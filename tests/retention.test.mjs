import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { makeTempDir, run, requireLocalSockets } from "./helpers.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { resolveStateDir } from "../plugins/codex/scripts/lib/state.mjs";
import { resolveCodexRuntimeIdentity } from "../plugins/codex/scripts/lib/codex-home.mjs";
import { resolveSessionMarkersRoot } from "../plugins/codex/scripts/lib/session-markers.mjs";
import { resolveRetentionDays, planRetention, applyRetention, applyRetentionWithBroker, runAutomaticRetention } from "../plugins/codex/scripts/lib/retention.mjs";
import { claudeSnapshotFile, writeClaudeSnapshot } from "../plugins/codex/scripts/lib/claude-memory.mjs";
import { instructionInventory } from "../plugins/codex/hooks/claude-memory.mjs";

const DAY = 86400000;
const cli = new URL("../plugins/codex/scripts/codex-companion.mjs", import.meta.url).pathname;
const hook = new URL("../plugins/codex/scripts/session-lifecycle-hook.mjs", import.meta.url).pathname;
function fixture() {
  const root = makeTempDir("retention-"), cwd = path.join(root, "workspace");
  fs.mkdirSync(cwd);
  installFakeCodex(root);
  const env = { ...buildEnv(root), CODEX_COMPANION_HOME: path.join(root, "isolated"), CLAUDE_CONFIG_DIR: path.join(root, "claude") };
  delete env.CODEX_COMPANION_RETENTION_DAYS;
  // Whole seconds: Node 22's utimes stores float seconds, so a millisecond
  // boundary could land just below the cutoff.
  const now = Math.floor(Date.now() / 1000) * 1000, old = new Date(now - 31 * DAY).toISOString(), recent = new Date(now - DAY).toISOString();
  return { root, cwd, env, now, old, recent, home: env.CODEX_COMPANION_HOME };
}
function json(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}
function seedJob(f, id, patch = {}, cwd = f.cwd) {
  const workspace = resolveStateDir(cwd, f.env), directory = path.join(workspace, "jobs");
  fs.mkdirSync(directory, { recursive: true });
  const record = { id, status: "completed", completedAt: f.old, updatedAt: f.old, ownerAttached: false, pid: null, threadId: randomUUID(), ...patch,
    logFile: path.join(directory, `${id}.log`), rawOutputFile: path.join(directory, `${id}.output.txt`), resultFile: path.join(directory, `${id}.result.json`) };
  const file = path.join(directory, `${id}.json`);
  json(file, record);
  for (const target of [record.logFile, record.rawOutputFile, record.resultFile]) fs.writeFileSync(target, "fixture artifact");
  const indexFile = path.join(workspace, "state.json");
  const state = fs.existsSync(indexFile) ? JSON.parse(fs.readFileSync(indexFile)) : { version: 1, config: {}, jobs: [] };
  state.jobs.push(record); json(indexFile, state);
  return { ...record, file, workspace, indexFile, files: [file, record.logFile, record.rawOutputFile, record.resultFile] };
}
function useLegacyPaths(f, job) {
  const legacyLog = path.join(f.root, "legacy", "jobs", `${job.id}.log`);
  fs.mkdirSync(path.dirname(legacyLog), { recursive: true });
  fs.writeFileSync(legacyLog, "retained legacy log");
  const index = JSON.parse(fs.readFileSync(job.indexFile));
  index.jobs.find(item => item.id === job.id).logFile = legacyLog;
  json(job.indexFile, index);
  json(job.file, { ...JSON.parse(fs.readFileSync(job.file)), logFile: legacyLog });
  return legacyLog;
}
function rollout(f, threadId = randomUUID(), date = f.old, name = "2026-01-01T00-00-00") {
  const file = path.join(f.home, "sessions", "2026", "01", "01", `rollout-${name}-${threadId}.jsonl`);
  json(file, { type: "session_meta", payload: { id: threadId } });
  fs.utimesSync(file, new Date(date), new Date(date));
  return file;
}
function marker(f, name, date = f.old) {
  const file = path.join(resolveSessionMarkersRoot(f.env), "session", name);
  json(file, {}); fs.utimesSync(file, new Date(date), new Date(date)); return file;
}
function plan(f, extra = {}) { return planRetention({ now: f.now, env: f.env, ...extra }); }
function cliResult(f, ...args) {
  const result = run(process.execPath, [cli, "cleanup", ...args], { cwd: f.cwd, env: f.env });
  assert.equal(result.status, 0, result.stderr + result.stdout); return JSON.parse(result.stdout);
}

test("SessionEnd deletes only its instruction snapshot and retention rechecks the job cutoff", async () => {
  const f = fixture();
  f.env.CODEX_COMPANION_RETENTION_DAYS = "7";
  const put = (sessionId, date = f.now) => {
    writeClaudeSnapshot({ sessionId, cwd: f.cwd, ...instructionInventory([{ path: "/loaded/CLAUDE.md", kind: "user", content: "Synthetic rule" }]) }, f.env);
    const file = claudeSnapshotFile(sessionId, f.env);
    fs.utimesSync(file, new Date(date), new Date(date));
    return file;
  };
  const ended = put("ended"), other = put("other"), stale = put("stale", f.now - 8 * DAY), recent = put("recent", f.now - 6 * DAY), renewed = put("renewed", f.old);
  const root = path.dirname(ended), unrelated = path.join(root, "keep.json"), outside = path.join(f.root, "outside.json");
  json(unrelated, { keep: true }); json(outside, { keep: true });
  const link = claudeSnapshotFile("link", f.env); fs.symlinkSync(outside, link);
  const end = run(process.execPath, [hook, "SessionEnd"], { cwd: f.cwd, env: f.env, input: JSON.stringify({ session_id: "ended", cwd: f.cwd }) });
  assert.equal(end.status, 0, end.stderr);
  assert.equal(fs.existsSync(ended), false); assert.ok(fs.existsSync(other));
  const p = plan(f);
  assert.deepEqual(p.snapshots.map(file => file.path).sort(), [stale, renewed].sort());
  put("renewed");
  const result = await applyRetention(p);
  assert.equal(result.snapshotsDeleted, 1); assert.deepEqual(result.errors, []);
  assert.equal(fs.existsSync(stale), false);
  for (const file of [other, recent, renewed, unrelated, link, outside]) assert.ok(fs.existsSync(file));
  // Automatic cleanup uses the same configured cutoff after a missed SessionEnd.
  put("stale", f.now - 8 * DAY);
  const automatic = await runAutomaticRetention({ env: f.env, now: f.now });
  assert.equal(automatic.snapshotsDeleted, 1); assert.deepEqual(automatic.errors, []);
  assert.equal(fs.existsSync(stale), false); assert.ok(fs.existsSync(recent));
});

test("automatic retention sweeps only stale owned import copies and leaves fresh copies and symlinks intact", async () => {
  const f = fixture(), projects = path.join(f.env.CLAUDE_CONFIG_DIR, "projects");
  const source = path.join(projects, "repo", "session.jsonl"); json(source, { type: "user" });
  const module = new URL("../plugins/codex/scripts/lib/claude-session-transfer.mjs", import.meta.url).href;
  const probe = run(process.execPath, ["--input-type=module", "-e", `
    import { snapshotClaudeSession } from ${JSON.stringify(module)};
    console.log(JSON.stringify([0, 1, 2].map(() => snapshotClaudeSession(process.cwd(), ${JSON.stringify(source)}).snapshotPath)));
  `], { cwd: f.cwd, env: f.env });
  assert.equal(probe.status, 0, probe.stderr);
  const [old, fresh, unmarked] = JSON.parse(probe.stdout).map(file => path.dirname(file));
  fs.unlinkSync(path.join(unmarked, ".duet-import.json"));
  const backup = path.join(projects, ".duet-import-backup"); fs.renameSync(unmarked, backup);
  const date = new Date(f.now - 2 * 3600000);
  for (const dir of [old, backup]) {
    for (const file of fs.readdirSync(dir)) fs.utimesSync(path.join(dir, file), date, date);
    fs.utimesSync(dir, date, date);
  }
  const outside = path.join(f.root, "outside"); fs.mkdirSync(outside); json(path.join(outside, "keep.jsonl"), { keep: true });
  const link = path.join(projects, ".duet-import-ABC123"); fs.symlinkSync(outside, link);
  const unsafe = fs.mkdtempSync(path.join(projects, ".duet-import-")); fs.chmodSync(unsafe, 0o700);
  fs.symlinkSync(path.join(outside, "keep.jsonl"), path.join(unsafe, "copy.jsonl")); fs.utimesSync(unsafe, date, date);
  const foreign = fs.mkdtempSync(path.join(projects, ".duet-import-")); fs.chmodSync(foreign, 0o700);
  json(path.join(foreign, "notes.txt"), { keep: true }); fs.utimesSync(foreign, date, date);
  const p = plan(f);
  assert.deepEqual(p.imports.map(item => item.path), [old]);
  assert.ok(fs.existsSync(old), "planning does not remove copies");
  const result = await runAutomaticRetention({ env: f.env, now: f.now });
  assert.equal(result.importsDeleted, 1); assert.deepEqual(result.errors, []);
  assert.equal(fs.existsSync(old), false);
  for (const dir of [fresh, backup, outside, link, unsafe, foreign]) assert.ok(fs.existsSync(dir));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(backup, "session.jsonl"))), { type: "user" });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(outside, "keep.jsonl"))), { keep: true });
});

test("retention precedence, default, integer validation and reported one-day clamp", () => {
  const f = fixture();
  assert.equal(resolveRetentionDays(f.env), 30);
  json(path.join(f.env.CLAUDE_CONFIG_DIR, "settings.json"), { cleanupPeriodDays: 45 });
  assert.equal(resolveRetentionDays(f.env), 45);
  assert.equal(resolveRetentionDays({ ...f.env, CODEX_COMPANION_RETENTION_DAYS: "12" }), 12);
  assert.equal(resolveRetentionDays({ ...f.env, CODEX_COMPANION_RETENTION_DAYS: "1.5" }), 45);
  for (const value of ["0", "-10"]) {
    const p = planRetention({ now: f.now, env: { ...f.env, CODEX_COMPANION_RETENTION_DAYS: value } });
    assert.equal(p.days, 1);
  }
  json(path.join(f.env.CLAUDE_CONFIG_DIR, "settings.json"), { cleanupPeriodDays: 0 });
  assert.equal(resolveRetentionDays(f.env), 1); assert.match(plan(f).warnings.join(), /clamped/);
  assert.equal(plan(f, { days: 2 }).days, 2);
  assert.throws(() => plan(f, { days: "bad" }), /integer/);
  const fallbackEnv = { ...f.env, CLAUDE_CONFIG_DIR: "", HOME: path.join(f.root, "home") };
  json(path.join(fallbackEnv.HOME, ".claude", "settings.json"), { cleanupPeriodDays: 18 });
  assert.equal(resolveRetentionDays(fallbackEnv), 18);
});

test("only expired, detached, dead-PID ended jobs and their four artifacts are removed", async () => {
  const f = fixture(), gone = seedJob(f, "expired"), recent = seedJob(f, "recent", { completedAt: f.recent });
  const running = seedJob(f, "running", { status: "running" });
  const queued = seedJob(f, "queued", { status: "queued" });
  const live = seedJob(f, "live", { pid: process.pid });
  const attached = seedJob(f, "attached", { ownerId: "parent", ownerAttached: true });
  const boundary = seedJob(f, "boundary", { completedAt: new Date(f.now - 30 * DAY).toISOString() });
  const fallback = seedJob(f, "fallback", { completedAt: null, updatedAt: f.old });
  const invalidDate = seedJob(f, "invalid-date", { completedAt: "invalid" });
  const p = plan(f);
  assert.deepEqual(p.jobs.map(job => job.jobId), ["expired", "fallback"]);
  assert.deepEqual(p.retained.map(({ jobId, reason }) => [jobId, reason]), [["running", "active"], ["queued", "active"], ["live", "pid-alive"], ["attached", "owner-attached"]]);
  const expectedBytes = [...gone.files, ...fallback.files].reduce((sum, file) => sum + fs.statSync(file).size, 0);
  const result = await applyRetention(p);
  assert.equal(result.jobsDeleted, 2); assert.equal(result.bytesFreed, expectedBytes); assert.deepEqual(result.errors, []);
  assert.deepEqual(result.retained, p.retained);
  for (const file of [...gone.files, ...fallback.files]) assert.equal(fs.existsSync(file), false);
  for (const record of [recent, running, queued, live, attached, boundary, invalidDate]) for (const file of record.files) assert.ok(fs.existsSync(file));
  assert.deepEqual(JSON.parse(fs.readFileSync(gone.indexFile)).jobs.map(job => job.id).sort(), ["attached", "boundary", "invalid-date", "live", "queued", "recent", "running"]);
});

test("all workspaces protect live or unresolved orphans and expire dead orphan and missing records", async () => {
  const f = fixture(), expired = seedJob(f, "expired");
  const elsewhere = path.join(f.root, "deleted-checkout");
  const retained = seedJob(f, "retained", { completedAt: f.recent }, elsewhere);
  const active = seedJob(f, "active", { status: "queued" }, elsewhere);
  const oldRollout = rollout(f, expired.threadId), kept = rollout(f, retained.threadId), activeRollout = rollout(f, active.threadId);
  const orphan = seedJob(f, "orphan", { status: "running", pid: 2147483647 });
  const protectedOrphans = [
    seedJob(f, "orphan-live", { status: "running", pid: process.pid }),
    seedJob(f, "orphan-starting", { status: "queued", createdAt: new Date(f.now).toISOString() }),
    seedJob(f, "orphan-unresolved", { jobClass: "task", status: "failed", result: { failureSource: "transport", turnEnded: false } }),
    seedJob(f, "orphan-recent", { completedAt: f.recent }),
    seedJob(f, "orphan-published", { status: "running" })
  ];
  const missing = seedJob(f, "missing", { status: "running", pid: process.pid });
  fs.unlinkSync(missing.file);
  const orphanIds = new Set([orphan.id, ...protectedOrphans.map(job => job.id)]);
  const index = JSON.parse(fs.readFileSync(orphan.indexFile)); index.jobs = index.jobs.filter(job => !orphanIds.has(job.id)); json(orphan.indexFile, index);
  protectedOrphans.forEach(job => rollout(f, job.threadId));
  const orphanRollout = rollout(f, orphan.threadId), unreferenced = randomUUID(), unreferencedFile = rollout(f, unreferenced);
  const recentFile = rollout(f, randomUUID(), f.recent);
  const duplicate = randomUUID(); rollout(f, duplicate); rollout(f, duplicate, f.recent, "2026-01-02T00-00-00");
  const p = plan(f), calls = [];
  assert.deepEqual(p.threads.map(thread => thread.threadId).sort(), [expired.threadId, orphan.threadId, protectedOrphans.at(-1).threadId, unreferenced].sort());
  // Publication between preview and application restores active-job protection.
  const publishedIndex = JSON.parse(fs.readFileSync(orphan.indexFile));
  publishedIndex.jobs.push(JSON.parse(fs.readFileSync(protectedOrphans.at(-1).file))); json(orphan.indexFile, publishedIndex);
  const result = await applyRetention(p, { deleteThread: async threadId => { calls.push(threadId); return {}; } });
  assert.equal(result.threadsDeleted, 3); assert.equal(result.threadsSkipped, 1); assert.equal(result.jobsDeleted, 3);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(calls.sort(), [expired.threadId, orphan.threadId, unreferenced].sort());
  assert.ok(orphan.files.every(file => !fs.existsSync(file)));
  assert.ok(missing.files.every(file => !fs.existsSync(file)));
  assert.ok(!JSON.parse(fs.readFileSync(missing.indexFile)).jobs.some(job => job.id === missing.id));
  for (const job of protectedOrphans) assert.ok(job.files.every(file => fs.existsSync(file)));
  for (const file of [oldRollout, kept, activeRollout, orphanRollout, unreferencedFile, recentFile]) assert.ok(fs.existsSync(file), "retention itself never unlinks rollouts");

  const alias = fixture(), old = seedJob(alias, "old", { threadId: null });
  const survivors = Array.from({ length: 50 }, (_, i) => seedJob(alias, `survivor-${i}`, { threadId: null, completedAt: alias.recent, updatedAt: alias.recent }));
  const outside = path.join(alias.root, "outside.txt"); fs.writeFileSync(outside, "keep");
  const aliasedIndex = JSON.parse(fs.readFileSync(old.indexFile));
  Object.assign(aliasedIndex.jobs.find(job => job.id === old.id), { logFile: survivors[0].file, rawOutputFile: outside, resultFile: survivors[1].resultFile });
  json(old.indexFile, aliasedIndex);
  const stateModule = new URL("../plugins/codex/scripts/lib/state.mjs", import.meta.url).href;
  const prune = run(process.execPath, ["--input-type=module", "-e", `import { updateState } from ${JSON.stringify(stateModule)}; updateState(process.cwd(), () => {});`], { cwd: alias.cwd, env: alias.env });
  assert.equal(prune.status, 0, prune.stderr);
  assert.ok(old.files.every(file => !fs.existsSync(file)));
  for (const job of survivors) assert.ok(job.files.every(file => fs.existsSync(file)));
  assert.equal(fs.readFileSync(outside, "utf8"), "keep");
});

test("legacy artifact paths retain only their job and thread without blocking unrelated thread cleanup", async () => {
  const f = fixture(), legacy = seedJob(f, "legacy"), normal = seedJob(f, "normal");
  const legacyLog = useLegacyPaths(f, legacy);
  const legacyRollout = rollout(f, legacy.threadId), normalRollout = rollout(f, normal.threadId);
  const p = plan(f);
  assert.deepEqual(p.jobs.map(job => job.jobId), [normal.id]);
  assert.deepEqual(p.threads.map(thread => thread.threadId), [normal.threadId]);
  assert.deepEqual(p.errors, []);
  assert.deepEqual(p.retained, [{ workspace: legacy.workspace, jobId: legacy.id, reason: "legacy-paths" }]);
  const calls = [], result = await applyRetention(p, { deleteThread: async id => { calls.push(id); return {}; } });
  assert.equal(result.jobsDeleted, 1); assert.equal(result.threadsDeleted, 1); assert.equal(result.threadsSkipped, 0);
  assert.deepEqual(calls, [normal.threadId]); assert.deepEqual(result.errors, []); assert.deepEqual(result.retained, p.retained);
  assert.deepEqual(JSON.parse(fs.readFileSync(normal.indexFile)).jobs.map(job => job.id), [legacy.id]);
  assert.ok(normal.files.every(file => !fs.existsSync(file)));
  for (const file of [...legacy.files, legacyLog, legacyRollout, normalRollout]) assert.ok(fs.existsSync(file), file);
});

test("legacy paths discovered after planning are retained without stopping other job or thread deletion", async () => {
  const f = fixture(), legacy = seedJob(f, "changed"), normal = seedJob(f, "normal");
  rollout(f, legacy.threadId); rollout(f, normal.threadId);
  const p = plan(f); assert.equal(p.jobs.length, 2); assert.equal(p.threads.length, 2);
  const legacyLog = useLegacyPaths(f, legacy), calls = [];
  const result = await applyRetention(p, { deleteThread: async id => { calls.push(id); return {}; } });
  assert.equal(result.jobsDeleted, 1); assert.equal(result.threadsDeleted, 1); assert.equal(result.threadsSkipped, 1);
  assert.deepEqual(calls, [normal.threadId]); assert.deepEqual(result.errors, []);
  assert.deepEqual(result.retained, [{ workspace: legacy.workspace, jobId: legacy.id, reason: "legacy-paths" }]);
  assert.deepEqual(p.retained, [], "application must not mutate the preview");
  assert.ok(fs.existsSync(legacyLog)); assert.ok(legacy.files.every(file => fs.existsSync(file)));
});

test("an unreadable index in another workspace still blocks thread planning and application", async () => {
  const f = fixture(), legacy = seedJob(f, "legacy"), normal = seedJob(f, "normal");
  useLegacyPaths(f, legacy); rollout(f, legacy.threadId); rollout(f, normal.threadId);
  const p = plan(f); assert.equal(p.threads.length, 1);
  const other = seedJob(f, "other", {}, path.join(f.root, "other-workspace"));
  const read = fs.readFileSync;
  fs.readFileSync = function(file, ...args) {
    if (file === other.indexFile) throw Object.assign(new Error("fixture state is unreadable"), { code: "EACCES" });
    return read.call(this, file, ...args);
  };
  try {
    const blocked = plan(f);
    assert.deepEqual(blocked.jobs.map(job => job.jobId), [normal.id]);
    assert.deepEqual(blocked.threads, []); assert.equal(blocked.errors.length, 1);
    assert.equal(blocked.errors[0].workspace, other.workspace); assert.match(blocked.errors[0].message, /unreadable/);
    assert.deepEqual(blocked.retained, p.retained);
    const result = await applyRetention(p, { deleteThread: async () => assert.fail("unknown references must block deletion") });
    assert.equal(result.jobsDeleted, 1); assert.equal(result.threadsSkipped, 1); assert.equal(result.threadsDeleted, 0);

  } finally { fs.readFileSync = read; }
});
test("unsupported or failed thread/delete skips threads without touching rollouts or indexes", async () => {
  for (const unsupported of [async () => ({ unsupported: true }), async () => { throw new Error("Unsupported method: thread/delete"); }]) {
    const f = fixture(), file = rollout(f);
    const sqlite = path.join(f.home, "state_5.sqlite"), history = path.join(f.home, "thread_history_1.sqlite");
    fs.writeFileSync(sqlite, "unchanged"); fs.writeFileSync(history, "unchanged");
    const result = await applyRetention(plan(f), { deleteThread: unsupported });
    assert.equal(result.threadsDeleted, 0); assert.equal(result.threadsSkipped, 1); assert.equal(result.bytesFreed, 0); assert.equal(result.errors.length, 1);
    assert.ok(fs.existsSync(file)); assert.equal(fs.readFileSync(sqlite, "utf8"), "unchanged"); assert.equal(fs.readFileSync(history, "utf8"), "unchanged");
  }
});

test("markers use the same cutoff, preserve newer files and ignore symlinks", async () => {
  const f = fixture(), old = marker(f, "old.json"), recent = marker(f, "recent.json", f.recent), temp = marker(f, ".old.tmp");
  const outside = path.join(f.root, "outside"); json(path.join(outside, "old.json"), {});
  fs.symlinkSync(outside, path.join(resolveSessionMarkersRoot(f.env), "linked"));
  const linkedFile = path.join(path.dirname(old), "linked.json"); fs.symlinkSync(path.join(outside, "old.json"), linkedFile);
  const boundary = marker(f, "boundary.json", new Date(f.now - 30 * DAY).toISOString());
  const p = plan(f); assert.deepEqual(p.markers.map(file => path.basename(file.path)).sort(), [".old.tmp", "old.json"]);
  const result = await applyRetention(p);
  assert.equal(result.markersDeleted, 2); assert.equal(fs.existsSync(old), false); assert.equal(fs.existsSync(temp), false);
  for (const file of [recent, linkedFile, boundary, path.join(outside, "old.json")]) assert.ok(fs.existsSync(file));
});

test("apply rechecks owner attachment, private records, mtimes and new cross-workspace references", async () => {
  const f = fixture(), job = seedJob(f, "changed"), file = rollout(f, job.threadId), markerFile = marker(f, "freshened.json");
  const secondId = randomUUID(), freshenedRollout = rollout(f, secondId), thirdId = randomUUID(); rollout(f, thirdId);
  const p = plan(f);
  json(job.file, { ...JSON.parse(fs.readFileSync(job.file)), ownerAttached: true });
  fs.utimesSync(markerFile, new Date(f.recent), new Date(f.recent));
  fs.utimesSync(freshenedRollout, new Date(f.recent), new Date(f.recent));
  seedJob(f, "new-reference", { threadId: thirdId, completedAt: f.recent }, path.join(f.root, "other"));
  const result = await applyRetention(p, { deleteThread: async () => assert.fail("stale plans must be revalidated") });
  assert.equal(result.jobsDeleted, 0); assert.equal(result.markersDeleted, 0); assert.equal(result.threadsSkipped, 3);
  assert.deepEqual(result.retained, [{ workspace: job.workspace, jobId: job.id, reason: "owner-attached" }]);
  for (const target of [...job.files, file, markerFile, freshenedRollout]) assert.ok(fs.existsSync(target));

  // Reuse unchanged records from the preview, but never a replaced file or a
  // symlink, even when the replacement's size and mtime match the preview.
  const g = fixture(), unchanged = seedJob(g, "unchanged"), replaced = seedJob(g, "replaced");
  const preview = plan(g), stat = fs.statSync(replaced.file);
  const replacement = `${replaced.file}.tmp`;
  fs.writeFileSync(replacement, fs.readFileSync(replaced.file, "utf8").replace('"ownerAttached":false', '"ownerAttached":true '));
  fs.utimesSync(replacement, stat.atime, stat.mtime);
  fs.renameSync(replacement, replaced.file);
  assert.equal(fs.statSync(replaced.file).size, stat.size);
  const read = fs.readFileSync, reads = [];
  fs.readFileSync = function(file, ...args) {
    if ([unchanged.file, replaced.file].includes(file)) reads.push(file);
    return read.call(this, file, ...args);
  };
  try {
    const applied = await applyRetention(preview);
    assert.equal(applied.jobsDeleted, 1); assert.deepEqual(applied.errors, []);
    assert.deepEqual(reads, [replaced.file]);
    assert.ok(fs.existsSync(replaced.file)); assert.equal(fs.existsSync(unchanged.file), false);
  } finally { fs.readFileSync = read; }
  const h = fixture(), linked = seedJob(h, "linked"), linkPlan = plan(h);
  const outside = path.join(h.root, "outside.json");
  fs.renameSync(linked.file, outside); fs.symlinkSync(outside, linked.file);
  const refused = await applyRetention(linkPlan);
  assert.equal(refused.jobsDeleted, 0); assert.equal(refused.errors.length, 1);
  assert.ok(fs.existsSync(outside)); assert.ok(fs.lstatSync(linked.file).isSymbolicLink());
});

test("unreadable state or a busy workspace lock skips the workspace and all thread deletion", async () => {
  for (const fault of ["bad-index", "bad-private", "locked", "symlink", "pending-legacy"]) {
    const f = fixture(), job = seedJob(f, "protected"); rollout(f, job.threadId);
    if (fault === "pending-legacy") json(path.join(job.workspace, ".legacy-migration.json"), { pending: [{ id: "live-legacy" }] });
    if (fault === "bad-index") fs.writeFileSync(job.indexFile, "{broken");
    if (fault === "bad-private") fs.writeFileSync(job.file, "{broken");
    if (fault === "locked") { fs.mkdirSync(path.join(job.workspace, ".state-lock")); fs.writeFileSync(path.join(job.workspace, ".state-lock", `owner-${process.pid}-${randomUUID()}`), ""); }
    if (fault === "symlink") { const moved = path.join(f.root, "state-outside"); fs.renameSync(job.workspace, moved); fs.symlinkSync(moved, job.workspace); }
    const p = plan(f); assert.equal(p.jobs.length, 0, fault); assert.equal(p.threads.length, 0, fault); assert.ok(p.errors.length, fault);
    const result = await applyRetention(p, { deleteThread: async () => assert.fail("unsafe scan") });
    assert.equal(result.jobsDeleted, 0); for (const file of job.files) assert.ok(fs.existsSync(file));
  }
});

test("a lock acquired after planning times out safely and keeps that job's thread", async () => {
  const f = fixture(), job = seedJob(f, "locked"); rollout(f, job.threadId); const p = plan(f);
  const lock = path.join(job.workspace, ".state-lock"); fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, `owner-${process.pid}-${randomUUID()}`), "");
  const result = await applyRetention(p, { deleteThread: async () => assert.fail("locked reference") });
  assert.equal(result.jobsDeleted, 0); assert.equal(result.threadsSkipped, 1);
  assert.ok(job.files.every(file => fs.existsSync(file)));
});

test("unsafe artifact paths are retained and the existing count cap cannot evict unselected jobs", async () => {
  const f = fixture(), job = seedJob(f, "unsafe"), index = JSON.parse(fs.readFileSync(job.indexFile));
  const sqlite = path.join(f.home, "state_5.sqlite"); fs.writeFileSync(sqlite, "never delete");
  index.jobs[0].logFile = sqlite; json(job.indexFile, index);
  assert.equal(plan(f).jobs.length, 0); assert.deepEqual(plan(f).errors, []);
  assert.deepEqual(plan(f).retained, [{ workspace: job.workspace, jobId: job.id, reason: "legacy-paths" }]);
  assert.equal((await applyRetention(plan(f))).jobsDeleted, 0); assert.ok(fs.existsSync(sqlite));
  const g = fixture(); seedJob(g, "expired");
  for (let i = 0; i < 51; i++) seedJob(g, `recent-${i}`, { completedAt: g.recent, threadId: null });
  const result = await applyRetention(plan(g));
  assert.equal(result.jobsDeleted, 0); assert.match(result.errors[0].message, /unselected/);
});

test("artifact removal errors are reported with actual partial counts and do not escape", async () => {
  const f = fixture(), job = seedJob(f, "partial"), p = plan(f), unlink = fs.unlinkSync;
  fs.unlinkSync = function(file, ...args) {
    if (file === job.logFile) throw Object.assign(new Error("fixture unlink denied"), { code: "EACCES" });
    return unlink.call(this, file, ...args);
  };
  let result;
  try { result = await applyRetention(p); } finally { fs.unlinkSync = unlink; }
  assert.equal(result.jobsDeleted, 1); assert.match(result.errors[0].message, /unlink denied/);
  assert.equal(result.bytesFreed, p.jobs[0].bytes - [job.logFile, job.rawOutputFile, job.resultFile].reduce((sum, file) => sum + fs.statSync(file).size, 0));
  assert.equal(fs.existsSync(job.file), false); assert.ok(fs.existsSync(job.logFile));
});

test("automatic cleanup persists its report, serializes overlapping runs and waits 12 hours", async () => {
  const f = fixture(), id = randomUUID(); rollout(f, id);
  let release; const pending = new Promise(resolve => { release = resolve; });
  const first = runAutomaticRetention({ env: f.env, now: f.now, deleteThread: async () => { await pending; return {}; } });
  const concurrent = await runAutomaticRetention({ env: f.env, now: f.now, deleteThread: async () => assert.fail("concurrent") });
  assert.equal(concurrent.reason, "locked"); release();
  assert.equal((await first).threadsDeleted, 1);
  const file = path.join(f.home, "duet", "retention.json"), saved = JSON.parse(fs.readFileSync(file));
  assert.equal(saved.lastRunAt, new Date(f.now).toISOString()); assert.equal(saved.lastReport.threadsDeleted, 1);
  const before = await runAutomaticRetention({ env: f.env, now: f.now + 12 * 3600000 - 1, deleteThread: async () => assert.fail("too early") });
  assert.equal(before.reason, "interval");
  const after = await runAutomaticRetention({ env: f.env, now: f.now + 12 * 3600000, deleteThread: async () => ({}) });
  assert.equal(after.threadsDeleted, 1);
});

test("cleanup dry-run is read-only, apply uses its candidates and ignores automatic throttling", async () => {
  const f = fixture(), old = seedJob(f, "old"), recent = seedJob(f, "recent", { completedAt: f.recent }); marker(f, "old.json");
  json(path.join(f.home, "duet", "retention.json"), { lastRunAt: new Date(f.now).toISOString(), lastReport: {} });
  const before = fs.readFileSync(old.indexFile, "utf8"), p = cliResult(f, "--dry-run", "--json");
  assert.equal(p.jobs.length, 1); assert.equal(p.markers.length, 1); assert.equal(p.threads.length, 0);
  assert.equal(fs.readFileSync(old.indexFile, "utf8"), before); assert.ok(old.files.every(file => fs.existsSync(file)));
  assert.equal(fs.existsSync(path.join(old.workspace, "broker.json")), false);
  const result = cliResult(f, "--json");
  assert.equal(result.jobsDeleted, p.jobs.length); assert.equal(result.markersDeleted, p.markers.length);
  assert.ok(recent.files.every(file => fs.existsSync(file))); assert.ok(old.files.every(file => !fs.existsSync(file)));
  assert.equal(cliResult(f, "--days", "0", "--dry-run", "--json").days, 1);
  const bad = run(process.execPath, [cli, "cleanup", "--days", "1.5"], { cwd: f.cwd, env: f.env });
  assert.equal(bad.status, 1); assert.match(bad.stderr, /integer/);

  const g = fixture(), stateRoot = path.dirname(resolveStateDir(g.cwd, g.env));
  const age = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) age(file);
      else if (!entry.isSymbolicLink()) fs.utimesSync(file, new Date(g.old), new Date(g.old));
    }
    fs.utimesSync(directory, new Date(g.old), new Date(g.old));
  };
  const leftover = (name, record = { id: "old", status: "completed" }) => {
    const cwd = path.join(g.root, name); fs.mkdirSync(cwd);
    const directory = resolveStateDir(cwd, g.env);
    json(path.join(directory, "jobs", "old.json"), record);
    fs.writeFileSync(path.join(directory, "jobs", "broken.json"), "{broken");
    age(directory);
    return directory;
  };
  const safe = leftover("safe"), deadLock = leftover("dead-lock"), recentTree = leftover("recent"), activeTree = leftover("active", { id: "old", status: "running" });
  const liveTree = leftover("live", { id: "old", status: "completed", pid: process.pid });
  const unresolved = leftover("unresolved", { id: "old", status: "failed", jobClass: "task", result: { failureSource: "transport", turnEnded: false } });
  const brokerTree = leftover("broker"), journalTree = leftover("journal"), unknown = leftover("unknown", {}), linked = leftover("linked"), changed = leftover("changed");
  const foreign = path.join(stateRoot, "another-tool"), foreignArtifact = leftover("foreign-artifact"), markerless = leftover("markerless");
  json(path.join(foreign, "config.json"), { tool: "unrelated" }); fs.writeFileSync(path.join(foreign, "data.db"), "foreign data"); age(foreign);
  fs.writeFileSync(path.join(foreignArtifact, "jobs", "data.db"), "foreign data"); age(foreignArtifact);
  fs.rmSync(path.join(markerless, "jobs"), { recursive: true }); age(markerless);
  json(path.join(unknown, ".legacy-migration.json"), { pending: [] }); age(unknown);
  const closedRun = path.join(safe, "runs", "run-closed");
  json(path.join(closedRun, "jobs", "old.brief.md"), "brief");
  json(path.join(closedRun, "jobs", "old.report.json"), { status: "completed" });
  fs.writeFileSync(path.join(closedRun, "journal.jsonl"), [
    { type: "run_started", runId: "run-closed", recordedAt: g.old },
    { type: "run_closed", recordedAt: g.recent }
  ].map(row => JSON.stringify(row)).join("\n") + "\n"); age(safe);
  json(path.join(brokerTree, "broker.json"), {}); age(brokerTree);
  json(path.join(journalTree, "runs", "run-open", "journal.jsonl"), { type: "run_started", runId: "run-open", recordedAt: g.recent }); age(journalTree);
  fs.mkdirSync(path.join(deadLock, ".state-lock")); fs.writeFileSync(path.join(deadLock, ".state-lock", "owner-2147483647-00000000-0000-0000-0000-000000000000"), ""); age(deadLock);
  fs.symlinkSync(path.join(safe, "jobs", "old.json"), path.join(linked, "outside")); age(linked);
  fs.utimesSync(path.join(recentTree, "jobs", "old.json"), new Date(g.recent), new Date(g.recent));
  const pendingWrite = leftover("pending-write");
  fs.writeFileSync(path.join(pendingWrite, "jobs", `.old.json.${process.pid}.${randomUUID()}.tmp`), "temporary"); age(pendingWrite);
  const snapshot = directory => Object.fromEntries(fs.readdirSync(directory).map(name => {
    const file = path.join(directory, name), stat = fs.lstatSync(file);
    return [name, { ino: stat.ino, mtime: stat.mtimeMs, ctime: stat.ctimeMs, mode: stat.mode,
      value: stat.isDirectory() ? snapshot(file) : stat.isSymbolicLink() ? fs.readlinkSync(file) : fs.readFileSync(file).toString("base64") }];
  }));
  const beforeTrees = snapshot(stateRoot), preview = cliResult(g, "--dry-run", "--json");
  // Old id-less/unparsable artifacts are ignored only inside a proven layout.
  assert.deepEqual(preview.inertWorkspaces.map(item => item.workspace).sort(), [safe, deadLock, changed, unknown].sort());
  assert.deepEqual(snapshot(stateRoot), beforeTrees);
  assert.equal(fs.existsSync(path.join(g.home, "duet", "quarantine")), false);
  for (const workspace of [recentTree, activeTree, liveTree, unresolved, brokerTree, journalTree, linked]) assert.ok(preview.workspacesRetained.some(item => item.workspace === workspace));
  assert.ok(preview.workspacesRetained.some(item => item.workspace === foreignArtifact && item.reason === "unknown-content"));
  for (const workspace of [foreign, markerless]) assert.equal(preview.workspacesRetained.some(item => item.workspace === workspace), false);
  assert.ok(preview.workspacesRetained.some(item => item.workspace === pendingWrite && item.reason === "pending-write"));
  const pending = plan(g);
  json(path.join(changed, "jobs", "old.json"), { id: "old", status: "running" });
  const beforeApply = snapshot(stateRoot), applied = await applyRetention(pending);
  assert.equal(applied.inertWorkspaces.length, 3); assert.deepEqual(applied.errors, []);
  assert.ok(applied.workspacesRetained.some(item => item.workspace === changed));
  assert.deepEqual(snapshot(stateRoot), beforeApply);
  for (const result of [preview, applied]) for (const field of ["quarantine", "expiredQuarantine", "workspacesQuarantined", "quarantineDeleted"]) assert.equal(Object.hasOwn(result, field), false);
  // Pre-release quarantine directories are no longer inspected or expired.
  const quarantineRoot = path.join(g.home, "duet", "quarantine");
  fs.cpSync(foreignArtifact, path.join(quarantineRoot, `${path.basename(foreignArtifact)}-${Date.now()}`), { recursive: true }); age(quarantineRoot);
  const beforeQuarantine = snapshot(quarantineRoot);
  await applyRetention(planRetention({ now: Date.now() + 31 * DAY, env: g.env }));
  assert.deepEqual(snapshot(quarantineRoot), beforeQuarantine);
  leftover("automatic");
  const beforeAutomatic = snapshot(stateRoot), automatic = await runAutomaticRetention({ env: g.env, now: g.now });
  assert.ok(automatic.inertWorkspaces.some(item => path.basename(item.workspace).startsWith("automatic-")));
  assert.deepEqual(snapshot(stateRoot), beforeAutomatic);

  const h = fixture(), workspace = resolveStateDir(h.cwd, h.env), thread = randomUUID();
  json(path.join(workspace, "jobs", "victim.json"), { turnId: "unique" });
  json(path.join(workspace, ".legacy-migration.json"), { pending: [] }); age(workspace);
  rollout(h, thread);
  const noJobs = path.join(path.dirname(workspace), "another-tool");
  json(path.join(noJobs, "config.json"), { tool: "unrelated" }); age(noJobs);
  const beforeNoJobs = snapshot(noJobs);
  const inventoryUrl = new URL("../plugins/codex/scripts/lib/job-runtime.mjs", import.meta.url).href;
  const inventory = () => {
    const result = run(process.execPath, ["--input-type=module", "-e", `import {recordedThreadJobs} from ${JSON.stringify(inventoryUrl)}; console.log(JSON.stringify(recordedThreadJobs('unique')));`], { cwd: h.cwd, env: h.env });
    assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
  };
  assert.equal(inventory().complete, true);
  const inertPlan = plan(h), beforeInert = snapshot(workspace), deleted = [];
  assert.deepEqual(inertPlan.inertWorkspaces.map(item => item.workspace), [workspace]);
  assert.deepEqual(inertPlan.threads.map(item => item.threadId), [thread]);
  const inertReport = await applyRetention(inertPlan, { deleteThread: async id => { deleted.push(id); return {}; } });
  assert.equal(inertReport.inertWorkspaces.length, 1); assert.deepEqual(inertReport.errors, []);
  assert.deepEqual(deleted, [thread]); assert.equal(inertReport.threadsDeleted, 1);
  assert.deepEqual(snapshot(workspace), beforeInert);
  assert.deepEqual(snapshot(noJobs), beforeNoJobs);
  // The inventory exemption uses a fixed 24-hour age, not retention's 30 days.
  fs.utimesSync(path.join(workspace, "jobs", "victim.json"), new Date(), new Date());
  assert.equal(inventory().complete, false);
  fs.utimesSync(path.join(workspace, "jobs", "victim.json"), new Date(h.now - 2 * DAY), new Date(h.now - 2 * DAY));
  assert.equal(inventory().complete, true); assert.equal(plan(h).inertWorkspaces.length, 0);
  age(workspace);
  fs.writeFileSync(path.join(workspace, "jobs", "broken.json"), "{broken"); age(workspace);
  assert.equal(inventory().complete, true);

  // A real private-record/index writer waits on a fixture-held lock while
  // cleanup runs. Cleanup must neither disturb its reservation nor move jobs/.
  const racePlan = plan(h), ready = path.join(h.root, "writer-ready"), output = path.join(h.root, "writer-result.json");
  const lock = path.join(workspace, ".state-lock"), owner = path.join(lock, `owner-${process.pid}-${randomUUID()}`);
  fs.mkdirSync(lock); fs.writeFileSync(owner, "");
  const stateUrl = new URL("../plugins/codex/scripts/lib/state.mjs", import.meta.url).href;
  const childCode = `import fs from 'node:fs'; import path from 'node:path'; import {upsertJob,writeJobFile} from ${JSON.stringify(stateUrl)};
    const mkdir = fs.mkdirSync; fs.mkdirSync = function(p, ...args) { const result = mkdir.call(this, p, ...args); if (path.basename(p).startsWith('.owner-')) fs.writeFileSync(${JSON.stringify(ready)}, 'ready'); return result; };
    try { const job = {id:'new', status:'queued', workspaceRoot:${JSON.stringify(h.cwd)}}; writeJobFile(${JSON.stringify(h.cwd)}, job.id, job); upsertJob(${JSON.stringify(h.cwd)}, job); fs.writeFileSync(${JSON.stringify(output)}, JSON.stringify({ok:true})); }
    catch (error) { fs.writeFileSync(${JSON.stringify(output)}, JSON.stringify({ok:false, code:error.code, message:error.message})); process.exitCode = 1; }`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", childCode], { cwd: h.cwd, env: h.env, stdio: "ignore" });
  const exited = new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
  let race;
  try {
    const until = Date.now() + 5000;
    while (!fs.existsSync(ready) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    assert.ok(fs.existsSync(ready), "writer reserved its lock");
    race = await applyRetention(racePlan, { deleteThread: async () => assert.fail("new writer protects threads") });
  } finally { fs.unlinkSync(owner); fs.rmdirSync(lock); await exited; }
  assert.deepEqual(JSON.parse(fs.readFileSync(output)), { ok: true });
  assert.equal(race.inertWorkspaces.length, 0); assert.equal(race.threadsSkipped, 1);
  assert.deepEqual(race.errors.map(error => error.threadId), [thread]);
  assert.ok(race.workspacesRetained.some(item => item.workspace === workspace));
  assert.ok(JSON.parse(fs.readFileSync(path.join(workspace, "state.json"))).jobs.some(job => job.id === "new"));
  assert.equal(JSON.parse(fs.readFileSync(path.join(workspace, "jobs", "new.json"))).id, "new");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(workspace, "jobs", "victim.json"))), { turnId: "unique" });

});

test("prewarm runs retention after broker startup and real broker unsupported RPC leaves rollout intact", async t => {
  if (!await requireLocalSockets(t)) return;
  const f = fixture(), job = seedJob(f, "old"), file = rollout(f, job.threadId); marker(f, "old.json");
  // Give fixture setup a full readiness budget under parallel suite load. The
  // hook's short startup budget is covered by the existing lifecycle tests;
  // this case verifies retention reuses the ready broker without another spawn.
  const lifecycle = new URL("../plugins/codex/scripts/lib/broker-lifecycle.mjs", import.meta.url).href;
  const ready = run(process.execPath, ["--input-type=module", "-e", `
    import { ensureBrokerSession } from ${JSON.stringify(lifecycle)};
    if (!await ensureBrokerSession(process.cwd(), { timeoutMs: 10000 })) throw new Error('Fixture broker did not become ready');
  `], { cwd: f.cwd, env: f.env });
  assert.equal(ready.status, 0, ready.stderr);
  const result = run(process.execPath, [hook, "prewarm", f.cwd], { cwd: f.cwd, env: f.env });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(fs.readFileSync(path.join(f.home, "duet", "retention.json"))).lastReport;
  assert.equal(report.jobsDeleted, 1); assert.equal(report.markersDeleted, 1); assert.equal(report.threadsSkipped, 1);
  assert.match(report.errors[0].message, /Unsupported method: thread\/delete/); assert.ok(fs.existsSync(file));
  const starts = JSON.parse(fs.readFileSync(path.join(f.root, "fake-codex-state.json"))).appServerStarts;
  assert.equal(starts, 1, "cleanup uses the prewarmed broker without another runtime");
  const manual = cliResult(f, "--json"); assert.equal(manual.threadsSkipped, 1);
});

test("broker deletion uses thread/delete and never falls back to a private runtime", async t => {
  if (!await requireLocalSockets(t)) return;
  const f = fixture(), id = randomUUID(), file = rollout(f, id), calls = [];
  const socket = path.join(f.root, "broker.sock"), connections = new Set();
  const server = net.createServer(connection => {
    connections.add(connection); connection.on("close", () => connections.delete(connection));
    connection.setEncoding("utf8"); let buffer = "";
    connection.on("data", chunk => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n"), message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        if (!message.id) continue;
        calls.push(message);
        const result = message.method === "initialize" ? { codexCompanionHome: fs.realpathSync(f.home), codexCompanionRuntime: resolveCodexRuntimeIdentity(f.env) } : {};
        connection.write(`${JSON.stringify({ id: message.id, result })}\n`);
      }
    });
  });
  await new Promise(resolve => server.listen(socket, resolve));
  try {
    const report = await applyRetentionWithBroker(plan(f), { cwd: f.cwd, env: f.env, broker: { endpoint: `unix:${socket}` } });
    assert.equal(report.threadsDeleted, 1, JSON.stringify(report.errors)); assert.deepEqual(calls.find(call => call.method === "thread/delete").params, { threadId: id });
    assert.ok(fs.existsSync(file));
  } finally { for (const connection of connections) connection.destroy(); await new Promise(resolve => server.close(resolve)); }
  const disconnected = await applyRetentionWithBroker(plan(f), { cwd: f.cwd, env: f.env, broker: { endpoint: `unix:${socket}` } });
  assert.equal(disconnected.threadsSkipped, 1); assert.match(disconnected.errors[0].message, /private startup refused/);
  assert.equal(fs.existsSync(path.join(f.root, "fake-codex-state.json")), false);
});
