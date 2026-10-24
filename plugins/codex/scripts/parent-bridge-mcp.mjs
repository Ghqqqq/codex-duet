#!/usr/bin/env node
// Minimal stdio MCP server for fresh and resumed Codex threads. Codex starts it
// before thread/start returns, so a fresh bridge captures its thread from the
// starting job once the companion records it, and retains that binding. Loaded
// threads keep their bridges across runs; each call finds the turn's owner
// across workspaces.
import path from "node:path";
import process from "node:process";
import { createJsonLineReader } from "./lib/app-server.mjs";
import { ACTIVE, ASK_PARENT, PARENT_BRIDGE_ENV, recordedThreadJobs, askParentQuestion } from "./lib/job-runtime.mjs";
import { readJobFile, resolveJobFile } from "./lib/state.mjs";

const cwd = process.env[PARENT_BRIDGE_ENV.cwd], envThread = process.env[PARENT_BRIDGE_ENV.threadId], envJob = process.env[PARENT_BRIDGE_ENV.jobId];
const validThread = id => typeof id === "string" && /^[A-Za-z0-9._-]{1,120}$/.test(id);
// Match the job filename alphabet used by retention, with a bounded length.
const validJob = id => typeof id === "string" && /^[A-Za-z0-9_-]{1,120}$/.test(id);
if (!cwd || !path.isAbsolute(cwd) || (envThread !== undefined) === (envJob !== undefined) ||
    (envThread !== undefined ? !validThread(envThread) : !validJob(envJob))) {
  process.stderr.write("parent-bridge-mcp: missing or invalid thread/job handle environment.\n");
  process.exit(2);
}
let resolvedThread = envThread ?? null;
const boundThread = () => {
  if (resolvedThread) return resolvedThread;
  try {
    const threadId = readJobFile(resolveJobFile(cwd, envJob))?.threadId;
    return validThread(threadId) ? (resolvedThread = threadId) : null;
  } catch { return null; }
};
// Capture a fresh thread's binding as soon as the companion records it, not at
// the first question: a loaded thread can serve many later jobs, and pruning can
// remove the starting record before any of them asks.
const BINDING_CAPTURE_MS = 5 * 60_000, BINDING_CAPTURE_POLL_MS = 250;
if (!resolvedThread) {
  const capturing = Date.now();
  const capture = setInterval(() => {
    if (boundThread() || Date.now() - capturing > BINDING_CAPTURE_MS) clearInterval(capture);
  }, BINDING_CAPTURE_POLL_MS);
  capture.unref();
}

const TURN_RECORD_WAIT_MS = 3000;
const TURN_RECORD_POLL_MS = 100;
const validTurn = id => typeof id === "string" && /^[A-Za-z0-9._-]{1,120}$/.test(id);
async function jobForTurn(threadId, turnId) {
  const deadline = Date.now() + (turnId ? TURN_RECORD_WAIT_MS : 0);
  while (true) {
    const inventory = recordedThreadJobs(threadId);
    const candidates = inventory.jobs.filter(job => ACTIVE.has(job.status) &&
      typeof job.workspaceRoot === "string" && path.isAbsolute(job.workspaceRoot) &&
      validTurn(job.turnId) && (!turnId || job.turnId === turnId));
    // Turn IDs are unique, and queued reservations have none, so one readable
    // match is the owner. An unrelated unreadable workspace (inventory.complete
    // false, e.g. a crash leftover) must not disable every parent question.
    if (candidates.length === 1) return candidates[0];
    // Missing metadata cannot justify guessing among owners. With an exact turn,
    // allow its accepted handle (or a concurrent index update) to be published.
    if (!turnId || candidates.length > 1 || Date.now() >= deadline ||
        inventory.jobs.some(job => job.turnId === turnId)) return null;
    await new Promise(resolve => setTimeout(resolve, TURN_RECORD_POLL_MS));
  }
}

const send = message => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const result = text => ({ content: [{ type: "text", text }], isError: false });
// readOnlyHint matters: Codex treats un-annotated MCP tools as needing approval,
// which the worker's "never" approval policy would turn into a failed call.
const TOOL = { name: ASK_PARENT.name, description: ASK_PARENT.description, inputSchema: ASK_PARENT.inputSchema,
  annotations: { title: "Ask parent", readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false } };
const valid = args => args && typeof args === "object" && typeof args.question === "string" && args.question.trim().length > 0 && args.question.length <= 1000 &&
  Object.keys(args).every(k => ["question", "options"].includes(k)) &&
  (args.options === undefined || (Array.isArray(args.options) && args.options.length <= 6 && args.options.every(o => typeof o === "string" && o.length <= 160)));

process.stdin.setEncoding("utf8");
process.stdin.on("data", createJsonLineReader(async line => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (!message || typeof message !== "object" || Array.isArray(message)) return;
  boundThread();
  if (message.id === undefined) return; // notifications need no reply
  try {
    switch (message.method) {
      case "initialize":
        send({ id: message.id, result: { protocolVersion: message.params?.protocolVersion ?? "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "duet-parent-bridge", version: "1" } } });
        break;
      case "ping":
        send({ id: message.id, result: {} });
        break;
      case "tools/list":
        send({ id: message.id, result: { tools: [TOOL] } });
        break;
      case "tools/call": {
        const { name, arguments: args, _meta } = message.params ?? {};
        if (name !== TOOL.name) { send({ id: message.id, error: { code: -32602, message: "Unknown tool" } }); break; }
        if (!valid(args)) { send({ id: message.id, result: { ...result("Invalid ask_parent arguments: question (<=1000 chars) and up to 6 options (<=160 chars) are accepted."), isError: true } }); break; }
        const threadId = boundThread();
        const turnId = _meta?.["x-codex-turn-metadata"]?.turn_id;
        const job = threadId && !(typeof _meta?.threadId === "string" && _meta.threadId !== threadId)
          ? await jobForTurn(threadId, validTurn(turnId) ? turnId : null) : null;
        if (!job) { send({ id: message.id, result: { ...result("No Duet task is listening on this thread right now. Proceed on a conservative assumption within the authorized scope and report it."), isError: true } }); break; }
        const callId = typeof _meta?.callId === "string" && /^[A-Za-z0-9_-]{1,120}$/.test(_meta.callId) ? _meta.callId : null;
        const { text } = await askParentQuestion(job.workspaceRoot, job.id, { question: args.question, options: args.options ?? [], callId });
        send({ id: message.id, result: result(text) });
        break;
      }
      default:
        send({ id: message.id, error: { code: -32601, message: "Method not found" } });
    }
  } catch (error) {
    send({ id: message.id, result: { ...result(`Parent question unavailable (${error instanceof Error ? error.message : String(error)}). Proceed conservatively and report missing essential input.`), isError: true } });
  }
}));
process.stdin.on("end", () => process.exit(0));
process.stdout.on("error", () => process.exit(0));
