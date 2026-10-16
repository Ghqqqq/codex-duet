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

test("configured sandbox persists across workspaces, implies write, and explicit task flags win", () => {
  const f = fixture();
  const json = result => { assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout); };
  assert.equal(json(f.call("setup", "--default-sandbox", "danger-full-access", "--dry-run", "--json")).defaultSandbox, "danger-full-access");
  assert.throws(f.state, /ENOENT/, "offline setup cannot start a runtime");
  const first = json(f.call("task", "--json", "investigate"));
  assert.equal(first.sandbox, "read-only");
  for (const mode of ["workspace-write", "danger-full-access"]) {
    assert.equal(json(f.call("setup", "--default-sandbox", mode, "--json")).defaultSandbox, mode);
    const result = json(f.call("task", "--thread", first.threadId, "--json", "--report", "investigate"));
    assert.equal(result.sandbox, mode);
    assert.equal(f.state().lastThreadResume.sandbox, mode);
    assert.equal(f.state().lastTurnStart.sandboxPolicy.type, mode === "workspace-write" ? "workspaceWrite" : "dangerFullAccess");
    assert.equal(f.state().lastTurnStart.approvalPolicy, "never");
  }
  assert.equal(json(f.call("setup", "--json")).defaultSandbox, "danger-full-access");
  const other = path.join(f.dir, "other-workspace"); fs.mkdirSync(other); initGitRepo(other);
  assert.equal(json(run(process.execPath, [f.script, "task", "--json", "investigate"], { cwd: other, env: f.env })).sandbox, "danger-full-access");
  assert.equal(json(f.call("task", "--sandbox", "read-only", "--json", "investigate")).sandbox, "read-only");
  assert.equal(json(f.call("task", "--write", "--json", "investigate")).sandbox, "workspace-write");
  assert.equal(json(f.call("task", "--write=false", "--json", "investigate")).sandbox, "read-only");
  assert.equal(json(f.call("task", "--write", "--sandbox", "workspace-write", "--json", "investigate")).sandbox, "workspace-write");
  assert.notEqual(f.call("task", "--sandbox", "danger-full-access", "investigate").status, 0, "explicit sandbox still needs explicit --write");
  assert.equal(json(f.call("setup", "--browser-approval", "never-ask", "--json")).browserOrigins.approval, "never-ask");
  assert.equal(json(f.call("setup", "--json")).browserOrigins.approval, "never-ask");
  json(f.call("setup", "--default-sandbox", "read-only", "--json"));
  assert.equal(json(f.call("task", "--json", "investigate")).sandbox, "read-only");
});

test("task sandbox opt-in reaches thread and turn APIs, then resets on an ordinary follow-up", () => {
  const f = fixture();
  const task = (...args) => {
    const result = f.call("task", "--json", ...args, "investigate");
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  assert.equal(task().sandbox, "read-only");
  assert.equal(f.state().lastThreadStart.sandbox, "read-only");
  assert.equal(f.state().lastTurnStart.sandboxPolicy, undefined);
  assert.equal(task("--write").sandbox, "workspace-write");
  assert.equal(f.state().lastThreadStart.sandbox, "workspace-write");
  assert.equal(f.state().lastTurnStart.sandboxPolicy, undefined);
  const elevated = task("--write", "--sandbox", "danger-full-access", "--report");
  assert.equal(elevated.sandbox, "danger-full-access");
  assert.equal(elevated.approvalPolicy, "never");
  assert.equal(f.state().lastThreadStart.sandbox, "danger-full-access");
  assert.deepEqual(f.state().lastTurnStart.sandboxPolicy, { type: "dangerFullAccess" });
  assert.equal(f.state().lastTurnStart.approvalPolicy, "never");
  const normal = task("--thread", elevated.threadId);
  assert.equal(normal.sandbox, "read-only");
  assert.equal(f.state().lastThreadResume.sandbox, "read-only");
  assert.equal(f.state().lastThreadResume.approvalPolicy, "never");
  assert.equal(f.state().lastTurnStart.sandboxPolicy, undefined);
  assert.equal(task("--write", "--sandbox", "workspace-write", "--thread", elevated.threadId).sandboxPolicy.type, "workspaceWrite");
  assert.equal(f.state().lastTurnStart.sandboxPolicy.type, "workspaceWrite");
  assert.equal(task("--sandbox", "read-only").sandbox, "read-only");
  assert.equal(f.state().lastTurnStart.sandboxPolicy.type, "readOnly");
});

test("task rejects unknown, missing and conflicting sandbox flags before starting a turn", () => {
  const f = fixture();
  for (const args of [
    ["--sandbox", "full-access"], ["--sandbox", "dangerFullAccess"], ["--sandbox", ""], ["--sandbox"],
    ["--sandbox", "danger-full-access"], ["--sandbox", "workspace-write"], ["--write", "--sandbox", "read-only"]
  ]) {
    const result = f.call("task", "--json", ...args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /sandbox/);
  }
  assert.throws(f.state, /ENOENT/, "no runtime may be started by invalid flags");
});

test("background task persists and reports the deliberately requested sandbox", async () => {
  const f = fixture();
  assert.equal(f.call("setup", "--default-sandbox", "danger-full-access", "--json").status, 0);
  const launched = f.call("task", "--background", "--json", "investigate");
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
