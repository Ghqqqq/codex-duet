// Read-only bridge for the function hook. Node supplies O_NOFOLLOW, fstat and
// bounded tail reads, which the function-hook filesystem API does not expose.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveStateRoot } from "./state.mjs";
import { ACTIVE, directReport, progressSnapshot, leaseExpiryReport } from "./job-runtime.mjs";
import { buildWorkerReport } from "./worker-report.mjs";

const id = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const strings = value => Array.isArray(value) && value.every(item => typeof item === "string");
const count = value => Number.isSafeInteger(value) && value >= 0;
const nullableString = value => value === null || typeof value === "string";
const fields = new Set(["status", "worker", "jobId", "summary", "summaryTruncated", "blockers", "question", "changedFiles", "changedFilesOmitted", "checks", "assumptions", "keyFindings", "usage", "next", "details"]);
const usageFields = ["inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"];

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
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid()) || (!tail && stat.size > limit)) return null;
    const named = fs.lstatSync(file);
    if (fs.realpathSync(file) !== file || named.dev !== stat.dev || named.ino !== stat.ino) return null;
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
    // Bind each wait/answer to the session that recorded it, including after
    // adoption. Legacy tool IDs remain scoped to the immutable dispatch session.
    if (job.deliveryBindings !== undefined) {
      const bindings = job.deliveryBindings;
      if (!Array.isArray(bindings) || bindings.length > 20
          || !bindings.every(binding => object(binding) && id(binding.toolUseId) && (binding.sessionId === null || id(binding.sessionId)))
          || !bindings.some(binding => binding.toolUseId === toolUseId && binding.sessionId === sessionId)) return null;
    } else {
      const bindings = job.deliveryToolUseIds ?? [job.dispatchToolUseId];
      if (job.dispatchSessionId !== sessionId || !Array.isArray(bindings) || bindings.length > 20
          || !bindings.every(id) || !bindings.includes(toolUseId)) return null;
    }
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
    return entry.length <= 100000 ? { taskId: notification.taskId, entry } : null;
  } catch { return null; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  let delivery = null;
  try { delivery = readDelivery(JSON.parse(fs.readFileSync(0, "utf8"))); } catch { /* Leave notification intact. */ }
  process.stdout.write(`${JSON.stringify(delivery)}\n`);
}
