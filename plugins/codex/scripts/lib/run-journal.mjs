import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolveIsolatedCodexHome } from "./codex-home.mjs";
import { resolveStateDir, resolveStateRoot, withJournalLock } from "./state.mjs";

const SEGMENT = /^[A-Za-z0-9_.:-]{1,128}$/;
const safeId = value => typeof value === "string" && SEGMENT.test(value) && value !== "." && value !== "..";
function id(value, label) {
  if (!safeId(value)) throw new Error(`Invalid ${label}; use a safe path segment (1–128 characters).`);
  return value;
}
function session(value) {
  if (!safeId(value)) throw new Error("Journal needs CODEX_COMPANION_SESSION_ID, exported by the Claude SessionStart hook.");
  return value;
}
function object(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Journal stdin must be a JSON object.");
}
function string(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string.`);
  return value;
}
function strings(value, name) {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array of strings.`);
  return value.map(item => string(item, name));
}
function choice(value, values, name) {
  if (!values.includes(value)) throw new Error(`${name} must be one of: ${values.join(", ")}.`);
  return value;
}
function validate(type, value) {
  object(value);
  switch (type) {
    case "run_started": return { goal: string(value.goal, "goal"), criteria: strings(value.criteria, "criteria") };
    case "criteria": return { criteria: strings(value.criteria, "criteria") };
    case "verdict": {
      if (!Array.isArray(value.criteria)) throw new Error("criteria must be an array of criterion/evidence/result objects.");
      return { jobId: id(value.jobId, "jobId"), verdict: choice(value.verdict, ["ACCEPT", "ACCEPT_WITH_GLUE", "REWORK", "REASSIGN"], "verdict"),
        criteria: value.criteria.map(item => { object(item); return { criterion: string(item.criterion, "criterion"), evidence: string(item.evidence, "evidence"), result: choice(item.result, ["met", "not_met", "cannot_verify"], "result") }; }),
        reason: string(value.reason, "reason") };
    }
    case "decision": return { summary: string(value.summary, "summary"), basis: string(value.basis, "basis"), ...(value.risk === undefined ? {} : { risk: string(value.risk, "risk") }) };
    case "run_closed": return { judgment: choice(value.judgment, ["passed", "blocked", "abandoned"], "judgment"), summary: string(value.summary, "summary"), ...(value.openRisks === undefined ? {} : { openRisks: strings(value.openRisks, "openRisks") }) };
    default: throw new Error(`Unknown journal entry type: ${type}.`);
  }
}

// Check each ancestor before creating its child. No journal operation follows
// symlinked directories or files below the canonical isolated home.
function directory(target, env, create = false) {
  const home = resolveIsolatedCodexHome(env), relative = path.relative(home, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Journal path is outside the isolated home.");
  if (create) fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  let current = home;
  for (const part of ["", ...relative.split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part);
    if (create && !fs.lstatSync(current, { throwIfNoEntry: false })) {
      try { fs.mkdirSync(current, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
    }
    if (!fs.lstatSync(current).isDirectory()) throw new Error(`Journal directory must not be a symlink: ${current}`);
    if (create && current !== home) fs.chmodSync(current, 0o700);
  }
  return target;
}
function read(file) {
  if (!fs.lstatSync(file).isFile()) throw new Error(`Journal file must be regular: ${file}`);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error(`Journal file must be regular: ${file}`);
    return fs.readFileSync(fd, "utf8");
  } finally { fs.closeSync(fd); }
}
function atomic(file, text) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, text, { flag: "wx", mode: 0o600 });
    fs.renameSync(temp, file);
  } finally { try { fs.unlinkSync(temp); } catch { /* renamed */ } }
}
const runsDir = stateDir => path.join(stateDir, "runs");
const runDir = (stateDir, runId) => path.join(runsDir(stateDir), id(runId, "runId"));
export const RUN_SESSIONS_DIR = "run-sessions";
const sessionsDir = env => path.join(resolveStateRoot(env), RUN_SESSIONS_DIR);
const pointer = (sessionId, env) => path.join(sessionsDir(env), `${session(sessionId)}.json`);
function runStateDirectory(value, env) {
  if (typeof value !== "string" || path.dirname(value) !== resolveStateRoot(env) || path.normalize(value) !== value || path.basename(value) === RUN_SESSIONS_DIR) throw new Error("Run stateDir must be a workspace directory directly under the isolated state root.");
  return value;
}
function entries(stateDir, runId, env) {
  const dir = directory(runDir(stateDir, runId), env);
  const rows = read(path.join(dir, "journal.jsonl")).trimEnd().split("\n").map(line => JSON.parse(line));
  if (rows[0]?.type !== "run_started" || rows[0].runId !== runId || rows.some(row => !row.type || !Number.isFinite(Date.parse(row.recordedAt)))) throw new Error(`Invalid journal for run ${runId}.`);
  return rows;
}
function append(stateDir, runId, type, data) {
  const file = path.join(runDir(stateDir, runId), "journal.jsonl");
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (stat && !stat.isFile()) throw new Error("Journal must be a regular file.");
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error("Journal must be a regular file.");
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, `${JSON.stringify({ ...data, type, recordedAt: new Date().toISOString() })}\n`);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}
function activePointer(sessionId, env) {
  if (!safeId(sessionId)) return null;
  try {
    directory(sessionsDir(env), env);
    const value = JSON.parse(read(pointer(sessionId, env)));
    return { runId: id(value.runId, "active runId"), stateDir: runStateDirectory(value.stateDir, env) };
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
function activeRun(sessionId, env) {
  const active = activePointer(sessionId, env);
  if (!active) return null;
  try {
    const rows = entries(active.stateDir, active.runId, env);
    return rows.some(row => row.type === "run_closed") ? null : { ...rows[0], stateDir: active.stateDir };
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
export function readActiveRun(cwd, sessionId, env = process.env) {
  try { return activeRun(sessionId, env); } catch { return null; }
}
function locked(stateDir, env, action, create = false) {
  directory(stateDir, env, create);
  return withJournalLock(stateDir, action);
}
export function startRun(cwd, sessionId, input, env = process.env) {
  const data = validate("run_started", input);
  session(sessionId);
  const stateDir = resolveStateDir(cwd, env);
  // Pointer mutations take the session-directory lock before a run lock.
  // This ordering serializes starts across workspaces without lock inversion.
  return locked(sessionsDir(env), env, () => {
    const previous = activeRun(sessionId, env);
    if (previous) throw new Error(`Session already has an open run: ${previous.runId}. Close it before starting another.`);
    return locked(stateDir, env, () => {
      const runId = `run-${randomUUID()}`, dir = runDir(stateDir, runId);
      directory(dir, env, true);
      try {
        append(stateDir, runId, "run_started", { runId, ...data, cwd, sessionId });
        atomic(pointer(sessionId, env), `${JSON.stringify({ runId, stateDir })}\n`);
      } catch (error) { fs.rmSync(dir, { recursive: true, force: true }); throw error; }
      return { runId };
    }, true);
  }, true);
}
function target(stateDir, sessionId, runId, env, latest = false) {
  if (runId !== undefined) return { stateDir, runId: id(runId, "runId") };
  const active = activeRun(sessionId, env);
  if (active) return { stateDir: active.stateDir, runId: active.runId };
  if (latest) {
    const recent = listAt(stateDir, env)[0];
    if (recent) return { stateDir, runId: recent.runId };
  }
  throw new Error("No active Duet run; use journal start or --run <id>.");
}
function requireOpen(rows, runId) {
  if (rows.some(row => row.type === "run_closed")) throw new Error(`Run ${runId} is already closed.`);
}
export function addEntry(cwd, sessionId, type, input, runId, env = process.env) {
  if (!["criteria", "verdict", "decision"].includes(type)) throw new Error(`Unknown journal entry type: ${type}.`);
  const data = validate(type, input);
  const selected = target(resolveStateDir(cwd, env), sessionId, runId, env), stateDir = selected.stateDir;
  runId = selected.runId;
  return locked(stateDir, env, () => {
    requireOpen(entries(stateDir, runId, env), runId);
    append(stateDir, runId, type, data);
    return { runId, type };
  });
}
function clearPointers(stateDir, runId, env) {
  const dir = sessionsDir(env);
  const removed = { count: 0, bytes: 0 };
  try { directory(dir, env); } catch (error) { if (error.code === "ENOENT") return removed; throw error; }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const file = path.join(dir, entry.name);
    let value;
    try { value = JSON.parse(read(file)); } catch (error) { if (error instanceof SyntaxError) continue; throw error; }
    if (value?.runId === runId && value.stateDir === stateDir) {
      const bytes = fs.lstatSync(file).size;
      fs.unlinkSync(file); removed.count += 1; removed.bytes += bytes;
    }
  }
  return removed;
}
export function closeRun(cwd, sessionId, input, runId, env = process.env) {
  const data = validate("run_closed", input);
  if (runId !== undefined) id(runId, "runId");
  return locked(sessionsDir(env), env, () => {
    const selected = target(resolveStateDir(cwd, env), sessionId, runId, env), stateDir = selected.stateDir;
    runId = selected.runId;
    return locked(stateDir, env, () => {
      requireOpen(entries(stateDir, runId, env), runId);
      append(stateDir, runId, "run_closed", data);
      clearPointers(stateDir, runId, env);
      return { runId, ...data };
    });
  }, true);
}
function listAt(stateDir, env) {
  try { directory(runsDir(stateDir), env); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  return fs.readdirSync(runsDir(stateDir), { withFileTypes: true }).filter(item => item.isDirectory() && item.name !== "active").map(item => {
    const rows = entries(stateDir, item.name, env), closed = rows.find(row => row.type === "run_closed");
    return { runId: item.name, goal: rows[0].goal, startedAt: rows[0].recordedAt, lastActivityAt: rows.at(-1).recordedAt, state: closed ? "closed" : "open", ...(closed ? { judgment: closed.judgment } : {}) };
  }).sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.runId.localeCompare(a.runId));
}
export function listRuns(cwd, env = process.env) { return listAt(resolveStateDir(cwd, env), env); }
export function showRun(cwd, sessionId, runId, env = process.env) {
  const selected = target(resolveStateDir(cwd, env), sessionId, runId, env, true), stateDir = selected.stateDir;
  runId = selected.runId;
  const rows = entries(stateDir, runId, env), jobs = new Map(), criteria = [...rows[0].criteria], decisions = [];
  let closed = null;
  for (const row of rows.slice(1)) {
    if (row.type === "criteria") criteria.push(...row.criteria);
    if (row.type === "job_started") jobs.set(row.jobId, { agentName: row.agentName ?? null, jobId: row.jobId, workspaceRoot: row.workspaceRoot ?? rows[0].cwd, cwd: row.cwd ?? row.workspaceRoot ?? rows[0].cwd, threadId: row.threadId ?? null, status: "queued", brief: row.brief, report: null, latestVerdict: null });
    if (row.type === "job_finished" && jobs.has(row.jobId)) Object.assign(jobs.get(row.jobId), { status: row.status, report: row.report, threadId: row.threadId ?? jobs.get(row.jobId).threadId });
    if (row.type === "verdict") {
      if (!jobs.has(row.jobId)) jobs.set(row.jobId, { agentName: null, jobId: row.jobId, threadId: null, status: "unknown", brief: null, report: null });
      jobs.get(row.jobId).latestVerdict = row;
    }
    if (row.type === "decision") decisions.push(row);
    if (row.type === "run_closed") closed = row;
  }
  // Supplement live handles, but recovery never depends on retained job records.
  for (const job of jobs.values()) {
    if (job.report) continue;
    try {
      const jobStateDir = job.workspaceRoot ? resolveStateDir(job.workspaceRoot, env) : stateDir;
      directory(path.join(jobStateDir, "jobs"), env);
      const live = JSON.parse(read(path.join(jobStateDir, "jobs", `${id(job.jobId, "jobId")}.json`)));
      if (live.runId === runId && (live.runStateDir ?? jobStateDir) === stateDir) Object.assign(job, { status: live.status, threadId: live.threadId ?? job.threadId });
    } catch { /* pruned or unavailable */ }
  }
  const linked = [...jobs.values()];
  return { runId, directory: runDir(stateDir, runId), goal: rows[0].goal, criteria, jobs: linked, decisions,
    openItems: linked.filter(job => !job.latestVerdict || ["REWORK", "REASSIGN"].includes(job.latestVerdict.verdict)).map(job => ({ jobId: job.jobId, reason: job.latestVerdict?.verdict ?? "no_verdict" })),
    state: closed ? "closed" : "open", closed };
}
const short = (text, limit = 180) => { const flat = String(text ?? "").replace(/\s+/g, " "); return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat; };
export function renderRun(view) {
  const lines = [`Run ${view.runId} (${view.state}${view.closed ? `: ${view.closed.judgment}` : ""}): ${short(view.goal, 240)}`, `Files: ${view.directory}`, "Criteria:",
    ...view.criteria.map((item, index) => `  ${index + 1}. ${short(item)}`), "Jobs:",
    ...view.jobs.map(job => `  ${job.agentName ?? "worker"} ${job.jobId} thread=${job.threadId ?? "?"} ${job.status} verdict=${job.latestVerdict?.verdict ?? "none"}; brief=${job.brief ?? "?"} report=${job.report ?? "pending"}`),
    "Decisions:", ...view.decisions.map(item => `  ${short(item.summary)}; basis: ${short(item.basis)}${item.risk ? `; risk: ${short(item.risk)}` : ""}`),
    `Open items: ${view.openItems.map(item => `${item.jobId} (${item.reason})`).join(", ") || "none"}`,
    ...(view.closed ? [`Close: ${short(view.closed.summary)}; open risks: ${(view.closed.openRisks ?? []).map(item => short(item)).join("; ") || "none"}`] : [])];
  return `${lines.join("\n")}\n`;
}
export function activeRunContext(cwd, sessionId, env = process.env) {
  const run = readActiveRun(cwd, sessionId, env);
  return run ? `Active Duet run ${run.runId}: ${short(run.goal, 80)}. Run node "$CODEX_COMPANION" journal show to recover criteria, verdicts and open work.` : null;
}

// Automatic hooks are best effort: neither I/O nor a busy/corrupt journal may
// change a task's outcome. Their callers persist runId on the ordinary record.
export function linkJournalJob(job, brief, env = process.env) {
  try {
    // The pointer is atomic; defer reading the append-only stream until locked
    // so a concurrent verdict append cannot make an active run look absent.
    const active = activePointer(job.sessionId, env);
    if (!active) return null;
    const stateDir = active.stateDir;
    return locked(stateDir, env, () => {
      const current = activePointer(job.sessionId, env);
      if (current?.stateDir !== stateDir || current.runId !== active.runId) return null;
      const run = activeRun(job.sessionId, env);
      if (!run) return null;
      const rows = entries(stateDir, run.runId, env), jobId = id(job.id, "jobId");
      if (!rows.some(row => row.type === "job_started" && row.jobId === jobId)) {
        const relative = `jobs/${jobId}.brief.md`;
        directory(path.join(runDir(stateDir, run.runId), "jobs"), env, true);
        const file = path.join(runDir(stateDir, run.runId), relative);
        atomic(file, brief);
        try {
          append(stateDir, run.runId, "job_started", { jobId, workspaceRoot: job.workspaceRoot, cwd: job.cwd ?? job.request?.cwd ?? job.workspaceRoot, agentName: job.agentName ?? null, threadId: job.threadId ?? null, title: job.title, model: job.model, effort: job.effort, sandbox: job.sandbox,
            ...(job.followUpOf ? { followUpOf: job.followUpOf } : {}), ...(job.continuationOf ? { continuationOf: job.continuationOf } : {}), brief: relative });
        } catch (error) { fs.unlinkSync(file); throw error; }
      }
      return { runId: run.runId, runStateDir: stateDir };
    });
  } catch { return null; }
}
export function finishJournalJob(job, report, env = process.env) {
  if (!job.runId || job.jobClass !== "task" || ["queued", "running"].includes(job.status)) return false;
  try {
    const stateDir = runStateDirectory(job.runStateDir ?? resolveStateDir(job.workspaceRoot, env), env);
    return locked(stateDir, env, () => {
      const rows = entries(stateDir, job.runId, env), jobId = id(job.id, "jobId");
      // Check AND append under the existing interprocess state lock. Every
      // observer shares this gate; report publication precedes the event.
      if (!rows.some(row => row.type === "job_started" && row.jobId === jobId)) return false;
      const finishes = rows.filter(row => row.type === "job_finished" && row.jobId === jobId);
      if (finishes.some(row => row.status === job.status)) return true;
      const relative = `jobs/${jobId}${finishes.length ? `.${id(job.status, "status")}` : ""}.report.json`;
      directory(path.join(runDir(stateDir, job.runId), "jobs"), env, true);
      const file = path.join(runDir(stateDir, job.runId), relative);
      // A failed append may leave a published report. Reuse it only for the
      // same status, without overwriting an existing artifact or following links.
      if (fs.lstatSync(file, { throwIfNoEntry: false })) {
        if (JSON.parse(read(file)).status !== job.status) return false;
      } else {
        atomic(file, `${JSON.stringify(report, null, 2)}\n`);
      }
      append(stateDir, job.runId, "job_finished", { jobId, status: job.status, threadId: job.threadId ?? null, report: relative });
      return true;
    });
  } catch { return false; /* never fail a task */ }
}

function hasActiveLinkedJob(rows, env) {
  if (rows.some(row => row.type === "run_closed")) return false;
  const unfinished = new Map();
  for (const row of rows) {
    if (row.type === "job_started") unfinished.set(row.jobId, row);
    if (row.type === "job_finished") unfinished.delete(row.jobId);
  }
  for (const row of unfinished.values()) {
    try {
      const stateDir = resolveStateDir(row.workspaceRoot ?? rows[0].cwd, env);
      const dir = directory(path.join(stateDir, "jobs"), env);
      const job = JSON.parse(read(path.join(dir, `${id(row.jobId, "jobId")}.json`)));
      if (["queued", "running"].includes(job.status)) return true;
    } catch { /* missing or unreadable job records do not protect a run */ }
  }
  return false;
}

function runBytes(dir) {
  let bytes = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) bytes += runBytes(target);
    else if (entry.isFile()) bytes += fs.lstatSync(target).size;
    else throw new Error("Unsafe file in run directory; retaining run.");
  }
  return bytes;
}
function missingRun(active, env) {
  try { entries(active.stateDir, active.runId, env); return false; }
  catch (error) { if (error.code === "ENOENT") return true; throw error; }
}
export function planRuns(cutoff, { env = process.env } = {}) {
  const runs = [], runSessions = [], errors = [], root = resolveStateRoot(env);
  try {
    directory(root, env);
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === RUN_SESSIONS_DIR) continue;
      const workspace = path.join(root, entry.name);
      try {
        for (const run of listAt(workspace, env)) {
          if (Date.parse(run.lastActivityAt) < cutoff && !hasActiveLinkedJob(entries(workspace, run.runId, env), env)) {
            runs.push({ workspace, ...run, bytes: runBytes(runDir(workspace, run.runId)) });
          }
        }
      } catch (error) { errors.push({ workspace, message: error.message }); }
    }
  } catch (error) { if (error.code !== "ENOENT") errors.push({ scope: "runs", message: error.message }); }
  try {
    const dir = directory(sessionsDir(env), env);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        const sessionId = entry.name.slice(0, -5), active = activePointer(sessionId, env);
        if (!active) continue;
        const missing = missingRun(active, env);
        if (missing || runs.some(run => run.workspace === active.stateDir && run.runId === active.runId)) {
          const file = pointer(sessionId, env);
          runSessions.push({ sessionId, ...active, path: file, bytes: fs.lstatSync(file).size, reason: missing ? "missing_run" : "expired_run" });
        }
      } catch (error) { if (error.code !== "ENOENT") errors.push({ scope: "run-sessions", session: entry.name, message: error.message }); }
    }
  } catch (error) { if (error.code !== "ENOENT") errors.push({ scope: "run-sessions", message: error.message }); }
  return { runs, runSessions, errors };
}
export function pruneRuns(candidates, cutoff, { env = process.env, runSessions = [] } = {}) {
  const report = { runsDeleted: 0, runSessionsDeleted: 0, bytesFreed: 0, errors: [] };
  for (const candidate of candidates) {
    try {
      runStateDirectory(candidate.workspace, env);
      locked(sessionsDir(env), env, () => locked(candidate.workspace, env, () => {
        const rows = entries(candidate.workspace, candidate.runId, env);
        if (Date.parse(rows.at(-1).recordedAt) >= cutoff || hasActiveLinkedJob(rows, env)) return;
        const dir = runDir(candidate.workspace, candidate.runId), bytes = runBytes(dir);
        const pointers = clearPointers(candidate.workspace, candidate.runId, env);
        report.runSessionsDeleted += pointers.count; report.bytesFreed += pointers.bytes;
        fs.rmSync(dir, { recursive: true });
        report.runsDeleted += 1; report.bytesFreed += bytes;
      }), true);
    } catch (error) { if (error.code !== "ENOENT") report.errors.push({ runId: candidate.runId, message: error.message }); }
  }
  // Recheck missing-run pointers under the same lock as start/close so cleanup
  // cannot erase a pointer that has been replaced by a newly started run.
  for (const candidate of runSessions) {
    try {
      locked(sessionsDir(env), env, () => {
        const active = activePointer(candidate.sessionId, env);
        if (!active || active.runId !== candidate.runId || active.stateDir !== candidate.stateDir || !missingRun(active, env)) return;
        const file = pointer(candidate.sessionId, env), bytes = fs.lstatSync(file).size;
        fs.unlinkSync(file);
        report.runSessionsDeleted += 1; report.bytesFreed += bytes;
      });
    } catch (error) { if (error.code !== "ENOENT") report.errors.push({ sessionId: candidate.sessionId, message: error.message }); }
  }
  return report;
}
