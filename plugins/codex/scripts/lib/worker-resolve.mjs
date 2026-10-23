import fs from "node:fs";
import path from "node:path";
import { importLegacyJob, listJobs, listSessionJobs, resolveStateDir } from "./state.mjs";
import { readStoredJob } from "./job-control.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

const newest = jobs => [...jobs].sort((a, b) =>
  String(b.createdAt ?? b.startedAt ?? b.updatedAt ?? "").localeCompare(String(a.createdAt ?? a.startedAt ?? a.updatedAt ?? "")) || b.id.localeCompare(a.id));

const reportSession = job => job.sessionId ?? null;
const activeJob = job => ["queued", "running", "needs_answer"].includes(job.status);
const pendingQuestion = job => activeJob(job) && job.pendingQuestion && job.pendingQuestion.answer === undefined;

// Read the resolver's workspace/session scope without migrating state from
// inside the delivery hook. The resolver applies name matching to this snapshot.
export function reportJobs(job, env = process.env) {
  const cwd = job.workspaceRoot ?? job.request?.cwd;
  if (!cwd) return [];
  try {
    const ownDir = resolveStateDir(cwd, env), root = path.dirname(ownDir);
    const directories = reportSession(job)
      ? fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => path.join(root, entry.name))
      : [ownDir];
    return directories.flatMap(directory => {
      let jobs;
      try { jobs = JSON.parse(fs.readFileSync(path.join(directory, "state.json"), "utf8")).jobs; }
      catch { return []; }
      return (Array.isArray(jobs) ? jobs : []).map(candidate => ({
        ...candidate, workspaceRoot: candidate.workspaceRoot ?? (directory === ownDir ? cwd : null)
      })).filter(candidate => typeof candidate.workspaceRoot === "string" && resolveStateDir(candidate.workspaceRoot, env) === directory);
    });
  } catch { return []; }
}

// Commands run in the job's current owning session. Dispatch provenance is
// deliberately independent, so adoption changes this scope in every projection.
export function reportWorkerTarget(job, jobs, worker = job.agentName, jobId = job.id) {
  const workspace = job.workspaceRoot ?? job.request?.cwd;
  if (!worker || !jobId || !workspace || !Array.isArray(jobs)) return jobId;
  try {
    const resolved = resolveWorkerTarget(workspace, worker, { sessionId: reportSession(job), jobs });
    return resolved.job.id === jobId ? worker : jobId;
  } catch { return jobId; }
}

function scopedJobs(cwd, session = process.env.CODEX_COMPANION_SESSION_ID?.trim(), jobs = null) {
  const workspace = resolveWorkspaceRoot(cwd);
  const candidates = jobs ?? (session ? listSessionJobs(workspace, session) : listJobs(workspace));
  return newest(candidates.filter(job => !session || (job.sessionId === undefined ? job.ownerId : job.sessionId) === session));
}

function stored(job, cwd) {
  return readStoredJob(job.workspaceRoot ?? resolveWorkspaceRoot(cwd), job.id) ?? job;
}

function target(job, cwd, snapshot = false) {
  const record = snapshot ? job : stored(job, cwd);
  return { job: record, reference: record.id, cwd: record.request?.cwd ?? record.workspaceRoot ?? cwd };
}

function resolutionError(reference, reason, candidates) {
  const listing = candidates.map(job => `${job.agentName ?? "(unnamed)"} | jobId=${job.id} | threadId=${job.threadId ?? "none"} | cwd=${job.request?.cwd ?? job.workspaceRoot ?? "unknown"} | status=${job.status}`).join("\n");
  return new Error(`Worker "${reference}": ${reason}. Pass a jobId or --thread <id>. Candidates:\n${listing || "(none in the current session/workspace)"}`);
}

// Names are scoped; explicit legacy IDs/threads remain usable in their workspace.
// Repeated jobs on one thread represent one worker. Reused names across threads do not.
export function resolveWorkerTarget(cwd, reference, { pending = false, nameState = null, legacyReferences = false, sessionId = process.env.CODEX_COMPANION_SESSION_ID?.trim(), jobs: snapshot = null } = {}) {
  const jobs = scopedJobs(cwd, sessionId, snapshot);
  let matches = jobs.filter(job => job.id === reference);
  if (!matches.length) {
    matches = jobs.filter(job => job.agentName?.toLowerCase() === reference.toLowerCase());
    if (new Set(matches.map(job => job.threadId ?? job.id)).size > 1) {
      const candidates = matches.map(job => snapshot ? job : stored(job, cwd));
      // State may break a name tie only when exactly one job fits the command.
      const fits = nameState === "pending" || pending ? pendingQuestion : nameState === "active" ? activeJob : null;
      const fitting = fits ? candidates.filter(fits) : [];
      if (fitting.length !== 1) throw resolutionError(reference, "ambiguous name across threads", candidates);
      matches = fitting;
    }
  }
  if (!matches.length && legacyReferences) {
    const workspace = resolveWorkspaceRoot(cwd);
    let local = newest(listJobs(workspace));
    if (!local.some(job => job.id === reference || job.threadId === reference || job.id.startsWith(reference)) && importLegacyJob(workspace, reference)) {
      local = newest(listJobs(workspace));
    }
    matches = local.filter(job => job.id === reference);
    if (!matches.length) matches = local.filter(job => job.threadId === reference);
    if (!matches.length) {
      matches = local.filter(job => job.id.startsWith(reference));
      if (matches.length > 1) throw resolutionError(reference, "ambiguous job ID", matches);
    }
  }
  if (pending) matches = matches.filter(job => pendingQuestion(snapshot ? job : stored(job, cwd)));
  if (!matches.length) throw resolutionError(reference, pending ? "no pending unanswered question" : "no match", jobs);
  return target(matches[0], cwd, snapshot !== null);
}

export function latestThreadJob(cwd, threadId) {
  const jobs = scopedJobs(cwd).filter(job => job.threadId === threadId);
  return jobs.length ? stored(jobs[0], cwd) : null;
}

export function resolveThreadInheritance(cwd, threadId, { allowCrossSessionFallback = false } = {}) {
  const job = latestThreadJob(cwd, threadId);
  const session = process.env.CODEX_COMPANION_SESSION_ID?.trim();
  const latest = newest([...(job ? [job] : []), ...listJobs(resolveWorkspaceRoot(cwd))])
    .find(candidate => candidate.threadId === threadId);
  if (!job && allowCrossSessionFallback && latest) {
    return { job: stored(latest, cwd), details: {
      jobId: latest.id, scope: "workspace",
      note: "Inherited settings and recorded request grants from the newest job on this thread because this session has no previous job; runtime-only grants were excluded."
    } };
  }
  const skipped = session && latest && (latest.sessionId === undefined ? latest.ownerId : latest.sessionId) !== session;
  return { job, ...(skipped ? { details: {
    jobId: job?.id ?? null, skippedJobId: latest.id, scope: "session",
    note: job ? "Inherited settings and request grants from this session's latest job; a newer job on the thread belongs to another session."
      : "No settings or request grants inherited: the thread's latest job belongs to another session and this session has no previous job."
  } } : allowCrossSessionFallback && job ? { details: {
    jobId: job.id, scope: session ? "session" : "workspace",
    note: "Inherited settings and recorded request grants from this job; runtime-only grants were excluded."
  } } : {}) };
}
