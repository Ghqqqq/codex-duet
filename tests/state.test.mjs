import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { initGitRepo, makeTempDir } from "./helpers.mjs";
import { ensureStateDir, listSessionJobs, resolveJobFile, resolveJobLogFile, resolveStateDir, resolveStateDirForRoot, resolveStateFile, resolveStateRoot, saveState } from "../plugins/codex/scripts/lib/state.mjs";

test("resolveStateDir is a per-workspace directory under the isolated home, independent of CLAUDE_PLUGIN_DATA and the temp dir", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const stateRoot = resolveStateRoot();

  assert.equal(stateRoot, path.join(path.resolve(process.env.CODEX_COMPANION_HOME), "duet", "state"));
  assert.equal(path.dirname(stateDir), stateRoot);
  assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
  assert.equal(stateDir.startsWith(os.tmpdir() + path.sep + "codex-companion-isolated"), false);
  // The plugin id (and so CLAUDE_PLUGIN_DATA) changed when the marketplace was
  // renamed; the state location must not follow it, nor vanish outside Claude.
  for (const env of [{ ...process.env, CLAUDE_PLUGIN_DATA: makeTempDir() }, { ...process.env, CLAUDE_PLUGIN_DATA: "" }]) {
    assert.equal(resolveStateDir(workspace, env), stateDir);
  }
  ensureStateDir(workspace);
  for (const dir of [stateRoot, stateDir, path.join(stateDir, "jobs")]) assert.equal(fs.statSync(dir).mode & 0o777, 0o700, dir);

  // Recorded roots use the same key, including legacy subdirectory/alias
  // records and repositories that have since been deleted.
  assert.equal(resolveStateDirForRoot(workspace), stateDir);
  const repo = makeTempDir(), nested = path.join(repo, "nested");
  initGitRepo(repo); fs.mkdirSync(nested);
  const repoState = resolveStateDir(repo), alias = path.join(workspace, "repo-alias");
  fs.symlinkSync(repo, alias, process.platform === "win32" ? "junction" : "dir");
  for (const root of [repo, nested, alias]) assert.equal(resolveStateDirForRoot(root), repoState);
  ensureStateDir(repo);
  const jobs = [repo, nested, alias].map((workspaceRoot, i) => ({ id: `task-root-${i}`, workspaceRoot, sessionId: "root-mapping" }));
  fs.writeFileSync(path.join(repoState, "state.json"), JSON.stringify({ jobs }));
  assert.deepEqual(listSessionJobs(nested, "root-mapping").map(job => job.id).sort(), jobs.map(job => job.id));
  fs.rmSync(repo, { recursive: true, force: true });
  assert.equal(resolveStateDirForRoot(repo), repoState);
});

test("saveState prunes dropped job artifacts when indexed jobs exceed the cap", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  const jobs = Array.from({ length: 51 }, (_, index) => {
    const jobId = `job-${index}`;
    const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
    const logFile = resolveJobLogFile(workspace, jobId);
    const jobFile = resolveJobFile(workspace, jobId);
    fs.writeFileSync(logFile, `log ${jobId}\n`, "utf8");
    fs.writeFileSync(jobFile, JSON.stringify({ id: jobId, status: "completed" }, null, 2), "utf8");
    return {
      id: jobId,
      status: "completed",
      logFile,
      updatedAt,
      createdAt: updatedAt
    };
  });

  fs.writeFileSync(
    stateFile,
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs
  });

  const prunedJobFile = resolveJobFile(workspace, "job-0");
  const prunedLogFile = resolveJobLogFile(workspace, "job-0");
  const retainedJobFile = resolveJobFile(workspace, "job-50");
  const retainedLogFile = resolveJobLogFile(workspace, "job-50");
  const jobsDir = path.dirname(prunedJobFile);

  assert.equal(fs.existsSync(retainedJobFile), true);
  assert.equal(fs.existsSync(retainedLogFile), true);

  const savedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(savedState.jobs.length, 50);
  assert.deepEqual(
    savedState.jobs.map((job) => job.id),
    Array.from({ length: 50 }, (_, index) => `job-${50 - index}`)
  );
  assert.deepEqual(
    fs.readdirSync(jobsDir).sort(),
    Array.from({ length: 50 }, (_, index) => `job-${index + 1}`)
      .flatMap((jobId) => [`${jobId}.json`, `${jobId}.log`])
      .sort()
  );
});
