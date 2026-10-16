import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDir, requireLocalSockets } from "./helpers.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { CodexAppServerClient } from "../plugins/codex/scripts/lib/app-server.mjs";
import { spawnBrokerProcess, waitForBrokerEndpoint, sendBrokerShutdown } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { resolveCodexRuntimeIdentity, resolveIsolatedCodexHome } from "../plugins/codex/scripts/lib/codex-home.mjs";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
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
  const shutdown = sendBrokerShutdown(f.endpoint);
  await until(() => fs.existsSync(marker));
  const admitted = await new Promise(resolve => {
    const socket = net.createConnection(f.socketPath);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
  });
  await shutdown;
  await until(() => child.exitCode !== null || child.signalCode !== null);
  assert.equal(admitted, false, "A stopping broker must not handshake against its closed app-server");
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
