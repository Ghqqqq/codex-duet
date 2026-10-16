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
  return { call, dir, env, script, state: () => JSON.parse(fs.readFileSync(path.join(dir, "fake-codex-state.json"))) };
}

test("full access is the built-in default; setup --default-sandbox lowers it and explicit task flags win", () => {
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
    const result = json(f.call("task", "--thread", first.threadId, "--json", "--report", "investigate"));
    assert.equal(result.sandbox, mode);
    assert.equal(f.state().lastThreadResume.sandbox, mode);
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
  assert.equal(fs.readFileSync(path.join(f.env.HOME, ".claude", "codex-isolated", "browser", "config.toml"), "utf8"), '"approval_mode" = "never_ask"\n');
  assert.equal(json(f.call("setup", "--browser-approval", "ask", "--json")).browserOrigins.approval, "ask");
  assert.equal(json(f.call("task", "--json", "investigate")).sandbox, "danger-full-access");
  assert.equal(json(f.call("setup", "--json")).browserOrigins.approval, "ask", "an explicit ask survives later tasks");
});

test("task sandbox reaches thread and turn APIs and resets to the default on an ordinary follow-up", () => {
  const f = fixture();
  const task = (...args) => {
    const result = f.call("task", "--json", ...args, "investigate");
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  assert.equal(task().sandbox, "danger-full-access");
  assert.equal(f.state().lastThreadStart.sandbox, "danger-full-access");
  assert.deepEqual(f.state().lastTurnStart.sandboxPolicy, { type: "dangerFullAccess" });
  assert.equal(task("--sandbox", "workspace-write").sandbox, "workspace-write");
  assert.equal(f.state().lastThreadStart.sandbox, "workspace-write");
  assert.equal(f.state().lastTurnStart.sandboxPolicy.type, "workspaceWrite");
  const narrowed = task("--sandbox", "read-only", "--report");
  assert.equal(narrowed.sandbox, "read-only");
  assert.equal(narrowed.approvalPolicy, "never");
  assert.equal(f.state().lastThreadStart.sandbox, "read-only");
  assert.equal(f.state().lastTurnStart.sandboxPolicy.type, "readOnly");
  assert.equal(f.state().lastTurnStart.sandboxPolicy.networkAccess, true, "a narrowed sandbox limits writes, never where Codex may connect");
  assert.equal(f.state().lastTurnStart.approvalPolicy, "never");
  const normal = task("--thread", narrowed.threadId);
  assert.equal(normal.sandbox, "danger-full-access", "a follow-up without flags returns to the default, not the previous call");
  assert.equal(f.state().lastThreadResume.sandbox, "danger-full-access");
  assert.equal(f.state().lastThreadResume.approvalPolicy, "never");
  assert.equal(task("--sandbox", "read-only", "--thread", narrowed.threadId).sandboxPolicy.type, "readOnly");
  assert.equal(f.state().lastTurnStart.sandboxPolicy.type, "readOnly");
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

test("background task persists and reports the deliberately requested sandbox", async () => {
  const f = fixture();
  assert.equal(f.call("setup", "--default-sandbox", "read-only", "--json").status, 0);
  const launched = f.call("task", "--background", "--sandbox", "danger-full-access", "--json", "investigate");
  assert.equal(launched.status, 0, launched.stderr);
  const queued = JSON.parse(launched.stdout);
  assert.equal(queued.sandbox, "danger-full-access");
  assert.equal(queued.approvalPolicy, "never");
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
  const result = f.call("result", queued.jobId, "--report", "--json");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).sandbox, "danger-full-access");
  assert.deepEqual(f.state().lastTurnStart.sandboxPolicy, { type: "dangerFullAccess" });
});
