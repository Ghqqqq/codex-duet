import fs from "node:fs";
import path from "node:path";
import { importLegacyJob, listJobs, listSessionJobs, resolveStateDir, resolveStateDirForRoot, startedThreadSettings, unresolvedTask } from "./state.mjs";

// Count pruning keeps the same settings anchors that inheritance reads.
export { startedThreadSettings };
import { readStoredJob } from "./job-control.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

const newest = jobs => [...jobs].sort((a, b) =>
  String(b.createdAt ?? b.startedAt ?? b.updatedAt ?? "").localeCompare(String(a.createdAt ?? a.startedAt ?? a.updatedAt ?? "")) || b.id.localeCompare(a.id));

const reportSession = job => (job.sessionId === undefined ? job.ownerId : job.sessionId) || null;
const activeJob = job => ["queued", "running", "needs_answer"].includes(job.status);
const pendingQuestion = job => activeJob(job) && job.pendingQuestion && job.pendingQuestion.answer === undefined;

export function requestGrantsInSession(job, session = process.env.CODEX_COMPANION_SESSION_ID?.trim() || null) {
  return Boolean(job?.request) && reportSession(job) === session &&
    // Adoption moves ownership; it does not re-authorize the original request.
    // Legacy adopted jobs have no dispatch provenance, so their grants are
    // unknown even when the replacement owner is in this session.
    (job.dispatchSessionId === undefined ? !job.retiredOwnerIds?.length : (job.dispatchSessionId || null) === session);
}

// Read the resolver's workspace/session scope without migrating state from
// inside the delivery hook. The resolver applies name matching to this snapshot.
// Session-scoped scans skip other sessions' jobs before validating their roots;
// `filter` narrows an all-workspace scan the same way.
export function reportJobs(job, env = process.env, { allWorkspaces = false, filter = null } = {}) {
  const cwd = job.workspaceRoot ?? job.request?.cwd;
  if (!cwd) return [];
  const session = allWorkspaces ? null : reportSession(job);
  try {
    const ownDir = resolveStateDir(cwd, env), root = path.dirname(ownDir);
    const stateDirs = new Map([[cwd, ownDir]]);
    const directories = allWorkspaces || reportSession(job)
      ? fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => path.join(root, entry.name))
      : [ownDir];
    return directories.flatMap(directory => {
      let jobs;
      try { jobs = JSON.parse(fs.readFileSync(path.join(directory, "state.json"), "utf8")).jobs; }
      catch { return []; }
      return (Array.isArray(jobs) ? jobs : []).map(candidate => ({
        ...candidate, workspaceRoot: candidate.workspaceRoot ?? (directory === ownDir ? cwd : null)
      })).filter(candidate => {
        if (typeof candidate.workspaceRoot !== "string") return false;
        if ((session && reportSession(candidate) !== session) || (filter && !filter(candidate))) return false;
        // Several jobs usually share a root; canonicalize it once per scan.
        if (!stateDirs.has(candidate.workspaceRoot)) stateDirs.set(candidate.workspaceRoot, resolveStateDirForRoot(candidate.workspaceRoot, env));
        return stateDirs.get(candidate.workspaceRoot) === directory;
      });
    });
  } catch { return []; }
}

// A name is safe only in the owning session and only when every generated
// command resolves it to this job. Explicit IDs survive another caller's scope.
export function reportWorkerTarget(job, jobs, worker = job.agentName, jobId = job.id, env = process.env) {
  const workspace = job.workspaceRoot ?? job.request?.cwd;
  if (!worker || !jobId || !workspace || !Array.isArray(jobs)) return jobId;
  if (reportSession(job) !== (env.CODEX_COMPANION_SESSION_ID?.trim() || null)) return jobId;
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

function resolutionError(reference, reason, candidates, command) {
  const listing = candidates.map(job => `${job.agentName ?? "(unnamed)"} | jobId=${job.id} | threadId=${job.threadId ?? "none"} | cwd=${job.request?.cwd ?? job.workspaceRoot ?? "unknown"} | status=${job.status}`).join("\n");
  const guidance = ["wait", "answer", "cancel"].includes(command)
    ? `Pass an exact positional job ID: duet ${command} <jobId>. Find job IDs with duet status --all.`
    : "Pass a jobId or --thread <id>.";
  return new Error(`Worker "${reference}": ${reason}. ${guidance} Candidates:\n${listing || "(none in the current session/workspace)"}`);
}

// Names are scoped; explicit legacy IDs/threads remain usable in their workspace.
// Repeated jobs on one thread represent one worker. Reused names across threads do not.
export function resolveWorkerTarget(cwd, reference, { command = "task", pending = false, nameState = null, legacyReferences = false, sessionId = process.env.CODEX_COMPANION_SESSION_ID?.trim(), jobs: snapshot = null } = {}) {
  const jobs = scopedJobs(cwd, sessionId, snapshot);
  const named = jobs.filter(job => job.agentName?.toLowerCase() === reference.toLowerCase());
  let matches = jobs.filter(job => job.id === reference);
  // Exact job IDs are handles, not names. Keep them usable across sessions in
  // their own workspace, including generated wait/answer/follow-up commands.
  if (!matches.length) matches = (snapshot ?? listJobs(resolveWorkspaceRoot(cwd))).filter(job => job.id === reference);
  if (!matches.length && !snapshot && (/^(task|review|job)-/.test(reference) || !named.length)) {
    // Compact report commands may omit a very long --cwd. Only exact handles
    // may cross workspace/session boundaries; names retain their usual scope.
    // Generated IDs use task/review (or generateJobId's default job) prefixes.
    // A known worker name does not need the all-workspace exact-ID fallback.
    matches = reportJobs({ workspaceRoot: resolveWorkspaceRoot(cwd) }, process.env, { allWorkspaces: true, filter: job => job.id === reference });
    if (matches.length > 1) throw resolutionError(reference, "ambiguous job ID across workspaces", matches, command);
  }
  if (!matches.length) {
    matches = named;
    if (matches.length) {
      const candidates = matches.map(job => snapshot ? job : stored(job, cwd));
      // Apply command-state preference before the workspace tie-break.
      const fits = nameState === "pending" || pending ? pendingQuestion : ["active", "wait", "cancel"].includes(nameState) ? activeJob : null;
      let fitting = fits ? candidates.filter(fits) : [];
      // An explicit question can be stale. Diagnose it on the live original,
      // never on a newer refused attempt with a different owner.
      if (!fitting.length && nameState === "pending" && !pending) fitting = candidates.filter(activeJob);
      if (!fitting.length && nameState === "pending" && !pending) fitting = candidates.filter(unresolvedTask);
      if (!fitting.length && ["wait", "cancel"].includes(nameState)) fitting = candidates.filter(unresolvedTask);
      if (!fitting.length && nameState === "cancel") throw resolutionError(reference, "no active or unresolved job", candidates, command);
      if (!fitting.length && (pending || nameState === "pending")) throw resolutionError(reference, "no pending unanswered question", candidates, command);
      matches = fitting.length ? fitting : candidates;
      if (new Set(matches.map(job => job.threadId ?? job.id)).size > 1) {
        // 1.3 assigned names within each workspace. Preserve a unique local
        // thread when command state alone cannot disambiguate those names.
        const workspace = resolveWorkspaceRoot(cwd);
        const local = matches.filter(job => resolveWorkspaceRoot(job.workspaceRoot ?? job.request?.cwd ?? cwd) === workspace);
        if (local.length) matches = local;
      }
      if (new Set(matches.map(job => job.threadId ?? job.id)).size > 1) throw resolutionError(reference, "ambiguous name across threads", candidates, command);
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
      if (matches.length > 1) throw resolutionError(reference, "ambiguous job ID", matches, command);
    }
  }
  const resolvedJob = command === "answer" && matches.length === 1 && matches[0].id === reference
    ? snapshot ? matches[0] : stored(matches[0], cwd) : null;
  if (pending) matches = matches.filter(job => pendingQuestion(snapshot ? job : stored(job, cwd)));
  if (!matches.length) throw Object.assign(resolutionError(reference, pending ? "no pending unanswered question" : "no match", jobs, command),
    resolvedJob ? { resolvedJob } : {});
  return target(matches[0], cwd, snapshot !== null);
}


export function latestThreadJob(cwd, threadId, { startedOnly = false } = {}) {
  for (const job of scopedJobs(cwd).filter(job => job.threadId === threadId)) {
    const record = stored(job, cwd);
    if (!startedOnly || startedThreadSettings(record)) return record;
  }
  return null;
}

// 1.3 foreground jobs have no request: their sandbox/write live on the job,
// and model/effort/tier plus sandboxPolicy live in its result. Background jobs
// and 1.4 foreground jobs also persist the original request.
export function recordedThreadSettings(job) {
  const sources = [job?.request, job, job?.result, job?.report].filter(Boolean);
  const modes = ["read-only", "workspace-write", "danger-full-access"];
  const policyModes = { readOnly: "read-only", workspaceWrite: "workspace-write", dangerFullAccess: "danger-full-access" };
  let sandbox = sources.map(source => source.sandbox).find(value => modes.includes(value));
  sandbox ??= sources.map(source => policyModes[source.sandboxPolicy?.type]).find(Boolean);
  if (!sandbox) {
    const write = sources.map(source => source.write).find(value => typeof value === "boolean");
    if (write !== undefined) sandbox = write ? "workspace-write" : "read-only";
  }
  return { sandbox,
    ...Object.fromEntries(["model", "effort", "serviceTier"].map(key => [key, sources.find(source => source[key] !== undefined)?.[key]])) };
}

export function resolveThreadInheritance(cwd, threadId, { allowCrossSessionFallback = false } = {}) {
  const job = latestThreadJob(cwd, threadId, { startedOnly: true });
  const session = process.env.CODEX_COMPANION_SESSION_ID?.trim();
  const latest = newest([...(job ? [job] : []), ...listJobs(resolveWorkspaceRoot(cwd))])
    .filter(candidate => candidate.threadId === threadId).map(candidate => stored(candidate, cwd)).find(startedThreadSettings);
  if (!job && allowCrossSessionFallback && latest) {
    return { job: stored(latest, cwd), details: {
      jobId: latest.id, scope: "workspace",
      settingsInherited: true, requestGrantsInherited: false,
      note: "Inherited settings from the newest job on this thread; request grants were excluded because it belongs to another session."
    } };
  }
  const skipped = session && latest && (latest.sessionId === undefined ? latest.ownerId : latest.sessionId) !== session;
  const grants = requestGrantsInSession(job, session || null);
  return { job, ...(skipped ? { details: {
    jobId: job?.id ?? null, skippedJobId: latest.id, scope: "session",
    settingsInherited: Boolean(job), requestGrantsInherited: grants,
    note: job ? `Inherited settings${grants ? " and recorded request grants" : " only"} from this session's latest job; a newer job on the thread belongs to another session.`
      : "No settings or request grants inherited: the thread's latest job belongs to another session and this session has no previous job."
  } } : job ? { details: {
    jobId: job.id, scope: session ? "session" : "workspace",
    settingsInherited: true, requestGrantsInherited: grants,
    note: grants
      ? "Inherited settings and recorded request grants from this session's job; runtime-only grants were excluded."
      : "Inherited settings from this job; no request grants recorded in this session were inherited."
  } } : {}) };
}
