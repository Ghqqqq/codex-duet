import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolveIsolatedCodexHome } from "./codex-home.mjs";
import { resolveStateDir, resolveStateDirForRoot, resolveStateRoot, withJournalLock } from "./state.mjs";

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
    case "criteria_withdrawn": return { criteria: strings(value.criteria, "criteria"), reason: string(value.reason, "reason") };
    case "verdict": {
      if (!Array.isArray(value.criteria)) throw new Error("criteria must be an array of criterion/evidence/result objects.");
      return { jobId: id(value.jobId, "jobId"), verdict: choice(value.verdict, ["ACCEPT", "ACCEPT_WITH_GLUE", "REWORK", "REASSIGN"], "verdict"),
        criteria: value.criteria.map(item => { object(item); return { criterion: string(item.criterion, "criterion"), evidence: string(item.evidence, "evidence"), result: choice(item.result, ["met", "not_met", "cannot_verify"], "result") }; }),
        reason: string(value.reason, "reason"),
        ...(value.resolves === undefined ? {} : { resolves: strings(value.resolves, "resolves").map(jobId => id(jobId, "resolves jobId")) }) };
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
function parseEntries(text, runId) {
  const terminated = text.endsWith("\n"), lines = text.split("\n"), rows = [];
  if (terminated) lines.pop();
  let bytes = 0;
  for (const [index, line] of lines.entries()) {
    const last = index === lines.length - 1;
    // A newline commits a row. Reads stay read-only; the next locked append
    // removes this tail before writing, so it cannot become interior damage.
    if (last && !terminated) break;
    try { rows.push(JSON.parse(line)); }
    catch (error) { if (!last) throw error; break; }
    bytes += Buffer.byteLength(line) + 1;
  }
  if (rows[0]?.type !== "run_started" || rows[0].runId !== runId || rows.some(row => !row.type || !Number.isFinite(Date.parse(row.recordedAt)))) throw new Error(`Invalid journal for run ${runId}.`);
  if (bytes < Buffer.byteLength(text)) console.warn(`Ignoring incomplete final journal entry for run ${runId} (${Buffer.byteLength(text) - bytes} bytes).`);
  return { rows, bytes };
}
function entries(stateDir, runId, env) {
  const dir = directory(runDir(stateDir, runId), env);
  return parseEntries(read(path.join(dir, "journal.jsonl")), runId).rows;
}
function append(stateDir, runId, type, data) {
  const file = path.join(runDir(stateDir, runId), "journal.jsonl");
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (stat && !stat.isFile()) throw new Error("Journal must be a regular file.");
  const fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile()) throw new Error("Journal must be a regular file.");
    fs.fchmodSync(fd, 0o600);
    const length = before.size ? parseEntries(fs.readFileSync(fd, "utf8"), runId).bytes : 0;
    if (length !== before.size) fs.ftruncateSync(fd, length);
    try {
      fs.writeFileSync(fd, `${JSON.stringify({ ...data, type, recordedAt: new Date().toISOString() })}\n`);
      fs.fsyncSync(fd);
    } catch (error) {
      try { fs.ftruncateSync(fd, length); fs.fsyncSync(fd); }
      catch (rollback) { throw new AggregateError([error, rollback], "Journal append and rollback failed."); }
      throw error;
    }
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
export function startRun(cwd, sessionId, input, env = process.env, { switchRun = false } = {}) {
  const data = validate("run_started", input);
  session(sessionId);
  const stateDir = resolveStateDir(cwd, env);
  // Pointer mutations take the session-directory lock before a run lock.
  // This ordering serializes starts across workspaces without lock inversion.
  return locked(sessionsDir(env), env, () => {
    const previous = activeRun(sessionId, env);
    if (previous && !switchRun) throw new Error(`Session already has an open run: ${previous.runId}. Close it or use --switch to leave it open and start another.`);
    return locked(stateDir, env, () => {
      const runId = `run-${randomUUID()}`, dir = runDir(stateDir, runId);
      directory(dir, env, true);
      try {
        append(stateDir, runId, "run_started", { runId, ...data, cwd, sessionId });
        atomic(pointer(sessionId, env), `${JSON.stringify({ runId, stateDir })}\n`);
      } catch (error) { fs.rmSync(dir, { recursive: true, force: true }); throw error; }
      return { runId, ...(previous ? { previousRunId: previous.runId } : {}) };
    }, true);
  }, true);
}
export function useRun(cwd, sessionId, runId, env = process.env) {
  session(sessionId);
  id(runId, "runId");
  return locked(sessionsDir(env), env, () => {
    const selected = findRun(resolveStateDir(cwd, env), runId, env);
    return locked(selected.stateDir, env, () => {
      requireOpen(entries(selected.stateDir, runId, env), runId);
      atomic(pointer(sessionId, env), `${JSON.stringify(selected)}\n`);
      return { runId };
    });
  }, true);
}
function singleOpenRun(stateDir, env) {
  const open = listAt(stateDir, env).filter(run => run.state === "open");
  if (open.length > 1) throw Object.assign(new Error(`Multiple open Duet runs in this workspace: ${open.map(run => run.runId).join(", ")}. Select one with duet journal use <runId> or --run <id>.`), {
    code: "RUN_SELECTION_AMBIGUOUS", runIds: open.map(run => run.runId)
  });
  return open.length ? { stateDir, runId: open[0].runId } : null;
}
function target(stateDir, sessionId, runId, env, latest = false) {
  if (runId !== undefined) return findRun(stateDir, runId, env);
  const active = activeRun(sessionId, env);
  if (active) return { stateDir: active.stateDir, runId: active.runId };
  if (latest) {
    const recent = listAt(stateDir, env)[0];
    if (recent) return { stateDir, runId: recent.runId };
  } else {
    const open = singleOpenRun(stateDir, env);
    if (open) return { ...open, fallback: true };
  }
  throw new Error("No active Duet run; use journal start, journal use <runId> or --run <id>.");
}
function findRun(stateDir, runId, env) {
  id(runId, "runId");
  const exists = candidate => {
    try { directory(runDir(candidate, runId), env); return true; }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
  };
  if (exists(stateDir)) return { stateDir, runId };
  // A selected run can outlive its active pointer, including after switching
  // from a different workspace. Resolve its stable id within this isolated home.
  const root = resolveStateRoot(env);
  try {
    directory(root, env);
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === RUN_SESSIONS_DIR) continue;
      const candidate = path.join(root, entry.name);
      if (candidate !== stateDir && exists(candidate)) return { stateDir: candidate, runId };
    }
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  throw new Error(`Unknown run: ${runId}.`);
}
function requireOpen(rows, runId, task = false) {
  if (rows.some(row => row.type === "run_closed")) throw new Error(`Run ${runId} is already closed.${task
    ? " Start a new run with duet journal start, choose another open run with --run <id>, or skip linking with --run none." : ""}`);
}
export function validateTaskRun(cwd, runId, env = process.env) {
  if (runId === undefined || runId === "none") return null;
  const selected = findRun(resolveStateDir(cwd, env), runId, env);
  requireOpen(entries(selected.stateDir, runId, env), runId, true);
  return selected;
}
// K<n> keeps its 1.4.5 forms; other ids need a colon, so a leading word such
// as "S3 bucket" is not mistaken for an id.
const criterionId = criterion => (/^(K\d+)(?=:|\s|$)/.exec(criterion) ?? /^([A-Z]{1,4}\d+)(?=:)/.exec(criterion))?.[1];
function matchCriterion(criterion, known, runId) {
  if (known.includes(criterion)) return criterion;
  const stableId = /^([A-Z]{1,4}\d+):?$/.exec(criterion)?.[1];
  const prefix = criterion.endsWith("…") ? criterion.slice(0, -1) : "";
  const matches = known.filter(text => stableId ? criterionId(text) === stableId
    : prefix && (text.startsWith(prefix) || text.replace(/\s+/g, " ").startsWith(prefix)));
  if (matches.length === 1) return matches[0];
  const knownCriteriaIds = [...new Set(known.map(criterionId).filter(Boolean))];
  throw Object.assign(new Error(`${matches.length ? "Ambiguous" : "Unknown"} criterion in run ${runId}: ${JSON.stringify(criterion)}. Known criteria IDs: ${knownCriteriaIds.join(", ") || "none (use exact criterion text)"}. Use exact text for ambiguous matches; add new criteria with journal add criteria.`), {
    code: matches.length ? "AMBIGUOUS_CRITERION" : "UNKNOWN_CRITERION", knownCriteriaIds
  });
}
export function addEntry(cwd, sessionId, type, input, runId, env = process.env) {
  if (type === "withdraw") type = "criteria_withdrawn";
  if (!["criteria", "criteria_withdrawn", "verdict", "decision"].includes(type)) throw new Error(`Unknown journal entry type: ${type}.`);
  const data = validate(type, input);
  const selected = target(resolveStateDir(cwd, env), sessionId, runId, env), stateDir = selected.stateDir;
  runId = selected.runId;
  return locked(stateDir, env, () => {
    const rows = entries(stateDir, runId, env);
    requireOpen(rows, runId);
    if (selected.fallback) singleOpenRun(stateDir, env);
    if (type === "criteria_withdrawn") {
      const known = new Set(rows.flatMap(row => row.type === "run_started" || row.type === "criteria" ? row.criteria
        : row.type === "verdict" ? row.criteria.map(item => item.criterion) : []));
      for (const criterion of data.criteria) {
        if (!known.has(criterion)) throw new Error(`Unknown criterion in run ${runId}: ${JSON.stringify(criterion)}.`);
      }
    }
    if (type === "verdict") {
      // Canonicalize new writes only. Historical verdict-only criteria remain
      // untouched and retain their existing validation/withdrawal behavior.
      const criteria = [...new Set(rows.flatMap(row => row.type === "run_started" || row.type === "criteria" ? row.criteria : []))];
      data.criteria = data.criteria.map(item => ({ ...item, criterion: matchCriterion(item.criterion, criteria, runId) }));
    }
    if (type === "verdict" && "resolves" in data && data.resolves?.length) {
      const known = new Set(rows.filter(row => row.type === "job_started").map(row => row.jobId));
      for (const jobId of data.resolves) {
        if (!known.has(jobId)) throw new Error(`Unknown resolves jobId in run ${runId}: ${jobId}.`);
      }
    }
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
      const rows = entries(stateDir, runId, env);
      requireOpen(rows, runId);
      // Check the same snapshot we close, while terminal observers and verdict
      // writers are excluded by the run lock. Validation itself only reads.
      const issues = viewAt(stateDir, runId, rows, env).issues;
      if ("judgment" in data && data.judgment === "passed" && issues.length) {
        throw Object.assign(new Error("Run has open issues; passed close refused."), {
          code: "RUN_HAS_OPEN_ISSUES", validation: { runId, ok: false, issues }
        });
      }
      const closed = { ...data, openIssues: issues };
      append(stateDir, runId, "run_closed", closed);
      clearPointers(stateDir, runId, env);
      return { runId, ...closed };
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
  return viewAt(stateDir, runId, entries(stateDir, runId, env), env);
}
function viewAt(stateDir, runId, rows, env) {
  const jobs = new Map(), criteria = [...rows[0].criteria], decisions = [];
  const withdrawn = new Map();
  const started = new Set(), finished = new Set(), liveStatus = new Map();
  const criterionResults = new Map(), verdictOrder = new Map();
  let closed = null;
  for (const [index, row] of rows.entries()) {
    if (row.type === "criteria") {
      criteria.push(...row.criteria);
      for (const criterion of row.criteria) withdrawn.delete(criterion);
    }
    if (row.type === "criteria_withdrawn") {
      for (const criterion of row.criteria) withdrawn.set(criterion, { criterion, reason: row.reason });
    }
    if (row.type === "job_started") {
      started.add(row.jobId);
      jobs.set(row.jobId, { agentName: row.agentName ?? null, jobId: row.jobId, workspaceRoot: row.workspaceRoot ?? rows[0].cwd, cwd: row.cwd ?? row.workspaceRoot ?? rows[0].cwd, threadId: row.threadId ?? null, status: "queued", brief: row.brief, report: null, latestVerdict: jobs.get(row.jobId)?.latestVerdict ?? null,
        ...(row.followUpOf ? { followUpOf: row.followUpOf } : {}), ...(row.continuationOf ? { continuationOf: row.continuationOf } : {}) });
    }
    if (row.type === "job_finished" && jobs.has(row.jobId)) {
      finished.add(row.jobId);
      Object.assign(jobs.get(row.jobId), { status: row.status, report: row.report, threadId: row.threadId ?? jobs.get(row.jobId).threadId });
    }
    if (row.type === "verdict") {
      if (!jobs.has(row.jobId)) jobs.set(row.jobId, { agentName: null, jobId: row.jobId, threadId: null, status: "unknown", brief: null, report: null });
      jobs.get(row.jobId).latestVerdict = row;
      verdictOrder.set(row.jobId, index);
      for (const item of row.criteria) criterionResults.set(item.criterion, { ...item, jobId: row.jobId });
    }
    if (row.type === "decision") decisions.push(row);
    if (row.type === "run_closed") closed = row;
  }
  // Supplement live handles, but recovery never depends on retained job records.
  for (const job of jobs.values()) {
    if (finished.has(job.jobId)) continue;
    try {
      const jobStateDir = job.workspaceRoot ? resolveStateDirForRoot(job.workspaceRoot, env) : stateDir;
      directory(path.join(jobStateDir, "jobs"), env);
      const live = JSON.parse(read(path.join(jobStateDir, "jobs", `${id(job.jobId, "jobId")}.json`)));
      if (live.runId === runId && (live.runStateDir ?? jobStateDir) === stateDir) {
        liveStatus.set(job.jobId, live.status);
        Object.assign(job, { status: live.status, threadId: live.threadId ?? job.threadId });
      }
    } catch { /* pruned or unavailable */ }
  }
  const linked = [...jobs.values()];
  // Explicit resolution or lineage resolves rework, never a shared thread. A
  // later rejection reopens it; a previous acceptance cannot erase that.
  const resolved = new Set();
  for (const job of linked) {
    if (!started.has(job.jobId) || !["ACCEPT", "ACCEPT_WITH_GLUE"].includes(job.latestVerdict?.verdict)) continue;
    for (const jobId of job.latestVerdict.resolves ?? []) {
      if (started.has(jobId) && verdictOrder.get(job.jobId) > verdictOrder.get(jobId)) resolved.add(jobId);
    }
    const pending = [job.followUpOf, job.continuationOf], seen = new Set([job.jobId]);
    while (pending.length) {
      const parentId = pending.pop(), parent = jobs.get(parentId);
      if (!parent || !started.has(parentId) || seen.has(parentId)) continue;
      seen.add(parentId);
      if (verdictOrder.get(job.jobId) > verdictOrder.get(parentId)) resolved.add(parentId);
      pending.push(parent.followUpOf, parent.continuationOf);
    }
  }
  const issues = [];
  for (const job of linked) {
    const jobId = job.jobId;
    const unrecordedFinish = started.has(jobId) && !finished.has(jobId)
      && ["completed", "failed", "cancelled", "interrupted", "blocked", "needs_input", "error"].includes(liveStatus.get(jobId));
    if (started.has(jobId) && !finished.has(jobId) && ["queued", "running"].includes(liveStatus.get(jobId))) issues.push({
      kind: "unfinished_job", jobId, detail: `Linked job is ${job.status} without a recorded finish.`,
      nextAction: "Check job status and its existing owner wait; wait for completion before judging it."
    });
    if (unrecordedFinish) issues.push({
      kind: "unrecorded_finish", jobId, detail: `Linked job is ${job.status} without a recorded finish.`,
      nextAction: `Inspect duet result ${jobId} --details to retry finish recording, then verify the evidence and record a journal verdict.`
    });
    if ((finished.has(jobId) || unrecordedFinish) && !job.latestVerdict) issues.push({
      kind: "no_verdict", jobId, detail: "Finished job has no orchestrator verdict.",
      nextAction: "Inspect the saved report and verify its criteria, then record a journal verdict."
    });
    if (["REWORK", "REASSIGN"].includes(job.latestVerdict?.verdict) && !resolved.has(jobId)) issues.push({
      kind: "open_rework", jobId, detail: `Latest verdict is ${job.latestVerdict.verdict}: ${job.latestVerdict.reason}`,
      nextAction: "Review the findings and verify a correction before recording acceptance; obtain user consent before continuing a stopped job."
    });
    if (finished.has(jobId)) {
      const problem = reportProblem(runDir(stateDir, runId), job.report, env);
      if (problem) issues.push({ kind: "missing_artifact", jobId, detail: problem,
        nextAction: "Inspect the retained job result and recover its report copy if available; otherwise explain the missing evidence and close blocked or abandoned." });
    }
  }
  for (const result of criterionResults.values()) {
    if (!withdrawn.has(result.criterion) && result.result !== "met") issues.push({ kind: "unmet_criterion", jobId: result.jobId, criterion: result.criterion,
      detail: `Latest result is ${result.result}: ${result.evidence}`,
      nextAction: "Resolve the finding and verify this exact criterion, then record a met result with observed evidence." });
  }
  for (const criterion of new Set(criteria)) {
    if (!withdrawn.has(criterion) && !criterionResults.has(criterion)) issues.push({ kind: "unchecked_criterion", criterion, detail: "Task criterion appears in no verdict.",
      nextAction: "Check this exact criterion and record its evidence and result in a journal verdict." });
  }
  const withdrawnCriteria = [...withdrawn.values()];
  return { runId, directory: runDir(stateDir, runId), goal: rows[0].goal, criteria, withdrawnCriteria, jobs: linked, decisions,
    openItems: linked.filter(job => !job.latestVerdict || (["REWORK", "REASSIGN"].includes(job.latestVerdict.verdict) && !resolved.has(job.jobId))).map(job => ({ jobId: job.jobId, reason: job.latestVerdict?.verdict ?? "no_verdict" })),
    criterionResults: [...criteria, ...withdrawnCriteria.map(item => item.criterion).filter(criterion => !criteria.includes(criterion))].map(criterion =>
      withdrawn.has(criterion) ? { ...criterionResults.get(criterion), ...withdrawn.get(criterion), result: "withdrawn" }
        : criterionResults.get(criterion) ?? { criterion, result: "unchecked", evidence: null }), issues,
    state: closed ? "closed" : "open", closed };
}
function reportProblem(dir, report, env) {
  if (typeof report !== "string" || !report.trim()) return "Finished job has no report path.";
  const file = path.resolve(dir, report), relative = path.relative(dir, file);
  if (path.isAbsolute(report) || !relative || relative === ".." || relative.startsWith(`..${path.sep}`)) return "Finished job report path is outside the run directory.";
  try {
    directory(path.dirname(file), env);
    if (!read(file).trim()) return `Report artifact is empty: ${report}`;
  } catch { return `Report artifact is missing, unreadable or not a regular file: ${report}`; }
  return null;
}
export function validateRun(cwd, sessionId, runId, env = process.env) {
  const view = showRun(cwd, sessionId, runId, env);
  return { runId: view.runId, ok: view.issues.length === 0, issues: view.issues };
}
const short = (text, limit = 180) => { const flat = String(text ?? "").replace(/\s+/g, " "); return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat; };
const renderIssue = issue => `  ${issue.kind}${issue.jobId ? ` ${issue.jobId}` : ""}${issue.criterion ? ` [${short(issue.criterion)}]` : ""}: ${short(issue.detail)} Next: ${issue.nextAction}`;
export function renderValidation(result) {
  return [`Run ${result.runId}: ${result.ok ? "no open issues" : `${result.issues.length} open issue(s)`} (record completeness).`, ...result.issues.map(renderIssue)].join("\n") + "\n";
}
export function renderRun(view) {
  const lines = [`Run ${view.runId} (${view.state}${view.closed ? `: ${view.closed.judgment}` : ""}): ${short(view.goal, 240)}`, `Files: ${view.directory}`, "Criteria:",
    ...view.criterionResults.map((item, index) => `  ${index + 1}. ${short(item.criterion)} — ${item.result}${item.reason ? `; reason: ${short(item.reason)}` : ""}${item.evidence ? `; evidence: ${short(item.evidence)}` : ""}`), "Jobs:",
    ...view.jobs.map(job => `  ${job.agentName ?? "worker"} ${job.jobId} thread=${job.threadId ?? "?"} ${job.status} verdict=${job.latestVerdict?.verdict ?? "none"}; brief=${job.brief ?? "?"} report=${job.report ?? "pending"}`),
    "Decisions:", ...view.decisions.map(item => `  ${short(item.summary)}; basis: ${short(item.basis)}${item.risk ? `; risk: ${short(item.risk)}` : ""}`),
    "Open:", ...(view.issues.length ? view.issues.map(renderIssue) : ["  none"]),
    ...(view.closed ? [`Close: ${short(view.closed.summary)}; open risks: ${(view.closed.openRisks ?? []).map(item => short(item)).join("; ") || "none"}`] : [])];
  return `${lines.join("\n")}\n`;
}
export function activeRunContext(cwd, sessionId, env = process.env) {
  const run = readActiveRun(cwd, sessionId, env);
  return run ? `Active Duet run ${run.runId}: ${short(run.goal, 80)}. Run node "$CODEX_COMPANION" journal show to recover criteria, verdicts and open work.` : null;
}

// Automatic linkage is best effort (storage failures and an ambiguous choice
// among several open runs leave the job unlinked); explicit linkage must
// succeed before dispatch.
// Callers persist runId on the ordinary record for terminal observers.
export function linkJournalJob(job, brief, env = process.env) {
  const requested = job.request?.run;
  if (requested === "none") return null;
  const explicit = requested !== undefined;
  try {
    const link = (run, rows) => {
      const stateDir = run.stateDir, jobId = id(job.id, "jobId");
      requireOpen(rows, run.runId);
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
    };
    const cwd = job.cwd ?? job.workspaceRoot;
    if (explicit) {
      const run = validateTaskRun(cwd, requested, env);
      return locked(run.stateDir, env, () => link(run, entries(run.stateDir, run.runId, env)));
    }
    const stateDir = resolveStateDir(cwd, env);
    // Avoid creating journal state for tasks with no pointer or workspace runs.
    if (!activePointer(job.sessionId, env)) directory(runsDir(stateDir), env);
    // Match start/use/close lock ordering, and read streams only under their
    // workspace lock. Selection cannot race another start or session switch.
    return locked(sessionsDir(env), env, () => {
      const active = activePointer(job.sessionId, env);
      if (active) {
        let linked, readActive = false;
        try {
          linked = locked(active.stateDir, env, () => {
            const rows = entries(active.stateDir, active.runId, env);
            readActive = true;
            return rows.some(row => row.type === "run_closed") ? null : link(active, rows);
          });
        } catch (error) { if (error.code !== "ENOENT" || readActive) throw error; }
        if (linked) return linked;
      }
      return locked(stateDir, env, () => {
        const run = singleOpenRun(stateDir, env);
        return run ? link(run, entries(stateDir, run.runId, env)) : null;
      });
    }, true);
  } catch (error) { if (explicit) throw error; return null; }
}
export function finishJournalJob(job, report, env = process.env) {
  if (!job.runId || job.jobClass !== "task" || ["queued", "running"].includes(job.status)) return false;
  try {
    const stateDir = runStateDirectory(job.runStateDir ?? resolveStateDirForRoot(job.workspaceRoot, env), env);
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
      const stateDir = row.workspaceRoot ? resolveStateDirForRoot(row.workspaceRoot, env) : resolveStateDir(rows[0].cwd, env);
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
