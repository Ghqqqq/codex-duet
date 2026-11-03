import test from "node:test";
import assert from "node:assert/strict";
import { lifecycleHarness } from "./fake-codex-fixture.mjs";
import { advanceBudget, newJobBudget } from "../plugins/codex/scripts/lib/job-budget.mjs";
import { unresolvedTask } from "../plugins/codex/scripts/lib/state.mjs";
import { approveDuet } from "../plugins/codex/scripts/duet-permission-hook.mjs";
import { startRun } from "../plugins/codex/scripts/lib/run-journal.mjs";
import { isC2Report } from "../plugins/codex/scripts/lib/report-delivery.mjs";
import { JobRuntime, directReport, fullReport } from "../plugins/codex/scripts/lib/job-runtime.mjs";
import { writeJobFile, resolveJobFile, updateJob } from "../plugins/codex/scripts/lib/state.mjs";

const { fs, path, fixture, json, direct, readJobFile, resolveStateDir, patchJob, waitUntil } = await lifecycleHarness();
const job = (f, id) => readJobFile(path.join(resolveStateDir(f.repo, f.env), "jobs", `${id}.json`));

test("a durable budget exceedance survives cancellation persistence failure and respects a competing stop", t => {
  t.mock.method(globalThis, "setInterval", () => null);
  const cwd = path.join(process.env.CODEX_COMPANION_TEST_ROOT, "budget-cancel");
  fs.mkdirSync(cwd, { recursive: true });
  const id = "budget-cancel", file = resolveJobFile(cwd, id);
  writeJobFile(cwd, id, { id, status: "running", turnId: "turn-budget", budget: newJobBudget(1) });
  const runtime = new JobRuntime(cwd, id);
  const rename = fs.renameSync;
  let failed = false;
  t.mock.method(fs, "renameSync", function(source, target) {
    if (target === file && JSON.parse(fs.readFileSync(source)).cancelRequested) {
      failed = true;
      throw Object.assign(new Error("Injected cancellation write failure"), { code: "EIO" });
    }
    return rename.call(this, source, target);
  });
  try {
    updateJob(cwd, id, current => ({ budget: { ...current.budget, consumedMs: 60000 } }));
    runtime.checkBudget();
    assert.equal(failed, true);
    assert.equal(readJobFile(file).budget.exceeded, "max_minutes");
    assert.equal(runtime.reason, "budget_exceeded:max_minutes");
    assert.equal(runtime.abort.signal.reason, runtime.reason);
  } finally { runtime.close(); }
  writeJobFile(cwd, "competing-stop", { id: "competing-stop", status: "running", turnId: "turn-competing", budget: newJobBudget(1) });
  const competing = new JobRuntime(cwd, "competing-stop");
  try {
    updateJob(cwd, "competing-stop", current => ({ budget: { ...current.budget, exceeded: "max_minutes" }, cancelRequested: { reason: "cancelled_by_user" } }));
    competing.stop("budget_exceeded:max_minutes", { expect: current => !current.cancelRequested });
    assert.equal(competing.reason, "cancelled_by_user");
  } finally { competing.close(); }
});

test("every watchdog tick evaluates running time without repeated writes and close preserves completed status", t => {
  let now = 100000, tick;
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "setInterval", callback => { tick = callback; return null; });
  const cwd = path.join(process.env.CODEX_COMPANION_TEST_ROOT, "budget-ticks");
  fs.mkdirSync(cwd, { recursive: true });
  const id = "budget-ticks", file = resolveJobFile(cwd, id);
  writeJobFile(cwd, id, { id, jobClass: "task", status: "running", turnId: "turn-ticks", budget: { ...newJobBudget(0.01), runningSince: now } });
  const runtime = new JobRuntime(cwd, id);
  const before = fs.readFileSync(file, "utf8");
  try {
    now += 250; tick();
    assert.equal(runtime.reason, null);
    assert.equal(fs.readFileSync(file, "utf8"), before, "an ordinary tick evaluates in memory");
    now += 500; tick();
    assert.equal(runtime.reason, "budget_exceeded:max_minutes", "a sub-two-second budget stops on the next tick");
    assert.equal(readJobFile(file).budget.consumedMs, 750);
  } finally { runtime.close(); }
  const finishedId = "budget-finished", finishedFile = resolveJobFile(cwd, finishedId);
  writeJobFile(cwd, finishedId, { id: finishedId, jobClass: "task", status: "running", turnId: "turn-finished", budget: { ...newJobBudget(0.01), runningSince: now } });
  const finished = new JobRuntime(cwd, finishedId);
  now += 750;
  finished.close();
  const record = readJobFile(finishedFile);
  assert.equal(record.budget.exceeded, "max_minutes");
  assert.equal(record.budget.consumedMs, 750);
  assert.equal(record.cancelRequested, undefined);
  assert.equal(finished.reason, null);
  const report = { status: "completed", summary: "Finished the turn." };
  assert.match(fullReport(report, record).budgetNote, /completed.*max_minutes/i);
  const compact = directReport(report, record);
  assert.equal(compact.status, "completed");
  assert.match(compact.summary, /completed.*max_minutes/i);
  assert.equal(compact.blockers, undefined);
});

test("running-time budgets exclude queueing and parent questions and interrupt a long turn without stranding its thread", async () => {
  let current = { status: "queued", budget: newJobBudget(1) };
  current.budget = advanceBudget(current, 1000);
  assert.equal(current.budget.consumedMs, 0);
  current = { ...current, status: "running", turnId: "turn-fixture" };
  current.budget = advanceBudget(current, 2000);
  current.budget = advanceBudget(current, 2500, { running: false });
  current.pendingQuestion = { id: "question-fixture" };
  current.budget = advanceBudget(current, 90000);
  assert.equal(current.budget.consumedMs, 500);
  current.budget = advanceBudget(current, 91000, { running: true });
  current.pendingQuestion = null;
  current.budget = advanceBudget(current, 92000);
  assert.equal(current.budget.consumedMs, 1500);

  const f = fixture("writer-lock");
  startRun(f.repo, f.env.CODEX_COMPANION_SESSION_ID, { goal: "Stop within the running-time budget", criteria: ["Confirm the interrupted turn ended"] }, f.env);
  const launch = json(f.call("task", "--detached", "--max-minutes", "1", "--json", "hold shared runtime"));
  await waitUntil(() => job(f, launch.jobId).turnId);
  const before = job(f, launch.jobId);
  assert.equal(json(f.call("adopt", launch.jobId, "--json")).adopted, true);
  assert.equal(job(f, launch.jobId).budget.maxMinutes, 1);
  assert.ok(job(f, launch.jobId).budget.consumedMs >= before.budget.consumedMs);
  // Advance the durable consumption, not the test's wall clock. The fake turn
  // remains in progress until the production watchdog sends turn/interrupt.
  patchJob(f, launch.jobId, { budget: { ...job(f, launch.jobId).budget, consumedMs: 60000 } });
  await waitUntil(() => job(f, launch.jobId).status === "interrupted");
  const ended = job(f, launch.jobId);
  assert.equal(ended.result.interruptionReason, "budget_exceeded:max_minutes");
  assert.equal(ended.result.interruptionConfirmed, true);
  assert.equal(ended.budget.exceeded, "max_minutes");
  assert.equal(ended.budget.runningSince, null);
  assert.equal(unresolvedTask(ended), false);
  const report = json(f.call("result", launch.jobId), 1);
  assert.ok(report.blockers.some(blocker => blocker.code === "budget_exceeded" && /max_minutes/.test(blocker.message)));
  const details = json(f.call("result", launch.jobId, "--details"), 1);
  assert.deepEqual(details.reason, { code: "budget_exceeded", limit: "max_minutes", maximum: 60000, consumed: ended.budget.consumedMs, unit: "milliseconds" });
  const journal = JSON.parse(fs.readFileSync(path.join(ended.runStateDir, "runs", ended.runId, "jobs", `${ended.id}.report.json`), "utf8"));
  assert.equal(journal.reason.code, "budget_exceeded");
  assert.equal(journal.reason.limit, "max_minutes");
  assert.equal(direct(f.call("task", "--thread", ended.threadId, "--direct", "finish fixture")).status, "completed");
});

test("token budgets interrupt on a usage update, retain the overshoot and exclude previous turns", () => {
  const f = fixture("writer-lock");
  const stopped = direct(f.call("task", "--direct", "--max-tokens", "150", "hold shared runtime"), 1);
  assert.equal(isC2Report(stopped), true);
  assert.equal(stopped.status, "interrupted");
  assert.ok(stopped.blockers.some(blocker => blocker.code === "budget_exceeded" && /max_tokens/.test(blocker.message)));
  const ended = job(f, stopped.jobId);
  assert.equal(ended.result.interruptionReason, "budget_exceeded:max_tokens");
  assert.equal(ended.result.interruptionConfirmed, true);
  assert.equal(ended.budget.consumedTokens, 180);
  assert.equal(ended.budget.maxTokens, 150);
  assert.equal(unresolvedTask(ended), false);
  const resumed = direct(f.call("task", "--thread", ended.threadId, "--direct", "--max-tokens", "200", "finish fixture"));
  assert.equal(resumed.status, "completed");
  assert.equal(job(f, resumed.jobId).budget.consumedTokens, 180);
  assert.equal(f.requests().filter(request => request.method === "turn/interrupt").length, 1);
});

test("budgets default off; setup previews, saves and resets defaults and explicit task limits override them", () => {
  const f = fixture("task-ok");
  const preview = json(f.call("setup", "--default-max-minutes", "2.5", "--default-max-tokens", "300", "--dry-run", "--json"));
  assert.equal(preview.defaultMaxMinutes, 2.5);
  assert.equal(fs.existsSync(path.join(f.env.CODEX_COMPANION_HOME, "duet", "config.toml")), false);
  const defaults = json(f.call("setup", "--json"));
  assert.equal(defaults.defaultMaxMinutes, "off");
  assert.equal(defaults.defaultMaxTokens, "off");
  assert.match(defaults.budgetNote, /overshoot by one usage update/);
  const original = direct(f.call("task", "--direct", "fixture"));
  assert.equal(original.status, "completed");
  assert.equal(job(f, original.jobId).budget.maxMinutes, null);
  assert.equal(job(f, original.jobId).budget.maxTokens, null);
  assert.equal(job(f, original.jobId).cancelRequested, undefined);
  json(f.call("setup", "--default-max-minutes", "2.5", "--default-max-tokens", "300", "--json"));
  const saved = direct(f.call("task", "--direct", "fixture"));
  assert.equal(job(f, saved.jobId).budget.maxMinutes, 2.5);
  assert.equal(job(f, saved.jobId).budget.maxTokens, 300);
  const override = direct(f.call("task", "--direct", "--max-minutes", "4", "--max-tokens", "400", "fixture"));
  assert.equal(job(f, override.jobId).budget.maxMinutes, 4);
  assert.equal(job(f, override.jobId).budget.maxTokens, 400);
  json(f.call("setup", "--default-max-minutes", "off", "--default-max-tokens", "off", "--json"));
  assert.equal(json(f.call("setup", "--json")).defaultMaxTokens, "off");
  const permission = command => approveDuet({ hook_event_name: "PreToolUse", tool_name: "Bash", permission_mode: "default", session_id: "fixture-session", tool_use_id: "budget-tool", cwd: f.repo, tool_input: { command } }, { ...f.env, PATH: path.dirname(process.execPath) });
  assert.equal(permission("duet task --max-minutes 2.5 --max-tokens 300").hookSpecificOutput.permissionDecision, "allow");
  assert.deepEqual(permission("duet task --max-tokens 1.5"), {});
  assert.equal(f.call("task", "--max-tokens", "0", "fixture").status, 1);
  assert.equal(f.call("setup", "--default-max-minutes", "0", "--json").status, 1);
});
