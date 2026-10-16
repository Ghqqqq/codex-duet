import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDir, initGitRepo, run, requireLocalSockets } from "./helpers.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { browserOriginSetup, transportSetup } from "../plugins/codex/scripts/lib/setup-config.mjs";
import { resolveIsolatedCodexHome } from "../plugins/codex/scripts/lib/codex-home.mjs";
import { redactActivity, itemActivity, planActivity, activityReader } from "../plugins/codex/scripts/lib/activity.mjs";
import { writeJobFile, upsertJob, updateJob, readJobFile, resolveJobFile } from "../plugins/codex/scripts/lib/state.mjs";
import { JobRuntime, renewLease, leaseSnapshot, questionMessage, adoptJob, ownershipNotice, answerQuestion, ownerLost, PARENT_BRIDGE_ENV } from "../plugins/codex/scripts/lib/job-runtime.mjs";
const bridgeScript = new URL("../plugins/codex/scripts/parent-bridge-mcp.mjs", import.meta.url).pathname;
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
  assert.deepEqual(result.activity, []); // This observer already consumed the command/plan events.
  assert.ok(result.cursor > 0);
  assert.doesNotMatch(fs.readFileSync(job(f, launch.jobId).logFile, "utf8"), /PRIVATE_FIXTURE/);
});

test("parent question and stdin answer continue the same turn; reports do not log answer text", () => {
  const f = fixture("w5-parent"), launch = json(f.call("task", "--detached", "--json", "ask fixture question"));
  const pending = json(f.call("wait", launch.jobId, "--json", "--report"));
  assert.equal(pending.questionMessage, `Question ${pending.question.id}: Which fixture approach? | Options: "Small"; "Broad"`);
  assert.equal(pending.status, "needs_answer"); assert.deepEqual(pending.question.options, ["Small", "Broad"]);
  const began = Date.now();
  const stillPending = json(f.call("wait", launch.jobId, "--after-question", pending.question.id, "--timeout-sec", "1", "--json"));
  assert.equal(stillPending.question.id, pending.question.id); assert.ok(Date.now() - began >= 900);
  assert.equal(json(f.answer(launch.jobId, pending.question.id, "Small PRIVATE_FIXTURE_ANSWER")).status, "answer_submitted");
  const done = json(f.call("wait", launch.jobId, "--json", "--report"));
  assert.equal(done.status, "completed"); assert.equal(done.turnId, pending.turnId);
  const ended = json(f.call("adopt", launch.jobId, "--json"), 2);
  assert.equal(ended.status, "job_ended"); assert.equal(ended.jobStatus, "completed");
  assert.ok(ended.continuationCommand.includes(`task --continue '${launch.jobId}'`));
  assert.equal(ended.ownerId, launch.ownerId);
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
  assert.ok(result.continuationCommand.includes(`task --continue '${launch.jobId}' --cwd '${f.repo}' --follow --report --json`));
  assert.match(result.continuationNote, /not been run/);
  const late = json(f.call("wait", launch.jobId, "--owner", launch.ownerId, "--json"), 1);
  assert.equal(late.interruptionReason, "lease_expired");
  assert.equal(f.state().nextTurnId, 2, "Late owner polling must not start a new turn");
  assert.equal(json(f.call("result", launch.jobId, "--report", "--json"), 1).continuationCommand, result.continuationCommand);
  const expired = json(f.call("adopt", launch.jobId, "--json"), 2);
  assert.equal(expired.status, "lease_expired"); assert.equal(expired.adopted, false);
  assert.equal(expired.continuationCommand, result.continuationCommand);
  assert.equal(job(f, launch.jobId).ownerId, launch.ownerId);
  assert.equal(f.state().nextTurnId, 2, "Expired adoption never starts another turn");
});

test("SessionEnd cancels only its session's jobs and retains confirmation evidence", () => {
  const f = fixture(), launch = json(f.call("task", "--detached", "--json", "fixture"));
  json(f.call("wait", launch.jobId, "--timeout-sec", "3", "--json", "--report"));
  f.env.CODEX_COMPANION_SESSION_ID = "foreign-session";
  const foreign = json(f.call("task", "--detached", "--json", "foreign fixture"));
  f.env.CODEX_COMPANION_SESSION_ID = "fixture-session";
  const foreignRunning = json(f.call("wait", foreign.jobId, "--timeout-sec", "3", "--json"));
  assert.ok(foreignRunning.turnId, "Wait for the foreign fixture turn before testing cancellation confirmation");
  const parentRepo = makeTempDir(); initGitRepo(parentRepo);
  const end = run(process.execPath, [hook, "SessionEnd"], { cwd: parentRepo, env: f.env, input: JSON.stringify({ session_id: "fixture-session", cwd: parentRepo }) });
  assert.equal(end.status, 0, end.stderr);
  const result = json(f.call("result", launch.jobId, "--json", "--report"), 1);
  assert.equal(result.status, "interrupted"); assert.equal(result.interruptionReason, "session_end"); assert.equal(result.interruptionConfirmed, true);
  assert.equal(job(f, foreign.jobId).status, "running");
  json(f.call("cancel", foreign.jobId, "--json"));
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


test("activity keeps text as written (no credential heuristics), strips terminal noise and selects no tool payloads", () => {
  for (const value of ["ANSWER=Yes", "KEY=assignment-value", "Authorization: Bearer header-value", "https://user:pw@example.com/path", "sk-fixture123", "npm test src/example.mjs"]) {
    assert.equal(redactActivity(value), value);
  }
  assert.equal(redactActivity("\x1b[31mred\x1b[0m\u202eflip\x07"), "red flip ", "ANSI escapes are removed; control/bidi characters become spaces");
  const starts = new Map();
  const tool = { type: "mcpToolCall", server: "fixture", tool: "inspect", status: "completed", arguments: "PRIVATE_ARGS", result: "PRIVATE_RESULT", output: "PRIVATE_OUTPUT" };
  assert.doesNotMatch(JSON.stringify(itemActivity(tool, "completed", starts, "t")), /PRIVATE/);
  const message = itemActivity({ type: "agentMessage", text: "word ".repeat(100) + " TOKEN=secret" }, "completed", starts, "m")[0];
  assert.equal(message.text.length, 300);
  const command = itemActivity({ type: "commandExecution", command: "echo " + "word ".repeat(100) }, "started", starts, "c", 100)[0];
  assert.equal(command.command.length, 160);
  assert.equal(itemActivity({ type: "commandExecution" }, "completed", starts, "c", 225)[0].durationMs, 125);
  assert.equal(planActivity([{ step: "word ".repeat(100) }])[0].steps[0].length, 80);
  assert.equal(itemActivity({ type: "commandExecution", command: 'FOO="first\nsecond-line" node script\nPRIVATE_BODY' }, "completed", starts, "c")[0].command, 'FOO="first', "only the first command line is shown");
});

test("feed streams before return, returns early and persists independent owner cursors", async () => {
  const f = fixture("w9-feed"), launch = json(f.call("task", "--detached", "--report", "--json", "fixture"));
  const began = Date.now(), chunks = [];
  const child = spawnOwned(process.execPath, [script, "wait", launch.jobId, "--owner", launch.ownerId, "--timeout-sec", "9", "--min-interval-sec", "4", "--report"], { cwd: f.repo, env: f.env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stdout.on("data", chunk => chunks.push({ at: Date.now(), text: String(chunk) }));
  child.stderr.on("data", chunk => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => { child.on("close", resolve); child.on("error", reject); });
  const elapsed = Date.now() - began;
  assert.equal(code, 0, stderr);
  assert.ok(elapsed >= 3900 && elapsed < 8000, `early return elapsed ${elapsed}`);
  assert.ok(Date.now() - chunks[0].at > 500, "A feed line must arrive before the final JSON/exit");
  const stdout = chunks.map(c => c.text).join("");
  assert.doesNotMatch(stdout + stderr, /PRIVATE_FIXTURE/);
  const lines = stdout.trim().split("\n"), final = JSON.parse(lines.at(-1));
  assert.equal(lines.filter(line => line.startsWith("{")).length, 1);
  assert.equal(final.status, "running");
  assert.equal(final.activity.length, lines.length - 1);
  assert.match(stdout, /Command completed: npm test.*exit 0; 425ms/);
  assert.match(stdout, /File update: src\/example.mjs/);
  assert.match(stdout, /Tool fixture\/inspect: completed \(10ms\)/);
  assert.match(stdout, /Codex: Inspecting the fixture/);
  assert.match(stdout, /Plan: Inspect fixture; Verify/);
  const same = json(f.call("wait", launch.jobId, "--owner", launch.ownerId, "--timeout-sec", "1", "--json"));
  assert.deepEqual(same.activity, []); assert.equal(same.cursor, final.cursor);
  const observer = json(f.call("wait", launch.jobId, "--timeout-sec", "1", "--json"));
  assert.deepEqual(observer.activity, final.activity);
  const other = json(f.call("wait", launch.jobId, "--owner", "other-reader", "--timeout-sec", "1", "--json"));
  assert.deepEqual(other.activity, final.activity);
  const saved = job(f, launch.jobId);
  for (const owner of [launch.ownerId, undefined, "other-reader"]) assert.equal(saved.activityCursors[activityReader(owner)], final.cursor);
  assert.equal(json(f.call("cancel", launch.jobId, "--json")).confirmation, "confirmed");
  const done = f.call("wait", launch.jobId, "--owner", launch.ownerId);
  assert.equal(done.status, 1); assert.doesNotMatch(done.stdout, /PRIVATE_FIXTURE/);
  assert.equal(JSON.parse(done.stdout.trim().split("\n").at(-1)).status, "cancelled");
  assert.doesNotMatch(f.call("status", launch.jobId, "--json").stdout, /PRIVATE_FIXTURE/);
});

test("per-job owners ignore ambient identity; adoption transfers the same turn and rejects the old owner", async () => {
  const f = fixture("w5-parent"); f.env.CODEX_COMPANION_OWNER_ID = "ambient-owner";
  const first = json(f.call("task", "--detached", "--json", "--lease-sec", "30", "first"));
  const second = json(f.call("task", "--detached", "--json", "second"));
  assert.notEqual(first.ownerId, second.ownerId); assert.notEqual(first.ownerId, "fixture-session"); assert.notEqual(first.ownerId, "ambient-owner");
  assert.equal(first.sessionId, "fixture-session");
  const initial = job(f, first.jobId).leaseExpiresAt;
  f.call("status", "--json"); f.call("result", first.jobId, "--json", "--report");
  json(f.call("wait", first.jobId, "--timeout-sec", "1", "--json"));
  json(f.call("status", first.jobId, "--owner", second.ownerId, "--json"));
  assert.equal(job(f, first.jobId).leaseExpiresAt, initial);
  await delay(15100);
  const orphan = job(f, first.jobId);
  assert.equal(orphan.orphaned, true); assert.ok(orphan.leaseRemainingSec > 0);
  assert.match(f.call("status").stdout, /orphaned; [0-9]+s lease/);
  assert.ok(orphan.adoptCommand.includes(`adopt '${first.jobId}' --cwd '${f.repo}' --json`));
  assert.ok(f.call("status").stdout.includes(orphan.adoptCommand));
  // An old wait already in flight must notice rotation, too.
  const pending = json(f.call("wait", first.jobId, "--owner", first.ownerId, "--json"));
  const oldWait = spawnOwned(process.execPath, [script, "wait", first.jobId, "--owner", first.ownerId, "--after-question", pending.question.id, "--timeout-sec", "30", "--json"], { cwd: f.repo, env: f.env, stdio: ["ignore", "pipe", "pipe"] });
  let oldOutput = ""; oldWait.stdout.on("data", chunk => { oldOutput += chunk; });
  const oldDone = new Promise((resolve, reject) => { oldWait.on("close", resolve); oldWait.on("error", reject); });
  await delay(200);
  f.env.CODEX_COMPANION_SESSION_ID = "replacement-session";
  const adopted = json(f.call("adopt", first.jobId, "--json"));
  assert.equal(adopted.status, "adopted"); assert.equal(adopted.adopted, true);
  assert.notEqual(adopted.ownerId, first.ownerId); assert.equal(adopted.sessionId, "replacement-session");
  assert.equal(adopted.threadId, pending.threadId); assert.equal(adopted.turnId, pending.turnId);
  assert.ok(adopted.waitCommand.includes(`wait '${first.jobId}' --owner '${adopted.ownerId}'`));
  assert.equal(await oldDone, 2); assert.equal(JSON.parse(oldOutput).status, "ownership_moved");
  const initialAdopted = job(f, first.jobId).leaseExpiresAt;
  for (const cmd of ["status", "wait"]) {
    const moved = json(f.call(cmd, first.jobId, "--owner", first.ownerId, "--json"), 2);
    assert.equal(moved.status, "ownership_moved"); assert.equal(moved.ownerId, adopted.ownerId);
  }
  const rejectedAnswer = run(process.execPath, [script, "answer", first.jobId, "--owner", first.ownerId, "--question", pending.question.id, "--json"], { cwd: f.repo, env: f.env, input: "Do not deliver" });
  assert.equal(json(rejectedAnswer, 2).status, "ownership_moved");
  assert.equal(job(f, first.jobId).pendingQuestion.answer, undefined);
  assert.equal(job(f, first.jobId).leaseExpiresAt, initialAdopted);
  assert.equal(json(f.call("status", "--json")).running.some(j => j.id === first.jobId), true);
  const attached = json(f.call("wait", first.jobId, "--owner", adopted.ownerId, "--json"));
  assert.equal(attached.status, "needs_answer"); assert.equal(attached.orphaned, false);
  assert.equal(attached.questionMessage, pending.questionMessage);
  assert.deepEqual(attached.activity, [], "Adoption inherits the last delivered owner cursor");
  assert.equal(attached.cursor, pending.cursor);
  assert.ok(job(f, first.jobId).leaseExpiresAt > initialAdopted);
  const renewed = job(f, first.jobId).leaseExpiresAt;
  json(f.call("status", first.jobId, "--owner", adopted.ownerId, "--json"));
  assert.ok(job(f, first.jobId).leaseExpiresAt > renewed);
  const answer = run(process.execPath, [script, "answer", first.jobId, "--owner", adopted.ownerId, "--question", attached.question.id, "--json"], { cwd: f.repo, env: f.env, input: "Small" });
  assert.equal(json(answer).status, "answer_submitted");
  const done = json(f.call("wait", first.jobId, "--owner", adopted.ownerId, "--json"));
  assert.equal(done.status, "completed"); assert.equal(done.turnId, attached.turnId);
  assert.equal(f.state().nextTurnId, 3, "Adoption does not submit a new turn");
  json(f.call("cancel", second.jobId, "--json"));
});

test("legacy session-ID owners remain readable and session-scoped without implicit renewal", () => {
  const f = fixture(), launch = json(f.call("task", "--detached", "--json", "--owner", "fixture-session", "fixture"));
  json(f.call("wait", launch.jobId, "--timeout-sec", "3", "--json"));
  const stateModule = new URL("../plugins/codex/scripts/lib/state.mjs", import.meta.url).href;
  const edit = run(process.execPath, ["--input-type=module", "-e", `import { updateJob } from ${JSON.stringify(stateModule)}; updateJob(process.cwd(), ${JSON.stringify(launch.jobId)}, () => ({ sessionId: undefined, activity: undefined, activityCursors: undefined, activitySeq: undefined, leaseRenewedAt: undefined }));`], { cwd: f.repo, env: f.env });
  assert.equal(edit.status, 0, edit.stderr);
  const before = job(f, launch.jobId).leaseExpiresAt;
  assert.equal(json(f.call("status", "--json")).running[0].id, launch.jobId);
  const snapshot = json(f.call("wait", launch.jobId, "--timeout-sec", "1", "--json"));
  assert.deepEqual(snapshot.activity, []); assert.equal(snapshot.cursor, 0);
  assert.equal(job(f, launch.jobId).leaseExpiresAt, before);
  json(f.call("wait", launch.jobId, "--owner", "fixture-session", "--timeout-sec", "1", "--json"));
  assert.ok(job(f, launch.jobId).leaseExpiresAt > before);
  const ended = run(process.execPath, [hook, "SessionEnd"], { cwd: f.repo, env: f.env, input: JSON.stringify({ session_id: "fixture-session", cwd: f.repo }) });
  assert.equal(ended.status, 0, ended.stderr);
  assert.equal(json(f.call("result", launch.jobId, "--json", "--report"), 1).interruptionReason, "session_end");
});

test("orphan threshold and questionMessage are deterministic and single-line", () => {
  const job = { status: "running", leaseSec: 180, leaseExpiresAt: 181000, leaseRenewedAt: 1000 };
  assert.equal(leaseSnapshot(job, 65999).orphaned, false);
  assert.deepEqual(leaseSnapshot(job, 66000), { orphaned: true, leaseRemainingSec: 115, leaseRenewedAt: 1000 });
  assert.equal(questionMessage({ id: "q-1", text: "Which\nchoice? TOKEN=value", options: ["Small\r\nchange", "Large"] }), 'Question q-1: Which choice? TOKEN=value | Options: "Small change"; "Large"');
  assert.equal(questionMessage({ id: "q-2", text: "Choose?", options: [] }), "Question q-2: Choose? | Options: (none)");
});


test("expired leases cannot be revived before the worker observes expiry", () => {
  const cwd = makeTempDir(), now = Date.now();
  const record = { id: "expired-owner-test", ownerId: "owner", status: "running", jobClass: "task", workspaceRoot: cwd, threadId: "expired-thread", leaseSec: 180, leaseRenewedAt: now - 180001, leaseExpiresAt: now - 1 };
  writeJobFile(cwd, record.id, record); upsertJob(cwd, record);
  assert.equal(renewLease(cwd, record.id, "owner").leaseExpiresAt, record.leaseExpiresAt);
  assert.equal(renewLease(cwd, record.id).leaseExpiresAt, record.leaseExpiresAt);
  const adopted = adoptJob(cwd, record.id, "new-session");
  assert.equal(adopted.status, "lease_expired"); assert.equal(adopted.ownerId, record.ownerId);
  assert.ok(adopted.continuationCommand.includes("task --continue 'expired-owner-test'"));
  const runtime = new JobRuntime(cwd, record.id, { foreground: true });
  try { assert.equal(runtime.reason, "lease_expired"); } finally { runtime.close(); }
});


test("adoption preserves legacy session scope, rotates every time and rejects cancellation", () => {
  const cwd = makeTempDir();
  const record = { id: "legacy-adopt", ownerId: "legacy-session", status: "running", jobClass: "task", workspaceRoot: cwd, leaseSec: 180, leaseExpiresAt: Date.now() + 180000 };
  writeJobFile(cwd, record.id, record); upsertJob(cwd, record);
  const first = adoptJob(cwd, record.id);
  assert.equal(first.status, "adopted"); assert.equal(first.sessionId, "legacy-session");
  const second = adoptJob(cwd, record.id);
  assert.equal(second.status, "adopted"); assert.notEqual(second.ownerId, first.ownerId);
  const stored = renewLease(cwd, record.id, "legacy-session");
  assert.equal(ownershipNotice(stored, first.ownerId).status, "ownership_moved");
  assert.equal(ownershipNotice(stored, "legacy-session").status, "ownership_moved");
  writeJobFile(cwd, record.id, { ...stored, cancelRequested: { reason: "cancelled_by_user" } });
  const stopping = adoptJob(cwd, record.id);
  assert.equal(stopping.status, "interrupting"); assert.equal(stopping.ownerId, second.ownerId);
  assert.equal(stopping.continuationCommand, null);
  writeJobFile(cwd, record.id, { ...stored, sessionId: null });
  assert.equal(adoptJob(cwd, record.id).sessionId, null, "Known absence of a session is not a legacy session-ID owner");
});

test("default wait blocks through activity and caps the reported activity list", async () => {
  const f = fixture("w9-feed"), launch = json(f.call("task", "--detached", "--report", "--json", "fixture"));
  const began = Date.now(), feed = f.call("wait", launch.jobId, "--owner", launch.ownerId, "--timeout-sec", "3", "--report");
  assert.equal(feed.status, 0, feed.stderr);
  assert.ok(Date.now() - began >= 2900, "no early return on activity without --min-interval-sec");
  const lines = feed.stdout.trim().split("\n"), final = JSON.parse(lines.at(-1));
  assert.equal(final.status, "running"); assert.ok(lines.length > 3, "feed lines still stream in feed mode");
  assert.equal(final.activityCount, final.activity.length); assert.equal(final.activityOmitted, undefined);
  assert.equal(job(f, launch.jobId).ownerDetachReason, "returned", "a clean return never starts the owner-lost clock");
  const stateModule = new URL("../plugins/codex/scripts/lib/state.mjs", import.meta.url).href;
  const padded = run(process.execPath, ["--input-type=module", "-e", `import { updateJob } from ${JSON.stringify(stateModule)}; updateJob(process.cwd(), ${JSON.stringify(launch.jobId)}, stored => ({ activity: [...stored.activity, ...Array.from({ length: 20 }, (_, i) => ({ type: "message", text: "extra " + i, seq: stored.activitySeq + i + 1, at: new Date().toISOString() }))], activitySeq: stored.activitySeq + 20 }));`], { cwd: f.repo, env: f.env });
  assert.equal(padded.status, 0, padded.stderr);
  const capped = json(f.call("wait", launch.jobId, "--owner", "capped-reader", "--timeout-sec", "1", "--json"));
  assert.equal(capped.activity.length, 12); assert.equal(capped.activityOmitted, capped.activityCount - 12); assert.ok(capped.activityCount >= 20);
  assert.equal(capped.activity.at(-1).seq, capped.cursor, "the newest events are the ones kept");
  // Feed mode streams at most --feed-limit lines per call (the agent's context pays for each one).
  const limited = f.call("wait", launch.jobId, "--owner", "feed-reader", "--timeout-sec", "1", "--feed-limit", "5", "--report");
  assert.equal(limited.status, 0, limited.stderr);
  const limitedLines = limited.stdout.trim().split("\n");
  assert.equal(limitedLines.filter(line => !line.startsWith("{") && !line.startsWith("…")).length, 5, "five feed lines, then the pause notice");
  assert.match(limitedLines[5], /^… feed paused after 5 lines/);
  const limitedFinal = JSON.parse(limitedLines.at(-1));
  assert.ok(limitedFinal.activityCount >= 20, "events after the cap are still counted and cursor-tracked");
  assert.equal(limitedFinal.activity.at(-1).seq, limitedFinal.cursor);
  const unlimited = f.call("wait", launch.jobId, "--owner", "all-reader", "--timeout-sec", "1", "--feed-limit", "0", "--report");
  assert.equal(unlimited.stdout.trim().split("\n").length - 1, JSON.parse(unlimited.stdout.trim().split("\n").at(-1)).activityCount, "--feed-limit 0 streams every event");
  assert.match(f.call("wait", launch.jobId, "--feed-limit", "many", "--timeout-sec", "1").stderr, /--feed-limit/);
  json(f.call("cancel", launch.jobId, "--json"));
});

test("an owner wait that dies abruptly interrupts the worker after the grace period", async () => {
  const f = fixture(); f.env.CODEX_COMPANION_OWNER_GRACE_SEC = "2";
  const launch = json(f.call("task", "--detached", "--json", "fixture"));
  const owner = spawnOwned(process.execPath, [script, "wait", launch.jobId, "--owner", launch.ownerId, "--timeout-sec", "60", "--json"], { cwd: f.repo, env: f.env, stdio: ["ignore", "pipe", "pipe"] });
  await waitUntil(() => job(f, launch.jobId).ownerAttached && job(f, launch.jobId).turnId);
  owner.kill("SIGKILL"); // Simulates Claude Code killing the Bash command when the user stops the agent.
  const killedAt = Date.now();
  const result = json(f.call("wait", launch.jobId, "--timeout-sec", "15", "--json", "--report"), 1);
  assert.equal(result.status, "interrupted"); assert.equal(result.interruptionReason, "owner_lost"); assert.equal(result.interruptionConfirmed, true);
  assert.ok(Date.now() - killedAt < 8000, "interruption follows the grace period, not the 180 s lease");
  assert.ok(result.continuationCommand.includes(`task --continue '${launch.jobId}'`));
  assert.equal(f.state().lastInterrupt.turnId, result.turnId);
});

test("a signalled owner wait stops the worker immediately; only a silent owner gets the grace period", async () => {
  const f = fixture();
  const launch = json(f.call("task", "--detached", "--json", "fixture"));
  const owner = spawnOwned(process.execPath, [script, "wait", launch.jobId, "--owner", launch.ownerId, "--timeout-sec", "60", "--json"], { cwd: f.repo, env: f.env, stdio: ["ignore", "pipe", "pipe"] });
  await waitUntil(() => job(f, launch.jobId).ownerAttached && job(f, launch.jobId).turnId);
  owner.kill("SIGTERM"); // Claude Code stopping the agent's Bash call, or Ctrl+C on a terminal --follow.
  const signalledAt = Date.now();
  const code = await new Promise(resolve => owner.on("close", resolve));
  assert.equal(code, 130);
  const result = json(f.call("wait", launch.jobId, "--timeout-sec", "10", "--json", "--report"), 1);
  assert.equal(result.status, "interrupted"); assert.equal(result.interruptionReason, "owner_stopped"); assert.equal(result.interruptionConfirmed, true);
  assert.ok(Date.now() - signalledAt < 3000, `an explicit detach does not wait for the grace period (${Date.now() - signalledAt} ms)`);
  assert.ok(result.continuationCommand.includes(`task --continue '${launch.jobId}'`));
  const detached = job(f, launch.jobId);
  assert.equal(detached.ownerAttached, false); assert.equal(detached.ownerDetachReason, "signal");
  // ownerLost semantics, evaluated directly (this process uses the default 5 s grace).
  const active = { ...detached, status: "running" };
  assert.equal(ownerLost(active, active.ownerDetachedAt + 1), true, "signal/parent_exit/stdout_closed detaches count immediately");
  assert.equal(ownerLost({ ...active, ownerDetachReason: "returned" }, active.ownerDetachedAt + 60000), false, "a clean return falls back to the lease");
  assert.equal(ownerLost({ ...active, ownerDetachReason: null, ownerDetachedAt: null }, active.ownerDetachedAt + 60000), false, "never attached: lease only");
  const silent = { ...active, ownerAttached: true, leaseRenewedAt: 1000 };
  assert.equal(ownerLost(silent, 1000 + 4999), false); assert.equal(ownerLost(silent, 1000 + 5000), true, "a silent heartbeat is given 5 s");
  // A clean return followed by silence (the worker between two wait calls) is not a stop.
  const second = json(f.call("task", "--detached", "--json", "fixture"));
  json(f.call("wait", second.jobId, "--owner", second.ownerId, "--timeout-sec", "1", "--json"));
  assert.equal(job(f, second.jobId).ownerDetachReason, "returned");
  await delay(5600);
  assert.equal(job(f, second.jobId).status, "running", "a clean return followed by silence falls back to the lease, not the grace clock");
  json(f.call("wait", second.jobId, "--owner", "not-the-owner", "--timeout-sec", "1", "--json"));
  assert.equal(job(f, second.jobId).ownerDetachReason, "returned", "a non-owner reader neither attaches nor detaches");
  assert.equal(json(f.call("cancel", second.jobId, "--json")).confirmation, "confirmed");
});

test("task --follow submits and waits in one call as the owner", () => {
  const f = fixture("w9-feed");
  const began = Date.now(), followed = json(f.call("task", "--follow", "--json", "--timeout-sec", "2", "fixture"));
  assert.ok(Date.now() - began >= 1900);
  assert.equal(followed.status, "running"); assert.ok(followed.jobId); assert.ok(followed.ownerId); assert.ok(followed.turnId);
  assert.ok(followed.activityCount > 0, "activity observed during the follow is reported");
  const stored = job(f, followed.jobId);
  assert.equal(stored.ownerId, followed.ownerId); assert.equal(stored.ownerDetachReason, "returned");
  assert.doesNotMatch(JSON.stringify(followed), /PRIVATE_FIXTURE/);
  json(f.call("cancel", followed.jobId, "--json"));
});

test("task --continue resumes the job's thread with its recorded authorization and a parent bridge", async () => {
  const f = fixture("slow-task");
  const first = json(f.call("task", "--detached", "--json", "--sandbox", "workspace-write", "first assignment"));
  const done = json(f.call("wait", first.jobId, "--json", "--report"));
  assert.equal(done.status, "completed"); assert.equal(done.sandbox, "workspace-write");
  for (const extra of [["--write"], ["--sandbox", "read-only"], ["--thread", done.threadId], ["--model", "other"], ["--approve-browser-origin", "https://example.com"]]) {
    const rejected = f.call("task", "--continue", first.jobId, ...extra, "--json");
    assert.notEqual(rejected.status, 0); assert.match(rejected.stderr, /--continue/);
  }
  assert.match(f.call("task", "--continue", "missing-job", "--json").stderr, /No stored job/);
  const second = json(f.call("task", "--continue", first.jobId, "--follow", "--report", "--json", "continue with the next step"));
  assert.equal(second.status, "completed"); assert.notEqual(second.jobId, first.jobId); assert.equal(second.threadId, done.threadId);
  assert.equal(second.sandbox, "workspace-write", "the original job's narrowed sandbox is inherited, not the full-access default");
  const resume = f.state().lastThreadResume;
  assert.equal(resume.threadId, done.threadId); assert.equal(resume.sandbox, "workspace-write");
  const bridge = resume.config.mcp_servers.duet_parent;
  assert.equal(bridge.command, process.execPath); assert.match(bridge.args[0], /parent-bridge-mcp\.mjs$/);
  assert.equal(bridge.env[PARENT_BRIDGE_ENV.threadId], done.threadId, "the bridge is bound to the thread, not the job"); assert.equal(bridge.env[PARENT_BRIDGE_ENV.cwd], f.repo);
  assert.equal(bridge.env.CLAUDE_PLUGIN_DATA, f.env.CLAUDE_PLUGIN_DATA); assert.equal(bridge.tool_timeout_sec, 900 + 120);
  assert.equal(Object.keys(bridge.env).filter(k => !["CLAUDE_PLUGIN_DATA", "TMPDIR", PARENT_BRIDGE_ENV.threadId, PARENT_BRIDGE_ENV.cwd].includes(k)).length, 0, "no other environment leaks into the bridge");
  assert.deepEqual(bridge.omit_tools_from, ["code_mode", "deferred"], "the tool must stay out of the deferred set or the model never sees it");
  assert.equal(bridge.tools.ask_parent.approval_mode, "approve", "approvalPolicy never would otherwise reject the call");
  assert.match(f.state().lastTurnStart.prompt, /continue with the next step/);
  assert.equal(job(f, second.jobId).request.continuedFrom, first.jobId);
  assert.equal(f.state().lastThreadStart.config, undefined, "new threads keep the in-process dynamic tool");
  const running = json(f.call("task", "--detached", "--json", "third"));
  assert.match(f.call("task", "--continue", running.jobId, "--json").stderr, /still (queued|running)/);
  json(f.call("cancel", running.jobId, "--json"));
});

test("the parent bridge answers ask_parent through the job file and reports cancellation", async () => {
  const cwd = makeTempDir(), id = "bridge-job", threadId = "thread-bridge";
  writeJobFile(cwd, id, { id, status: "running", jobClass: "task", workspaceRoot: cwd, ownerId: "owner", questionTimeoutSec: 5, threadId });
  upsertJob(cwd, { id, status: "running", jobClass: "task", workspaceRoot: cwd, threadId, createdAt: "2026-01-01T00:00:00.000Z" });
  const env = { ...process.env, [PARENT_BRIDGE_ENV.cwd]: cwd, [PARENT_BRIDGE_ENV.threadId]: threadId };
  const bridge = spawnOwned(process.execPath, [bridgeScript], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  const replies = []; let buffer = "";
  bridge.stdout.on("data", chunk => { buffer += chunk; let i; while ((i = buffer.indexOf("\n")) >= 0) { replies.push(JSON.parse(buffer.slice(0, i))); buffer = buffer.slice(i + 1); } });
  const send = message => bridge.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const reply = id => waitUntil(() => replies.find(r => r.id === id));
  send({ id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
  assert.equal((await reply(1)).result.serverInfo.name, "duet-parent-bridge");
  send({ method: "notifications/initialized" });
  send({ id: 2, method: "tools/list" });
  assert.deepEqual((await reply(2)).result.tools.map(t => t.name), ["ask_parent"]);
  send({ id: 3, method: "tools/call", params: { name: "ask_parent", arguments: { question: "Which way?", options: ["A", "B"] } } });
  const pending = await waitUntil(() => readJobFile(resolveJobFile(cwd, id)).pendingQuestion);
  assert.equal(pending.text, "Which way?"); assert.deepEqual(pending.options, ["A", "B"]);
  answerQuestion(cwd, id, pending.id, "Go with A", "owner");
  const answered = await reply(3);
  assert.equal(answered.result.isError, false); assert.equal(answered.result.content[0].text, "Go with A");
  send({ id: 4, method: "tools/call", params: { name: "ask_parent", arguments: { question: "x".repeat(1001) } } });
  assert.equal((await reply(4)).result.isError, true);
  updateJob(cwd, id, () => ({ cancelRequested: { reason: "cancelled_by_user", at: new Date().toISOString() } }));
  send({ id: 5, method: "tools/call", params: { name: "ask_parent", arguments: { question: "Still there?" } } });
  assert.match((await reply(5)).result.content[0].text, /owner cancelled this task/);
  // The broker keeps a thread loaded across runs, so one bridge process outlives
  // the job that spawned it: once that job is over, calls bind to the thread's
  // newest active job, and with none active the tool reports it instead of hanging.
  updateJob(cwd, id, () => ({ status: "completed", cancelRequested: null }));
  upsertJob(cwd, { id, status: "completed" });
  send({ id: 6, method: "tools/call", params: { name: "ask_parent", arguments: { question: "Anyone?" } } });
  const nobody = await reply(6);
  assert.equal(nobody.result.isError, true); assert.match(nobody.result.content[0].text, /No Duet task is listening/);
  const next = "bridge-job-2";
  writeJobFile(cwd, next, { id: next, status: "running", jobClass: "task", workspaceRoot: cwd, ownerId: "owner-2", questionTimeoutSec: 5, threadId });
  upsertJob(cwd, { id: next, status: "running", jobClass: "task", workspaceRoot: cwd, threadId, createdAt: "2026-01-02T00:00:00.000Z" });
  send({ id: 7, method: "tools/call", params: { name: "ask_parent", arguments: { question: "Next job?" } } });
  const nextPending = await waitUntil(() => readJobFile(resolveJobFile(cwd, next)).pendingQuestion);
  assert.equal(nextPending.text, "Next job?"); assert.equal(readJobFile(resolveJobFile(cwd, id)).pendingQuestion, null, "the finished job is left alone");
  answerQuestion(cwd, next, nextPending.id, "Yes", "owner-2");
  assert.equal((await reply(7)).result.content[0].text, "Yes");
  bridge.stdin.end();
  await waitUntil(() => !alive(bridge.pid));
});
