import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { resolveJobFile, tryAcquirePidLock } from "./state.mjs";

const ACTIVE = new Set(["queued", "running"]);
const TERMINAL = new Set(["applied", "deferred", "failed", "unknown"]);
const MAX_DELIVERIES = 256;
const digest = text => createHash("sha256").update(text).digest("hex");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const read = file => JSON.parse(fs.readFileSync(file, "utf8"));
const inboxPath = jobFile => jobFile.replace(/\.json$/, ".steering.json");
const now = () => new Date().toISOString();

function persist(file, value) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temporary, "wx", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value) + "\n"); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
    // Flush the rename as well as the data before acknowledging a handoff.
    if (process.platform !== "win32") {
      const directory = fs.openSync(path.dirname(file), "r");
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    }
  } finally { fs.rmSync(temporary, { force: true }); }
}

async function locked(jobFile, action) {
  const file = inboxPath(jobFile), deadline = Date.now() + 2000;
  let release;
  while (!(release = tryAcquirePidLock(`${file}.lock`))) {
    if (Date.now() >= deadline) throw new Error("Fugato steering inbox is busy.");
    await pause(10);
  }
  try {
    let inbox;
    try { inbox = read(file); }
    catch (error) { if (error.code !== "ENOENT") throw error; inbox = { version: 1, deliveries: [] }; }
    if (inbox.version !== 1 || !Array.isArray(inbox.deliveries)) throw new Error("Invalid Fugato steering inbox.");
    // Compact terminal rows from older inboxes too, without losing receipts.
    let compacted = false;
    for (const row of inbox.deliveries) if (TERMINAL.has(row.status) && typeof row.text === "string") {
      redact(row); compacted = true;
    }
    const result = action(inbox, read(jobFile));
    if (result.changed || compacted) persist(file, inbox);
    return result.value;
  } finally { release(); }
}

const pendingQuestion = job => job.pendingQuestion && job.pendingQuestion.answer === undefined;
const receipt = (jobId, row, fallback = false) => ({ jobId, deliveryId: row.deliveryId,
  status: row.status === "submitting" ? "unknown" : row.status, fallback, reason: row.reason ?? null });
function redact(row) {
  if (typeof row.text === "string") { row.textHash = digest(row.text); delete row.text; }
}
function finish(row, status, reason) {
  Object.assign(row, { status, reason, updatedAt: now() });
  redact(row);
}

// An RPC error is proof of rejection only when it came from the runtime, not
// a broker wrapping a lost connection. All other failures forbid replay.
function runtimeRejection(error) {
  return Number.isInteger(error.rpcCode) && !error.code && !error.failureSource
    // The broker can wrap a JSONL parser error in -32000 without transportCode.
    // Its message may quote malformed input containing rejection-like text.
    && !/^Failed to parse codex app-server JSONL:/i.test(error.message);
}
function endedRejection(error) {
  return runtimeRejection(error)
    && /\bno active turn\b|\bturn (?:has |already )?(?:ended|completed|finished)\b|expected[_ ]?turn[_ ]?id.*(?:mismatch|does not match)|(?:mismatch|does not match).*expected[_ ]?turn[_ ]?id/i.test(error.message);
}

export async function handoffSteering(cwd, jobId, { deliveryId, text, sessionId, ownerId }) {
  if (typeof deliveryId !== "string" || !deliveryId.trim() || deliveryId.length > 512) throw new Error("steer requires a delivery ID of at most 512 characters.");
  if (typeof text !== "string" || !text.trim() || text.length > 65536) throw new Error("steer requires non-empty stdin of at most 65536 characters.");
  if (!sessionId) throw new Error("steer requires the owning Claude session.");
  const jobFile = resolveJobFile(cwd, jobId);
  const refused = await locked(jobFile, (inbox, job) => {
    if (job.sessionId !== sessionId || (ownerId && job.ownerId !== ownerId)) throw new Error("Fugato steering job ownership changed.");
    const existing = inbox.deliveries.find(row => row.deliveryId === deliveryId);
    if (existing) {
      if ((existing.textHash ?? digest(existing.text)) !== digest(text)) throw new Error("Steering delivery ID already belongs to different text.");
      return { changed: false };
    }
    if (inbox.deliveries.length >= MAX_DELIVERIES) return { changed: false,
      value: receipt(jobId, { deliveryId, status: "failed", reason: "inbox_full" }) };
    const row = { deliveryId, text, at: now(), status: "queued", sessionId, ownerId: job.ownerId };
    if (job.request?.permissionPolicy) finish(row, "deferred", "permission_mapping");
    else if (pendingQuestion(job)) finish(row, "deferred", "pending_question");
    else if (!ACTIVE.has(job.status) || !job.threadId || !job.turnId) finish(row, "deferred", "no_active_turn");
    inbox.deliveries.push(row);
    return { changed: true };
  });
  if (refused) return refused;
  // The sender holds the original host delivery until this bounded outcome.
  // If the worker never claimed it, withdrawing it under the same lock proves
  // that forwarding to the ordinary host queue cannot duplicate a steer.
  const deadline = Date.now() + 6000;
  for (;;) {
    const result = await locked(jobFile, (inbox, job) => {
      const row = inbox.deliveries.find(row => row.deliveryId === deliveryId);
      let changed = false;
      if (row.status === "queued" && (!ACTIVE.has(job.status) || pendingQuestion(job) || Date.now() >= deadline)) {
        finish(row, "deferred", pendingQuestion(job) ? "pending_question" : "not_submitted"); changed = true;
      } else if (row.status === "submitting" && Date.now() >= deadline) {
        finish(row, "unknown", "acknowledgement_missing"); changed = true;
      }
      if (["queued", "submitting"].includes(row.status)) return { changed, value: null };
      const fallback = row.status === "deferred" && !row.fallbackClaimedAt;
      if (fallback) { row.fallbackClaimedAt = now(); changed = true; }
      return { changed, value: receipt(jobId, row, fallback) };
    });
    if (result) return result;
    await pause(50);
  }
}

// Only the worker owning the app-server connection calls this. The write-ahead
// submitting state survives a crash and is never submitted again on restart.
export function startSteeringDrain(cwd, jobId, { threadId, turnId, request, onError = () => {} }) {
  const jobFile = resolveJobFile(cwd, jobId);
  let stopped = false, pending = null;
  const drain = async () => {
    while (!stopped) {
      if (!fs.existsSync(inboxPath(jobFile))) return;
      const row = await locked(jobFile, (inbox, job) => {
        const row = inbox.deliveries.find(row => row.status === "queued");
        if (!row || stopped) return { changed: false, value: null };
        if (job.sessionId !== row.sessionId || job.ownerId !== row.ownerId) finish(row, "failed", "ownership_changed");
        else if (job.request?.permissionPolicy) finish(row, "deferred", "permission_mapping");
        else if (pendingQuestion(job)) finish(row, "deferred", "pending_question");
        else if (!ACTIVE.has(job.status) || job.threadId !== threadId || job.turnId !== turnId) finish(row, "deferred", "no_active_turn");
        else Object.assign(row, { status: "submitting", threadId, turnId, submittedAt: now() });
        return { changed: true, value: { ...row } };
      });
      if (!row) return;
      if (row.status !== "submitting") continue;
      let status, reason;
      try {
        const result = await request({ threadId, expectedTurnId: turnId,
          input: [{ type: "text", text: row.text, text_elements: [] }] });
        status = result?.turnId === turnId ? "applied" : "unknown";
        reason = status === "applied" ? null : "unexpected_acknowledgement";
      } catch (error) {
        status = endedRejection(error) ? "deferred" : runtimeRejection(error) ? "failed" : "unknown";
        reason = status === "deferred" ? "turn_rejected" : status === "failed" ? "steer_rejected" : "acknowledgement_missing";
      }
      await locked(jobFile, inbox => {
        const current = inbox.deliveries.find(value => value.deliveryId === row.deliveryId);
        // A late positive ack can clarify unknown, but must never authorize a
        // late fallback after the sender already consumed an unknown outcome.
        if (current.status !== "submitting" && !(current.status === "unknown" && status === "applied")) return { changed: false };
        finish(current, status, reason);
        return { changed: true };
      });
    }
  };
  const tick = () => {
    if (pending || stopped) return;
    pending = drain().catch(onError).finally(() => { pending = null; });
  };
  const timer = setInterval(tick, 100);
  tick();
  return async () => {
    stopped = true; clearInterval(timer);
    await pending;
    if (!fs.existsSync(inboxPath(jobFile))) return;
    await locked(jobFile, inbox => {
      let changed = false;
      for (const row of inbox.deliveries) if (row.status === "queued") {
        finish(row, "deferred", "not_submitted"); changed = true;
      }
      return { changed };
    }).catch(onError);
  };
}
