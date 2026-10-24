import fs from "node:fs";
import path from "node:path";
import { spawnOwned as spawn } from "../plugins/codex/scripts/lib/process.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { buildWorkerReport, classifyWorkerOutcome, classifyBrowserBlocker, parseStructuredReport } from "../plugins/codex/scripts/lib/worker-report.mjs";
import { makeTempDir, run, initGitRepo, waitForCondition, readyBroker } from "./helpers.mjs";
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
  assert.equal(job.result.failureSource, "transport");
  assert.equal(job.result.errorCode, "BROKER_CONNECTION_CLOSED");
  assert.equal(job.result.turnEnded, false);
  assert.match(job.errorMessage, /connection to Codex closed while the turn was running/i);
  assert.equal(job.activity.length, 36);
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

test("stored transport failures recover the exact terminal outcome and provenance without replay", () => {
  for (const outcome of ["completed", "blocked", "needs_input", "failed", "interrupted"]) {
    const turnStatus = ["failed", "interrupted"].includes(outcome) ? outcome : "completed";
    const f = fixture(`lost-turn:${turnStatus}`), original = loseTurn(f);
    const state = f.state(), turn = state.threads[0].turns[0];
    assert.equal(turn.status, turnStatus);
    const blockers = outcome === "blocked" ? [{ code: "fixture_dependency", message: "Fixture dependency unavailable." }] : [];
    const question = outcome === "needs_input" ? "Which fixture dependency should be used?" : null;
    const message = turn.items.find(item => item.type === "agentMessage");
    if (["blocked", "needs_input"].includes(outcome)) message.text = JSON.stringify({ ...JSON.parse(message.text), status: outcome,
      summary: "Fixture dependency unavailable.", blockers, question });
    fs.writeFileSync(path.join(f.dir, "fake-codex-state.json"), JSON.stringify(state));

    // Legacy releases persisted the diagnostic without a typed transport marker.
    if (outcome === "completed") storedFixtureJob(f, original.id, { errorMessage: "Codex broker connection closed during startup.",
      result: { status: 1, error: "Codex broker connection closed during startup.", threadId: original.threadId, turnId: original.turnId } });
    if (["completed", "interrupted"].includes(outcome)) {
      const status = directJson(f.call("status", original.id, "--json"));
      assert.equal(status.job.status, outcome);
      assert.equal(status.job.turnResolution, turnStatus);
    }

    const waited = f.call("wait", original.id, "--owner", original.ownerId, "--direct");
    const exitCode = outcome === "completed" ? 0 : ["failed", "interrupted"].includes(outcome) ? 1 : 2;
    assert.equal(waited.status, exitCode, waited.stderr + waited.stdout);
    const compact = directJson(waited), report = directJson(f.call("result", original.id, "--details")), saved = storedFixtureJob(f, original.id);
    assert.equal(compact.status, outcome);
    assert.equal(report.status, outcome);
    assert.equal(saved.status, outcome);
    if (!["failed", "interrupted"].includes(outcome)) assert.equal(saved.result.structured.status, outcome);
    assert.equal(saved.result.workerStatus, outcome);
    assert.equal(report.recovered, true);
    assert.equal(saved.recovered, true);
    assert.equal(report.recoveredAt, saved.recoveredAt);
    assert.equal(report.completedAt, new Date(turn.completedAt * 1000).toISOString());
    assert.equal(saved.completedAt, report.completedAt);
    assert.notEqual(report.completedAt, report.recoveredAt);
    const originalError = outcome === "completed" ? "Codex broker connection closed during startup." : original.errorMessage;
    assert.equal(report.recovery.originalError, originalError);
    assert.equal(report.recovery.wrapperEndedAt, original.completedAt);
    assert.equal(report.recovery.turnStatus, turnStatus);
    assert.equal(report.recovery.source, "thread/read");
    assert.equal(report.threadId, original.threadId);
    assert.equal(report.turnId, original.turnId);
    assert.equal(report.recovery.turnId, original.turnId);
    if (!["failed", "interrupted"].includes(outcome)) assert.deepEqual(report.blockers, question ? [{ code: "needs_input", message: question }] : blockers);
    if (question) assert.equal(report.question, question);
    assert.equal(saved.errorMessage, outcome === "failed" ? "Fixture worker failed" : null);
    assert.equal(JSON.parse(fs.readFileSync(saved.resultFile)).recovery.originalError, originalError);

    const result = f.call("result", original.id, "--details");
    assert.equal(result.status, exitCode, result.stderr + result.stdout);
    const reread = directJson(result);
    assert.equal(reread.status, outcome);
    assert.equal(reread.recoveredAt, report.recoveredAt);
    assert.equal(reread.completedAt, report.completedAt);
    assert.deepEqual(reread.recovery, report.recovery);
    assert.deepEqual(reread.blockers, report.blockers);
    if (question) assert.equal(reread.question, question);
    assert.deepEqual(f.state().turnReads, [{ threadId: original.threadId, includeTurns: true }]);
    assert.equal(f.state().nextTurnId, 2, "recovery never replays the turn");
  }
});

test("an unresolved transport failure stays blocked until explicit exact-turn cancel is confirmed", () => {
  const f = fixture("lost-turn:inProgress"), original = loseTurn(f);
  const changeServer = patch => fs.writeFileSync(path.join(f.dir, "fake-codex-state.json"), JSON.stringify({ ...f.state(), ...patch }));
  const status = () => directJson(f.call("status", original.id, "--json"));
  assert.equal(status().job.turnResolution, "in_progress");
  const blocked = directJson(f.call("task", "--continue", original.id, "--direct", "follow up"));
  assert.equal(blocked.status, "blocked");
  assert.ok(blocked.blockers[0].cancelCommand);
  const blocker = directJson(f.call("result", blocked.jobId, "--details")).blockers[0];
  const observe = run("/bin/sh", ["-c", blocker.recoveryCommand], { cwd: f.repo, env: f.env });
  assert.equal(directJson(observe).job.turnResolution, "in_progress");
  assert.equal(f.state().nextTurnId, 2);
  assert.equal(f.state().lastInterrupt, null);

  changeServer({ unreachable: true });
  const cancel = () => run("/bin/sh", ["-c", blocker.cancelCommand], { cwd: f.repo, env: f.env });
  const offline = f.call("cancel", original.agentName, "--json");
  assert.equal(offline.status, 2, offline.stderr + offline.stdout);
  assert.equal(directJson(offline).confirmation, "unconfirmed");
  assert.match(directJson(offline).detail, /unreachable/);
  assert.deepEqual(storedFixtureJob(f, original.id).result, original.result);
  assert.equal(storedFixtureJob(f, original.id).turnResolution, "unknown");
  assert.equal(f.state().lastInterrupt, null);
  changeServer({ unreachable: false, unreadable: true });
  assert.equal(status().job.turnResolution, "unknown");
  changeServer({ unreadable: false, ignoreInterrupt: true });
  assert.equal(cancel().status, 2, "an interrupt acknowledgement alone must not release the thread");
  assert.equal(storedFixtureJob(f, original.id).turnResolution, "in_progress");
  changeServer({ ignoreInterrupt: false });
  const stopped = cancel();
  assert.equal(stopped.status, 0, stopped.stderr + stopped.stdout);
  assert.equal(directJson(stopped).confirmation, "confirmed");
  const saved = storedFixtureJob(f, original.id);
  assert.equal(saved.status, "interrupted");
  assert.equal(saved.turnResolution, "interrupted");
  assert.equal(saved.recovery.originalError, original.errorMessage);
  assert.equal(saved.recovery.interruptRequested, true);
  assert.deepEqual(f.state().lastInterrupt, { threadId: original.threadId, turnId: original.turnId });
  assert.equal(f.state().lastThreadResume.threadId, original.threadId);
  const followup = f.call("task", "--to", original.agentName, "--direct", "follow up");
  assert.equal(followup.status, 0, followup.stderr + followup.stdout);
  assert.equal(directJson(followup).status, "completed");
  assert.equal(f.state().nextTurnId, 3);

  // A worker-reported failure, even with the old diagnostic as its text, is
  // terminal and must never be overwritten by a server read.
  const workerFailure = { status: 1, error: "Codex broker connection closed during startup.", turnEnded: true, workerStatus: "failed" };
  storedFixtureJob(f, original.id, { status: "failed", recovered: false, result: workerFailure });
  const reads = f.state().turnReads.length;
  status();
  assert.equal(f.state().turnReads.length, reads);
  assert.deepEqual(storedFixtureJob(f, original.id).result, workerFailure);

  const startup = fixture("lost-turn:startup");
  const start = startup.call("task", "--report", "--json", "fixture startup");
  assert.equal(start.status, 1);
  const startId = /Job handle: ([^;]+)/.exec(start.stderr)[1];
  const startJob = storedFixtureJob(startup, startId);
  assert.ok(!startJob.turnId);
  assert.equal(startJob.result.failureSource, "transport");
  assert.match(startJob.errorMessage, /connection closed during startup/);
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
    const compact = directJson(response);
    const report = directJson(f.call("result", compact.jobId, "--details"));
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
  assert.equal(JSON.parse(restored.stdout).summary, fs.readFileSync(report.rawOutputFile, "utf8").trim().slice(0, 8000));
  const legacy = JSON.parse(f.call("result", report.jobId, "--json").stdout);
  assert.deepEqual(legacy.storedJob.report, report);
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

test("declared blockers override completed while failures and essential questions retain their outcomes", () => {
  for (const declaredStatus of ["blocked", "completed"]) {
    const f = fixture("structured-blocked");
    if (declaredStatus === "completed") {
      const binary = path.join(f.dir, "codex");
      fs.writeFileSync(binary, fs.readFileSync(binary, "utf8").replace('status: "blocked", summary:', 'status: "completed", summary:'));
    }
    const response = f.call("task", "--direct", "install the dependency");
    assert.equal(response.status, 2, response.stderr);
    const report = directJson(response), details = directJson(f.call("result", report.jobId, "--details"));
    assert.equal(report.status, "blocked"); assert.equal(details.declaredStatus, declaredStatus);
    assert.deepEqual(report.blockers, [{ code: "missing_dependency", message: "fixture-dep is not installed" }]);
    assert.equal(JSON.parse(f.call("status", report.jobId, "--json").stdout).job.status, "blocked");
    const payload = directJson(f.call("result", report.jobId, "--json")).storedJob.result;
    assert.equal(buildWorkerReport({ ...payload, status: 1 }).status, "failed");
    const essential = buildWorkerReport({ ...payload, structured: { ...payload.structured, status: declaredStatus, blockers: [], question: "Which branch?" } });
    assert.equal(essential.status, "needs_input"); assert.equal(essential.declaredStatus, declaredStatus);
    assert.equal(essential.question, "Which branch?");
    if (declaredStatus === "completed") {
      const saved = storedFixtureJob(f, report.jobId);
      const { declaredStatus: oldDeclaration, ...oldReport } = saved.report;
      storedFixtureJob(f, report.jobId, { status: "completed", report: { ...oldReport, status: "completed" } });
      for (const command of [["result", report.jobId], ["wait", report.jobId, "--direct"], ["result", report.jobId, "--details"]]) {
        const observed = f.call(...command);
        assert.equal(observed.status, 2); assert.equal(directJson(observed).status, "blocked", "older stored reports cannot claim completed with blockers");
      }
      assert.equal(directJson(f.call("result", report.jobId, "--details")).declaredStatus, "completed");
      const question = "Which branch should receive the legacy fix?";
      storedFixtureJob(f, report.jobId, { report: { ...oldReport, status: "completed", blockers: [] },
        result: { ...saved.result, structured: { ...saved.result.structured, blockers: [], question } } });
      for (const command of [["result", report.jobId], ["wait", report.jobId, "--direct"], ["result", report.jobId, "--details"]]) {
        const observed = f.call(...command), recovered = directJson(observed);
        assert.equal(observed.status, 2); assert.equal(recovered.status, "needs_input");
        assert.equal(typeof recovered.question === "string" ? recovered.question : recovered.question.text, question);
      }
    }
  }
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
  const recovered = f.call("result", first.jobId, "--details");
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(JSON.parse(recovered.stdout).turnId, first.turnId);
  assert.equal(JSON.parse(recovered.stdout).fileTrackingStatus, "partial");
  assert.equal(JSON.parse(recovered.stdout).sandbox, "danger-full-access", "the recovered report keeps the sandbox the job actually ran with");
  assert.equal(JSON.parse(f.call("result", "--thread", first.threadId, "--details").stdout).turnId, second.turnId);
  assert.equal(f.state().nextTurnId, 3, "recovery must not submit a third turn");

  // A missing reply cannot claim a foreign turn, including one whose wrapper
  // died. Incomplete records and two same-second starts remain unconfirmed.
  const attribution = fixture("lost-turn:inProgress");
  attribution.env.CODEX_COMPANION_HOME = path.join(attribution.dir, "isolated");
  const victim = loseTurn(attribution);
  const other = path.join(attribution.dir, "other"); fs.mkdirSync(other); initGitRepo(other);
  const seeded = run(process.execPath, ["--input-type=module", "-e", `
    import fs from "node:fs";
    import path from "node:path";
    import { writeJobFile, upsertJob, resolveStateFile, resolveStateRoot } from ${JSON.stringify(stateModule)};
    import { recordedThreadJobs } from ${JSON.stringify(new URL("../plugins/codex/scripts/lib/job-runtime.mjs", import.meta.url).href)};
    const cwd = ${JSON.stringify(other)}, job = { ...${JSON.stringify(victim)}, id: "foreign-owner", workspaceRoot: cwd, pid: null };
    const file = writeJobFile(cwd, job.id, job); upsertJob(cwd, job);
    // Metadata-only workspaces and damaged private records indexed on other
    // threads must not make every handle-less recovery ambiguous.
    const root = resolveStateRoot(), empty = path.join(root, "empty"), unrelated = path.join(root, "unrelated");
    fs.mkdirSync(path.join(empty, "jobs"), { recursive: true });
    fs.writeFileSync(path.join(empty, "jobs", "old.result.json"), "{}");
    fs.mkdirSync(path.join(root, "broker-only"));
    fs.mkdirSync(path.join(unrelated, "jobs"), { recursive: true });
    const elsewhere = { id: "elsewhere", workspaceRoot: cwd, threadId: "another-thread" };
    fs.writeFileSync(path.join(unrelated, "state.json"), JSON.stringify({ jobs: [elsewhere, { ...elsewhere, id: "missing" }] }));
    fs.writeFileSync(path.join(unrelated, "jobs", "elsewhere.json"), "{");
    fs.writeFileSync(path.join(unrelated, "jobs", "orphan.json"), JSON.stringify({ ...elsewhere, id: "orphan" }));
    console.log(JSON.stringify({ file, index: resolveStateFile(cwd), complete: recordedThreadJobs(job.threadId).complete }));
  `], { cwd: attribution.repo, env: attribution.env });
  assert.equal(seeded.status, 0, seeded.stderr);
  const files = JSON.parse(seeded.stdout), originalIndex = fs.readFileSync(files.index), originalJob = fs.readFileSync(files.file);
  assert.equal(files.complete, true);
  const requestsFile = path.join(attribution.dir, "fake-codex-state.json.requests.jsonl");
  for (const status of ["completed", "inProgress"]) {
    for (const damage of ["readable", "missing-index", "malformed-index", "unreadable-index", "missing-job", "malformed-job", "unreadable-job", "orphan-job", "mismatched-turn", "two-missing"]) {
      storedFixtureJob(attribution, victim.id, { ...victim, turnId: null, recovered: false, recovery: null,
        result: { ...victim.result, turnId: null } });
      const state = attribution.state(); state.threads[0].turns[0].status = status;
      fs.writeFileSync(path.join(attribution.dir, "fake-codex-state.json"), JSON.stringify(state));
      const target = damage.endsWith("index") ? files.index : files.file;
      if (damage.startsWith("missing")) fs.unlinkSync(target);
      if (damage.startsWith("malformed")) fs.writeFileSync(target, "{");
      if (damage.startsWith("unreadable")) fs.chmodSync(target, 0);
      if (damage === "orphan-job") fs.writeFileSync(files.index, JSON.stringify({ ...JSON.parse(originalIndex), jobs: [] }));
      if (damage === "mismatched-turn") fs.writeFileSync(files.file, JSON.stringify({ ...JSON.parse(originalJob), turnId: "other-turn" }));
      if (damage === "two-missing") {
        const owner = JSON.parse(originalJob), index = JSON.parse(originalIndex);
        owner.turnId = null; index.jobs[0].turnId = null;
        fs.writeFileSync(files.file, JSON.stringify(owner)); fs.writeFileSync(files.index, JSON.stringify(index));
      }
      const offset = fs.readFileSync(requestsFile, "utf8").trim().split("\n").length;
      try {
        assert.equal(attribution.call("status", victim.id, "--json").status, 0);
        const saved = storedFixtureJob(attribution, victim.id);
        assert.equal(saved.turnId, null, `${status}/${damage}`);
        assert.equal(saved.recovered === true, damage === "readable", `${status}/${damage}`);
        const cancelled = attribution.call("cancel", victim.id, "--json"), report = JSON.parse(cancelled.stdout);
        assert.equal(cancelled.status, damage === "readable" ? 0 : 2, cancelled.stderr);
        assert.equal(report.confirmation, damage === "readable" ? "confirmed" : "unconfirmed");
        assert.equal(report.turnInterruptAttempted, false);
        const requests = fs.readFileSync(requestsFile, "utf8").trim().split("\n").slice(offset).map(JSON.parse);
        assert.equal(requests.some(request => ["turn/start", "turn/interrupt", "thread/backgroundTerminals/clean"].includes(request.method)), false);
      } finally {
        if (fs.existsSync(target)) fs.chmodSync(target, 0o600);
        fs.writeFileSync(files.index, originalIndex); fs.writeFileSync(files.file, originalJob);
      }
    }
  }
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
  const stored = storedFixtureJob(f, done.jobId);
  assert.equal(directLines(stdout).length - 1, stored.activity.length);
  assert.ok(stored.activity.length > 0);
  assert.equal(stored.leaseSec, 1800);
  assert.equal(stored.direct, true);
  assert.equal(stored.ownerId, json(f.call("result", done.jobId, "--details")).ownerId);
  assert.equal(stored.ownerDetachReason, "returned");
  assert.equal(stored.request.report, true);
  assert.equal(stored.request.detached, true);
  assert.doesNotMatch(JSON.stringify(done), /PRIVATE_FIXTURE/);
  const again = f.call("wait", done.jobId, "--owner", stored.ownerId, "--direct", "--details");
  const repeated = json(again);
  assert.equal(directLines(again.stdout).length, 1);
  assert.equal(repeated.activityCount, 0);
  assert.equal(repeated.turnId, stored.turnId);
  assert.equal(f.state().nextTurnId, 2);
});

test("direct questions provide executable re-wait and stdin-answer commands and preserve adoption", async () => {
  const f = fixture("w5-parent"), launch = json(f.call("task", "--detached", "--json", "--owner", "parent's owner", "fixture"));
  const compact = direct(f.call("wait", launch.jobId, "--owner", launch.ownerId, "--direct"));
  const pending = json(f.call("result", launch.jobId, "--details"));
  assert.equal(compact.next, `duet answer ${launch.agentName} --question '${pending.question.id}'`);
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
  assert.equal(moved.status, "ownership_moved"); assert.equal(job(f, launch.jobId).ownerId, adopted.ownerId);
  assert.equal(moved.waitCommand, undefined); assert.equal(moved.answerCommand, undefined);
  const replacement = directJson(f.call(...splitRawArgumentString(adopted.waitCommand).slice(2), "--details"));
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
  assert.equal(progress.length, storedFixtureJob(f, done.jobId).activity.filter(event => event.seq > cursor).length);
  for (const line of progress) assert.ok(Number(/^\[(\d+)\]/.exec(line)?.[1]) > cursor, "only new events are streamed");
  assert.equal(done.status, "completed"); assert.equal(job(f, done.jobId).turnId, pending.turnId);
});

test("report v2 is decision-first and bounded; result and wait details retain the full report", async () => {
  const usage = { inputTokens: 150, cachedInputTokens: 40, outputTokens: 30, reasoningOutputTokens: 10, totalTokens: 180 };
  for (const [behavior, status, code] of [["slow-task", "completed", 0], ["structured-blocked", "blocked", 2], ["question-only", "needs_input", 2], ["w5-parent", "needs_answer", 0], ["w5-working", "running", 0]]) {
    const f = fixture(behavior), output = f.call("task", "--direct", ...(status === "running" ? ["--timeout-sec", "1"] : []), "fixture");
    const result = direct(output, code);
    try {
      assert.equal(result.status, status);
      assert.deepEqual(Object.keys(result).slice(0, 4), ["status", "worker", "jobId", "summary"]);
      assert.deepEqual(Object.keys(result).slice(-2), ["next", "details"]);
      const { summary, ...envelope } = result;
      assert.ok(Buffer.byteLength(JSON.stringify(envelope)) <= 2000);
      assert.equal(result.details, `duet result '${result.jobId}' --details`);
      assert.equal(result.next, status === "completed" ? null : status === "needs_answer" ? `duet answer ${result.worker} --question '${result.question.id}'` : status === "running" ? `duet wait ${result.worker}` : `duet task --to ${result.worker}`);
      for (const key of ["waitCommand", "answerCommand", "answerAndWaitCommand", "rawOutputFile", "ownerId"]) assert.equal(Object.hasOwn(result, key), false);
      const details = json(f.call("result", result.jobId, "--details"), code);
      const reread = json(f.call("result", result.jobId), code);
      assert.equal(reread.status, result.status); assert.equal(reread.next, result.next);
      if (["running", "needs_answer"].includes(status)) {
        assert.ok(details.waitCommand);
        if (status === "needs_answer") {
          assert.deepEqual(Object.keys(result.question), ["id", "kind", "text", "options", "expiresInSec"]);
          assert.deepEqual(result.question.options, details.question.options);
          assert.ok(result.question.expiresInSec >= 0);
          assert.ok(details.answerCommand && details.answerAndWaitCommand);
        }
      } else {
        assert.deepEqual(result.usage, usage);
        assert.deepEqual(details.usage, usage);
        assert.deepEqual(storedFixtureJob(f, result.jobId).result.usage, usage);
        assert.deepEqual(Object.keys(result).slice(-3), ["usage", "next", "details"]);
        assert.equal(result.summary, fs.readFileSync(details.rawOutputFile, "utf8").trim());
        assert.deepEqual(reread, result);
        const quiet = f.call("wait", result.jobId, "--direct", "--quiet");
        assert.deepEqual(direct(quiet, code), result);
        assert.equal(quiet.stdout, `${directLines(output.stdout).at(-1)}\n`);
        const legacy = json(f.call("wait", result.jobId, "--json"), code);
        const waited = json(f.call("wait", result.jobId, "--details"), code);
        assert.deepEqual(Object.keys(legacy).filter(key => !Object.hasOwn(waited, key)), [], "no 1.3 wait report keys disappear");
        for (const key of ["status", "reportFormat", "jobId", "threadId", "turnId", "exitCode", "sandbox", "approvalPolicy", "model", "effort", "serviceTier", "touchedFiles", "preExistingChanges", "fileTrackingStatus", "fileTrackingBasis", "verification", "verificationBasis", "keyFindings", "findingsBasis", "assumptions", "blockers", "question", "rawOutputFile", "resultFile", "ownerId", "sessionId"]) {
          assert.equal(Object.hasOwn(details, key), Object.hasOwn(legacy, key), key);
          assert.deepEqual(details[key], legacy[key], key);
        }
        assert.deepEqual(details.claimedVerification, legacy.claimedVerification ?? []);
        assert.deepEqual(result.checks?.ran ?? [], details.verification);
        assert.deepEqual(result.checks?.claimed ?? [], details.claimedVerification);
        if (status !== "completed") {
          assert.match(details.continuationCommand, / --direct$/);
          assert.equal(legacy.continuationCommand, details.continuationCommand);
          assert.equal(json(f.call("adopt", result.jobId, "--json"), 2).continuationCommand, details.continuationCommand);
        }
      }
    } finally {
      if (["running", "needs_answer"].includes(status)) f.call("cancel", result.jobId, "--json");
    }
  }
  const f = fixture("review-ok");
  const first = direct(f.call("task", "--direct", "fixture"));
  assert.deepEqual(first.usage, usage, "usage sums both requests, including the update before turn/start responds");
  const threadId = storedFixtureJob(f, first.jobId).threadId;
  const follow = direct(f.call("task", "--thread", threadId, "--direct", "fixture"));
  assert.deepEqual(follow.usage, usage, "follow-ups report the whole turn's delta from cumulative thread totals");
  assert.deepEqual(json(f.call("result", follow.worker, "--details")).usage, usage);
  assert.deepEqual(storedFixtureJob(f, follow.jobId).result.usage, usage);
  assert.equal(Object.hasOwn(directReport({ status: "completed", summary: "Completed." }), "usage"), false);

  const patchRuntime = (f, marker, replacement) => {
    const binary = path.join(f.dir, "codex"), source = fs.readFileSync(binary, "utf8");
    assert.ok(source.includes(marker)); fs.writeFileSync(binary, source.replace(marker, replacement));
  };
  const requests = f => fs.readFileSync(path.join(f.dir, "fake-codex-state.json.requests.jsonl"), "utf8")
    .trim().split("\n").map(line => JSON.parse(line));
  // Lose turn/start's reply, both with and without an actually started turn.
  // Admission itself must recover the missing handle before sending new work.
  for (const active of [true, false]) {
    const lost = fixture("lost-turn:inProgress");
    const marker = "const turnId = nextTurnId(state);\n        thread.updatedAt = now();";
    patchRuntime(lost, marker, `${marker}
      if (turnId === "turn_1") {
        thread.turns = ${active ? "[buildTurn(turnId)]" : "[]"};
        saveState(state); process.exit(0);
      }
    `);
    const failed = lost.call("task", "--fresh", "--report", "--sandbox", "read-only", "--json", "fixture");
    assert.equal(failed.status, 1);
    const id = /Job handle: ([^;]+)/.exec(failed.stderr)?.[1]; assert.ok(id);
    const original = storedFixtureJob(lost, id);
    assert.ok(original.threadId && !original.turnId);
    assert.equal(original.result.failureSource, "transport");
    const offset = requests(lost).length;
    const next = direct(lost.call("task", "--thread", original.threadId, "--direct", "fixture"), active ? 2 : 0);
    const admission = requests(lost).slice(offset);
    assert.ok(admission.some(r => r.method === "thread/read" && r.params.includeTurns));
    const recovered = storedFixtureJob(lost, id);
    assert.equal(recovered.recovery.source, "thread/read");
    if (active) {
      assert.equal(next.status, "blocked"); assert.equal(next.blockers[0].code, "thread_busy");
      assert.ok(next.blockers[0].cancelCommand);
      assert.equal(recovered.turnId, "turn_1");
      assert.equal(admission.some(r => r.method === "turn/start"), false);
      const cancelled = json(run("/bin/sh", ["-c", next.blockers[0].cancelCommand], { cwd: lost.repo, env: lost.env }));
      assert.equal(cancelled.confirmation, "confirmed");
      assert.equal(direct(lost.call("task", "--thread", original.threadId, "--direct", "fixture")).status, "completed");
    } else {
      assert.equal(next.status, "completed");
      assert.equal(recovered.recovered, true); assert.equal(recovered.status, "failed");
      assert.equal(recovered.turnResolution, "notStarted");
      assert.ok(admission.findIndex(r => r.method === "thread/read") < admission.findIndex(r => r.method === "turn/start"));
    }
  }

  // A private retry starts a fresh approval lifetime after a busy shared broker.
  const retry = fixture("computer-use-requests");
  patchRuntime(retry, 'case "turn/start": {', `case "turn/start": {
    if (!state.busyRejected) {
      state.busyRejected = true; saveState(state);
      send({ id: message.id, error: { code: -32001, message: "Shared Codex broker is busy." } }); break;
    }
  `);
  const broker = await readyBroker(retry.repo, retry.env);
  let pending;
  try {
    pending = direct(retry.call("task", "--fresh", "--direct", "fixture"));
    assert.equal(pending.status, "needs_answer"); assert.equal(pending.question.kind, "approval");
    assert.equal(retry.state().appServerStarts, 2);
    const saved = storedFixtureJob(retry, pending.jobId);
    json(run(process.execPath, [script, "answer", saved.id, "--owner", saved.ownerId, "--question", pending.question.id, "--json"],
      { cwd: retry.repo, env: retry.env, input: "task" }));
    assert.equal(direct(retry.call("wait", saved.id, "--owner", saved.ownerId, "--direct", "--quiet")).status, "completed");
    assert.equal(fs.existsSync(path.join(retry.env.CODEX_COMPANION_HOME, "computer-use", "sessions", `${saved.threadId}.toml`)), false);
  } finally {
    if (pending) retry.call("cancel", pending.jobId, "--json");
    broker.close();
  }
});

test("v2 budgets UTF-8 text and counts omitted files/checks while details keeps expanded lists", () => {
  const cwd = makeTempDir(), id = "long-structured-report", createdAt = new Date().toISOString();
  const entries = ["\x1b[31mLong finding\x1b[0m\n" + "detail ".repeat(80).trimEnd(), "字".repeat(2100), ...Array.from({ length: 28 }, (_, i) => `Entry ${i}\nwith details`)];
  const structured = parseStructuredReport(JSON.stringify({ status: "completed", summary: "Completed the work. " + "字".repeat(9000), key_findings: entries, assumptions: entries, verification: entries, blockers: [], question: null }));
  const result = { status: 0, structured, rawOutput: structured.summary, touchedFiles: entries,
    commandExecutions: entries.map(command => ({ command, exitCode: 0, status: "completed" })) };
  const report = buildWorkerReport(result, { jobId: id });
  const record = { id, workspaceRoot: cwd, jobClass: "task", status: "completed", createdAt, result, report,
    activity: Array.from({ length: 75 }, (_, i) => ({ seq: i + 1, type: "agentMessage", text: "\x1b[31mFixture\x1b[0m\n\r\u202e " + "details ".repeat(40) })) };
  writeJobFile(cwd, id, record); upsertJob(cwd, record);
  const output = run(process.execPath, [script, "wait", id, "--direct"], { cwd });
  const compact = direct(output);
  assert.equal(directLines(output.stdout).length, 76, "direct progress has no feed cap");
  assert.equal(compact.summary.length, 8000); assert.equal(compact.summaryTruncated, true);
  assert.equal(compact.details, `duet result '${id}' --details`, "unnamed jobs use the job ID");
  const { summary, ...envelope } = compact;
  assert.ok(Buffer.byteLength(JSON.stringify(envelope)) <= 2000);
  assert.equal(compact.changedFiles.length + compact.changedFilesOmitted, entries.length);
  assert.equal(compact.checks.ran.length + compact.checks.claimed.length + compact.checks.omitted, entries.length * 2);
  assert.deepEqual({ ...compact, details: `duet result '${id}' --cwd '${cwd}' --details` }, directReport(report, { ...record, result: { ...result,
    structured: { ...structured, keyFindings: entries.slice(0, 12), assumptions: entries.slice(0, 12) } } }), "expanded storage preserves compact v2");
  const full = json(run(process.execPath, [script, "wait", id, "--details"], { cwd }));
  const legacy = json(run(process.execPath, [script, "wait", id, "--json"], { cwd }));
  for (const key of ["keyFindings", "assumptions"]) {
    assert.deepEqual(full[key], entries.map(value => redactActivity(value).slice(0, 2000)), key);
    assert.ok(full[key][0].length > 300); assert.ok(full[key][0].includes("\n")); assert.equal(full[key][1].length, 2000);
    assert.deepEqual(legacy[key], report[key], "non-direct lists retain the report builder's bounds");
    assert.ok(legacy[key][0].length <= 300);
  }
  const expanded = entries.map(value => redactActivity(value).slice(0, 2000));
  const ran = result.commandExecutions.map(c => redactActivity(`${c.command}: exit ${c.exitCode}, ${c.status}`).slice(0, 2000));
  for (const details of [full, json(run(process.execPath, [script, "result", id, "--details"], { cwd }))]) {
    assert.deepEqual(details.touchedFiles, expanded);
    assert.deepEqual(details.verification, ran);
    assert.deepEqual(details.claimedVerification, expanded);
    assert.deepEqual(details.keyFindings, expanded);
    assert.deepEqual(details.assumptions, expanded);
    for (const key of ["touchedFilesOmitted", "verificationOmitted", "claimedVerificationOmitted", "keyFindingsOmitted", "assumptionsOmitted"]) assert.equal(details[key], 0);
  }
  const checks = Array.from({ length: 503 }, (_, i) => `Check ${i}`);
  const parsed = parseStructuredReport(JSON.stringify({ status: "completed", summary: "Completed.", verification: checks, key_findings: checks, assumptions: checks }));
  assert.deepEqual(parsed.verification, checks.slice(0, 500));
  assert.equal(parsed.verificationOmitted, 3);
  const largeResult = { ...result, touchedFiles: checks, structured: parsed, commandExecutions: checks.map(command => ({ command, exitCode: 0, status: "completed" })) };
  const largeRecord = { ...record, result: largeResult, report: buildWorkerReport(largeResult, { jobId: id }) };
  writeJobFile(cwd, id, largeRecord); upsertJob(cwd, largeRecord);
  const capped = json(run(process.execPath, [script, "result", id, "--details"], { cwd }));
  for (const key of ["touchedFiles", "verification", "claimedVerification", "keyFindings", "assumptions"]) {
    assert.equal(capped[key].length, 500);
    assert.equal(capped[`${key}Omitted`], 3);
  }
  const cappedCompact = json(run(process.execPath, [script, "result", id], { cwd }));
  assert.equal(cappedCompact.changedFiles.length + cappedCompact.changedFilesOmitted, checks.length);
  assert.equal(cappedCompact.checks.ran.length + cappedCompact.checks.claimed.length + cappedCompact.checks.omitted, checks.length * 2);
  assert.ok(legacy.assumptions.length <= 3); assert.ok(legacy.claimedVerification.length <= 3);
  const pending = directReport({ status: "needs_answer", jobId: id, question: { id: "q", text: "字".repeat(1000), options: Array(6).fill("字".repeat(160)), expiresAt: Date.now() + 10000 }, blockers: [{ code: "fixture", message: "字".repeat(500) }] });
  const { summary: pendingSummary, ...pendingEnvelope } = pending;
  assert.ok(Buffer.byteLength(JSON.stringify(pendingEnvelope)) <= 2000);
  assert.equal(pending.next, `duet answer ${id} --question 'q'`);
  for (const options of [Array(165).fill("12345678"), Array(500).fill(""), Array(500).fill("😀".repeat(80))]) {
    const question = { id: "question-'quoted", text: "Choose a scope.", options };
    const compact = directReport({ status: "needs_answer", jobId: id, question });
    const { summary, ...envelope } = compact;
    assert.ok(Buffer.byteLength(JSON.stringify(envelope)) <= 2000);
    assert.equal(compact.question.options.length + (compact.question.optionsOmitted ?? 0), options.length);
    assert.deepEqual(splitRawArgumentString(compact.next), ["duet", "answer", id, "--question", question.id]);
    assert.equal(question.options.length, options.length, "fitting leaves the full options intact");
  }
  const astral = "a".repeat(7999) + "😀";
  const unicode = directReport({ status: "completed", jobId: id, summary: astral });
  assert.equal(unicode.summary, astral.slice(0, 7999));
  assert.equal(unicode.summaryTruncated, true);
  const astralRecord = { ...record, result: { ...result, structured: { ...structured, summary: astral } } };
  writeJobFile(cwd, id, astralRecord);
  assert.equal(json(run(process.execPath, [script, "result", id, "--details"], { cwd })).summary, unicode.summary);
  const errorReport = buildWorkerReport({ status: 0, rawOutput: "Completed.", error: "Runtime error." });
  assert.equal(errorReport.status, "blocked");
  assert.equal(errorReport.blockers[0].code, "error");
  const recoveryCommand = "duet status predecessor --json";
  const busy = directReport({ status: "blocked", jobId: id, blockers: [{ code: "thread_busy", message: "Active predecessor.", recoveryCommand }] });
  assert.equal(busy.blockers[0].recoveryCommand, recoveryCommand);
});

test("report commands resolve ambiguous, cross-workspace and adopted workers through the duet CLI", t => {
  const cwd = makeTempDir();
  const records = ["first", "second"].map((id, i) => ({ id, workspaceRoot: cwd, jobClass: "task", agentName: "SharedWorker", threadId: `thread-${id}`,
    sessionId: "command-session", status: "needs_input", createdAt: `2026-10-23T00:00:0${i}Z`,
    report: { status: "needs_input", jobId: id, question: "Which branch?" } }));
  const save = record => { writeJobFile(cwd, record.id, record); upsertJob(cwd, record); };
  const read = id => json(run(process.execPath, [script, "result", id], { cwd, env: { CODEX_COMPANION_SESSION_ID: "command-session" } }), 2);
  records.forEach(save);
  const ambiguousLocal = run(process.execPath, [script, "status", "SharedWorker", "--json"], { cwd, env: { CODEX_COMPANION_SESSION_ID: "command-session" } });
  assert.equal(ambiguousLocal.status, 1);
  assert.match(ambiguousLocal.stderr, /ambiguous name across threads/);
  for (const { id } of records) assert.ok(ambiguousLocal.stderr.includes(`jobId=${id} |`));
  for (const { id } of records) {
    const report = read(id);
    assert.equal(report.worker, "SharedWorker");
    assert.equal(report.next, `duet task --to ${id}`);
    assert.equal(report.details, `duet result '${id}' --details`);
    const recovered = json(run(process.execPath, [script, ...splitRawArgumentString(report.details).slice(1)], { cwd }), 2);
    assert.equal(recovered.jobId, id);
  }
  save({ ...records[1], threadId: records[0].threadId });
  assert.equal(read("first").details, "duet result 'first' --details");
  assert.equal(read("first").next, "duet task --to first");
  assert.equal(read("second").details, "duet result 'second' --details");
  assert.equal(read("second").next, "duet task --to SharedWorker");

  const f = fixture("review-ok"), other = path.join(f.dir, "other-workspace");
  fs.mkdirSync(other); initGitRepo(other);
  f.env.PATH = `${path.dirname(new URL("../plugins/codex/bin/duet", import.meta.url).pathname)}${path.delimiter}${f.env.PATH}`;
  const execute = (command, cwd = f.repo) => run("sh", ["-c", command], { cwd, env: f.env, input: "Complete the fixture follow-up." });
  const workers = [f.repo, other].map(workspace => {
    const launched = direct(execute("duet task --fresh", workspace));
    const fixture = { ...f, repo: workspace };
    const original = storedFixtureJob(fixture, launched.jobId);
    storedFixtureJob(fixture, launched.jobId, { agentName: "AcrossWorker", status: "needs_input", report: { ...original.report, status: "needs_input" } });
    return { fixture, original };
  });
  for (const { original } of workers) {
    const projected = json(execute(`duet result ${original.id}`), 2);
    assert.equal(projected.worker, "AcrossWorker");
    const cwdFlag = original.workspaceRoot === f.repo ? "" : ` --cwd '${original.workspaceRoot}'`;
    assert.equal(projected.details, `duet result '${original.id}'${cwdFlag} --details`);
    assert.equal(projected.next, `duet task --to AcrossWorker${cwdFlag}`);
    assert.equal(json(execute(projected.details), 2).jobId, original.id);
    const continued = direct(execute(projected.next));
    assert.equal(continued.status, "completed");
    const details = json(execute(continued.details));
    assert.equal(details.threadId, original.threadId);
    assert.equal(json(execute(projected.details), 2).jobId, original.id, "saved details still selects the earlier job after a follow-up");
    assert.equal(continued.next, null);
  }
  const adopted = workers[0];
  storedFixtureJob(adopted.fixture, adopted.original.id, { agentName: "AdoptedWorker", status: "running", leaseExpiresAt: Date.now() + 180000 });
  const moved = json(run(process.execPath, [script, "adopt", adopted.original.id, "--json"], {
    cwd: f.repo, env: { ...f.env, CODEX_COMPANION_SESSION_ID: "replacement-session" }
  }));
  assert.equal(moved.adopted, true);
  storedFixtureJob(adopted.fixture, adopted.original.id, { status: "needs_input", report: { ...adopted.original.report, status: "needs_input" } });
  const dispatchProjection = json(execute(`duet result ${adopted.original.id}`), 2);
  f.env.CODEX_COMPANION_SESSION_ID = "replacement-session";
  const projected = json(execute(`duet result ${adopted.original.id}`), 2);
  assert.deepEqual(dispatchProjection, { ...projected, next: `duet task --to ${adopted.original.id}`,
    details: `duet result '${adopted.original.id}' --details` }, "foreign-session commands use exact job handles");
  assert.equal(projected.details, `duet result '${adopted.original.id}' --details`);
  assert.equal(projected.next, "duet task --to AdoptedWorker");
  assert.equal(json(execute(projected.details), 2).jobId, adopted.original.id);
  const continued = direct(execute(projected.next));
  assert.equal(continued.status, "completed");
  assert.equal(json(execute(continued.details)).threadId, adopted.original.threadId);
  assert.equal(continued.next, null);

  const sequence = fixture("parent-question-sequence");
  sequence.env.PATH = `${path.dirname(new URL("../plugins/codex/bin/duet", import.meta.url).pathname)}${path.delimiter}${sequence.env.PATH}`;
  const runSequence = command => run("sh", ["-c", command], { cwd: sequence.repo, env: sequence.env, input: "Small" });
  const firstQuestion = direct(runSequence("duet task --fresh"));
  const secondQuestion = direct(runSequence(firstQuestion.next));
  assert.equal(secondQuestion.status, "needs_answer");
  assert.notEqual(secondQuestion.question.id, firstQuestion.question.id);
  const replies = sequence.state().serverRequestReplies.length;
  for (const target of [firstQuestion.worker, firstQuestion.jobId]) {
    const stale = runSequence(`duet answer ${target} --question '${firstQuestion.question.id}'`);
    assert.notEqual(stale.status, 0);
    assert.equal(sequence.state().serverRequestReplies.length, replies);
    assert.equal(storedFixtureJob(sequence, firstQuestion.jobId).pendingQuestion.id, secondQuestion.question.id);
  }
  assert.equal(direct(runSequence(secondQuestion.next)).status, "completed");
  assert.equal(sequence.state().serverRequestReplies.length, replies + 1);

  // Reproduce pre-upgrade duplicate names: one completed worker and one real
  // pending question in another workspace, both in the same Claude session.
  const p = fixture("w5-parent"), remote = path.join(p.dir, "remote");
  fs.mkdirSync(remote); initGitRepo(remote);
  const duet = new URL("../plugins/codex/bin/duet", import.meta.url).pathname;
  const command = (...args) => run(duet, args, { cwd: p.repo, env: p.env, input: "Small" });
  const first = direct(command("task", "--fresh"));
  assert.equal(first.status, "needs_answer");
  assert.equal(direct(command("answer", first.jobId)).status, "completed");
  const ended = storedFixtureJob(p, first.jobId, { agentName: "Heisenberg" });
  const second = direct(command("task", "--fresh", "--cwd", remote));
  const remoteFixture = { ...p, repo: remote };
  const pending = storedFixtureJob(remoteFixture, second.jobId, { agentName: "Heisenberg" });
  assert.equal(second.status, "needs_answer");
  t.diagnostic(JSON.stringify({ scenario: "same-session legacy duplicate", candidates: [ended, pending].map(record => ({
    jobId: record.id, worker: record.agentName, status: record.status, pending: Boolean(record.pendingQuestion), cwd: record.workspaceRoot
  })) }));
  const resolverModule = new URL("../plugins/codex/scripts/lib/worker-resolve.mjs", import.meta.url).href;
  const resolveName = options => json(run(process.execPath, ["--input-type=module", "-e", `
    import { resolveWorkerTarget } from ${JSON.stringify(resolverModule)};
    console.log(JSON.stringify(resolveWorkerTarget(process.cwd(), "Heisenberg", ${JSON.stringify(options)}).job.id));
  `], { cwd: p.repo, env: p.env }));
  const before = p.state();
  assert.equal(resolveName({}), first.jobId, "a legacy name tie selects the caller's workspace");
  assert.equal(json(command("result", "Heisenberg")).jobId, first.jobId);
  const waited = direct(command("wait", "heisenberg"));
  assert.equal(waited.jobId, second.jobId); assert.equal(waited.status, "needs_answer");
  t.diagnostic(JSON.stringify({ command: "duet wait heisenberg", ...waited }));
  for (const status of ["queued", "running", "needs_answer"]) {
    storedFixtureJob(p, first.jobId, { status, pendingQuestion: { ...pending.pendingQuestion, id: "legacy-question" } });
    for (const options of [{ nameState: "pending", pending: true }, { nameState: "wait" }, { nameState: "cancel" }]) {
      assert.equal(resolveName(options), first.jobId);
    }
  }
  assert.equal(p.state().nextTurnId, before.nextTurnId, "resolving legacy names never dispatches");
  assert.equal(p.state().serverRequestReplies.length, before.serverRequestReplies.length, "resolving legacy names never submits an answer");
  assert.equal(storedFixtureJob(remoteFixture, second.jobId).pendingQuestion.answer, undefined);
  // An active job with an already-answered question fits wait but not answer.
  storedFixtureJob(p, first.jobId, { status: "running", pendingQuestion: { ...pending.pendingQuestion, id: "legacy-question", answer: "Already submitted" } });
  assert.equal(resolveName({ nameState: "wait" }), first.jobId);
  const answered = direct(command("answer", "heisenberg"));
  assert.equal(answered.jobId, second.jobId); assert.equal(answered.status, "completed");
  assert.equal(p.state().serverRequestReplies.length, before.serverRequestReplies.length + 1);
  t.diagnostic(JSON.stringify({ command: "duet answer heisenberg", ...answered }));
  storedFixtureJob(p, first.jobId, { status: "completed", pendingQuestion: null });
  const noQuestion = command("answer", "Heisenberg");
  assert.equal(noQuestion.status, 1); assert.match(noQuestion.stderr, /no pending unanswered question/);
  assert.equal(direct(command("wait", "Heisenberg")).jobId, first.jobId);
  assert.equal(direct(command("wait", first.jobId)).jobId, first.jobId, "explicit completed IDs still work");
  const third = direct(command("task", "--fresh", "--cwd", remote));
  const explicit = storedFixtureJob(remoteFixture, third.jobId, { agentName: "Heisenberg" });
  const explicitAnswer = direct(command("answer", "Heisenberg", "--question", explicit.pendingQuestion.id, "--owner", explicit.ownerId));
  assert.equal(explicitAnswer.jobId, third.jobId); assert.equal(explicitAnswer.status, "completed");
  t.diagnostic(JSON.stringify({ command: "duet answer Heisenberg --question <id> --owner <id>", ...explicitAnswer }));

  const busy = fixture("w5-parent");
  const launched = direct(busy.call("task", "--fresh", "--direct", "fixture"));
  const rejected = direct(busy.call("task", "--to", launched.worker, "--direct", "mistaken follow-up"), 2);
  assert.equal(rejected.blockers[0].code, "thread_busy");
  const active = direct(busy.call("wait", launched.worker, "--direct"));
  assert.equal(active.jobId, launched.jobId); assert.equal(active.status, "needs_answer");
  assert.equal(json(busy.call("cancel", launched.worker, "--json")).jobId, launched.jobId);
  json(run(process.execPath, ["--input-type=module", "-e", `
    import { writeJobFile, upsertJob } from ${JSON.stringify(stateModule)};
    const original = { id: "late-answer-active", workspaceRoot: process.cwd(), jobClass: "task", sessionId: "fixture-session",
      agentName: "LateAnswer", ownerId: "late-owner", threadId: "late-thread", turnId: "late-turn", status: "running", pid: ${process.pid},
      createdAt: "2026-01-01T00:00:00Z" };
    const refused = { ...original, id: "late-answer-refused", ownerId: "refused-owner", turnId: null, status: "blocked", pid: null,
      createdAt: "2026-01-02T00:00:00Z", result: { blockers: [{ code: "thread_busy" }] } };
    for (const record of [original, refused]) { writeJobFile(process.cwd(), record.id, record); upsertJob(process.cwd(), record); }
    console.log("{}");
  `], { cwd: busy.repo, env: busy.env }));
  const late = run(process.execPath, [script, "answer", "LateAnswer", "--question", "old-question", "--owner", "late-owner", "--direct"],
    { cwd: busy.repo, env: busy.env, input: "Small" });
  assert.equal(late.status, 1); assert.match(late.stderr, /Question is no longer pending/);

  const names = fixture("w5-parent");
  const resident = direct(names.call("task", "--fresh", "--direct", "fixture"));
  const answer = id => direct(run(process.execPath, [script, "answer", id, "--direct"], { cwd: names.repo, env: names.env, input: "Small" }));
  names.env.CODEX_COMPANION_SESSION_ID = "foreign-session";
  const incoming = direct(names.call("task", "--fresh", "--direct", "fixture"));
  const foreign = storedFixtureJob(names, incoming.jobId, { agentName: resident.worker });
  names.env.CODEX_COMPANION_SESSION_ID = "fixture-session";
  const adoptedName = json(names.call("adopt", incoming.jobId, "--json"));
  assert.equal(adoptedName.adopted, true); assert.equal(adoptedName.jobId, incoming.jobId);
  assert.notEqual(adoptedName.agentName.toLowerCase(), resident.worker.toLowerCase());
  assert.equal(storedFixtureJob(names, incoming.jobId).threadId, foreign.threadId);
  assert.equal(answer(adoptedName.agentName).jobId, incoming.jobId);
  names.env.CODEX_COMPANION_SESSION_ID = "third-session";
  const completedForeign = direct(names.call("task", "--fresh", "--direct", "fixture"));
  answer(completedForeign.jobId);
  const threadSource = storedFixtureJob(names, completedForeign.jobId, { agentName: resident.worker });
  names.env.CODEX_COMPANION_SESSION_ID = "fixture-session";
  const broughtIn = direct(names.call("task", "--thread", threadSource.threadId, "--direct", "fixture"));
  assert.equal(broughtIn.status, "needs_answer");
  assert.notEqual(broughtIn.worker.toLowerCase(), resident.worker.toLowerCase());
  assert.equal(storedFixtureJob(names, broughtIn.jobId).threadId, threadSource.threadId);
  answer(broughtIn.worker); answer(resident.worker);

  for (const [session, workspaceBytes] of [["other-session", null], ["", null], ["other-session", 875], ["", 950]]) {
    const scoped = fixture("review-ok");
    let remote = path.join(scoped.dir, "quoted ' workspace");
    while (workspaceBytes && Buffer.byteLength(remote) < workspaceBytes) remote = path.join(remote, "w".repeat(Math.min(180, workspaceBytes - Buffer.byteLength(remote) - 1)));
    fs.mkdirSync(remote, { recursive: true }); initGitRepo(remote);
    scoped.env.PATH = f.env.PATH;
    if (!session) scoped.env.CODEX_COMPANION_SESSION_ID = "";
    const first = direct(scoped.call("task", "--fresh", "--direct", "--cwd", remote, "fixture"));
    const remoteFixture = { ...scoped, repo: remote }, saved = storedFixtureJob(remoteFixture, first.jobId);
    const outcome = workspaceBytes ? { status: "blocked", blockers: [{ code: "fixture_blocker", message: "Review needed before continuing." }],
      usage: { inputTokens: 100000, cachedInputTokens: 100000, outputTokens: 100000, reasoningOutputTokens: 100000, totalTokens: 300000 } } : { status: "needs_input" };
    storedFixtureJob(remoteFixture, first.jobId, { status: outcome.status, report: { ...saved.report, ...outcome } });
    scoped.env.CODEX_COMPANION_SESSION_ID = session;
    const report = json(scoped.call("result", first.jobId, "--cwd", remote), 2);
    const { summary, ...envelope } = report;
    assert.ok(Buffer.byteLength(JSON.stringify(envelope)) <= 2000);
    const execute = command => run("sh", ["-c", command], { cwd: scoped.repo, env: scoped.env, input: "Follow up." });
    assert.equal(json(execute(report.details), 2).jobId, first.jobId);
    const resumed = direct(execute(report.next));
    assert.equal(json(execute(resumed.details)).threadId, saved.threadId);
  }

  for (const workspaceBytes of [875, 3000]) {
    const lost = fixture("lost-turn:inProgress");
    let remote = path.join(lost.dir, "quoted ' workspace");
    while (Buffer.byteLength(remote) < workspaceBytes) remote = path.join(remote, "w".repeat(Math.min(180, workspaceBytes - Buffer.byteLength(remote) - 1)));
    assert.equal(Buffer.byteLength(remote), workspaceBytes);
    // macOS PATH_MAX is 1024: project the 3 KB report path onto a real job in
    // a shorter workspace, then execute its compact commands against that job.
    const actualWorkspace = workspaceBytes === 875 ? remote : lost.repo;
    if (workspaceBytes === 875) { fs.mkdirSync(remote, { recursive: true }); initGitRepo(remote); }
    const remoteFixture = { ...lost, repo: actualWorkspace };
    const failed = direct(lost.call("task", "--fresh", "--direct", "--cwd", actualWorkspace, "--sandbox", "read-only", "fixture"), 1);
    const predecessor = storedFixtureJob(remoteFixture, failed.jobId);
    const refused = direct(lost.call("task", "--thread", predecessor.threadId, "--direct", "--cwd", actualWorkspace, "follow-up"), 2);
    assert.equal(refused.blockers[0].code, "thread_busy");
    const saved = storedFixtureJob(remoteFixture, refused.jobId);
    const quote = value => `'${value.replace(/'/g, `'"'"'`)}'`;
    const payload = { ...saved.report,
      usage: { inputTokens: 100000, cachedInputTokens: 100000, outputTokens: 100000, reasoningOutputTokens: 100000, totalTokens: 300000 },
      blockers: saved.report.blockers.map(blocker => ({ ...blocker,
        cancelCommand: blocker.cancelCommand.replace(`--cwd ${quote(actualWorkspace)}`, `--cwd ${quote(remote)}`),
        recoveryCommand: blocker.recoveryCommand.replace(`--cwd ${quote(actualWorkspace)}`, `--cwd ${quote(remote)}`)
      })) };
    storedFixtureJob(remoteFixture, refused.jobId, { report: payload });
    lost.env.PATH = `${path.dirname(duet)}${path.delimiter}${lost.env.PATH}`;
    lost.env.CODEX_COMPANION_SESSION_ID = "other-session";
    const project = payload => directReport(payload, { ...saved, workspaceRoot: remote, request: { ...saved.request, cwd: remote } }, lost.env);
    const execute = command => run("sh", ["-c", command], { cwd: lost.repo, env: lost.env });
    const report = project(payload), { summary, ...envelope } = report;
    assert.ok(Buffer.byteLength(JSON.stringify(envelope)) <= 2000);
    const beforeCancel = lost.requests().length;
    const cancelled = json(execute(report.blockers[0].cancelCommand));
    assert.equal(cancelled.jobId, predecessor.id);
    assert.equal(cancelled.confirmation, "confirmed");
    assert.ok(lost.requests().slice(beforeCancel).some(request => request.method === "turn/interrupt"
      && request.params.threadId === predecessor.threadId && request.params.turnId === predecessor.turnId));
    const stillRefused = storedFixtureJob(remoteFixture, refused.jobId);
    assert.equal(stillRefused.status, "blocked");
    assert.ok(!stillRefused.cancelRequested);
    assert.equal(json(execute(report.details), 2).blockers[0].cancelCommand, payload.blockers[0].cancelCommand);

    if (workspaceBytes === 3000) {
      const legacy = { ...payload, blockers: payload.blockers.map(({ predecessorJobId, ...blocker }) => blocker) };
      storedFixtureJob(remoteFixture, refused.jobId, { report: legacy });
      const compact = project(legacy), { summary, ...envelope } = compact;
      assert.ok(Buffer.byteLength(JSON.stringify(envelope)) <= 2000);
      assert.equal(Object.hasOwn(compact.blockers[0], "cancelCommand"), false);
      const details = json(execute(compact.details), 2);
      for (const key of ["cancelCommand", "recoveryCommand"]) assert.equal(details.blockers[0][key], legacy.blockers[0][key]);
    }
  }
});

test("direct tasks preserve lease precedence, input forms, run settings and continuation inheritance", async () => {
  const f = fixture("slow-task"); f.env.CODEX_COMPANION_LEASE_SEC = "27";
  const promptFile = path.join(f.repo, "prompt.txt"); fs.writeFileSync(promptFile, "fixture from prompt file");
  const firstOutput = f.call("task", "--direct", "--quiet", "--fresh", "--prompt-file", promptFile, "--model", "spark", "--effort", "high", "--fast", "--write", "--sandbox", "workspace-write", "--approve-browser-origin", "https://example.com", "--approve-computer-app", "com.apple.TextEdit", "--owner", "explicit-owner", "--question-timeout-sec", "42", "--cwd", f.repo);
  const first = direct(firstOutput);
  assert.equal(directLines(firstOutput.stdout).length, 1, "task --direct --quiet prints just its JSON");
  const observed = f.call("wait", first.jobId, "--direct");
  assert.deepEqual(direct(observed), first);
  assert.equal(`${directLines(observed.stdout).at(-1)}\n`, firstOutput.stdout, "quiet and streaming task payloads are byte-identical for the same job");
  const firstDetails = json(f.call("result", first.jobId, "--details"));
  assert.ok(AGENT_NAMES.includes(first.worker));
  assert.equal(job(f, first.jobId).agentName, first.worker);
  assert.equal(job(f, first.jobId).leaseSec, 27); assert.equal(firstDetails.ownerId, "explicit-owner");
  assert.equal(firstDetails.model, "gpt-5.3-codex-spark"); assert.equal(firstDetails.effort, "high"); assert.equal(firstDetails.serviceTier, "priority");
  assert.equal(job(f, first.jobId).questionTimeoutSec, 42);
  assert.match(f.state().lastTurnStart.prompt, /fixture from prompt file/);
  const continued = direct(run(process.execPath, [script, "task", "--continue", first.jobId, "--direct", "--report", "--lease-sec", "39"], { cwd: f.repo, env: f.env, input: "fixture from stdin" }));
  assert.equal(job(f, continued.jobId).leaseSec, 39); const continuedDetails = json(f.call("result", continued.jobId, "--details"));
  assert.equal(continuedDetails.threadId, firstDetails.threadId);
  for (const key of ["agentName", "sandbox", "model", "effort", "serviceTier", "approvedBrowserOrigins", "approvedComputerApps"]) assert.deepEqual(continuedDetails[key], firstDetails[key], key);
  assert.match(f.state().lastTurnStart.prompt, /fixture from stdin/);
  const threaded = direct(f.call("task", "--direct", "--thread", firstDetails.threadId, "--normal", "fixture next turn"));
  assert.equal(threaded.worker, first.worker);
  assert.equal(job(f, threaded.jobId).agentName, first.worker);
  const threadedDetails = json(f.call("result", threaded.jobId, "--details"));
  assert.equal(threadedDetails.threadId, firstDetails.threadId); assert.equal(threadedDetails.serviceTier, null);

  const retained = fixture("review-ok");
  const older = direct(retained.call("task", "--fresh", "--direct", "--sandbox", "danger-full-access", "--effort", "high", "fixture"));
  const anchor = direct(retained.call("task", "--to", older.worker, "--direct", "--sandbox", "read-only", "--effort", "low", "--dispatch-nonce", "retained-dispatch", "fixture"));
  const threadId = storedFixtureJob(retained, anchor.jobId).threadId;
  const mutate = (f, code) => json(run(process.execPath, ["--input-type=module", "-e", `
    import { updateState, updateJob, listJobs } from ${JSON.stringify(stateModule)};
    ${code}
    console.log(JSON.stringify(listJobs(process.cwd())));
  `], { cwd: f.repo, env: f.env }));
  const flood = count => `updateState(process.cwd(), state => state.jobs.push(...Array.from({ length: ${count} }, (_, i) => ({
    id: "filler-" + i, threadId: "filler-thread-" + i, status: "completed", jobClass: "task", result: { turnEnded: true },
    sessionId: "fixture-session", createdAt: new Date(Date.now() + i + 1).toISOString(), updatedAt: new Date(Date.now() + i + 1).toISOString()
  }))));`;
  mutate(retained, `updateJob(process.cwd(), ${JSON.stringify(older.jobId)}, () => ({ activityCursors: { observer: 1 } }));`);
  const indexed = mutate(retained, flood(55));
  assert.ok(indexed.some(record => record.id === anchor.jobId));
  const visible = json(retained.call("status", "--all", "--json"));
  assert.equal(visible.recent.length + 1, 50);
  assert.ok(!visible.recent.some(record => record.id === anchor.jobId));
  mutate(retained, `updateState(process.cwd(), state => state.jobs.push({ id: "foreign-nonce", threadId: "foreign-thread", jobClass: "task",
    sessionId: "another-session", dispatchNonce: "retained-dispatch", status: "completed", result: { turnEnded: true }, createdAt: new Date().toISOString() }));`);
  const nonce = json(retained.call("status", "--all", "--json", "--dispatch-nonce", "retained-dispatch"));
  assert.deepEqual([...nonce.running, nonce.latestFinished, ...nonce.recent].filter(Boolean).map(record => record.id), [anchor.jobId]);
  const resumed = direct(retained.call("task", "--thread", threadId, "--direct", "fixture"));
  const settings = storedFixtureJob(retained, resumed.jobId).request;
  assert.deepEqual([settings.sandbox, settings.effort], ["read-only", "low"]);
  mutate(retained, `updateState(process.cwd(), state => { state.jobs = state.jobs.filter(job => job.threadId !== ${JSON.stringify(threadId)}); });`);
  const turns = retained.state().nextTurnId;
  const unknown = direct(retained.call("task", "--thread", threadId, "--direct", "fixture"), 2);
  assert.equal(unknown.blockers[0].code, "thread_settings_unknown");
  assert.equal(retained.state().nextTurnId, turns);
  assert.equal(direct(retained.call("task", "--thread", threadId, "--sandbox", "read-only", "--direct", "fixture")).status, "completed");

  const lost = fixture("lost-turn:inProgress");
  const failed = direct(lost.call("task", "--fresh", "--direct", "--sandbox", "read-only", "fixture"), 1);
  const original = storedFixtureJob(lost, failed.jobId);
  storedFixtureJob(lost, failed.jobId, { completedAt: "2000-01-01T00:00:00.000Z" });
  assert.ok(mutate(lost, flood(210)).some(record => record.id === failed.jobId));
  const retentionModule = new URL("../plugins/codex/scripts/lib/retention.mjs", import.meta.url).href;
  const afterRetention = mutate(lost, `import { planRetention, applyRetention } from ${JSON.stringify(retentionModule)};
    const result = await applyRetention(planRetention({ days: 1 }));
    if (result.errors.length || result.jobsDeleted) throw new Error(JSON.stringify(result));`);
  assert.ok(afterRetention.some(record => record.id === failed.jobId));
  const blocked = direct(lost.call("task", "--thread", original.threadId, "--sandbox", "read-only", "--direct", "fixture"), 2);
  assert.equal(blocked.blockers[0].code, "thread_busy");
  const beforeWait = lost.requests().length;
  assert.equal(direct(lost.call("wait", failed.worker, "--direct"), 1).jobId, failed.jobId);
  assert.ok(lost.requests().slice(beforeWait).some(request => request.method === "thread/read"));
  assert.equal(lost.state().nextTurnId, 2);

  const aliases = fixture("review-ok");
  const initial = direct(aliases.call("task", "--fresh", "--direct", "--sandbox", "read-only", "--model", "gpt-5.4", "--effort", "low", "--fast", "fixture"));
  const resumedThread = storedFixtureJob(aliases, initial.jobId).threadId;
  for (const flag of ["--resume", "--resume-last"]) {
    const follow = direct(aliases.call("task", flag, "--direct", "fixture"));
    const record = storedFixtureJob(aliases, follow.jobId);
    assert.equal(record.threadId, resumedThread);
    assert.deepEqual([record.request.sandbox, record.request.model, record.request.effort, record.request.serviceTier], ["read-only", "gpt-5.4", "low", "priority"]);
    assert.equal(aliases.state().lastTurnStart.sandboxPolicy.type, "readOnly");
  }
  mutate(aliases, `updateState(process.cwd(), state => { state.jobs = [{ id: "unknown-resume", jobClass: "task", status: "completed",
    sessionId: "fixture-session", threadId: ${JSON.stringify(resumedThread)}, result: { turnEnded: true }, createdAt: new Date().toISOString() }]; });`);
  const beforeUnknown = aliases.state().nextTurnId;
  for (const flag of ["--resume", "--resume-last"]) {
    assert.equal(direct(aliases.call("task", flag, "--direct", "fixture"), 2).blockers[0].code, "thread_settings_unknown");
  }
  assert.equal(aliases.state().nextTurnId, beforeUnknown);
  assert.equal(direct(aliases.call("task", "--resume-last", "--sandbox", "read-only", "--direct", "fixture")).status, "completed");

  const refused = fixture("w5-parent");
  const live = direct(refused.call("task", "--fresh", "--direct", "--sandbox", "read-only", "--effort", "low", "fixture"));
  const liveJob = storedFixtureJob(refused, live.jobId);
  const decline = () => new Promise((resolve, reject) => {
    const child = spawnOwned(process.execPath, [script, "task", "--thread", liveJob.threadId, "--sandbox", "danger-full-access", "--effort", "xhigh", "--direct", "--quiet", "fixture"],
      { cwd: refused.repo, env: refused.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject); child.on("close", status => { try { resolve(direct({ status, stdout, stderr }, 2)); } catch (error) { reject(error); } });
  });
  const attempts = await Promise.all([decline(), decline()]);
  for (const attempt of attempts) {
    assert.equal(storedFixtureJob(refused, attempt.jobId).report.blockers[0].predecessorJobId, live.jobId);
  }
  assert.equal(refused.state().nextTurnId, 2);
  const answer = id => direct(run(process.execPath, [script, "answer", id, "--direct"], { cwd: refused.repo, env: refused.env, input: "Small" }));
  answer(live.jobId);
  const checkFollow = (selector = ["--to", live.worker]) => {
    const follow = direct(refused.call("task", ...selector, "--direct", "fixture"));
    const stored = storedFixtureJob(refused, follow.jobId);
    assert.deepEqual([stored.request.sandbox, stored.request.effort], ["read-only", "low"]);
    assert.equal(refused.state().lastTurnStart.sandboxPolicy.type, "readOnly");
    answer(follow.jobId);
    return storedFixtureJob(refused, follow.jobId);
  };
  checkFollow();
  const started = checkFollow(["--continue", attempts[0].jobId]);
  const neverStarted = { ...started, id: "never-started", status: "failed", turnId: null, recovered: true,
    recovery: { turnStatus: "notStarted" }, result: { turnEnded: true }, report: { status: "failed" },
    createdAt: new Date(Date.now() + 1000).toISOString(), request: { ...started.request, sandbox: "danger-full-access", effort: "xhigh" } };
  mutate(refused, `import { writeJobFile, upsertJob } from ${JSON.stringify(stateModule)};
    const record = ${JSON.stringify(neverStarted)}; writeJobFile(process.cwd(), record.id, record); upsertJob(process.cwd(), record);`);
  checkFollow();
});
}
