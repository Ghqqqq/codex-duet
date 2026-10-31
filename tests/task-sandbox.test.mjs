import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDir, initGitRepo, run } from "./helpers.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { resolveStateDir } from "../plugins/codex/scripts/lib/state.mjs";

function fixture() {
  const dir = makeTempDir(); installFakeCodex(dir);
  const repo = path.join(dir, "repo"); fs.mkdirSync(repo); initGitRepo(repo);
  const script = new URL("../plugins/codex/scripts/codex-companion.mjs", import.meta.url).pathname;
  const env = { ...buildEnv(dir), CLAUDE_PLUGIN_DATA: path.join(dir, "data") };
  const call = (...args) => run(process.execPath, [script, ...args], { cwd: repo, env });
  return { call, dir, repo, env, script, state: () => JSON.parse(fs.readFileSync(path.join(dir, "fake-codex-state.json"))) };
}

test("sandbox defaults apply to fresh tasks; named and thread follow-ups inherit recorded settings with explicit overrides", () => {
  const f = fixture();
  const json = result => { assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout); };
  assert.equal(json(f.call("setup", "--default-sandbox", "read-only", "--dry-run", "--json")).defaultSandbox, "read-only");
  assert.throws(f.state, /ENOENT/, "offline setup cannot start a runtime");
  const first = json(f.call("task", "--json", "investigate"));
  assert.equal(first.sandbox, "danger-full-access", "no setting: workers run like the user's own Codex app");
  assert.equal(first.approvalPolicy, "never");
  assert.deepEqual(f.state().lastTurnStart.sandboxPolicy, { type: "dangerFullAccess" });
  json(f.call("setup", "--default-sandbox", "read-only", "--json"));
  assert.equal(json(f.call("task", "--write", "--json", "investigate")).sandbox, "workspace-write");
  assert.equal(f.state().lastTurnStart.sandboxPolicy.type, "workspaceWrite");
  const other = path.join(f.dir, "other-workspace"); fs.mkdirSync(other); initGitRepo(other);
  const duet = new URL("../plugins/codex/bin/duet", import.meta.url).pathname;
  const invoke = (args, cwd = f.repo) => run(duet, args, { cwd, env: f.env, input: "Synthetic follow-up brief." });
  const direct = result => { assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout.trim().split("\n").at(-1)); };
  const stored = id => json(f.call("result", id, "--json")).storedJob;
  const patch = (id, fields, cwd = f.repo) => {
    const module = new URL("../plugins/codex/scripts/lib/state.mjs", import.meta.url).href;
    const result = run(process.execPath, ["--input-type=module", "-e", `import { updateJob } from ${JSON.stringify(module)}; updateJob(process.cwd(), ${JSON.stringify(id)}, () => (${JSON.stringify(fields)}));`], { cwd, env: f.env });
    assert.equal(result.status, 0, result.stderr);
  };
  f.env.CODEX_COMPANION_SESSION_ID = "ignored-session";
  const session = ["--session", "addressing-session"];
  const narrow = direct(invoke(["task", ...session, "--fresh", "--model", "fixture-reviewer", "--effort", "high", "--fast",
    "--approve-browser-origin", "https://example.com", "--approve-computer-app", "com.example.Recorded"]));
  const narrowJob = stored(narrow.jobId);
  // Grants received while answering a runtime question are not request grants.
  patch(narrow.jobId, { approvedBrowserOrigins: ["https://one-call.example"], approvedComputerApps: ["com.example.OneCall"] });
  const followed = direct(invoke(["task", ...session, "--to", narrow.worker.toLowerCase()], other));
  assert.equal(stored(followed.jobId).threadId, narrowJob.threadId);
  assert.equal(followed.worker, narrow.worker);
  const request = stored(followed.jobId).request;
  assert.equal(request.cwd, f.repo);
  assert.equal(stored(followed.jobId).sessionId, "addressing-session");
  assert.deepEqual([request.model, request.effort, request.sandbox, request.serviceTier], ["fixture-reviewer", "high", "read-only", "priority"]);
  assert.deepEqual(request.approvedBrowserOrigins, ["https://example.com"]);
  assert.deepEqual(request.approvedComputerApps, ["com.example.Recorded"]);
  assert.equal(f.state().lastThreadResume.cwd, f.repo);
  assert.equal(f.state().lastThreadResume.sandbox, "read-only");
  assert.equal(f.state().lastTurnStart.sandboxPolicy.type, "readOnly");
  assert.equal(f.state().lastTurnStart.effort, "high");
  assert.equal(f.state().lastTurnStart.serviceTier, "priority");
  const duplicateId = "legacy-duplicate", stateModule = new URL("../plugins/codex/scripts/lib/state.mjs", import.meta.url).href;
  const seeded = run(process.execPath, ["--input-type=module", "-e", `
    import { writeJobFile, upsertJob } from ${JSON.stringify(stateModule)};
    const record = { id: ${JSON.stringify(duplicateId)}, agentName: ${JSON.stringify(narrow.worker)}, jobClass: "task", status: "completed",
      sessionId: "addressing-session", workspaceRoot: ${JSON.stringify(other)}, threadId: "foreign-thread", createdAt: new Date(Date.now() + 1000).toISOString() };
    writeJobFile(record.workspaceRoot, record.id, record); upsertJob(record.workspaceRoot, record);
  `], { cwd: f.repo, env: f.env });
  assert.equal(seeded.status, 0, seeded.stderr);
  const foreignFile = path.join(resolveStateDir(other, f.env), "jobs", `${duplicateId}.json`), foreignBefore = fs.readFileSync(foreignFile, "utf8");
  const explicit = direct(invoke(["task", ...session, "--to", narrow.worker, "--model", "fixture-editor", "--effort", "medium", "--sandbox", "workspace-write", "--normal",
    "--approve-browser-origin", "https://override.example", "--approve-computer-app", "com.example.Override"]));
  const latest = stored(explicit.jobId).request;
  assert.deepEqual([latest.model, latest.effort, latest.sandbox, latest.serviceTier], ["fixture-editor", "medium", "workspace-write", null]);
  assert.deepEqual(latest.approvedBrowserOrigins, ["https://override.example"]);
  assert.deepEqual(latest.approvedComputerApps, ["com.example.Override"]);
  assert.equal(stored(explicit.jobId).threadId, narrowJob.threadId, "legacy duplicate names prefer the caller workspace");
  assert.equal(fs.readFileSync(foreignFile, "utf8"), foreignBefore);
  assert.equal(json(invoke(["status", narrow.worker, ...session, "--json"])).job.id, explicit.jobId);
  const before = f.state().nextTurnId;
  for (const args of [["task", ...session, "--to", "UnknownWorker"], ["task", "--to", narrow.worker]]) {
    const missing = invoke(args);
    assert.equal(missing.status, 1);
    assert.equal(JSON.parse(missing.stdout).status, "error");
  }
  assert.equal(f.state().nextTurnId, before, "failed resolution never starts a turn");
});

test("task cwd and follow-ups stay in the requested directory while state, snapshots and reviews use the repository root", () => {
  const f = fixture();
  const sub = path.join(f.repo, "packages", "web");
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(f.repo, "pre-existing.txt"), "baseline\n");
  const binary = path.join(f.dir, "codex");
  fs.writeFileSync(binary, fs.readFileSync(binary, "utf8").replace('case "turn/start": {', `case "turn/start": {
    fs.appendFileSync(${JSON.stringify(path.join(f.repo, "root-edited.txt"))}, "edit\\n");
    fs.appendFileSync(path.join(ensureThread(state, message.params.threadId).cwd, "cwd-edited.txt"), "edit\\n");`));
  f.env.CODEX_COMPANION_SESSION_ID = "subdirectory-session";
  const duet = new URL("../plugins/codex/bin/duet", import.meta.url).pathname;
  const json = result => {
    assert.equal(result.status, 0, result.stderr);
    try { return JSON.parse(result.stdout); }
    catch { return JSON.parse(result.stdout.trim().split("\n").at(-1)); }
  };
  const task = (...args) => json(run(duet, ["task", ...args], { cwd: f.repo, env: f.env, input: "Inspect the fixture." }));
  const stored = report => json(f.call("result", report.jobId, "--json")).storedJob;
  const stateDir = resolveStateDir(f.repo, f.env);
  const assertJob = (report, cwd) => {
    const job = stored(report);
    assert.equal(report.status, "completed");
    assert.equal(job.request.cwd, cwd);
    assert.equal(job.workspaceRoot, f.repo);
    assert.equal(path.dirname(job.resultFile), path.join(stateDir, "jobs"));
    assert.ok(JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"))).jobs.some(entry => entry.id === job.id));
    return job;
  };
  const first = task("--cwd", sub);
  const firstJob = assertJob(first, sub);
  assert.equal(f.state().lastThreadStart.cwd, sub);
  const details = JSON.parse(fs.readFileSync(firstJob.resultFile));
  assert.ok(details.touchedFiles.includes("packages/web/cwd-edited.txt"));
  assert.ok(details.touchedFiles.includes("root-edited.txt"));
  assert.ok(details.preExistingChanges.includes("pre-existing.txt"));
  assert.equal(details.fileTracking.status, "complete");
  for (const args of [["--thread", firstJob.threadId]]) {
    const followup = assertJob(task(...args), sub);
    assert.equal(followup.threadId, firstJob.threadId);
    assert.equal(f.state().lastThreadResume.cwd, sub);
  }
  // Codex receives the physical directory even when the CLI uses a symlink.
  const alias = path.join(f.dir, "web-alias");
  fs.symlinkSync(sub, alias, process.platform === "win32" ? "junction" : "dir");
  assertJob(task("--cwd", alias), alias);
  assert.equal(f.state().lastThreadStart.cwd, fs.realpathSync(sub));
  for (const review of ["review"]) {
    json(f.call(review, "--cwd", sub, "--scope", "working-tree", "--json"));
    assert.equal(f.state().lastThreadStart.cwd, f.repo);
  }
});

test("task rejects malformed sandbox and reserved name flags before starting a turn", () => {
  const f = fixture();
  for (const args of [
    ["--sandbox", "full-access"], ["--sandbox"], ["--write", "--sandbox", "read-only"],
    ["--name", "task-x"], ["--name", "bad name"]
  ]) {
    const result = f.call("task", "--json", ...args);
    assert.notEqual(result.status, 0);
  }
  assert.throws(f.state, /ENOENT/, "no runtime may be started by invalid flags");
});

test("named follow-ups stay session-scoped while explicit continuations inherit the selected request", () => {
  const f = fixture();
  const json = result => {
    assert.equal(result.status, 0, result.stderr);
    try { return JSON.parse(result.stdout); }
    catch { return JSON.parse(result.stdout.trim().split("\n").at(-1)); }
  };
  const stored = id => json(f.call("result", id, "--json")).storedJob;
  const addRuntimeGrants = id => {
    const module = new URL("../plugins/codex/scripts/lib/state.mjs", import.meta.url).href;
    const result = run(process.execPath, ["--input-type=module", "-e", `import { updateJob } from ${JSON.stringify(module)}; updateJob(process.cwd(), ${JSON.stringify(id)}, () => ({ approvedBrowserOrigins: ["https://one-call.example"], approvedComputerApps: ["com.example.OneCall"] }));`], { cwd: f.repo, env: f.env });
    assert.equal(result.status, 0, result.stderr);
  };
  f.env.CODEX_COMPANION_SESSION_ID = "session-a";
  const first = json(f.call("task", "--direct", "--fresh", "--sandbox", "read-only", "--model", "session-a-model", "--effort", "high", "--fast", "fixture"));
  const own = json(f.call("task", "--direct", "--to", first.worker, "--effort", "medium", "--normal", "fixture"));
  const thread = stored(own.jobId).threadId;
  f.env.CODEX_COMPANION_SESSION_ID = "session-b";
  const foreign = json(f.call("task", "--direct", "--thread", thread, "--sandbox", "danger-full-access", "--model", "session-b-model", "--effort", "max", "--fast",
    "--approve-browser-origin", "https://foreign.example", "--approve-computer-app", "com.example.Foreign", "fixture"));
  f.env.CODEX_COMPANION_SESSION_ID = "session-a";
  const followup = json(f.call("task", "--direct", "--to", first.worker, "fixture"));
  const request = stored(followup.jobId).request;
  assert.deepEqual([request.sandbox, request.model, request.effort, request.serviceTier], ["read-only", "session-a-model", "medium", null]);
  assert.deepEqual(request.approvedBrowserOrigins, []);
  assert.deepEqual(request.approvedComputerApps, []);
  assert.equal(f.state().lastThreadResume.sandbox, "read-only");
  assert.equal(f.state().lastTurnStart.sandboxPolicy.type, "readOnly");
  assert.equal(f.state().lastTurnStart.model, "session-a-model");
  const details = json(f.call("result", followup.jobId, "--details"));
  assert.equal(details.settingsInheritance.jobId, own.jobId);
  assert.equal(details.settingsInheritance.skippedJobId, foreign.jobId);
  assert.equal(details.settingsInheritance.scope, "session");
  assert.equal(Object.hasOwn(followup, "settingsInheritance"), false);

  addRuntimeGrants(foreign.jobId);
  f.env.CODEX_COMPANION_SESSION_ID = "session-c";
  const restarted = json(f.call("task", "--continue", foreign.jobId, "--direct", "fixture"));
  const restartedJob = stored(restarted.jobId);
  assert.equal(restartedJob.request.continuedFrom, foreign.jobId);
  assert.equal(restartedJob.threadId, thread);
  assert.equal(restartedJob.sessionId, "session-c");
  for (const key of ["sandbox", "write", "model", "effort", "serviceTier", "approvedBrowserOrigins", "approvedComputerApps"]) {
    assert.deepEqual(restartedJob.request[key], key.startsWith("approved") ? [] : stored(foreign.jobId).request[key], key);
  }
  assert.equal(f.state().lastTurnStart.sandboxPolicy.type, "dangerFullAccess");
  assert.equal(f.state().lastTurnStart.model, "session-b-model");
  assert.equal(f.state().lastTurnStart.computerUse.session, null);
  assert.doesNotMatch(f.state().lastTurnStart.computerUse.session ?? "", /com\.example\.OneCall/);
  f.env.CODEX_COMPANION_SESSION_ID = "session-d";
  const threaded = json(f.call("task", "--direct", "--thread", thread, "fixture"));
  const threadedJob = stored(threaded.jobId);
  assert.equal(threadedJob.threadId, thread);
  assert.equal(threadedJob.sessionId, "session-d");
  for (const key of ["sandbox", "write", "model", "effort", "serviceTier", "approvedBrowserOrigins", "approvedComputerApps"]) {
    assert.deepEqual(threadedJob.request[key], restartedJob.request[key], key);
  }
  assert.equal(f.state().lastTurnStart.model, "session-b-model");
  assert.equal(f.state().lastTurnStart.computerUse.session, null);
  assert.doesNotMatch(f.state().lastTurnStart.computerUse.session ?? "", /com\.example\.OneCall/);
  const threadedDetails = json(f.call("result", threaded.jobId, "--details"));
  assert.equal(threadedDetails.settingsInheritance.jobId, restarted.jobId);
  assert.equal(threadedDetails.settingsInheritance.scope, "workspace");
  assert.equal(Object.hasOwn(threaded, "settingsInheritance"), false);
});

test("background task persists and reports the deliberately requested sandbox", async () => {
  const f = fixture();
  assert.equal(f.call("setup", "--default-sandbox", "read-only", "--json").status, 0);
  const launched = f.call("task", "--background", "--sandbox", "danger-full-access", "--fast", "--effort", "max", "--json", "investigate");
  assert.equal(launched.status, 0, launched.stderr);
  const queued = JSON.parse(launched.stdout);
  assert.equal(queued.sandbox, "danger-full-access");
  assert.equal(queued.approvalPolicy, "never+elicitations", "an owned job can forward Computer Use requests to its parent");
  let job;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    job = JSON.parse(fs.readFileSync(path.join(resolveStateDir(f.repo, f.env), "jobs", `${queued.jobId}.json`)));
    if (job.status === "completed" || job.status === "failed") break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(job.status, "completed");
  const result = f.call("result", queued.jobId, "--details");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).sandbox, "danger-full-access");
  assert.deepEqual(f.state().lastTurnStart.sandboxPolicy, { type: "dangerFullAccess" });
  assert.equal(f.state().lastTurnStart.serviceTier, "priority");
  assert.equal(f.state().lastTurnStart.effort, "max");
  for (const launch of f.state().launches) assert.equal(fs.realpathSync(launch.home), fs.realpathSync(f.env.CODEX_COMPANION_HOME));
});
