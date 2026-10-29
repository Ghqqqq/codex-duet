import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolveIsolatedCodexHome } from "./codex-home.mjs";
import { resolveStateRoot, resolveStateDirForRoot, removeJobsFromState, unresolvedTask } from "./state.mjs";
import { spawnOwned } from "./process.mjs";
import { inertIndexlessWorkspace } from "./indexless-state.mjs";
import { resolveSessionMarkersRoot, planSessionMarkers, pruneSessionMarkers } from "./session-markers.mjs";
import { planRuns, pruneRuns, RUN_SESSIONS_DIR } from "./run-journal.mjs";
import { CodexAppServerClient } from "./app-server.mjs";
import { ensureBrokerSession } from "./broker-lifecycle.mjs";
import { CLAUDE_MEMORY_DIR, planClaudeSnapshots, pruneClaudeSnapshots } from "./claude-memory.mjs";
import { planClaudeImports, sweepClaudeImports } from "./claude-session-transfer.mjs";
import { planAgentNames, pruneAgentNames } from "./agent-names.mjs";

const DAY = 86400000;
const INTERVAL = 12 * 60 * 60 * 1000;
const RECONCILE_LIMIT = 5;
const MAINTENANCE_BUDGET_MS = 5000;
const LOST_TURN_GRACE_MS = 30 * 60 * 1000;
const LEASE_MARGIN_MS = 60 * 1000;
const CONTEXT = Symbol("retentionContext");
const active = job => ["queued", "running"].includes(job.status);
const safeId = id => typeof id === "string" && /^[A-Za-z0-9_-]+$/.test(id);
const errorEntry = (scope, error) => ({ ...scope, message: error instanceof Error ? error.message : String(error) });
const RETAIN_ARTIFACT_PATHS = "RETAIN_ARTIFACT_PATHS";
const artifactPathRetention = () => Object.assign(new Error("Noncanonical artifact paths; retaining job."), { code: RETAIN_ARTIFACT_PATHS });
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
}
function integer(value) {
  if (!["string", "number"].includes(typeof value) || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}
function retentionPolicy(env, override) {
  const warnings = [];
  let requested = integer(override), source = "--days";
  if (override !== undefined && requested === null) throw new Error("--days must be an integer.");
  if (override === undefined) {
    requested = integer(env.CODEX_COMPANION_RETENTION_DAYS);
    source = "CODEX_COMPANION_RETENTION_DAYS";
    if (env.CODEX_COMPANION_RETENTION_DAYS !== undefined && requested === null) warnings.push("Invalid CODEX_COMPANION_RETENTION_DAYS; using Claude settings or 30 days.");
    if (requested === null) {
      source = "cleanupPeriodDays";
      const settings = path.join(env.CLAUDE_CONFIG_DIR || path.join(env.HOME || env.USERPROFILE || os.homedir(), ".claude"), "settings.json");
      try {
        const value = JSON.parse(fs.readFileSync(settings, "utf8")).cleanupPeriodDays;
        requested = integer(value);
        if (value !== undefined && requested === null) warnings.push("Invalid cleanupPeriodDays; using 30 days.");
      } catch (error) { if (error.code !== "ENOENT") warnings.push(`Cannot read Claude retention settings; using 30 days: ${error.message}`); }
    }
    if (requested === null) { requested = 30; source = "default"; }
  }
  if (requested < 1) warnings.push(`${source} was ${requested}; clamped to 1 day.`);
  return { days: Math.max(1, requested), source, warnings };
}
export function resolveRetentionDays(env = process.env) {
  return retentionPolicy(env).days;
}

function realDirectory(directory) {
  if (!fs.lstatSync(directory).isDirectory() || fs.realpathSync(directory) !== directory) throw new Error(`Unsafe directory (symlink or not a directory): ${directory}`);
}
function regularStat(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) throw new Error(`Not a regular file: ${file}`);
    return stat;
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
function readJson(file, cache = null) {
  const before = regularStat(file);
  if (!before) { cache?.delete(file); return null; }
  const cached = cache?.get(file);
  if (cached && cached.stat.ino === before.ino && cached.stat.mtimeMs === before.mtimeMs && cached.stat.size === before.size && cached.stat.ctimeMs === before.ctimeMs) return cached.value;
  cache?.delete(file);
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  const after = regularStat(file);
  if (!after || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.size !== after.size) throw new Error(`Record changed while reading: ${file}`);
  cache?.set(file, { stat: after, value });
  return value;
}

// Check every recorded activity time, not just completedAt: a renewed lease or
// a later owner must win over an old wrapper outcome. Missing/invalid history
// is not evidence that it is safe to reconcile automatically.
function staleTask(job, now, requireUnresolved = true) {
  if (!job || job.jobClass !== "task" || active(job) || job.ownerAttached || alive(job.pid) || alive(job.launcherPid) || (requireUnresolved && !unresolvedTask(job))) return false;
  if (!job.threadId || !job.turnId || typeof job.workspaceRoot !== "string" || !path.isAbsolute(job.workspaceRoot)) return false;
  const times = [job.createdAt, job.startedAt, job.updatedAt, job.completedAt].filter(value => value != null).map(value => Date.parse(value));
  if (job.leaseRenewedAt != null) times.push(Number(job.leaseRenewedAt));
  const lease = Number(job.leaseSec ?? 1800) * 1000;
  if (!times.length || times.some(value => !Number.isFinite(value)) || !Number.isFinite(lease) || lease < 0) return false;
  if (now - Math.max(...times) < Math.max(LOST_TURN_GRACE_MS, lease + LEASE_MARGIN_MS)) return false;
  return job.leaseExpiresAt == null || (Number.isFinite(Number(job.leaseExpiresAt)) && now >= Number(job.leaseExpiresAt) + LEASE_MARGIN_MS);
}

// Run in a short-lived child with the requested isolated environment. This
// avoids changing the caller's process.env for the exact recovery machinery.
export async function reconcileAutomaticTask(file, now, deadline) {
  const workspace = path.dirname(path.dirname(file)), env = process.env;
  const read = () => {
    realDirectory(resolveStateRoot(env)); realDirectory(workspace); realDirectory(path.dirname(file));
    if (path.dirname(workspace) !== resolveStateRoot(env) || fs.existsSync(path.join(workspace, ".state-lock"))) return null;
    const job = readJson(file);
    if (!staleTask(job, now) || resolveStateDirForRoot(job.workspaceRoot, env) !== workspace || path.basename(file) !== `${job.id}.json`) return null;
    const index = readJson(path.join(workspace, "state.json"))?.jobs?.find(item => item.id === job.id);
    if (!index || !staleTask({ ...job, ...index, result: job.result }, now)) return null;
    artifactFiles(workspace, job); // Recovery writes artifacts; reject foreign paths.
    return job;
  };
  const job = read();
  if (!job || Date.now() >= deadline) return false;
  const { readAppServerTurn } = await import("./codex.mjs");
  const result = await readAppServerTurn(job.workspaceRoot, job, { env, deadline });
  // Unavailable/in-progress turns remain byte-for-byte unchanged. Do not let
  // failed observations repeatedly reset the age of an unresolved record.
  if (!result?.turnEnded || Date.now() >= deadline) return false;
  const latest = read();
  if (!latest || latest.threadId !== job.threadId || latest.turnId !== job.turnId) return false;
  const { reconcileLostTurn } = await import("../codex-companion.mjs");
  const recovered = await reconcileLostTurn(latest.workspaceRoot, latest, { turnResult: result });
  return recovered.recovery?.status === "recovered";
}

async function recoverInEnvironment(file, now, deadline, env) {
  const source = `import { reconcileAutomaticTask } from ${JSON.stringify(import.meta.url)};
    try { console.log(JSON.stringify(await reconcileAutomaticTask(...JSON.parse(process.argv[1])))); }
    catch { process.exitCode = 1; }`;
  const child = spawnOwned(process.execPath, ["--input-type=module", "-e", source, JSON.stringify([file, now, deadline - 1000])],
    { env, stdio: ["ignore", "pipe", "ignore"] });
  let output = "";
  child.stdout.on("data", chunk => { if (output.length < 100) output += chunk; });
  // The reader closes its owned client first. This final ceiling also bounds
  // synchronous state-lock contention after the RPC has finished.
  const timeout = setTimeout(() => child.kill("SIGKILL"), Math.max(1, deadline - Date.now()));
  try {
    return await new Promise(resolve => {
      child.once("error", () => resolve(false));
      child.once("close", code => resolve(code === 0 && output.trim() === "true"));
    });
  } finally { clearTimeout(timeout); }
}

function pruneMissingJobMarkers({ env, jobFiles = null, deadline = Infinity, limit = 100, after = "" }) {
  const report = { markersDeleted: 0, bytesFreed: 0, errors: [], cursor: after };
  const root = resolveSessionMarkersRoot(env);
  function* candidates() {
    try {
      realDirectory(root);
      // Include the separator so session order agrees with full-path cursors.
      const sessions = fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)
        .sort((a, b) => a + path.sep < b + path.sep ? -1 : a + path.sep > b + path.sep ? 1 : 0);
      // Resume after the previous scan, wrapping once. Examine at most limit
      // marker files, including retained ones, so old live markers cannot starve
      // later sessions and the pass never parses the entire marker history.
      for (const wrap of [false, true]) for (const session of sessions) {
        if (Date.now() >= deadline) return;
        const directory = path.join(root, session);
        try {
          realDirectory(directory);
          for (const name of fs.readdirSync(directory).sort()) {
            if (!name.endsWith(".json")) continue;
            const file = path.join(directory, name);
            if ((file <= after) !== wrap) continue;
            yield file;
          }
        } catch (error) { report.errors.push(errorEntry({ path: directory }, error)); }
      }
    } catch (error) { if (error.code !== "ENOENT") report.errors.push(errorEntry({ path: root }, error)); }
  }
  let scanned = 0;
  for (const candidate of candidates()) {
    if (Date.now() >= deadline || scanned++ >= limit) break;
    report.cursor = candidate;
    try {
      if (!fs.lstatSync(candidate).isFile()) continue;
      const marker = readJson(candidate), file = marker?.jobFile;
      if (!safeId(marker?.jobId) || typeof file !== "string" || !path.isAbsolute(file) || path.basename(candidate) !== `${marker.jobId}.json`) continue;
      if (jobFiles && !jobFiles.has(file)) continue;
      const jobs = path.dirname(file), workspace = path.dirname(jobs), root = resolveStateRoot(env);
      if (path.dirname(workspace) !== root || path.basename(jobs) !== "jobs" || path.basename(file) !== `${marker.jobId}.json`) continue;
      realDirectory(root); realDirectory(workspace); realDirectory(jobs);
      // A missing/unreadable state directory may be an unavailable mount, not
      // a pruned job. Listing also checks directory readability before unlink.
      fs.readdirSync(workspace); fs.readdirSync(jobs);
      if (fs.existsSync(path.join(workspace, ".state-lock")) || fs.lstatSync(file, { throwIfNoEntry: false })) continue;
      const stat = regularStat(candidate);
      if (!stat) continue;
      fs.unlinkSync(candidate);
      report.markersDeleted += 1; report.bytesFreed += stat.size;
    } catch (error) {
      if (error.code !== "ENOENT") report.errors.push(errorEntry({ path: candidate }, error));
    }
  }
  return report;
}

async function maintainStaleJobs({ env, now, directory, broker }) {
  const deadline = Date.now() + MAINTENANCE_BUDGET_MS;
  const file = path.join(directory, "maintenance.json"), previous = readJson(file) ?? {};
  const markers = pruneMissingJobMarkers({ env, deadline, after: previous.markerCursor });
  const report = { jobsReconciled: 0, reconciliationAttempts: 0, markersDeleted: markers.markersDeleted, bytesFreed: markers.bytesFreed, errors: markers.errors };
  const candidates = [];
  const root = resolveStateRoot(env);
  try {
    realDirectory(root);
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (Date.now() >= deadline) break;
      if (!entry.isDirectory()) continue;
      const workspace = path.join(root, entry.name);
      try {
        realDirectory(workspace);
        if (fs.existsSync(path.join(workspace, ".state-lock")) || readJson(path.join(workspace, ".legacy-migration.json"))?.pending?.length) continue;
        const state = readJson(path.join(workspace, "state.json"));
        if (!Array.isArray(state?.jobs)) continue;
        realDirectory(path.join(workspace, "jobs"));
        for (const index of state.jobs) {
          if (Date.now() >= deadline) break;
          if (!safeId(index.id) || !staleTask(index, now, false)) continue;
          const file = path.join(workspace, "jobs", `${index.id}.json`), record = readJson(file);
          if (staleTask(record, now) && staleTask({ ...record, ...index, result: record.result }, now)) candidates.push(file);
        }
      } catch { /* Locked, malformed or incomplete workspaces are not candidates. */ }
    }
  } catch (error) { if (error.code !== "ENOENT") report.errors.push(errorEntry({ scope: "reconciliation" }, error)); }
  candidates.sort();
  const cursor = previous.jobCursor ?? "";
  const ordered = [...candidates.filter(item => item > cursor), ...candidates.filter(item => item <= cursor)];
  let jobCursor = cursor;
  for (const candidate of ordered) {
    if (report.reconciliationAttempts >= RECONCILE_LIMIT || deadline - Date.now() < 1500) break;
    jobCursor = candidate;
    report.reconciliationAttempts += 1;
    const recoveryEnv = broker?.endpoint ? { ...env, CODEX_COMPANION_APP_SERVER_ENDPOINT: broker.endpoint } : env;
    if (await recoverInEnvironment(candidate, now, deadline, recoveryEnv)) report.jobsReconciled += 1;
  }
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify({ jobCursor, markerCursor: markers.cursor }), { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
  } finally { try { fs.unlinkSync(temporary); } catch { /* renamed */ } }
  return report;
}
function validateJob(job) {
  if (!job || !safeId(job.id) || typeof job.status !== "string" || !job.status) throw new Error("Invalid job record.");
}
function expired(job, cutoff, record = job, orphan = false) {
  const timestamp = Date.parse(job.completedAt ?? job.updatedAt);
  // Orphan files can precede index publication during startup. Requiring every
  // recorded start/update time to predate the (at least one day) age cutoff
  // keeps that window protected even when their stale status is still active.
  const oldOrphan = orphan && [job.createdAt, job.startedAt, job.updatedAt].filter(value => value != null)
    .every(value => Number.isFinite(Date.parse(value)) && Date.parse(value) < cutoff);
  return (!active(job) || oldOrphan) && !unresolvedTask({ ...job, ...record }) && Number.isFinite(timestamp) && timestamp < cutoff && !job.ownerAttached && !alive(job.pid);
}
function eligibleRecord(index, record, cutoff) {
  // A missing private record cannot establish that a queued/running launch
  // ended. Keep its remaining evidence unless the index proves quiescence.
  if (!record) return ["completed", "failed", "cancelled", "interrupted", "blocked", "needs_input", "error"].includes(index?.status)
    && !protectionReason(index) && expired(index, cutoff)
    && [index.createdAt, index.startedAt, index.updatedAt].filter(value => value != null)
      .every(value => Number.isFinite(Date.parse(value)) && Date.parse(value) < cutoff);
  return index ? expired(index, cutoff, record) && expired(record, cutoff) : expired(record, cutoff, record, true);
}
function protectionReason(...jobs) {
  if (jobs.some(job => job && active(job))) return "active";
  if (jobs.some(job => job?.ownerAttached)) return "owner-attached";
  if (jobs.some(job => alive(job?.pid) || alive(job?.launcherPid))) return "pid-alive";
  if (unresolvedTask(Object.assign({}, ...jobs))) return "unresolved";
  return null;
}
function recordRetention(retained, workspace, jobId, reason) {
  if (!reason) return;
  const existing = retained.find(item => item.workspace === workspace && item.jobId === jobId);
  if (existing) existing.reason = reason;
  else retained.push({ workspace, jobId, reason });
}
function artifactFiles(workspace, job) {
  const directory = path.join(workspace, "jobs");
  const files = [path.join(directory, `${job.id}.json`)];
  // Do not follow legacy/out-of-home paths or permit a corrupt record to name
  // Codex's rollouts, databases, another job's artifacts, or symlinks.
  for (const [key, suffix] of [["logFile", ".log"], ["rawOutputFile", ".output.txt"], ["resultFile", ".result.json"]]) {
    if (!job[key]) continue;
    const expected = path.join(directory, `${job.id}${suffix}`);
    if (job[key] !== expected) throw artifactPathRetention();
    files.push(expected);
  }
  return files.map(file => {
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (stat && !stat.isFile()) throw artifactPathRetention();
    return { path: file, bytes: stat?.size ?? 0 };
  });
}
function workspaceRecords(workspace, { state = null, locked = false, cache = null } = {}) {
  realDirectory(workspace);
  const lock = path.join(workspace, ".state-lock");
  if (!locked && fs.existsSync(lock)) throw new Error("Workspace state is locked; skipping.");
  const migration = readJson(path.join(workspace, ".legacy-migration.json"));
  if (migration?.pending?.length) throw new Error("Legacy jobs are still pending migration; references are unknown.");
  const indexFile = path.join(workspace, "state.json");
  const before = regularStat(indexFile);
  const index = state ?? readJson(indexFile);
  if (index !== null && !Array.isArray(index.jobs)) throw new Error("Invalid job-state index.");
  const indexed = index?.jobs ?? [], records = new Map();
  for (const job of indexed) {
    validateJob(job);
    if (records.has(job.id)) throw new Error("Duplicate job id in index.");
    records.set(job.id, { index: job, record: null });
  }
  const jobsDir = path.join(workspace, "jobs");
  try {
    realDirectory(jobsDir);
    for (const entry of fs.readdirSync(jobsDir, { withFileTypes: true })) {
      if (!entry.name.endsWith(".json") || entry.name.endsWith(".result.json")) continue;
      const record = readJson(path.join(jobsDir, entry.name), cache);
      validateJob(record);
      if (entry.name !== `${record.id}.json`) throw new Error("Job file id does not match its name.");
      records.set(record.id, { index: records.get(record.id)?.index ?? null, record });
    }
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (index === null && records.size) throw new Error("Missing job-state index.");
  const after = regularStat(indexFile);
  if (before?.ino !== after?.ino || before?.mtimeMs !== after?.mtimeMs || before?.size !== after?.size || (!locked && fs.existsSync(lock))) throw new Error("Workspace changed while reading; skipping.");
  return records;
}

// Every surviving job may be a follow-up address, even after it finishes.
// Do not infer session quiescence from a partial, locked or corrupt inventory.
// This only reads: dispatch/adoption already take workspace -> names locks.
function reservationSessions(env, removed = []) {
  const sessions = new Set(), root = resolveStateRoot(env);
  const omitted = new Set(removed.map(job => path.join(job.workspace, job.jobId)));
  try {
    realDirectory(root);
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if ([RUN_SESSIONS_DIR, CLAUDE_MEMORY_DIR].includes(entry.name)) continue;
      if (entry.isSymbolicLink()) return null;
      if (!entry.isDirectory()) continue;
      const workspace = path.join(root, entry.name);
      for (const [id, { index, record }] of workspaceRecords(workspace)) {
        if (omitted.has(path.join(workspace, id))) continue;
        for (const job of [index, record]) {
          if (!job) continue;
          const session = job.sessionId === undefined ? job.ownerId : job.sessionId;
          if (session == null) continue;
          if (typeof session !== "string") return null;
          if (session) sessions.add(session);
        }
      }
    }
  } catch { return null; }
  return sessions;
}

function inspectWorkspaces(env, cutoff, { retainAll = false, cache = null } = {}) {
  const jobs = [], referenced = new Set(), errors = [], retained = [];
  const inertWorkspaces = [], workspacesRetained = [];
  let incomplete = false;
  try {
    const root = resolveStateRoot(env);
    realDirectory(root);
    for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if ([RUN_SESSIONS_DIR, CLAUDE_MEMORY_DIR].includes(entry.name)) continue;
      const workspace = path.join(root, entry.name);
      if (!entry.isDirectory()) {
        if (entry.isSymbolicLink()) errors.push({ workspace, message: "Symlinked workspace; references are unknown." });
        continue;
      }
      try {
        if (!fs.lstatSync(path.join(workspace, "state.json"), { throwIfNoEntry: false })) {
          try {
            // Match thread inventory: broker/journal-only or empty directories
            // have no private job records and cannot hold thread references.
            let files = [];
            try {
              const jobsDir = path.join(workspace, "jobs");
              realDirectory(jobsDir);
              files = fs.readdirSync(jobsDir).filter(name => /^[\w-]+\.json$/.test(name));
            } catch (error) { if (error.code !== "ENOENT") throw error; }
            if (!files.length) continue;
            const inspected = inertIndexlessWorkspace(workspace, { cutoffMs: cutoff });
            if (inspected.reason) { incomplete = true; workspacesRetained.push({ workspace, reason: inspected.reason }); }
            else inertWorkspaces.push({ workspace, bytes: inspected.bytes });
          } catch (error) {
            incomplete = true;
            workspacesRetained.push({ workspace, reason: "unreadable-or-unsafe" });
            throw error;
          }
          continue;
        }
        const records = workspaceRecords(workspace, { cache });
        const candidates = [], protectedRecords = [];
        for (const { index, record } of records.values()) {
          const job = record ?? index;
          let candidate = !retainAll && eligibleRecord(index, record, cutoff);
          let reason = candidate ? null : protectionReason(index, record);
          let bytes = 0;
          if (candidate) {
            try {
              if (index && record) artifactFiles(workspace, record);
              bytes = artifactFiles(workspace, index ?? record).reduce((sum, file) => sum + file.bytes, 0);
            }
            catch (error) {
              if (error.code === RETAIN_ARTIFACT_PATHS) reason = "legacy-paths";
              else errors.push(errorEntry({ workspace, jobId: job.id }, error));
              candidate = false;
            }
          }
          if (candidate) candidates.push({ workspace, jobId: job.id, threadId: record?.threadId ?? index?.threadId ?? null, bytes });
          else {
            protectedRecords.push(index, record);
            recordRetention(retained, workspace, job.id, reason);
          }
        }
        jobs.push(...candidates);
        for (const job of protectedRecords) for (const id of [job?.threadId, job?.sourceThreadId]) if (id) referenced.add(id);
      } catch (error) { errors.push(errorEntry({ workspace }, error)); }
    }
  } catch (error) { if (error.code !== "ENOENT") errors.push(errorEntry({ scope: "state" }, error)); }
  return { jobs, referenced, errors, retained, inertWorkspaces, workspacesRetained, incomplete };
}
function inspectThreads(env, cutoff, referenced) {
  const grouped = new Map(), errors = [];
  const root = path.join(resolveIsolatedCodexHome(env), "sessions");
  function visit(directory, depth) {
    realDirectory(directory);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Symlinked rollout path: ${target}`);
      if (depth < 3 && entry.isDirectory() && (depth === 0 ? /^\d{4}$/ : /^\d{2}$/).test(entry.name)) visit(target, depth + 1);
      if (depth !== 3 || !entry.isFile()) continue;
      const match = /^rollout-.+-([a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})\.jsonl$/i.exec(entry.name);
      if (!match) continue;
      const stat = regularStat(target);
      if (!stat) throw new Error("Rollout changed during scan.");
      const threadId = match[1], files = grouped.get(threadId) ?? [];
      files.push({ path: target, bytes: stat.size, mtime: stat.mtimeMs });
      grouped.set(threadId, files);
    }
  }
  try {
    if (fs.existsSync(root)) visit(root, 0);
    else if (fs.lstatSync(root, { throwIfNoEntry: false })) throw new Error("Unsafe rollout root.");
  } catch (error) { errors.push(errorEntry({ scope: "threads" }, error)); }
  const threads = [];
  if (!errors.length) for (const [threadId, files] of grouped) {
    if (referenced.has(threadId) || files.some(file => file.mtime >= cutoff)) continue;
    threads.push({ threadId, path: files[0].path, bytes: files.reduce((sum, file) => sum + file.bytes, 0) });
  }
  return { threads, errors };
}

export function planRetention({ now = Date.now(), days, env = process.env } = {}) {
  const policy = retentionPolicy(env, days), cutoffMs = Number(new Date(now)) - policy.days * DAY;
  if (!Number.isFinite(cutoffMs) || !Number.isFinite(new Date(cutoffMs).getTime())) throw new Error("Invalid retention date or period.");
  resolveIsolatedCodexHome(env); // Enforce the test-home and normal-home guards before scanning.
  // Keep parsed private records only for this plan/apply cycle. Every reuse
  // still checks the file identity, timestamps and size, including under lock.
  const cache = new Map();
  const state = inspectWorkspaces(env, cutoffMs, { cache });
  const markers = planSessionMarkers(cutoffMs, { env });
  if (state.jobs.length) {
    const jobFiles = new Set(state.jobs.map(job => path.join(job.workspace, "jobs", `${job.jobId}.json`)));
    const selected = new Set(markers.markers.map(marker => marker.path));
    const linked = planSessionMarkers(Infinity, { env });
    markers.errors.push(...linked.errors);
    for (const marker of linked.markers) {
      if (selected.has(marker.path)) continue;
      try {
        const record = readJson(marker.path);
        if (safeId(record?.jobId) && path.basename(marker.path) === `${record.jobId}.json` &&
            jobFiles.has(record.jobFile) && path.basename(record.jobFile) === `${record.jobId}.json`) markers.markers.push(marker);
      } catch { /* An unreadable marker is never selected through its payload. */ }
    }
  }
  const runs = planRuns(cutoffMs, { env });
  const snapshots = planClaudeSnapshots(cutoffMs, { env });
  const imports = planClaudeImports({ now, env });
  const names = planAgentNames(cutoffMs, { env, inspectSessions: () => reservationSessions(env, state.jobs) });
  const threads = state.errors.length || state.incomplete ? { threads: [], errors: [] } : inspectThreads(env, cutoffMs, state.referenced);
  const plan = { cutoff: new Date(cutoffMs).toISOString(), ...policy, jobs: state.jobs, inertWorkspaces: state.inertWorkspaces, workspacesRetained: state.workspacesRetained, runs: runs.runs, runSessions: runs.runSessions, markers: markers.markers, snapshots: snapshots.snapshots, imports: imports.imports, agentNameSessions: names.agentNameSessions, agentNameTemporaries: names.agentNameTemporaries, threads: threads.threads, retained: state.retained, errors: [...state.errors, ...markers.errors, ...runs.errors, ...snapshots.errors, ...imports.errors, ...names.errors, ...threads.errors] };
  Object.defineProperty(plan, CONTEXT, { value: { env: { ...env }, now: Number(new Date(now)), cache } });
  return plan;
}

export async function applyRetention(plan, { deleteThread } = {}) {
  const report = { jobsDeleted: 0, runsDeleted: 0, runSessionsDeleted: 0, markersDeleted: 0, snapshotsDeleted: 0, importsDeleted: 0, agentNameSessionsDeleted: 0, agentNameTemporariesDeleted: 0, threadsDeleted: 0, threadsSkipped: 0, bytesFreed: 0, inertWorkspaces: [], workspacesRetained: (plan?.workspacesRetained ?? []).map(item => ({ ...item })), retained: (plan?.retained ?? []).map(item => ({ ...item })), errors: [...(plan?.errors ?? [])], days: plan?.days, warnings: [...(plan?.warnings ?? [])] };
  const cache = plan?.[CONTEXT]?.cache ?? new Map();
  try {
    const env = plan[CONTEXT]?.env ?? process.env, cutoff = Date.parse(plan.cutoff);
    if (!Number.isFinite(cutoff)) throw new Error("Invalid retention cutoff.");
    const root = resolveStateRoot(env);
    for (const candidate of plan.inertWorkspaces ?? []) {
      const workspace = candidate.workspace;
      try {
        realDirectory(root);
        if (path.dirname(workspace) !== root) throw new Error("Workspace is outside the state root.");
        const inspected = inertIndexlessWorkspace(workspace, { cutoffMs: cutoff });
        if (inspected.reason) report.workspacesRetained.push({ workspace, reason: inspected.reason });
        else report.inertWorkspaces.push({ workspace, bytes: inspected.bytes });
      } catch (error) {
        report.workspacesRetained.push({ workspace, reason: "unreadable-or-unsafe" });
        report.errors.push(errorEntry({ workspace }, error));
      }
    }
    const workspaces = new Map(), removedJobFiles = new Set();
    for (const candidate of plan.jobs) {
      const selected = workspaces.get(candidate.workspace) ?? new Set();
      selected.add(candidate.jobId); workspaces.set(candidate.workspace, selected);
    }
    for (const [workspace, ids] of workspaces) {
      let files = [], selectedIds = [], counted = false;
      try {
        realDirectory(root);
        if (path.dirname(workspace) !== root) throw new Error("Workspace is outside the state root.");
        realDirectory(workspace);
        const removed = removeJobsFromState(workspace, state => {
          const records = workspaceRecords(workspace, { state, locked: true, cache }), selected = [];
          for (const id of ids) {
            const item = records.get(id);
            if (!item) continue;
            if (!eligibleRecord(item.index, item.record, cutoff)) {
              recordRetention(report.retained, workspace, id, protectionReason(item.index, item.record));
              continue;
            }
            try {
              if (item.index && item.record) artifactFiles(workspace, item.record);
              const artifacts = artifactFiles(workspace, item.index ?? item.record);
              files.push(...artifacts);
              if (item.index) selected.push(id);
              else {
                // Still unindexed after rechecking under the publication lock:
                // remove the expired orphan without ever admitting it as a job.
                for (const file of artifacts) {
                  try { fs.unlinkSync(file.path); } catch (error) { if (error.code !== "ENOENT") throw error; }
                }
                report.jobsDeleted += 1;
              }
            } catch (error) {
              if (error.code !== RETAIN_ARTIFACT_PATHS) throw error;
              recordRetention(report.retained, workspace, id, "legacy-paths");
            }
          }
          selectedIds = selected;
          return selected;
        });
        report.jobsDeleted += removed.length;
        counted = true;
      } catch (error) {
        report.errors.push(errorEntry({ workspace }, error));
        // commitState writes the index before unlinking artifacts. Report jobs
        // actually dropped even if an artifact unlink subsequently failed.
        if (!counted && selectedIds.length) try {
          const current = readJson(path.join(workspace, "state.json"));
          if (Array.isArray(current?.jobs)) report.jobsDeleted += selectedIds.filter(id => !current.jobs.some(job => job.id === id)).length;
        } catch { /* original failure is already reported */ }
      }
      // Also account for partial artifact removal if commitState hit an I/O error.
      for (const file of files) if (!fs.existsSync(file.path)) {
        report.bytesFreed += file.bytes;
        removedJobFiles.add(file.path);
      }
    }
    const names = pruneAgentNames(plan, cutoff, { env, inspectSessions: () => reservationSessions(env) });
    report.agentNameSessionsDeleted = names.agentNameSessionsDeleted;
    report.agentNameTemporariesDeleted = names.agentNameTemporariesDeleted;
    report.bytesFreed += names.bytesFreed;
    report.errors.push(...names.errors);
    const runs = pruneRuns(plan.runs ?? [], cutoff, { env, runSessions: plan.runSessions ?? [] });
    report.runsDeleted = runs.runsDeleted;
    report.runSessionsDeleted = runs.runSessionsDeleted;
    report.bytesFreed += runs.bytesFreed;
    report.errors.push(...runs.errors);
    const markers = pruneSessionMarkers(0, { now: cutoff, env, files: plan.markers });
    report.markersDeleted = markers.markersDeleted;
    report.bytesFreed += markers.bytesFreed;
    report.errors.push(...markers.errors);
    if (removedJobFiles.size) {
      const linked = pruneMissingJobMarkers({ env, jobFiles: removedJobFiles, limit: Infinity });
      report.markersDeleted += linked.markersDeleted;
      report.bytesFreed += linked.bytesFreed;
      report.errors.push(...linked.errors);
    }
    const snapshots = pruneClaudeSnapshots(plan.snapshots ?? [], cutoff, { env });
    report.snapshotsDeleted = snapshots.snapshotsDeleted;
    report.bytesFreed += snapshots.bytesFreed;
    report.errors.push(...snapshots.errors);
    const imports = sweepClaudeImports({ now: plan[CONTEXT]?.now ?? Date.now(), env, files: plan.imports ?? [] });
    report.importsDeleted = imports.importsDeleted;
    report.bytesFreed += imports.bytesFreed;
    report.errors.push(...imports.errors);
    for (const thread of plan.threads) {
      try {
        // Even expired jobs that failed to be removed now protect their threads.
        // Recheck references and rollout mtimes immediately before each RPC.
        const state = inspectWorkspaces(env, cutoff, { retainAll: true, cache });
        if (state.errors.length || state.incomplete) throw new Error("Cannot safely recheck all workspace references.");
        const current = inspectThreads(env, cutoff, state.referenced);
        if (current.errors.length) throw new Error("Cannot safely recheck rollout activity.");
        const candidate = current.threads.find(item => item.threadId === thread.threadId);
        if (!candidate) { report.threadsSkipped += 1; continue; }
        if (!deleteThread) throw new Error("No broker thread/delete connection is available.");
        const response = await deleteThread(thread.threadId);
        if (response === false || response?.unsupported || response?.skipped || response?.error || response?.supported === false) throw new Error(response?.error?.message || "thread/delete is unsupported or skipped.");
        report.threadsDeleted += 1;
        report.bytesFreed += candidate.bytes;
      } catch (error) { report.threadsSkipped += 1; report.errors.push(errorEntry({ threadId: thread.threadId }, error)); }
    }
  } catch (error) {
    report.errors.push(errorEntry({ scope: "retention" }, error));
    report.threadsSkipped = (plan?.threads?.length ?? 0) - report.threadsDeleted;
  } finally {
    cache.clear();
  }
  return report;
}

// The hook passes its already-started broker. Reject the client's private-spawn
// fallback before initialize(), so retention never creates an extra runtime.
export async function applyRetentionWithBroker(plan, { cwd = process.cwd(), env = process.env, broker } = {}) {
  let client = null, failure = null;
  try {
    return await applyRetention(plan, { deleteThread: async threadId => {
      if (failure) throw failure;
      try {
        if (!client) {
          const session = broker === undefined ? await ensureBrokerSession(cwd, { env }) : broker;
          if (!session?.endpoint) throw new Error("Retention broker is unavailable.");
          const timeout = setTimeout(() => client?.close().catch(() => {}), 10000);
          try {
            client = await CodexAppServerClient.connect(cwd, {
              env, brokerEndpoint: session.endpoint, reuseExistingBroker: true,
              onClient(candidate) {
                if (candidate.transport !== "broker") throw new Error("Retention requires the existing broker; private startup refused.");
                client = candidate;
              }
            });
          } finally { clearTimeout(timeout); }
        }
        const timeout = setTimeout(() => client.close().catch(() => {}), 10000);
        try { return await client.request("thread/delete", { threadId }); }
        finally { clearTimeout(timeout); }
      } catch (error) { failure = error; throw error; }
    } });
  } finally { await client?.close().catch(() => {}); }
}

function acquireAutomaticLock(directory) {
  const lock = path.join(directory, ".retention-lock");
  const owner = `owner-${process.pid}-${randomUUID()}`, candidate = path.join(directory, `.${owner}`);
  fs.mkdirSync(candidate, { mode: 0o700 });
  try {
    fs.writeFileSync(path.join(candidate, owner), "", { flag: "wx", mode: 0o600 });
    try { fs.renameSync(candidate, lock); }
    catch (error) {
      if (!["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(error.code)) throw error;
      realDirectory(lock);
      for (const name of fs.readdirSync(lock)) {
        const match = /^owner-(\d+)-[a-f0-9-]+$/.exec(name);
        if (!match || alive(Number(match[1]))) return null;
        try { fs.unlinkSync(path.join(lock, name)); } catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      // Non-recursive removal cannot remove a competing process's new owner.
      try { fs.rmdirSync(lock); } catch (error) { if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error; }
      return null;
    }
    return () => {
      fs.unlinkSync(path.join(lock, owner));
      try { fs.rmdirSync(lock); } catch (error) { if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error; }
    };
  } finally {
    try { fs.unlinkSync(path.join(candidate, owner)); } catch { /* published */ }
    try { fs.rmdirSync(candidate); } catch { /* published */ }
  }
}

export async function runAutomaticRetention({ cwd = process.cwd(), now = Date.now(), env = process.env, broker, deleteThread } = {}) {
  let release;
  const failed = error => ({ jobsDeleted: 0, runsDeleted: 0, runSessionsDeleted: 0, markersDeleted: 0, snapshotsDeleted: 0, importsDeleted: 0, threadsDeleted: 0, threadsSkipped: 0, bytesFreed: 0, retained: [], errors: [errorEntry({ scope: "automatic-retention" }, error)] });
  try {
    const directory = path.join(resolveIsolatedCodexHome(env), "duet");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    realDirectory(directory);
    release = acquireAutomaticLock(directory);
    if (!release) return { skipped: true, reason: "locked" };
    const token = randomUUID();
    const file = path.join(directory, "retention.json"), previous = readJson(file);
    const at = Number(new Date(now)), lastRun = Date.parse(previous?.lastRunAt);
    // Every detached prewarm gets a bounded maintenance pass, independently of
    // the 12-hour age-deletion throttle. The same lock serializes both paths.
    const maintenance = await maintainStaleJobs({ env, now: at, directory, broker });
    if (Number.isFinite(lastRun) && at - lastRun < INTERVAL) return { skipped: true, reason: "interval", lastRunAt: previous.lastRunAt, ...maintenance };
    const plan = planRetention({ now: at, env });
    function save(lastReport) {
      const temporary = path.join(directory, `.retention-${token}.tmp`);
      try {
        fs.writeFileSync(temporary, `${JSON.stringify({ lastRunAt: new Date(at).toISOString(), lastReport }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
        fs.renameSync(temporary, file);
      } finally { try { fs.unlinkSync(temporary); } catch { /* already renamed */ } }
    }
    save(null); // Reserve this interval even if the detached process is interrupted.
    const report = deleteThread ? await applyRetention(plan, { deleteThread }) : await applyRetentionWithBroker(plan, { cwd, env, broker });
    report.jobsReconciled = maintenance.jobsReconciled;
    report.reconciliationAttempts = maintenance.reconciliationAttempts;
    report.markersDeleted += maintenance.markersDeleted;
    report.bytesFreed += maintenance.bytesFreed;
    report.errors.push(...maintenance.errors);
    save(report);
    return report;
  } catch (error) { return failed(error); }
  finally {
    try { release?.(); } catch { /* best effort */ }
  }
}
