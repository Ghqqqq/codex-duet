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
  return { call, state: () => JSON.parse(fs.readFileSync(path.join(dir, "fake-codex-state.json"))) };
}

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
  const launched = f.call("task", "--background", "--write", "--sandbox", "danger-full-access", "--json", "investigate");
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
