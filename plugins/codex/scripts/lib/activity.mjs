import { createHash } from "node:crypto";
import path from "node:path";

export const ACTIVITY_RETAINED_MAX = 500;
export const ACTIVITY_PENDING_MAX = 100;

function countToolUses(events, pending) {
  let count = 0;
  for (const event of events) {
    if (!["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall"].includes(event.type)) continue;
    count += 1;
    if (event.type === "fileChange") continue;
    // Mirror codex-live/model.ts collapseActivity: starts pair FIFO with a
    // terminal event by command, or by type/server/tool (not callId). Count a
    // pair once, unmatched events once, and each file-change entry once.
    const text = value => typeof value === "string" ? value : "";
    const identity = event.type === "commandExecution"
      ? [event.type, text(event.command)] : [event.type, text(event.server), text(event.tool)];
    // Persist only counts of outstanding starts, not completed item history.
    // Hashes keep command excerpts out of the index and bound each key's size.
    const key = createHash("sha256").update(JSON.stringify(identity)).digest("base64url");
    if (event.lifecycle === "started") {
      pending[key] = (pending[key] ?? 0) + 1;
      const keys = Object.keys(pending);
      if (keys.length > ACTIVITY_PENDING_MAX) {
        // A completion whose start was evicted counts as unmatched; accept that overcount to bound persisted state.
        for (const oldest of keys.slice(0, keys.length - ACTIVITY_PENDING_MAX)) delete pending[oldest];
      }
    } else if ((event.lifecycle === "completed" || ["completed", "failed", "cancelled", "declined"].includes(event.status)) && pending[key]) {
      count -= 1;
      if (--pending[key] === 0) delete pending[key];
    }
  }
  return count;
}

export function appendActivity(stored, events, at = new Date().toISOString()) {
  const retained = stored.activity ?? [];
  const pending = stored.activityTotals ? { ...stored.activityPendingTools } : {};
  // Legacy records have no totals: seed from their available history once.
  // Keep outstanding pairs across window eviction and updater/process restarts.
  const totals = stored.activityTotals ?? {
    events: retained.length,
    toolUses: countToolUses([...retained].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)), pending)
  };
  const seq = stored.activitySeq ?? retained.at(-1)?.seq ?? 0;
  const appended = events.map((event, index) => ({ ...event, seq: seq + index + 1, at }));
  return {
    activity: [...retained, ...appended].slice(-ACTIVITY_RETAINED_MAX),
    activitySeq: seq + appended.length,
    activityTotals: { events: totals.events + appended.length, toolUses: totals.toolUses + countToolUses(appended, pending) },
    activityPendingTools: pending
  };
}

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
      return [{ ...base, command: snippet(commandExcerpt(redactActivity(item.command).split(/\r?\n/)[0], true), 160), exitCode: Number.isInteger(item.exitCode) ? item.exitCode : null, durationMs }];
    case "fileChange":
      return lifecycle === "completed" ? (item.changes ?? []).map(change => ({ ...base, path: snippet(change.path, 180), kind: ["add", "delete", "update"].includes(change.kind?.type ?? change.kind) ? (change.kind?.type ?? change.kind) : "unknown", ...changeLineCounts(change) })) : [];
    case "mcpToolCall":
    case "dynamicToolCall":
      return [{ ...base, callId: item.id ?? null, server: snippet(item.server ?? item.namespace ?? "dynamic", 80), tool: snippet(item.tool ?? item.name ?? "unknown", 80), durationMs }];
    default: return [];
  }
}
export function planActivity(plan = []) {
  return [{ type: "plan", steps: plan.map(step => snippet(step.step, 80)), statuses: plan.map(step => ["pending", "inProgress", "completed"].includes(step.status) ? step.status : "pending") }];
}
// Display-only parsing: never evaluate shell text. Leave unsupported or
// incomplete prefixes intact, including assignments with no command after them.
function stripEnvironment(command) {
  const word = /^(?:[^\s'"\\;&|<>()`]|'[^']*'|"(?:\\.|[^"\\])*"|\\.)+(?=\s|[;&|<>()]|$)/;
  let rest = command, env = false, options = false;
  for (;;) {
    const token = word.exec(rest)?.[0];
    if (!token || token.startsWith("#")) return command;
    if (token === "env" && !env) { env = true; options = true; }
    else if (options && token === "-i") { /* ignore inherited environment */ }
    else if (options && token === "-u") {
      const next = rest.slice(token.length).trimStart();
      const name = word.exec(next)?.[0];
      if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return command;
      rest = next.slice(name.length).trimStart();
      continue;
    } else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) options = false;
    else {
      return env && token.startsWith("-") ? command : rest;
    }
    rest = rest.slice(token.length).trimStart();
  }
}
// Match codex-live's shell unwrapping. Capture-time cleanup retains the wrapper
// and quotes; only the leading environment prefix is removed before the cap.
function commandExcerpt(command, keepWrapper = false) {
  const source = snippet(command, Infinity);
  const wrapper = /^(?:\/bin\/)?(?:zsh|bash|sh)\s+-(?:lc|c)\s+/.exec(source)?.[0] ?? "";
  let start = wrapper.length, end = source.length;
  if (wrapper && (source[start] === "'" || source[start] === '"')) {
    if (source.length > start + 1 && source.endsWith(source[start])) end -= 1;
    start += 1;
  }
  const body = source.slice(start, end);
  // Double-quoted wrappers still contain shell escapes: do not tokenize them
  // as decoded command text and accidentally discard part of an assignment.
  const result = wrapper && source[wrapper.length] === '"' && body.includes("\\") ? body : stripEnvironment(body);
  return keepWrapper ? source.slice(0, start) + result + source.slice(end) : wrapper ? result.replace(/'"'"'/g, "'") : result;
}
function activityPath(file, root) {
  if (!root || !file) return file;
  const windows = value => /^[a-z]:[\\/]|^\\\\[^\\]/i.test(value);
  if (windows(root) !== windows(file)) return file;
  const paths = windows(root) ? path.win32 : path.posix;
  if (!paths.isAbsolute(root) || !paths.isAbsolute(file)) return file;
  const relative = paths.relative(root, file);
  if (relative === ".." || relative.startsWith(`..${paths.sep}`) || paths.isAbsolute(relative)) return file;
  return (relative || ".").split(paths.sep).join("/");
}
function activityResult(event) {
  if (["cancelled", "declined", "interrupted"].includes(event.status)) return event.status;
  if (event.lifecycle === "started" || ["started", "inProgress", "running", "queued"].includes(event.status)) return "running";
  const command = event.type === "commandExecution";
  if (command && !Number.isInteger(event.exitCode)) return "exit unknown";
  let elapsed = "";
  if (Number.isFinite(event.durationMs) && event.durationMs >= 1000) {
    const seconds = Math.round(event.durationMs / 1000);
    const duration = event.durationMs < 60000 ? `${(event.durationMs / 1000).toFixed(1)}s`
      : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    elapsed = ` (${duration})`;
  }
  const failed = ["failed", "error"].includes(event.status) || command && event.exitCode !== 0;
  return (failed ? command ? `Error: exit ${event.exitCode}` : "Error" : "Done") + elapsed;
}
/** @param {{ root?: string }} [options] */
export function formatActivity(event, options = {}) {
  const { root } = options;
  let detail;
  switch (event.type) {
    case "agentMessage": detail = `Codex: ${event.text}`; break;
    case "commandExecution": {
      const result = activityResult(event);
      // Reserve space for the result before the emitter's 200-character cap:
      // a long command must never hide a failure's exit code.
      const limit = Math.max(0, Math.min(160, 200 - `[${event.seq}] Bash() · ${result}`.length));
      const command = commandExcerpt(event.command);
      const excerpt = command.length > limit ? `${command.slice(0, Math.max(0, limit - 1))}…` : command;
      detail = `Bash(${excerpt}) · ${result}`;
      break;
    }
    case "fileChange": {
      const action = event.kind === "add" ? "Write" : event.kind === "delete" ? "Delete" : "Update";
      detail = `${action}(${activityPath(event.path, root)}) · +${event.added ?? (event.kind === "delete" ? 0 : "?")} −${event.removed ?? (event.kind === "add" ? 0 : "?")}`;
      break;
    }
    case "mcpToolCall":
    case "dynamicToolCall": {
      const name = event.type === "mcpToolCall" ? `${event.server} - ${event.tool} (MCP)` : event.tool;
      detail = `${name} · ${activityResult(event)}`;
      break;
    }
    case "plan": {
      const steps = event.steps ?? [], statuses = event.statuses ?? [];
      const done = steps.filter((_, i) => statuses[i] === "completed").length;
      const active = steps.findIndex((_, i) => statuses[i] === "inProgress");
      const current = active < 0 ? steps.findIndex((_, i) => statuses[i] !== "completed") : active;
      detail = `Update Todos · ${done}/${steps.length}${current < 0 ? "" : ` · ${steps[current]}`}`;
      break;
    }
    default: detail = "Activity";
  }
  return `[${event.seq}] ${detail}`;
}
// Ownerless observers have their own cursor, independent of the native worker.
export const activityReader = owner => createHash("sha256").update(owner == null ? "observer" : `owner:${owner}`).digest("hex");
