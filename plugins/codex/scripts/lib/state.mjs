import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { resolveIsolatedCodexHome } from "./codex-home.mjs";
import { nearestGitBoundary, resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;
const MAX_THREAD_ANCHORS = 200;
const STATE_BASELINE = Symbol("stateBaseline");
const LOCK_TIMEOUT_MS = 10000;
const LOCK_WAIT = new Int32Array(new SharedArrayBuffer(4));
// Legacy-state merge: a busy legacy lock is retried later, never waited on for long.
const LEGACY_MIGRATION_FILE = ".legacy-migration.json";
const LEGACY_LOCK_TIMEOUT_MS = 1500;
const LEGACY_RETRY_MS = 10000;
const isActiveStatus = status => status === "queued" || status === "running";

function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {
      stopReviewGate: false
    },
    jobs: []
  };
}

// One directory per workspace, named by its basename plus a hash of its
// canonical path; the same key is used under every state root, old or new.
function workspaceKey(workspaceRoot) {
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  return `${slug}-${hash}`;
}

// Job state lives in the isolated Codex home, next to duet/config.toml: one
// location whatever the plugin is called and however the helper is invoked.
// CLAUDE_PLUGIN_DATA is derived from the plugin id, which changed when the
// marketplace was renamed, and the temp-dir fallback could be cleared; both are
// read only as legacy sources below.
export function resolveStateRoot(env = process.env) {
  return path.join(resolveIsolatedCodexHome(env), "duet", "state");
}

export function resolveStateDir(cwd, env = process.env) {
  return resolveStateDirForRoot(resolveWorkspaceRoot(cwd), env);
}

// Recorded roots are Git toplevels or non-Git folders outside any repository,
// so mapping them must not spawn Git per job. Older/noncanonical records can
// contain a subdirectory or symlink instead; those keep Git's resolution,
// cached per path by resolveWorkspaceRoot.
export function resolveStateDirForRoot(root, env = process.env) {
  try {
    const real = fs.realpathSync.native(root), boundary = nearestGitBoundary(real);
    if (boundary !== null && boundary !== root) root = resolveWorkspaceRoot(root);
  } catch { /* Deleted workspaces retain their original path-based key. */ }
  return path.join(resolveStateRoot(env), workspaceKey(root));
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

function createStateDir(stateDir) {
  fs.mkdirSync(path.join(stateDir, JOBS_DIR_NAME), { recursive: true, mode: 0o700 });
}

export function ensureStateDir(cwd) {
  createStateDir(resolveStateDir(cwd));
}

function isDirectory(candidate) {
  try { return fs.statSync(candidate).isDirectory(); } catch { return false; }
}
function within(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
function canonical(candidate) {
  try { return fs.realpathSync.native(candidate); } catch { return path.resolve(candidate); }
}
function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== "ESRCH"; }
}

// Roots used by earlier releases, newest layout first. Only existing directories
// are returned; in test mode only directories inside the test root.
export function legacyStateRoots(env = process.env) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const pluginData = path.join(home, ".claude", "plugins", "data");
  const candidates = [
    env.CLAUDE_PLUGIN_DATA ? path.join(env.CLAUDE_PLUGIN_DATA, "state") : null,
    path.join(pluginData, "codex-duet", "state"),
    path.join(pluginData, "codex-codex-isolated-local", "state"),
    path.join(env.TMPDIR ? path.resolve(env.TMPDIR) : os.tmpdir(), "codex-companion-isolated")
  ].filter(Boolean);
  const current = resolveStateRoot(env);
  const testRoot = env.CODEX_COMPANION_TEST_MODE === "1" ? canonical(env.CODEX_COMPANION_TEST_ROOT || "") : null;
  const roots = [];
  for (const candidate of candidates) {
    if (!isDirectory(candidate)) continue;
    const resolved = canonical(candidate);
    if (roots.includes(resolved) || within(current, resolved) || within(resolved, current)) continue;
    if (testRoot && !within(testRoot, resolved)) continue;
    roots.push(resolved);
  }
  return roots;
}

function readState(stateFile) {
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return {
      ...defaultState(),
      ...parsed,
      config: {
        ...defaultState().config,
        ...(parsed.config ?? {})
      },
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
    };
  } catch {
    return defaultState();
  }
}

// Enumerable symbols survive {...state} in SessionEnd, but never enter JSON.
function snapshot(state) {
  return Object.assign(state, { [STATE_BASELINE]: structuredClone(state) });
}

export function loadState(cwd) {
  const stateDir = resolveStateDir(cwd);
  ensureMigrated(stateDir);
  return snapshot(readState(path.join(stateDir, STATE_FILE_NAME)));
}

function removeFileIfExists(filePath) {
  if (!filePath) return;
  try { fs.unlinkSync(filePath); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}

function removeEmptyDirectory(dir) {
  try { fs.rmdirSync(dir); }
  catch (error) {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error;
  }
}

function reclaimDeadLock(lockDir, deadOwnerGraceMs = 0) {
  let owners;
  try { owners = fs.readdirSync(lockDir); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  for (const owner of owners) {
    const match = /^owner-(\d+)-[a-f0-9-]+$/.exec(owner);
    if (!match) return;
    try { process.kill(Number(match[1]), 0); }
    catch (error) {
      if (error.code !== "ESRCH") continue;
      const marker = path.join(lockDir, owner);
      if (deadOwnerGraceMs > 0) {
        // The marker is written once when acquiring the lock, never renewed.
        // Inspect that unique marker so another reclaimer's new lock is safe.
        try { if (Date.now() - fs.statSync(marker).mtimeMs < deadOwnerGraceMs) return; }
        catch (error) { if (error.code === "ENOENT") continue; throw error; }
      }
      removeFileIfExists(marker);
    }
  }
  // A new owner's unique marker prevents a concurrent reaper from deleting it.
  removeEmptyDirectory(lockDir);
}

// Publish the PID marker with the lock, so a crash never leaves an ownerless
// reservation. The returned release may span async work; contention never waits.
export function tryAcquirePidLock(lockDir, { deadOwnerGraceMs = 0 } = {}) {
  const owner = `owner-${process.pid}-${randomUUID()}`;
  const candidate = `${lockDir}.${owner}`;
  fs.mkdirSync(candidate, { mode: 0o700 });
  let acquired = false;
  try {
    fs.writeFileSync(path.join(candidate, owner), "", { flag: "wx", mode: 0o600 });
    for (let attempt = 0; attempt < 2; attempt++) {
      try { fs.renameSync(candidate, lockDir); acquired = true; break; }
      catch (error) {
        if (!["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(error.code)) throw error;
        if (attempt === 0) reclaimDeadLock(lockDir, deadOwnerGraceMs);
      }
    }
    if (!acquired) return null;
    return () => {
      if (!acquired) return;
      removeFileIfExists(path.join(lockDir, owner));
      removeEmptyDirectory(lockDir);
      acquired = false;
    };
  } finally {
    if (!acquired) {
      removeFileIfExists(path.join(candidate, owner));
      removeEmptyDirectory(candidate);
    }
  }
}

// The lock protocol is shared with earlier releases, so a legacy directory can
// be locked the same way while an older session may still be writing to it.
const HELD_LOCKS = new Set();
function lockStateDir(stateDir, action, { lockTimeoutMs = LOCK_TIMEOUT_MS, create = true } = {}) {
  if (HELD_LOCKS.has(stateDir)) throw new Error(`Re-entrant Codex job-state lock: ${stateDir}`);
  if (create) createStateDir(stateDir);
  const lockDir = path.join(stateDir, ".state-lock");
  const owner = `owner-${process.pid}-${randomUUID()}`;
  const candidate = path.join(stateDir, `.${owner}`);
  fs.mkdirSync(candidate, { mode: 0o700 });
  let acquired = false;
  try {
    fs.writeFileSync(path.join(candidate, owner), "", { flag: "wx", mode: 0o600 });
    const deadline = Date.now() + lockTimeoutMs;
    while (!acquired) {
      try {
        // Rename publishes the directory with its owner already present. An
        // existing nonempty lock cannot be replaced, even after a crash.
        fs.renameSync(candidate, lockDir);
        acquired = true;
      } catch (error) {
        if (!["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(error.code)) throw error;
        reclaimDeadLock(lockDir);
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for the Codex job-state lock: ${lockDir}`);
        Atomics.wait(LOCK_WAIT, 0, 0, 10);
      }
    }
    HELD_LOCKS.add(stateDir);
    return action(stateDir);
  } finally {
    HELD_LOCKS.delete(stateDir);
    if (acquired) {
      removeFileIfExists(path.join(lockDir, owner));
      removeEmptyDirectory(lockDir);
    } else {
      removeFileIfExists(path.join(candidate, owner));
      removeEmptyDirectory(candidate);
    }
  }
}

function withStateLock(cwd, action, options = {}) {
  const stateDir = resolveStateDir(cwd);
  return lockStateDir(stateDir, () => {
    migrateUnderLock(stateDir);
    return action(stateDir);
  }, options);
}

// Journal callers validate/create their private directory first. Reuse the
// state lock without migration, index writes or job-count pruning.
export function withJournalLock(stateDir, action, options = {}) {
  return lockStateDir(stateDir, action, { ...options, create: false });
}

function writeJsonAtomically(filePath, value) {
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, filePath);
  } finally {
    removeFileIfExists(temporary);
  }
}

// Shared with admission and retention: a dead wrapper is not proof that its
// Codex turn ended. Keep the historical predicate's process check unchanged.
function taskProcessAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== "ESRCH"; }
}

export function unresolvedTask(current) {
  if (!current || current.jobClass !== "task" || current.recovered || taskProcessAlive(current.pid)) return false;
  if (!current.result) return current.status !== "cancelled";
  // A stopped job whose interrupt was never confirmed may still own its turn.
  if (["interrupted", "cancelled"].includes(current.status)) {
    return Boolean(current.turnId) && current.result.turnEnded === false && current.result.interruptionConfirmed !== true;
  }
  const result = current.result;
  if (current.status === "completed" && result.inferredCompletion === true) {
    return Boolean(current.turnId) && result.turnEnded === false;
  }
  if (current.status !== "failed" || result.turnEnded || result.structured) return false;
  if (result.failureSource === "transport") return true;
  // Older wrappers stored only the transport's literal diagnostic. Worker
  // outcomes carry workerStatus/structured output or an observed turn end.
  if (result.workerStatus) return false;
  return result.errorCode === "BROKER_CONNECTION_CLOSED" ||
    /^(Codex broker connection closed during startup\.|Connection to Codex closed while the turn was running\.|Codex connection closed before turn completion; recover the recorded job\.)$/i.test(result.error ?? current.errorMessage ?? "");
}

export function startedThreadSettings(job) {
  if (!job || [job.recovery?.turnStatus, job.result?.turnStatus].includes("notStarted")) return false;
  if (job.turnId || job.result?.turnId || job.report?.turnId) return true;
  // A completed thread/start RPC establishes settings when the first turn's
  // handle was not delivered. Merely requesting/reserving a thread does not.
  return Boolean(job.threadId) && [job, job.result, job.report].some(source => {
    const timing = source?.startupTimings?.threadStart;
    return Number.isFinite(timing) || Number.isFinite(timing?.durationMs);
  });
}

// The visible history retains its old count limit; extra thread anchors are
// available to inheritance and admission, not added to status listings.
export function visibleJobs(jobs, recordForJob = job => job) {
  let historyCount = 0;
  return [...jobs]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    .filter(job => isActiveStatus(job.status) || unresolvedTask(recordForJob(job)) || historyCount++ < MAX_JOBS);
}

const PRUNE_RECORDS = new Map();
const MAX_PRUNE_RECORDS = MAX_JOBS + MAX_THREAD_ANCHORS;
const sameRecord = (left, right) => left.ino === right.ino && left.mtimeMs === right.mtimeMs && left.size === right.size && left.ctimeMs === right.ctimeMs;
function readPruneRecord(file) {
  try {
    const before = fs.statSync(file), cached = PRUNE_RECORDS.get(file);
    if (cached && sameRecord(cached.stat, before)) return cached.value;
    PRUNE_RECORDS.delete(file);
    const value = JSON.parse(fs.readFileSync(file, "utf8")), after = fs.statSync(file);
    if (sameRecord(before, after)) {
      if (PRUNE_RECORDS.size >= MAX_PRUNE_RECORDS) PRUNE_RECORDS.delete(PRUNE_RECORDS.keys().next().value);
      PRUNE_RECORDS.set(file, { stat: after, value });
    }
    return value;
  } catch {
    PRUNE_RECORDS.delete(file);
    return null;
  }
}

function pruneJobs(jobs, stateDir, imports = new Map()) {
  const ordered = [...jobs].sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
  const finished = ordered.filter(job => !isActiveStatus(job.status));
  // These jobs fit the visible history even if none are unresolved. No private
  // record can change membership, so cursor/lease writes need no payload scan.
  if (finished.length <= MAX_JOBS) return ordered;
  const threadOrder = [...finished].sort((left, right) =>
    String(right.createdAt ?? right.startedAt ?? right.updatedAt ?? "").localeCompare(String(left.createdAt ?? left.startedAt ?? left.updatedAt ?? "")) || right.id.localeCompare(left.id));
  const grouped = new Map();
  for (const job of threadOrder) {
    if (!job.threadId) continue;
    if (!grouped.has(job.threadId) && grouped.size < MAX_THREAD_ANCHORS) grouped.set(job.threadId, []);
    grouped.get(job.threadId)?.push(job);
  }
  const guaranteed = new Set(finished.slice(0, MAX_JOBS).map(job => job.id));
  // A thread with one attempt has an unambiguous anchor. Multiple attempts
  // still need the private started/unresolved predicates below, unchanged.
  for (const attempts of grouped.values()) if (attempts.length === 1) guaranteed.add(attempts[0].id);
  if (finished.every(job => guaranteed.has(job.id))) return ordered;

  // The index intentionally omits result. Consult private records for the
  // predicate without publishing their output in the index or status views.
  const records = new Map();
  const recordFor = job => {
    if (job.jobClass !== "task") return job;
    if (!records.has(job.id)) records.set(job.id, { ...job, ...(imports.get(job.id)?.file ?? readPruneRecord(path.join(stateDir, JOBS_DIR_NAME, `${job.id}.json`))) });
    return records.get(job.id);
  };
  const visible = new Set(visibleJobs(jobs, recordFor).map(job => job.id));
  const threads = new Map();
  // Match inheritance's job order: an old job's cursor/lease update must not
  // displace the later turn that recorded the thread's current settings. A
  // newer refused or never-started attempt must not displace it either.
  for (const job of threadOrder) {
    if (!job.threadId) continue;
    const anchor = threads.get(job.threadId);
    if (!anchor) {
      if (threads.size < MAX_THREAD_ANCHORS) threads.set(job.threadId, { id: job.id, started: startedThreadSettings(recordFor(job)) });
    } else if (!anchor.started && startedThreadSettings(recordFor(job))) Object.assign(anchor, { id: job.id, started: true });
  }
  const anchors = new Set([...threads.values()].map(anchor => anchor.id));
  return ordered
    .filter(job => visible.has(job.id) || anchors.has(job.id));
}

// ---------------------------------------------------------------------------
// Legacy-state migration
//
// Earlier releases stored this workspace's jobs under one of legacyStateRoots().
// The first access to a workspace under the new root merges every legacy copy
// in, once, under the new directory's lock (so concurrent starters serialize
// and the second one finds the marker). A legacy job whose worker process is
// still alive is not copied: that worker keeps writing its own record, so the
// job is served in place from the legacy directory until it ends, then merged.
// Records keep their format; artifact paths (log/raw/result) stay where they
// are and remain readable. Nothing is deleted from a legacy directory.
// ---------------------------------------------------------------------------
const MIGRATION = new Map();

function readJsonOrNull(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}
function markerFileOf(stateDir) { return path.join(stateDir, LEGACY_MIGRATION_FILE); }
function markerMtime(stateDir) {
  try { return fs.statSync(markerFileOf(stateDir)).mtimeMs; } catch { return 0; }
}
function readMarker(stateDir) {
  const marker = readJsonOrNull(markerFileOf(stateDir));
  if (!marker || marker.version !== 1 || typeof marker.sources !== "object" || !Array.isArray(marker.pending)) {
    return { version: 1, migratedAt: null, sources: {}, pending: [] };
  }
  return marker;
}
function writeMarker(stateDir, marker) {
  writeJsonAtomically(markerFileOf(stateDir), { ...marker, migratedAt: nowIso() });
}
// Index entries never carry raw results or the activity journal (see updateJob).
function indexEntryOf(record) {
  const { result, report, rendered, activity, ...entry } = record;
  const interruptionReason = result?.interruptionReason ?? report?.interruptionReason;
  if (interruptionReason) Object.assign(entry, { interruptionReason, interruptionConfirmed: result?.interruptionConfirmed ?? report?.interruptionConfirmed });
  return entry;
}
const updatedAtOf = (...records) => records.reduce((latest, record) => {
  const value = String(record?.updatedAt ?? "");
  return value > latest ? value : latest;
}, "");

// Every job a directory knows: index entries plus private job files (a file
// may briefly exist before its index entry does).
function readWorkspaceRecords(dir, onlyId = null) {
  const state = readState(path.join(dir, STATE_FILE_NAME));
  const records = new Map();
  for (const job of state.jobs) {
    if (typeof job?.id === "string" && (onlyId === null || job.id === onlyId)) records.set(job.id, { id: job.id, index: job, file: null });
  }
  let names = [];
  if (onlyId !== null) names = [`${onlyId}.json`];
  else { try { names = fs.readdirSync(path.join(dir, JOBS_DIR_NAME)); } catch (error) { if (error.code !== "ENOENT") throw error; } }
  for (const name of names) {
    const match = /^(.+)\.json$/.exec(name);
    if (!match || name.endsWith(".result.json")) continue;
    const record = readJsonOrNull(path.join(dir, JOBS_DIR_NAME, name));
    if (!record || typeof record !== "object" || Array.isArray(record)) continue;
    const id = match[1], entry = records.get(id) ?? { id, index: null, file: null };
    entry.file = { id, ...record };
    records.set(id, entry);
  }
  return { config: state.config, records };
}
function readLegacyRecords(legacyDir, onlyId = null, { lockTimeoutMs = LEGACY_LOCK_TIMEOUT_MS } = {}) {
  try {
    return lockStateDir(legacyDir, () => readWorkspaceRecords(legacyDir, onlyId), { lockTimeoutMs: Math.min(lockTimeoutMs, LEGACY_LOCK_TIMEOUT_MS), create: false });
  } catch (error) {
    if (/Timed out waiting for the Codex job-state lock/.test(error.message)) return null;
    throw error;
  }
}
const isLive = (record, fallbackPid = null) => isActiveStatus(record?.status) && processAlive(record?.pid ?? fallbackPid);

// Merge selected legacy records into the (already locked) new directory.
// Newer updatedAt wins; a live legacy job is only noted as pending.
function mergeLegacyRecords(stateDir, legacyDir, legacy, marker, selected = null) {
  const stateFile = path.join(stateDir, STATE_FILE_NAME), jobsDir = path.join(stateDir, JOBS_DIR_NAME);
  const state = readState(stateFile), current = new Map(state.jobs.map(job => [job.id, job]));
  const imports = new Map();
  let pending = 0;
  for (const { id, index, file } of legacy.records.values()) {
    if (selected && !selected.has(id)) continue;
    const entry = withoutPrivateActivity({ ...(index ?? {}), ...(file ? indexEntryOf(file) : {}) });
    if (isLive(entry)) {
      if (!marker.pending.some(item => item.id === id)) marker.pending.push({ id, stateDir: legacyDir, pid: entry.pid ?? null, noticedAt: nowIso() });
      pending += 1;
      continue;
    }
    const existing = current.get(id), existingFile = readJsonOrNull(path.join(jobsDir, `${id}.json`));
    if ((existing || existingFile) && !(updatedAtOf(entry, file) > updatedAtOf(existing, existingFile))) continue;
    imports.set(id, { entry, file });
  }
  if (!imports.size) {
    // Carry over a configured review gate when this directory is still at defaults.
    const config = selected ? state.config : mergeLegacyConfig(state.config, legacy.config);
    if (!isDeepStrictEqual(config, state.config)) commitState(stateDir, state, { ...state, config });
    return { at: nowIso(), imported: 0, pending };
  }
  const merged = new Map(current);
  for (const [id, { entry }] of imports) merged.set(id, entry);
  const retained = new Set(pruneJobs([...merged.values()], stateDir, imports).map(job => job.id));
  for (const [id, { file }] of imports) {
    if (file && retained.has(id)) writeJsonAtomically(path.join(jobsDir, `${id}.json`), file);
  }
  commitState(stateDir, state, { ...state, config: selected ? state.config : mergeLegacyConfig(state.config, legacy.config), jobs: [...merged.values()] });
  return { at: nowIso(), imported: imports.size, pending };
}
function mergeLegacyConfig(config, legacyConfig) {
  const defaults = defaultState().config, next = { ...config };
  for (const [key, value] of Object.entries(legacyConfig ?? {})) {
    if (!Object.hasOwn(next, key) || isDeepStrictEqual(next[key], defaults[key])) next[key] = value;
  }
  return next;
}

// Re-check jobs served in place; merge each one as soon as its worker is gone.
function settlePending(stateDir, marker, lockOptions = {}) {
  let changed = false;
  for (const item of [...marker.pending]) {
    const legacy = isDirectory(item.stateDir) ? readLegacyRecords(item.stateDir, item.id, lockOptions) : { config: {}, records: new Map() };
    if (legacy === null) continue;
    const record = legacy.records.get(item.id);
    if (record && isLive(record.file ?? record.index, record.index?.pid ?? item.pid)) continue;
    marker.pending = marker.pending.filter(other => other !== item);
    if (record) mergeLegacyRecords(stateDir, item.stateDir, legacy, marker, new Set([item.id]));
    changed = true;
  }
  return changed;
}

function remember(stateDir, marker, retryAt = null) {
  const status = { pending: marker.pending, retryAt, markerMtimeMs: markerMtime(stateDir), checkedAt: Date.now() };
  MIGRATION.set(stateDir, status);
  return status;
}
const PENDING_RECHECK_MS = 1000;

// Runs with the new directory's lock held. Cheap once memoized: a process
// scans for legacy directories once; only pending (in-place) jobs are re-read.
function migrateUnderLock(stateDir, lockOptions = {}) {
  const memo = MIGRATION.get(stateDir);
  const retryDue = memo?.retryAt != null && Date.now() >= memo.retryAt;
  if (memo && !retryDue && (!memo.pending.length || Date.now() - memo.checkedAt < PENDING_RECHECK_MS)) return memo;
  const marker = readMarker(stateDir);
  let changed = false, retryAt = null;
  if (!memo || retryDue) {
    const key = path.basename(stateDir);
    for (const root of legacyStateRoots()) {
      const legacyDir = path.join(root, key);
      if (marker.sources[legacyDir] || !isDirectory(legacyDir)) continue;
      const legacy = readLegacyRecords(legacyDir, null, lockOptions);
      if (legacy === null) { retryAt = Date.now() + LEGACY_RETRY_MS; continue; }
      marker.sources[legacyDir] = mergeLegacyRecords(stateDir, legacyDir, legacy, marker);
      changed = true;
    }
  }
  if (marker.pending.length && settlePending(stateDir, marker, lockOptions)) changed = true;
  if (changed || !fs.existsSync(markerFileOf(stateDir))) writeMarker(stateDir, marker);
  return remember(stateDir, marker, retryAt);
}

// Read paths call this before touching the directory. The fast path is a map
// lookup; while jobs are pending, the marker is re-read when another process
// has changed it.
function ensureMigrated(stateDir, lockOptions = {}) {
  let memo = MIGRATION.get(stateDir);
  if (memo && !memo.pending.length && (memo.retryAt == null || Date.now() < memo.retryAt)) return memo;
  if (memo?.pending.length) {
    if (markerMtime(stateDir) !== memo.markerMtimeMs) memo = remember(stateDir, readMarker(stateDir), memo.retryAt);
    if (Date.now() - memo.checkedAt < PENDING_RECHECK_MS) return memo;
  }
  // Inside this process's own critical section the lock is already held.
  if (HELD_LOCKS.has(stateDir)) return migrateUnderLock(stateDir, lockOptions);
  return lockStateDir(stateDir, () => migrateUnderLock(stateDir, lockOptions), lockOptions);
}

// A job served in place lives in its legacy directory until its worker ends.
function jobStateDir(cwd, jobId, lockOptions = {}) {
  const stateDir = resolveStateDir(cwd);
  const status = ensureMigrated(stateDir, lockOptions);
  return status.pending.find(item => item.id === jobId)?.stateDir ?? stateDir;
}
function pendingJobs(stateDir, status) {
  const jobs = [];
  for (const item of status.pending) {
    const entry = readState(path.join(item.stateDir, STATE_FILE_NAME)).jobs.find(job => job.id === item.id)
      ?? readJsonOrNull(path.join(item.stateDir, JOBS_DIR_NAME, `${item.id}.json`));
    if (entry) jobs.push(indexEntryOf({ id: item.id, ...entry }));
  }
  return jobs;
}

// Fallback for a job id (or thread id / id prefix) unknown to the new
// directory after migration, for example one written by a still-running older
// session: merge it in, or serve it in place while its worker is alive.
export function importLegacyJob(cwd, reference) {
  if (!reference) return false;
  const stateDir = resolveStateDir(cwd), key = path.basename(stateDir);
  const matches = record => record.id === reference || record.file?.threadId === reference || record.index?.threadId === reference || record.id.startsWith(reference);
  for (const root of legacyStateRoots()) {
    const legacyDir = path.join(root, key);
    if (!isDirectory(legacyDir)) continue;
    const legacy = readLegacyRecords(legacyDir);
    if (legacy === null) continue;
    const selected = new Set([...legacy.records.values()].filter(matches).map(record => record.id));
    if (!selected.size) continue;
    return lockStateDir(stateDir, () => {
      const marker = readMarker(stateDir);
      const outcome = mergeLegacyRecords(stateDir, legacyDir, legacy, marker, selected);
      writeMarker(stateDir, marker);
      remember(stateDir, marker, MIGRATION.get(stateDir)?.retryAt ?? null);
      return outcome.imported > 0 || outcome.pending > 0;
    });
  }
  return false;
}

function mergeChangedFields(baseline, requested, current) {
  const merged = { ...current };
  for (const key of new Set([...Object.keys(baseline), ...Object.keys(requested)])) {
    if (Object.hasOwn(baseline, key) === Object.hasOwn(requested, key) && isDeepStrictEqual(baseline[key], requested[key])) continue;
    if (Object.hasOwn(requested, key)) merged[key] = requested[key];
    else delete merged[key];
  }
  return merged;
}

function mergeSnapshot(state, current) {
  const baseline = state[STATE_BASELINE];
  if (!baseline) return state;
  const previousJobs = new Map(baseline.jobs.map(job => [job.id, job]));
  const requestedJobs = new Map((state.jobs ?? []).map(job => [job.id, job]));
  const currentJobs = new Map(current.jobs.map(job => [job.id, job]));
  for (const id of previousJobs.keys()) {
    if (!requestedJobs.has(id)) currentJobs.delete(id);
  }
  for (const [id, job] of requestedJobs) {
    const previous = previousJobs.get(id);
    if (!previous) currentJobs.set(id, { ...currentJobs.get(id), ...job });
    else if (currentJobs.has(id)) currentJobs.set(id, mergeChangedFields(previous, job, currentJobs.get(id)));
  }
  return {
    config: mergeChangedFields(baseline.config, state.config ?? {}, current.config),
    jobs: [...currentJobs.values()]
  };
}

function commitState(stateDir, previousState, state) {
  const nextJobs = pruneJobs(state.jobs ?? [], stateDir);
  const nextState = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(state.config ?? {})
    },
    jobs: nextJobs
  };

  writeJsonAtomically(path.join(stateDir, STATE_FILE_NAME), nextState);
  const retainedIds = new Set(nextJobs.map((job) => job.id));
  // Include records rejected by this very update, whose private files may
  // already have been written before their first index publication.
  const candidates = new Map([...previousState.jobs, ...(state.jobs ?? [])].map(job => [job.id, job]));
  for (const job of candidates.values()) {
    if (retainedIds.has(job.id)) {
      continue;
    }
    // Index paths may be stale legacy paths or aliases of another job. Only
    // remove this job's canonical files, without following a jobs-dir symlink.
    const directory = path.join(stateDir, JOBS_DIR_NAME);
    if (typeof job.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(job.id) || !fs.lstatSync(directory, { throwIfNoEntry: false })?.isDirectory()) continue;
    for (const suffix of [".json", ".log", ".output.txt", ".result.json"]) {
      const file = path.join(directory, `${job.id}${suffix}`);
      if (fs.lstatSync(file, { throwIfNoEntry: false })?.isFile()) removeFileIfExists(file);
    }
  }

  return snapshot(nextState);
}

export function saveState(cwd, state) {
  return withStateLock(cwd, stateDir => {
    const current = readState(path.join(stateDir, STATE_FILE_NAME));
    return commitState(stateDir, current, mergeSnapshot(state, current));
  });
}

// Retention already knows the canonical state directory, including workspaces
// whose checkout no longer exists. Never migrate or use readState's forgiving
// fallback here: an unreadable index must not authorize deletion.
export function removeJobsFromState(stateDir, select, options = {}) {
  return lockStateDir(stateDir, () => {
    const state = JSON.parse(fs.readFileSync(path.join(stateDir, STATE_FILE_NAME), "utf8"));
    if (!Array.isArray(state?.jobs)) throw new Error("Invalid job-state index.");
    const ids = new Set(select(state));
    const removed = state.jobs.filter(job => ids.has(job.id));
    const jobs = state.jobs.filter(job => !ids.has(job.id));
    // Ordinary updates still enforce the count cap. Cleanup must not let that
    // cap evict additional records outside its checked retention candidates.
    if (pruneJobs(jobs, stateDir).length !== jobs.length) throw new Error("Retention would prune unselected jobs.");
    if (removed.length) commitState(stateDir, state, { ...state, jobs });
    return removed;
  }, { lockTimeoutMs: 0, ...options, create: false });
}

export function updateState(cwd, mutate) {
  return withStateLock(cwd, stateDir => {
    const stateFile = path.join(stateDir, STATE_FILE_NAME);
    const previousState = readState(stateFile);
    const state = structuredClone(previousState);
    mutate(state);
    return commitState(stateDir, previousState, state);
  });
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

// Pairing state belongs only to the private job file, never the index or reports.
export function withoutPrivateActivity(job) {
  if (!job) return job;
  const { activityPendingTools, ...visible } = job;
  return visible;
}

export function upsertJob(cwd, jobPatch) {
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
    if (existingIndex === -1) {
      state.jobs.unshift(withoutPrivateActivity({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...jobPatch
      }));
      return;
    }
    state.jobs[existingIndex] = withoutPrivateActivity({
      ...state.jobs[existingIndex],
      ...jobPatch,
      updatedAt: timestamp
    });
  });
}

// Jobs still served in place from a legacy directory are listed alongside,
// replacing any stale copy of the same id.
export function listJobs(cwd) {
  const stateDir = resolveStateDir(cwd);
  const status = ensureMigrated(stateDir);
  const jobs = readState(path.join(stateDir, STATE_FILE_NAME)).jobs;
  if (!status.pending.length) return jobs;
  const pending = pendingJobs(stateDir, status), ids = new Set(pending.map(job => job.id));
  return [...jobs.filter(job => !ids.has(job.id)), ...pending];
}

// SessionEnd can run from the parent checkout while workers use other worktrees.
// Inspect only this plugin-data root, and verify each record's workspace mapping.
export function listSessionJobs(cwd, sessionId) {
  const ownDir = resolveStateDir(cwd), root = path.dirname(ownDir);
  // Jobs an older release started in this workspace's legacy directory are
  // merged or served in place first; a busy lock is not waited on (the hook has
  // a 5 s budget) and the owner lease remains the fallback.
  let pending = [];
  try { pending = pendingJobs(ownDir, ensureMigrated(ownDir, { lockTimeoutMs: 1000 })); } catch { /* reported by the lease fallback */ }
  if (!fs.existsSync(root)) return [];
  const pendingIds = new Set(pending.map(job => job.id));
  return fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).flatMap(entry => {
    const directory = path.join(root, entry.name);
    const indexed = readState(path.join(directory, STATE_FILE_NAME)).jobs.filter(job => directory !== ownDir || !pendingIds.has(job.id));
    return [...indexed, ...(directory === ownDir ? pending : [])].map(job => ({
      ...job, workspaceRoot: job.workspaceRoot ?? (directory === ownDir ? cwd : null)
    })).filter(job => {
      if ((job.sessionId === undefined ? job.ownerId : job.sessionId) !== sessionId || typeof job.workspaceRoot !== "string") return false;
      try { return resolveStateDirForRoot(job.workspaceRoot) === directory; } catch { return false; }
    });
  });
}

export function setConfig(cwd, key, value) {
  return updateState(cwd, (state) => {
    state.config = {
      ...state.config,
      [key]: value
    };
  });
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

export function writeJobFile(cwd, jobId, payload) {
  return lockStateDir(jobStateDir(cwd, jobId), stateDir => {
    const jobFile = path.join(stateDir, JOBS_DIR_NAME, `${jobId}.json`);
    writeJsonAtomically(jobFile, payload);
    return jobFile;
  });
}

export function readJobFile(jobFile) {
  return JSON.parse(fs.readFileSync(jobFile, "utf8"));
}

// One lock covers both the full record and index, including concurrent lease,
// answer, cancellation and progress updates. A stale reader cannot erase them.
export function updateJob(cwd, jobId, mutate, options = {}) {
  return lockStateDir(jobStateDir(cwd, jobId, { lockTimeoutMs: options.lockTimeoutMs }), stateDir => {
    const state = readState(path.join(stateDir, STATE_FILE_NAME));
    const file = path.join(stateDir, JOBS_DIR_NAME, `${jobId}.json`);
    const indexed = state.jobs.find(j => j.id === jobId);
    const current = fs.existsSync(file) ? { ...indexed, ...readJobFile(file) } : indexed;
    if (!current) throw new Error("Job record not found.");
    const patch = mutate(structuredClone(current));
    if (patch == null) return current;
    const next = { ...current, ...patch, updatedAt: nowIso() };
    writeJsonAtomically(file, next);
    const jobs = state.jobs.filter(j => j.id !== jobId);
    // Keep raw results/output and the activity journal in the private job file.
    // Status reads the index: cursor updates after completion must not copy raw
    // tool payloads into its output, or duplicate a growing journal there.
    const { result, report, rendered, activity, activityPendingTools, ...indexedNext } = next;
    const interruptionReason = result?.interruptionReason ?? report?.interruptionReason;
    if (interruptionReason) Object.assign(indexedNext, { interruptionReason, interruptionConfirmed: result?.interruptionConfirmed ?? report?.interruptionConfirmed });
    commitState(stateDir, state, { ...state, jobs: [indexedNext, ...jobs] });
    return next;
  }, options);
}

export function resolveJobLogFile(cwd, jobId) {
  const stateDir = jobStateDir(cwd, jobId);
  createStateDir(stateDir);
  return path.join(stateDir, JOBS_DIR_NAME, `${jobId}.log`);
}

export function resolveJobFile(cwd, jobId) {
  const stateDir = jobStateDir(cwd, jobId);
  createStateDir(stateDir);
  return path.join(stateDir, JOBS_DIR_NAME, `${jobId}.json`);
}
