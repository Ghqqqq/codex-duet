import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDir, initGitRepo, run } from "./helpers.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { computerUseSetup, ensureComputerUseApproval, grantComputerAppsForThread, normalCodexHome } from "../plugins/codex/scripts/lib/setup-config.mjs";

const script = new URL("../plugins/codex/scripts/codex-companion.mjs", import.meta.url).pathname;
const USER_FILE = '# user\'s Codex app\n[apps]\nallowed = ["com.google.Chrome", "com.apple.finder", "not a bundle id"]\ndenied = ["com.evil.App"]\n';

// Every fixture owns a temporary user home (the "Codex app" side, read-only)
// and a temporary isolated home (the Duet side), both under the test root.
function fixture(behavior = "review-ok") {
  const dir = makeTempDir(); installFakeCodex(dir, behavior);
  const repo = path.join(dir, "repo"); fs.mkdirSync(repo); initGitRepo(repo);
  const env = { ...buildEnv(dir), CODEX_COMPANION_HOME: path.join(dir, "isolated"), CLAUDE_PLUGIN_DATA: path.join(dir, "data") };
  const userDir = path.join(env.CODEX_HOME, "computer-use");
  fs.mkdirSync(path.join(userDir, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(userDir, "config.toml"), USER_FILE);
  fs.writeFileSync(path.join(userDir, "sessions", "0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee.toml"), '[apps]\nallowed = ["com.apple.Notes"]\n');
  const digest = () => Object.fromEntries(fs.readdirSync(env.CODEX_HOME, { recursive: true }).sort().map(name => {
    const file = path.join(env.CODEX_HOME, name);
    return [name, fs.statSync(file).isFile() ? crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") : "dir"];
  }));
  const isolatedFile = path.join(env.CODEX_COMPANION_HOME, "computer-use", "config.toml");
  const call = (...args) => run(process.execPath, [script, ...args], { cwd: repo, env });
  const json = result => { assert.equal(result.status, 0, result.stderr + result.stdout); return JSON.parse(result.stdout); };
  const state = () => JSON.parse(fs.readFileSync(path.join(dir, "fake-codex-state.json"), "utf8"));
  return { dir, repo, env, userDir, isolatedFile, call, json, state, digest, userHash: digest() };
}
const allowedIn = file => fs.existsSync(file) ? JSON.parse(/"allowed" = (\[.*\])/.exec(fs.readFileSync(file, "utf8"))?.[1] ?? "[]") : null;

test("mirror copies only the user's always-allowed apps, idempotently and without touching ~/.codex", () => {
  const f = fixture();
  assert.equal(normalCodexHome(f.env), f.env.CODEX_HOME);
  const first = computerUseSetup({ env: f.env });
  assert.equal(first.preference, "mirror");
  assert.deepEqual(first.allowed, [{ app: "com.google.Chrome", source: "mirrored" }, { app: "com.apple.finder", source: "mirrored" }]);
  assert.deepEqual(first.codexApp.allowed, ["com.google.Chrome", "com.apple.finder"], "the malformed entry is skipped, not copied");
  assert.deepEqual(first.changedFiles, [f.isolatedFile, path.join(f.env.CODEX_COMPANION_HOME, "duet", "config.toml")]);
  assert.deepEqual(allowedIn(f.isolatedFile), ["com.google.Chrome", "com.apple.finder"]);
  const isolated = fs.readFileSync(f.isolatedFile, "utf8");
  assert.doesNotMatch(isolated, /denied|com\.evil|com\.apple\.Notes/, "denied and session-level apps never cross over");
  assert.equal(fs.statSync(f.isolatedFile).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.join(f.env.CODEX_COMPANION_HOME, "computer-use")), ["config.toml"], "no sessions are invented");
  assert.deepEqual(computerUseSetup({ env: f.env }).changedFiles, [], "a second pass is a no-op");
  assert.deepEqual(ensureComputerUseApproval({ env: f.env }), { computerUseApproval: "mirror", allowed: ["com.google.Chrome", "com.apple.finder"], changedFiles: [], backups: [] });
  assert.deepEqual(f.digest(), f.userHash, "every file under the user's Codex home is byte-identical");
  // The source changes: a newly always-allowed app follows; a withdrawn one disappears.
  fs.writeFileSync(path.join(f.userDir, "config.toml"), '[apps]\nallowed = ["com.apple.finder", "com.apple.Terminal"]\n');
  assert.deepEqual(computerUseSetup({ env: f.env }).allowed.map(a => a.app), ["com.apple.finder", "com.apple.Terminal"]);
  // A hand-written isolated entry survives mirroring.
  fs.writeFileSync(f.isolatedFile, '["apps"]\n"allowed" = ["com.apple.finder","com.apple.Terminal","com.local.Hand"]\n');
  assert.deepEqual(computerUseSetup({ env: f.env }).allowed.map(a => [a.app, a.source]), [["com.local.Hand", "explicit"], ["com.apple.finder", "mirrored"], ["com.apple.Terminal", "mirrored"]]);
});

test("ask stops mirroring and removes mirrored apps; allow/revoke/list/dry-run behave through the CLI", () => {
  const f = fixture();
  const setup = (...args) => f.json(f.call("setup", ...args, "--json")).computerUse;
  const listed = setup("--list-computer-apps");
  assert.equal(listed.dryRun, true, "listing is read-only");
  assert.equal(fs.existsSync(f.env.CODEX_COMPANION_HOME), false, "listing creates nothing");
  assert.deepEqual(listed.allowed.map(a => a.app), ["com.google.Chrome", "com.apple.finder"], "the list previews what mirror would apply");
  const dry = setup("--allow-computer-app", "com.apple.Terminal", "--dry-run");
  assert.equal(dry.dryRun, true);
  assert.deepEqual(dry.changedFiles.map(file => path.basename(path.dirname(file))), ["computer-use", "duet"]);
  assert.equal(fs.existsSync(f.env.CODEX_COMPANION_HOME), false, "dry run writes nothing");
  const allowed = setup("--allow-computer-app", "com.apple.Terminal");
  assert.deepEqual(allowed.allowed, [{ app: "com.google.Chrome", source: "mirrored" }, { app: "com.apple.finder", source: "mirrored" }, { app: "com.apple.Terminal", source: "explicit" }]);
  assert.deepEqual(allowedIn(f.isolatedFile), ["com.google.Chrome", "com.apple.finder", "com.apple.Terminal"]);
  const revoked = setup("--revoke-computer-app", "com.apple.finder");
  assert.deepEqual(revoked.revoked, ["com.apple.finder"]);
  assert.deepEqual(allowedIn(f.isolatedFile).sort(), ["com.apple.Terminal", "com.google.Chrome"]);
  assert.deepEqual(setup("--list-computer-apps").allowed.map(a => a.app).sort(), ["com.apple.Terminal", "com.google.Chrome"], "a revoked app stays out on later mirrors");
  assert.deepEqual(setup("--allow-computer-app", "com.apple.finder").revoked, [], "allowing again clears the revocation");
  const ask = setup("--computer-use-approval", "ask");
  assert.equal(ask.preference, "ask");
  assert.deepEqual(ask.allowed, [{ app: "com.apple.Terminal", source: "explicit" }, { app: "com.apple.finder", source: "explicit" }], "mirrored entries leave; explicit ones stay");
  assert.deepEqual(allowedIn(f.isolatedFile), ["com.apple.Terminal", "com.apple.finder"]);
  assert.equal(f.json(f.call("setup", "--json")).computerUse.preference, "ask", "setup's summary reports the preference without changing anything");
  fs.writeFileSync(path.join(f.userDir, "config.toml"), '[apps]\nallowed = ["com.google.Chrome", "com.new.App"]\n'); // the user changes their Codex app
  const userHash = f.digest();
  assert.deepEqual(setup("--list-computer-apps").allowed.map(a => a.app), ["com.apple.Terminal", "com.apple.finder"], "ask never syncs");
  assert.deepEqual(setup("--computer-use-approval", "mirror").allowed.map(a => a.app), ["com.apple.Terminal", "com.apple.finder", "com.google.Chrome", "com.new.App"]);
  assert.match(fs.readFileSync(path.join(f.env.CODEX_COMPANION_HOME, "duet", "config.toml"), "utf8"), /computer_use_approval" = "mirror"/);
  const preference = fs.readFileSync(path.join(f.env.CODEX_COMPANION_HOME, "duet", "config.toml"), "utf8");
  assert.match(preference, /computer_use_mirrored_apps/);
  // Validation happens before any write; the input is not echoed back.
  for (const args of [["--allow-computer-app", "Google Chrome"], ["--revoke-computer-app", "DO_NOT_LOG_FIXTURE"], ["--allow-computer-app", "com.a.B", "--revoke-computer-app", "com.a.B"], ["--computer-use-approval", "never"], ["--computer-use-approval", "ask", "--browser-approval", "ask"], ["--allow-computer-app", "com.a.B", "--default-sandbox", "read-only"], ["--allow-computer-app", "com.a.B", "--sync-tools"]]) {
    const result = f.call("setup", ...args, "--json");
    assert.notEqual(result.status, 0, args.join(" "));
    assert.doesNotMatch(result.stderr, /DO_NOT_LOG_FIXTURE|Google Chrome/);
  }
  assert.equal(fs.readFileSync(path.join(f.env.CODEX_COMPANION_HOME, "duet", "config.toml"), "utf8"), preference, "a rejected command changed nothing");
  assert.deepEqual(f.digest(), userHash, "~/.codex is never written");
  const backups = fs.readdirSync(path.join(f.env.CODEX_COMPANION_HOME, "computer-use")).filter(name => name.includes(".backup-"));
  assert.ok(backups.length >= 3, "each rewrite keeps a private backup");
  assert.ok(backups.every(name => (fs.statSync(path.join(f.env.CODEX_COMPANION_HOME, "computer-use", name)).mode & 0o777) === 0o600));
});

test("mirror runs before every task; a per-call --approve-computer-app grant exists only during the turn", () => {
  const f = fixture();
  const first = f.json(f.call("task", "--json", "--report", "investigate"));
  assert.equal(first.status, "completed");
  assert.deepEqual(allowedIn(f.isolatedFile), ["com.google.Chrome", "com.apple.finder"], "the task mirrored the user's always-allowed apps first");
  assert.equal(f.state().lastTurnStart.computerUse.session, null, "no per-thread file without the flag");
  assert.equal(first.approvedComputerApps, undefined);
  const granted = f.json(f.call("task", "--json", "--report", "--approve-computer-app", "com.apple.Notes", "--approve-computer-app", " com.apple.Notes ", "--approve-computer-app", "org.mozilla.firefox", "investigate"));
  assert.deepEqual(granted.approvedComputerApps, ["com.apple.Notes", "org.mozilla.firefox"]);
  const seen = f.state().lastTurnStart.computerUse;
  assert.match(seen.session, /"allowed" = \["com\.apple\.Notes","org\.mozilla\.firefox"\]/, "node_repl would see a session-scoped approval for exactly this thread");
  assert.match(seen.global, /com\.google\.Chrome/);
  assert.doesNotMatch(seen.global, /com\.apple\.Notes/, "per-call apps do not enter the persistent file");
  const sessions = path.join(f.env.CODEX_COMPANION_HOME, "computer-use", "sessions");
  assert.deepEqual(fs.existsSync(sessions) ? fs.readdirSync(sessions) : [], [], "the grant is withdrawn when the turn ends");
  const status = f.json(f.call("status", granted.jobId, "--json"));
  assert.deepEqual(status.job.approvedComputerApps, ["com.apple.Notes", "org.mozilla.firefox"]);

  assert.deepEqual(f.json(f.call("result", granted.jobId, "--details")).approvedComputerApps, ["com.apple.Notes", "org.mozilla.firefox"]);
  // --continue inherits recorded request grants and rejects additional flags.
  // Named/thread inheritance (excluding runtime-only grants) is in task-sandbox.
  const rejected = f.call("task", "--continue", granted.jobId, "--approve-computer-app", "com.apple.Notes", "again");
  assert.notEqual(rejected.status, 0);
  const continued = f.json(f.call("task", "--json", "--continue", granted.jobId, "again"));
  assert.deepEqual(continued.approvedComputerApps, ["com.apple.Notes", "org.mozilla.firefox"]);
  assert.match(f.state().lastTurnStart.computerUse.session, /com\.apple\.Notes/);
  const bad = f.call("task", "--approve-computer-app", "Google Chrome", "investigate");
  assert.notEqual(bad.status, 0); assert.match(bad.stderr, /bundle identifier/); assert.doesNotMatch(bad.stderr, /Google Chrome/);
  assert.deepEqual(f.digest(), f.userHash);
  // The grant helper restores a pre-existing session file instead of deleting it.
  const file = path.join(sessions, "thr_keep.toml"); fs.mkdirSync(sessions, { recursive: true }); fs.writeFileSync(file, '[apps]\nallowed = ["com.pre.Existing"]\n');
  const release = grantComputerAppsForThread("thr_keep", ["com.apple.Notes"], f.env);
  assert.deepEqual(allowedIn(file), ["com.pre.Existing", "com.apple.Notes"]);
  release();
  assert.equal(fs.readFileSync(file, "utf8"), '[apps]\nallowed = ["com.pre.Existing"]\n');
  assert.throws(() => grantComputerAppsForThread("../escape", ["com.apple.Notes"], f.env), /thread id/);
});

test("a Computer Use elicitation is accepted only with the per-call flag; otherwise the task is blocked, not completed", () => {
  const f = fixture("computer-use-requests");
  const denied = f.call("task", "--json", "--report", "capture chrome");
  assert.equal(denied.status, 2, denied.stderr);
  const report = JSON.parse(denied.stdout);
  assert.equal(report.status, "blocked");
  assert.deepEqual(report.blockers.map(b => [b.code, b.app]), [["computer_use_app_not_approved", "com.google.Chrome"]]);
  assert.deepEqual(f.state().serverRequestReplies.at(-1).result, { action: "cancel" });
  assert.equal(f.json(f.call("status", report.jobId, "--json")).job.status, "blocked");
  assert.equal(f.call("result", report.jobId, "--report", "--json").status, 2);
  const log = fs.readFileSync(f.json(f.call("status", report.jobId, "--json")).job.logFile, "utf8");
  assert.match(log, /"kind":"computer-use-app".*"reason":"no-flag"/);
  assert.doesNotMatch(log + denied.stderr, /DO_NOT_LOG_FIXTURE|tool_params_display/);
  const other = f.call("task", "--json", "--report", "--approve-computer-app", "com.apple.finder", "capture chrome");
  assert.equal(other.status, 2);
  assert.match(JSON.parse(other.stdout).blockers[0].message, /app-mismatch/);
  const approved = f.json(f.call("task", "--json", "--report", "--approve-computer-app", "com.google.Chrome", "capture chrome"));
  assert.equal(approved.status, "completed");
  assert.deepEqual(approved.blockers, []);
  assert.deepEqual(f.state().serverRequestReplies.at(-1).result, { action: "accept" });
  assert.match(f.state().lastTurnStart.computerUse.session, /com\.google\.Chrome/);
  assert.deepEqual(f.digest(), f.userHash);
});

const GRANULAR = { granular: { mcp_elicitations: true, rules: false, sandbox_approval: false, request_permissions: false, skill_approval: false } };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitUntil(fn) { for (const end = Date.now() + 12000; Date.now() < end;) { const result = fn(); if (result) return result; await delay(80); } throw new Error("Fixture deadline expired"); }

test("an owned job forwards an unapproved Computer Use request to the parent; the answer scopes the grant", async () => {
  const f = fixture("computer-use-requests");
  f.json(f.call("setup", "--computer-use-approval", "ask", "--json"));
  const sessionFile = threadId => path.join(f.env.CODEX_COMPANION_HOME, "computer-use", "sessions", `${threadId}.toml`);
  const answer = (launch, id, text) => run(process.execPath, [script, "answer", launch.jobId, "--owner", launch.ownerId, "--question", id, "--json"], { cwd: f.repo, env: f.env, input: text });
  const ask = async (text) => {
    const launch = f.json(f.call("task", "--detached", "--json", "--report", "capture chrome"));
    const pending = f.json(f.call("wait", launch.jobId, "--owner", launch.ownerId, "--json", "--report"));
    assert.equal(pending.status, "needs_answer");
    assert.equal(pending.question.kind, "approval");
    assert.match(pending.question.id, /^approval-/);

    assert.deepEqual(pending.question.options, ["Allow this call", "Allow for this task", "Allow always (isolated Codex home)", "Deny"]);

    assert.equal(f.json(answer(launch, pending.question.id, text)).status, "answer_submitted");
    const finished = f.call("wait", launch.jobId, "--owner", launch.ownerId, "--json", "--report");
    assert.ok([0, 2].includes(finished.status), finished.stderr + finished.stdout);
    const done = JSON.parse(finished.stdout);
    const log = fs.readFileSync(f.json(f.call("status", launch.jobId, "--json")).job.logFile, "utf8");
    assert.doesNotMatch(log, /DO_NOT_LOG_FIXTURE|tool_params_display/);
    return { done, log, reply: f.state().serverRequestReplies.at(-1), threadId: done.threadId };
  };
  // The thread and the turn both carry the granular policy that lets Codex forward MCP elicitations.
  const denied = await ask("Deny");
  assert.deepEqual(f.state().lastThreadStart.approvalPolicy, GRANULAR);
  assert.deepEqual(f.state().lastTurnStart.approvalPolicy, GRANULAR);
  assert.equal(denied.done.status, "blocked");
  assert.equal(denied.done.approvalPolicy, "never+elicitations");
  assert.deepEqual(denied.done.blockers.map(b => [b.code, b.app]), [["computer_use_app_not_approved", "com.google.Chrome"]]);
  assert.deepEqual(denied.reply.result, { action: "cancel" });
  assert.match(denied.log, /"decision":"pending","reason":"ask-parent"/);
  assert.match(denied.log, /"decision":"cancelled","reason":"parent-denied"/);
  // One call: accepted without any persisted state.
  const once = await ask("1");
  assert.equal(once.done.status, "completed");
  assert.deepEqual(once.reply.result, { action: "accept" });
  assert.equal(once.reply.computerUse.session, null);
  assert.equal(allowedIn(f.isolatedFile), null, "ask mode and no always-grant: no isolated allow list yet");
  // This task: the thread's session file exists while the turn runs and is withdrawn afterwards.
  const task = await ask("Allow for this task");
  assert.equal(task.done.status, "completed");
  assert.deepEqual(task.reply.result, { action: "accept" });
  assert.match(task.reply.computerUse.session, /com\.google\.Chrome/);
  assert.equal(fs.existsSync(sessionFile(task.threadId)), false);
  assert.match(task.log, /"decision":"approved","reason":"parent-task"/);
  // Always: the isolated home's own allow list; the user's ~/.codex is untouched.
  const always = await ask("always");
  assert.equal(always.done.status, "completed");
  assert.match(always.reply.computerUse.global, /com\.google\.Chrome/);
  assert.deepEqual(allowedIn(f.isolatedFile), ["com.google.Chrome"]);
  assert.deepEqual(f.json(f.call("setup", "--list-computer-apps", "--json")).computerUse.allowed, [{ app: "com.google.Chrome", source: "explicit" }]);
  assert.deepEqual(f.digest(), f.userHash);
  // An unrecognised answer denies; a plain foreground run keeps "never" and fails closed at once.
  const garbage = await ask("maybe later");
  assert.equal(garbage.done.status, "blocked");
  assert.match(garbage.log, /parent-denied/);
  const foreground = f.call("task", "--json", "--report", "capture chrome");
  assert.equal(foreground.status, 2, foreground.stderr);
  assert.equal(JSON.parse(foreground.stdout).approvalPolicy, "never");
  assert.equal(f.state().lastTurnStart.approvalPolicy, "never");
  assert.match(fs.readFileSync(f.json(f.call("status", JSON.parse(foreground.stdout).jobId, "--json")).job.logFile, "utf8"), /"reason":"no-flag"/);
});

test("a refusal surfaced only through the tool result makes the turn blocked with a structured blocker", () => {
  const f = fixture("computer-use-denied");
  const result = f.call("task", "--json", "--report", "capture chrome");
  assert.equal(result.status, 2, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "blocked");
  assert.equal(report.blockers[0].code, "computer_use_app_not_approved");
  assert.equal(report.blockers[0].app, "Google Chrome");
  assert.ok(report.blockers.some(b => b.code === "reported_blocked"), "the final answer's own 'Blocked' is kept as well");
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_FIXTURE/);
  const stored = JSON.parse(fs.readFileSync(report.resultFile, "utf8"));
  assert.equal(stored.blockers[0].code, "computer_use_app_not_approved");
  assert.doesNotMatch(JSON.stringify(stored.blockers), /PRIVATE_FIXTURE_STACK|PRIVATE_FIXTURE_ARGUMENTS/);
  assert.equal(f.json(f.call("status", report.jobId, "--json")).job.status, "blocked");
});
