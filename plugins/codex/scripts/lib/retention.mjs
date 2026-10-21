import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolveIsolatedCodexHome } from "./codex-home.mjs";
import { resolveStateRoot, removeJobsFromState } from "./state.mjs";
import { planSessionMarkers, pruneSessionMarkers } from "./session-markers.mjs";
import { planRuns, pruneRuns, RUN_SESSIONS_DIR } from "./run-journal.mjs";
import { CodexAppServerClient } from "./app-server.mjs";
import { ensureBrokerSession } from "./broker-lifecycle.mjs";

const DAY = 86400000;
const INTERVAL = 12 * 60 * 60 * 1000;
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
function readJson(file) {
  const before = regularStat(file);
  if (!before) return null;
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  const after = regularStat(file);
  if (!after || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.size !== after.size) throw new Error(`Record changed while reading: ${file}`);
  return value;
}
function validateJob(job) {
  if (!job || !safeId(job.id) || typeof job.status !== "string" || !job.status) throw new Error("Invalid job record.");
}
function expired(job, cutoff) {
  const timestamp = Date.parse(job.completedAt ?? job.updatedAt);
  return !active(job) && Number.isFinite(timestamp) && timestamp < cutoff && !job.ownerAttached && !alive(job.pid);
}
function protectionReason(...jobs) {
  if (jobs.some(job => job && active(job))) return "active";
  if (jobs.some(job => job?.ownerAttached)) return "owner-attached";
  if (jobs.some(job => alive(job?.pid))) return "pid-alive";
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
function workspaceRecords(workspace, { state = null, locked = false } = {}) {
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
    records.set(job.id, { index: job, record: job });
  }
  const jobsDir = path.join(workspace, "jobs");
  try {
    realDirectory(jobsDir);
    for (const entry of fs.readdirSync(jobsDir, { withFileTypes: true })) {
      if (!entry.name.endsWith(".json") || entry.name.endsWith(".result.json")) continue;
      const record = readJson(path.join(jobsDir, entry.name));
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
function inspectWorkspaces(env, cutoff, { retainAll = false } = {}) {
  const jobs = [], referenced = new Set(), errors = [], retained = [];
  try {
    const root = resolveStateRoot(env);
    realDirectory(root);
    for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === RUN_SESSIONS_DIR) continue;
      const workspace = path.join(root, entry.name);
      if (!entry.isDirectory()) {
        if (entry.isSymbolicLink()) errors.push({ workspace, message: "Symlinked workspace; references are unknown." });
        continue;
      }
      try {
        const records = workspaceRecords(workspace);
        const candidates = [], protectedRecords = [];
        for (const { index, record } of records.values()) {
          let candidate = !retainAll && index && expired(index, cutoff) && expired(record, cutoff);
          let reason = protectionReason(index, record);
          if (reason) candidate = false;
          let bytes = 0;
          if (candidate) {
            try { bytes = artifactFiles(workspace, index).reduce((sum, file) => sum + file.bytes, 0); }
            catch (error) {
              if (error.code === RETAIN_ARTIFACT_PATHS) reason = "legacy-paths";
              else errors.push(errorEntry({ workspace, jobId: index.id }, error));
              candidate = false;
            }
          }
          if (candidate) candidates.push({ workspace, jobId: index.id, threadId: record.threadId ?? index.threadId ?? null, bytes });
          else {
            protectedRecords.push(index, record);
            recordRetention(retained, workspace, record.id, reason);
          }
        }
        jobs.push(...candidates);
        for (const job of protectedRecords) for (const id of [job?.threadId, job?.sourceThreadId]) if (id) referenced.add(id);
      } catch (error) { errors.push(errorEntry({ workspace }, error)); }
    }
  } catch (error) { if (error.code !== "ENOENT") errors.push(errorEntry({ scope: "state" }, error)); }
  return { jobs, referenced, errors, retained };
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
  const state = inspectWorkspaces(env, cutoffMs);
  const markers = planSessionMarkers(cutoffMs, { env });
  const runs = planRuns(cutoffMs, { env });
  const threads = state.errors.length ? { threads: [], errors: [] } : inspectThreads(env, cutoffMs, state.referenced);
  const plan = { cutoff: new Date(cutoffMs).toISOString(), ...policy, jobs: state.jobs, runs: runs.runs, runSessions: runs.runSessions, markers: markers.markers, threads: threads.threads, retained: state.retained, errors: [...state.errors, ...markers.errors, ...runs.errors, ...threads.errors] };
  Object.defineProperty(plan, CONTEXT, { value: { env: { ...env } } });
  return plan;
}

export async function applyRetention(plan, { deleteThread } = {}) {
  const report = { jobsDeleted: 0, runsDeleted: 0, runSessionsDeleted: 0, markersDeleted: 0, threadsDeleted: 0, threadsSkipped: 0, bytesFreed: 0, retained: (plan?.retained ?? []).map(item => ({ ...item })), errors: [...(plan?.errors ?? [])], days: plan?.days, warnings: [...(plan?.warnings ?? [])] };
  try {
    const env = plan[CONTEXT]?.env ?? process.env, cutoff = Date.parse(plan.cutoff);
    if (!Number.isFinite(cutoff)) throw new Error("Invalid retention cutoff.");
    const root = resolveStateRoot(env);
    const workspaces = new Map();
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
          const records = workspaceRecords(workspace, { state, locked: true }), selected = [];
          for (const id of ids) {
            const item = records.get(id);
            if (!item?.index) continue;
            if (!expired(item.index, cutoff) || !expired(item.record, cutoff)) {
              recordRetention(report.retained, workspace, id, protectionReason(item.index, item.record));
              continue;
            }
            try {
              const artifacts = artifactFiles(workspace, item.index);
              files.push(...artifacts); selected.push(id);
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
      for (const file of files) if (!fs.existsSync(file.path)) report.bytesFreed += file.bytes;
    }
    const runs = pruneRuns(plan.runs ?? [], cutoff, { env, runSessions: plan.runSessions ?? [] });
    report.runsDeleted = runs.runsDeleted;
    report.runSessionsDeleted = runs.runSessionsDeleted;
    report.bytesFreed += runs.bytesFreed;
    report.errors.push(...runs.errors);
    const markers = pruneSessionMarkers(0, { now: cutoff, env, files: plan.markers });
    report.markersDeleted = markers.markersDeleted;
    report.bytesFreed += markers.bytesFreed;
    report.errors.push(...markers.errors);
    for (const thread of plan.threads) {
      try {
        // Even expired jobs that failed to be removed now protect their threads.
        // Recheck references and rollout mtimes immediately before each RPC.
        const state = inspectWorkspaces(env, cutoff, { retainAll: true });
        if (state.errors.length) throw new Error("Cannot safely recheck all workspace references.");
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
  const failed = error => ({ jobsDeleted: 0, runsDeleted: 0, runSessionsDeleted: 0, markersDeleted: 0, threadsDeleted: 0, threadsSkipped: 0, bytesFreed: 0, retained: [], errors: [errorEntry({ scope: "automatic-retention" }, error)] });
  try {
    const directory = path.join(resolveIsolatedCodexHome(env), "duet");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    realDirectory(directory);
    release = acquireAutomaticLock(directory);
    if (!release) return { skipped: true, reason: "locked" };
    const token = randomUUID();
    const file = path.join(directory, "retention.json"), previous = readJson(file);
    const at = Number(new Date(now)), lastRun = Date.parse(previous?.lastRunAt);
    if (Number.isFinite(lastRun) && at - lastRun < INTERVAL) return { skipped: true, reason: "interval", lastRunAt: previous.lastRunAt };
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
    save(report);
    return report;
  } catch (error) { return failed(error); }
  finally {
    try { release?.(); } catch { /* best effort */ }
  }
}
