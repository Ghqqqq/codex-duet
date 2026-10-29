import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDir, requireLocalSockets, run, readyBroker } from "./helpers.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { CodexAppServerClient } from "../plugins/codex/scripts/lib/app-server.mjs";
import { spawnBrokerProcess, waitForBrokerEndpoint, sendBrokerShutdown } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { resolveCodexRuntimeIdentity, resolveIsolatedCodexHome } from "../plugins/codex/scripts/lib/codex-home.mjs";
import { parseBrokerEndpoint } from "../plugins/codex/scripts/lib/broker-endpoint.mjs";
import { spawnOwned } from "../plugins/codex/scripts/lib/process.mjs";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } };
async function until(fn) {
  for (const deadline = Date.now() + 10000; Date.now() < deadline;) {
    if (fn()) return;
    await delay(10);
  }
  throw new Error("Fixture condition timed out");
}
function fixture(behavior = "review-ok") {
  const dir = makeTempDir("br-"); installFakeCodex(dir, behavior);
  return { dir, env: buildEnv(dir), endpoint: `unix:${path.join(dir, "s")}`, socketPath: path.join(dir, "s") };
}
async function serve(f, handler) {
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => {});
    socket.setEncoding("utf8"); let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk;
      for (let at; (at = buffer.indexOf("\n")) >= 0;) {
        const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
        if (line) handler(socket, JSON.parse(line));
      }
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(f.socketPath, resolve); });
  return async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); };
}

test("broker shutdown stops admitting clients before awaiting app-server cleanup", async t => {
  if (!await requireLocalSockets(t)) return;
  const f = fixture(), marker = path.join(f.dir, "stopping");
  const executable = path.join(f.dir, "codex");
  const original = fs.readFileSync(executable, "utf8");
  // Hold this owned fixture alive during graceful shutdown so the listener race
  // is deterministic. The broker's normal SIGKILL cleanup remains in force.
  // Keep it alive after stdin closes too, so the broker's SIGTERM (not an
  // early natural exit on EOF) always ends it and writes the marker.
  fs.writeFileSync(executable, original.replace('const fs = require("node:fs");', `const fs = require("node:fs");\nsetInterval(() => {}, 1000);\nprocess.on("SIGTERM", () => { fs.writeFileSync(${JSON.stringify(marker)}, "stopping"); setTimeout(() => {}, 5000); });`));
  const child = spawnBrokerProcess({ scriptPath: new URL("../plugins/codex/scripts/app-server-broker.mjs", import.meta.url).pathname,
    cwd: f.dir, endpoint: f.endpoint, pidFile: path.join(f.dir, "broker.pid"), logFile: path.join(f.dir, "broker.log"), env: f.env });
  assert.equal(await waitForBrokerEndpoint(f.endpoint, 10000), true);
  assert.equal(Number(fs.readFileSync(path.join(f.dir, "broker.pid"), "utf8").trim()), child.pid);
  const shutdown = sendBrokerShutdown(f.endpoint);
  await until(() => fs.existsSync(marker));
  process.kill(child.pid, "SIGTERM"); // A second shutdown shares the pending cleanup.
  const admitted = await new Promise(resolve => {
    const socket = net.createConnection(f.socketPath);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
  });
  await shutdown;
  await until(() => !alive(child.pid));
  assert.equal(admitted, false, "A stopping broker must not handshake against its closed app-server");

  // The runtime exits after accepting a turn, without delivering completion.
  // Shutdown must finish even though its interrupt request now throws at call time.
  const lost = fixture("lost-turn:interrupted"), pidFile = path.join(lost.dir, "broker.pid");
  const broker = spawnOwned(process.execPath, [new URL("../plugins/codex/scripts/app-server-broker.mjs", import.meta.url).pathname,
    "serve", "--endpoint", lost.endpoint, "--pid-file", pidFile], { cwd: lost.dir, env: lost.env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  broker.stderr.on("data", data => { stderr += data; });
  const exited = new Promise(resolve => broker.once("close", (code, signal) => resolve({ code, signal })));
  t.after(() => { if (broker.exitCode === null && broker.signalCode === null) broker.kill("SIGTERM"); });
  assert.equal(await waitForBrokerEndpoint(lost.endpoint, 10000), true);
  const client = await CodexAppServerClient.connect(lost.dir, { env: lost.env, brokerEndpoint: lost.endpoint });
  t.after(() => client.close());
  const { thread } = await client.request("thread/start", { cwd: lost.dir });
  await client.request("turn/start", { threadId: thread.id, input: [] });
  await client.exitPromise;
  assert.deepEqual(await exited, { code: 0, signal: null }, stderr);
  assert.equal(fs.existsSync(pidFile), false);
  assert.equal(fs.existsSync(lost.socketPath), false);
  const state = JSON.parse(fs.readFileSync(path.join(lost.dir, "fake-codex-state.json")));
  assert.equal(state.threads[0].turns[0].status, "interrupted");
  assert.equal(state.lastInterrupt, null);
});

test("abandoned turns expire without interrupting connected owners or stopping live peers", { timeout: 30000 }, async t => {
  if (!await requireLocalSockets(t)) return;
  const start = async (hangInterrupt = false, review = false) => {
    const f = fixture(review ? "review-ok" : "interruptible-slow-task");
    f.env.CODEX_COMPANION_TEST_ABANDONED_TURN_GRACE_MS = "250";
    f.env.CODEX_COMPANION_BROKER_IDLE_SEC = "1";
    if (hangInterrupt) {
      const executable = path.join(f.dir, "codex"), source = fs.readFileSync(executable, "utf8");
      fs.writeFileSync(executable, source.replace('case "turn/interrupt": {', 'case "turn/interrupt": { state.lastInterrupt = message.params; saveState(state); return;'));
    }
    const logFile = path.join(f.dir, "broker.log");
    const child = spawnBrokerProcess({ scriptPath: new URL("../plugins/codex/scripts/app-server-broker.mjs", import.meta.url).pathname,
      cwd: f.dir, endpoint: f.endpoint, pidFile: path.join(f.dir, "broker.pid"), logFile, env: f.env });
    t.after(() => { try { process.kill(child.pid, "SIGTERM"); } catch {} });
    assert.equal(await waitForBrokerEndpoint(f.endpoint, 10000), true);
    const owner = await CodexAppServerClient.connect(f.dir, { env: f.env, brokerEndpoint: f.endpoint });
    t.after(() => owner.close());
    const { thread } = await owner.request("thread/start", { cwd: f.dir });
    const completed = new Promise(resolve => owner.setNotificationHandler(message => { if (message.method === "turn/completed") resolve(); }));
    const { turn } = await owner.request(review ? "review/start" : "turn/start", { threadId: thread.id, input: [], ...(review ? { delivery: "detached", target: { type: "uncommittedChanges" } } : {}) });
    if (review) await completed;
    const state = () => JSON.parse(fs.readFileSync(path.join(f.dir, "fake-codex-state.json")));
    const serverPid = state().launches.at(-1).pid;
    const events = () => fs.readFileSync(logFile, "utf8").split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line));
    return { ...f, owner, child, thread, turn, serverPid, state, events };
  };
  const connected = await start(), abandoned = await start(true), retiring = await start(true);
  const peer = await CodexAppServerClient.connect(abandoned.dir, { env: abandoned.env, brokerEndpoint: abandoned.endpoint });
  t.after(() => peer.close());
  await abandoned.owner.close();
  await retiring.owner.close();
  await until(() => abandoned.events().some(event => event.event === "abandoned_turn" && event.outcome === "expired"));
  await until(() => abandoned.state().lastInterrupt?.turnId === abandoned.turn.id);
  await until(() => !alive(retiring.child.pid) && !alive(retiring.serverPid));
  assert.equal((await peer.request("initialize", {})).codexCompanionHome, resolveIsolatedCodexHome(abandoned.env));
  assert.equal(alive(abandoned.child.pid), true);
  assert.equal(connected.state().lastInterrupt, null);
  assert.deepEqual(connected.events(), []);
  await peer.close();
  await until(() => !alive(abandoned.child.pid) && !alive(abandoned.serverPid));
  assert.equal(alive(connected.child.pid), true); assert.equal(alive(connected.serverPid), true);
  assert.equal(connected.state().lastInterrupt, null);
  await connected.owner.close();
  await until(() => !alive(connected.child.pid) && !alive(connected.serverPid));
  assert.equal(connected.state().lastInterrupt.turnId, connected.turn.id);
  assert.ok(connected.events().some(event => event.outcome === "completed" && event.turnId === connected.turn.id));
  const review = await start(false, true);
  assert.equal((await review.owner.request("account/read", {})).account.type, "chatgpt");
  await review.owner.close();
  await until(() => !alive(review.child.pid) && !alive(review.serverPid));
});

test("detached broker returns its real PID, leaves the caller tree and keeps stdout/stderr in its log", { skip: process.platform === "win32" }, async () => {
  const f = fixture(), scriptPath = path.join(f.dir, "logging-broker.mjs");
  const pidFile = path.join(f.dir, "broker.pid"), logFile = path.join(f.dir, "broker.log");
  fs.writeFileSync(scriptPath, `
    import fs from "node:fs";
    fs.writeFileSync(process.argv[process.argv.indexOf("--pid-file") + 1], String(process.pid) + "\\n");
    console.log("fixture broker stdout");
    console.error("fixture broker stderr");
    setInterval(() => {}, 1000);
  `);
  const child = spawnBrokerProcess({ scriptPath, cwd: f.dir, endpoint: f.endpoint, pidFile, logFile, env: f.env });
  try {
    await until(() => fs.existsSync(pidFile) && fs.readFileSync(logFile, "utf8").includes("fixture broker stderr"));
    assert.equal(fs.readFileSync(pidFile, "utf8"), `${child.pid}\n`, "the pid-file protocol is unchanged");
    assert.equal(fs.readFileSync(logFile, "utf8"), "fixture broker stdout\nfixture broker stderr\n");
    const record = JSON.parse(fs.readFileSync(path.join(process.env.CODEX_COMPANION_TEST_PROCESSES, `${child.pid}.json`)));
    assert.equal(record.detached, true); assert.equal(alive(record.spawnedBy), false);
    const parent = run("ps", ["-p", String(child.pid), "-o", "ppid="]);
    assert.equal(parent.status, 0, parent.stderr);
    assert.notEqual(Number(parent.stdout.trim()), process.pid);
    assert.notEqual(Number(parent.stdout.trim()), record.spawnedBy);
  } finally {
    // This PID was returned from the fixture's own spawn, never inherited state.
    if (alive(child.pid)) process.kill(child.pid, "SIGTERM");
    await until(() => !alive(child.pid));
  }
});

test("a failed detached launcher falls back once and records the target PID", async () => {
  const f = fixture(), preload = path.join(f.dir, "fail-launcher.cjs");
  const target = path.join(f.dir, "target.mjs"), caller = path.join(f.dir, "caller.mjs"), pidFile = path.join(f.dir, "target.pid");
  // Fail only the inline launcher, leaving the caller and fallback target free
  // to run. All three inherit the suite's isolated test home and process ledger.
  fs.writeFileSync(preload, 'if (process.execArgv.includes("--input-type=module") && process.execArgv.includes("-e")) process.exit(23);');
  fs.writeFileSync(target, `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`);
  fs.writeFileSync(caller, `
    import { spawnDetached } from ${JSON.stringify(new URL("../plugins/codex/scripts/lib/process.mjs", import.meta.url).href)};
    const child = spawnDetached(process.execPath, [${JSON.stringify(target)}], { stdio: "ignore" });
    console.log(JSON.stringify({ pid: child.pid, callerPid: process.pid }));
  `);
  const result = run(process.execPath, [caller], { cwd: f.dir, env: { ...f.env, NODE_OPTIONS: `--require ${JSON.stringify(preload)}` } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "codex-companion: detached launcher failed; using direct detached spawn.\n");
  const { pid, callerPid } = JSON.parse(result.stdout);
  try {
    await until(() => fs.existsSync(pidFile));
    assert.equal(Number(fs.readFileSync(pidFile, "utf8")), pid);
    const record = JSON.parse(fs.readFileSync(path.join(process.env.CODEX_COMPANION_TEST_PROCESSES, `${pid}.json`)));
    assert.equal(record.pid, pid); assert.equal(record.spawnedBy, callerPid); assert.equal(record.detached, true);
    assert.equal(alive(pid), true);
  } finally {
    if (alive(pid)) process.kill(pid, "SIGTERM");
    await until(() => !alive(pid));
  }
});

test("broker handshake EOF retries one private spawn; both transports preserve large JSONL", { timeout: 30000 }, async t => {
  if (!await requireLocalSockets(t)) return;
  const f = fixture("large-jsonl"), methods = [];
  const executable = path.join(f.dir, "codex");
  const source = fs.readFileSync(executable, "utf8"), inputMarker = 'process.stdin.setEncoding("utf8");';
  assert.ok(source.includes(inputMarker));
  fs.writeFileSync(executable, source.replace(inputMarker, `process.stdout.write('null\\n[]\\ntrue\\n42\\n"text"\\n');\n${inputMarker}`));
  const close = await serve(f, (socket, message) => { methods.push(message.method); socket.destroy(); });
  t.after(close);
  const payload = "x".repeat(438000) + "\u2028\u2029世界🚀\r\n" + "z".repeat(4 * 1024 * 1024);
  async function roundTrip(client, threadId) {
    let item;
    const completed = new Promise(resolve => client.setNotificationHandler(message => {
      if (message.method === "item/completed") item = message.params.item;
      if (message.method === "turn/completed") resolve(message.params.turn);
    }));
    const { turn } = await client.request("turn/start", { threadId, input: [{ type: "text", text: payload, text_elements: [] }] });
    const ended = await Promise.race([completed, client.exitPromise.then(() => { throw client.exitError ?? new Error("Transport closed before completion"); })]);
    assert.equal(ended.id, turn.id);
    assert.equal(ended.status, "completed");
    assert.ok(item.text === payload, `${client.transport} notification preserves every character`);
    const response = await client.request("thread/read", { threadId, includeTurns: true });
    assert.ok(response.thread.turns.find(entry => entry.id === turn.id).items[0].text === payload,
      `${client.transport} thread/read preserves every character`);
    assert.equal((await client.request("account/read", { refreshToken: false })).account.type, "chatgpt",
      "a later small response still resolves on the same connection");
    t.diagnostic(`${client.transport}: ${Buffer.byteLength(payload)} payload bytes preserved in request, notification and thread/read; later RPC succeeds`);
  }
  const events = [], client = await CodexAppServerClient.connect(f.dir, { env: f.env, brokerEndpoint: f.endpoint, onRuntimeEvent: event => events.push(event) });
  try {
    assert.equal(client.transport, "direct");
    const { thread } = await client.request("thread/start", { cwd: f.dir, sandbox: "read-only", approvalPolicy: "never" });
    assert.deepEqual(methods, ["initialize"]);
    const state = JSON.parse(fs.readFileSync(path.join(f.dir, "fake-codex-state.json")));
    assert.equal(state.threads.length, 1);
    assert.equal(state.appServerStarts, 1);
    assert.ok(events.some(e => e.brokerStartupRetry === true));
    await roundTrip(client, thread.id);
  } finally { await client.close(); }
  // Extend only this temporary runtime. The callback holds an RPC open until
  // later socket chunks arrive, without relying on sleeps or response timing.
  const completionGate = path.join(f.dir, "complete-turn"), auxiliaryGate = path.join(f.dir, "auxiliary-callback");
  const abandoned = path.join(f.dir, "abandoned-request");
  const original = fs.readFileSync(executable, "utf8"), marker = '    switch (message.method) {';
  assert.ok(original.includes(marker));
  fs.writeFileSync(executable, original.replace(marker, `
    if (message.method === undefined && message.id === "transport-callback") {
      send({ id: globalThis.transportPending, result: message.result }); return;
    }
    if (message.method === "turn/start" && message.params.fixtureFail) throw new Error("Fixture start failed");
    if (message.method === "turn/start" && message.params.fixtureEarly) {
      send({ method: "turn/completed", params: { threadId: message.params.threadId, turn: buildTurn("early-turn", "completed") } });
      send({ id: message.id, result: { turn: buildTurn("early-turn") } }); return;
    }
    if (message.method === "turn/start" && message.params.fixtureHold) {
      globalThis.transportThread = message.params.threadId;
      send({ id: message.id, result: { turn: buildTurn("transport-turn") } });
      send({ method: "turn/started", params: { threadId: message.params.threadId, turn: buildTurn("transport-turn") } }); return;
    }
    switch (message.method) {
      case "fixture/abandon": fs.writeFileSync(${JSON.stringify(abandoned)}, String(process.pid)); return;
      case "fixture/complete-during-aux": {
        globalThis.transportPending = message.id;
        send({ method: "turn/completed", params: { threadId: globalThis.transportThread, turn: buildTurn("transport-turn", "completed") } });
        const timer = setInterval(() => {
          if (!fs.existsSync(${JSON.stringify(auxiliaryGate)})) return;
          clearInterval(timer);
          send({ id: "transport-callback", method: "item/tool/call", params: { tool: "ask_parent" } });
        }, 10); return;
      }
      case "fixture/hold":
        globalThis.transportPending = message.id;
        send({ id: "transport-callback", method: "item/tool/call", params: { tool: "ask_parent" } }); return;
      case "fixture/echo": send({ id: message.id, result: message.params }); return;
      case "fixture/fail": {
        send({ id: message.id, error: { code: -32000, message: "Fixture auxiliary failure" } });
        const timer = setInterval(() => {
          if (!fs.existsSync(${JSON.stringify(completionGate)})) return;
          clearInterval(timer);
          send({ method: "item/completed", params: { threadId: globalThis.transportThread, turnId: "transport-turn", item: { type: "agentMessage", id: "transport-item", text: "after failure" } } });
          send({ method: "turn/completed", params: { threadId: globalThis.transportThread, turn: buildTurn("transport-turn", "completed") } });
        }, 10); return;
      }
  `));
  const broker = await readyBroker(f.dir, f.env); t.after(broker.close);
  const relayed = await CodexAppServerClient.connect(f.dir, { env: f.env, brokerEndpoint: broker.endpoint });
  try {
    assert.equal(relayed.transport, "broker", "large-message coverage must use the real broker relay");
    const { thread } = await relayed.request("thread/start", { cwd: f.dir });
    await roundTrip(relayed, thread.id);

    const socket = net.createConnection(parseBrokerEndpoint(broker.endpoint).path);
    t.after(() => socket.destroy());
    socket.setEncoding("utf8");
    const messages = []; let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk;
      for (let at; (at = buffer.indexOf("\n")) !== -1;) {
        messages.push(JSON.parse(buffer.slice(0, at))); buffer = buffer.slice(at + 1);
      }
    });
    await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    const line = message => JSON.stringify(message) + "\n";
    const reply = async id => { await until(() => messages.some(message => message.id === id)); return messages.find(message => message.id === id); };
    async function callbackResponse() {
      await until(() => messages.some(message => message.method === "item/tool/call"));
      const callback = messages.find(message => message.method === "item/tool/call");
      return Buffer.from(line({ id: callback.id, result: { success: true, contentItems: [{ type: "inputText", text: "release" }] } }));
    }
    const echo = { text: "split\u2028\u2029世界🚀" };
    socket.write('null\n[]\ntrue\n42\n"text"\n');
    const second = Buffer.from(line({ id: 2, method: "fixture/echo", params: echo }));
    const cut = second.indexOf(Buffer.from("\u2028")) + 1;
    socket.write(Buffer.concat([Buffer.from(line({ id: 1, method: "fixture/hold" })), second.subarray(0, cut)]));
    const callbackReply = await callbackResponse();
    socket.write(Buffer.concat([second.subarray(cut), callbackReply]));
    await reply(2);
    assert.deepEqual(messages.filter(message => typeof message.id === "number").map(message => message.id), [1, 2]);
    assert.deepEqual((await reply(2)).result, echo);

    // A complete queued record plus another chunk used to leave a stale LF
    // index behind the awaiting handler, truncating the next partial record.
    messages.length = 0;
    const third = Buffer.from(line({ id: 3, method: "fixture/echo", params: echo }));
    socket.write(line({ id: 1, method: "fixture/hold" }) + line({ id: 2, method: "fixture/echo", params: {} }));
    const nextCallbackReply = await callbackResponse();
    socket.write(Buffer.concat([nextCallbackReply, third.subarray(0, cut)]));
    await reply(1);
    socket.write(Buffer.concat([third.subarray(cut), Buffer.from(line({ id: 4, method: "fixture/echo", params: {} }))]));
    await reply(4);
    assert.deepEqual(messages.filter(message => typeof message.id === "number").map(message => message.id), [1, 2, 3, 4]);
    assert.deepEqual((await reply(3)).result, echo);
    assert.equal(messages.some(message => message.error), false);

    messages.length = 0;
    socket.write(line({ id: 5, method: "turn/start", params: { threadId: thread.id, fixtureHold: true } }));
    await reply(5);
    socket.write(line({ id: 6, method: "fixture/fail" }));
    assert.equal((await reply(6)).error.code, -32000);
    // A second failed start must also leave the acknowledged turn owned.
    socket.write(line({ id: 7, method: "turn/start", params: { threadId: thread.id, fixtureFail: true } }));
    assert.equal((await reply(7)).error.code, -32000);
    await assert.rejects(relayed.request("account/read", {}), error => error.rpcCode === -32001);
    fs.writeFileSync(completionGate, "complete");
    await until(() => messages.some(message => message.method === "turn/completed"));
    assert.deepEqual(messages.filter(message => message.method).map(message => message.method), ["turn/started", "item/completed", "turn/completed"]);
    assert.equal(messages.find(message => message.method === "item/completed").params.item.text, "after failure");
    assert.equal(messages.find(message => message.method === "turn/completed").params.turn.id, "transport-turn");
    assert.equal((await relayed.request("account/read", {})).account.type, "chatgpt", "completion releases the stream owner");
    socket.write(line({ id: 8, method: "turn/start", params: { threadId: thread.id, fixtureFail: true } }));
    assert.equal((await reply(8)).error.code, -32000);
    assert.equal((await relayed.request("account/read", {})).account.type, "chatgpt", "a failed initial start leaves no stream owner");

    messages.length = 0;
    socket.write(line({ id: 9, method: "turn/start", params: { threadId: thread.id, fixtureEarly: true } }));
    await reply(9);
    assert.equal(messages[0].method, "turn/completed");
    assert.equal((await relayed.request("account/read", {})).account.type, "chatgpt", "a late response cannot restore completed stream ownership");

    messages.length = 0;
    socket.write(line({ id: 10, method: "turn/start", params: { threadId: thread.id, fixtureHold: true } }));
    await reply(10);
    socket.write(line({ id: 11, method: "fixture/complete-during-aux" }));
    await until(() => messages.some(message => message.method === "turn/completed"));
    await assert.rejects(relayed.request("account/read", {}), error => error.rpcCode === -32001);
    fs.writeFileSync(auxiliaryGate, "release");
    const ownedReply = await callbackResponse();
    const callback = messages.find(message => message.method === "item/tool/call");
    relayed.sendMessage({ id: callback.id, result: { success: true, contentItems: [{ type: "inputText", text: "wrong owner" }] } });
    await relayed.request("initialize", {}); // Fence the forged reply on the peer socket.
    assert.equal(messages.some(message => message.id === 11), false, "a peer cannot answer the outstanding request's callback");
    socket.write(ownedReply);
    assert.equal((await reply(11)).result.contentItems[0].text, "release");
    assert.equal((await relayed.request("account/read", {})).account.type, "chatgpt", "settlement releases the auxiliary owner");

    socket.write(line({ id: 12, method: "fixture/abandon" }));
    await until(() => fs.existsSync(abandoned));
    const serverPid = Number(fs.readFileSync(abandoned, "utf8"));
    socket.destroy();
    await relayed.close();
    broker.close();
    await until(() => !alive(broker.pid) && !alive(serverPid));
  } finally { await relayed.close(); }
});

test("a broker close after handshake never replays thread/start", async t => {
  if (!await requireLocalSockets(t)) return;
  const f = fixture(), methods = [];
  const close = await serve(f, (socket, message) => {
    methods.push(message.method);
    if (message.method === "initialize") socket.write(JSON.stringify({ id: message.id, result: {
      codexCompanionHome: resolveIsolatedCodexHome(f.env), codexCompanionRuntime: resolveCodexRuntimeIdentity(f.env)
    } }) + "\n");
    if (message.method === "thread/start") socket.destroy();
  });
  t.after(close);
  const client = await CodexAppServerClient.connect(f.dir, { env: f.env, brokerEndpoint: f.endpoint });
  try {
    await assert.rejects(client.request("thread/start", { cwd: f.dir }), /closed/);
    assert.equal(methods.filter(m => m === "thread/start").length, 1);
    assert.equal(fs.existsSync(path.join(f.dir, "fake-codex-state.json")), false);
  } finally { await client.close(); }
});

// Shared fixture; these contracts were moved from worker-lifecycle to balance file runtime.
{
const {
  fs, path, makeTempDir, run, requireLocalSockets, buildEnv, installFakeCodex, resolveIsolatedCodexHome, resolveSessionMarkersRoot, spawnOwned, script, hook, brokerScript, alive, fixture, json, delay, waitUntil, job
} = await (await import('./fake-codex-fixture.mjs')).lifecycleHarness();
test("broker SIGTERM during initialize reaps its separately grouped app-server", async () => {
  const f = fixture("w5-initialize-hang");
  const child = spawnOwned(process.execPath, [brokerScript, "serve", "--endpoint", `unix:${path.join(f.dir, "startup.sock")}`, "--cwd", f.repo], { cwd: f.repo, env: f.env, stdio: "ignore" });
  const serverPid = await waitUntil(() => {
    try { return f.state().launches?.[0]?.pid; } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  });
  child.kill("SIGTERM");
  await waitUntil(() => !alive(serverPid) && !alive(child.pid));
});

test("broker prewarm is non-blocking and idle exit reaps the server group", async t => {
  if (!await requireLocalSockets(t)) return;
  const f = fixture("review-ok"), gate = path.join(f.dir, "prewarm-release");
  const preload = path.join(f.dir, "hold-prewarm.mjs");
  fs.writeFileSync(preload, `import fs from 'node:fs';
    if (process.argv[2] === 'prewarm') {
      fs.writeFileSync(${JSON.stringify(gate + ".waiting")}, 'ready');
      while (!fs.existsSync(${JSON.stringify(gate)})) await new Promise(resolve => setTimeout(resolve, 25));
    }`);
  f.env.NODE_OPTIONS = `--import ${preload}`;
  const warmed = run(process.execPath, [hook, "SessionStart"], { cwd: f.repo, env: f.env,
    input: JSON.stringify({ session_id: "fixture-session", cwd: f.repo }) });
  assert.equal(warmed.status, 0, warmed.stderr);
  await waitUntil(() => fs.existsSync(gate + ".waiting"));
  assert.equal(fs.existsSync(gate), false, "hook returned while prewarm cannot finish");
  const broker = await readyBroker(f.repo, f.env); t.after(broker.close);
  fs.writeFileSync(gate, "continue");
  const retentionFile = path.join(f.env.CODEX_COMPANION_HOME, "duet", "retention.json");
  await waitUntil(() => fs.existsSync(retentionFile) && JSON.parse(fs.readFileSync(retentionFile)).lastReport);
  const launches = f.state().launches;
  assert.ok(launches.length);
  broker.close();
  await waitUntil(() => !alive(broker.pid) && launches.every(launch => !alive(launch.pid)));
});

test("stopping a direct shell's whole descendant tree preserves its worker, shared broker and other job", { skip: process.platform === "win32" }, async t => {
  if (!await requireLocalSockets(t)) return;
  const f = fixture(), ownerPidFile = path.join(f.dir, "owner.pid");
  const ready = await readyBroker(f.repo, f.env); t.after(ready.close);
  const processModule = new URL("../plugins/codex/scripts/lib/process.mjs", import.meta.url).href;
  const holder = spawnOwned(process.execPath, ["--input-type=module", "-e", `
    import fs from "node:fs";
    import { spawnOwned } from ${JSON.stringify(processModule)};
    const owner = spawnOwned(process.execPath, ${JSON.stringify([script, "task", "--fresh", "--direct", "fixture tree stop"])}, { stdio: ["ignore", 1, 2] });
    fs.writeFileSync(${JSON.stringify(ownerPidFile)}, String(owner.pid));
    owner.on("exit", code => { process.exitCode = code; });
  `], { cwd: f.repo, env: f.env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  holder.stdout.resume(); holder.stderr.on("data", chunk => { stderr += chunk; });
  const holderClosed = new Promise(resolve => holder.once("close", resolve));
  const markerDir = path.join(resolveSessionMarkersRoot(f.env), f.env.CODEX_COMPANION_SESSION_ID);
  const marker = await waitUntil(() => {
    if (!fs.existsSync(markerDir)) return null;
    const file = fs.readdirSync(markerDir).find(name => name.endsWith(".json"));
    return file && JSON.parse(fs.readFileSync(path.join(markerDir, file)));
  });
  const readOwned = () => JSON.parse(fs.readFileSync(marker.jobFile));
  const owned = await waitUntil(() => { const current = readOwned(); return current.ownerAttached && current.turnId && current; });
  const brokerFile = path.join(path.dirname(path.dirname(marker.jobFile)), "broker.json");
  const broker = JSON.parse(fs.readFileSync(brokerFile));
  const brokerPid = Number(fs.readFileSync(broker.pidFile, "utf8").trim());
  assert.equal(broker.pid, brokerPid, "the saved broker PID is its real pid-file PID");
  const brokerServerPid = f.state().launches[0].pid;
  assert.equal(f.state().appServerStarts, 1);

  // Start the peer only after this holder's job has created the shared broker.
  // The existing busy-broker policy gives the concurrent turn a private server.
  const peer = json(f.call("task", "--fresh", "--detached", "--json", "fixture peer"));
  const peerJob = await waitUntil(() => { const current = job(f, peer.jobId); return current.turnId && current; });
  assert.equal(f.state().appServerStarts, 2, "the peer uses the existing busy-broker fallback");
  // While the broker streams the holder's turn, a follow-up's admission read of
  // the peer's thread uses a private runtime instead of reporting it unreadable.
  const codexModule = new URL("../plugins/codex/scripts/lib/codex.mjs", import.meta.url).href;
  const recovered = run(process.execPath, ["--input-type=module", "-e", `
    import { readAppServerTurn } from ${JSON.stringify(codexModule)};
    console.log(JSON.stringify(await readAppServerTurn(process.cwd(), ${JSON.stringify({ threadId: peerJob.threadId, turnId: peerJob.turnId })}, { privateWhenBusy: true })));
  `], { cwd: f.repo, env: f.env });
  assert.equal(JSON.parse(recovered.stdout || "null")?.turnId, peerJob.turnId, recovered.stderr);
  assert.equal(f.state().appServerStarts, 3);
  // A short-lived helper can sit in the tree for a moment without a ledger
  // record; take new snapshots until every PID in the tree is one we started.
  const { table, tree } = await waitUntil(() => {
    const tableResult = run("ps", ["-axo", "pid=,ppid=,command="]);
    assert.equal(tableResult.status, 0, tableResult.stderr);
    const table = new Map(tableResult.stdout.trim().split("\n").map(line => {
      const [, pid, ppid, command] = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      return [Number(pid), { ppid: Number(ppid), command }];
    }));
    const tree = [holder.pid];
    for (let index = 0; index < tree.length; index++) {
      for (const [pid, entry] of table) if (entry.ppid === tree[index]) tree.push(pid);
    }
    return tree.every(pid => fs.existsSync(path.join(process.env.CODEX_COMPANION_TEST_PROCESSES, `${pid}.json`))) && { table, tree };
  });
  const ownerPid = Number(fs.readFileSync(ownerPidFile, "utf8"));
  assert.ok(tree.includes(ownerPid), "the ps walk includes the task --direct owner");
  assert.ok(table.get(owned.pid)?.command.includes(`${script} task-worker --cwd `), "job.pid identifies the real worker");
  assert.ok(table.get(owned.pid).command.includes(`--job-id ${owned.id}`));
  assert.equal(table.get(brokerServerPid)?.ppid, brokerPid, "the app-server stays a child of the broker");
  for (const pid of [owned.pid, brokerPid, peerJob.pid]) {
    assert.equal(tree.includes(pid), false, `PID ${pid} is outside the holder's descendant tree`);
    const record = JSON.parse(fs.readFileSync(path.join(process.env.CODEX_COMPANION_TEST_PROCESSES, `${pid}.json`)));
    assert.equal(record.pid, pid); assert.equal(record.detached, true);
    assert.equal(table.has(record.spawnedBy), false, "the short-lived launcher has already exited");
  }
  // Validate every victim against the fresh suite ledger before signalling any
  // PID. ps discovers ancestry only; it never authorizes killing other processes.
  for (const pid of tree) assert.equal(JSON.parse(fs.readFileSync(path.join(process.env.CODEX_COMPANION_TEST_PROCESSES, `${pid}.json`))).pid, pid);
  const stoppedAt = Date.now();
  for (const pid of [...tree].reverse()) {
    try { process.kill(pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  }
  assert.equal(alive(owned.pid), true, "the worker survives the descendant-tree SIGTERM");
  assert.equal(alive(brokerPid), true, "the shared broker survives the descendant-tree SIGTERM");
  const ended = await waitUntil(() => { const current = readOwned(); return current.result && current; });
  const elapsed = Date.now() - stoppedAt;
  assert.equal(ended.status, "interrupted"); assert.equal(ended.ownerDetachReason, "signal");
  assert.equal(ended.result.interruptionReason, "owner_stopped");
  assert.equal(ended.result.interruptionConfirmed, true); assert.equal(ended.result.turnEnded, true);
  assert.equal(f.state().lastInterrupt.turnId, owned.turnId);
  await holderClosed;
  assert.equal(stderr, "");
  assert.equal(job(f, peer.jobId).status, "running"); assert.equal(alive(peerJob.pid), true);
  const result = f.call("result", peer.jobId, "--json");
  assert.equal(result.status, 1); assert.equal(result.stdout, "");

  assert.equal(JSON.parse(fs.readFileSync(brokerFile)).pid, brokerPid);
  assert.equal(alive(brokerPid), true);
  assert.equal(alive(brokerServerPid), true);
  assert.equal(json(f.call("cancel", peer.jobId, "--json")).confirmation, "confirmed", "the surviving peer remains cancellable");
  assert.equal(f.state().lastInterrupt.turnId, peerJob.turnId);
  assert.equal(f.state().appServerStarts, 3, "neither app-server was replaced; the third is the private recovery read");
  t.diagnostic(`SIGTERM tree=${tree.join(",")}; worker=${owned.pid}; broker=${brokerPid}; peer=${peerJob.pid}; owner_stopped confirmed with turnEnded in ${elapsed} ms`);
});
}

test("transport failures settle requests, reap runtimes and bound retained buffers", { timeout: 45000 }, async t => {
  const transport = await import("../plugins/codex/scripts/lib/app-server.mjs");
  const { stopOwnedProcessGroup } = await import("../plugins/codex/scripts/lib/process.mjs");
  const guarded = async promise => {
    let timer;
    try { return await Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve({ watchdog: true }), 3000); })]); }
    finally { clearTimeout(timer); }
  };
  await t.test("S3-1: asynchronous stdin failure is contained in the worker and broker", async () => {
    const observations = [];
    for (const broker of [false, true]) {
      const f = fixture("transport-close-stdin");
      const result = run(process.execPath, ["--input-type=module", "-e", `
        import { CodexAppServerClient } from ${JSON.stringify(new URL("../plugins/codex/scripts/lib/app-server.mjs", import.meta.url).href)};
        const client = await CodexAppServerClient.connect(process.cwd(), { disableBroker: ${!broker} });
        const watchdog = setTimeout(() => process.exit(42), 5000);
        const closed = new Promise(resolve => client.setNotificationHandler(m => { if (m.method === 'fixture/closedStdin') resolve(); }));
        const first = client.request('account/read', {}).then(() => null, error => error.code);
        await closed;
        const second = Promise.resolve().then(() => client.request('config/read', {})).then(() => null, error => error.code);
        console.log(JSON.stringify({ errors: await Promise.all([first, second]), pending: client.pending.size }));
        await client.close(); clearTimeout(watchdog);
      `], { cwd: f.dir, env: f.env });
      const state = JSON.parse(fs.readFileSync(path.join(f.dir, "fake-codex-state.json")));
      await guarded(until(() => state.launches.every(entry => !alive(entry.pid))));
      const survivors = state.launches.filter(entry => alive(entry.pid));
      // Baseline crashes must not strand the fake runtime used to reproduce it.
      for (const entry of survivors) await stopOwnedProcessGroup(entry, 50);
      const session = broker ? (await import("../plugins/codex/scripts/lib/broker-lifecycle.mjs")).loadBrokerSession(f.dir) : null;
      const brokerLog = session ? fs.readFileSync(session.logFile, "utf8") : "";
      const uncaughtEpipe = (result.stderr + brokerLog).includes("Unhandled 'error' event");
      t.diagnostic(JSON.stringify({ finding: "S3-1", broker, exit: result.status, uncaughtEpipe, survivingRuntime: survivors.length, result: result.stdout.trim() }));
      observations.push({ result, survivors, uncaughtEpipe });
    }
    for (const { result, survivors, uncaughtEpipe } of observations) {
      assert.equal(result.status, 0, result.stderr);
      const observed = JSON.parse(result.stdout);
      assert.equal(observed.pending, 0);
      assert.ok(observed.errors.every(Boolean));
      assert.equal(uncaughtEpipe, false);
      assert.equal(survivors.length, 0);
    }
  });
  await t.test("S3-2: default initialize deadline and one startup/fallback budget", async () => {
    const f = fixture("w5-initialize-hang");
    let client;
    const realTimeout = globalThis.setTimeout, scheduled = [];
    // Exercise the production default without spending a minute on a hung fake.
    globalThis.setTimeout = (fn, ms, ...args) => {
      if (ms >= 59000 && ms <= 60000) { scheduled.push(ms); return realTimeout(fn, 250, ...args); }
      return realTimeout(fn, ms, ...args);
    };
    let outcome;
    try {
      outcome = await guarded(CodexAppServerClient.connect(f.dir, { env: f.env, disableBroker: true, onClient: value => { client = value; } }).then(() => ({ connected: true }), error => ({ code: error.code })));
    } finally { globalThis.setTimeout = realTimeout; await client?.close(); }
    t.diagnostic(JSON.stringify({ finding: "S3-2", outcome, defaultTimerCount: scheduled.length, pending: client.pending.size, alive: alive(client.proc.pid) }));
    assert.deepEqual(outcome, { code: "ETIMEDOUT" });
    assert.equal(scheduled.length, 1);
    assert.equal(client.pending.size, 0); assert.equal(alive(client.proc.pid), false);

    const startup = fixture("w5-initialize-hang"), candidates = [];
    const startupResult = await guarded(CodexAppServerClient.connect(startup.dir, { env: startup.env, connectTimeoutMs: 1800, onClient: value => candidates.push(value) }).then(() => null, error => error.code));
    for (const candidate of candidates) await candidate.close();
    assert.equal(startupResult, "ETIMEDOUT");
    assert.equal(candidates.length, 0, "an exhausted broker startup budget cannot spawn the direct fallback");
    const state = JSON.parse(fs.readFileSync(path.join(startup.dir, "fake-codex-state.json")));
    assert.ok(state.launches.length > 0);
    assert.ok(state.launches.every(entry => !alive(entry.pid)));

    const fallback = fixture("w5-initialize-hang"), clients = [];
    const close = await serve(fallback, socket => socket.destroy());
    try {
      const result = await guarded(CodexAppServerClient.connect(fallback.dir, { env: fallback.env, brokerEndpoint: fallback.endpoint, connectTimeoutMs: 600, onClient: value => clients.push(value) }).then(() => null, error => error.code));
      assert.equal(result, "ETIMEDOUT");
      assert.deepEqual(clients.map(value => value.transport), ["broker", "direct"]);
      assert.equal(new Set(clients.map(value => value.options.connectDeadline)).size, 1);
      assert.ok(clients.every(value => value.pending.size === 0));
      assert.equal(alive(clients[1].proc.pid), false);
    } finally { for (const candidate of clients) await candidate.close(); await close(); }
  });
  await t.test("S3-3: stdout EOF preserves complete responses and rejects pending work", async () => {
    const f = fixture("transport-close-stdout"), client = await CodexAppServerClient.connect(f.dir, { env: f.env, disableBroker: true });
    let outcome;
    try {
      const complete = client.request("account/read", {}), pending = client.request("config/read", {});
      outcome = await guarded(Promise.allSettled([complete, pending]));
      t.diagnostic(JSON.stringify({ finding: "S3-3", outcome: Array.isArray(outcome) ? outcome.map(row => ({ status: row.status, code: row.reason?.code })) : outcome, pending: client.pending.size }));
    } finally { await client.close(); }
    assert.equal(outcome[0]?.status, "fulfilled");
    assert.equal(outcome[0].value.account.type, "chatgpt");
    assert.equal(outcome[1]?.status, "rejected"); assert.equal(outcome[1].reason.code, "CODEX_TRANSPORT_CLOSED");
    assert.equal(client.pending.size, 0); assert.equal(alive(client.proc.pid), false);
  });
  await t.test("S3-6: stderr retains a bounded UTF-8 tail and still detects warnings", async () => {
    const f = fixture("transport-stderr"), events = [];
    const client = await CodexAppServerClient.connect(f.dir, { env: f.env, disableBroker: true, onRuntimeEvent: event => events.push(event) });
    try {
      await until(() => client.stderr.endsWith("TAIL"));
      const retained = Buffer.byteLength(client.stderr);
      t.diagnostic(JSON.stringify({ finding: "S3-6", emittedBytes: 256 * 65535, retainedBytes: retained, truncated: Boolean(client.stderrTruncated) }));
      assert.ok(retained <= 64 * 1024); assert.equal(client.stderrTruncated, true);
      assert.equal(client.stderr.includes("\uFFFD"), false);
      assert.ok(events.some(event => event.startupWarning));
      await assert.rejects(client.request("config/read", {}), error => error.code === "CODEX_TRANSPORT_CLOSED" && error.message.includes(client.stderr.trim()));
    } finally { await client.close(); }
  });
  await t.test("S3-5: slow runtime and broker sockets have bounded ordered writers", async () => {
    for (const broker of [false, true]) {
      const f = fixture("transport-slow-stdin");
      let paused;
      const stopped = new Promise(resolve => { paused = resolve; });
      const close = broker ? await serve(f, (socket, message) => {
        if (message.method === "initialize") socket.write(JSON.stringify({ id: message.id, result: { codexCompanionHome: resolveIsolatedCodexHome(f.env), codexCompanionRuntime: resolveCodexRuntimeIdentity(f.env) } }) + "\n");
        if (message.method === "initialized") { socket.pause(); paused(); }
      }) : async () => {};
      const client = await CodexAppServerClient.connect(f.dir, { env: f.env, ...(broker ? { brokerEndpoint: f.endpoint } : { disableBroker: true }), onClient: value => value.setNotificationHandler(message => { if (message.method === "fixture/paused") paused(); }) });
      try {
        await stopped;
        const pending = client.request("account/read", {}).then(() => null, error => error.code);
        const frame = { method: "fixture/fill", params: { text: "x".repeat(65536) } };
        let peak = 0;
        for (let i = 0; i < 640; i++) {
          client.sendMessage(frame);
          peak = Math.max(peak, client.outbound?.bufferedBytes ?? (client.proc?.stdin ?? client.socket).writableLength);
        }
        const failure = client.exitError?.code ?? null;
        t.diagnostic(JSON.stringify({ finding: "S3-5", broker, peakBytes: peak, failure }));
        assert.ok(peak <= 32 * 1024 * 1024);
        assert.equal(failure, "CODEX_TRANSPORT_BACKPRESSURE");
        assert.equal(await pending, failure);
      } finally { await client.close(); await close(); }
    }
    // A stalled Writable must receive no further writes until drain; queued
    // records retain wire order, including server-request callback responses.
    const { Writable } = await import("node:stream");
    const delivered = [], callbacks = [];
    const stream = new Writable({ highWaterMark: 1, write(chunk, encoding, callback) { delivered.push(JSON.parse(chunk)); callbacks.push(callback); } });
    const failures = [], writer = transport.createOutboundQueue(stream, error => failures.push(error));
    writer.send({ id: 1, method: "account/read" }); writer.send({ id: "callback", result: {} }); writer.send({ id: 2, method: "config/read" });
    assert.equal(delivered.length, 1);
    for (let i = 0; i < 3; i++) { callbacks.shift()(); await new Promise(resolve => setImmediate(resolve)); }
    assert.deepEqual(delivered.map(message => message.id), [1, "callback", 2]);
    assert.equal(writer.bufferedBytes, 0); assert.deepEqual(failures, []); writer.close(); stream.destroy();
    // One oversized frame on an idle peer is delivered, and ordinary frames
    // behind it while it drains are not counted against the backlog cap.
    const large = [], drains = [];
    const slow = new Writable({ highWaterMark: 1, write(chunk, encoding, callback) { large.push(chunk.length); drains.push(callback); } });
    const bulk = transport.createOutboundQueue(slow, error => failures.push(error));
    bulk.send({ id: 3, result: { text: "x".repeat(33 * 1024 * 1024) } }); bulk.send({ method: "turn/completed", params: {} });
    while (drains.length) { drains.shift()(); await new Promise(resolve => setImmediate(resolve)); }
    assert.equal(large.length, 2); assert.deepEqual(failures, []); bulk.close(); slow.destroy();
  });
  await t.test("S3-5: overflowing one broker consumer preserves the broker and other peers", async () => {
    const f = fixture("transport-slow-peer"), broker = await readyBroker(f.dir, f.env);
    const client = await CodexAppServerClient.connect(f.dir, { env: f.env, brokerEndpoint: broker.endpoint });
    let peer;
    try {
      client.socket.pause();
      const pending = client.request("account/read", {}).catch(() => {});
      const result = await guarded(until(() => fs.readFileSync(broker.logFile, "utf8").includes("CODEX_TRANSPORT_BACKPRESSURE")));
      const logged = fs.readFileSync(broker.logFile, "utf8").split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line));
      t.diagnostic(JSON.stringify({ finding: "S3-5-broker", result, errors: logged.filter(event => event.event === "transport_error"), brokerAlive: alive(broker.pid) }));
      assert.ok(logged.some(event => event.event === "transport_error" && event.code === "CODEX_TRANSPORT_BACKPRESSURE" && event.bufferedBytes <= 32 * 1024 * 1024));
      peer = await CodexAppServerClient.connect(f.dir, { env: f.env, brokerEndpoint: broker.endpoint });
      assert.equal(peer.transport, "broker");
      assert.ok((await peer.request("initialize", {})).codexCompanionHome);
      assert.equal(alive(broker.pid), true);
      const response = await guarded((async () => {
        for (;;) {
          try { return await peer.request("config/read", {}); }
          catch (error) { if (error.rpcCode !== transport.BROKER_BUSY_RPC_CODE) throw error; await delay(10); }
        }
      })());
      assert.deepEqual(response.config, { model_provider: "openai" });
      client.socket.resume(); await pending;
    } finally { await client.close(); await peer?.close(); broker.close(); }
  });
});
