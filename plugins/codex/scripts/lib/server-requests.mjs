import { createHash } from "node:crypto";

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

export function unsupportedServerRequest(message) {
  // browser-service oee persists accept/decline only; cancel avoids a stale deny.
  if (message.method === "mcpServer/elicitation/request") return { id: message.id, result: { action: "cancel" } };
  return { id: message.id, error: { code: -32601, message: methods.has(message.method) ? `Unsupported server request: ${message.method}` : "Unsupported server request" } };
}

export function decideServerRequest(message, { approvedBrowserOrigins = [], threadId = null, turnId = null } = {}) {
  const method = methods.has(message.method) ? message.method : `unrecognized:${hash(message.method)}`;
  /** @type {{ method: string, requestId: string | number, kind: string, decision: string, reason: string, origin?: string, fields?: string[] }} */
  const summary = {
    method,
    requestId: Number.isSafeInteger(message.id) ? message.id : `sha256:${hash(message.id)}`,
    kind: "unsupported", decision: "unsupported", reason: "unsupported-method"
  };
  const reply = unsupportedServerRequest(message);
  const p = message.params;
  if (message.method === "mcpServer/elicitation/request") {
    summary.decision = "cancelled";
    summary.reason = "unsupported-elicitation-nonpersistent";
    if (["form", "openai/form", "openaiForm", "url"].includes(p?.mode)) summary.kind = `elicitation-${p.mode}`;
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
  }
  request(message, owner) {
    if (!owner || owner.destroyed) {
      const { reply, summary } = decideServerRequest(message);
      this.log({ ...summary, reason: "no-active-job" });
      this.respond(reply);
      return;
    }
    const id = `broker-server-${this.nextId++}`;
    this.pending.set(id, { message, owner });
    this.send(owner, { ...message, id });
  }
  response(message, owner) {
    if (message.method !== undefined || !this.pending.has(message.id)) return false;
    const pending = this.pending.get(message.id);
    if (pending.owner !== owner) return true;
    this.pending.delete(message.id);
    if (pending.message.method === "item/commandExecution/requestApproval" && object(message.result) && Object.keys(message.result).length === 1 && message.result.decision === "accept") {
      this.respond({ id: pending.message.id, result: { decision: "accept" } });
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
  }
}
