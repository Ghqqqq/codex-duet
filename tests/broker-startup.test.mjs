import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDir, requireLocalSockets, run } from "./helpers.mjs";
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
