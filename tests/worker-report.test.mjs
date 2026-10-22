import fs from "node:fs";
import path from "node:path";
import { spawnOwned as spawn } from "../plugins/codex/scripts/lib/process.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { buildWorkerReport, classifyWorkerOutcome, classifyBrowserBlocker, parseStructuredReport } from "../plugins/codex/scripts/lib/worker-report.mjs";
import { makeTempDir, run, initGitRepo, waitForCondition } from "./helpers.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";

const script = new URL("../plugins/codex/scripts/codex-companion.mjs", import.meta.url).pathname;
const stateModule = new URL("../plugins/codex/scripts/lib/state.mjs", import.meta.url).href;
test("stale browser claims have a distinct blocker with the owning session ID", () => {
  const text = "Tab 123 is already part of browser session 00000000-0000-0000-0000-000000000001";
  const report = buildWorkerReport({ status: 0, rawOutput: text });
  assert.equal(report.status, "blocked");
  assert.deepEqual(report.browserBlocker, { kind: "stale_browser_tab_claim", tabId: "123", sessionId: "00000000-0000-0000-0000-000000000001" });
  assert.equal(report.blockers[0].code, "stale_browser_tab_claim");
  assert.equal(report.blockers[0].sessionId, "00000000-0000-0000-0000-000000000001");
  assert.equal(report.blockers[0].tabId, "123");
  assert.equal(buildWorkerReport({ status: 1, error: text }).browserBlocker.kind, "stale_browser_tab_claim");
  assert.equal(classifyBrowserBlocker("a tab is already part of another session"), null);
  assert.equal(classifyBrowserBlocker("Tab 123 is already part of browser session malformed"), null);
});
function fixture(behavior) {
  const dir = makeTempDir();
  installFakeCodex(dir, behavior);
  const repo = path.join(dir, "repo"); fs.mkdirSync(repo); initGitRepo(repo);
  const env = { ...buildEnv(dir), CLAUDE_PLUGIN_DATA: path.join(dir, "data") };
  const call = (...args) => run(process.execPath, [script, ...args], { cwd: repo, env });
  const state = () => JSON.parse(fs.readFileSync(path.join(dir, "fake-codex-state.json"), "utf8"));
  return { dir, repo, env, call, state };
}

function storedFixtureJob(f, id, patch = null) {
  const response = run(process.execPath, ["--input-type=module", "-e", `
    import { readJobFile, resolveJobFile, updateJob } from ${JSON.stringify(stateModule)};
    const id = ${JSON.stringify(id)}, patch = ${JSON.stringify(patch)};
    console.log(JSON.stringify(patch ? updateJob(process.cwd(), id, () => patch) : readJobFile(resolveJobFile(process.cwd(), id))));
  `], { cwd: f.repo, env: f.env });
  assert.equal(response.status, 0, response.stderr);
  return JSON.parse(response.stdout);
}

function loseTurn(f) {
  const response = f.call("task", "--report", "--json", "complete the fixture work");
  assert.equal(response.status, 1, response.stderr);
  const id = /Job handle: ([^;]+)/.exec(response.stderr)?.[1];
  assert.ok(id, response.stderr);
  const job = storedFixtureJob(f, id);
  assert.equal(job.status, "failed");
  assert.ok(job.threadId && job.turnId && job.errorMessage);
  assert.ok(!job.result);
  assert.equal(f.state().nextTurnId, 2);
  return job;
}

const directJson = response => {
  try { return JSON.parse(response.stdout); }
  catch { return JSON.parse(response.stdout.trim().split("\n").filter(line => line.startsWith("{")).at(-1)); }
};

function callAsync(f, ...args) {
  const child = spawn(process.execPath, [script, ...args], { cwd: f.repo, env: f.env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", data => { stdout += data; });
  child.stderr.on("data", data => { stderr += data; });
  return { child, done: new Promise(resolve => child.once("close", status => resolve({ status, stdout, stderr }))) };
}

test("lost completed turns preserve structured blocked and needs_input outcomes with recovery provenance", () => {
  for (const outcome of ["blocked", "needs_input"]) {
    const f = fixture("lost-turn:completed"), original = loseTurn(f);
    const state = f.state(), turn = state.threads[0].turns[0];
    assert.equal(turn.status, "completed");
    const blockers = [{ code: "fixture_dependency", message: "Fixture dependency unavailable." }];
    const question = outcome === "needs_input" ? "Which fixture dependency should be used?" : null;
    const message = turn.items.find(item => item.type === "agentMessage");
    message.text = JSON.stringify({ ...JSON.parse(message.text), status: outcome,
      summary: "Fixture dependency unavailable.", blockers, question });
    fs.writeFileSync(path.join(f.dir, "fake-codex-state.json"), JSON.stringify(state));

    const waited = f.call("wait", original.id, "--owner", original.ownerId, "--direct");
    assert.equal(waited.status, 2, waited.stderr + waited.stdout);
    const report = directJson(waited), saved = storedFixtureJob(f, original.id);
    assert.equal(report.status, outcome);
    assert.equal(saved.status, outcome);
    assert.equal(saved.result.structured.status, outcome);
    assert.equal(saved.result.workerStatus, outcome);
    assert.equal(report.recovered, true);
    assert.equal(saved.recovered, true);
    assert.equal(report.recoveredAt, saved.recoveredAt);
    assert.equal(report.completedAt, new Date(turn.completedAt * 1000).toISOString());
    assert.equal(saved.completedAt, report.completedAt);
    assert.notEqual(report.completedAt, report.recoveredAt);
    assert.equal(report.recovery.originalError, original.errorMessage);
    assert.equal(report.recovery.wrapperEndedAt, original.completedAt);
    assert.equal(report.recovery.turnStatus, "completed");
    assert.equal(report.recovery.source, "thread/read");
    assert.equal(report.threadId, original.threadId);
    assert.equal(report.turnId, original.turnId);
    assert.equal(report.recovery.turnId, original.turnId);
    assert.deepEqual(report.blockers, blockers);
    if (question) assert.equal(report.question, question);
    assert.equal(saved.errorMessage, null);
    assert.equal(JSON.parse(fs.readFileSync(saved.resultFile)).recovery.originalError, original.errorMessage);

    const result = f.call("result", original.id, "--report", "--json");
    assert.equal(result.status, 2, result.stderr + result.stdout);
    const reread = directJson(result);
    assert.equal(reread.status, outcome);
    assert.equal(reread.recoveredAt, report.recoveredAt);
    assert.equal(reread.completedAt, report.completedAt);
    assert.deepEqual(reread.recovery, report.recovery);
    assert.deepEqual(reread.blockers, blockers);
    if (question) assert.equal(reread.question, question);
    assert.deepEqual(f.state().turnReads, [{ threadId: original.threadId, includeTurns: true }]);
    assert.equal(f.state().nextTurnId, 2, "recovery never replays the turn");
  }
});

test("running predecessor blocks a direct follow-up with an observational status command", async () => {
  const f = fixture("w5-working");
  const launch = JSON.parse(f.call("task", "--detached", "--json", "fixture work").stdout);
  const waiter = callAsync(f, "wait", launch.jobId, "--owner", launch.ownerId, "--direct");
  try {
    await waitForCondition(() => { const job = storedFixtureJob(f, launch.jobId); return job.turnId && job.ownerAttached; });
    const job = storedFixtureJob(f, launch.jobId);
    const response = f.call("task", "--thread", job.threadId, "--direct", "follow up");
    assert.equal(response.status, 2, response.stderr + response.stdout);
    const report = directJson(response);
    assert.equal(report.status, "blocked");
    assert.equal(report.turnId, null);
    assert.equal(report.blockers[0].code, "thread_busy");
    assert.equal(report.blockers[0].predecessorJobId, job.id);
    assert.equal(report.blockers[0].predecessorStatus, "running");
    assert.match(report.blockers[0].recoveryCommand, / status .* --cwd .* --json$/);
    assert.doesNotMatch(report.blockers[0].recoveryCommand, /\bwait\b|--owner/);
    assert.ok(!report.blockers[0].recoveryCommand.includes(job.ownerId));
    assert.equal(f.state().nextTurnId, 2, "blocked job must never start a turn");
    const recovery = run("/bin/sh", ["-c", report.blockers[0].recoveryCommand], { cwd: f.repo, env: f.env });
    assert.equal(recovery.status, 0, recovery.stderr + recovery.stdout);
    assert.equal(directJson(recovery).job.status, "running");
    const observed = storedFixtureJob(f, job.id);
    assert.equal(observed.ownerId, job.ownerId);
    assert.equal(observed.ownerAttached, true);
    assert.equal(observed.ownerWaitToken, job.ownerWaitToken);
    assert.equal(observed.status, "running");
    assert.ok(!observed.interruptionReason);
    assert.ok(!f.state().lastInterrupt);
    assert.equal(storedFixtureJob(f, report.jobId).status, "blocked");
  } finally {
    f.call("cancel", launch.jobId, "--json");
    waiter.child.kill("SIGTERM");
    await waiter.done;
  }
});

test("compact worker report is bounded, separates claims and preserves full output", () => {
  const f = fixture("verbose-task");
  const response = f.call("task", "--fresh", "--report", "--json", "investigate");
  assert.equal(response.status, 0, response.stderr);
  const report = JSON.parse(response.stdout);
  assert.equal(report.status, "completed");
  assert.ok(response.stdout.split("\n").length <= 60);
  assert.equal(fs.readFileSync(report.rawOutputFile, "utf8").split("\n").length, 300);
  assert.ok(JSON.parse(fs.readFileSync(report.resultFile)).rawOutput.includes("Finding 299"));
  const restored = f.call("result", report.jobId, "--report", "--json");
  assert.equal(restored.status, 0, restored.stderr);
  assert.deepEqual(JSON.parse(restored.stdout), report);
  const legacy = JSON.parse(f.call("result", report.jobId, "--json").stdout);
  assert.ok(legacy.storedJob.result.rawOutput.includes("Finding 299"));
  assert.equal(f.state().nextTurnId, 2);
});

test("a --report worker runs with the worker-report schema and the parent reads the declared report", () => {
  const f = fixture("review-ok");
  const response = f.call("task", "--report", "--json", "implement safely");
  assert.equal(response.status, 0, response.stderr);
  const report = JSON.parse(response.stdout);
  const schema = f.state().lastTurnStart.outputSchema;
  assert.deepEqual(Object.keys(schema.properties).sort(), ["assumptions", "blockers", "key_findings", "question", "status", "summary", "verification"]);
  assert.equal(schema.additionalProperties, false, "strict structured output requires a closed object");
  assert.deepEqual(schema.required.sort(), Object.keys(schema.properties).sort(), "strict structured output requires every property");
  assert.equal(report.status, "completed");
  assert.equal(report.reportFormat, "structured");
  assert.deepEqual(report.keyFindings, ["Fixture finding one", "Fixture finding two"]);
  assert.deepEqual(report.assumptions, ["Fixture assumption"]);
  assert.deepEqual(report.claimedVerification, ["fixture check: passed"]);
  // The summary is the prose the parent reads; the raw output file holds it, not the JSON envelope.
  assert.equal(fs.readFileSync(report.rawOutputFile, "utf8"), "Handled the requested task.\nTask prompt accepted.");
  const stored = JSON.parse(fs.readFileSync(report.resultFile, "utf8"));
  assert.equal(stored.rawOutput, "Handled the requested task.\nTask prompt accepted.");
  assert.equal(stored.structured.status, "completed");
  // A task without --report (stop-gate hook, plain rescue) keeps prose output and no schema.
  const plain = f.call("task", "--json", "implement safely");
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(f.state().lastTurnStart.outputSchema, null);
  assert.equal(JSON.parse(plain.stdout).rawOutput, "Handled the requested task.\nTask prompt accepted.");
});

test("a declared blocked report is blocked with Codex's own blocker entries", () => {
  const f = fixture("structured-blocked");
  const response = f.call("task", "--report", "--json", "install the dependency");
  assert.equal(response.status, 2, response.stderr);
  const report = JSON.parse(response.stdout);
  assert.equal(report.status, "blocked");
  assert.deepEqual(report.blockers, [{ code: "missing_dependency", message: "fixture-dep is not installed" }]);
  assert.equal(JSON.parse(f.call("status", report.jobId, "--json").stdout).job.status, "blocked");
});

test("parseStructuredReport accepts the schema object or a trailing json block and rejects prose", () => {
  const object = { status: "needs_input", summary: "Need the target branch.", key_findings: [], assumptions: ["x"], verification: [], blockers: [], question: "Which branch should receive the fix?" };
  const parsed = parseStructuredReport(JSON.stringify(object));
  assert.equal(parsed.status, "needs_input");
  assert.equal(parsed.question, "Which branch should receive the fix?");
  const fenced = parseStructuredReport(`Done.\n\n\`\`\`json\n${JSON.stringify({ ...object, status: "completed", question: null })}\n\`\`\``);
  assert.equal(fenced.status, "completed");
  assert.equal(fenced.question, null);
  assert.equal(parseStructuredReport("Implemented the fix. Tests passed."), null);
  assert.equal(parseStructuredReport(JSON.stringify({ status: "done", summary: "x" })), null, "unknown status is not a report");
  assert.equal(parseStructuredReport(JSON.stringify({ verdict: "approve", summary: "x" })), null);
  // Declared completed with a plan-only summary is still needs_input; declared needs_input carries its question.
  const over = buildWorkerReport({ status: 0, rawOutput: "I will inspect the repository and then implement the change.", structured: { ...parsed, status: "completed", summary: "I will inspect the repository and then implement the change.", question: null } });
  assert.equal(over.status, "needs_input");
  const asks = buildWorkerReport({ status: 0, rawOutput: object.summary, structured: parsed });
  assert.equal(asks.status, "needs_input");
  assert.equal(asks.question, "Which branch should receive the fix?");
  assert.equal(asks.blockers[0].code, "needs_input");
  // A captured runtime refusal outranks a declared completed.
  const captured = buildWorkerReport({ status: 0, rawOutput: "Done.", structured: { ...parsed, status: "completed", summary: "Done.", question: null }, blockers: [{ code: "computer_use_app_not_approved", app: "com.google.Chrome" }] });
  assert.equal(captured.status, "blocked");
  // Declared blocked without entries names the summary.
  const bare = buildWorkerReport({ status: 0, rawOutput: "Blocked by the firewall.", structured: { ...parsed, status: "blocked", summary: "Blocked by the firewall.", question: null } });
  assert.deepEqual(bare.blockers, [{ code: "reported_blocked", message: "Blocked by the firewall." }]);
});

for (const behavior of ["question-only"]) test(`${behavior} is needs_input, not success`, () => {
  const f = fixture(behavior);
  const response = f.call("task", "--report", "--json", "implement safely");
  assert.equal(response.status, 2, response.stderr);
  const report = JSON.parse(response.stdout);
  assert.equal(report.status, "needs_input");
  assert.ok(report.question);
  assert.equal(JSON.parse(f.call("status", report.jobId, "--json").stdout).job.status, "needs_input");
  assert.equal(f.call("result", report.jobId, "--report", "--json").status, 2);
  assert.equal(f.state().nextTurnId, 2);
});

test("question detection keeps delivered findings with an optional follow-up complete", () => {
  assert.equal(classifyWorkerOutcome("Implemented the fix. Tests passed. Would you like details?"), "completed");
  assert.equal(classifyWorkerOutcome("Status: needs_input\nWhich target?"), "needs_input");
  assert.equal(classifyWorkerOutcome("请确认要使用哪个数据库？"), "needs_input");
  assert.equal(classifyWorkerOutcome("Which files should be changed?"), "needs_input");
  assert.equal(classifyWorkerOutcome("Please confirm whether tests passed."), "needs_input");
  assert.equal(classifyWorkerOutcome("I will implement the changes once tests have passed."), "needs_input");
  assert.equal(classifyWorkerOutcome("", 1), "failed");
  const report = buildWorkerReport({ status: 0, rawOutput: "Fixed issue", touchedFiles: Array(40).fill("a.js"), commandExecutions: [{ command: "node --test", exitCode: 1, status: "failed" }] });
  assert.equal(report.touchedFiles.length + report.touchedFilesOmitted, 40);

});
test("Computer Use refusals and declared blocks are structured blockers with status blocked", () => {
  const rawOutput = [
    "**Blocked before native capture.** No new screenshots were taken.",
    "- `cua.getApp(\"Google Chrome\")` failed: `Computer Use was not approved to use Google Chrome`.",
    "| Tab | Session | Result |", "| --- | --- | --- |",
    "| `128187414` | `codex-readme-shots` | Could not close: `Debugger unattached`. May require manual closure. |",
    "The first tab failed inspection, rebinding, and close operations with `Debugger unattached`.",
    "Assumptions", "None beyond the above."
  ].join("\n");
  const report = buildWorkerReport({ status: 0, rawOutput, approvedComputerApps: ["com.google.Chrome"], touchedFiles: Array(40).fill("changed.js"), preExistingChanges: Array(30).fill("dirty.js"), commandExecutions: Array(10).fill({ command: "node --test", exitCode: 0, status: "completed" }), approvedBrowserOrigins: Array.from({ length: 10 }, (_, i) => `https://fixture${i}.example`) });
  assert.equal(report.status, "blocked");
  assert.deepEqual(report.approvedComputerApps, ["com.google.Chrome"]);
  assert.deepEqual(report.blockers.map(b => b.code), ["computer_use_app_not_approved", "browser_tab_debugger_unattached"]);
  assert.equal(report.blockers[0].app, "Google Chrome");
  assert.deepEqual([report.blockers[1].tabId, report.blockers[1].sessionId, report.blockers[1].closed], ["128187414", "codex-readme-shots", false]);
  assert.equal(report.blockersOmitted, 1, "the declared block is counted when the budget drops it");
  assert.ok(`${JSON.stringify(report, null, 2)}\n`.split("\n").length <= 60);
  const declared = buildWorkerReport({ status: 0, rawOutput: "Blocked: the review cannot proceed without the design file.\nDetails follow." });
  assert.equal(declared.status, "blocked");
  assert.deepEqual(declared.blockers, [{ code: "reported_blocked", message: "Blocked: the review cannot proceed without the design file." }]);
  assert.equal(buildWorkerReport({ status: 0, rawOutput: "Status: blocked\nWaiting on credentials." }).status, "blocked");
  // Captured runtime blockers make a turn blocked even when the final answer claims success.
  const captured = buildWorkerReport({ status: 0, rawOutput: "Done, screenshots attached.", blockers: [{ code: "computer_use_app_not_approved", app: "com.google.Chrome", message: "Computer Use elicitation for com.google.Chrome cancelled (no-flag)" }] });
  assert.equal(captured.status, "blocked");
  assert.equal(captured.blockers[0].app, "com.google.Chrome");
  assert.equal(classifyWorkerOutcome("Computer Use is blocked from using the app 'com.evil.App' by your organization's policy."), "blocked");
  assert.equal(classifyWorkerOutcome("Implemented the unblocking fix; tests passed."), "completed");
  assert.equal(buildWorkerReport({ status: 1, error: "Computer Use was not approved to use Google Chrome" }).status, "failed");
});

test("compact report budgets origin grants and a stale claim without losing the session ID", () => {
  const report = buildWorkerReport({
    status: 0, rawOutput: "Tab 123 is already part of browser session 00000000-0000-0000-0000-000000000001\nAssumptions\nPending decision\nMore findings\nOther findings",
    touchedFiles: Array(40).fill("changed.js"), preExistingChanges: Array(30).fill("dirty.js"),
    commandExecutions: Array(10).fill({ command: "node --test", exitCode: 0, status: "completed" }),
    approvedBrowserOrigins: Array.from({ length: 10 }, (_, i) => `https://fixture${i}.example`)
  });
  assert.equal(report.approvedBrowserOriginsOmitted, 7);
  assert.equal(report.preExistingChangesOmitted, 27);
  assert.equal(report.touchedFiles.length + report.touchedFilesOmitted, 40);
  assert.equal(report.browserBlocker.sessionId, "00000000-0000-0000-0000-000000000001");
  assert.ok(`${JSON.stringify(report, null, 2)}\n`.split("\n").length <= 60);
});

test("recovery fetches the exact lost turn, even after a later turn on the same thread", () => {
  const f = fixture("review-ok");
  const first = JSON.parse(f.call("task", "--report", "--json", "first task").stdout);
  const second = JSON.parse(f.call("task", "--report", "--json", "--thread", first.threadId, "follow up").stdout);
  const patch = run(process.execPath, ["--input-type=module", "-e", `
    import { readJobFile, resolveJobFile, writeJobFile, upsertJob } from ${JSON.stringify(stateModule)};
    const id = ${JSON.stringify(first.jobId)};
    const job = readJobFile(resolveJobFile(process.cwd(), id));
    delete job.result; delete job.rendered; delete job.report;
    Object.assign(job, { status: "running", pid: null });
    writeJobFile(process.cwd(), id, job);
    upsertJob(process.cwd(), { id, status: "running", pid: null });
  `], { cwd: f.repo, env: f.env });
  assert.equal(patch.status, 0, patch.stderr);
  const recovered = f.call("result", first.jobId, "--report", "--json");
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(JSON.parse(recovered.stdout).turnId, first.turnId);
  assert.equal(JSON.parse(recovered.stdout).fileTrackingStatus, "partial");
  assert.equal(JSON.parse(recovered.stdout).sandbox, "danger-full-access", "the recovered report keeps the sandbox the job actually ran with");
  assert.equal(JSON.parse(f.call("result", "--thread", first.threadId, "--report", "--json").stdout).turnId, second.turnId);
  assert.equal(f.state().nextTurnId, 3, "recovery must not submit a third turn");
});

test("early handle and heartbeat survive a killed wrapper; result recovers without rerun", async () => {
  const f = fixture("slow-recovery-task");
  const gate = path.join(f.dir, "release-turn");
  f.env.CODEX_FIXTURE_TURN_GATE = gate;
  const child = spawn(process.execPath, [script, "task", "--report", "--json", "investigate"], {
    cwd: f.repo, env: { ...f.env, CODEX_COMPANION_PROGRESS_INTERVAL_MS: "250" }, stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "", stdout = "";
  child.stderr.on("data", data => { stderr += data; });
  child.stdout.on("data", data => { stdout += data; });
  const exited = new Promise(resolve => child.once("exit", resolve));
  const waitFor = async predicate => {
    const deadline = Date.now() + 12000;
    while (!predicate()) {
      if (Date.now() > deadline) { child.kill("SIGKILL"); throw new Error(`Timed out: ${stderr}`); }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };
  await waitFor(() => /Turn handle:/.test(stderr) && /Progress:/.test(stderr));
  const id = /Job handle: ([^;]+)/.exec(stderr)[1];
  assert.equal(stdout, "", "stdout must not contain progress or partial JSON");
  child.kill("SIGKILL"); await exited;
  fs.writeFileSync(gate, "finish");
  await waitFor(() => f.state().threads[0].turns?.some(t => t.status === "completed"));
  const response = f.call("result", id, "--report", "--json");
  assert.equal(response.status, 0, response.stderr + response.stdout);
  assert.equal(JSON.parse(response.stdout).status, "completed");
  assert.equal(f.state().nextTurnId, 2);
  const status = JSON.parse(f.call("status", id, "--json").stdout);
  assert.equal(status.job.recovered, true);
  assert.match(fs.readFileSync(status.job.logFile, "utf8"), /Progress:.*items, .*tools;.*last activity/);
});

// Shared fixture; these contracts were moved from worker-lifecycle to balance file runtime.
{
const {
  fs, path, makeTempDir, initGitRepo, run, buildEnv, installFakeCodex, redactActivity, activityReader, writeJobFile, upsertJob, directReport, buildWorkerReport, AGENT_NAMES, splitRawArgumentString, spawnOwned, script, fixture, json, directLines, direct, waitUntil, job
} = await (await import('./fake-codex-fixture.mjs')).lifecycleHarness();
test("task --direct streams progress as owner, then resumes without replaying activity", async () => {
  const f = fixture("w9-feed"), gate = path.join(f.dir, "finish-turn");
  f.env.CODEX_FIXTURE_TURN_GATE = gate;
  const owner = spawnOwned(process.execPath, [script, "task", "--direct", "fixture"],
    { cwd: f.repo, env: f.env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  owner.stdout.on("data", chunk => { stdout += chunk; });
  owner.stderr.on("data", chunk => { stderr += chunk; });
  const closed = new Promise(resolve => owner.once("close", resolve));
  await waitUntil(() => {
    assert.equal(owner.exitCode, null, stderr || "direct owner exited before progress");
    return stdout.includes("\n");
  });
  assert.equal(owner.exitCode, null, "fixture completion is still gated");
  assert.equal(stdout.split("\n").some(line => line.startsWith("{")), false);
  fs.writeFileSync(gate, "complete");
  const done = direct({ status: await closed, stdout, stderr });
  assert.equal(done.status, "completed");
  assert.equal(directLines(stdout).length - 1, done.activityCount);
  assert.ok(done.activityCount > 0);
  const stored = job(f, done.jobId);
  assert.equal(stored.leaseSec, 1800);
  assert.equal(stored.direct, true);
  assert.equal(stored.ownerId, done.ownerId);
  assert.equal(stored.ownerDetachReason, "returned");
  assert.equal(stored.request.report, true);
  assert.equal(stored.request.detached, true);
  assert.doesNotMatch(JSON.stringify(done), /PRIVATE_FIXTURE/);
  const again = f.call("wait", done.jobId, "--owner", done.ownerId, "--direct");
  const repeated = direct(again);
  assert.equal(directLines(again.stdout).length, 1);
  assert.equal(repeated.activityCount, 0);
  assert.equal(repeated.turnId, done.turnId);
  assert.equal(f.state().nextTurnId, 2);
});

test("direct questions provide executable re-wait and stdin-answer commands and preserve adoption", async () => {
  const f = fixture("w5-parent"), launch = json(f.call("task", "--detached", "--json", "--owner", "parent's owner", "fixture"));
  const pending = direct(f.call("wait", launch.jobId, "--owner", launch.ownerId, "--direct"));
  assert.equal(pending.status, "needs_answer"); assert.ok(pending.question.id);
  assert.deepEqual(pending.question.options, ["Small", "Broad"]);
  assert.deepEqual(splitRawArgumentString(pending.waitCommand), ["node", script, "wait", launch.jobId, "--cwd", f.repo, "--owner", launch.ownerId, "--direct", "--after-question", pending.question.id]);
  assert.deepEqual(splitRawArgumentString(pending.answerCommand), ["node", script, "answer", launch.jobId, "--cwd", f.repo, "--owner", launch.ownerId, "--question", pending.question.id, "--json"]);
  const before = job(f, launch.jobId);
  assert.equal(before.direct, true); assert.equal(before.leaseSec, 180, "direct wait preserves the original lease duration");
  const began = Date.now();
  const stillPendingOutput = f.call(...splitRawArgumentString(pending.waitCommand).slice(2), "--timeout-sec", "1");
  const stillPending = direct(stillPendingOutput);
  assert.equal(directLines(stillPendingOutput.stdout).length, 1, "--after-question does not replay progress");
  assert.equal(stillPending.question.id, pending.question.id);
  assert.ok(job(f, launch.jobId).leaseExpiresAt > before.leaseExpiresAt);
  const adopted = json(f.call("adopt", launch.jobId, "--json"));
  assert.deepEqual(splitRawArgumentString(adopted.waitCommand), ["node", script, "wait", launch.jobId, "--owner", adopted.ownerId, "--cwd", f.repo, "--direct"]);
  const moved = direct(f.call("wait", launch.jobId, "--owner", launch.ownerId, "--direct"), 2);
  assert.equal(moved.status, "ownership_moved"); assert.equal(moved.ownerId, adopted.ownerId);
  assert.equal(moved.waitCommand, undefined); assert.equal(moved.answerCommand, undefined);
  const replacement = direct(f.call(...splitRawArgumentString(adopted.waitCommand).slice(2)));
  const cursor = job(f, launch.jobId).activityCursors[activityReader(adopted.ownerId)];
  const owner = spawnOwned(process.execPath, splitRawArgumentString(replacement.waitCommand).slice(1), { cwd: f.repo, env: f.env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  owner.stdout.on("data", chunk => { stdout += chunk; }); owner.stderr.on("data", chunk => { stderr += chunk; });
  const closed = new Promise(resolve => owner.on("close", resolve));
  await waitUntil(() => job(f, launch.jobId).ownerAttached);
  const answer = run(process.execPath, splitRawArgumentString(replacement.answerCommand).slice(1), { cwd: f.repo, env: f.env, input: "Small PRIVATE_FIXTURE_ANSWER" });
  assert.equal(json(answer).status, "answer_submitted");
  const done = direct({ status: await closed, stdout, stderr });
  const progress = directLines(stdout).slice(0, -1);
  assert.ok(progress.length > 0, "answering produces new progress before the final report");
  assert.equal(progress.length, done.activityCount);
  for (const line of progress) assert.ok(Number(/^\[(\d+)\]/.exec(line)?.[1]) > cursor, "only new events are streamed");
  assert.equal(done.status, "completed"); assert.equal(done.turnId, pending.turnId);
});

test("direct terminal waits retain structured report fields and existing outcome exit codes", () => {
  for (const [behavior, status, code] of [["slow-task", "completed", 0], ["structured-blocked", "blocked", 2], ["question-only", "needs_input", 2]]) {
    const f = fixture(behavior), output = f.call("task", "--direct", "fixture");
    const result = direct(output, code), launch = result;
    assert.ok(directLines(output.stdout).length > 1, "task streams progress before its terminal report");
    // An independent observer reads the same completed job from cursor zero,
    // avoiding different job IDs/timestamps while comparing exact payload bytes.
    const quiet = f.call("wait", launch.jobId, "--direct", "--quiet");
    assert.deepEqual(direct(quiet, code), result);
    assert.equal(quiet.stdout, `${directLines(output.stdout).at(-1)}\n`);
    assert.equal(result.status, status); assert.equal(result.reportFormat, "structured");
    assert.equal(result.summary, fs.readFileSync(result.rawOutputFile, "utf8").trim(), "the final summary travels in the direct payload");
    const legacy = json(f.call("wait", launch.jobId, "--owner", launch.ownerId, "--json"), code);
    for (const key of ["status", "reportFormat", "jobId", "threadId", "turnId", "exitCode", "sandbox", "approvalPolicy", "model", "effort", "serviceTier", "touchedFiles", "preExistingChanges", "fileTrackingStatus", "fileTrackingBasis", "verification", "verificationBasis", "keyFindings", "findingsBasis", "assumptions", "blockers", "question", "rawOutputFile", "resultFile", "ownerId", "sessionId"]) {
      assert.equal(Object.hasOwn(result, key), Object.hasOwn(legacy, key), key); assert.deepEqual(result[key], legacy[key], key);
    }
    assert.deepEqual(result.claimedVerification, legacy.claimedVerification ?? [], "direct structured reports include the full verification list, including an empty list");
    if (status !== "completed") {
      assert.match(result.continuationCommand, / --direct$/);
      assert.equal(legacy.continuationCommand, result.continuationCommand);
      assert.equal(json(f.call("adopt", launch.jobId, "--json"), 2).continuationCommand, result.continuationCommand);
    }
  }
  const cwd = makeTempDir(), id = "long-structured-report", createdAt = new Date().toISOString();
  const entries = ["\x1b[31mLong finding\x1b[0m\n" + "detail ".repeat(80), "x".repeat(2100), ...Array.from({ length: 20 }, (_, i) => `Entry ${i}\nwith details`)];
  const structured = { status: "completed", summary: "Completed the work.", keyFindings: entries, assumptions: entries, verification: entries, blockers: [], question: null };
  const result = { status: 0, structured, rawOutput: structured.summary };
  const report = buildWorkerReport(result, { jobId: id });
  const record = { id, workspaceRoot: cwd, jobClass: "task", status: "completed", createdAt, result, report,
    activity: Array.from({ length: 75 }, (_, i) => ({ seq: i + 1, type: "agentMessage", text: "\x1b[31mFixture\x1b[0m\n\r\u202e " + "details ".repeat(40) })) };
  writeJobFile(cwd, id, record); upsertJob(cwd, record);
  const output = run(process.execPath, [script, "wait", id, "--direct"], { cwd });
  const full = direct(output);
  assert.equal(directLines(output.stdout).length, 76, "direct progress has no feed cap");
  assert.equal(full.activityCount, 75);
  const legacy = json(run(process.execPath, [script, "wait", id, "--json"], { cwd }));
  for (const key of ["keyFindings", "assumptions", "claimedVerification"]) {
    assert.deepEqual(full[key], entries.slice(0, 20).map(value => redactActivity(value).slice(0, 2000)), key);
    assert.ok(full[key][0].length > 300); assert.ok(full[key][0].includes("\n")); assert.equal(full[key][1].length, 2000);
    assert.deepEqual(legacy[key], report[key], "non-direct lists retain the report builder's bounds");
    assert.ok(legacy[key][0].length <= 300);
  }
  assert.ok(legacy.assumptions.length <= 3); assert.ok(legacy.claimedVerification.length <= 3);
  const warning = directReport({ status: "running", startupWarning: "fixture-warning", activity: [], cursor: 2 }, {});
  assert.equal(warning.startupWarning, "fixture-warning");
  assert.equal(Object.hasOwn(warning, "activity"), false);
  const unstructured = { status: "completed", keyFindings: ["prose finding"], assumptions: ["prose assumption"], claimedVerification: ["prose check"] };
  assert.deepEqual(directReport(unstructured, { result: {} }), unstructured, "without structured data, keep the report's lists");
});

test("direct tasks preserve lease precedence, input forms, run settings and continuation inheritance", () => {
  const f = fixture("slow-task"); f.env.CODEX_COMPANION_LEASE_SEC = "27";
  const promptFile = path.join(f.repo, "prompt.txt"); fs.writeFileSync(promptFile, "fixture from prompt file");
  const firstOutput = f.call("task", "--direct", "--quiet", "--fresh", "--prompt-file", promptFile, "--model", "spark", "--effort", "high", "--fast", "--write", "--sandbox", "workspace-write", "--approve-browser-origin", "https://example.com", "--approve-computer-app", "com.apple.TextEdit", "--owner", "explicit-owner", "--question-timeout-sec", "42", "--cwd", f.repo);
  const first = direct(firstOutput);
  assert.equal(directLines(firstOutput.stdout).length, 1, "task --direct --quiet prints just its JSON");
  const observed = f.call("wait", first.jobId, "--direct");
  assert.deepEqual(direct(observed), first);
  assert.equal(`${directLines(observed.stdout).at(-1)}\n`, firstOutput.stdout, "quiet and streaming task payloads are byte-identical for the same job");
  assert.ok(AGENT_NAMES.includes(first.agentName));
  assert.equal(job(f, first.jobId).agentName, first.agentName);
  assert.equal(job(f, first.jobId).leaseSec, 27); assert.equal(first.ownerId, "explicit-owner");
  assert.equal(first.model, "gpt-5.3-codex-spark"); assert.equal(first.effort, "high"); assert.equal(first.serviceTier, "priority");
  assert.equal(job(f, first.jobId).questionTimeoutSec, 42);
  assert.match(f.state().lastTurnStart.prompt, /fixture from prompt file/);
  const continued = direct(run(process.execPath, [script, "task", "--continue", first.jobId, "--direct", "--report", "--lease-sec", "39"], { cwd: f.repo, env: f.env, input: "fixture from stdin" }));
  assert.equal(job(f, continued.jobId).leaseSec, 39); assert.equal(continued.threadId, first.threadId);
  for (const key of ["agentName", "sandbox", "model", "effort", "serviceTier", "approvedBrowserOrigins", "approvedComputerApps"]) assert.deepEqual(continued[key], first[key], key);
  assert.match(f.state().lastTurnStart.prompt, /fixture from stdin/);
  const threaded = direct(f.call("task", "--direct", "--thread", first.threadId, "--normal", "fixture next turn"));
  assert.equal(threaded.agentName, first.agentName);
  assert.equal(job(f, threaded.jobId).agentName, first.agentName);
  assert.equal(threaded.threadId, first.threadId); assert.equal(threaded.serviceTier, null);
});
}
