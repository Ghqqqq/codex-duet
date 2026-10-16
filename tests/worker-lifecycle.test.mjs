import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDir, initGitRepo, run, requireLocalSockets } from "./helpers.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { browserOriginSetup, transportSetup } from "../plugins/codex/scripts/lib/setup-config.mjs";
import { resolveIsolatedCodexHome } from "../plugins/codex/scripts/lib/codex-home.mjs";
import { spawnOwned } from "../plugins/codex/scripts/lib/process.mjs";
const script = new URL("../plugins/codex/scripts/codex-companion.mjs", import.meta.url).pathname;
const hook = new URL("../plugins/codex/scripts/session-lifecycle-hook.mjs", import.meta.url).pathname;
const brokerScript = new URL("../plugins/codex/scripts/app-server-broker.mjs", import.meta.url).pathname;
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } };
function fixture(behavior = "w5-working") {
  const dir = makeTempDir(), repo = path.join(dir, "repo"); fs.mkdirSync(repo); initGitRepo(repo); installFakeCodex(dir, behavior);
  const env = { ...buildEnv(dir), CLAUDE_PLUGIN_DATA: path.join(dir, "data"), CODEX_COMPANION_SESSION_ID: "fixture-session", CODEX_COMPANION_HOME: path.join(dir, "isolated") };
  return { dir, repo, env, call: (...args) => run(process.execPath, [script, ...args], { cwd: repo, env }), state: () => JSON.parse(fs.readFileSync(path.join(dir, "fake-codex-state.json"))), answer: (job, id, text) => run(process.execPath, [script, "answer", job, "--question", id, "--json"], { cwd: repo, env, input: text }) };
}
function json(result, code = 0) { assert.equal(result.status, code, result.stderr + result.stdout); return JSON.parse(result.stdout); }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitUntil(fn) { for (const end = Date.now() + 12000; Date.now() < end;) { const result = fn(); if (result) return result; await delay(80); } throw new Error("Fixture deadline expired"); }
function job(f, id) { return json(f.call("status", id, "--json")).job; }

test("detached wait returns bounded safe progress, startup phases and confirmed cancellation", () => {
  const f = fixture(); const launch = json(f.call("task", "--detached", "--report", "--json", "fixture work"));
  const snapshot = json(f.call("wait", launch.jobId, "--timeout-sec", "4", "--json", "--report"));
  assert.equal(snapshot.status, "running"); assert.ok(snapshot.headline.length <= 60);
  assert.equal(snapshot.completedItems.find(i => i.type === "commandExecution").exitCode, 0);
  for (const phase of ["brokerConnectSpawn", "appServerInitialize", "threadStart", "turnStart", "firstModelEvent", "firstToolCall", "mcpReady"]) assert.ok(snapshot.startupTimings[phase], phase);
  assert.match(snapshot.startupWarning, /WebSocket/);
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_FIXTURE/);
  const cancellation = json(f.call("cancel", launch.jobId, "--json")); assert.equal(cancellation.confirmation, "confirmed");
  const result = json(f.call("wait", launch.jobId, "--json", "--report"), 1);
  assert.equal(result.status, "cancelled"); assert.equal(result.interruptionConfirmed, true);
  assert.equal(f.state().lastInterrupt.turnId, snapshot.turnId);
  assert.doesNotMatch(fs.readFileSync(job(f, launch.jobId).logFile, "utf8"), /PRIVATE_FIXTURE/);
});

test("parent question and stdin answer continue the same turn; reports do not log answer text", () => {
  const f = fixture("w5-parent"), launch = json(f.call("task", "--detached", "--json", "ask fixture question"));
  const pending = json(f.call("wait", launch.jobId, "--json", "--report"));
  assert.equal(pending.status, "needs_answer"); assert.deepEqual(pending.question.options, ["Small", "Broad"]);
  const began = Date.now();
  const stillPending = json(f.call("wait", launch.jobId, "--after-question", pending.question.id, "--timeout-sec", "1", "--json"));
  assert.equal(stillPending.question.id, pending.question.id); assert.ok(Date.now() - began >= 900);
  assert.equal(json(f.answer(launch.jobId, pending.question.id, "Small PRIVATE_FIXTURE_ANSWER")).status, "answer_submitted");
  const done = json(f.call("wait", launch.jobId, "--json", "--report"));
  assert.equal(done.status, "completed"); assert.equal(done.turnId, pending.turnId);
  assert.equal(f.state().nextTurnId, 2); assert.equal(f.state().capabilities.experimentalApi, true);
  assert.deepEqual(f.state().serverRequestReplies[0].result, { success: true, contentItems: [{ type: "inputText", text: "Small PRIVATE_FIXTURE_ANSWER" }] });
  assert.doesNotMatch(fs.readFileSync(job(f, launch.jobId).logFile, "utf8"), /PRIVATE_FIXTURE_ANSWER|Which fixture/);
  assert.notEqual(f.answer(launch.jobId, pending.question.id, "late").status, 0);
});

test("question timeout resolves its callback with conservative-assumption guidance", async () => {
  const f = fixture("w5-parent"), launch = json(f.call("task", "--detached", "--json", "--question-timeout-sec", "1", "fixture"));
  await waitUntil(() => f.state().serverRequestReplies?.length);
  const result = json(f.call("wait", launch.jobId, "--json", "--report"));
  assert.equal(result.status, "completed"); assert.match(f.state().serverRequestReplies[0].result.contentItems[0].text, /conservative assumption/);
});

test("owner lease expiry interrupts a running worker; a foreign owner cannot renew it", async () => {
  const f = fixture(), launch = json(f.call("task", "--detached", "--json", "--lease-sec", "4", "--owner", "fixture-owner", "fixture"));
  await delay(4000);
  const result = json(f.call("wait", launch.jobId, "--timeout-sec", "6", "--json", "--report"), 1);
  assert.equal(result.status, "interrupted"); assert.equal(result.interruptionReason, "lease_expired"); assert.equal(result.interruptionConfirmed, true);
});

test("SessionEnd cancels only its session's jobs and retains confirmation evidence", () => {
  const f = fixture(), launch = json(f.call("task", "--detached", "--json", "fixture"));
  json(f.call("wait", launch.jobId, "--timeout-sec", "3", "--json", "--report"));
  const parentRepo = makeTempDir(); initGitRepo(parentRepo);
  const end = run(process.execPath, [hook, "SessionEnd"], { cwd: parentRepo, env: f.env, input: JSON.stringify({ session_id: "fixture-session", cwd: parentRepo }) });
  assert.equal(end.status, 0, end.stderr);
  const result = json(f.call("result", launch.jobId, "--json", "--report"), 1);
  assert.equal(result.status, "interrupted"); assert.equal(result.interruptionReason, "session_end"); assert.equal(result.interruptionConfirmed, true);
});

test("test-home guard rejects real homes and symlink aliases before creating them", () => {
  const f = fixture();
  for (const value of ["/fixture-real-home/.claude/codex-isolated", "/fixture-real-home/.codex"]) assert.throws(() => resolveIsolatedCodexHome({ ...f.env, CODEX_COMPANION_HOME: value }), /Test-home guard/);
  const alias = path.join(f.dir, "outside"); fs.symlinkSync(path.dirname(process.env.CODEX_COMPANION_TEST_ROOT), alias);
  assert.throws(() => resolveIsolatedCodexHome({ ...f.env, CODEX_COMPANION_HOME: alias }), /Test-home guard/);
});

test("task-worker SIGTERM resolves a pending question and confirms its turn interruption", async () => {
  const f = fixture("w5-parent"), launch = json(f.call("task", "--detached", "--json", "fixture"));
  const pending = json(f.call("wait", launch.jobId, "--json"));
  const owned = job(f, launch.jobId);
  process.kill(owned.pid, "SIGTERM"); // This worker was just spawned by this fixture.
  const done = json(f.call("wait", launch.jobId, "--after-question", pending.question.id, "--json", "--report"), 1);
  assert.equal(done.interruptionReason, "signal_sigterm"); assert.equal(done.interruptionConfirmed, true);
  assert.equal(done.turnId, pending.turnId);
  await waitUntil(() => !alive(owned.pid));
});

test("broker SIGTERM during initialize reaps its separately grouped app-server", async () => {
  const f = fixture("w5-initialize-hang");
  const child = spawnOwned(process.execPath, [brokerScript, "serve", "--endpoint", `unix:${path.join(f.dir, "startup.sock")}`, "--cwd", f.repo], { cwd: f.repo, env: f.env, stdio: "ignore" });
  const serverPid = await waitUntil(() => {
    try { return f.state().launches?.[0]?.pid; } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  });
  child.kill("SIGTERM");
  await waitUntil(() => !alive(serverPid) && !alive(child.pid));
});

test("cancel also interrupts a currently running review without killing a saved PID", async () => {
  const f = fixture("w5-review");
  const child = spawnOwned(process.execPath, [script, "review", "--scope", "working-tree", "--json"], { cwd: f.repo, env: f.env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = ""; child.stderr.on("data", chunk => { stderr += chunk; });
  const id = await waitUntil(() => /Job handle: ([^;]+);/.exec(stderr)?.[1]);
  await waitUntil(() => job(f, id).turnId);
  const cancelled = json(f.call("cancel", id, "--json"));
  assert.equal(cancelled.confirmation, "confirmed");
  assert.equal(f.state().lastInterrupt.turnId, job(f, id).turnId);
  await waitUntil(() => !alive(child.pid));
});

test("transport setup is opt-in, merges the hand-written provider, backs up once and is idempotent", () => {
  const f = fixture(), home = f.env.CODEX_COMPANION_HOME; fs.mkdirSync(home);
  const file = path.join(home, "config.toml"), before = 'model_provider = "openai-http"\n# retained\n[model_providers.openai-http]\nname = "OpenAI HTTP"\nbase_url = "https://chatgpt.com/backend-api/codex"\nwire_api = "responses"\nrequires_openai_auth = true\nsupports_websockets = false\n'; fs.writeFileSync(file, before);
  assert.deepEqual(transportSetup({ mode: "http", env: f.env }).changedFiles, []);
  assert.equal(transportSetup({ env: f.env }).transport, "http"); assert.equal(fs.readFileSync(file, "utf8"), before);
  const changed = transportSetup({ mode: "websocket", env: f.env }); assert.equal(changed.backups.length, 1); assert.equal(fs.readFileSync(changed.backups[0], "utf8"), before);
  assert.match(fs.readFileSync(file, "utf8"), /# retained/); assert.deepEqual(transportSetup({ mode: "websocket", env: f.env }).changedFiles, []);
  assert.equal(json(f.call("setup", "--transport", "status", "--json")).transport.transport, "websocket");
  assert.throws(() => transportSetup({ mode: "auto", env: f.env }), /must be/);
});

test("browser origin allow/revoke merges global settings and removes exact stale denies only", () => {
  const f = fixture(), browser = path.join(f.env.CODEX_COMPANION_HOME, "browser"), sessions = path.join(browser, "sessions"); fs.mkdirSync(sessions, { recursive: true });
  const global = path.join(browser, "config.toml"), session = path.join(sessions, "fixture-thread.toml");
  const before = '# retained\n[origins]\nallowed = ["https://other.example"] # preserved comment\ndenied = ["https://EXAMPLE.COM:443"]\n[other]\nkeep = "value"\n';
  fs.writeFileSync(global, before); fs.writeFileSync(session, '[origins]\nallowed = []\ndenied = ["https://example.com", "https://child.example.com"]\n[other]\nkeep = true\n');
  assert.equal(browserOriginSetup({ allow: ["HTTPS://EXAMPLE.COM:443"], env: f.env, dryRun: true }).changedFiles.length, 2); assert.equal(fs.readFileSync(global, "utf8"), before);
  const result = browserOriginSetup({ allow: ["https://example.com"], env: f.env }); assert.equal(result.changedFiles.length, 2); assert.equal(result.backups.length, 2);
  assert.match(fs.readFileSync(global, "utf8"), /# preserved comment/); assert.match(fs.readFileSync(session, "utf8"), /child.example.com/); assert.match(fs.readFileSync(session, "utf8"), /keep = true/);
  assert.deepEqual(browserOriginSetup({ allow: ["https://example.com"], env: f.env }).changedFiles, []);
  const revoked = browserOriginSetup({ revoke: ["https://example.com"], env: f.env }); assert.ok(revoked.denied.includes("https://example.com")); assert.ok(!revoked.allowed.includes("https://example.com"));
  assert.ok(json(f.call("setup", "--list-browser-origins", "--json")).browserOrigins.denied.includes("https://example.com"));
  assert.throws(() => browserOriginSetup({ allow: ["https://example.com/path"], env: f.env }), /requires an HTTP/);
});

test("broker prewarm is non-blocking and idle exit reaps the server group", async t => {
  if (!await requireLocalSockets(t)) return;
  const f = fixture("review-ok"), start = Date.now();
  const warmed = run(process.execPath, [hook, "SessionStart"], { cwd: f.repo, env: f.env, input: JSON.stringify({ session_id: "fixture-session", cwd: f.repo }) });
  assert.equal(warmed.status, 0, warmed.stderr); assert.ok(Date.now() - start < 2000);
  // The helper state root is selected by the child env, not this test's default.
  const stateRoot = path.join(f.env.CLAUDE_PLUGIN_DATA, "state");
  const broker = await waitUntil(() => {
    if (!fs.existsSync(stateRoot)) return null;
    const dir = fs.readdirSync(stateRoot)[0]; const file = dir && path.join(stateRoot, dir, "broker.json");
    return file && fs.existsSync(file) && JSON.parse(fs.readFileSync(file));
  });
  await waitUntil(() => { try { process.kill(broker.pid, 0); return false; } catch (e) { return e.code === "ESRCH"; } });
  for (const launch of f.state().launches) assert.equal(alive(launch.pid), false, "Idle exit must reap its app-server too");
});
