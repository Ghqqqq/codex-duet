// Bridge for the function hook. Node supplies O_NOFOLLOW, fstat, state locks and
// bounded tail reads, which the function-hook filesystem API does not expose.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolveStateRoot, resolveStateDirForRoot, updateJob } from "./state.mjs";
import { resolveIsolatedCodexHome } from "./codex-home.mjs";
import { ACTIVE, directReport, progressSnapshot, leaseExpiryReport } from "./job-runtime.mjs";
import { buildWorkerReport } from "./worker-report.mjs";
import { snippet } from "./activity.mjs";

const id = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const strings = value => Array.isArray(value) && value.every(item => typeof item === "string");
const count = value => Number.isSafeInteger(value) && value >= 0;
const nullableString = value => value === null || typeof value === "string";
const fields = new Set(["status", "worker", "jobId", "summary", "summaryTruncated", "blockers", "question", "changedFiles", "changedFilesOmitted", "checks", "assumptions", "keyFindings", "usage", "next", "details"]);
const usageFields = ["inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"];
const terminal = new Set(["completed", "needs_input", "blocked", "failed", "cancelled", "interrupted", "owner_stopped", "error"]);
const noticeLimit = 5, graceMs = 10000;
export const ENDING_CLAIM_TTL_MS = 600000;
const claimToken = value => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const sessionOf = job => job.sessionId === undefined ? job.ownerId : job.sessionId;
const quote = value => `'${value.replace(/'/g, `'"'"'`)}'`;

// State mutations use process.env. Keep the exported helper's explicit env
// support synchronous and confined to the selected, validated isolated home.
function inStateHome(env, work) {
  const home = resolveIsolatedCodexHome(env), previous = process.env.CODEX_COMPANION_HOME;
  process.env.CODEX_COMPANION_HOME = home;
  try { return work(); }
  finally {
    if (previous === undefined) delete process.env.CODEX_COMPANION_HOME;
    else process.env.CODEX_COMPANION_HOME = previous;
  }
}

export function markReportEmitted(job, status, env = process.env) {
  if (job?.reportTracking !== 1 || !terminal.has(status)) return;
  // Output has already been accepted. A bookkeeping failure must not replace
  // that output or change its exit code. The first successful write wins.
  try {
    inStateHome(env, () => updateJob(job.workspaceRoot, job.id, current =>
      current.reportTracking === 1 && !current.reportEmittedAt ? { reportEmittedAt: new Date().toISOString() } : null,
    { lockTimeoutMs: 100 }));
  } catch { /* Best effort after delivery. */ }
}

// Same PID probe as state/retention (their helpers are module-private).
function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
}

function eligible(job, now) {
  const completed = Date.parse(job.completedAt), claimed = Date.parse(job.endingClaim?.at);
  // A terminal wait can still be draining a backed-up stdout after the grace
  // period. An attached live PID is still a consumer; dead/missing PIDs are not.
  return job.reportTracking === 1 && terminal.has(job.status) && Number.isFinite(completed)
    && completed <= now - graceMs && !job.reportEmittedAt && !job.endingNoticedAt
    && !(Number.isFinite(claimed) && claimed > now - ENDING_CLAIM_TTL_MS)
    && !(job.ownerAttached && processAlive(job.ownerWaitPid));
}

function sessionRecords(sessionId, env, select) {
  if (!id(sessionId)) throw new Error("Invalid session.");
  const root = resolveStateRoot(env);
  if (!fs.existsSync(root)) return [];
  if (fs.realpathSync(root) !== root) throw new Error("Invalid state root.");
  const records = [], seen = new Set();
  let entries = 0, bytes = 0;
  // Match listSessionJobs' current-session/workspace scope, with hard scan and
  // read bounds and strict parsing instead of its best-effort migration reads.
  const directory = fs.opendirSync(root);
  try {
    for (let entry; (entry = directory.readSync());) {
      if (++entries > 256) throw new Error("State scan limit.");
      if (!entry.isDirectory()) continue;
      const stateDir = path.join(root, entry.name), file = path.join(stateDir, "state.json");
      if (!fs.existsSync(file)) continue;
      const text = readRegular(file, { limit: 2 * 1024 * 1024 });
      if (text === null || (bytes += Buffer.byteLength(text)) > 8 * 1024 * 1024) throw new Error("State read limit.");
      const state = JSON.parse(text);
      if (!object(state) || !Array.isArray(state.jobs) || state.jobs.length > 2000) throw new Error("Invalid state index.");
      for (const job of state.jobs) {
        if (!object(job)) throw new Error("Invalid job.");
        if (sessionOf(job) !== sessionId || job.reportTracking !== 1 || !select(job)) continue;
        if (!id(job.id) || typeof job.workspaceRoot !== "string" || !path.isAbsolute(job.workspaceRoot)
            || resolveStateDirForRoot(job.workspaceRoot, env) !== stateDir || seen.has(job.id)) throw new Error("Invalid job mapping.");
        seen.add(job.id);
        if (records.length >= 2000) throw new Error("Job scan limit.");
        records.push({ job, file: path.join(stateDir, "jobs", `${job.id}.json`) });
      }
    }
  } finally { directory.closeSync(); }
  return records;
}

function noticeEntry(job) {
  const reason = job.interruptionReason ?? job.result?.interruptionReason ?? job.report?.interruptionReason
    ?? job.report?.blockers?.[0]?.code ?? job.result?.blockers?.[0]?.code ?? null;
  const unsafePath = /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(job.workspaceRoot);
  const details = `duet result ${quote(job.id)}${unsafePath ? "" : ` --cwd ${quote(job.workspaceRoot)}`} --details`;
  if (details.length > 4096) throw new Error("Invalid details command.");
  return { worker: snippet(job.agentName, 96) || job.id, jobId: job.id, status: job.status,
    reason: typeof reason === "string" && /^[A-Za-z0-9_.:-]{1,96}$/.test(reason) ? reason : null, details };
}

export function claimUnreported({ sessionId }, env = process.env, now = Date.now()) {
  const claimed = [];
  try {
    if (!Number.isFinite(now)) return null;
    const records = sessionRecords(sessionId, env, job => eligible(job, now))
      .sort((a, b) => a.job.completedAt.localeCompare(b.job.completedAt) || a.job.id.localeCompare(b.job.id));
    // Validate the whole candidate scan before any mutation. An empty scan is
    // strictly read-only: no migration, directories, locks or marker writes.
    checkMarkRecords(records);
    inStateHome(env, () => {
      for (const { job } of records) {
        let entry;
        updateJob(job.workspaceRoot, job.id, current => {
          if (current.id !== job.id || current.workspaceRoot !== job.workspaceRoot
              || sessionOf(current) !== sessionId || !eligible(current, now)) return null;
          entry = { ...noticeEntry(current), token: randomUUID() };
          return { endingClaim: { token: entry.token, at: new Date(now).toISOString() } };
        }, { lockTimeoutMs: 100 });
        if (entry) claimed.push(entry);
        if (claimed.length === noticeLimit) break;
      }
    });
    return claimed;
  } catch {
    if (claimed.length) releaseNoticed({ sessionId, claims: claimed }, env);
    return null;
  }
}

function checkMarkRecords(records) {
  let bytes = 0;
  for (const { job, file } of records) {
    const text = readRegular(file);
    if (text === null || (bytes += Buffer.byteLength(text)) > 32 * 1024 * 1024) throw new Error("Job read limit.");
    const current = JSON.parse(text);
    if (!object(current) || current.id !== job.id || current.workspaceRoot !== job.workspaceRoot) throw new Error("Invalid job record.");
  }
}

// Lost claim responses and failed releases become eligible again after the
// TTL. A failed confirmation can repeat an accepted notice after the TTL, but
// cannot permanently consume it before acceptance was recorded.
function finishNoticeClaims({ sessionId, claims }, env, confirm, now) {
  try {
    if (!Number.isFinite(now) || !Array.isArray(claims) || !claims.length || claims.length > noticeLimit
        || !claims.every(claim => object(claim) && id(claim.jobId) && claimToken(claim.token))
        || new Set(claims.map(claim => claim.jobId)).size !== claims.length) return null;
    const tokens = new Map(claims.map(claim => [claim.jobId, claim.token]));
    const records = sessionRecords(sessionId, env, job => tokens.has(job.id));
    checkMarkRecords(records);
    inStateHome(env, () => {
      for (const { job } of records) updateJob(job.workspaceRoot, job.id, current =>
        current.id === job.id && current.workspaceRoot === job.workspaceRoot && current.reportTracking === 1
          && sessionOf(current) === sessionId && current.endingClaim?.token === tokens.get(job.id)
          ? { endingClaim: undefined, ...(confirm && !current.endingNoticedAt ? { endingNoticedAt: new Date(now).toISOString() } : {}) }
          : null, { lockTimeoutMs: 100 });
    });
    return { ok: true };
  } catch { return null; }
}

export function confirmNoticed(request, env = process.env, now = Date.now()) {
  return finishNoticeClaims(request, env, true, now);
}

export function releaseNoticed(request, env = process.env) {
  return finishNoticeClaims(request, env, false, Date.now());
}

// Native aborts can hand Claude a synthesized stopped report before the job
// itself ends. turn.complete runs this after the aborted step can no longer
// call processes. Do not require terminal state for that already-emitted report.
export function markEmitted({ sessionId, jobIds }, env = process.env) {
  try {
    if (!Array.isArray(jobIds) || !jobIds.length || jobIds.length > noticeLimit || !jobIds.every(id)
        || new Set(jobIds).size !== jobIds.length) return null;
    const records = sessionRecords(sessionId, env, job => jobIds.includes(job.id));
    checkMarkRecords(records);
    inStateHome(env, () => {
      for (const { job } of records) updateJob(job.workspaceRoot, job.id, current =>
        current.id === job.id && current.workspaceRoot === job.workspaceRoot && current.reportTracking === 1
          && sessionOf(current) === sessionId && !current.reportEmittedAt
          ? { reportEmittedAt: new Date().toISOString() } : null, { lockTimeoutMs: 100 });
    });
    return { ok: true };
  } catch { return null; }
}

export function isC2Report(value) {
  if (!object(value) || Object.keys(value).some(key => !fields.has(key))
      || !["completed", "needs_input", "blocked", "failed", "cancelled", "queued", "running", "needs_answer", "ownership_moved", "interrupted", "owner_stopped", "error", "unknown", "unreachable"].includes(value.status)
      || !id(value.jobId) || !nullableString(value.worker) || typeof value.summary !== "string" || value.summary.length > 8000
      || !nullableString(value.next) || !nullableString(value.details)) return false;
  if ("summaryTruncated" in value && typeof value.summaryTruncated !== "boolean") return false;
  for (const key of ["changedFiles", "assumptions", "keyFindings"]) if (key in value && !strings(value[key])) return false;
  if ("changedFilesOmitted" in value && !count(value.changedFilesOmitted)) return false;
  if ("blockers" in value && (!Array.isArray(value.blockers) || !value.blockers.every(b => object(b) && typeof b.code === "string" && typeof b.message === "string"))) return false;
  if ("checks" in value && (!object(value.checks) || !strings(value.checks.ran) || !strings(value.checks.claimed) || !count(value.checks.omitted))) return false;
  if ("usage" in value && (!object(value.usage) || Object.keys(value.usage).length !== usageFields.length
      || !usageFields.every(key => count(value.usage[key])))) return false;
  if ("question" in value) {
    const q = value.question;
    if (!object(q) || !nullableString(q.id) || typeof q.kind !== "string" || typeof q.text !== "string" || !strings(q.options)
        || !(q.expiresInSec === null || count(q.expiresInSec))) return false;
  }
  const { summary, ...envelope } = value;
  return Buffer.byteLength(JSON.stringify(envelope)) <= 2000;
}

export function parseTaskNotification(text) {
  if (typeof text !== "string" || text.length > 32768) return null;
  // Pinned li/y7t envelope: optional task-type and note; never correlate using
  // a description. Duplicate, nested, unexpected or incomplete tags abstain.
  const outer = /^\s*<task-notification>([\s\S]*?)<\/task-notification>\s*$/.exec(text);
  if (!outer) return null;
  const tags = {};
  let rest = outer[1].trim();
  while (rest) {
    const match = /^<(task-id|tool-use-id|task-type|output-file|status|summary|note)>([^<]*)<\/\1>\s*/.exec(rest);
    if (!match || Object.hasOwn(tags, match[1])) return null;
    tags[match[1]] = match[2];
    rest = rest.slice(match[0].length);
  }
  if (!id(tags["task-id"]) || !id(tags["tool-use-id"]) || !tags["output-file"] || !["completed", "failed", "stopped"].includes(tags.status) || typeof tags.summary !== "string") return null;
  return { taskId: tags["task-id"], toolUseId: tags["tool-use-id"], outputFile: tags["output-file"] };
}

function readRegular(file, { tail = false, limit = 16 * 1024 * 1024 } = {}) {
  const valid = stat => stat.isFile() && stat.nlink === 1 && (!process.getuid || stat.uid === process.getuid())
    && (tail || stat.size <= limit);
  for (let attempt = 0; attempt < 3; attempt++) {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const stat = fs.fstatSync(fd);
      if (!valid(stat)) return null;
      const named = fs.lstatSync(file);
      if (!valid(named) || fs.realpathSync(file) !== file) return null;
      // Atomic state publication may replace a valid regular file after open.
      // Retry only that identity race; unsafe paths and other failures abstain.
      if (named.dev !== stat.dev || named.ino !== stat.ino) continue;
      const start = tail ? Math.max(0, stat.size - limit) : 0;
      const buffer = Buffer.alloc(Math.min(stat.size, limit));
      let offset = 0;
      while (offset < buffer.length) {
        const read = fs.readSync(fd, buffer, offset, buffer.length - offset, start + offset);
        if (!read) return null;
        offset += read;
      }
      const after = fs.fstatSync(fd);
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) return null;
      const text = buffer.toString("utf8");
      // A cut first line must never masquerade as a whole JSON record.
      return start ? text.slice(text.indexOf("\n") < 0 ? text.length : text.indexOf("\n") + 1) : text;
    } finally { fs.closeSync(fd); }
  }
  return null;
}

function outputTail(notification, sessionId, env) {
  // Claude Code 2.1.302: um -> Ed -> em -> Ssn/wI -> oDt -> qrn.
  // Default /tmp (realpathed on macOS), or CLAUDE_CODE_TMPDIR; per-uid
  // claude-<uid>/<sanitized-original-cwd>/<session>/tasks/<task>.output.
  // Remote/adopted roots and diskless sessions deliberately abstain.
  const rootPath = path.join(env.CLAUDE_CODE_TMPDIR || "/tmp", `claude-${process.getuid?.() ?? 0}`);
  const rootStat = fs.lstatSync(rootPath);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (process.getuid && rootStat.uid !== process.getuid())) return null;
  const root = fs.realpathSync(rootPath);
  const file = notification.outputFile;
  if (!path.isAbsolute(file) || path.normalize(file) !== file) return null;
  const canonical = fs.realpathSync(file);
  const relative = path.relative(root, canonical).split(path.sep);
  if (relative.length !== 4 || !/^[A-Za-z0-9-]+$/.test(relative[0]) || relative[1] !== sessionId
      || relative[2] !== "tasks" || relative[3] !== `${notification.taskId}.output`) return null;
  // Permit /tmp -> /private/tmp, but no symlinked project/session/tasks/leaf.
  const spelled = path.relative(path.join(env.CLAUDE_CODE_TMPDIR || "/tmp", `claude-${process.getuid?.() ?? 0}`), file);
  if (spelled !== relative.join(path.sep) && file !== canonical) return null;
  if (fs.lstatSync(file).isSymbolicLink()) return null;
  // Details can be much larger than the compact attachment. Keep the same
  // bounded read budget as a stored job, without parsing that much output.
  return readRegular(canonical, { tail: true, limit: 16 * 1024 * 1024 });
}

function boundHere(job, sessionId, toolUseId) {
  // Adoption changes the owner, not the session attached to an existing wait.
  if (job.deliveryBindings !== undefined) {
    const bindings = job.deliveryBindings;
    return Array.isArray(bindings) && bindings.length <= 20
      && bindings.every(binding => object(binding) && id(binding.toolUseId) && (binding.sessionId === null || id(binding.sessionId)))
      && bindings.some(binding => binding.toolUseId === toolUseId && binding.sessionId === sessionId);
  }
  const bindings = job.deliveryToolUseIds ?? [job.dispatchToolUseId];
  return job.dispatchSessionId === sessionId && Array.isArray(bindings) && bindings.length <= 20
    && bindings.every(id) && bindings.includes(toolUseId);
}

function dispatchedHere(jobId, sessionId, toolUseId, env) {
  const root = fs.realpathSync(resolveStateRoot(env));
  let matched = null;
  for (const directory of fs.readdirSync(root, { withFileTypes: true })) {
    if (!directory.isDirectory()) continue;
    const file = path.join(root, directory.name, "jobs", `${jobId}.json`);
    if (!fs.existsSync(file)) continue;
    if (fs.realpathSync(file) !== file) return null;
    const job = JSON.parse(readRegular(file));
    if (!object(job) || job.id !== jobId || job.jobClass !== "task" || matched) return null;
    if (!boundHere(job, sessionId, toolUseId)) return null;
    matched = job;
  }
  return matched;
}

function storedReport(job, env) {
  // Match the direct wait/result projection. A stopped owner writes its final
  // line before the worker finishes interrupting; the detach marker is already
  // persisted, so this status never needs to be trusted from the output file.
  const ownerStopped = ACTIVE.has(job.status) && !job.ownerAttached && job.ownerDetachedAt
    && ["signal", "parent_exit", "stdout_closed"].includes(job.ownerDetachReason);
  const payload = ownerStopped ? { status: "owner_stopped", jobId: job.id }
    : ACTIVE.has(job.status) ? progressSnapshot(job)
    : { ...(job.report ?? buildWorkerReport(job.result ?? { status: 1, error: job.errorMessage ?? "No stored result." },
      { jobId: job.id, rawOutputFile: job.rawOutputFile, resultFile: job.resultFile })), ...leaseExpiryReport(job) };
  return directReport(payload, job, env);
}

export function readDelivery({ text, sessionId }, env = process.env) {
  try {
    if (!id(sessionId)) return null;
    const notification = parseTaskNotification(text);
    if (!notification) return null;
    const tail = outputTail(notification, sessionId, env);
    const line = tail?.split("\n").findLast(line => line.startsWith("{"));
    if (!line) return null;
    // The untrusted file is only a job locator, never the report authority.
    // Details start with status, optional structured-report tags, then jobId;
    // report v2 uses status/worker/jobId. Inspect only a bounded JSON prefix.
    const jobId = line.length > 100000
      ? /^\{"status":"[a-z_]+",(?:(?:"worker":(?:null|"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*")|"reportFormat":"structured","declaredStatus":"(?:completed|needs_input|blocked)"),)?"jobId":"([A-Za-z0-9_-]{1,128})"[,}]/.exec(line.slice(0, 2048))?.[1]
      : JSON.parse(line)?.jobId;
    if (!id(jobId)) return null;
    const job = dispatchedHere(jobId, sessionId, notification.toolUseId, env);
    if (!job) return null;
    const report = storedReport(job, env);
    if (!isC2Report(report)) return null;
    const entry = `Duet report for background task ${notification.taskId}:\n${JSON.stringify(report)}`;
    if (entry.length > 100000) return null;
    return { taskId: notification.taskId, jobId, status: report.status, entry };
  } catch { return null; }
}

// Called only after downstream accepts the prepared attachment. Recheck its
// binding under the job lock; current ownership need not be the bound session.
export function markDeliveryEmitted({ text, sessionId, jobId, status }, env = process.env) {
  try {
    if (!id(sessionId) || !id(jobId) || !terminal.has(status)) return null;
    const notification = parseTaskNotification(text);
    if (!notification) return null;
    const job = dispatchedHere(jobId, sessionId, notification.toolUseId, env);
    if (!job || typeof job.workspaceRoot !== "string") return null;
    inStateHome(env, () => updateJob(job.workspaceRoot, jobId, current =>
      current.id === jobId && current.workspaceRoot === job.workspaceRoot && current.jobClass === "task"
        && current.reportTracking === 1 && !current.reportEmittedAt && boundHere(current, sessionId, notification.toolUseId)
        && terminal.has(storedReport(current, env).status)
        ? { reportEmittedAt: new Date().toISOString() } : null, { lockTimeoutMs: 100 }));
    return { ok: true };
  } catch { return null; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  let delivery = null;
  try {
    // Bound stdin too; the composer modes never need notification text.
    const buffer = Buffer.alloc(256 * 1024 + 1);
    let length = 0, read;
    while (length < buffer.length && (read = fs.readSync(0, buffer, length, buffer.length - length))) length += read;
    if (length === buffer.length) throw new Error("Input limit.");
    const request = JSON.parse(buffer.toString("utf8", 0, length));
    delivery = process.argv[2] === "--claim-unreported" ? claimUnreported(request)
      : process.argv[2] === "--release-noticed" ? releaseNoticed(request)
      : process.argv[2] === "--confirm-noticed" ? confirmNoticed(request)
      : process.argv[2] === "--mark-delivered" ? markDeliveryEmitted(request)
      : process.argv[2] === "--mark-emitted" ? markEmitted(request)
      : process.argv[2] === undefined ? readDelivery(request) : null;
  } catch { /* Leave the prompt intact. */ }
  process.stdout.write(`${JSON.stringify(delivery)}\n`);
}
