import { fileURLToPath } from "node:url";
import { snippet, activityReader, redactActivity } from "./activity.mjs";
import { randomUUID } from "node:crypto";
import { listJobs, updateJob, readJobFile, resolveJobFile } from "./state.mjs";
import { APPROVAL_OPTIONS, parseApprovalAnswer } from "./server-requests.mjs";
import { finishJournalJob } from "./run-journal.mjs";
import { buildWorkerReport } from "./worker-report.mjs";

export const ACTIVE = new Set(["queued", "running"]);
export function recordFinishedJob(job) {
  if (!job?.runId || ACTIVE.has(job.status) || job.journalFinishedStatus === job.status) return;
  try {
    const report = job.report ?? buildWorkerReport(job.result ?? { status: 1, error: job.errorMessage ?? "No stored result." }, { jobId: job.id, rawOutputFile: job.rawOutputFile, resultFile: job.resultFile });
    if (finishJournalJob(job, directReport({ ...report, status: job.status, ...leaseExpiryReport(job) }, job))) {
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
// Direct callers get the same report, without the feed or verbose progress.
// Filter a copy so the existing JSON/feed and status shapes remain unchanged.
export function directReport(payload, job) {
  const report = { ...payload, ...(job.agentName ? { agentName: job.agentName } : {}) };
  for (const key of ["activity", "activityOmitted", "cursor", "startupTimings", "currentItem", "completedItems", "questionMessage"]) delete report[key];
  if (report.startupWarning == null) delete report.startupWarning;
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
    if (job.result?.structured) {
      for (const [target, source] of [["keyFindings", "keyFindings"], ["assumptions", "assumptions"], ["claimedVerification", "verification"]]) {
        report[target] = (job.result.structured[source] ?? []).slice(0, 20).map(value => redactActivity(value).slice(0, 2000));
      }
    }
    const text = redactActivity(job.result?.structured?.summary ?? job.result?.rawOutput ?? "").trim();
    if (text) {
      report.summary = text.slice(0, DIRECT_SUMMARY_LIMIT);
      if (text.length > DIRECT_SUMMARY_LIMIT) report.summaryTruncated = true;
    }
  }
  return report;
}
const DIRECT_SUMMARY_LIMIT = 8000;
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
    const nextOwner = ownerId(id);
    status = "adopted";
    return { ownerId: nextOwner, retiredOwnerIds: [...new Set([...(current.retiredOwnerIds ?? []), current.ownerId].filter(Boolean))],
      // A replacement launched in another Claude session takes over cleanup.
      // Without a caller session, preserve the original (including legacy) scope.
      sessionId: sessionId || (current.sessionId === undefined ? current.ownerId : current.sessionId) || null,
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
// The bridge is bound to a *thread*, not a job: the shared broker keeps a resumed
// thread (and its MCP servers) loaded across runs, so the same bridge process can
// serve several consecutive jobs. Each call resolves the job active on the thread.
export const PARENT_BRIDGE_ENV = { cwd: "CODEX_COMPANION_BRIDGE_CWD", threadId: "CODEX_COMPANION_BRIDGE_THREAD" };
export function activeJobForThread(cwd, threadId) {
  if (!threadId) return null;
  const candidates = listJobs(cwd).filter(job => job.threadId === threadId && ACTIVE.has(job.status));
  candidates.sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
  return candidates[0]?.id ?? null;
}
/**
 * Block one Codex question on the job file until the owner answers, the
 * question times out, or the job is stopped. Shared by the in-process dynamic
 * tool (new threads) and the stdio MCP bridge process (resumed threads), so the
 * owner-facing wait/answer flow is identical for both.
 */
// kind "question" is Codex's own ask_parent call; kind "approval" is a Computer
// Use request the runtime forwards, with the fixed choices from APPROVAL_CHOICES.
export async function askParentQuestion(cwd, id, { question, options = [], kind = "question" }, { signal = null, onProgress = null, stopped = () => false } = {}) {
  const questionId = `${kind}-${randomUUID()}`;
  const job = readJobFile(resolveJobFile(cwd, id));
  if (!ACTIVE.has(job.status) || job.cancelRequested) return { text: "The owner cancelled this task. Stop work and report interrupted.", resolution: "interrupted" };
  if (job.pendingQuestion) return { text: "Another parent question is pending. Proceed on a conservative assumption and report it.", resolution: "busy" };
  const pending = { id: questionId, kind, text: question, options, expiresAt: Date.now() + (job.questionTimeoutSec ?? 900) * 1000 };
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
    updateJob(cwd, id, current => current.pendingQuestion?.id === questionId || current.phase === "needs_answer"
      ? { pendingQuestion: null, lastQuestion: { id: questionId, resolution }, phase: resolution === "interrupted" || current.cancelRequested ? "interrupting" : "running" } : { lastQuestion: { id: questionId, resolution } });
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

export class JobRuntime {
  constructor(cwd, id, { foreground = false, onProgress = null } = {}) {
    this.cwd = cwd; this.id = id; this.onProgress = onProgress;
    this.abort = new AbortController(); this.reason = null;
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
    const { text } = await askParentQuestion(this.cwd, this.id, message.params.arguments, { signal: this.abort.signal, onProgress: this.onProgress });
    return textReply(text);
  }
  // A forwarded Computer Use request. Only an explicit answer grants anything;
  // timeout, cancellation and a second pending question all deny.
  async approval(request) {
    const question = `Codex asks to control ${request.app}${request.toolName ? ` (Computer Use tool ${request.toolName})` : " via Computer Use"}. Allow? Nothing outside the isolated Codex home is changed by any choice.`;
    const { text, resolution } = await askParentQuestion(this.cwd, this.id, { question, options: APPROVAL_OPTIONS, kind: "approval" }, { signal: this.abort.signal, onProgress: this.onProgress });
    return resolution === "answered" ? parseApprovalAnswer(text) : "deny";
  }
  close() { clearInterval(this.timer); for (const [signal, handler] of this.handlers) process.off(signal, handler); }
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
