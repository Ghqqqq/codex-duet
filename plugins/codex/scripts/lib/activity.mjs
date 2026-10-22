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

// A worker's final message is the worker-report JSON (schemas/worker-report.schema.json);
// the live feed shows its status and summary rather than the envelope.
function reportText(text, summaryOnly = false) {
  const trimmed = String(text).trim();
  if (!trimmed.startsWith("{")) return text;
  try {
    const value = JSON.parse(trimmed);
    if (value && typeof value.status === "string" && typeof value.summary === "string") return summaryOnly ? value.summary : `[${value.status}] ${value.summary}`;
  } catch { /* ordinary message */ }
  return text;
}
function changeLineCounts(change) {
  const diff = change.diff ?? change.kind?.unified_diff;
  if (typeof diff === "string") {
    let added = 0, removed = 0;
    for (const line of diff.split(/\r?\n/)) {
      if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
      if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
    }
    return { added, removed };
  }
  const content = change.content ?? change.kind?.content;
  if ((change.kind?.type ?? change.kind) === "add" && typeof content === "string") {
    return { added: content === "" ? 0 : content.split("\n").length - (content.endsWith("\n") ? 1 : 0) };
  }
  return {};
}
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
      return lifecycle === "completed" && item.text ? [{ ...base, text: snippet(reportText(item.text), 300), body: redactActivity(reportText(item.text, true)).slice(0, 4000) }] : [];
    case "commandExecution":
      return [{ ...base, command: snippet(redactActivity(item.command).split(/\r?\n/)[0], 160), exitCode: Number.isInteger(item.exitCode) ? item.exitCode : null, durationMs }];
    case "fileChange":
      return lifecycle === "completed" ? (item.changes ?? []).map(change => ({ ...base, path: snippet(change.path, 180), kind: ["add", "delete", "update"].includes(change.kind?.type ?? change.kind) ? (change.kind?.type ?? change.kind) : "unknown", ...changeLineCounts(change) })) : [];
    case "mcpToolCall":
    case "dynamicToolCall":
      return [{ ...base, server: snippet(item.server ?? item.namespace ?? "dynamic", 80), tool: snippet(item.tool ?? item.name ?? "unknown", 80), durationMs }];
    default: return [];
  }
}
export function planActivity(plan = []) {
  return [{ type: "plan", steps: plan.map(step => snippet(step.step, 80)), statuses: plan.map(step => ["pending", "inProgress", "completed"].includes(step.status) ? step.status : "pending") }];
}
// Match the pane's unwrapCommand: remove only a recognized shell wrapper,
// including its outer quotes, even when the stored excerpt was truncated.
function commandExcerpt(command) {
  let result = snippet(command, Infinity);
  const wrapper = /^(?:\/bin\/)?(?:zsh|bash|sh)\s+-(?:lc|c)\s+/;
  if (!wrapper.test(result)) return result;
  result = result.replace(wrapper, "");
  const quote = result[0];
  if (quote === "'" || quote === '"') {
    result = result.slice(1);
    if (result.endsWith(quote)) result = result.slice(0, -1);
  }
  return result.replace(/'"'"'/g, "'");
}
export function formatActivity(event) {
  const duration = event.durationMs == null ? "duration unknown" : `${event.durationMs}ms`;
  let detail;
  switch (event.type) {
    case "agentMessage": detail = `Codex: ${event.text}`; break;
    case "commandExecution": {
      const command = commandExcerpt(event.command);
      if (["cancelled", "declined", "interrupted"].includes(event.status)) detail = `■ ${event.status} · ${command}`;
      else if (event.lifecycle === "started" || ["started", "inProgress", "running", "queued"].includes(event.status)) detail = `▸ ${command}`;
      else if (!Number.isInteger(event.exitCode)) detail = `? exit unknown · ${command}`;
      else {
        const result = event.exitCode !== 0 || ["failed", "error"].includes(event.status) ? "✗" : "✓";
        const elapsed = Number.isFinite(event.durationMs) && event.durationMs >= 0 ? ` · ${(event.durationMs / 1000).toFixed(1)}s` : "";
        detail = `${result} exit ${event.exitCode}${elapsed} · ${command}`;
      }
      break;
    }
    case "fileChange": detail = `edit ${event.path} +${event.added ?? (event.kind === "delete" ? 0 : "?")} −${event.removed ?? (event.kind === "add" ? 0 : "?")}`; break;
    case "mcpToolCall":
    case "dynamicToolCall": detail = `Tool ${event.server}/${event.tool}: ${event.status} (${duration})`; break;
    case "plan": {
      const steps = event.steps ?? [], statuses = event.statuses ?? [];
      const done = steps.filter((_, i) => statuses[i] === "completed").length;
      const active = steps.findIndex((_, i) => statuses[i] === "inProgress");
      const current = active < 0 ? steps.findIndex((_, i) => statuses[i] !== "completed") : active;
      detail = `plan ${done}/${steps.length}${current < 0 ? "" : ` · ${steps[current]}`}`;
      break;
    }
    default: detail = "Activity";
  }
  return `[${event.seq}] ${detail}`;
}
// Ownerless observers have their own cursor, independent of the native worker.
export const activityReader = owner => createHash("sha256").update(owner == null ? "observer" : `owner:${owner}`).digest("hex");
