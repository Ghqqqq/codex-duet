#!/usr/bin/env node
// Minimal stdio MCP server that gives a *resumed* Codex thread the same
// `ask_parent` tool new threads get as a dynamic tool. Codex spawns one bridge
// per thread from the per-thread `mcp_servers` config override and keeps it for
// as long as the thread stays loaded, so the bridge knows only the thread (env)
// and binds each call to whichever Duet job is active on that thread right now.
import process from "node:process";
import readline from "node:readline";
import { ASK_PARENT, PARENT_BRIDGE_ENV, activeJobForThread, askParentQuestion } from "./lib/job-runtime.mjs";

const cwd = process.env[PARENT_BRIDGE_ENV.cwd], threadId = process.env[PARENT_BRIDGE_ENV.threadId];
if (!cwd || !threadId || !/^[A-Za-z0-9._-]{1,120}$/.test(threadId)) {
  process.stderr.write("parent-bridge-mcp: missing or invalid thread handle environment.\n");
  process.exit(2);
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

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", async line => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch { return; }
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
        const { name, arguments: args } = message.params ?? {};
        if (name !== TOOL.name) { send({ id: message.id, error: { code: -32602, message: "Unknown tool" } }); break; }
        if (!valid(args)) { send({ id: message.id, result: { ...result("Invalid ask_parent arguments: question (<=1000 chars) and up to 6 options (<=160 chars) are accepted."), isError: true } }); break; }
        const jobId = activeJobForThread(cwd, threadId);
        if (!jobId) { send({ id: message.id, result: { ...result("No Duet task is listening on this thread right now. Proceed on a conservative assumption within the authorized scope and report it."), isError: true } }); break; }
        const { text } = await askParentQuestion(cwd, jobId, { question: args.question, options: args.options ?? [] });
        send({ id: message.id, result: result(text) });
        break;
      }
      default:
        send({ id: message.id, error: { code: -32601, message: "Method not found" } });
    }
  } catch (error) {
    send({ id: message.id, result: { ...result(`Parent question unavailable (${error instanceof Error ? error.message : String(error)}). Proceed conservatively and report missing essential input.`), isError: true } });
  }
});
rl.on("close", () => process.exit(0));
process.stdout.on("error", () => process.exit(0));
