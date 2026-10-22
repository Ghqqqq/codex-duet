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

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } };
async function until(fn) {
  for (const deadline = Date.now() + 10000; Date.now() < deadline;) {
    if (fn()) return;
    await delay(10);
  }
  throw new Error("Fixture condition timed out");
}
function fixture() {
  const dir = makeTempDir("br-"); installFakeCodex(dir);
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
  fs.writeFileSync(executable, original.replace('const fs = require("node:fs");', `const fs = require("node:fs");\nprocess.on("SIGTERM", () => { fs.writeFileSync(${JSON.stringify(marker)}, "stopping"); setTimeout(() => {}, 5000); });`));
  const child = spawnBrokerProcess({ scriptPath: new URL("../plugins/codex/scripts/app-server-broker.mjs", import.meta.url).pathname,
    cwd: f.dir, endpoint: f.endpoint, pidFile: path.join(f.dir, "broker.pid"), logFile: path.join(f.dir, "broker.log"), env: f.env });
  assert.equal(await waitForBrokerEndpoint(f.endpoint, 10000), true);
  assert.equal(Number(fs.readFileSync(path.join(f.dir, "broker.pid"), "utf8").trim()), child.pid);
  const shutdown = sendBrokerShutdown(f.endpoint);
  await until(() => fs.existsSync(marker));
  const admitted = await new Promise(resolve => {
    const socket = net.createConnection(f.socketPath);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
  });
  await shutdown;
  await until(() => !alive(child.pid));
  assert.equal(admitted, false, "A stopping broker must not handshake against its closed app-server");
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

test("broker handshake EOF retries one private spawn before any task request", async t => {
  if (!await requireLocalSockets(t)) return;
  const f = fixture(), methods = [];
  const close = await serve(f, (socket, message) => { methods.push(message.method); socket.destroy(); });
  t.after(close);
  const events = [], client = await CodexAppServerClient.connect(f.dir, { env: f.env, brokerEndpoint: f.endpoint, onRuntimeEvent: event => events.push(event) });
  try {
    assert.equal(client.transport, "direct");
    await client.request("thread/start", { cwd: f.dir, sandbox: "read-only", approvalPolicy: "never" });
    assert.deepEqual(methods, ["initialize"]);
    const state = JSON.parse(fs.readFileSync(path.join(f.dir, "fake-codex-state.json")));
    assert.equal(state.threads.length, 1);
    assert.equal(state.appServerStarts, 1);
    assert.ok(events.some(e => e.brokerStartupRetry === true));
  } finally { await client.close(); }
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
  assert.equal(f.state().appServerStarts, 2, "neither app-server was replaced");
  t.diagnostic(`SIGTERM tree=${tree.join(",")}; worker=${owned.pid}; broker=${brokerPid}; peer=${peerJob.pid}; owner_stopped confirmed with turnEnded in ${elapsed} ms`);
});
}
