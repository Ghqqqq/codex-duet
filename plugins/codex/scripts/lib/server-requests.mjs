import { createHash } from "node:crypto";
import { cleanDisplayText } from "./display-text.mjs";

const methods = new Set([
  "item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/tool/requestUserInput",
  "mcpServer/elicitation/request", "item/permissions/requestApproval", "item/tool/call",
  "account/chatgptAuthTokens/refresh", "attestation/generate", "applyPatchApproval", "execCommandApproval"
]);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const only = (value, keys) => object(value) && Object.keys(value).every(k => keys.includes(k));
const empty = value => value == null || (Array.isArray(value) && value.length === 0);
const hash = value => createHash("sha256").update(String(value)).digest("hex").slice(0, 16);

export function normalizeBrowserOrigin(value) {
  // An origin has no trailing slash/path, even '/'. Do not echo invalid input:
  // callers might have accidentally supplied userinfo or a private URL/query.
  const invalid = () => new Error("--approve-browser-origin requires an HTTP(S) origin (scheme://host[:port]) without wildcard, path, query, fragment or userinfo.");
  if (typeof value !== "string") throw invalid();
  const match = /^(https?):\/\/(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::([0-9]+))?$/i.exec(value);
  if (!match) throw invalid();
  let url;
  try { url = new URL(value); } catch { throw invalid(); }
  if (!url.hostname || url.origin === "null") throw invalid();
  if (!match[2].startsWith("[")) {
    if (url.hostname !== match[2].toLowerCase() || match[2].length > 253 ||
        match[2].split(".").some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) throw invalid();
  }
  return url.origin;
}

export function normalizeBrowserOrigins(values = []) {
  if (!Array.isArray(values)) throw new Error("Browser origin approvals must be a list.");
  return [...new Set(values.map(normalizeBrowserOrigin))];
}

// Computer Use identifies macOS apps by bundle identifier (reverse-DNS, as in
// `com.google.Chrome`). Case is significant to the runtime, so it is preserved.
export function normalizeBundleId(value) {
  const invalid = () => new Error("A Computer Use app must be a bundle identifier such as com.google.Chrome (reverse-DNS labels, no spaces or wildcards).");
  if (typeof value !== "string") throw invalid();
  const id = value.trim();
  if (id.length > 255 || !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(id)) throw invalid();
  return id;
}
export function normalizeBundleIds(values = []) {
  if (!Array.isArray(values)) throw new Error("Computer Use app approvals must be a list.");
  return [...new Set(values.map(normalizeBundleId))];
}

// setup installs cua_repl; tool sync also preserves the legacy node_repl server.
// Only their empty-form Computer Use request is supported. Metadata supplied by
// another server, or attached to a broader form/URL request, is not app consent.
// Unknown envelope/metadata fields are ignored; the schema and tool parameters
// remain closed so an app grant cannot approve additional input or actions.
function computerUseElicitation(params) {
  if (!object(params) ||
      !["node_repl", "cua_repl"].includes(params.serverName) || params.mode !== "form" ||
      typeof params.threadId !== "string" || !params.threadId ||
      (params.turnId != null && typeof params.turnId !== "string") || typeof params.message !== "string" ||
      !only(params.requestedSchema, ["type", "properties"]) || params.requestedSchema.type !== "object" ||
      !only(params.requestedSchema.properties, [])) return null;
  const meta = params?._meta;
  if (!object(meta) ||
      meta.connector_id !== "computer-use" || meta.codex_approval_kind !== "mcp_tool_call" ||
      (meta.connector_name !== undefined && meta.connector_name !== "Computer Use") ||
      (meta.persist !== undefined && (!Array.isArray(meta.persist) || meta.persist.length !== 2 || meta.persist[0] !== "session" || meta.persist[1] !== "always")) ||
      (meta.riskLevel !== undefined && typeof meta.riskLevel !== "string") ||
      typeof meta.tool_name !== "string" || !meta.tool_name ||
      (meta.tool_params_display !== undefined && typeof meta.tool_params_display !== "string") ||
      !only(meta.tool_params, ["app"])) return null;
  try {
    const app = normalizeBundleId(meta.tool_params.app);
    return app === meta.tool_params.app ? app : null;
  } catch { return null; }
}

// The parent's answer to a forwarded Computer Use request: one call, the rest of
// this task (thread-scoped persisted state, withdrawn when the turn ends), always
// (the isolated home's own allow list; `~/.codex` is never written) or deny.
export const APPROVAL_CHOICES = ["call", "task", "always", "deny"];
export const APPROVAL_OPTIONS = ["Allow this call", "Allow for this task", "Allow always (isolated Codex home)", "Deny"];
export function parseApprovalAnswer(answer) {
  const text = String(answer ?? "").trim().toLowerCase();
  const option = APPROVAL_OPTIONS.findIndex(label => label.toLowerCase() === text.replace(/\.$/, ""));
  if (option !== -1) return APPROVAL_CHOICES[option];
  if (/^[1-4]$/.test(text)) return APPROVAL_CHOICES[Number(text) - 1];
  if (APPROVAL_CHOICES.includes(text)) return text;
  if (text === "once") return "call";
  return "deny";
}

export const ACTION_APPROVAL_OPTIONS = ["Allow once", "Deny"];
export const isActionApproval = message => ["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(message.method);
// JSON quoting keeps whitespace and control characters visible and exact. Bidi
// formatting and C1 controls must also be visible, not affect the parent's UI.
const operationText = value => cleanDisplayText(JSON.stringify(value).replace(/[\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g,
  char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`));

export function actionApprovalRequest(message, context, policy, item) {
  if (!policy || !isActionApproval(message)) return null;
  const p = message.params;
  const summary = { method: message.method, requestId: Number.isSafeInteger(message.id) ? message.id : `sha256:${hash(message.id)}`,
    kind: "action-approval", decision: "cancelled", reason: "malformed-request" };
  const denied = { reply: { id: message.id, result: { decision: "decline" } }, summary, request: null };
  if (!object(p) || !(Number.isSafeInteger(message.id) || typeof message.id === "string" && message.id.length > 0) ||
      !["threadId", "turnId", "itemId"].every(key => typeof p[key] === "string" && p[key]) || !Number.isSafeInteger(p.startedAtMs)) return denied;
  if (!context.threadId || !context.turnId || p.threadId !== context.threadId || p.turnId !== context.turnId) {
    summary.reason = "turn-mismatch"; return denied;
  }
  if (!policy.forwardActions) { summary.reason = "permission-mode-denies-approvals"; return denied; }
  let question;
  if (message.method === "item/commandExecution/requestApproval") {
    // Codex 0.166 also sends kind, availableDecisions and the "local" environment.
    if (!only(p, ["threadId", "turnId", "itemId", "startedAtMs", "approvalId", "environmentId", "reason", "networkApprovalContext", "command", "cwd", "commandActions", "proposedExecpolicyAmendment", "proposedNetworkPolicyAmendments", "kind", "availableDecisions"]) ||
        typeof p.command !== "string" || !p.command || typeof p.cwd !== "string" || !p.cwd || (p.environmentId != null && p.environmentId !== "local") ||
        (p.kind !== undefined && p.kind !== "command")) return denied;
    question = `Codex command approval. Command: ${operationText(p.command)}\nCwd: ${operationText(p.cwd)}`;
  } else {
    // grantRoot is unstable session authority, never a filename or consent.
    if (!only(p, ["threadId", "turnId", "itemId", "startedAtMs", "reason", "grantRoot", "kind", "availableDecisions"]) || p.grantRoot != null) {
      summary.reason = "unsupported-root-grant"; return denied;
    }
    if (item?.type !== "fileChange" || item.id !== p.itemId || item.threadId !== p.threadId || item.turnId !== p.turnId || !Array.isArray(item.changes) || !item.changes.length ||
        !item.changes.every(change => typeof change.path === "string" && change.path && typeof change.diff === "string" &&
          ["add", "delete", "update"].includes(change.kind?.type) && (change.kind.move_path == null || typeof change.kind.move_path === "string"))) {
      summary.reason = "missing-file-change-details"; return denied;
    }
    question = `Codex file-change approval. Cwd: ${operationText(policy.cwd)}\nFiles/diff: ${operationText(item.changes.map(change => ({ path: change.path, kind: change.kind, diff: change.diff })))}`;
  }
  // Only a one-time accept is ever sent; refuse to ask when the runtime offers none.
  if (p.availableDecisions != null && (!Array.isArray(p.availableDecisions) || !p.availableDecisions.includes("accept"))) {
    summary.reason = "accept-unavailable"; return denied;
  }
  if (Buffer.byteLength(JSON.stringify(question)) > 800) { summary.reason = "operation-too-large-to-display-exactly"; return denied; }
  summary.decision = "pending"; summary.reason = "ask-parent";
  return { ...denied, request: { kind: "action-approval", question,
    binding: { threadId: p.threadId, turnId: p.turnId, requestId: message.id, itemId: p.itemId, approvalId: p.approvalId ?? null, method: message.method } } };
}

export function unsupportedServerRequest(message) {
  // browser-service oee persists accept/decline only; cancel avoids a stale deny.
  if (message.method === "mcpServer/elicitation/request") return { id: message.id, result: { action: "cancel" } };
  return { id: message.id, error: { code: -32601, message: methods.has(message.method) ? `Unsupported server request: ${message.method}` : "Unsupported server request" } };
}

export function decideServerRequest(message, { approvedBrowserOrigins = [], approvedComputerApps = [], threadId = null, turnId = null } = {}) {
  const method = methods.has(message.method) ? message.method : `unrecognized:${hash(message.method)}`;
  /** @type {{ method: string, requestId: string | number, kind: string, decision: string, reason: string, origin?: string, app?: string, server?: string, fields?: string[] }} */
  const summary = {
    method,
    requestId: Number.isSafeInteger(message.id) ? message.id : `sha256:${hash(message.id)}`,
    kind: "unsupported", decision: "unsupported", reason: "unsupported-method"
  };
  const reply = unsupportedServerRequest(message);
  const p = message.params;
  // Retain only a bounded server identifier, never request messages or schemas.
  if (typeof p?.serverName === "string" && /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,79}$/.test(p.serverName)) summary.server = p.serverName;
  if (message.method === "mcpServer/elicitation/request") {
    summary.decision = "cancelled";
    summary.reason = "unsupported-elicitation-nonpersistent";
    if (["form", "openai/form", "openaiForm", "url"].includes(p?.mode)) summary.kind = `elicitation-${p.mode}`;
    const app = computerUseElicitation(p);
    if (app) {
      // The bundle id is the runtime's own identifier, safe to log and report.
      summary.kind = "computer-use-app";
      summary.app = app;
      const apps = normalizeBundleIds(approvedComputerApps);
      // Elicitation params may omit turnId; when present it must match the active turn.
      if (!threadId || !turnId || p.threadId !== threadId || (p.turnId != null && p.turnId !== turnId)) summary.reason = "turn-mismatch";
      else if (!apps.length) summary.reason = "no-flag";
      else if (!apps.includes(app)) summary.reason = "app-mismatch";
      else {
        summary.decision = "approved";
        summary.reason = "app-match";
        // McpServerElicitationRequestResponse: accept without persistence metadata,
        // so the runtime records nothing beyond this request.
        return { reply: { id: message.id, result: { action: "accept" } }, summary };
      }
      return { reply, summary };
    }
    // Fixed field-name allowlist for a future denied probe. Never traverse a
    // page's requestedSchema, print arbitrary keys, or retain metadata values.
    const observed = ["threadId", "turnId", "serverName", "mode", "message", "requestedSchema", "url", "elicitationId", "_meta"];
    const metadata = ["codex_approval_kind", "codex_sensitive_action", "codex_request_type", "connector_id", "connector_name", "persist", "tool_name", "tool_title", "tool_params", "tool_params_display", "origin"];
    const type = value => value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    summary.fields = observed.filter(key => object(p) && Object.hasOwn(p, key)).map(key => `${key}:${type(p[key])}`);
    for (const key of metadata) {
      if (object(p?._meta) && Object.hasOwn(p._meta, key)) summary.fields.push(`_meta.${key}:${type(p._meta[key])}`);
    }
    if (object(p?._meta?.tool_params) && Object.hasOwn(p._meta.tool_params, "origin")) summary.fields.push(`_meta.tool_params.origin:${type(p._meta.tool_params.origin)}`);
    // Observation only: the schema's _meta is opaque. An origin-shaped value
    // may be safely summarized, but cannot authorize the elicitation.
    try { summary.origin = normalizeBrowserOrigin(p?._meta?.origin); } catch { /* no valid origin */ }
  }
  // Schema evidence: ServerRequest /oneOf/0 and /definitions/NetworkApprovalContext.
  // General permissions have only network.enabled; opaque elicitation _meta has
  // no schema-defined origin. Neither is authority for an origin-scoped grant.
  if (message.method !== "item/commandExecution/requestApproval") return { reply, summary };
  summary.kind = "command-approval";
  summary.reason = "malformed-request";
  if (!(Number.isSafeInteger(message.id) || typeof message.id === "string") ||
      !only(p, ["approvalId", "command", "commandActions", "cwd", "environmentId", "itemId", "kind", "networkApprovalContext", "proposedExecpolicyAmendment", "proposedNetworkPolicyAmendments", "reason", "startedAtMs", "threadId", "turnId"]) ||
      !["itemId", "threadId", "turnId"].every(k => typeof p[k] === "string" && p[k].length > 0) ||
      !Number.isSafeInteger(p.startedAtMs) ||
      (p.approvalId != null && typeof p.approvalId !== "string") ||
      (p.reason != null && typeof p.reason !== "string") ||
      !only(p.networkApprovalContext, ["host", "protocol"]) ||
      typeof p.networkApprovalContext.host !== "string" ||
      !["http", "https"].includes(p.networkApprovalContext.protocol)) return { reply, summary };
  let origin;
  try { origin = normalizeBrowserOrigin(`${p.networkApprovalContext.protocol}://${p.networkApprovalContext.host}`); }
  catch { return { reply, summary }; }
  summary.kind = "network-egress";
  summary.origin = origin;
  // Never approve a command/stdin, working directory or broader policy grant
  // merely because it also mentions an allowed network destination.
  if (p.command != null || p.cwd != null || p.environmentId != null ||
      (p.kind !== undefined && p.kind !== "command") || !empty(p.commandActions) ||
      !empty(p.proposedExecpolicyAmendment) || !empty(p.proposedNetworkPolicyAmendments)) {
    summary.reason = "not-network-only";
    return { reply, summary };
  }
  if (!threadId || !turnId || p.threadId !== threadId || p.turnId !== turnId) {
    summary.reason = "turn-mismatch";
    return { reply, summary };
  }
  const origins = normalizeBrowserOrigins(approvedBrowserOrigins);
  if (!origins.length) summary.reason = "no-flag";
  else if (!origins.includes(origin)) summary.reason = "origin-mismatch";
  else {
    summary.decision = "approved";
    summary.reason = "origin-match";
    // CommandExecutionRequestApprovalResponse /properties/decision:
    // accept is request-scoped, unlike acceptForSession/policy amendments.
    return { reply: { id: message.id, result: { decision: "accept" } }, summary };
  }
  return { reply, summary };
}

export function logServerRequest(summary, logger) {
  if (logger) logger(summary);
  else process.stderr.write(`Server request ${JSON.stringify(summary)}\n`);
}

// A broker carries requests to the owning task client, which owns the policy
// and job log. Reply IDs are private to this direction; other sockets cannot
// answer them. Disconnects fail closed, without retaining an origin grant.
export class ServerRequestRelay {
  constructor({ send, respond, log }) {
    this.send = send; this.respond = respond; this.log = log;
    this.pending = new Map(); this.nextId = 1;
    this.actions = new Map();
  }
  request(message, owner, { trackActions = false } = {}) {
    const tracked = trackActions && isActionApproval(message);
    const previous = tracked && this.actions.get(message.id);
    if (previous && (this.pending.has(previous.id) || previous.threadId === message.params?.threadId && previous.turnId === message.params?.turnId)) return;
    if (!owner || owner.destroyed) {
      const { reply, summary } = decideServerRequest(message);
      this.log({ ...summary, reason: "no-active-job" });
      this.respond(reply);
      return;
    }
    const id = `broker-server-${this.nextId++}`;
    this.pending.set(id, { message, owner });
    if (tracked) this.actions.set(message.id, { id, owner, threadId: message.params?.threadId, turnId: message.params?.turnId });
    this.send(owner, { ...message, id });
  }
  resolved(message) {
    const tracked = this.actions.get(message.params?.requestId);
    if (!tracked || tracked.threadId !== message.params?.threadId) return false;
    if (this.pending.delete(tracked.id)) this.send(tracked.owner, { ...message, params: { ...message.params, requestId: tracked.id } });
    return true;
  }
  response(message, owner) {
    if (message.method !== undefined || !this.pending.has(message.id)) return false;
    const pending = this.pending.get(message.id);
    if (pending.owner !== owner) return true;
    this.pending.delete(message.id);
    if (isActionApproval(pending.message) && object(message.result) && Object.keys(message.result).length === 1 && ["accept", "decline"].includes(message.result.decision)) {
      this.respond({ id: pending.message.id, result: { decision: message.result.decision } });
    } else if (pending.message.method === "mcpServer/elicitation/request" && object(message.result) && Object.keys(message.result).length === 1 && message.result.action === "accept" && computerUseElicitation(pending.message.params)) {
      this.respond({ id: pending.message.id, result: { action: "accept" } });
    } else if (pending.message.method === "item/tool/call" && pending.message.params?.tool === "ask_parent" &&
        object(message.result) && typeof message.result.success === "boolean" && Array.isArray(message.result.contentItems) &&
        message.result.contentItems.length === 1 && message.result.contentItems[0]?.type === "inputText" &&
        typeof message.result.contentItems[0].text === "string" && message.result.contentItems[0].text.length <= 8000) {
      this.respond({ id: pending.message.id, result: { success: message.result.success, contentItems: [{ type: "inputText", text: message.result.contentItems[0].text }] } });
    } else this.respond(unsupportedServerRequest(pending.message));
    return true;
  }
  disconnect(owner) {
    for (const [id, pending] of this.pending) {
      if (pending.owner !== owner) continue;
      this.pending.delete(id);
      this.respond(unsupportedServerRequest(pending.message));
      const { summary } = decideServerRequest(pending.message);
      this.log({ ...summary, reason: "job-disconnected" });
    }
    for (const [id, tracked] of this.actions) if (tracked.owner === owner) this.actions.delete(id);
  }
}
