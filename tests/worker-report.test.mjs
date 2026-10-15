import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { buildWorkerReport, classifyWorkerOutcome, classifyBrowserBlocker } from "../plugins/codex/scripts/lib/worker-report.mjs";
import { makeTempDir, run, initGitRepo } from "./helpers.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";

const script = new URL("../plugins/codex/scripts/codex-companion.mjs", import.meta.url).pathname;
const stateModule = new URL("../plugins/codex/scripts/lib/state.mjs", import.meta.url).href;
test("stale browser claims have a distinct blocker with the owning session ID", () => {
  const text = "Tab 123 is already part of browser session 00000000-0000-0000-0000-000000000001";
  const report = buildWorkerReport({ status: 0, rawOutput: text });
  assert.equal(report.status, "needs_input");
  assert.deepEqual(report.browserBlocker, { kind: "stale_browser_tab_claim", tabId: "123", sessionId: "00000000-0000-0000-0000-000000000001" });
  assert.match(report.blockers[0], /stale_browser_tab_claim.*00000000-0000-0000-0000-000000000001/);
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
  assert.equal(report.touchedFilesOmitted, 30);
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
  assert.equal(report.preExistingChangesOmitted, 26);
  assert.ok(`${JSON.stringify(report, null, 2)}\n`.split("\n").length <= 60);
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
  assert.equal(JSON.parse(recovered.stdout).sandbox, "read-only");
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
