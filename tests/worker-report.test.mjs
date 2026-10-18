import fs from "node:fs";
import path from "node:path";
import { spawnOwned as spawn } from "../plugins/codex/scripts/lib/process.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { buildWorkerReport, classifyWorkerOutcome, classifyBrowserBlocker, parseStructuredReport } from "../plugins/codex/scripts/lib/worker-report.mjs";
import { makeTempDir, run, initGitRepo } from "./helpers.mjs";
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

test("compact worker report is bounded, separates claims and preserves full output", () => {
  const f = fixture("verbose-task");
  const response = f.call("task", "--fresh", "--report", "--json", "investigate");
  assert.equal(response.status, 0, response.stderr);
  const report = JSON.parse(response.stdout);
  assert.equal(report.status, "completed");
  assert.ok(response.stdout.split("\n").length <= 60);
  assert.match(report.findingsBasis, /not independently verified/);
  assert.equal(fs.readFileSync(report.rawOutputFile, "utf8").split("\n").length, 300);
  assert.ok(JSON.parse(fs.readFileSync(report.resultFile)).rawOutput.includes("Finding 299"));
  assert.match(response.stderr, /Job handle: task-/);
  assert.match(response.stderr, /Thread handle: thr_/);
  assert.match(response.stderr, /Turn handle: turn_/);
  assert.match(f.state().lastTurnStart.prompt, /conservative assumptions/);
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
  assert.match(report.findingsBasis, /Declared by Codex/);
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
  assert.match(fs.readFileSync(report.rawOutputFile, "utf8"), /^Stopped: the fixture dependency is unavailable/);
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

for (const behavior of ["question-only", "unfinished-task"]) test(`${behavior} is needs_input, not success`, () => {
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
  assert.equal(report.touchedFilesOmitted, 31);
  assert.match(report.verification[0], /exit 1, failed/);
});

test("fully populated report stays within 60 lines including dirty paths and sandbox", () => {
  const report = buildWorkerReport({
    status: 0, rawOutput: "Status: needs_input\nAssumptions\nPending decision\nWhich target?\nMore context\nMore findings",
    touchedFiles: Array(40).fill("changed.js"), preExistingChanges: Array(30).fill("dirty.js"),
    commandExecutions: Array(10).fill({ command: "node --test", exitCode: 0, status: "completed" }),
    sandbox: "workspace-write", approvalPolicy: "never",
    fileTracking: { status: "complete", basis: "fixture snapshots" }
  });
  assert.equal(report.status, "needs_input");
  assert.equal(report.preExistingChangesOmitted, 27);
  assert.deepEqual(report.blockers, [{ code: "needs_input", message: "Which target?" }]);
  assert.ok(`${JSON.stringify(report, null, 2)}\n`.split("\n").length <= 60);
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
  assert.match(JSON.parse(recovered.stdout).fileTrackingBasis, /Recovered exact-turn/);
  assert.equal(JSON.parse(recovered.stdout).sandbox, "danger-full-access", "the recovered report keeps the sandbox the job actually ran with");
  assert.equal(JSON.parse(f.call("result", "--thread", first.threadId, "--report", "--json").stdout).turnId, second.turnId);
  assert.equal(f.state().nextTurnId, 3, "recovery must not submit a third turn");
});

test("early handle and heartbeat survive a killed wrapper; result recovers without rerun", async () => {
  const f = fixture("slow-recovery-task");
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
  await waitFor(() => f.state().threads[0].turns?.some(t => t.status === "completed"));
  const response = f.call("result", id, "--report", "--json");
  assert.equal(response.status, 0, response.stderr + response.stdout);
  assert.equal(JSON.parse(response.stdout).status, "completed");
  assert.equal(f.state().nextTurnId, 2);
  const status = JSON.parse(f.call("status", id, "--json").stdout);
  assert.equal(status.job.recovered, true);
  assert.match(fs.readFileSync(status.job.logFile, "utf8"), /Progress:.*items, .*tools;.*last activity/);
});
