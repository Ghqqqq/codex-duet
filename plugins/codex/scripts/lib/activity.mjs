import { createHash } from "node:crypto";

// Display cleanup only: strip ANSI escapes and control/bidi characters so
// snippets stay single-line and terminal-safe. Credential redaction was removed
// deliberately (it blanked ordinary `NAME=value` text such as `ANSWER=Yes`);
// the parent and the worker report see Codex's text as written.
export function redactActivity(value) {
  return String(value ?? "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ");
}
export const snippet = (value, length) => redactActivity(value).replace(/\s+/g, " ").trim().slice(0, length);
const statusOf = (item, lifecycle) => ["inProgress", "completed", "failed", "declined", "cancelled"].includes(item.status) ? item.status : lifecycle;

// Select fields explicitly. Never copy arguments, results, diffs, command output,
// reasoning, web-search results or page content from a protocol item.
export function itemActivity(item, lifecycle, starts, key, now = Date.now()) {
  if (!item) return [];
  if (lifecycle === "started") starts.set(key, now);
  const start = starts.get(key);
  if (lifecycle === "completed") starts.delete(key);
  const durationMs = lifecycle === "completed" ? (Number.isFinite(item.durationMs) && item.durationMs >= 0 ? item.durationMs : start == null ? null : Math.max(0, now - start)) : null;
  const base = { type: item.type, status: statusOf(item, lifecycle), lifecycle };
  switch (item.type) {
    case "agentMessage":
      return lifecycle === "completed" && item.text ? [{ ...base, text: snippet(item.text, 300) }] : [];
    case "commandExecution":
      return [{ ...base, command: snippet(redactActivity(item.command).split(/\r?\n/)[0], 160), exitCode: Number.isInteger(item.exitCode) ? item.exitCode : null, durationMs }];
    case "fileChange":
      return lifecycle === "completed" ? (item.changes ?? []).map(change => ({ ...base, path: snippet(change.path, 180), kind: ["add", "delete", "update"].includes(change.kind?.type ?? change.kind) ? (change.kind?.type ?? change.kind) : "unknown" })) : [];
    case "mcpToolCall":
    case "dynamicToolCall":
      return [{ ...base, server: snippet(item.server ?? item.namespace ?? "dynamic", 80), tool: snippet(item.tool ?? item.name ?? "unknown", 80), durationMs }];
    default: return [];
  }
}
export function planActivity(plan = []) {
  return [{ type: "plan", steps: plan.map(step => snippet(step.step, 80)) }];
}
export function formatActivity(event) {
  const duration = event.durationMs == null ? "duration unknown" : `${event.durationMs}ms`;
  let detail;
  switch (event.type) {
    case "agentMessage": detail = `Codex: ${event.text}`; break;
    case "commandExecution": detail = `Command ${event.status}: ${event.command} (exit ${event.exitCode ?? "pending/unknown"}; ${duration})`; break;
    case "fileChange": detail = `File ${event.kind}: ${event.path}`; break;
    case "mcpToolCall":
    case "dynamicToolCall": detail = `Tool ${event.server}/${event.tool}: ${event.status} (${duration})`; break;
    case "plan": detail = `Plan: ${event.steps.join("; ")}`; break;
    default: detail = "Activity";
  }
  return `[${event.seq}] ${detail}`;
}
// Ownerless observers have their own cursor, independent of the native worker.
export const activityReader = owner => createHash("sha256").update(owner == null ? "observer" : `owner:${owner}`).digest("hex");
