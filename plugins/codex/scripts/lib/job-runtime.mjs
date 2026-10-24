import { fileURLToPath } from "node:url";
import { snippet, activityReader, redactActivity } from "./activity.mjs";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { listJobs, updateJob, readJobFile, resolveJobFile, resolveStateRoot, resolveStateDirForRoot, unresolvedTask } from "./state.mjs";
import { APPROVAL_OPTIONS, parseApprovalAnswer } from "./server-requests.mjs";
import { finishJournalJob } from "./run-journal.mjs";
import { buildWorkerReport } from "./worker-report.mjs";
import { reportJobs, reportWorkerTarget } from "./worker-resolve.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";
import { reserveAgentName } from "./agent-names.mjs";

export const ACTIVE = new Set(["queued", "running"]);
// Thread IDs are global to the isolated runtime, unlike workspace job indexes.
// Read matching records and check for unindexed owners across workspaces.
export function recordedThreadJobs(threadId) {
  const inventory = { jobs: [], complete: true }, root = resolveStateRoot();
  let directories;
  try { directories = fs.readdirSync(root, { withFileTypes: true }); }
  catch { inventory.complete = false; return inventory; }
  for (const entry of directories) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(root, entry.name);
    const indexed = new Map();
    let indexMissing = false;
    try {
      const index = JSON.parse(fs.readFileSync(path.join(directory, "state.json"), "utf8"));
      if (!Array.isArray(index?.jobs)) throw new Error("Invalid job index");
      for (const job of index.jobs) {
        if (!job || typeof job.id !== "string" || !/^[\w-]+$/.test(job.id) || typeof job.workspaceRoot !== "string" || !job.workspaceRoot) {
          inventory.complete = false;
          continue;
        }
        if (indexed.has(job.id)) inventory.complete = false;
        indexed.set(job.id, job);
      }
    } catch (error) {
      if (error.code === "ENOENT") indexMissing = true;
      else inventory.complete = false;
    }
    let files = [];
    try {
      files = fs.readdirSync(path.join(directory, "jobs")).filter(name => /^[\w-]+\.json$/.test(name));
    } catch (error) { if (error.code !== "ENOENT") inventory.complete = false; }
    // Broker/journal-only workspaces need no index. An index is required once
    // private records exist, even when the readable orphans belong elsewhere.
    if (indexMissing && files.length) inventory.complete = false;
    const present = new Set(files.map(name => name.slice(0, -5)));
    for (const job of indexed.values()) {
      if (job.threadId === threadId && !present.has(job.id)) inventory.complete = false;
    }
    for (const name of files) {
      const job = indexed.get(name.slice(0, -5));
      if (job && job.threadId !== threadId) continue;
      try {
        const stored = readJobFile(path.join(directory, "jobs", name));
        if (!job) {
          if (!stored || typeof stored !== "object" || Array.isArray(stored) ||
              (stored.threadId != null && (typeof stored.threadId !== "string" || !stored.threadId))) {
            inventory.complete = false;
            continue;
          }
          if (stored.threadId !== threadId) continue;
        }
        if (!stored || stored.id !== name.slice(0, -5) || typeof stored.workspaceRoot !== "string" || !stored.workspaceRoot ||
            typeof stored.status !== "string" || !stored.status ||
            (stored.threadId != null && (typeof stored.threadId !== "string" || !stored.threadId)) ||
            (stored.turnId != null && (typeof stored.turnId !== "string" || !stored.turnId))) {
          inventory.complete = false;
          continue;
        }
        // updateJob publishes the private record before the index. A target
        // mismatch during that interval defers handle-less recovery until retry.
        if (job && (job.workspaceRoot !== stored.workspaceRoot || job.threadId !== stored.threadId || job.turnId !== stored.turnId)) inventory.complete = false;
        if (stored.threadId !== threadId) continue;
        if (resolveStateDirForRoot(stored.workspaceRoot) !== directory) { inventory.complete = false; continue; }
        if (!job) {
          // Pruning publishes the index before unlinking old private records.
          // A resolved orphan still owns its turn, but cannot hide another start.
          if (ACTIVE.has(stored.status) || unresolvedTask(stored)) inventory.complete = false;
          else if (!stored.turnId) continue;
        }
        inventory.jobs.push(stored);
      } catch { inventory.complete = false; }
    }
  }
  return inventory;
}

// Codex timestamps turn starts in seconds. A dead wrapper's request may still
// be accepted later, so its exit cannot close the possible start window.
export function turnInJobStartWindow(job, startedAt) {
  const since = Math.floor(Date.parse(job.startedAt ?? job.createdAt) / 1000);
  if (!Number.isFinite(since) || !Number.isFinite(startedAt)) return null;
  return startedAt >= since;
}

export function uniqueTurnAttribution(job, turn, inventory = recordedThreadJobs(job.threadId), admittingJobId = null) {
  if (!inventory.complete || turnInJobStartWindow(job, turn.startedAt) !== true) return false;
  return !inventory.jobs.some(candidate => {
    if (candidate.id === job.id && candidate.workspaceRoot === job.workspaceRoot) return false;
    if (candidate.turnId) return candidate.turnId === turn.id;
    // The caller may be recovering its predecessor before attempting admission;
    // that particular invocation has not submitted any turn yet.
    if (candidate.id === admittingJobId && candidate.workspaceRoot === job.workspaceRoot) return false;
    if (candidate.recovery?.turnStatus === "notStarted" || candidate.result?.blockers?.some(blocker =>
      ["thread_busy", "thread_settings_unknown"].includes(blocker.code))) return false;
    return turnInJobStartWindow(candidate, turn.startedAt) !== false;
  });
}
export function recordFinishedJob(job) {
  if (!job?.runId || ACTIVE.has(job.status) || job.journalFinishedStatus === job.status) return;
  try {
    const report = job.report ?? buildWorkerReport(job.result ?? { status: 1, error: job.errorMessage ?? "No stored result." }, { jobId: job.id, rawOutputFile: job.rawOutputFile, resultFile: job.resultFile });
    if (finishJournalJob(job, fullReport({ ...report, status: job.status, ...leaseExpiryReport(job) }, job))) {
      // The journal lock has been released before acquiring the job-state lock.
      updateJob(job.workspaceRoot, job.id, () => ({ journalFinishedStatus: job.status }));
    }
  } catch { /* terminal journaling never changes the job outcome */ }
}
export function seconds(value, fallback, name, maximum = 86400) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(String(value)) || Number(value) < 1 || Number(value) > maximum) throw new Error(`${name} must be an integer from 1 to ${maximum}.`);
  return Number(value);
}
export const ownerId = jobId => `${jobId}-${randomUUID()}`;
// An attached owner `wait` renews about once per second, so leaseRenewedAt doubles
// as its heartbeat. After the owner detaches abnormally (signal, parent shell
// gone, closed stdout) or its heartbeat stops, the worker interrupts the turn once
// this grace period passes without a re-attach. The grace covers a Claude Bash
// timeout kill followed by an immediate re-run of wait; a user stop never re-attaches.
// Grace applies only to a silent owner (heartbeat stopped without a detach mark,
// e.g. SIGKILL). The attached owner renews at least once a second, so 5 s is
// several missed beats. An owner that could mark its exit (signal, parent gone,
// closed pipe) is treated like a killed native subagent: stop immediately.
export const OWNER_GRACE_MS = (() => {
  const raw = process.env.CODEX_COMPANION_OWNER_GRACE_SEC;
  return /^\d+$/.test(raw ?? "") && Number(raw) >= 1 && Number(raw) <= 600 ? Number(raw) * 1000 : 5000;
})();
export const PAUSE_THRESHOLD_MS = 2000;
export function pauseAdjustment(job, gapMs, now) {
  if (!Number.isFinite(gapMs) || gapMs <= PAUSE_THRESHOLD_MS || !ACTIVE.has(job.status) || job.cancelRequested) return null;
  const patch = { lastPauseMs: gapMs, lastPauseAt: now };
  // The owner may already have renewed after wake. Never put its heartbeat in
  // the future or grant more than one full lease from this tick.
  if (Number.isFinite(job.leaseRenewedAt)) patch.leaseRenewedAt = Math.min(job.leaseRenewedAt + gapMs, now);
  if (Number.isFinite(job.leaseExpiresAt)) patch.leaseExpiresAt = Math.min(job.leaseExpiresAt + gapMs, now + (job.leaseSec ?? 180) * 1000);
  return patch;
}
export function renewLease(cwd, id, owner) {
  return updateJob(cwd, id, job => {
    const now = Date.now(); // Check expiry after acquiring the state lock.
    return owner && ACTIVE.has(job.status) && job.ownerId === owner && !job.cancelRequested && (!job.leaseExpiresAt || job.leaseExpiresAt > now)
      ? { leaseRenewedAt: now, leaseExpiresAt: now + (job.leaseSec ?? 180) * 1000 } : null;
  });
}
// reason: null (attach) | "returned" (clean exit: timeout/terminal/question) |
// "signal" | "parent_exit" | "stdout_closed" (the owner was stopped: interrupt now).
export function markOwnerAttachment(cwd, id, owner, reason = null) {
  const result = updateJob(cwd, id, job => {
    if (!owner || job.ownerId !== owner) return null;
    const now = Date.now();
    if (reason !== null) return job.ownerAttached || ACTIVE.has(job.status) ? { ownerAttached: false, ownerDetachedAt: now, ownerDetachReason: reason } : null;
    if (!ACTIVE.has(job.status) || (job.leaseExpiresAt && job.leaseExpiresAt <= now)) return null;
    return { ownerAttached: true, ownerAttachedAt: now, ownerDetachedAt: null, ownerDetachReason: null, leaseRenewedAt: now, leaseExpiresAt: now + (job.leaseSec ?? 180) * 1000 };
  });
  recordFinishedJob(result);
  return result;
}
export function ownerLost(job, now = Date.now()) {
  if (!ACTIVE.has(job.status)) return false;
  if (job.ownerAttached) return Boolean(job.leaseRenewedAt) && now - job.leaseRenewedAt >= OWNER_GRACE_MS;
  return Boolean(job.ownerDetachedAt) && job.ownerDetachReason !== null && job.ownerDetachReason !== "returned";
}
const quote = value => `'${String(value).replace(/'/g, `'"'"'`)}'`;
const companionCommand = args => `node ${quote(fileURLToPath(new URL("../codex-companion.mjs", import.meta.url)))} ${args}`;
export function continuationReport(job) {
  const continuationCommand = job.threadId && job.id ? companionCommand(`task --continue ${quote(job.id)} --cwd ${quote(job.request?.cwd ?? job.workspaceRoot)} ${job.direct ? "--direct" : "--follow --report --json"}`) : null;
  return { continuationCommand,
    continuationNote: continuationCommand ? "Starts one new turn on the same Codex thread with this job's recorded sandbox, write, model and browser-origin settings; append extra instructions as the prompt. It has not been run. Wait for any pending interruption to finish first." : "No thread handle was recorded; no continuation command is available." };
}
// The details view retains the full report and the old direct-mode commands,
// summary and expanded lists. JSON/feed callers keep their existing payloads.
export function fullReport(payload, job = {}) {
  const report = { ...payload,
    ...((payload.usage ?? job.result?.usage) ? { usage: payload.usage ?? job.result.usage } : {}),
    ...(job.backgroundTerminals ? { backgroundTerminals: job.backgroundTerminals } : {}),
    ...(job.request?.claudeMd ? { claudeMd: job.request.claudeMd } : {}),
    ...(job.request?.settingsInheritance ? { settingsInheritance: job.request.settingsInheritance } : {}),
    ...(payload.activityCount === undefined && job.activity ? { activityCount: job.activity.length } : {}),
    ...(job.agentName ? { agentName: job.agentName } : {}) };
  // Older stored reports may predate status normalization. Project their
  // decision without rewriting the record or overriding failure states.
  const structured = job.result?.structured;
  if (structured) report.declaredStatus = structured.status;
  if (["completed", "needs_input", "blocked"].includes(report.status)) {
    if (structured?.blockers?.length || (report.status === "completed" && report.blockers?.length)) report.status = "blocked";
    else if (report.status === "completed" && structured?.question) {
      report.status = "needs_input";
      report.question = redactActivity(structured.question);
    }
  }
  if (ACTIVE.has(report.status) || report.status === "needs_answer") {
    const target = `${quote(job.id)} --cwd ${quote(job.request?.cwd ?? job.workspaceRoot)} --owner ${quote(job.ownerId)}`;
    const question = report.status === "needs_answer" ? report.question : null;
    report.waitCommand = companionCommand(`wait ${target} --direct${question ? ` --after-question ${quote(question.id)}` : ""}`);
    if (question) {
      report.answerCommand = companionCommand(`answer ${target} --question ${quote(question.id)} --json`);
      report.answerAndWaitCommand = companionCommand(`answer ${target} --question ${quote(question.id)} --direct`);
    }
  } else if (report.status !== "completed" && report.status !== "ownership_moved" && job.threadId) {
    Object.assign(report, continuationReport({ ...job, direct: true }));
  }
  // A terminal report carries Codex's final summary, so the caller does not
  // have to read rawOutputFile for the answer itself.
  if (!ACTIVE.has(report.status) && report.status !== "needs_answer" && report.status !== "ownership_moved") {
    for (const [target, values] of [
      ["touchedFiles", job.result?.touchedFiles],
      ["preExistingChanges", job.result?.preExistingChanges],
      ["verification", job.result?.commandExecutions?.map(c => `${c.command ?? "command"}: exit ${c.exitCode ?? "unknown"}, ${c.status ?? "unknown"}`)]
    ]) {
      if (!Array.isArray(values)) continue;
      report[target] = values.slice(0, DETAILS_LIST_LIMIT).map(value => redactActivity(value).slice(0, 2000));
      report[`${target}Omitted`] = Math.max(0, values.length - DETAILS_LIST_LIMIT);
    }
    if (job.result?.structured) {
      for (const target of ["keyFindings", "assumptions"]) {
        const values = job.result.structured[target] ?? [];
        report[target] = values.slice(0, DETAILS_LIST_LIMIT).map(value => redactActivity(value).slice(0, 2000));
        report[`${target}Omitted`] = Math.max(0, values.length - DETAILS_LIST_LIMIT) + (job.result.structured[`${target}Omitted`] ?? 0);
      }
      const claimed = job.result.structured.verification ?? [];
      report.claimedVerification = claimed.slice(0, DETAILS_LIST_LIMIT).map(value => redactActivity(value).slice(0, 2000));
      report.claimedVerificationOmitted = Math.max(0, claimed.length - DETAILS_LIST_LIMIT) + (job.result.structured.verificationOmitted ?? 0);
    }
    const text = redactActivity(job.result?.structured?.summary ?? job.result?.rawOutput ?? job.result?.codex?.stdout ?? "").trim();
    if (text) {
      report.summary = truncate(text, DIRECT_SUMMARY_LIMIT);
      if (text.length > DIRECT_SUMMARY_LIMIT) report.summaryTruncated = true;
    }
  }
  return report;
}
const DIRECT_SUMMARY_LIMIT = 8000;
const DETAILS_LIST_LIMIT = 500;
// Keep the UTF-16 limit without cutting an astral character in half.
function truncate(text, limit) {
  const end = text.charCodeAt(limit - 1), next = text.charCodeAt(limit);
  return text.slice(0, end >= 0xd800 && end <= 0xdbff && next >= 0xdc00 && next <= 0xdfff ? limit - 1 : limit);
}

const duetTarget = value => /^[\w.-]+$/.test(value) ? value : quote(value);
const envelopeBytes = ({ summary, ...envelope }) => Buffer.byteLength(JSON.stringify(envelope));
const brief = value => truncate(redactActivity(value).replace(/\s+/g, " ").trim(), 240);

// Budget serialized UTF-8, not JS character counts: escaping and multibyte text
// both count. Details always retains the unabridged report behind this view.
function fitDirectEnvelope(report) {
  const lists = [
    [report, "keyFindings"], [report, "assumptions"],
    [report.checks, "ran"], [report.checks, "claimed"], [report, "changedFiles"],
    [report.question, "options"],
    [report, "blockers", 1]
  ];
  while (envelopeBytes(report) > 2000) {
    const candidates = lists.filter(([object, key, min = 0]) => object?.[key]?.length > min);
    if (!candidates.length) break;
    const [object, key] = candidates.sort(([a, ak], [b, bk]) => Buffer.byteLength(JSON.stringify(b[bk])) - Buffer.byteLength(JSON.stringify(a[ak])))[0];
    object[key].pop();
    if (key === "changedFiles") report.changedFilesOmitted = (report.changedFilesOmitted ?? 0) + 1;
    else if (key === "options") report.question.optionsOmitted = (report.question.optionsOmitted ?? 0) + 1;
    else if (object === report.checks) report.checks.omitted += 1;
    else if (!object[key].length) delete object[key];
  }
  while (envelopeBytes(report) > 2000) {
    const strings = [
      ...(report.blockers ?? []).map(blocker => [blocker, "message"]),
      ...(report.question ? [[report.question, "text"], ...report.question.options.map((_, i) => [report.question.options, i])] : [])
    ].filter(([object, key]) => object[key].length > 8);
    if (!strings.length) break; // Valid job handles and fixed fields fit on their own.
    const [object, key] = strings.sort(([a, ak], [b, bk]) => Buffer.byteLength(JSON.stringify(b[bk])) - Buffer.byteLength(JSON.stringify(a[ak])))[0];
    object[key] = Array.from(object[key]).slice(0, Math.floor(Array.from(object[key]).length / 2)).join("") + "…";
  }
  if (report.changedFilesOmitted === 0) delete report.changedFilesOmitted;
  return report;
}

export function directReport(payload, job = {}, env = process.env) {
  const full = fullReport(payload, job);
  const worker = job.agentName ?? full.agentName ?? null;
  const jobId = full.jobId ?? job.id ?? null;
  let target = jobId;
  if (worker && jobId) {
    try { target = reportWorkerTarget(job, reportJobs(job, env), worker, jobId, env); }
    catch { /* Unavailable or invalid records must use the exact job ID. */ }
  }
  const workspace = job.workspaceRoot ?? job.request?.cwd;
  const cwdOption = workspace && resolveWorkspaceRoot(workspace) !== resolveWorkspaceRoot(process.cwd()) ? ` --cwd ${quote(workspace)}` : "";
  const command = target ? `${duetTarget(target)}${cwdOption}` : null;
  const summary = redactActivity(full.summary ?? full.headline ?? full.message ?? full.error ?? "");
  /** @type {Record<string, any> & { summary: string }} */
  const report = {
    status: full.status,
    worker,
    jobId,
    summary: truncate(summary, DIRECT_SUMMARY_LIMIT),
    ...(full.summaryTruncated || summary.length > DIRECT_SUMMARY_LIMIT ? { summaryTruncated: true } : {})
  };
  if (full.blockers?.length) report.blockers = full.blockers.map(blocker => ({ code: blocker.code, message: brief(blocker.message ?? ""),
    ...(blocker.code === "thread_busy" && blocker.cancelCommand ? { cancelCommand: blocker.cancelCommand } : {}),
    ...(blocker.code === "thread_busy" && blocker.recoveryCommand ? { recoveryCommand: blocker.recoveryCommand } : {}) }));
  if (full.question) {
    const question = typeof full.question === "string" ? { text: full.question } : full.question;
    report.question = { id: question.id ?? null, kind: question.kind ?? "question", text: redactActivity(question.text),
      options: (question.options ?? []).map(redactActivity),
      expiresInSec: Number.isFinite(question.expiresAt) ? Math.max(0, Math.ceil((question.expiresAt - Date.now()) / 1000)) : null };
  }
  if (full.touchedFiles?.length || full.touchedFilesOmitted) {
    report.changedFiles = (full.touchedFiles ?? []).map(brief);
    report.changedFilesOmitted = full.touchedFilesOmitted ?? 0;
  }
  if (full.verification?.length || full.claimedVerification?.length) {
    report.checks = { ran: (full.verification ?? []).map(brief), claimed: (full.claimedVerification ?? []).map(brief),
      omitted: Math.max(0, (job.result?.commandExecutions?.length ?? 0) - (full.verification?.length ?? 0))
        + Math.max(0, (job.result?.structured?.verification?.length ?? 0) - (full.claimedVerification?.length ?? 0))
        + (job.result?.structured?.verificationOmitted ?? 0) };
  }
  if (full.assumptions?.length) report.assumptions = full.assumptions.slice(0, 12).map(brief);
  if (full.keyFindings?.length) report.keyFindings = full.keyFindings.slice(0, 12).map(brief);
  if (full.usage) report.usage = full.usage;
  const nextCommand = target => !target || ["completed", "ownership_moved"].includes(full.status) ? null
    : full.status === "needs_answer" ? full.question?.id ? `duet answer ${target} --question ${quote(full.question.id)}` : null
    : ACTIVE.has(full.status) ? `duet wait ${target}`
    : `duet task --to ${target}`;
  report.next = nextCommand(command);
  report.details = jobId ? `duet result ${quote(jobId)}${cwdOption} --details` : null;
  if (envelopeBytes(report) > 2000) {
    // Blocker commands act on the predecessor, not the refused job. Use its
    // recorded ID without parsing shell text; full details keep the originals.
    report.blockers?.forEach((blocker, index) => {
      const predecessor = full.blockers[index].predecessorJobId;
      if (typeof predecessor !== "string" || !predecessor) return;
      for (const [key, action] of [["cancelCommand", "cancel"], ["recoveryCommand", "status"]]) {
        if (blocker[key]) blocker[key] = `duet ${action} ${duetTarget(predecessor)} --json`;
      }
    });
  }
  fitDirectEnvelope(report);
  // Long workspace paths can exceed the fixed-field budget even after text
  // fitting. Exact IDs resolve across stored workspaces without a cwd hint.
  if (cwdOption && jobId && envelopeBytes(report) > 2000) {
    const exact = duetTarget(jobId);
    report.next = nextCommand(exact);
    if (envelopeBytes(report) > 2000) report.details = `duet result ${quote(jobId)} --details`;
  }
  if (envelopeBytes(report) > 2000) {
    // Legacy blockers may have no target metadata. Omit an oversized command
    // from this compact view rather than truncate it into an invalid command.
    const commands = (report.blockers ?? []).flatMap(blocker => ["cancelCommand", "recoveryCommand"]
      .filter(key => blocker[key]).map(key => [blocker, key]))
      .sort(([a, ak], [b, bk]) => Buffer.byteLength(b[bk]) - Buffer.byteLength(a[ak]));
    for (const [blocker, key] of commands) {
      delete blocker[key];
      if (envelopeBytes(report) <= 2000) break;
    }
  }
  return report;
}
export function ownershipNotice(job, owner) {
  if (!owner || job.ownerId === owner || !job.retiredOwnerIds?.includes(owner)) return null;
  return { status: "ownership_moved", jobStatus: job.status, jobId: job.id, ownerId: job.ownerId,
    ...(job.agentName ? { agentName: job.agentName } : {}),
    threadId: job.threadId ?? null, turnId: job.turnId ?? null,
    message: "Ownership moved to a replacement worker. Stop polling; do not reuse its ownerId or adopt again." };
}
export function adoptJob(cwd, id, sessionId) {
  let status;
  const job = updateJob(cwd, id, current => {
    const now = Date.now();
    const expired = (current.result?.interruptionReason ?? current.report?.interruptionReason ?? current.interruptionReason) === "lease_expired";
    if (!ACTIVE.has(current.status)) { status = expired ? "lease_expired" : "job_ended"; return null; }
    if (current.leaseExpiresAt <= now || current.cancelRequested?.reason === "lease_expired") { status = "lease_expired"; return null; }
    if (current.cancelRequested || current.phase === "interrupting") { status = "interrupting"; return null; }
    if (current.jobClass !== "task" || !Number.isFinite(current.leaseExpiresAt)) { status = "not_adoptable"; return null; }
    const destinationSession = sessionId || (current.sessionId === undefined ? current.ownerId : current.sessionId) || null;
    const agentName = current.agentName ? reserveAgentName([], { cwd, sessionId: destinationSession, preferredName: current.agentName, threadId: current.threadId }) : undefined;
    const nextOwner = ownerId(id);
    status = "adopted";
    return { ownerId: nextOwner, agentName, retiredOwnerIds: [...new Set([...(current.retiredOwnerIds ?? []), current.ownerId].filter(Boolean))],
      // A replacement launched in another Claude session takes over cleanup.
      // Without a caller session, preserve the original (including legacy) scope.
      sessionId: destinationSession,
      leaseRenewedAt: now, leaseExpiresAt: now + (current.leaseSec ?? 180) * 1000,
      ownerAttached: false, ownerDetachedAt: null, ownerDetachReason: null,
      activityCursors: { ...current.activityCursors, [activityReader(nextOwner)]: current.activityCursors?.[activityReader(current.ownerId)] ?? 0 }
    };
  });
  return { ...progressSnapshot(job), status, jobStatus: job.status, adopted: status === "adopted", leaseExpiresAt: job.leaseExpiresAt ?? null,
    ...(status === "adopted" ? { waitCommand: companionCommand(`wait ${quote(job.id)} --owner ${quote(job.ownerId)} --cwd ${quote(job.request?.cwd ?? cwd)} ${job.direct ? "--direct" : "--report"}`) }
      : { ...continuationReport(job), ...(status === "lease_expired" ? { interruptionReason: "lease_expired", interruptionConfirmed: job.result?.interruptionConfirmed ?? job.interruptionConfirmed ?? null } : {}) }) };
}
export function leaseSnapshot(job, now = Date.now()) {
  if (!ACTIVE.has(job.status) || !job.leaseExpiresAt) return {};
  const lastRenewal = job.leaseRenewedAt ?? job.leaseExpiresAt - (job.leaseSec ?? 180) * 1000;
  // Native Agent stops have no companion callback. Infer staleness after the
  // maximum 60-second wait plus handoff time, or half a short lease. Direct
  // owners can sleep between waits much longer, so use half their full lease.
  const halfLeaseMs = (job.leaseSec ?? 180) * 500;
  const staleAfterMs = job.direct === true ? halfLeaseMs : Math.min(65000, halfLeaseMs);
  const orphaned = now - lastRenewal >= staleAfterMs;
  return { orphaned, leaseRemainingSec: Math.max(0, Math.ceil((job.leaseExpiresAt - now) / 1000)), leaseRenewedAt: lastRenewal,
    ...(orphaned && job.id ? { adoptCommand: companionCommand(`adopt ${quote(job.id)} --cwd ${quote(job.request?.cwd ?? job.workspaceRoot)} --json`) } : {}) };
}
export function leaseExpiryReport(job) {
  if ((job.result?.interruptionReason ?? job.report?.interruptionReason ?? job.interruptionReason) !== "lease_expired") return {};
  return { interruptionReason: "lease_expired", ...continuationReport(job) };
}
export function questionMessage(question) {
  return `Question ${question.id}: ${snippet(question.text, 1000)} | Options: ${question.options?.length ? question.options.map(option => JSON.stringify(snippet(option, 160))).join("; ") : "(none)"}`;
}
export function requestCancel(cwd, id, reason = "cancelled_by_user", options = {}) {
  return updateJob(cwd, id, job => ACTIVE.has(job.status) ? { cancelRequested: { reason, at: new Date().toISOString() } } : null, options);
}
export function answerQuestion(cwd, id, questionId, answer, owner) {
  if (typeof answer !== "string" || !answer.trim() || answer.length > 8000) throw new Error("Answer stdin must contain 1–8000 characters.");
  return updateJob(cwd, id, job => {
    if (ownershipNotice(job, owner)) return null;
    if (!ACTIVE.has(job.status) || !job.pendingQuestion || job.pendingQuestion.id !== questionId || job.pendingQuestion.expiresAt <= Date.now() || job.pendingQuestion.answer !== undefined) throw new Error("Question is no longer pending; no answer was sent.");
    return { pendingQuestion: { ...job.pendingQuestion, answer: answer.trim() } };
  });
}
export const ASK_PARENT = {
  type: "function", name: "ask_parent",
  description: "Ask the parent Claude agent one blocking mid-task question. Use only when an answer materially changes authorized work. Never include secrets or page content. The parent can answer within this same turn; on timeout proceed on a conservative assumption and report it.",
  inputSchema: { type: "object", properties: { question: { type: "string", maxLength: 1000 }, options: { type: "array", maxItems: 6, items: { type: "string", maxLength: 160 } } }, required: ["question"], additionalProperties: false }
};
const textReply = text => ({ success: true, contentItems: [{ type: "inputText", text }] });
export const PARENT_BRIDGE_SERVER = "duet_parent";
// The bridge retains its thread from either a thread handle or the starting job.
// The shared broker keeps threads and MCP servers loaded across runs; calls find
// the recorded turn owner across workspaces, never a newer queued reservation.
export const PARENT_BRIDGE_ENV = { cwd: "CODEX_COMPANION_BRIDGE_CWD", threadId: "CODEX_COMPANION_BRIDGE_THREAD", jobId: "CODEX_COMPANION_BRIDGE_JOB" };
export function activeJobForThread(cwd, threadId) {
  if (!threadId) return null;
  const candidates = listJobs(cwd).filter(job => job.threadId === threadId && ACTIVE.has(job.status));
  candidates.sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
  return candidates[0]?.id ?? null;
}
/**
 * Block one Codex question on the job file until the owner answers, the
 * question times out, or the job is stopped. Shared by the in-process dynamic
 * tool (compatibility fallback) and the stdio MCP bridge process, so the
 * owner-facing wait/answer flow is identical for both.
 */
// kind "question" is Codex's own ask_parent call; kind "approval" is a Computer
// Use request the runtime forwards, with the fixed choices from APPROVAL_CHOICES.
export async function askParentQuestion(cwd, id, { question, options = [], kind = "question", callId = null }, { signal = null, onProgress = null, stopped = () => false } = {}) {
  const questionId = `${kind}-${randomUUID()}`;
  const askedAt = new Date(Date.now()).toISOString();
  // Tool call IDs come from the dynamic request or MCP _meta.callId. Approval
  // requests have no ask_parent item. Never guess a missing ID from question
  // order, text, or the MCP transport's independent request ID.
  callId = kind === "approval" ? null : callId;
  const historyPatch = (current, resolution, answer = undefined) => ({ questionHistory: [...(current.questionHistory ?? []).slice(-19), {
    id: questionId, callId, kind, text: question, options, askedAt,
    answeredAt: answer === undefined ? null : new Date(Date.now()).toISOString(),
    answer: answer === undefined ? null : answer.slice(0, 2000), resolution
  }] });
  const job = readJobFile(resolveJobFile(cwd, id));
  if (!ACTIVE.has(job.status) || job.cancelRequested) {
    updateJob(cwd, id, current => historyPatch(current, "interrupted"));
    return { text: "The owner cancelled this task. Stop work and report interrupted.", resolution: "interrupted" };
  }
  if (job.pendingQuestion) {
    updateJob(cwd, id, current => historyPatch(current, "busy"));
    return { text: "Another parent question is pending. Proceed on a conservative assumption and report it.", resolution: "busy" };
  }
  const pending = { id: questionId, callId, kind, text: question, options, askedAt, expiresAt: Date.now() + (job.questionTimeoutSec ?? 900) * 1000 };
  updateJob(cwd, id, () => ({ pendingQuestion: pending, phase: "needs_answer" }));
  onProgress?.({ message: `Parent question pending: ${questionId}.`, phase: "needs_answer" });
  let text = "No answer arrived before the timeout. Proceed on a conservative assumption within the authorized scope and report the assumption. If essential input is missing, finish with needs_input.";
  let resolution = "timeout";
  const aborted = () => signal?.aborted || stopped();
  try {
    while (!aborted() && Date.now() < pending.expiresAt) {
      const current = readJobFile(resolveJobFile(cwd, id));
      if (!ACTIVE.has(current.status) || current.cancelRequested) break;
      if (current.pendingQuestion?.id !== questionId) break;
      if (current.pendingQuestion.answer !== undefined) { text = current.pendingQuestion.answer; resolution = "answered"; break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const current = readJobFile(resolveJobFile(cwd, id));
    if (aborted() || !ACTIVE.has(current.status) || current.cancelRequested) { resolution = "interrupted"; text = "The owner cancelled this task. Stop work and report interrupted."; }
    else if (current.pendingQuestion?.id === questionId && current.pendingQuestion.answer !== undefined) { text = current.pendingQuestion.answer; resolution = "answered"; }
    return { text, resolution };
  } finally {
    updateJob(cwd, id, current => {
      const answer = current.pendingQuestion?.id === questionId ? current.pendingQuestion.answer : undefined;
      return { ...historyPatch(current, resolution, answer), lastQuestion: { id: questionId, resolution },
        ...(current.pendingQuestion?.id === questionId || current.phase === "needs_answer"
          ? { pendingQuestion: null, phase: resolution === "interrupted" || current.cancelRequested ? "interrupting" : "running" } : {}) };
    });
    onProgress?.(`Parent question ${resolution}: ${questionId}.`);
  }
}
export function isParentQuestion(message, policy) {
  const p = message.params;
  return message.method === "item/tool/call" && p?.tool === "ask_parent" && (p.namespace == null || p.namespace === "") &&
    p.threadId === policy.threadId && p.turnId === policy.turnId && Boolean(policy.turnId) &&
    typeof p.callId === "string" && p.arguments && typeof p.arguments.question === "string" &&
    p.arguments.question.trim().length > 0 && p.arguments.question.length <= 1000 &&
    Object.keys(p.arguments).every(k => ["question", "options"].includes(k)) &&
    (p.arguments.options === undefined || Array.isArray(p.arguments.options) && p.arguments.options.length <= 6 && p.arguments.options.every(o => typeof o === "string" && o.length <= 160));
}

// The runtime owns the job record; the turn capture owns the live connection.
// Associate them by signal so cleanup can be recorded even if capture throws.
const runtimeJobs = new WeakMap();
export function recordBackgroundTerminals(signal, backgroundTerminals) {
  const runtime = runtimeJobs.get(signal);
  if (runtime) updateJob(runtime.cwd, runtime.id, () => ({ backgroundTerminals }));
}

export class JobRuntime {
  constructor(cwd, id, { foreground = false, onProgress = null } = {}) {
    this.cwd = cwd; this.id = id; this.onProgress = onProgress;
    this.abort = new AbortController(); this.reason = null;
    runtimeJobs.set(this.abort.signal, this);
    this.handlers = new Map();
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      const handler = () => this.stop(`signal_${signal.toLowerCase()}`);
      this.handlers.set(signal, handler); process.on(signal, handler);
    }
    const foregroundOwner = foreground ? readJobFile(resolveJobFile(cwd, id)).ownerId : null;
    let lastTickAt = Date.now();
    const tick = () => {
      if (this.reason) return;
      const now = Date.now(), gap = now - lastTickAt;
      lastTickAt = now;
      const paused = gap > PAUSE_THRESHOLD_MS;
      try {
        // Shift the current record under its lock before checking a wake tick.
        // Cancellation still wins, and normal checks resume on the next tick.
        const job = paused ? updateJob(cwd, id, current => pauseAdjustment(current, gap, now)) : readJobFile(resolveJobFile(cwd, id));
        if (job.cancelRequested) this.stop(job.cancelRequested.reason);
        else if (!paused && job.leaseExpiresAt && now >= job.leaseExpiresAt) this.stop("lease_expired");
        // owner_stopped: the owner marked its exit (user stopped the agent/wait).
        // owner_lost: the heartbeat went silent (killed outright or crashed).
        else if (!paused && !foreground && ownerLost(job, now)) this.stop(job.ownerAttached ? "owner_lost" : "owner_stopped");
        else if (foreground && !this.reason) renewLease(cwd, id, foregroundOwner);
      } catch { this.stop("owner_state_unavailable"); }
    };
    tick(); this.timer = setInterval(tick, 250);
  }
  stop(reason) {
    if (this.reason) return;
    this.reason = reason;
    this.onProgress?.({ message: `Interrupt requested: ${reason}.`, phase: "interrupting" });
    this.abort.abort(reason);
  }
  async question(message) {
    const { text } = await askParentQuestion(this.cwd, this.id, { ...message.params.arguments, callId: message.params.callId }, { signal: this.abort.signal, onProgress: this.onProgress });
    return textReply(text);
  }
  // A forwarded Computer Use request. Only an explicit answer grants anything;
  // timeout, cancellation and a second pending question all deny.
  async approval(request) {
    const question = `Codex asks to control ${request.app}${request.toolName ? ` (Computer Use tool ${request.toolName})` : " via Computer Use"}. Allow? Nothing outside the isolated Codex home is changed by any choice.`;
    const { text, resolution } = await askParentQuestion(this.cwd, this.id, { question, options: APPROVAL_OPTIONS, kind: "approval" }, { signal: this.abort.signal, onProgress: this.onProgress });
    return resolution === "answered" ? parseApprovalAnswer(text) : "deny";
  }
  close() { runtimeJobs.delete(this.abort.signal); clearInterval(this.timer); for (const [signal, handler] of this.handlers) process.off(signal, handler); }
}

// Deliberately omit shell arguments, tool arguments, model text and outputs.
// Only command family/classification is safe without knowing their contents.
export function safeItem(item, lifecycle) {
  if (!item || !["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "collabAgentToolCall", "webSearch", "plan"].includes(item.type)) return null;
  let summary = item.type;
  if (item.type === "commandExecution") {
    const first = String(item.command ?? "").trim().split(/\s+/)[0].split("/").at(-1);
    summary = ["node", "npm", "pnpm", "yarn", "git", "python", "python3", "pytest", "cargo", "go", "rg", "ls", "cat", "sed", "make", "tsc"].includes(first) ? `${first} command` : "shell command";
    if (/\b(test|pytest|jest|vitest|check|lint|build)\b/.test(item.command ?? "")) summary = "running tests/checks";
  } else if (item.type === "fileChange") {
    summary = "file changes";
  } else if (["mcpToolCall", "dynamicToolCall"].includes(item.type)) {
    const name = item.tool ?? item.name;
    summary = typeof name === "string" && /^[a-zA-Z_][\w./-]{0,80}$/.test(name) ? `tool ${name}` : "tool call";
  } else if (item.type === "plan") summary = "plan updated";
  return { type: item.type, summary: snippet(summary, 96), lifecycle,
    ...(item.type === "fileChange" ? { paths: (item.changes ?? []).map(c => snippet(c.path, 180)).slice(0, 6) } : {}),
    ...(Number.isInteger(item.exitCode) ? { exitCode: item.exitCode } : {}) };
}
export function progressSnapshot(job) {
  const pending = job.pendingQuestion?.answer === undefined ? job.pendingQuestion : null;
  const elapsedMs = Math.max(0, (job.completedAt ? Date.parse(job.completedAt) : Date.now()) - Date.parse(job.startedAt ?? job.createdAt));
  const seconds = Math.floor(elapsedMs / 1000), elapsed = `${Math.floor(seconds / 60)}m${seconds % 60}s`;
  const phase = pending ? "needs_answer" : job.phase === "needs_answer" ? "running" : job.phase ?? job.status;
  return { status: pending ? "needs_answer" : job.status, jobId: job.id, threadId: job.threadId ?? null, turnId: job.turnId ?? null,
    ...(job.agentName ? { agentName: job.agentName } : {}),
    ownerId: job.ownerId ?? null, sessionId: job.sessionId ?? null, ownerAttached: Boolean(job.ownerAttached), ...leaseSnapshot(job),
    headline: `${pending ? "waiting for parent" : job.currentItem?.summary ?? phase} · ${elapsed}`.slice(0, 60), phase, elapsed, elapsedMs,
    startupTimings: { mcpReady: null, ...job.startupTimings }, startupWarning: job.startupWarning ?? null,
    currentItem: job.currentItem ?? null, completedItems: job.completedItems ?? [],
    ...(pending ? { questionMessage: questionMessage(pending), question: { id: pending.id, kind: pending.kind ?? "question", text: snippet(pending.text, 1000), options: pending.options.map(option => snippet(option, 160)), expiresAt: pending.expiresAt } } : {}) };
}
