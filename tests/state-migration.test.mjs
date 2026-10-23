import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDir, initGitRepo, run } from "./helpers.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { spawnOwned } from "../plugins/codex/scripts/lib/process.mjs";
import { legacyStateRoots, resolveStateDir } from "../plugins/codex/scripts/lib/state.mjs";

const script = new URL("../plugins/codex/scripts/codex-companion.mjs", import.meta.url).pathname;

// Earlier releases stored jobs under CLAUDE_PLUGIN_DATA (whose value followed the
// plugin id: it changed when the marketplace was renamed) or, outside Claude,
// under the temp dir. These fixtures recreate such directories exactly as an
// older release left them, including artifact paths inside them.
function fixture() {
  const dir = makeTempDir(); installFakeCodex(dir);
  const repo = path.join(dir, "repo"); fs.mkdirSync(repo); initGitRepo(repo);
  const env = { ...buildEnv(dir), CLAUDE_PLUGIN_DATA: path.join(dir, "data"), CODEX_COMPANION_SESSION_ID: "fixture-session" };
  const stateDir = resolveStateDir(repo, env), key = path.basename(stateDir);
  const legacyRoots = {
    oldPluginId: path.join(env.HOME, ".claude", "plugins", "data", "codex-codex-isolated-local", "state"),
    newPluginId: path.join(env.HOME, ".claude", "plugins", "data", "codex-duet", "state"),
    pluginData: path.join(env.CLAUDE_PLUGIN_DATA, "state"),
    tmp: path.join(env.TMPDIR, "codex-companion-isolated")
  };
  const call = (args, overrides = {}) => run(process.execPath, [script, ...args], { cwd: repo, env: { ...env, ...overrides } });
  const json = (result, code = 0) => { assert.equal(result.status, code, result.stderr + result.stdout); return JSON.parse(result.stdout); };
  // Move the workspace's current state into a legacy root, rewriting recorded
  // absolute paths so the records look as if that release had written them.
  const relocate = root => {
    const target = path.join(root, key);
    fs.mkdirSync(root, { recursive: true });
    fs.cpSync(stateDir, target, { recursive: true });
    fs.rmSync(path.join(target, ".legacy-migration.json"), { force: true });
    for (const file of [path.join(target, "state.json"), ...fs.readdirSync(path.join(target, "jobs")).filter(n => n.endsWith(".json")).map(n => path.join(target, "jobs", n))]) {
      fs.writeFileSync(file, fs.readFileSync(file, "utf8").split(stateDir).join(target));
    }
    fs.rmSync(stateDir, { recursive: true, force: true });
    return target;
  };
  const readState = dir => JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
  const marker = () => JSON.parse(fs.readFileSync(path.join(stateDir, ".legacy-migration.json"), "utf8"));
  return { dir, repo, env, stateDir, key, legacyRoots, call, json, relocate, readState, marker, fake: () => JSON.parse(fs.readFileSync(path.join(dir, "fake-codex-state.json"))) };
}

test("jobs written under the old plugin-data directory are found by status, result, --continue and adopt", () => {
  const f = fixture();
  const done = f.json(f.call(["task", "--json", "--report", "fixture work"]));
  assert.equal(done.status, "completed");
  assert.ok(fs.existsSync(path.join(f.stateDir, "jobs", `${done.jobId}.json`)), "written under the isolated home");
  const legacyDir = f.relocate(f.legacyRoots.oldPluginId);
  assert.equal(fs.existsSync(f.stateDir), false);

  const status = f.json(f.call(["status", done.jobId, "--json"]));
  assert.equal(status.job.id, done.jobId); assert.equal(status.job.status, "completed");
  assert.ok(status.job.logFile.startsWith(legacyDir), "artifact paths stay where the older release wrote them");
  assert.ok(fs.existsSync(status.job.logFile));
  const migrated = f.marker();
  assert.deepEqual(Object.keys(migrated.sources), [legacyDir]); assert.equal(migrated.sources[legacyDir].imported, 1); assert.deepEqual(migrated.pending, []);
  assert.deepEqual(fs.readdirSync(path.join(legacyDir, "jobs")).sort(), fs.readdirSync(path.join(legacyDir, "jobs")).sort(), "the legacy directory is left intact");
  assert.ok(fs.existsSync(path.join(legacyDir, "jobs", `${done.jobId}.json`)));
  for (const dir of [f.stateDir, path.join(f.stateDir, "jobs")]) assert.equal(fs.statSync(dir).mode & 0o777, 0o700);

  const report = f.json(f.call(["result", done.jobId, "--details"]));
  assert.equal(report.jobId, done.jobId); assert.equal(report.status, "completed");
  assert.equal(report.model, "gpt-6-astra"); assert.equal(report.effort, "xhigh"); assert.equal(report.serviceTier, null);
  assert.ok(fs.existsSync(report.resultFile));

  const adopt = f.json(f.call(["adopt", done.jobId, "--json"]), 2);
  assert.equal(adopt.status, "job_ended", "known job, just not adoptable any more");

  const next = f.json(f.call(["task", "--continue", done.jobId, "--json", "--report"]));
  assert.equal(next.status, "completed"); assert.equal(next.threadId, done.threadId); assert.notEqual(next.jobId, done.jobId);
  assert.equal(f.fake().lastThreadResume.threadId, done.threadId);
  const listed = f.json(f.call(["status", "--json"]));
  assert.deepEqual([listed.latestFinished, ...listed.recent].map(j => j.id).sort(), [done.jobId, next.jobId].sort(), "one list with both the old and the new job");
});

test("a terminal (no CLAUDE_PLUGIN_DATA) and a Claude session (with it) see the same jobs", () => {
  const f = fixture();
  const fromSession = f.json(f.call(["task", "--json", "fixture work"]));
  const fromTerminal = f.json(f.call(["task", "--json", "fixture work"], { CLAUDE_PLUGIN_DATA: "" }));
  const ids = jobs => [jobs.latestFinished, ...jobs.recent].map(j => j.id).sort();
  const expected = [fromSession.jobId, fromTerminal.jobId].sort();
  assert.deepEqual(ids(f.json(f.call(["status", "--json"]))), expected);
  assert.deepEqual(ids(f.json(f.call(["status", "--json"], { CLAUDE_PLUGIN_DATA: "" }))), expected);
  assert.deepEqual(ids(f.json(f.call(["status", "--json"], { CLAUDE_PLUGIN_DATA: path.join(f.dir, "renamed-plugin-id") }))), expected, "a renamed plugin id changes nothing");
  assert.equal(fs.existsSync(path.join(f.env.CLAUDE_PLUGIN_DATA, "state")), false, "nothing is written under the plugin data directory any more");
  assert.equal(fs.existsSync(f.legacyRoots.tmp), false);
  assert.deepEqual(legacyStateRoots(f.env), []);
});

test("migration merges every legacy root once, keeps the newer record and is idempotent", () => {
  const f = fixture();
  const first = f.json(f.call(["task", "--json", "fixture one"]));
  const oldDir = f.relocate(f.legacyRoots.oldPluginId);
  const second = f.json(f.call(["task", "--json", "fixture two"]));
  // The second task triggered the merge of the first root; move everything into
  // a second legacy root so the next start finds two sources plus a conflict.
  assert.deepEqual(Object.keys(f.marker().sources), [oldDir]);
  const newDir = f.relocate(f.legacyRoots.pluginData);
  // Conflict: the same job in both roots. The one with the newer updatedAt wins.
  const stale = { ...JSON.parse(fs.readFileSync(path.join(oldDir, "jobs", `${first.jobId}.json`))), summary: "stale copy", updatedAt: "2000-01-01T00:00:00.000Z" };
  fs.writeFileSync(path.join(oldDir, "jobs", `${first.jobId}.json`), JSON.stringify(stale, null, 2));
  const third = { ...JSON.parse(fs.readFileSync(path.join(newDir, "jobs", `${second.jobId}.json`))), id: "task-legacy-third", summary: "newer in old root", threadId: "thr_third", updatedAt: "2999-01-01T00:00:00.000Z" };
  fs.writeFileSync(path.join(oldDir, "jobs", `${third.id}.json`), JSON.stringify(third, null, 2));
  fs.writeFileSync(path.join(newDir, "jobs", `${third.id}.json`), JSON.stringify({ ...third, summary: "older copy", updatedAt: "2998-01-01T00:00:00.000Z" }, null, 2));
  for (const [dir, summary] of [[oldDir, "newer in old root"], [newDir, "older copy"]]) {
    const state = f.readState(dir);
    state.jobs.unshift({ id: third.id, status: "completed", jobClass: "task", threadId: "thr_third", summary, updatedAt: summary === "older copy" ? "2998-01-01T00:00:00.000Z" : "2999-01-01T00:00:00.000Z", workspaceRoot: f.repo });
    fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(state, null, 2));
  }

  const listed = f.json(f.call(["status", "--json", "--all"]));
  const jobs = [listed.latestFinished, ...listed.recent];
  assert.deepEqual(jobs.map(j => j.id).sort(), [first.jobId, second.jobId, third.id].sort());
  assert.equal(jobs.find(j => j.id === third.id).summary, "newer in old root");
  const firstRecord = JSON.parse(fs.readFileSync(path.join(f.stateDir, "jobs", `${first.jobId}.json`)));
  assert.notEqual(firstRecord.summary, "stale copy", "the stale duplicate did not overwrite the newer record");
  const marker = f.marker();
  assert.deepEqual(Object.keys(marker.sources).sort(), [oldDir, newDir].sort());
  const before = JSON.stringify(f.readState(f.stateDir));
  f.json(f.call(["status", "--json"])); f.json(f.call(["status", "--json"], { CLAUDE_PLUGIN_DATA: "" }));
  assert.equal(JSON.stringify(f.readState(f.stateDir)), before, "a second start changes nothing");
  assert.deepEqual(f.marker().sources, marker.sources);
  assert.equal(new Set(f.readState(f.stateDir).jobs.map(j => j.id)).size, f.readState(f.stateDir).jobs.length, "no duplicate index entries");
});

test("concurrent first starts migrate once and agree", async () => {
  const f = fixture();
  const launched = [];
  for (let i = 0; i < 3; i++) launched.push(f.json(f.call(["task", "--json", `fixture ${i}`])).jobId);
  const legacyDir = f.relocate(f.legacyRoots.tmp);
  const results = await Promise.all([0, 1, 2].map(() => new Promise(resolve => {
    const child = spawnOwned(process.execPath, [script, "status", "--json"], { cwd: f.repo, env: f.env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", c => { out += c; }); child.stderr.on("data", c => { err += c; });
    child.on("exit", code => resolve({ code, out, err }));
  })));
  for (const r of results) assert.equal(r.code, 0, r.err);
  const ids = results.map(r => { const s = JSON.parse(r.out); return [s.latestFinished, ...s.recent].map(j => j.id).sort(); });
  assert.deepEqual(ids[0], launched.sort()); assert.deepEqual(ids[1], ids[0]); assert.deepEqual(ids[2], ids[0]);
  const marker = f.marker();
  assert.deepEqual(Object.keys(marker.sources), [legacyDir]); assert.equal(marker.sources[legacyDir].imported, 3);
  assert.equal(f.readState(f.stateDir).jobs.length, 3);
});

test("a legacy job whose worker is still alive is served in place, then merged when it ends; wait attaches throughout", async () => {
  const f = fixture();
  const finished = f.json(f.call(["task", "--json", "fixture work"]));
  const legacyDir = f.relocate(f.legacyRoots.newPluginId);
  // An older release's task-worker, still running: its record lives in the legacy directory.
  const worker = spawnOwned(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    const id = "task-legacy-live", now = Date.now();
    const record = { id, status: "running", jobClass: "task", title: "Codex Task", workspaceRoot: f.repo, ownerId: "old-owner", sessionId: "fixture-session", pid: worker.pid,
      threadId: "thr_live", turnId: "turn_live", leaseSec: 180, leaseRenewedAt: now, leaseExpiresAt: now + 180000, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
      logFile: path.join(legacyDir, "jobs", `${id}.log`), request: { model: "gpt-6-astra", effort: "low", serviceTier: "priority" } };
    fs.writeFileSync(record.logFile, "[fixture] running\n");
    fs.writeFileSync(path.join(legacyDir, "jobs", `${id}.json`), JSON.stringify(record, null, 2));
    const legacyState = f.readState(legacyDir); legacyState.jobs.unshift({ ...record }); fs.writeFileSync(path.join(legacyDir, "state.json"), JSON.stringify(legacyState, null, 2));

    const listed = f.json(f.call(["status", "--json"]));
    assert.deepEqual(listed.running.map(j => j.id), [id], "the live legacy job is listed");
    assert.equal(f.json(f.call(["status", id, "--json"])).job.pid, worker.pid);
    assert.equal(listed.latestFinished.id, finished.jobId, "finished legacy jobs were merged");
    assert.deepEqual(f.marker().pending.map(p => [p.id, p.stateDir]), [[id, legacyDir]]);
    assert.equal(fs.existsSync(path.join(f.stateDir, "jobs", `${id}.json`)), false, "not copied while its worker owns it");

    const waited = f.json(f.call(["wait", id, "--timeout-sec", "1", "--json", "--report"]));
    assert.equal(waited.status, "running"); assert.equal(waited.jobId, id);
    // Control written by the new release reaches the record the old worker reads.
    const cancel = f.call(["cancel", id, "--json"]);
    assert.equal(cancel.status, 2, "no worker of this release confirms; the request is only recorded");
    const legacyRecord = JSON.parse(fs.readFileSync(path.join(legacyDir, "jobs", `${id}.json`)));
    assert.equal(legacyRecord.cancelRequested?.reason, "cancelled_by_user");

    // The old worker finishes and exits.
    fs.writeFileSync(path.join(legacyDir, "jobs", `${id}.json`), JSON.stringify({ ...legacyRecord, status: "completed", pid: null, summary: "finished by the old worker", updatedAt: new Date().toISOString(), cancelRequested: null, result: { status: 0, rawOutput: "done", sandbox: "danger-full-access", approvalPolicy: "never" } }, null, 2));
    const ended = f.readState(legacyDir); ended.jobs = ended.jobs.map(j => j.id === id ? { ...j, status: "completed", pid: null, summary: "finished by the old worker", updatedAt: new Date().toISOString() } : j);
    fs.writeFileSync(path.join(legacyDir, "state.json"), JSON.stringify(ended, null, 2));
    worker.kill("SIGKILL"); await new Promise(resolve => worker.on("exit", resolve));

    const after = f.json(f.call(["status", id, "--json"]));
    assert.equal(after.job.status, "completed"); assert.equal(after.job.summary, "finished by the old worker");
    assert.deepEqual(f.marker().pending, []);
    assert.ok(fs.existsSync(path.join(f.stateDir, "jobs", `${id}.json`)), "merged into the isolated home once the worker was gone");
    const report = f.json(f.call(["result", id, "--details"]));
    assert.equal(report.serviceTier, "priority"); assert.equal(report.effort, "low");
  } finally {
    if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL");
  }
});

test("SessionEnd after an upgrade still interrupts a session's job that lives in the legacy directory", async () => {
  const f = fixture();
  f.json(f.call(["task", "--json", "fixture work"]));
  const legacyDir = f.relocate(f.legacyRoots.pluginData);
  const worker = spawnOwned(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    const id = "task-legacy-session", now = Date.now();
    const record = { id, status: "running", jobClass: "task", title: "Codex Task", workspaceRoot: f.repo, ownerId: "old-owner", sessionId: "fixture-session", pid: worker.pid,
      threadId: "thr_session", turnId: "turn_session", leaseSec: 180, leaseRenewedAt: now, leaseExpiresAt: now + 180000, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
      logFile: path.join(legacyDir, "jobs", `${id}.log`), request: {} };
    fs.writeFileSync(record.logFile, "");
    fs.writeFileSync(path.join(legacyDir, "jobs", `${id}.json`), JSON.stringify(record, null, 2));
    const legacyState = f.readState(legacyDir); legacyState.jobs.unshift({ ...record }); fs.writeFileSync(path.join(legacyDir, "state.json"), JSON.stringify(legacyState, null, 2));
    // First contact with this workspace comes from the hook itself.
    const hook = new URL("../plugins/codex/scripts/session-lifecycle-hook.mjs", import.meta.url).pathname;
    const end = run(process.execPath, [hook, "SessionEnd"], { cwd: f.repo, env: f.env, input: JSON.stringify({ session_id: "fixture-session", cwd: f.repo }) });
    assert.equal(end.status, 0, end.stderr);
    const legacyRecord = JSON.parse(fs.readFileSync(path.join(legacyDir, "jobs", `${id}.json`)));
    assert.equal(legacyRecord.cancelRequested?.reason, "session_end", "the control reached the record the old worker reads");
    assert.deepEqual(f.marker().pending.map(p => p.id), [id]);
  } finally {
    worker.kill("SIGKILL"); await new Promise(resolve => worker.on("exit", resolve));
  }
});

test("after migration, a job that an older session writes later is still found by id and merged", () => {
  const f = fixture();
  const done = f.json(f.call(["task", "--json", "fixture work"]));
  const legacyDir = f.relocate(f.legacyRoots.oldPluginId);
  f.json(f.call(["status", "--json"]));
  assert.deepEqual(Object.keys(f.marker().sources), [legacyDir]);
  const late = { ...JSON.parse(fs.readFileSync(path.join(legacyDir, "jobs", `${done.jobId}.json`))), id: "task-written-later", threadId: "thr_later", summary: "late", updatedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(legacyDir, "jobs", `${late.id}.json`), JSON.stringify(late, null, 2));
  const state = f.readState(legacyDir); state.jobs.unshift({ id: late.id, status: "completed", jobClass: "task", threadId: "thr_later", summary: "late", updatedAt: late.updatedAt, workspaceRoot: f.repo });
  fs.writeFileSync(path.join(legacyDir, "state.json"), JSON.stringify(state, null, 2));
  assert.equal(f.call(["status", "task-nonexistent", "--json"]).status, 1);
  const found = f.json(f.call(["status", late.id, "--json"]));
  assert.equal(found.job.summary, "late");
  assert.ok(fs.existsSync(path.join(f.stateDir, "jobs", `${late.id}.json`)));
  assert.equal(f.json(f.call(["status", "thr_later", "--json"])).job.id, late.id, "thread references resolve too");
});
