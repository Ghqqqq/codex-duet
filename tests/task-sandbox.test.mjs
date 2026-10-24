import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDir, initGitRepo, run } from "./helpers.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";

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
  for (const mode of ["read-only", "workspace-write"]) {
    assert.equal(json(f.call("setup", "--default-sandbox", mode, "--json")).defaultSandbox, mode);
    const result = json(f.call("task", "--fresh", "--json", "--report", "investigate"));
    assert.equal(result.sandbox, mode);
    assert.equal(f.state().lastThreadStart.sandbox, mode);
    assert.equal(f.state().lastTurnStart.sandboxPolicy.type, mode === "workspace-write" ? "workspaceWrite" : "readOnly");
    assert.equal(f.state().lastTurnStart.approvalPolicy, "never");
  }
  assert.equal(json(f.call("setup", "--json")).defaultSandbox, "workspace-write");
  const other = path.join(f.dir, "other-workspace"); fs.mkdirSync(other); initGitRepo(other);
  assert.equal(json(run(process.execPath, [f.script, "task", "--json", "investigate"], { cwd: other, env: f.env })).sandbox, "workspace-write", "the setting is per isolated home, not per workspace");
  // --sandbox adjusts one call in either direction without any other flag.
  assert.equal(json(f.call("task", "--sandbox", "read-only", "--json", "investigate")).sandbox, "read-only");
  assert.equal(json(f.call("task", "--sandbox", "danger-full-access", "--json", "investigate")).sandbox, "danger-full-access");
  // --write is a floor (at least workspace-write) and --write=false an explicit read-only request.
  json(f.call("setup", "--default-sandbox", "read-only", "--json"));
  assert.equal(json(f.call("task", "--json", "investigate")).sandbox, "read-only");
  assert.equal(json(f.call("task", "--write", "--json", "investigate")).sandbox, "workspace-write");
  json(f.call("setup", "--default-sandbox", "danger-full-access", "--json"));
  assert.equal(json(f.call("task", "--write", "--json", "investigate")).sandbox, "danger-full-access");
  assert.equal(json(f.call("task", "--write=false", "--json", "investigate")).sandbox, "read-only");
  assert.equal(json(f.call("task", "--write", "--sandbox", "workspace-write", "--json", "investigate")).sandbox, "workspace-write");
  // Every task mirrored the unrestricted browser default into the runtime's file.
  assert.equal(json(f.call("setup", "--json")).browserOrigins.approval, "never-ask");
  assert.equal(fs.readFileSync(path.join(f.env.CODEX_COMPANION_HOME, "browser", "config.toml"), "utf8"), '"approval_mode" = "never_ask"\n');
  assert.equal(json(f.call("setup", "--browser-approval", "ask", "--json")).browserOrigins.approval, "ask");
  assert.equal(json(f.call("task", "--json", "investigate")).sandbox, "danger-full-access");
  assert.equal(json(f.call("setup", "--json")).browserOrigins.approval, "ask", "an explicit ask survives later tasks");

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
  const narrow = direct(invoke(["task", ...session, "--sandbox", "read-only", "--model", "fixture-reviewer", "--effort", "high", "--fast",
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
  const explicit = direct(invoke(["task", ...session, "--thread", narrowJob.threadId, "--model", "fixture-editor", "--effort", "medium", "--sandbox", "workspace-write", "--normal",
    "--approve-browser-origin", "https://override.example", "--approve-computer-app", "com.example.Override"]));
  // The legacy invocation gets identical inheritance, including normal (null) tier.
  const legacy = direct(run(process.execPath, [f.script, "task", ...session, "--thread", narrowJob.threadId, "--direct"], { cwd: f.repo, env: f.env, input: "Legacy follow-up." }));
  const latest = stored(legacy.jobId).request;
  assert.deepEqual([latest.model, latest.effort, latest.sandbox, latest.serviceTier], ["fixture-editor", "medium", "workspace-write", null]);
  assert.deepEqual(latest.approvedBrowserOrigins, ["https://override.example"]);
  assert.deepEqual(latest.approvedComputerApps, ["com.example.Override"]);
  assert.equal(stored(legacy.jobId).threadId, stored(explicit.jobId).threadId);
  assert.equal(json(invoke(["status", narrow.worker, ...session, "--json"], other)).job.id, legacy.jobId);
  assert.equal(json(invoke(["result", narrow.worker, ...session], other)).jobId, legacy.jobId);
  assert.equal(json(invoke(["result", legacy.jobId, ...session, "--json"], other)).storedJob.request.cwd, f.repo);
  assert.equal(direct(invoke(["wait", narrow.worker, ...session], other)).jobId, legacy.jobId);
  const before = f.state().nextTurnId;
  for (const args of [["task", ...session, "--to", "UnknownWorker"], ["task", "--to", narrow.worker]]) {
    const missing = invoke(args);
    assert.equal(missing.status, 1);
    assert.equal(JSON.parse(missing.stdout).status, "error");
  }
  assert.equal(f.state().nextTurnId, before, "failed resolution never starts a turn");
  const duplicate = direct(invoke(["task", ...session], other));
  patch(duplicate.jobId, { agentName: narrow.worker }, other);
  const foreignBefore = JSON.parse(run(process.execPath, [f.script, "result", duplicate.jobId, "--json"], { cwd: other, env: f.env }).stdout).storedJob;
  const local = direct(invoke(["task", ...session, "--to", narrow.worker]));
  assert.equal(stored(local.jobId).threadId, narrowJob.threadId, "legacy duplicate names prefer the caller's workspace");
  assert.deepEqual(JSON.parse(run(process.execPath, [f.script, "result", duplicate.jobId, "--json"], { cwd: other, env: f.env }).stdout).storedJob, foreignBefore);
  assert.equal(f.state().nextTurnId, before + 2, "the local follow-up starts exactly one additional turn");
});

test("task rejects unknown, missing and conflicting sandbox flags before starting a turn", () => {
  const f = fixture();
  for (const args of [
    ["--sandbox", "full-access"], ["--sandbox", "dangerFullAccess"], ["--sandbox", ""], ["--sandbox"],
    ["--write", "--sandbox", "read-only"]
  ]) {
    const result = f.call("task", "--json", ...args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /sandbox/);
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
  addRuntimeGrants(restarted.jobId);
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
  f.env.CODEX_COMPANION_SESSION_ID = "";
  const unscoped = json(f.call("task", "--direct", "--thread", thread, "fixture"));
  assert.deepEqual(stored(unscoped.jobId).request.approvedComputerApps, []);
  assert.deepEqual(stored(unscoped.jobId).request.approvedBrowserOrigins, []);
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
    const status = f.call("status", queued.jobId, "--json");
    assert.equal(status.status, 0, status.stderr);
    job = JSON.parse(status.stdout).job;
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
