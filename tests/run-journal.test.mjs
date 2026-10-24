import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { makeTempDir, initGitRepo, run, requireLocalSockets } from "./helpers.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { resolveStateDir, resolveStateRoot } from "../plugins/codex/scripts/lib/state.mjs";
import { linkJournalJob, finishJournalJob, validateRun } from "../plugins/codex/scripts/lib/run-journal.mjs";
import { planRetention, applyRetention, runAutomaticRetention } from "../plugins/codex/scripts/lib/retention.mjs";

const cli = new URL("../plugins/codex/scripts/codex-companion.mjs", import.meta.url).pathname;
const hook = new URL("../plugins/codex/scripts/session-lifecycle-hook.mjs", import.meta.url).pathname;
const journalModule = new URL("../plugins/codex/scripts/lib/run-journal.mjs", import.meta.url).href;
const runtimeModule = new URL("../plugins/codex/scripts/lib/job-runtime.mjs", import.meta.url).href;
const stateModule = new URL("../plugins/codex/scripts/lib/state.mjs", import.meta.url).href;
const SESSION = "journal-session:1";
function fixture() {
  const root = makeTempDir(); installFakeCodex(root);
  const cwd = path.join(root, "workspace"); fs.mkdirSync(cwd);
  const env = { ...buildEnv(root), CODEX_COMPANION_HOME: path.join(root, "isolated"), CLAUDE_PLUGIN_DATA: path.join(root, "data"), CODEX_COMPANION_SESSION_ID: SESSION };
  const state = resolveStateDir(cwd, env), runs = path.join(state, "runs");
  const call = (args, input, extra = {}) => run(process.execPath, [cli, ...args, "--cwd", cwd], { cwd, env: { ...env, ...extra }, input: typeof input === "string" ? input : input === undefined ? undefined : JSON.stringify(input) });
  const journal = (args, input) => call(["journal", ...args, "--json"], input);
  const start = (goal = "Ship a durable journal", criteria = ["Recover after compaction"]) => json(journal(["start"], { goal, criteria })).runId;
  const file = runId => path.join(runs, runId, "journal.jsonl");
  const rows = runId => fs.readFileSync(file(runId), "utf8").trim().split("\n").map(line => JSON.parse(line));
  const stateRoot = resolveStateRoot(env), sessions = path.join(stateRoot, "run-sessions");
  return { root, cwd, env, state, stateRoot, sessions, runs, call, journal, start, file, rows, pointer: path.join(sessions, `${SESSION}.json`) };
}
// Direct calls print /tasks progress first; their payload is the last line starting with "{".
function json(result) {
  assert.equal(result.status, 0, result.stderr + result.stdout);
  try { return JSON.parse(result.stdout); } catch { return JSON.parse(result.stdout.trimEnd().split("\n").filter(line => line.startsWith("{")).at(-1)); }
}
function snapshot(dir) {
  if (!fs.existsSync(dir)) return null;
  return fs.readdirSync(dir).sort().map(name => {
    const file = path.join(dir, name), stat = fs.lstatSync(file);
    return [name, stat.mode & 0o777, stat.isDirectory() ? snapshot(file) : fs.readFileSync(file, "utf8")];
  });
}
const verdict = (jobId, value = "ACCEPT") => ({ jobId, verdict: value, criteria: [{ criterion: "Recover after compaction", evidence: "Observed CLI recovery", result: "met" }], reason: "Checked the stored evidence" });
function linked(f, runId, jobId = "job-fixture") {
  const job = { id: jobId, workspaceRoot: f.cwd, sessionId: SESSION, jobClass: "task", agentName: "Ada", title: "Test task", model: "fixture-model", effort: "high", sandbox: "read-only", status: "completed", threadId: "thread-fixture" };
  const linkedRun = linkJournalJob(job, "Exact brief\n", f.env);
  assert.deepEqual(linkedRun, { runId, runStateDir: f.state });
  return { ...job, ...linkedRun };
}
test("journal validation is read-only and passed close preserves state until verdict and criterion evidence exist", t => {
  const f = fixture(), runId = f.start(), job = linked(f, runId);
  assert.equal(finishJournalJob(job, { status: "completed", summary: "Synthetic retained report" }, f.env), true);
  const before = snapshot(f.stateRoot);
  const result = f.journal(["validate"]);
  assert.equal(result.status, 2, result.stderr);
  const expected = JSON.parse(result.stdout);
  assert.equal(expected.ok, false);
  assert.deepEqual(expected.issues.map(issue => issue.kind), ["no_verdict", "unchecked_criterion"]);
  assert.equal(expected.issues[0].jobId, job.id);
  assert.equal(expected.issues[1].criterion, "Recover after compaction");
  const open = fs.openSync;
  const guard = t.mock.method(fs, "openSync", function(file, flags, ...args) {
    assert.equal(typeof flags === "number" && Boolean(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT)), false, "validation cannot open for writing");
    assert.ok(typeof flags !== "string" || flags === "r", "validation cannot open for writing");
    return open.call(this, file, flags, ...args);
  });
  const noMkdir = t.mock.method(fs, "mkdirSync", () => assert.fail("validation cannot create directories or locks"));
  assert.deepEqual(validateRun(f.cwd, SESSION, runId, f.env), expected);
  guard.mock.restore(); noMkdir.mock.restore();
  const refused = f.journal(["close"], { judgment: "passed", summary: "Premature" });
  assert.equal(refused.status, 2, refused.stderr);
  assert.deepEqual(JSON.parse(refused.stdout), expected);
  assert.deepEqual(snapshot(f.stateRoot), before, "validation and refused close preserve the journal and active pointer");
  json(f.journal(["add", "verdict"], verdict(job.id)));
  assert.deepEqual(json(f.journal(["validate"])), { runId, ok: true, issues: [] });
  assert.deepEqual(json(f.journal(["close"], { judgment: "passed", summary: "Now checked" })).openIssues, []);
  assert.equal(fs.existsSync(f.pointer), false);
});

function age(f, runId) {
  const old = new Date(Date.now() - 45 * 86400000).toISOString();
  fs.writeFileSync(f.file(runId), f.rows(runId).map(row => JSON.stringify({ ...row, recordedAt: old })).join("\n") + "\n");
}
function storeJob(f, job) {
  const stateDir = resolveStateDir(job.workspaceRoot, f.env), file = path.join(stateDir, "jobs", `${job.id}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(job));
  fs.writeFileSync(path.join(stateDir, "state.json"), JSON.stringify({ version: 1, config: {}, jobs: [job] }));
  return file;
}
function observe(f, job, patch) {
  const source = `
    import {recordFinishedJob} from ${JSON.stringify(runtimeModule)};
    import {readJobFile, resolveJobFile, updateJob} from ${JSON.stringify(stateModule)};
    const file = resolveJobFile(${JSON.stringify(job.workspaceRoot)}, ${JSON.stringify(job.id)});
    const job = ${patch === undefined ? "readJobFile(file)" : `updateJob(${JSON.stringify(job.workspaceRoot)}, ${JSON.stringify(job.id)}, () => (${JSON.stringify(patch)}))`};
    recordFinishedJob(job);
    console.log(JSON.stringify(readJobFile(file)));
  `;
  return json(run(process.execPath, ["--input-type=module", "-e", source], { cwd: f.cwd, env: f.env }));
}

test("journal CLI round trip, latest verdict open items and atomic private storage", () => {
  const f = fixture(), runId = f.start(), before = snapshot(f.runs);
  const duplicate = f.journal(["start"], { goal: "Other", criteria: [] });
  assert.equal(duplicate.status, 1); assert.ok(duplicate.stderr.includes(runId)); assert.deepEqual(snapshot(f.runs), before);
  const job = linked(f, runId);
  let view = json(f.journal(["show"]));
  assert.deepEqual(view.openItems, [{ jobId: job.id, reason: "no_verdict" }]);
  json(f.journal(["add", "criteria"], { criteria: ["Private files"] }));
  json(f.journal(["add", "verdict"], verdict(job.id, "REWORK")));
  assert.equal(json(f.journal(["show"])).openItems[0].reason, "REWORK");
  json(f.journal(["add", "verdict"], verdict(job.id, "REASSIGN")));
  assert.equal(json(f.journal(["show"])).openItems[0].reason, "REASSIGN");
  json(f.journal(["add", "verdict"], verdict(job.id, "ACCEPT_WITH_GLUE")));
  json(f.journal(["add", "decision"], { summary: "Use isolated storage", basis: "Keep user checkout clean", risk: "Retention is finite" }));
  view = json(f.journal(["show", "--run", runId]));
  assert.deepEqual(view.criteria, ["Recover after compaction", "Private files"]); assert.deepEqual(view.openItems, []);
  assert.equal(view.decisions[0].risk, "Retention is finite");
  const text = f.call(["journal", "show"]); assert.equal(text.status, 0); assert.doesNotMatch(text.stdout, /Exact brief/);
  for (const file of [f.pointer, f.file(runId), path.join(f.runs, runId, "jobs", `${job.id}.brief.md`)]) assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  for (const dir of [f.runs, f.sessions, path.join(f.runs, runId), path.join(f.runs, runId, "jobs")]) assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  finishJournalJob(job, { status: "completed", summary: "Verified journal recovery" }, f.env);
  json(f.journal(["add", "verdict"], { ...verdict(job.id, "ACCEPT_WITH_GLUE"), criteria: [{ criterion: "Private files", evidence: "Checked file and directory modes above", result: "met" }] }));
  json(f.journal(["close"], { judgment: "passed", summary: "Verified", openRisks: [] }));
  assert.equal(fs.existsSync(f.pointer), false);
  assert.equal(json(f.journal(["show"])).state, "closed", "newest run is the recovery fallback");
  const closed = snapshot(f.runs);
  for (const args of [["close", "--run", runId], ["close"]]) assert.equal(f.journal(args, { judgment: "passed", summary: "Again" }).status, 1);
  assert.deepEqual(snapshot(f.runs), closed);
  assert.equal(f.journal(["add", "decision", "--run", runId], { summary: "Late", basis: "Late" }).status, 1);
  const next = f.start("Second run");
  assert.deepEqual(json(f.journal(["list"])).map(run => [run.runId, run.state]), [[next, "open"], [runId, "closed"]]);
  assert.deepEqual(fs.readdirSync(f.cwd), [], "no files in the user's workspace");
});

test("invalid stdin, enums, types, ids and every journal help leave state untouched", () => {
  const f = fixture();
  for (const input of ["{", "null", "[]", {}, { goal: " ", criteria: [] }, { goal: "ok", criteria: [3] }]) {
    assert.equal(f.journal(["start"], input).status, 1);
    assert.equal(fs.existsSync(f.stateRoot), false);
  }
  for (const action of [["start"]]) for (const flag of ["--help"]) {
    const result = f.call(["journal", ...action, flag, "--bad-flag"], "bad JSON");
    assert.equal(result.status, 0, result.stderr); assert.equal(fs.existsSync(f.stateRoot), false);
  }
  f.start(); const before = snapshot(f.stateRoot);
  const cases = [
    [["add", "unknown"], {}], [["add", "criteria"], {}], [["add", "criteria"], { criteria: [""] }],
    [["add", "verdict"], { ...verdict("job"), verdict: "ALLOW" }], [["add", "verdict"], { ...verdict("job"), reason: "" }],
    [["add", "verdict"], { ...verdict("job"), criteria: [{ criterion: "c", evidence: "e", result: "maybe" }] }],
    [["add", "verdict"], { ...verdict("job"), criteria: [{ criterion: "c", result: "met" }] }],
    [["add", "decision"], { summary: "s" }], [["add", "decision"], { summary: "s", basis: "b", risk: 2 }],
    [["close"], { judgment: "done", summary: "s" }], [["close"], { judgment: "passed", summary: "s", openRisks: [false] }],
    [["add", "criteria", "--run", "../escape"], { criteria: ["c"] }], [["add", "verdict"], verdict("../job")]
  ];
  for (const [args, input] of cases) { assert.equal(f.journal(args, input).status, 1, args.join(" ")); assert.deepEqual(snapshot(f.stateRoot), before); }
});

test("one session links jobs and recovers its run across workspaces; other sessions stay separate", async t => {
  if (!await requireLocalSockets(t)) return;
  const f = fixture(); initGitRepo(f.cwd);
  const other = path.join(f.root, "workspace-b"); fs.mkdirSync(other); initGitRepo(other);
  const otherState = resolveStateDir(other, f.env);
  assert.notEqual(otherState, f.state);
  const call = (args, input, sessionId = SESSION) => run(process.execPath, [cli, ...args, "--cwd", other], { cwd: other, env: { ...f.env, CODEX_COMPANION_SESSION_ID: sessionId }, input: typeof input === "string" ? input : input === undefined ? undefined : JSON.stringify(input) });
  const lifecycle = sessionId => run(process.execPath, [hook, "SessionStart"], { cwd: other, env: { ...f.env, CODEX_COMPANION_BIN: path.join(f.root, "missing-codex") }, input: JSON.stringify({ cwd: other, session_id: sessionId, source: "compact" }) });
  const originalContext = lifecycle(SESSION).stdout;
  const runId = f.start();
  assert.deepEqual(JSON.parse(fs.readFileSync(f.pointer)), { runId, stateDir: f.state });
  const beforeDuplicate = snapshot(f.stateRoot);
  const duplicate = call(["journal", "start"], { goal: "Duplicate from B", criteria: [] });
  assert.equal(duplicate.status, 1); assert.ok(duplicate.stderr.includes(runId)); assert.deepEqual(snapshot(f.stateRoot), beforeDuplicate);
  const context = json(lifecycle(SESSION)).hookSpecificOutput.additionalContext;
  const baseline = JSON.parse(originalContext).hookSpecificOutput.additionalContext;
  assert.ok(context.startsWith(baseline + "\n")); assert.equal(context.split("\n").length, baseline.split("\n").length + 1); assert.ok(context.includes(runId));
  assert.equal(lifecycle("other-session").stdout, originalContext);
  const report = json(call(["task", "--direct", "--sandbox", "read-only"], "Cross-workspace brief."));
  const events = f.rows(runId), starts = events.filter(row => row.type === "job_started"), finishes = events.filter(row => row.type === "job_finished");
  assert.equal(starts.length, 1); assert.equal(finishes.length, 1); assert.equal(starts[0].workspaceRoot, other); assert.equal(starts[0].cwd, other);
  assert.equal(starts[0].jobId, report.jobId); assert.equal(finishes[0].jobId, report.jobId);
  const stored = JSON.parse(fs.readFileSync(path.join(otherState, "jobs", `${report.jobId}.json`)));
  assert.equal(stored.runId, runId); assert.equal(stored.runStateDir, f.state);
  assert.equal(fs.existsSync(path.join(otherState, "runs")), false);
  assert.equal(fs.readFileSync(path.join(f.runs, runId, starts[0].brief), "utf8"), JSON.parse(fs.readFileSync(path.join(f.root, "fake-codex-state.json"))).lastTurnStart.prompt);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.runs, runId, finishes[0].report))).summary, report.summary);
  const view = json(call(["journal", "show", "--json"]));
  assert.equal(view.runId, runId); assert.equal(view.jobs[0].workspaceRoot, other); assert.equal(view.jobs[0].status, "completed");
  json(call(["wait", report.jobId, "--owner", stored.ownerId, "--direct"]));
  json(call(["result", report.jobId, "--report", "--json"]));
  assert.equal(f.rows(runId).filter(row => row.type === "job_finished").length, 1);
  json(call(["journal", "add", "criteria"], { criteria: ["Cross-worktree recovery"] }));
  json(call(["journal", "add", "verdict"], verdict(report.jobId)));
  json(call(["journal", "add", "decision"], { summary: "Use worktrees", basis: "Independent writers" }));
  assert.ok(json(f.journal(["show"])).criteria.includes("Cross-worktree recovery"));
  const beforeOther = snapshot(f.runs);
  const unlinked = json(call(["task", "--direct", "--sandbox", "read-only"], "Different session.", "other-session"));
  assert.equal(JSON.parse(fs.readFileSync(path.join(otherState, "jobs", `${unlinked.jobId}.json`))).runId, undefined);
  assert.deepEqual(snapshot(f.runs), beforeOther);
  assert.deepEqual(json(call(["journal", "list", "--json"])), [], "list remains workspace-scoped");
  json(call(["journal", "add", "verdict"], { ...verdict(report.jobId), criteria: [{ criterion: "Cross-worktree recovery", evidence: "Observed run and worker handles from both workspaces", result: "met" }] }));
  json(call(["journal", "close"], { judgment: "passed", summary: "Cross-workspace acceptance passed" }));
  assert.equal(fs.existsSync(f.pointer), false); assert.equal(json(f.journal(["show"])).state, "closed");
  assert.equal(lifecycle(SESSION).stdout, originalContext);
  const competing = await Promise.all([f.cwd, other].map(cwd => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "journal", "start", "--cwd", cwd], { cwd, env: f.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject); child.on("close", status => resolve({ status, stdout, stderr }));
    child.stdin.end(JSON.stringify({ goal: "Concurrent session start", criteria: [] }));
  })));
  assert.equal(competing.filter(result => result.status === 0).length, 1);
  const winner = json(competing.find(result => result.status === 0));
  assert.ok(competing.find(result => result.status !== 0).stderr.includes(winner.runId));
  assert.equal(json(call(["journal", "show", "--json"])).runId, winner.runId);
  json(call(["journal", "close"], { judgment: "passed", summary: "Only one active run" }));
});

test("direct tasks link exact worker brief and one terminal compact report; unlinked tasks do not journal", async t => {
  if (!await requireLocalSockets(t)) return;
  const f = fixture(), runId = f.start();
  const report = json(f.call(["task", "--fresh", "--direct", "--sandbox", "read-only"], "  Check journal linking.\n"));
  assert.equal(report.status, "completed");
  const events = f.rows(runId), started = events.filter(row => row.type === "job_started"), finished = events.filter(row => row.type === "job_finished");
  assert.equal(started.length, 1); assert.equal(finished.length, 1); assert.equal(started[0].jobId, report.jobId);
  const stored = JSON.parse(fs.readFileSync(path.join(f.state, "jobs", `${report.jobId}.json`)));
  assert.equal(stored.runId, runId); assert.equal(started[0].agentName, report.worker);
  const server = JSON.parse(fs.readFileSync(path.join(f.root, "fake-codex-state.json")));
  assert.equal(fs.readFileSync(path.join(f.runs, runId, started[0].brief), "utf8"), server.lastTurnStart.prompt);
  const saved = JSON.parse(fs.readFileSync(path.join(f.runs, runId, finished[0].report)));
  assert.equal(saved.status, report.status); assert.equal(saved.summary, report.summary); assert.equal(saved.threadId, stored.threadId);
  assert.equal(fs.statSync(path.join(f.runs, runId, finished[0].report)).mode & 0o777, 0o600);
  json(f.call(["wait", report.jobId, "--owner", stored.ownerId, "--direct"]));
  json(f.call(["result", report.jobId, "--report", "--json"]));
  assert.equal(f.rows(runId).filter(row => row.type === "job_finished").length, 1);
  assert.equal(json(f.journal(["show"])).jobs[0].threadId, stored.threadId);
  const followUp = json(f.call(["task", "--thread", stored.threadId, "--json", "--sandbox", "read-only"], "  Plain foreground follow up.\n"));
  const followStart = f.rows(runId).find(row => row.type === "job_started" && row.jobId === followUp.jobId);
  assert.equal(followStart.followUpOf, report.jobId); assert.equal(followStart.threadId, stored.threadId);
  assert.equal(fs.readFileSync(path.join(f.runs, runId, followStart.brief), "utf8"), "Plain foreground follow up.");
  const continuation = json(f.call(["task", "--continue", report.jobId, "--direct"], "Continue the recorded task."));
  assert.equal(f.rows(runId).find(row => row.type === "job_started" && row.jobId === continuation.jobId).continuationOf, report.jobId);
  assert.equal(f.rows(runId).filter(row => row.type === "job_finished").length, 3);
  const resumed = json(f.call(["task", "--resume-last", "--json", "--sandbox", "read-only"]));
  const resumeStart = f.rows(runId).find(row => row.type === "job_started" && row.jobId === resumed.jobId);
  assert.equal(fs.readFileSync(path.join(f.runs, runId, resumeStart.brief), "utf8"), JSON.parse(fs.readFileSync(path.join(f.root, "fake-codex-state.json"))).lastTurnStart.prompt);
  for (const jobId of [report.jobId, followUp.jobId, continuation.jobId, resumed.jobId]) json(f.journal(["add", "verdict"], verdict(jobId)));
  json(f.journal(["close"], { judgment: "passed", summary: "Done" }));
  const before = snapshot(f.runs);
  const unlinked = json(f.call(["task", "--fresh", "--direct", "--sandbox", "read-only"], "Check without a run."));
  assert.equal(unlinked.status, "completed"); assert.deepEqual(snapshot(f.runs), before);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.state, "jobs", `${unlinked.jobId}.json`))).runId, undefined);
});

test("concurrent terminal observers serialize exactly one finish, including after close", async () => {
  const f = fixture(), runId = f.start(), job = linked(f, runId);
  json(f.journal(["close"], { judgment: "blocked", summary: "Owner stopped", openRisks: ["Worker still finishing"] }));
  const source = `import {finishJournalJob} from ${JSON.stringify(journalModule)}; finishJournalJob(${JSON.stringify(job)}, {status:'completed',summary:'Final compact report'});`;
  await Promise.all(Array.from({ length: 6 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], { cwd: f.cwd, env: f.env, stdio: ["ignore", "ignore", "pipe"] });
    let error = ""; child.stderr.on("data", chunk => { error += chunk; }); child.on("error", reject);
    child.on("close", code => code === 0 ? resolve() : reject(new Error(error)));
  })));
  assert.equal(f.rows(runId).filter(row => row.type === "job_finished").length, 1);
  assert.equal(json(f.journal(["show"])).jobs[0].status, "completed");
});

test("a recovered terminal status keeps both reports and show uses the latest finish", () => {
  const f = fixture(), runId = f.start();
  const job = { ...linked(f, runId), status: "failed", result: { status: 1 }, report: { status: "failed", summary: "Wrapper failed before recovery" } };
  storeJob(f, job);
  assert.equal(observe(f, job).journalFinishedStatus, "failed");
  const failedPath = path.join(f.runs, runId, "jobs", `${job.id}.report.json`), failedReport = fs.readFileSync(failedPath, "utf8");
  const recovered = observe(f, job, { status: "completed", result: { status: 0 }, report: { status: "completed", summary: "Recovered exact-turn success" } });
  assert.equal(recovered.journalFinishedStatus, "completed");
  observe(f, job);
  json(f.call(["status", job.id, "--json"]));
  json(f.call(["result", job.id, "--report", "--json"]));
  const finishes = f.rows(runId).filter(row => row.type === "job_finished");
  assert.deepEqual(finishes.map(row => row.status), ["failed", "completed"]);
  assert.deepEqual(finishes.map(row => row.report), [`jobs/${job.id}.report.json`, `jobs/${job.id}.completed.report.json`]);
  assert.equal(fs.readFileSync(failedPath, "utf8"), failedReport);
  assert.equal(JSON.parse(failedReport).summary, job.report.summary);
  const completedPath = path.join(f.runs, runId, finishes[1].report);
  assert.equal(JSON.parse(fs.readFileSync(completedPath)).summary, recovered.report.summary);
  assert.equal(fs.statSync(completedPath).mode & 0o777, 0o600);
  const before = snapshot(path.join(f.runs, runId));
  assert.equal(finishJournalJob(job, { status: "failed", summary: "Duplicate failure" }, f.env), true);
  assert.equal(finishJournalJob(recovered, { status: "completed", summary: "Duplicate success" }, f.env), true);
  assert.deepEqual(snapshot(path.join(f.runs, runId)), before, "earlier statuses and duplicate reports stay immutable");
  const view = json(f.journal(["show", "--run", runId]));
  assert.equal(view.jobs[0].status, "completed");
  assert.equal(view.jobs[0].report, finishes[1].report);
});

test("persisted terminal observations skip journal locks and reads on status and result", () => {
  const f = fixture(), runId = f.start(), other = path.join(f.root, "other-workspace");
  fs.mkdirSync(other);
  const job = { ...linked({ ...f, cwd: other }, runId), result: { status: 0 }, report: { status: "completed", summary: "Already journaled" } };
  const file = storeJob(f, job);
  assert.equal(observe(f, job).journalFinishedStatus, "completed");
  assert.equal(JSON.parse(fs.readFileSync(file)).journalFinishedStatus, "completed");
  const before = fs.statSync(f.file(runId), { bigint: true });
  const accesses = path.join(f.root, "journal-accesses"), preload = path.join(f.root, "trace-journal.mjs");
  fs.writeFileSync(preload, `
    import fs from 'node:fs';
    import path from 'node:path';
    const open = fs.openSync, mkdir = fs.mkdirSync;
    fs.openSync = function(file, ...args) {
      if (String(file) === ${JSON.stringify(f.file(runId))}) fs.appendFileSync(${JSON.stringify(accesses)}, 'journal open\\n');
      return open.call(this, file, ...args);
    };
    fs.mkdirSync = function(dir, ...args) {
      if (path.dirname(String(dir)) === ${JSON.stringify(f.state)} && path.basename(String(dir)).startsWith('.owner-')) fs.appendFileSync(${JSON.stringify(accesses)}, 'journal lock\\n');
      return mkdir.call(this, dir, ...args);
    };
  `);
  for (let i = 0; i < 3; i++) for (const args of [["status", job.id, "--json"], ["result", job.id, "--report", "--json"]]) {
    json(run(process.execPath, [cli, ...args, "--cwd", other], { cwd: other, env: { ...f.env, NODE_OPTIONS: `--import=${preload}` } }));
  }
  assert.equal(fs.existsSync(accesses), false, "finished observations must not acquire the run lock or open the journal");
  const after = fs.statSync(f.file(runId), { bigint: true });
  assert.equal(after.mtimeNs, before.mtimeNs);
  assert.equal(after.size, before.size);
  assert.equal(f.rows(runId).filter(row => row.type === "job_finished").length, 1);
});

test("finish returns a boolean and retries a failed append without overwriting its report", t => {
  const f = fixture(), runId = f.start(), job = linked(f, runId);
  for (const patch of [{ runId: null }, { jobClass: "review" }, { status: "queued" }, { status: "running" }, { id: "unlinked" }]) {
    assert.equal(finishJournalJob({ ...job, ...patch }, { status: "completed" }, f.env), false);
  }
  const open = fs.openSync;
  const deny = t.mock.method(fs, "openSync", function(file, flags, ...args) {
    if (file === f.file(runId) && (flags & fs.constants.O_WRONLY)) throw new Error("fixture append denied");
    return open.call(this, file, flags, ...args);
  });
  const report = { status: "completed", summary: "First published report" };
  assert.equal(finishJournalJob(job, report, f.env), false);
  deny.mock.restore();
  assert.equal(f.rows(runId).filter(row => row.type === "job_finished").length, 0);
  const file = path.join(f.runs, runId, "jobs", `${job.id}.report.json`), before = fs.readFileSync(file, "utf8");
  assert.equal(finishJournalJob(job, { status: "completed", summary: "Later observer" }, f.env), true);
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.equal(finishJournalJob(job, report, f.env), true);
  assert.equal(f.rows(runId).filter(row => row.type === "job_finished").length, 1);
});

test("journal write failures never change direct task outcome, and terminal writes can be retried", async t => {
  if (!await requireLocalSockets(t)) return;
  const f = fixture(), runId = f.start();
  const baseline = json(f.call(["task", "--direct", "--sandbox", "read-only"], "Check write failure."));
  const preload = path.join(f.root, "deny-journal.mjs");
  fs.writeFileSync(preload, `import fs from 'node:fs'; const open = fs.openSync; fs.openSync = function(file, flags, ...rest) { if (String(file).endsWith('/journal.jsonl') && typeof flags === 'number' && (flags & fs.constants.O_WRONLY)) throw Object.assign(new Error('fixture journal write denied'), {code:'EACCES'}); return open.call(this,file,flags,...rest); };`);
  const before = snapshot(f.runs);
  const denied = f.call(["task", "--direct", "--sandbox", "read-only"], "Check write failure.", { NODE_OPTIONS: `--import=${preload}` });
  const report = json(denied); assert.equal(report.status, baseline.status); assert.equal(report.summary, baseline.summary); assert.deepEqual(snapshot(f.runs), before);
  fs.writeFileSync(preload, `import fs from 'node:fs'; const write = fs.writeFileSync; fs.writeFileSync = function(file, ...rest) { if (String(file).includes('.report.json.')) throw Object.assign(new Error('fixture report copy denied'), {code:'EACCES'}); return write.call(this,file,...rest); };`);
  const terminalDenied = json(f.call(["task", "--direct", "--sandbox", "read-only"], "Check write failure.", { NODE_OPTIONS: `--import=${preload}` }));
  assert.equal(terminalDenied.status, baseline.status); assert.equal(terminalDenied.summary, baseline.summary);
  assert.equal(f.rows(runId).filter(row => row.type === "job_finished" && row.jobId === terminalDenied.jobId).length, 0);
  json(f.call(["result", terminalDenied.jobId, "--report", "--json"]));
  assert.equal(f.rows(runId).filter(row => row.type === "job_finished" && row.jobId === terminalDenied.jobId).length, 1);
  const job = linked(f, runId, "terminal-retry"), reportPath = path.join(f.runs, runId, "jobs", `${job.id}.report.json`);
  fs.mkdirSync(reportPath);
  assert.doesNotThrow(() => finishJournalJob(job, { status: "completed" }, f.env));
  assert.equal(f.rows(runId).filter(row => row.type === "job_finished" && row.jobId === job.id).length, 0);
  fs.rmdirSync(reportPath); finishJournalJob(job, { status: "completed" }, f.env);
  assert.equal(f.rows(runId).filter(row => row.type === "job_finished" && row.jobId === job.id).length, 1);
});

test("SessionStart adds one recovery line only for the active session, SessionEnd preserves runs", () => {
  const f = fixture();
  const lifecycle = (event, session = SESSION, source = "resume") => run(process.execPath, [hook, event], { cwd: f.cwd, env: { ...f.env, CODEX_COMPANION_BIN: path.join(f.root, "missing-codex") }, input: JSON.stringify({ cwd: f.cwd, session_id: session, source }) });
  const baseline = lifecycle("SessionStart"); assert.equal(baseline.status, 0);
  const runId = f.start("Long goal\n" + "x".repeat(150));
  for (const source of ["resume", "compact"]) {
    const result = lifecycle("SessionStart", SESSION, source), value = json(result), context = value.hookSpecificOutput.additionalContext;
    const original = JSON.parse(baseline.stdout).hookSpecificOutput.additionalContext;
    assert.ok(context.startsWith(original + "\n")); assert.equal(context.split("\n").length, original.split("\n").length + 1);
    assert.ok(context.includes(runId)); assert.ok(context.includes("journal show")); assert.ok(context.length - original.length < 300);
  }
  assert.equal(lifecycle("SessionStart", "another-session").stdout, baseline.stdout);
  assert.equal(lifecycle("SessionEnd").status, 0); assert.equal(fs.existsSync(f.pointer), true);
  json(f.journal(["close"], { judgment: "abandoned", summary: "Stopped" }));
  assert.equal(lifecycle("SessionStart").stdout, baseline.stdout);
});

test("cleanup plans and removes expired open/closed runs and pointers, retaining activity and run copies", async () => {
  const f = fixture(), closed = f.start("Empty completed run", []);
  json(f.journal(["close"], { judgment: "passed", summary: "Old completed run" })); age(f, closed);
  const stale = f.start("Stale open run"); age(f, stale);
  const dry = run(process.execPath, [cli, "cleanup", "--dry-run", "--days", "30", "--json"], { cwd: f.cwd, env: f.env });
  const plan = json(dry); assert.deepEqual(new Set(plan.runs.map(run => run.runId)), new Set([closed, stale])); assert.ok(fs.existsSync(f.pointer));
  const applied = json(run(process.execPath, [cli, "cleanup", "--days", "30", "--json"], { cwd: f.cwd, env: f.env }));
  assert.equal(applied.runsDeleted, 2); assert.equal(fs.existsSync(f.pointer), false); assert.equal(fs.existsSync(f.file(closed)), false);
  const recent = f.start("Recent"), job = linked(f, recent);
  finishJournalJob(job, { status: "completed" }, f.env);
  const old = new Date(Date.now() - 45 * 86400000).toISOString(), record = { ...job, createdAt: old, updatedAt: old, completedAt: old, pid: null, result: { turnEnded: true } };
  fs.mkdirSync(path.join(f.state, "jobs"), { recursive: true });
  fs.writeFileSync(path.join(f.state, "jobs", `${job.id}.json`), JSON.stringify(record));
  fs.writeFileSync(path.join(f.state, "state.json"), JSON.stringify({ version: 1, config: {}, jobs: [record] }));
  const copies = snapshot(path.join(f.runs, recent));
  const result = await applyRetention(planRetention({ env: f.env }));
  assert.equal(result.jobsDeleted, 1); assert.equal(result.runsDeleted, 0); assert.deepEqual(snapshot(path.join(f.runs, recent)), copies);
  age(f, recent); const stalePlan = planRetention({ env: f.env });
  json(f.journal(["add", "decision"], { summary: "Still active", basis: "Fresh work" }));
  assert.equal((await applyRetention(stalePlan)).runsDeleted, 0, "recheck activity under the journal lock");
  age(f, recent);
  assert.equal((await runAutomaticRetention({ cwd: f.cwd, env: f.env, deleteThread: async () => ({}) })).runsDeleted, 1);
  assert.equal(fs.existsSync(f.pointer), false);
  const missing = f.start("Missing run"); fs.rmSync(path.join(f.runs, missing), { recursive: true });
  const missingPlan = planRetention({ env: f.env });
  assert.equal(missingPlan.runSessions[0].reason, "missing_run"); assert.ok(fs.existsSync(f.pointer));
  const replacement = f.start("Replacement run");
  assert.equal((await applyRetention(missingPlan)).runSessionsDeleted, 0, "stale plans cannot erase a replacement session pointer");
  assert.equal(JSON.parse(fs.readFileSync(f.pointer)).runId, replacement);
  fs.rmSync(path.join(f.runs, replacement), { recursive: true });
  const missingApplied = json(run(process.execPath, [cli, "cleanup", "--json"], { cwd: f.cwd, env: f.env }));
  assert.equal(missingApplied.runSessionsDeleted, 1); assert.equal(fs.existsSync(f.pointer), false);
});

test("cleanup protects expired open runs with active linked jobs in planning and stale-plan pruning", async () => {
  for (const scenario of [{ status: "running" }, { status: "queued", crossWorkspace: true }, { status: "running", legacy: true }]) {
    const f = fixture(), runId = f.start();
    const workspaceRoot = scenario.crossWorkspace ? path.join(f.root, "worker-workspace") : f.cwd;
    fs.mkdirSync(workspaceRoot, { recursive: true });
    const job = linked({ ...f, cwd: workspaceRoot }, runId);
    storeJob(f, job);
    if (scenario.legacy) fs.writeFileSync(f.file(runId), f.rows(runId).map(row => {
      if (row.type === "job_started") delete row.workspaceRoot;
      return JSON.stringify(row);
    }).join("\n") + "\n");
    age(f, runId);
    const stalePlan = planRetention({ env: f.env });
    assert.deepEqual(stalePlan.runs.map(run => run.runId), [runId]);
    storeJob(f, { ...job, status: scenario.status });
    const protectedPlan = planRetention({ env: f.env });
    assert.deepEqual(protectedPlan.errors, []);
    assert.deepEqual(protectedPlan.runs, []);
    assert.deepEqual(protectedPlan.runSessions, []);
    const retained = await applyRetention(stalePlan);
    assert.deepEqual(retained.errors, []);
    assert.equal(retained.runsDeleted, 0, "recheck the linked job under the journal lock");
    assert.equal(retained.runSessionsDeleted, 0);
    assert.equal(fs.existsSync(f.file(runId)), true);
    assert.equal(fs.existsSync(f.pointer), true);
    storeJob(f, { ...job, status: "completed" });
    const expired = planRetention({ env: f.env });
    assert.deepEqual(expired.runs.map(run => run.runId), [runId]);
    const removed = await applyRetention(expired);
    assert.deepEqual(removed.errors, []);
    assert.equal(removed.runsDeleted, 1);
    assert.equal(removed.runSessionsDeleted, 1);
    assert.equal(fs.existsSync(f.file(runId)), false);
    assert.equal(fs.existsSync(f.pointer), false);
  }
});

test("closed runs, finished links and missing or unreadable job records still expire", async () => {
  for (const scenario of ["closed", "finished", "missing", "unreadable"]) {
    const f = fixture(), runId = f.start(), job = linked(f, runId);
    if (scenario !== "missing") {
      const file = storeJob(f, { ...job, status: "running" });
      if (scenario === "unreadable") fs.writeFileSync(file, "not JSON");
    }
    if (scenario === "closed") json(f.journal(["close"], { judgment: "abandoned", summary: "Closed with a live worker" }));
    if (scenario === "finished") assert.equal(finishJournalJob(job, { status: "completed" }, f.env), true);
    age(f, runId);
    const plan = planRetention({ env: f.env });
    assert.deepEqual(plan.runs.map(run => run.runId), [runId], scenario);
    assert.equal((await applyRetention(plan)).runsDeleted, 1, scenario);
    assert.equal(fs.existsSync(f.file(runId)), false);
  }
});

test("journal refuses symlinked run directories and files without touching their targets", () => {
  const f = fixture(), outside = path.join(f.root, "outside"); fs.mkdirSync(outside);
  fs.mkdirSync(f.state, { recursive: true }); fs.symlinkSync(outside, f.runs);
  assert.equal(f.journal(["start"], { goal: "Unsafe", criteria: [] }).status, 1);
  assert.deepEqual(fs.readdirSync(outside), []);
  fs.unlinkSync(f.runs); const runId = f.start(), target = path.join(outside, "keep");
  fs.writeFileSync(target, "keep"); fs.unlinkSync(f.file(runId)); fs.symlinkSync(target, f.file(runId));
  assert.equal(f.journal(["add", "criteria"], { criteria: ["Unsafe"] }).status, 1);
  assert.equal(fs.readFileSync(target, "utf8"), "keep");
  const g = fixture(); fs.mkdirSync(g.stateRoot, { recursive: true }); fs.symlinkSync(outside, g.sessions);
  assert.equal(g.journal(["start"], { goal: "Unsafe session pointer", criteria: [] }).status, 1);
  assert.deepEqual(fs.readdirSync(outside), ["keep"]);
  fs.unlinkSync(g.sessions); const safeRun = g.start();
  const saved = fs.readFileSync(g.pointer, "utf8");
  fs.writeFileSync(g.pointer, JSON.stringify({ runId: safeRun, stateDir: outside }));
  assert.equal(g.journal(["show"]).status, 1); assert.equal(fs.readFileSync(target, "utf8"), "keep");
  fs.writeFileSync(g.pointer, saved); fs.unlinkSync(g.pointer); fs.symlinkSync(target, g.pointer);
  assert.equal(g.journal(["show"]).status, 1); assert.equal(fs.readFileSync(target, "utf8"), "keep");
});
