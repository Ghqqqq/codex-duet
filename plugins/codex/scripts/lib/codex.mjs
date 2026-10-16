import { itemActivity, planActivity } from "./activity.mjs";
/**
 * @typedef {import("./app-server-protocol").AppServerNotification} AppServerNotification
 * @typedef {import("./app-server-protocol").ReviewTarget} ReviewTarget
 * @typedef {import("./app-server-protocol").ThreadItem} ThreadItem
 * @typedef {import("./app-server-protocol").ThreadResumeParams} ThreadResumeParams
 * @typedef {import("./app-server-protocol").ThreadStartParams} ThreadStartParams
 * @typedef {import("./app-server-protocol").Turn} Turn
 * @typedef {import("./app-server-protocol").UserInput} UserInput
 * @typedef {((update: string | { message: string, phase: string | null, threadId?: string | null, turnId?: string | null, stderrMessage?: string | null, logTitle?: string | null, logBody?: string | null }) => void)} ProgressReporter
 * @typedef {{
 *   threadId: string,
 *   rootThreadId: string,
 *   threadIds: Set<string>,
 *   threadTurnIds: Map<string, string>,
 *   threadLabels: Map<string, string>,
 *   turnId: string | null,
 *   bufferedNotifications: AppServerNotification[],
 *   completion: Promise<TurnCaptureState>,
 *   resolveCompletion: (state: TurnCaptureState) => void,
 *   rejectCompletion: (error: unknown) => void,
 *   finalTurn: Turn | null,
 *   completed: boolean,
 *   turnEndedObserved: boolean,
 *   finalAnswerSeen: boolean,
 *   pendingCollaborations: Set<string>,
 *   activeSubagentTurns: Set<string>,
 *   completionTimer: ReturnType<typeof setTimeout> | null,
 *   lastAgentMessage: string,
 *   reviewText: string,
 *   reasoningSummary: string[],
 *   error: unknown,
 *   messages: Array<{ lifecycle: string, phase: string | null, text: string }>,
 *   fileChanges: ThreadItem[],
 *   commandExecutions: ThreadItem[],
 *   safeProgress: boolean,
 *   onProgress: ProgressReporter | null
 * }} TurnCaptureState
 */
import { ASK_PARENT, PARENT_BRIDGE_ENV, PARENT_BRIDGE_SERVER, safeItem } from "./job-runtime.mjs";
import crypto from "node:crypto";
import fs from "node:fs";
import { resolveIsolatedCodexHome, resolveCodexBinary, isolatedCodexEnv } from "./codex-home.mjs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { readJsonFile } from "./fs.mjs";
import { BROKER_BUSY_RPC_CODE, BROKER_ENDPOINT_ENV, CodexAppServerClient } from "./app-server.mjs";
import { loadBrokerSession } from "./broker-lifecycle.mjs";
import { binaryAvailable } from "./process.mjs";
import { classifyRuntimeError } from "./runtime-errors.mjs";

const SERVICE_NAME = "claude_code_codex_plugin";
const TASK_THREAD_PREFIX = "Codex Companion Task";
const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current thread state. Pick the next highest-value step and follow through until the task is resolved.";
const EXTERNAL_AGENT_IMPORT_COMPLETED = "externalAgentConfig/import/completed";
const EXTERNAL_AGENT_IMPORT_TIMEOUT_MS = 2 * 60 * 1000;

function cleanCodexStderr(stderr) {
  return stderr
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line && !line.startsWith("WARNING: proceeding, even though we could not update PATH:"))
    .join("\n");
}

/** @returns {ThreadStartParams} */
function buildThreadParams(cwd, options = {}) {
  return {
    cwd,
    model: options.model ?? null,
    approvalPolicy: options.approvalPolicy ?? "never",
    sandbox: options.sandbox ?? "read-only",
    serviceName: SERVICE_NAME,
    ...(options.parentQuestions ? { dynamicTools: [ASK_PARENT] } : {}),
    ephemeral: options.ephemeral ?? true
  };
}

// thread/resume accepts no dynamicTools, so a resumed thread gets ask_parent from
// a per-thread MCP server override instead: Codex spawns this plugin's stdio bridge,
// which blocks on the same job-file question flow the in-process tool uses. Only
// the thread handle and state-location variables are passed; nothing else leaks.
// `omit_tools_from` keeps the tool out of Codex's deferred/code-mode tool sets:
// verified live that without it the server starts and `mcpServerStatus/list`
// shows the tool, yet the model never sees `mcp__duet_parent.ask_parent`.
export function parentBridgeConfig(bridge) {
  const env = { [PARENT_BRIDGE_ENV.cwd]: bridge.cwd, [PARENT_BRIDGE_ENV.threadId]: bridge.threadId };
  for (const key of ["CLAUDE_PLUGIN_DATA", "TMPDIR"]) if (process.env[key]) env[key] = process.env[key];
  return { mcp_servers: { [PARENT_BRIDGE_SERVER]: {
    command: process.execPath, args: [fileURLToPath(new URL("../parent-bridge-mcp.mjs", import.meta.url))], env,
    enabled: true, enabled_tools: ["ask_parent"], omit_tools_from: ["code_mode", "deferred"],
    // Workers run with approvalPolicy "never"; without this (and the tool's
    // readOnlyHint) Codex rejects the call as "requires approval".
    tools: { ask_parent: { approval_mode: "approve" } },
    startup_timeout_sec: 30, tool_timeout_sec: Math.min(86400, (bridge.questionTimeoutSec ?? 900) + 120)
  } } };
}

/** @returns {ThreadResumeParams} */
function buildResumeParams(threadId, cwd, options = {}) {
  return {
    threadId,
    cwd,
    model: options.model ?? null,
    approvalPolicy: options.approvalPolicy ?? "never",
    sandbox: options.sandbox ?? "read-only",
    ...(options.parentBridge ? { config: parentBridgeConfig({ ...options.parentBridge, threadId }) } : {})
  };
}

/** @returns {UserInput[]} */
function buildTurnInput(prompt) {
  return [{ type: "text", text: prompt, text_elements: [] }];
}

function shorten(text, limit = 72) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function looksLikeVerificationCommand(command) {
  return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i.test(
    command
  );
}

function buildTaskThreadName(prompt) {
  const excerpt = shorten(prompt, 56);
  return excerpt ? `${TASK_THREAD_PREFIX}: ${excerpt}` : TASK_THREAD_PREFIX;
}

function extractThreadId(message) {
  return message?.params?.threadId ?? null;
}

function extractTurnId(message) {
  if (message?.params?.turnId) {
    return message.params.turnId;
  }
  if (message?.params?.turn?.id) {
    return message.params.turn.id;
  }
  return null;
}

function collectTouchedFiles(fileChanges) {
  const paths = new Set();
  for (const fileChange of fileChanges) {
    for (const change of fileChange.changes ?? []) {
      if (change.path) {
        paths.add(change.path);
      }
    }
  }
  return [...paths];
}

function normalizeReasoningText(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function extractReasoningSections(value) {
  if (!value) {
    return [];
  }

  if (typeof value === "string") {
    const normalized = normalizeReasoningText(value);
    return normalized ? [normalized] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => extractReasoningSections(entry));
  }

  if (typeof value === "object") {
    if (typeof value.text === "string") {
      return extractReasoningSections(value.text);
    }
    if ("summary" in value) {
      return extractReasoningSections(value.summary);
    }
    if ("content" in value) {
      return extractReasoningSections(value.content);
    }
    if ("parts" in value) {
      return extractReasoningSections(value.parts);
    }
  }

  return [];
}

function mergeReasoningSections(existingSections, nextSections) {
  const merged = [];
  for (const section of [...existingSections, ...nextSections]) {
    const normalized = normalizeReasoningText(section);
    if (!normalized || merged.includes(normalized)) {
      continue;
    }
    merged.push(normalized);
  }
  return merged;
}

/**
 * @param {ProgressReporter | null | undefined} onProgress
 * @param {string | null | undefined} message
 * @param {string | null | undefined} [phase]
 */
function emitProgress(onProgress, message, phase = null, extra = {}) {
  if (!onProgress || !message) {
    return;
  }
  if (!phase && Object.keys(extra).length === 0) {
    onProgress(message);
    return;
  }
  onProgress({ message, phase, ...extra });
}

function emitLogEvent(onProgress, options = {}) {
  if (!onProgress) {
    return;
  }

  onProgress({
    message: options.message ?? "",
    phase: options.phase ?? null,
    stderrMessage: options.stderrMessage ?? null,
    logTitle: options.logTitle ?? null,
    logBody: options.logBody ?? null
  });
}

function labelForThread(state, threadId) {
  if (!threadId || threadId === state.rootThreadId || threadId === state.threadId) {
    return null;
  }
  return state.threadLabels.get(threadId) ?? threadId;
}

function registerThread(state, threadId, options = {}) {
  if (!threadId) {
    return;
  }

  state.threadIds.add(threadId);
  const label =
    options.threadName ??
    options.name ??
    options.agentNickname ??
    options.agentRole ??
    state.threadLabels.get(threadId) ??
    null;
  if (label) {
    state.threadLabels.set(threadId, label);
  }
}

function describeStartedItem(state, item) {
  switch (item.type) {
    case "enteredReviewMode":
      return { message: `Reviewer started: ${item.review}`, phase: "reviewing" };
    case "commandExecution":
      return {
        message: `Running command: ${shorten(item.command, 96)}`,
        phase: looksLikeVerificationCommand(item.command) ? "verifying" : "running"
      };
    case "fileChange":
      return { message: `Applying ${item.changes.length} file change(s).`, phase: "editing" };
    case "mcpToolCall":
      return { message: `Calling ${item.server}/${item.tool}.`, phase: "investigating" };
    case "dynamicToolCall":
      return { message: `Running tool: ${item.tool}.`, phase: "investigating" };
    case "collabAgentToolCall": {
      const subagents = (item.receiverThreadIds ?? []).map((threadId) => labelForThread(state, threadId) ?? threadId);
      const summary =
        subagents.length > 0
          ? `Starting subagent ${subagents.join(", ")} via collaboration tool: ${item.tool}.`
          : `Starting collaboration tool: ${item.tool}.`;
      return { message: summary, phase: "investigating" };
    }
    case "webSearch":
      return { message: `Searching: ${shorten(item.query, 96)}`, phase: "investigating" };
    default:
      return null;
  }
}

function describeCompletedItem(state, item) {
  switch (item.type) {
    case "commandExecution": {
      const exitCode = item.exitCode ?? "?";
      const statusLabel = item.status === "completed" ? "completed" : item.status;
      return {
        message: `Command ${statusLabel}: ${shorten(item.command, 96)} (exit ${exitCode})`,
        phase: looksLikeVerificationCommand(item.command) ? "verifying" : "running"
      };
    }
    case "fileChange":
      return { message: `File changes ${item.status}.`, phase: "editing" };
    case "mcpToolCall":
      return { message: `Tool ${item.server}/${item.tool} ${item.status}.`, phase: "investigating" };
    case "dynamicToolCall":
      return { message: `Tool ${item.tool} ${item.status}.`, phase: "investigating" };
    case "collabAgentToolCall": {
      const subagents = (item.receiverThreadIds ?? []).map((threadId) => labelForThread(state, threadId) ?? threadId);
      const summary =
        subagents.length > 0
          ? `Subagent ${subagents.join(", ")} ${item.status}.`
          : `Collaboration tool ${item.tool} ${item.status}.`;
      return { message: summary, phase: "investigating" };
    }
    case "exitedReviewMode":
      return { message: "Reviewer finished.", phase: "finalizing" };
    default:
      return null;
  }
}

/** @returns {TurnCaptureState} */
function createTurnCaptureState(threadId, options = {}) {
  let resolveCompletion;
  let rejectCompletion;
  const completion = new Promise((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });

  return {
    threadId,
    rootThreadId: threadId,
    threadIds: new Set([threadId]),
    threadTurnIds: new Map(),
    threadLabels: new Map(),
    turnId: null,
    bufferedNotifications: [],
    completion,
    resolveCompletion,
    rejectCompletion,
    finalTurn: null,
    completed: false,
    turnEndedObserved: false,
    finalAnswerSeen: false,
    pendingCollaborations: new Set(),
    activeSubagentTurns: new Set(),
    completionTimer: null,
    lastAgentMessage: "",
    reviewText: "",
    reasoningSummary: [],
    error: null,
    messages: [],
    fileChanges: [],
    commandExecutions: [],
    activityStarts: new Map(),
    onProgress: options.onProgress ?? null,
    safeProgress: Boolean(options.safeProgress)
  };
}

function clearCompletionTimer(state) {
  if (state.completionTimer) {
    clearTimeout(state.completionTimer);
    state.completionTimer = null;
  }
}

function completeTurn(state, turn = null, options = {}) {
  if (state.completed) {
    return;
  }

  clearCompletionTimer(state);
  state.completed = true;

  if (turn) {
    state.finalTurn = turn;
    state.turnEndedObserved = turn.status !== "inProgress";
    if (!state.turnId) {
      state.turnId = turn.id;
    }
  } else if (!state.finalTurn) {
    state.finalTurn = {
      id: state.turnId ?? "inferred-turn",
      status: "completed"
    };
  }

  if (options.inferred) {
    emitProgress(state.onProgress, "Turn completion inferred after the main thread finished and subagent work drained.", "finalizing");
  }

  state.resolveCompletion(state);
}

function scheduleInferredCompletion(state) {
  if (state.completed || state.finalTurn || !state.finalAnswerSeen) {
    return;
  }

  if (state.pendingCollaborations.size > 0 || state.activeSubagentTurns.size > 0) {
    return;
  }

  clearCompletionTimer(state);
  state.completionTimer = setTimeout(() => {
    state.completionTimer = null;
    if (state.completed || state.finalTurn || !state.finalAnswerSeen) {
      return;
    }
    if (state.pendingCollaborations.size > 0 || state.activeSubagentTurns.size > 0) {
      return;
    }
    completeTurn(state, null, { inferred: true });
  }, 250);
  state.completionTimer.unref?.();
}

function belongsToTurn(state, message) {
  const messageThreadId = extractThreadId(message);
  if (!messageThreadId || !state.threadIds.has(messageThreadId)) {
    return false;
  }
  const trackedTurnId = state.threadTurnIds.get(messageThreadId) ?? null;
  const messageTurnId = extractTurnId(message);
  return trackedTurnId === null || messageTurnId === null || messageTurnId === trackedTurnId;
}

function recordItem(state, item, lifecycle, threadId = null) {
  if (item.type === "collabAgentToolCall") {
    if (!threadId || threadId === state.threadId) {
      if (lifecycle === "started" || item.status === "inProgress") {
        state.pendingCollaborations.add(item.id);
      } else if (lifecycle === "completed") {
        state.pendingCollaborations.delete(item.id);
        scheduleInferredCompletion(state);
      }
    }
    for (const receiverThreadId of item.receiverThreadIds ?? []) {
      registerThread(state, receiverThreadId);
    }
  }

  if (item.type === "agentMessage") {
    state.messages.push({
      lifecycle,
      phase: item.phase ?? null,
      text: item.text ?? ""
    });
    if (item.text) {
      if (!threadId || threadId === state.threadId) {
        state.lastAgentMessage = item.text;
        if (lifecycle === "completed" && item.phase === "final_answer") {
          state.finalAnswerSeen = true;
          scheduleInferredCompletion(state);
        }
      }
      if (lifecycle === "completed" && !state.safeProgress) {
        const sourceLabel = labelForThread(state, threadId);
        emitLogEvent(state.onProgress, {
          message: sourceLabel ? `Subagent ${sourceLabel}: ${shorten(item.text, 96)}` : `Assistant message captured: ${shorten(item.text, 96)}`,
          stderrMessage: null,
          phase: item.phase === "final_answer" ? "finalizing" : null,
          logTitle: sourceLabel ? `Subagent ${sourceLabel} message` : "Assistant message",
          logBody: item.text
        });
      }
    }
    return;
  }

  if (item.type === "exitedReviewMode") {
    state.reviewText = item.review ?? "";
    if (lifecycle === "completed" && item.review) {
      emitLogEvent(state.onProgress, {
        message: "Review output captured.",
        stderrMessage: null,
        phase: "finalizing",
        logTitle: "Review output",
        logBody: item.review
      });
    }
    return;
  }

  if (item.type === "reasoning" && lifecycle === "completed") {
    const nextSections = extractReasoningSections(item.summary);
    state.reasoningSummary = mergeReasoningSections(state.reasoningSummary, nextSections);
    if (nextSections.length > 0 && !state.safeProgress) {
      const sourceLabel = labelForThread(state, threadId);
      emitLogEvent(state.onProgress, {
        message: sourceLabel
          ? `Subagent ${sourceLabel} reasoning: ${shorten(nextSections[0], 96)}`
          : `Reasoning summary captured: ${shorten(nextSections[0], 96)}`,
        stderrMessage: null,
        logTitle: sourceLabel ? `Subagent ${sourceLabel} reasoning summary` : "Reasoning summary",
        logBody: nextSections.map((section) => `- ${section}`).join("\n")
      });
    }
    return;
  }

  if (item.type === "fileChange" && lifecycle === "completed") {
    state.fileChanges.push(item);
    return;
  }

  if (item.type === "commandExecution" && lifecycle === "completed") {
    state.commandExecutions.push(item);
  }
}

function applyTurnNotification(state, message) {
  if (state.safeProgress && ["item/started", "item/completed"].includes(message.method)) {
    const lifecycle = message.method === "item/started" ? "started" : "completed";
    const item = message.params.item;
    const activity = itemActivity(item, lifecycle, state.activityStarts, `${message.params.threadId}:${item?.id}`);
    if (activity.length) emitProgress(state.onProgress, "Activity recorded.", null, { activity });
  }
  switch (message.method) {
    case "thread/started":
      registerThread(state, message.params.thread.id, {
        threadName: message.params.thread.name,
        name: message.params.thread.name,
        agentNickname: message.params.thread.agentNickname,
        agentRole: message.params.thread.agentRole
      });
      break;
    case "thread/name/updated":
      registerThread(state, message.params.threadId, {
        threadName: message.params.threadName ?? null
      });
      break;
    case "turn/started":
      registerThread(state, message.params.threadId);
      state.threadTurnIds.set(message.params.threadId, message.params.turn.id);
      if ((message.params.threadId ?? null) !== state.threadId) {
        state.activeSubagentTurns.add(message.params.threadId);
      }
      emitProgress(
        state.onProgress,
        `Turn started (${message.params.turn.id}).`,
        "starting",
        (message.params.threadId ?? null) === state.threadId
          ? {
              threadId: message.params.threadId ?? null,
              turnId: message.params.turn.id ?? null
            }
          : {}
      );
      break;
    case "item/started":
      recordItem(state, message.params.item, "started", message.params.threadId ?? null);
      {
        const item = safeItem(message.params.item, "started");
        const update = state.safeProgress ? item && { message: item.summary, phase: item.type === "fileChange" ? "editing" : item.summary.includes("tests") ? "verifying" : "running" } : describeStartedItem(state, message.params.item);
        emitProgress(state.onProgress, update?.message, update?.phase ?? null, item ? { item } : {});
      }
      break;
    case "item/completed":
      recordItem(state, message.params.item, "completed", message.params.threadId ?? null);
      {
        const item = safeItem(message.params.item, "completed");
        const update = state.safeProgress ? item && { message: `${item.summary} completed${item.exitCode !== undefined ? ` (exit ${item.exitCode})` : ""}.`, phase: "running" } : describeCompletedItem(state, message.params.item);
        emitProgress(state.onProgress, update?.message, update?.phase ?? null, item ? { item } : {});
      }
      break;
    case "turn/plan/updated":
      emitProgress(state.onProgress, "Plan updated.", "planning", { item: { type: "plan", summary: "plan updated", lifecycle: "completed", steps: (message.params.plan ?? []).length }, activity: planActivity(message.params.plan) });
      break;
    case "error":
      state.error = message.params.error;
      emitProgress(state.onProgress, state.safeProgress ? "Codex reported an error; inspect the final result." : `Codex error: ${message.params.error.message}`, "failed");
      break;
    case "turn/completed":
      if ((message.params.threadId ?? null) !== state.threadId) {
        state.activeSubagentTurns.delete(message.params.threadId);
        scheduleInferredCompletion(state);
        break;
      }
      emitProgress(
        state.onProgress,
        `Turn ${message.params.turn.status === "completed" ? "completed" : message.params.turn.status}.`,
        "finalizing"
      );
      completeTurn(state, message.params.turn);
      break;
    default:
      break;
  }
}

async function captureTurn(client, threadId, startRequest, options = {}) {
  const state = createTurnCaptureState(threadId, options);
  const previousHandler = client.notificationHandler;
  let lastActivity = Date.now(), itemCount = 0, toolCount = 0;
  const started = Date.now();
  const seenItems = new Set();
  let firstModel = false, firstTool = false;
  const trackActivity = message => {
    lastActivity = Date.now();
    const item = message.params?.item;
    if (item && !firstModel) { firstModel = true; options.onTiming?.("firstModelEvent"); }
    if (item && !["agentMessage", "userMessage", "reasoning", "plan"].includes(item.type) && !firstTool) { firstTool = true; options.onTiming?.("firstToolCall"); }
    if (item && !seenItems.has(`${extractThreadId(message)}:${item.id}`)) {
      seenItems.add(`${extractThreadId(message)}:${item.id}`);
      itemCount++;
      if (!["agentMessage", "userMessage", "reasoning"].includes(item.type)) toolCount++;
    }
  };
  const heartbeat = setInterval(() => {
    emitProgress(options.onProgress,
      `Progress: thread=${threadId} turn=${state.turnId ?? "starting"}; ${itemCount} items, ${toolCount} tools; elapsed ${Math.floor((Date.now() - started) / 1000)}s; last activity ${Math.floor((Date.now() - lastActivity) / 1000)}s ago.`, null);
  }, Math.max(250, Number(process.env.CODEX_COMPANION_PROGRESS_INTERVAL_MS) || 15000));
  heartbeat.unref?.();

  client.setNotificationHandler((message) => {
    if (!state.turnId) {
      state.bufferedNotifications.push(message);
      return;
    }

    if (message.method === "thread/started" || message.method === "thread/name/updated") {
      applyTurnNotification(state, message);
      return;
    }

    if (!belongsToTurn(state, message)) {
        if (previousHandler) {
          previousHandler(message);
        }
        return;
    }
    trackActivity(message);
    applyTurnNotification(state, message);
  });

  let interruptTimer = null;
  const interrupt = () => {
    const turnId = state.turnId ?? client.serverRequestPolicy.turnId;
    if (turnId) void client.request("turn/interrupt", { threadId, turnId }).catch(() => {});
    if (!interruptTimer) interruptTimer = setTimeout(() => { void client.close(); }, 4000);
  };
  options.signal?.addEventListener("abort", interrupt);
  try {
    if (options.signal?.aborted) throw new Error("Task interrupted before turn start.");
    const turnBegan = Date.now();
    const response = await startRequest();
    options.onTiming?.("turnStart", Date.now() - turnBegan);
    options.onResponse?.(response, state);
    state.turnId = response.turn?.id ?? null;
    client.setServerRequestContext(threadId, state.turnId);
    if (state.turnId) {
      state.threadTurnIds.set(state.threadId, state.turnId);
      // The response can precede notifications (or they may be dropped).
      emitProgress(options.onProgress, `Turn handle: ${state.turnId}.`, "starting", { threadId: state.threadId, turnId: state.turnId });
    }
    if (options.signal?.aborted) interrupt();
    for (const message of state.bufferedNotifications) {
      if (belongsToTurn(state, message)) {
        trackActivity(message);
        applyTurnNotification(state, message);
      } else {
        if (previousHandler) {
          previousHandler(message);
        }
      }
    }
    state.bufferedNotifications.length = 0;

    if (response.turn?.status && response.turn.status !== "inProgress") {
      completeTurn(state, response.turn);
    }

    return await Promise.race([
      state.completion,
      client.exitPromise.then(() => { throw client.exitError ?? new Error("Codex connection closed before turn completion; recover the recorded job."); })
    ]);
  } finally {
    options.signal?.removeEventListener("abort", interrupt);
    clearTimeout(interruptTimer);
    clearInterval(heartbeat);
    clearCompletionTimer(state);
    client.setNotificationHandler(previousHandler ?? null);
    client.setServerRequestContext(null, null);
  }
}

async function withAppServer(cwd, fn, options = {}) {
  let client = null;
  try {
    client = await CodexAppServerClient.connect(cwd, options);
    const result = await fn(client);
    await client.close();
    return result;
  } catch (error) {
    const brokerRequested = client?.transport === "broker" || Boolean(process.env[BROKER_ENDPOINT_ENV]);
    const shouldRetryDirect =
      (client?.transport === "broker" && error?.rpcCode === BROKER_BUSY_RPC_CODE) ||
      (brokerRequested && (error?.code === "ENOENT" || error?.code === "ECONNREFUSED"));

    if (client) {
      await client.close().catch(() => {});
      client = null;
    }

    if (!shouldRetryDirect) {
      throw error;
    }

    const directClient = await CodexAppServerClient.connect(cwd, { ...options, disableBroker: true });
    try {
      return await fn(directClient);
    } finally {
      await directClient.close();
    }
  }
}

async function withDirectAppServer(cwd, fn) {
  const client = await CodexAppServerClient.connect(cwd, { disableBroker: true });
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

function resolveCodexHome() {
  return resolveIsolatedCodexHome();
}

function sourceContentSha256(sourcePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex");
}

function importedThreadIdForSource(sourcePath) {
  const ledgerPath = path.join(resolveCodexHome(), "external_agent_session_imports.json");
  if (!fs.existsSync(ledgerPath)) {
    return null;
  }
  const ledger = readJsonFile(ledgerPath);
  const canonicalSource = fs.realpathSync(sourcePath);
  const contentSha256 = sourceContentSha256(canonicalSource);
  const records = Array.isArray(ledger?.records) ? ledger.records : [];
  const match = records
    .filter(
      (record) =>
        record?.source_path === canonicalSource &&
        record?.content_sha256 === contentSha256 &&
        typeof record?.imported_thread_id === "string"
    )
    .at(-1);
  return match?.imported_thread_id ?? null;
}

function externalAgentSessionMigration(sourcePath, cwd) {
  return {
    migrationItems: [
      {
        itemType: "SESSIONS",
        description: `Transfer Claude session ${path.basename(sourcePath)}`,
        cwd: null,
        details: {
          plugins: [],
          sessions: [{ path: sourcePath, cwd, title: null }],
          mcpServers: [],
          hooks: [],
          subagents: [],
          commands: []
        }
      }
    ]
  };
}

async function requestExternalAgentSessionImport(client, params) {
  const previousHandler = client.notificationHandler;
  let timeout = null;
  let resolveCompleted;
  let rejectCompleted;
  const completed = new Promise((resolve, reject) => {
    resolveCompleted = resolve;
    rejectCompleted = reject;
  });
  void completed.catch(() => {});

  client.setNotificationHandler((message) => {
    if (message.method === EXTERNAL_AGENT_IMPORT_COMPLETED) {
      resolveCompleted();
      return;
    }
    previousHandler?.(message);
  });
  timeout = setTimeout(() => {
    rejectCompleted(new Error("Timed out waiting for Codex to finish importing the Claude session."));
  }, EXTERNAL_AGENT_IMPORT_TIMEOUT_MS);

  try {
    await client.request("externalAgentConfig/import", params);
    await completed;
  } finally {
    clearTimeout(timeout);
    client.setNotificationHandler(previousHandler ?? null);
  }
}

async function startThread(client, cwd, options = {}) {
  let response;
  try { response = await client.request("thread/start", buildThreadParams(cwd, options)); }
  catch (error) {
    if (!options.parentQuestions || !/dynamicTools|dynamic.tools|experimental/i.test(error.message) || ![-32600, -32601, -32602].includes(error.rpcCode)) throw error;
    emitProgress(options.onProgress, "Parent questions unavailable in this runtime; final needs_input fallback remains enabled.", "starting");
    response = await client.request("thread/start", buildThreadParams(cwd, { ...options, parentQuestions: false }));
  }
  const threadId = response.thread.id;
  emitProgress(options.onProgress, `Thread handle: ${threadId}.`, "starting", { threadId });
  if (options.threadName) {
    try {
      await client.request("thread/name/set", { threadId, name: options.threadName });
    } catch (err) {
      // Only suppress "unknown variant/method" errors from older CLI versions
      // that don't support thread/name/set. Rethrow auth, network, or server errors.
      const msg = String(err?.message ?? err ?? "");
      if (!msg.includes("unknown variant") && !msg.includes("unknown method")) {
        throw err;
      }
    }
  }
  return response;
}

async function resumeThread(client, threadId, cwd, options = {}) {
  try { return await client.request("thread/resume", buildResumeParams(threadId, cwd, options)); }
  catch (error) {
    if (!options.parentBridge || !/config|mcp_servers|unknown field|experimental/i.test(error.message) || ![-32600, -32601, -32602].includes(error.rpcCode)) throw error;
    emitProgress(options.onProgress, "Parent questions unavailable on this resumed thread; final needs_input fallback remains enabled.", "starting");
    return client.request("thread/resume", buildResumeParams(threadId, cwd, { ...options, parentBridge: null }));
  }
}

function buildResultStatus(turnState) {
  return turnState.finalTurn?.status === "completed" ? 0 : 1;
}

const BUILTIN_PROVIDER_LABELS = new Map([
  ["openai", "OpenAI"],
  ["ollama", "Ollama"],
  ["lmstudio", "LM Studio"]
]);

function normalizeProviderId(value) {
  const providerId = typeof value === "string" ? value.trim() : "";
  return providerId || null;
}

function formatProviderLabel(providerId, providerConfig = null) {
  const configuredName = typeof providerConfig?.name === "string" ? providerConfig.name.trim() : "";
  if (configuredName) {
    return configuredName;
  }
  if (!providerId) {
    return "The active provider";
  }
  return BUILTIN_PROVIDER_LABELS.get(providerId) ?? providerId;
}

function buildAuthStatus(fields = {}) {
  return {
    available: true,
    status: fields.loggedIn ? "authenticated" : "unauthenticated",
    reason: null,
    loggedIn: false,
    detail: "not authenticated",
    source: "unknown",
    authMethod: null,
    verified: null,
    requiresOpenaiAuth: null,
    provider: null,
    ...fields
  };
}

function resolveProviderConfig(configResponse) {
  const config = configResponse?.config;
  if (!config || typeof config !== "object") {
    return {
      providerId: null,
      providerConfig: null
    };
  }

  const providerId = normalizeProviderId(config.model_provider);
  const providers =
    config.model_providers && typeof config.model_providers === "object" && !Array.isArray(config.model_providers)
      ? config.model_providers
      : null;
  const providerConfig =
    providerId && providers?.[providerId] && typeof providers[providerId] === "object" ? providers[providerId] : null;

  return {
    providerId,
    providerConfig
  };
}

function buildAppServerAuthStatus(accountResponse, configResponse) {
  const account = accountResponse?.account ?? null;
  const requiresOpenaiAuth =
    typeof accountResponse?.requiresOpenaiAuth === "boolean" ? accountResponse.requiresOpenaiAuth : null;
  const { providerId, providerConfig } = resolveProviderConfig(configResponse);
  const providerLabel = formatProviderLabel(providerId, providerConfig);

  if (account?.type === "chatgpt") {
    const email = typeof account.email === "string" && account.email.trim() ? account.email.trim() : null;
    return buildAuthStatus({
      loggedIn: true,
      detail: email ? `ChatGPT login active for ${email}` : "ChatGPT login active",
      source: "app-server",
      authMethod: "chatgpt",
      verified: true,
      requiresOpenaiAuth,
      provider: providerId
    });
  }

  if (account?.type === "apiKey") {
    return buildAuthStatus({
      loggedIn: true,
      detail: "API key configured (unverified)",
      source: "app-server",
      authMethod: "apiKey",
      verified: false,
      requiresOpenaiAuth,
      provider: providerId
    });
  }

  if (requiresOpenaiAuth === false) {
    return buildAuthStatus({
      loggedIn: true,
      detail: `${providerLabel} is configured and does not require OpenAI authentication`,
      source: "app-server",
      requiresOpenaiAuth,
      provider: providerId
    });
  }

  return buildAuthStatus({
    loggedIn: false,
    status: requiresOpenaiAuth === true ? "unauthenticated" : "unknown",
    detail: requiresOpenaiAuth === true ? `${providerLabel} requires OpenAI authentication` : "The runtime did not establish an authentication state",
    source: "app-server",
    requiresOpenaiAuth,
    provider: providerId
  });
}

async function getCodexAuthStatusFromClient(client, cwd) {
  try {
    const accountResponse = await client.request("account/read", { refreshToken: false });
    const configResponse = await client.request("config/read", {
      includeLayers: false,
      cwd
    });

    return buildAppServerAuthStatus(accountResponse, configResponse);
  } catch (error) {
    return buildAuthStatus({
      loggedIn: false,
      ...classifyRuntimeError(error),
      source: "app-server"
    });
  }
}

export function getCodexAvailability(cwd) {
  const versionStatus = binaryAvailable(resolveCodexBinary(), ["--version"], { cwd, env: isolatedCodexEnv() });
  if (!versionStatus.available) {
    return versionStatus;
  }

  const appServerStatus = binaryAvailable(resolveCodexBinary(), ["app-server", "--help"], { cwd, env: isolatedCodexEnv() });
  if (!appServerStatus.available) {
    return {
      available: false,
      status: "unavailable",
      reason: "runtime-unavailable",
      detail: `${versionStatus.detail}; advanced runtime unavailable: ${appServerStatus.detail}`
    };
  }

  return {
    available: true,
    detail: `${versionStatus.detail}; advanced runtime available`
  };
}

export function getSessionRuntimeStatus(env = process.env, cwd = process.cwd()) {
  const endpoint = env?.[BROKER_ENDPOINT_ENV]?.trim() || loadBrokerSession(cwd)?.endpoint || null;
  if (endpoint) {
    return {
      mode: "shared",
      label: "shared session",
      detail: "This Claude session is configured to reuse one shared Codex runtime.",
      endpoint
    };
  }

  return {
    mode: "direct",
    label: "direct startup",
    detail: "No shared Codex runtime is active yet. The first review or task command will start one on demand.",
    endpoint: null
  };
}

export async function getCodexAuthStatus(cwd, options = {}) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    return {
      available: false,
      status: "unavailable",
      reason: "runtime-unavailable",
      loggedIn: false,
      detail: availability.detail,
      source: "availability",
      authMethod: null,
      verified: null,
      requiresOpenaiAuth: null,
      provider: null
    };
  }

  let client = null;
  try {
    client = await CodexAppServerClient.connect(cwd, {
      env: options.env,
      reuseExistingBroker: true
    });
    return await getCodexAuthStatusFromClient(client, cwd);
  } catch (error) {
    return buildAuthStatus({
      loggedIn: false,
      ...classifyRuntimeError(error),
      source: "app-server"
    });
  } finally {
    if (client) {
      await client.close().catch(() => {});
    }
  }
}

export async function interruptAppServerTurn(cwd, { threadId, turnId }) {
  if (!threadId || !turnId) {
    return {
      attempted: false,
      interrupted: false,
      transport: null,
      detail: "missing threadId or turnId"
    };
  }

  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    return {
      attempted: false,
      interrupted: false,
      transport: null,
      detail: availability.detail
    };
  }

  let client = null;
  try {
    client = await CodexAppServerClient.connect(cwd, { reuseExistingBroker: true });
    await client.request("turn/interrupt", { threadId, turnId });
    return {
      attempted: true,
      interrupted: true,
      transport: client.transport,
      detail: `Interrupted ${turnId} on ${threadId}.`
    };
  } catch (error) {
    return {
      attempted: true,
      interrupted: false,
      transport: client?.transport ?? null,
      detail: error instanceof Error ? error.message : String(error)
    };
  } finally {
    await client?.close().catch(() => {});
  }
}

export async function runAppServerReview(cwd, options = {}) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }

  return withAppServer(cwd, async (client) => {
    emitProgress(options.onProgress, "Starting Codex review thread.", "starting");
    const thread = await startThread(client, cwd, {
      model: options.model,
      sandbox: "read-only",
      ephemeral: true,
      threadName: options.threadName
    });
    const sourceThreadId = thread.thread.id;
    emitProgress(options.onProgress, `Thread ready (${sourceThreadId}).`, "starting", {
      threadId: sourceThreadId
    });
    const delivery = options.delivery ?? "inline";

    const turnState = await captureTurn(
      client,
      sourceThreadId,
      () =>
        client.request("review/start", {
          threadId: sourceThreadId,
          delivery,
          target: options.target
        }),
      {
        onProgress: options.onProgress,
        signal: options.signal,
        onResponse(response, state) {
          if (response.reviewThreadId) {
            state.threadIds.add(response.reviewThreadId);
            if (delivery === "detached") {
              state.threadId = response.reviewThreadId;
            }
          }
        }
      }
    );

    return {
      status: buildResultStatus(turnState),
      threadId: turnState.threadId,
      sourceThreadId,
      turnId: turnState.turnId,
      reviewText: turnState.reviewText,
      reasoningSummary: turnState.reasoningSummary,
      turn: turnState.finalTurn,
      turnEnded: Boolean(turnState.turnEndedObserved),
      error: turnState.error,
      stderr: cleanCodexStderr(client.stderr)
    };
  }, { signal: options.signal, onServerRequestLog: summary => emitProgress(options.onProgress, `Server request ${JSON.stringify(summary)}`, null) });
}

export async function importExternalAgentSession(cwd, options = {}) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }
  if (!options.sourcePath) {
    throw new Error("A Claude session source path is required.");
  }

  return withDirectAppServer(cwd, async (client) => {
    emitProgress(options.onProgress, "Importing Claude session into Codex.", "transferring");
    try {
      await requestExternalAgentSessionImport(client, externalAgentSessionMigration(options.sourcePath, cwd));
    } catch (error) {
      if (error?.rpcCode === -32601) {
        throw new Error(
          "This Codex version does not support Claude session transfer. Update Codex with `npm install -g @openai/codex@latest`, then retry.",
          { cause: error }
        );
      }
      throw error;
    }
    const threadId = importedThreadIdForSource(options.sourcePath);
    if (!threadId) {
      const stderr = cleanCodexStderr(client.stderr);
      throw new Error(
        `Codex reported that the Claude import completed, but did not record an imported thread.${stderr ? `\n${stderr}` : " Check the Codex app-server logs for the underlying import error."}`
      );
    }
    emitProgress(options.onProgress, `Claude session imported (${threadId}).`, "completed", { threadId });
    return {
      threadId,
      stderr: cleanCodexStderr(client.stderr)
    };
  });
}

export async function runAppServerTurn(cwd, options = {}) {
  const began = Date.now(), startupTimings = { mcpReady: null };
  let startupWarning = null;
  const onTiming = (phase, durationMs) => {
    const timing = { phase, elapsedMs: Date.now() - began, ...(durationMs === undefined ? {} : { durationMs }) };
    startupTimings[phase] = timing;
    emitProgress(options.onProgress, `Startup timing: ${phase} ${JSON.stringify(timing)}`, null, { timing });
  };
  const runtimeEvent = event => {
    if (event.timing) onTiming(event.timing.phase, event.timing.durationMs);
    if (event.startupTimings) for (const [phase, duration] of Object.entries(event.startupTimings)) {
      if (typeof duration === "number") onTiming(phase, duration);
    }
    if (event.mcpReady && !startupTimings.mcpReady) onTiming("mcpReady");
    if (event.startupWarning) {
      startupWarning = event.startupWarning;
      emitProgress(options.onProgress, startupWarning, null, { startupWarning });
    }
  };
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }

  return withAppServer(cwd, async (client) => {
    if (options.signal?.aborted) throw new Error("Task interrupted during startup.");
    let threadId;
    let threadPolicy;

    const threadBegan = Date.now();
    if (options.resumeThreadId) {
      emitProgress(options.onProgress, `Resuming thread ${options.resumeThreadId}.`, "starting");
      const response = await resumeThread(client, options.resumeThreadId, cwd, {
        model: options.model,
        sandbox: options.sandbox,
        ephemeral: false,
        onProgress: options.onProgress,
        parentBridge: options.onParentQuestion && options.parentBridge ? options.parentBridge : null
      });
      threadId = response.thread.id;
      threadPolicy = response.sandbox;
    } else {
      emitProgress(options.onProgress, "Starting Codex task thread.", "starting");
      const response = await startThread(client, cwd, {
        model: options.model,
        sandbox: options.sandbox,
        ephemeral: options.persistThread ? false : true,
        threadName: options.persistThread ? options.threadName : options.threadName ?? null,
        onProgress: options.onProgress,
        parentQuestions: Boolean(options.onParentQuestion)
      });
      threadId = response.thread.id;
      threadPolicy = response.sandbox;
    }

    onTiming(options.resumeThreadId ? "threadResume" : "threadStart", Date.now() - threadBegan);
    if (options.signal?.aborted) throw new Error("Task interrupted before turn start.");

    emitProgress(options.onProgress, `Thread ready (${threadId}).`, "starting", {
      threadId
    });

    const prompt = options.prompt?.trim() || options.defaultPrompt || "";
    if (!prompt) {
      throw new Error("A prompt is required for this Codex run.");
    }

    // SandboxPolicy comes from thread/start or thread/resume, preserving the
    // runtime's roots/network defaults. An explicit task opt-in is also applied
    // to turn/start. Each invocation resumes with its own policy, so elevation
    // cannot leak into an ordinary follow-up on the same thread.
    const sandbox = { readOnly: "read-only", workspaceWrite: "workspace-write", dangerFullAccess: "danger-full-access" }[threadPolicy?.type];
    if (sandbox !== (options.sandbox ?? "read-only")) {
      throw new Error("Codex did not acknowledge the requested sandbox policy; refusing to start the turn.");
    }
    // The sandbox limits what Codex may write, never where it may connect: a
    // narrowed read-only/workspace-write call keeps full network access, so web
    // research, package installs and browser work never hit an egress approval.
    const turnPolicy = threadPolicy.type === "dangerFullAccess" ? threadPolicy : { ...threadPolicy, networkAccess: true };
    const turnState = await captureTurn(
      client,
      threadId,
      () =>
        client.request("turn/start", {
          threadId,
          input: buildTurnInput(prompt),
          model: options.model ?? null,
          effort: options.effort ?? null,
          serviceTier: options.serviceTier ?? null,
          outputSchema: options.outputSchema ?? null,
          approvalPolicy: "never",
          ...(options.explicitSandbox ? { sandboxPolicy: turnPolicy } : {})
        }),
      { onProgress: options.onProgress, safeProgress: true, onTiming, signal: options.signal }
    );

    return {
      status: buildResultStatus(turnState),
      sandbox,
      sandboxPolicy: options.explicitSandbox ? turnPolicy : threadPolicy,
      approvalPolicy: "never",
      approvedBrowserOrigins: options.approvedBrowserOrigins ?? [],
      threadId,
      turnId: turnState.turnId,
      finalMessage: turnState.lastAgentMessage,
      reasoningSummary: turnState.reasoningSummary,
      turn: turnState.finalTurn,
      error: turnState.error,
      stderr: cleanCodexStderr(client.stderr),
      fileChanges: turnState.fileChanges,
      touchedFiles: collectTouchedFiles(turnState.fileChanges),
      commandExecutions: turnState.commandExecutions,
      startupTimings, startupWarning, turnEnded: Boolean(turnState.turnEndedObserved)
    };
  }, {
    approvedBrowserOrigins: options.approvedBrowserOrigins ?? [],
    onParentQuestion: options.onParentQuestion,
    signal: options.signal,
    onRuntimeEvent: runtimeEvent,
    onServerRequestLog: summary => emitProgress(options.onProgress, `Server request ${JSON.stringify(summary)}`, null)
  });
}

// Recovery is read-only: never resume a thread or submit another turn.
export async function readAppServerTurn(cwd, { threadId, turnId }) {
  const client = await CodexAppServerClient.connect(cwd, { reuseExistingBroker: true });
  try {
    const response = await client.request("thread/read", { threadId, includeTurns: true });
    const turn = response.thread?.turns?.find(candidate => candidate.id === turnId);
    if (!turn) return null;
    const items = turn.items ?? [];
    const fileChanges = items.filter(item => item.type === "fileChange");
    return {
      status: turn.status === "completed" ? 0 : 1,
      turnStatus: turn.status,
      threadId,
      turnId: turn.id,
      finalMessage: items.filter(item => item.type === "agentMessage").at(-1)?.text ?? "",
      error: turn.error,
      stderr: turn.error?.message ?? "",
      reasoningSummary: items.filter(item => item.type === "reasoning").flatMap(item => extractReasoningSections(item.summary)),
      touchedFiles: collectTouchedFiles(fileChanges),
      commandExecutions: items.filter(item => item.type === "commandExecution")
    };
  } finally { await client.close(); }
}

export async function findLatestTaskThread(cwd) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }

  return withAppServer(cwd, async (client) => {
    const response = await client.request("thread/list", {
      cwd,
      limit: 20,
      sortKey: "updated_at",
      sourceKinds: ["appServer"],
      searchTerm: TASK_THREAD_PREFIX
    });

    return (
      response.data.find((thread) => typeof thread.name === "string" && thread.name.startsWith(TASK_THREAD_PREFIX)) ??
      null
    );
  });
}

export function buildPersistentTaskThreadName(prompt) {
  return buildTaskThreadName(prompt);
}

export function parseStructuredOutput(rawOutput, fallback = {}) {
  if (!rawOutput) {
    return {
      parsed: null,
      parseError: fallback.failureMessage ?? "Codex did not return a final structured message.",
      rawOutput: rawOutput ?? "",
      ...fallback
    };
  }

  try {
    return {
      parsed: JSON.parse(rawOutput),
      parseError: null,
      rawOutput,
      ...fallback
    };
  } catch (error) {
    return {
      parsed: null,
      parseError: error.message,
      rawOutput,
      ...fallback
    };
  }
}

export function readOutputSchema(schemaPath) {
  return readJsonFile(schemaPath);
}

export { DEFAULT_CONTINUE_PROMPT, TASK_THREAD_PREFIX };
