import { fileURLToPath } from "node:url";
import { snippet, activityReader } from "./activity.mjs";
import { randomUUID } from "node:crypto";
import { updateJob, readJobFile, resolveJobFile } from "./state.mjs";

export const ACTIVE = new Set(["queued", "running"]);
export function seconds(value, fallback, name, maximum = 86400) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(String(value)) || Number(value) < 1 || Number(value) > maximum) throw new Error(`${name} must be an integer from 1 to ${maximum}.`);
  return Number(value);
}
export const ownerId = jobId => `${jobId}-${randomUUID()}`;
export function renewLease(cwd, id, owner) {
  return updateJob(cwd, id, job => {
    const now = Date.now(); // Check expiry after acquiring the state lock.
    return owner && ACTIVE.has(job.status) && job.ownerId === owner && !job.cancelRequested && (!job.leaseExpiresAt || job.leaseExpiresAt > now)
      ? { leaseRenewedAt: now, leaseExpiresAt: now + (job.leaseSec ?? 180) * 1000 } : null;
  });
}
const quote = value => `'${String(value).replace(/'/g, `'"'"'`)}'`;
const companionCommand = args => `node ${quote(fileURLToPath(new URL("../codex-companion.mjs", import.meta.url)))} ${args}`;
export function continuationReport(job) {
  const continuationCommand = job.threadId ? companionCommand(`task --thread ${quote(job.threadId)} --cwd ${quote(job.request?.cwd ?? job.workspaceRoot)} --detached --report --json`) : null;
  return { continuationCommand,
    continuationNote: continuationCommand ? "This command starts a new turn using the configured default sandbox; restore per-call write/runtime/origin flags only with authorization. It has not been run. Wait for any pending interruption to finish first." : "No thread handle was recorded; no continuation command is available." };
}
export function ownershipNotice(job, owner) {
  if (!owner || job.ownerId === owner || !job.retiredOwnerIds?.includes(owner)) return null;
  return { status: "ownership_moved", jobStatus: job.status, jobId: job.id, ownerId: job.ownerId,
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
      activityCursors: { ...current.activityCursors, [activityReader(nextOwner)]: current.activityCursors?.[activityReader(current.ownerId)] ?? 0 }
    };
  });
  return { ...progressSnapshot(job), status, jobStatus: job.status, adopted: status === "adopted", leaseExpiresAt: job.leaseExpiresAt ?? null,
    ...(status === "adopted" ? { waitCommand: companionCommand(`wait ${quote(job.id)} --owner ${quote(job.ownerId)} --cwd ${quote(job.request?.cwd ?? cwd)} --report`) }
      : { ...continuationReport(job), ...(status === "lease_expired" ? { interruptionReason: "lease_expired", interruptionConfirmed: job.result?.interruptionConfirmed ?? job.interruptionConfirmed ?? null } : {}) }) };
}
export function leaseSnapshot(job, now = Date.now()) {
  if (!ACTIVE.has(job.status) || !job.leaseExpiresAt) return {};
  const lastRenewal = job.leaseRenewedAt ?? job.leaseExpiresAt - (job.leaseSec ?? 180) * 1000;
  // Native Agent stops have no companion callback. Infer staleness after the
  // maximum 60-second wait plus handoff time, or half a short lease.
  const staleAfterMs = Math.min(65000, (job.leaseSec ?? 180) * 500);
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
    const tick = () => {
      try {
        const job = readJobFile(resolveJobFile(cwd, id));
        if (job.cancelRequested) this.stop(job.cancelRequested.reason);
        else if (job.leaseExpiresAt && Date.now() >= job.leaseExpiresAt) this.stop("lease_expired");
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
    const id = `question-${randomUUID()}`;
    const job = readJobFile(resolveJobFile(this.cwd, this.id));
    if (job.pendingQuestion) return textReply("Another parent question is pending. Proceed on a conservative assumption and report it.");
    const pending = { id, text: message.params.arguments.question, options: message.params.arguments.options ?? [], expiresAt: Date.now() + (job.questionTimeoutSec ?? 900) * 1000 };
    updateJob(this.cwd, this.id, () => ({ pendingQuestion: pending, phase: "needs_answer" }));
    this.onProgress?.({ message: `Parent question pending: ${id}.`, phase: "needs_answer" });
    let answer = "No answer arrived before the timeout. Proceed on a conservative assumption within the authorized scope and report the assumption. If essential input is missing, finish with needs_input.";
    let resolution = "timeout";
    try {
      while (!this.abort.signal.aborted && Date.now() < pending.expiresAt) {
        const current = readJobFile(resolveJobFile(this.cwd, this.id)).pendingQuestion;
        if (current?.id !== id) break;
        if (current.answer !== undefined) { answer = current.answer; resolution = "answered"; break; }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (this.abort.signal.aborted) { resolution = "interrupted"; answer = "The owner cancelled this task. Stop work and report interrupted."; }
      return textReply(answer);
    } finally {
      updateJob(this.cwd, this.id, () => ({ pendingQuestion: null, lastQuestion: { id, resolution }, phase: this.reason ? "interrupting" : "running" }));
      this.onProgress?.(`Parent question ${resolution}: ${id}.`);
    }
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
    ownerId: job.ownerId ?? null, sessionId: job.sessionId ?? null, ...leaseSnapshot(job),
    headline: `${pending ? "waiting for parent" : job.currentItem?.summary ?? phase} · ${elapsed}`.slice(0, 60), phase, elapsed, elapsedMs,
    startupTimings: { mcpReady: null, ...job.startupTimings }, startupWarning: job.startupWarning ?? null,
    currentItem: job.currentItem ?? null, completedItems: job.completedItems ?? [],
    ...(pending ? { questionMessage: questionMessage(pending), question: { id: pending.id, text: snippet(pending.text, 1000), options: pending.options.map(option => snippet(option, 160)), expiresAt: pending.expiresAt } } : {}) };
}
