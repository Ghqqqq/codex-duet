import { itemActivity, planActivity } from "./activity.mjs";
import { bestEffortDiagnostic } from "./tracked-jobs.mjs";
/**
 * @typedef {import("./app-server-protocol").AppServerNotification} AppServerNotification
 * @typedef {import("./app-server-protocol").ReviewTarget} ReviewTarget
 * @typedef {import("./app-server-protocol").ThreadItem} ThreadItem
 * @typedef {import("./app-server-protocol").ThreadResumeParams} ThreadResumeParams
 * @typedef {import("./app-server-protocol").ThreadStartParams} ThreadStartParams
 * @typedef {import("./app-server-protocol").Turn} Turn
 * @typedef {import("./app-server-protocol").UserInput} UserInput
 * @typedef {{ inputTokens: number, cachedInputTokens: number, outputTokens: number, reasoningOutputTokens: number, totalTokens: number }} TurnTokenUsage
 * @typedef {((update: string | { message: string, phase: string | null, threadId?: string | null, turnId?: string | null, stderrMessage?: string | null, logTitle?: string | null, logBody?: string | null }) => void)} ProgressReporter
 * @typedef {{
 *   threadId: string,
 *   rootThreadId: string,
 *   threadIds: Set<string>,
 *   threadTurnIds: Map<string, string>,
 *   threadLabels: Map<string, string>,
 *   turnId: string | null,
 *   usage: TurnTokenUsage | null,
 *   usageBaseline: TurnTokenUsage | null,
 *   usageUnavailable: boolean,
 *   bufferedNotifications: AppServerNotification[],
 *   completion: Promise<TurnCaptureState>,
 *   resolveCompletion: (state: TurnCaptureState) => void,
 *   rejectCompletion: (error: unknown) => void,
 *   finalTurn: Turn | null,
 *   completed: boolean,
 *   turnEndedObserved: boolean,
 *   inferredCompletion?: boolean,
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
 *   blockers: ReturnType<typeof toolCallBlockers>,
 *   activityStarts: Map<string, number>,
 *   safeProgress: boolean,
 *   onProgress: ProgressReporter | null
 * }} TurnCaptureState
 */
import { ACTIVE, ASK_PARENT, PARENT_BRIDGE_ENV, PARENT_BRIDGE_SERVER, recordBackgroundTerminals, recordedThreadJobs, turnInJobStartWindow, uniqueTurnAttribution, safeItem } from "./job-runtime.mjs";
import crypto from "node:crypto";
import fs from "node:fs";
import { resolveIsolatedCodexHome, resolveCodexBinary, isolatedCodexEnv } from "./codex-home.mjs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { readJsonFile } from "./fs.mjs";
import { snapshotClaudeSession } from "./claude-session-transfer.mjs";
import { BROKER_BUSY_RPC_CODE, BROKER_ENDPOINT_ENV, CodexAppServerClient, defaultConnectTimeoutMs } from "./app-server.mjs";
import { loadBrokerSession } from "./broker-lifecycle.mjs";
import { binaryAvailable } from "./process.mjs";
import { classifyRuntimeError } from "./runtime-errors.mjs";
import { computerUseSetup, computerUseSessionFile, grantComputerAppsForThread, readTomlField, setTomlField } from "./setup-config.mjs";
import { withJournalLock, tryAcquirePidLock, updateJob, unresolvedTask } from "./state.mjs";
import { APPROVAL_CHOICES } from "./server-requests.mjs";
import { dedupeBlockers, normalizeCodexErrorInfo, toolCallBlockers } from "./blockers.mjs";

const SERVICE_NAME = "claude_code_codex_plugin";
const TASK_THREAD_PREFIX = "Codex Companion Task";
const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current thread state. Pick the next highest-value step and follow through until the task is resolved.";
const EXTERNAL_AGENT_IMPORT_COMPLETED = "externalAgentConfig/import/completed";
const EXTERNAL_AGENT_IMPORT_TIMEOUT_MS = 2 * 60 * 1000;
// A dead admission holder may still have a broker turn/start awaiting acceptance.
// Let it settle before reclaiming the lock and checking the server for that turn.
const THREAD_ADMISSION_SETTLE_MS = 30_000;

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
}

// Persist the original session file before exposing any task-scoped grant.
// A separate short-lived lock serializes recovery with a new turn's grant;
// its PID-aware lock reclamation also survives a hard-killed worker.
function withTaskGrant(threadId, action) {
  const home = resolveIsolatedCodexHome(), file = computerUseSessionFile(home, threadId);
  const directory = path.join(home, "duet", "task-grants"), journal = path.join(directory, `${threadId}.json`);
  for (const target of [file, journal]) {
    let part = home;
    for (const name of path.relative(home, target).split(path.sep)) {
      part = path.join(part, name);
      try { if (fs.lstatSync(part).isSymbolicLink()) throw new Error("Task grant cleanup refuses symlinked paths."); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return withJournalLock(directory, () => {
    let record = null;
    try { record = JSON.parse(fs.readFileSync(journal, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
    const read = () => { try { return fs.readFileSync(file, "utf8"); } catch (error) { if (error.code === "ENOENT") return null; throw error; } };
    const write = (target, text) => {
      const temp = `${target}.${crypto.randomUUID()}.tmp`;
      try { fs.writeFileSync(temp, text, { flag: "wx", mode: 0o600 }); fs.renameSync(temp, target); }
      finally { fs.rmSync(temp, { force: true }); }
    };
    const release = () => {
      if (!record) return;
      const current = read();
      if (current !== null) {
        const allowed = readTomlField(current, ["apps", "allowed"]) ?? [];
        const remaining = allowed.filter(app => !record.added.includes(app));
        const expected = setTomlField(record.before ?? "", ["apps", "allowed"], [...new Set([...(readTomlField(record.before ?? "", ["apps", "allowed"]) ?? []), ...record.added])]);
        const restored = current === expected ? record.before : setTomlField(current, ["apps", "allowed"], remaining);
        if (restored === null) fs.rmSync(file, { force: true });
        else write(file, restored);
      }
      fs.rmSync(journal, { force: true });
      record = null;
    };
    if (record && !processAlive(record.pid)) release();
    return action({ record, read, release, save: next => write(journal, JSON.stringify(next)) });
  });
}

export function releaseStaleTaskComputerGrants(threadId) {
  if (threadId) withTaskGrant(threadId, () => {});
}

function grantTaskComputerApps(threadId, apps, owner) {
  withTaskGrant(threadId, ({ record, read, save }) => {
    if (record && record.token !== owner.token) throw new Error("Another live turn owns this thread's Computer Use grants.");
    const before = record ? record.before : read();
    const original = readTomlField(before ?? "", ["apps", "allowed"]) ?? [];
    save({ ...owner, pid: process.pid, before, added: [...new Set([...(record?.added ?? []), ...apps.filter(app => !original.includes(app))])] });
    grantComputerAppsForThread(threadId, apps);
  });
  return () => withTaskGrant(threadId, ({ record, release }) => { if (record?.token === owner.token) release(); });
}

function cleanCodexStderr(stderr) {
  return stderr
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line && !line.startsWith("WARNING: proceeding, even though we could not update PATH:"))
    .join("\n");
}

// Workers answer no approval prompt themselves: command, sandbox, rule, skill
// and permission requests are rejected as under "never". MCP elicitations are
// the exception: with mcp_elicitations enabled, Codex sends a Computer Use app
// request to this client instead of resolving it, so the parent can decide
// (see AppServerClient.handleServerRequest). The label is what results report.
export const FORWARDED_APPROVALS = Object.freeze({ granular: Object.freeze({ mcp_elicitations: true, rules: false, sandbox_approval: false, request_permissions: false, skill_approval: false }) });
export const FORWARDED_APPROVALS_LABEL = "never+elicitations";
export function approvalPolicyFor(options) {
  return options.onApprovalRequest ? FORWARDED_APPROVALS : "never";
}
export function approvalPolicyLabel(policy) {
  return policy === FORWARDED_APPROVALS ? FORWARDED_APPROVALS_LABEL : typeof policy === "string" ? policy : "granular";
}
/** @returns {ThreadStartParams} */
function buildThreadParams(cwd, options = {}) {
  return {
    cwd,
    model: options.model ?? null,
    approvalPolicy: options.approvalPolicy ?? "never",
    sandbox: options.sandbox ?? "read-only",
    serviceName: SERVICE_NAME,
    ...(options.developerInstructions != null ? { developerInstructions: options.developerInstructions } : {}),
    ...(options.parentQuestions ? options.parentBridge ? { config: parentBridgeConfig(options.parentBridge) } : { dynamicTools: [ASK_PARENT] } : {}),
    ephemeral: options.ephemeral ?? true
  };
}

// Fresh and resumed threads get ask_parent from a per-thread MCP server override.
// Fresh threads bind through the starting job until its thread handle is recorded;
// resumes bind directly to the thread. Only one handle and the state-location
// variables are passed. The bridge uses the in-process tool's job-file flow.
// `omit_tools_from` keeps the tool out of Codex's deferred/code-mode tool sets:
// verified live that without it the server starts and `mcpServerStatus/list`
// shows the tool, yet the model never sees `mcp__duet_parent.ask_parent`.
export function parentBridgeConfig(bridge) {
  // The bridge finds job state through the isolated home, like every other
  // helper process; pass it explicitly because Codex starts MCP servers with a
  // reduced environment.
  const env = { [PARENT_BRIDGE_ENV.cwd]: bridge.cwd,
    ...(bridge.threadId ? { [PARENT_BRIDGE_ENV.threadId]: bridge.threadId } : { [PARENT_BRIDGE_ENV.jobId]: bridge.jobId }),
    CODEX_COMPANION_HOME: resolveIsolatedCodexHome() };
  for (const key of ["TMPDIR"]) if (process.env[key]) env[key] = process.env[key];
  return { mcp_servers: { [PARENT_BRIDGE_SERVER]: {
    command: process.execPath, args: [fileURLToPath(new URL("../parent-bridge-mcp.mjs", import.meta.url))], env,
    enabled: true, enabled_tools: ["ask_parent"], omit_tools_from: ["code_mode", "deferred"],
    // Workers reject tool approvals ("never", or the granular policy that only
    // forwards MCP elicitations); without this (and the tool's readOnlyHint)
    // Codex rejects the call as "requires approval".
    tools: { ask_parent: { approval_mode: "approve" } },
    startup_timeout_sec: 30, tool_timeout_sec: Math.min(86400, (bridge.questionTimeoutSec ?? 900) + 120)
  } } };
}

/** @returns {ThreadResumeParams} */
function buildResumeParams(threadId, cwd, options = {}) {
  return {
    threadId,
    cwd,
    ...(options.developerInstructions != null ? { developerInstructions: options.developerInstructions } : {}),
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
  bestEffortDiagnostic(() => {
    if (!phase && Object.keys(extra).length === 0) {
      onProgress(message);
      return;
    }
    onProgress({ message, phase, ...extra });
  });
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
    usage: null,
    usageBaseline: null,
    usageUnavailable: false,
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
    blockers: [],
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
    state.inferredCompletion = true;
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

async function confirmInferredCompletion(client, state) {
  if (!state.inferredCompletion) return {};
  try {
    // The final answer is useful even if the notification was lost. Read the
    // exact turn while still connected, but never wait indefinitely for the RPC.
    const response = await client.request("thread/read", { threadId: state.threadId, includeTurns: true }, { timeoutMs: 5000 });
    const turn = response?.thread?.id === state.threadId
      ? response.thread.turns?.find(turn => turn.id === state.turnId) : null;
    if (["completed", "failed", "interrupted"].includes(turn?.status)) {
      state.finalTurn = turn;
      state.turnEndedObserved = true;
      if (turn.error) state.error = turn.error;
    }
    return { inferredCompletion: true, turnStatus: turn?.status ?? null };
  } catch {
    // Unreadable history is not proof of completion. The marker keeps this
    // captured answer eligible for exact-turn recovery and cancellation.
    return { inferredCompletion: true, turnStatus: null };
  }
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
        bestEffortDiagnostic(() => emitLogEvent(state.onProgress, {
          message: sourceLabel ? `Subagent ${sourceLabel}: ${shorten(item.text, 96)}` : `Assistant message captured: ${shorten(item.text, 96)}`,
          stderrMessage: null,
          phase: item.phase === "final_answer" ? "finalizing" : null,
          logTitle: sourceLabel ? `Subagent ${sourceLabel} message` : "Assistant message",
          logBody: item.text
        }));
      }
    }
    return;
  }

  if (item.type === "exitedReviewMode") {
    state.reviewText = item.review ?? "";
    if (lifecycle === "completed" && item.review) {
      bestEffortDiagnostic(() => emitLogEvent(state.onProgress, {
        message: "Review output captured.",
        stderrMessage: null,
        phase: "finalizing",
        logTitle: "Review output",
        logBody: item.review
      }));
    }
    return;
  }

  if (item.type === "reasoning" && lifecycle === "completed") {
    const nextSections = extractReasoningSections(item.summary);
    state.reasoningSummary = mergeReasoningSections(state.reasoningSummary, nextSections);
    if (nextSections.length > 0 && !state.safeProgress) {
      const sourceLabel = labelForThread(state, threadId);
      bestEffortDiagnostic(() => emitLogEvent(state.onProgress, {
        message: sourceLabel
          ? `Subagent ${sourceLabel} reasoning: ${shorten(nextSections[0], 96)}`
          : `Reasoning summary captured: ${shorten(nextSections[0], 96)}`,
        stderrMessage: null,
        logTitle: sourceLabel ? `Subagent ${sourceLabel} reasoning summary` : "Reasoning summary",
        logBody: nextSections.map((section) => `- ${section}`).join("\n")
      }));
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

  // Known runtime refusals (Computer Use app approval, browser tab state) are
  // recorded as structured blockers; the tool payload itself is not retained.
  if (item.type === "mcpToolCall" && lifecycle === "completed") {
    const found = toolCallBlockers(item);
    if (found.length) state.blockers = dedupeBlockers([...state.blockers, ...found]);
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
    case "thread/tokenUsage/updated": {
      if (message.params.threadId !== state.rootThreadId || message.params.turnId !== state.turnId) break;
      if (state.usageUnavailable) break;
      // `last` covers one model request, while `total` includes thread history.
      // The first response gives the total before this turn as total - last;
      // subsequent responses (including tool loops) retain that same baseline.
      const last = message.params.tokenUsage?.last;
      const total = message.params.tokenUsage?.total;
      const keys = ["inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"];
      if (!total || keys.some(key => !Number.isSafeInteger(total[key]) || total[key] < 0) ||
          (!state.usageBaseline && (!last || keys.some(key => !Number.isSafeInteger(last[key]) || last[key] < 0 || total[key] < last[key]))) ||
          (state.usageBaseline && keys.some(key => total[key] < state.usageBaseline[key] + (state.usage?.[key] ?? 0)))) {
        // Do not rebase on a later request or retain partial usage after an
        // invalid update: either would risk presenting an under-count as final.
        state.usageUnavailable = true;
        state.usage = null;
        break;
      }
      state.usageBaseline ??= /** @type {TurnTokenUsage} */ (Object.fromEntries(keys.map(key => [key, total[key] - last[key]])));
      state.usage = /** @type {TurnTokenUsage} */ (Object.fromEntries(keys.map(key => [key, total[key] - state.usageBaseline[key]])));
      break;
    }
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
      if (message.params.turn.error) {
        state.error = { ...message.params.turn.error,
          codexErrorInfo: message.params.turn.error.codexErrorInfo ?? state.error?.codexErrorInfo ?? null };
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

  let interruptTimer = null, backgroundTerminalsCleanup = null;
  const interrupt = () => {
    if (backgroundTerminalsCleanup || state.completed) return;
    const turnId = state.turnId ?? client.serverRequestPolicy.turnId;
    if (turnId) {
      try { void client.request("turn/interrupt", { threadId, turnId }).catch(() => {}); } catch { /* cleanup still reports a closed transport */ }
      // Sending the interrupt precedes cleanup; its acknowledgement may never
      // arrive. Keep this client's connection open for the bounded cleanup.
      backgroundTerminalsCleanup = cleanBackgroundTerminals(client, threadId).then(outcome => {
        try { recordBackgroundTerminals(options.signal, outcome); } catch { /* recording cannot change the interruption outcome */ }
      });
    }
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
    options.onStarted?.(state.turnId);
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
  } catch (error) {
    if (connectionFailure(error, client)) {
      error.failureSource = "transport";
      error.threadId = threadId;
      error.turnId = state.turnId ?? client.serverRequestPolicy.turnId;
      error.message = error.turnId ? "Connection to Codex closed while the turn was running."
        : "Connection to Codex closed while the turn was running or awaiting acceptance; its start reply was not received. Recover the recorded job before continuing.";
    }
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", interrupt);
    await backgroundTerminalsCleanup;
    clearTimeout(interruptTimer);
    clearInterval(heartbeat);
    clearCompletionTimer(state);
    client.setNotificationHandler(previousHandler ?? null);
    client.setServerRequestContext(null, null);
  }
}

function connectionFailure(error, client) {
  return client?.exitResolved || ["BROKER_CONNECTION_CLOSED", "ECONNRESET", "EPIPE", "ECONNREFUSED"].includes(error.code) ||
    /^codex app-server (?:connection closed|client is closed)\.$/i.test(error.message);
}

async function withAppServer(cwd, fn, options = {}) {
  // The existing busy-broker fallback shares the original connection budget.
  options = { ...options, connectDeadline: options.connectDeadline ?? Date.now() + (options.connectTimeoutMs ?? defaultConnectTimeoutMs(options.env ?? process.env)) };
  let client = null;
  try {
    client = await CodexAppServerClient.connect(cwd, options);
    const result = await fn(client);
    await client.close();
    return result;
  } catch (error) {
    if (connectionFailure(error, client)) {
      error.failureSource = "transport";
      if (!error.turnId && /^codex app-server (?:connection closed|client is closed)\.$/i.test(error.message)) {
        error.message = client?.transport === "broker" ? "Codex broker connection closed during startup." : "Codex connection closed during startup.";
      }
    }
    const brokerRequested = client?.transport === "broker" || Boolean(process.env[BROKER_ENDPOINT_ENV]);
    const shouldRetryDirect = !error.turnId && (
      (client?.transport === "broker" && error?.rpcCode === BROKER_BUSY_RPC_CODE) ||
      (brokerRequested && (error?.code === "ENOENT" || error?.code === "ECONNREFUSED")));

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

function importedThreadIdForSource(canonicalSource, contentSha256) {
  const ledgerPath = path.join(resolveCodexHome(), "external_agent_session_imports.json");
  if (!fs.existsSync(ledgerPath)) {
    return null;
  }
  const ledger = readJsonFile(ledgerPath);
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
  let importId = null;
  const earlyCompletions = new Map();
  /** @type {(notification: Extract<AppServerNotification, { method: "externalAgentConfig/import/completed" }>["params"]) => void} */
  let resolveCompleted;
  const completed = new Promise((resolve) => {
    resolveCompleted = resolve;
  });
  let timeout;
  /** @type {Promise<never>} */
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(
      `Timed out after 120 seconds waiting for Codex Claude session import${importId ? ` ${importId}` : " acknowledgement"}. No task turn was started. Check the Codex app-server logs, then retry or use a normal duet task brief without --fork.`
    )), EXTERNAL_AGENT_IMPORT_TIMEOUT_MS);
  });

  client.setNotificationHandler((message) => {
    if (message.method === EXTERNAL_AGENT_IMPORT_COMPLETED) {
      const notification = message.params;
      if (notification?.importId === importId) resolveCompleted(notification);
      else if (!importId && typeof notification?.importId === "string") earlyCompletions.set(notification.importId, notification);
      return;
    }
    previousHandler?.(message);
  });
  try {
    // The deadline covers a missing response as well as a missing completion.
    const response = await Promise.race([client.request("externalAgentConfig/import", params), deadline]);
    if (typeof response?.importId !== "string" || !response.importId) {
      throw new Error("Codex did not acknowledge the Claude session import with an importId. Update Codex and retry, or use a normal task brief.");
    }
    importId = response.importId;
    if (earlyCompletions.has(importId)) resolveCompleted(earlyCompletions.get(importId));
    earlyCompletions.clear();
    const notification = await Promise.race([completed, deadline]);
    const results = notification?.itemTypeResults;
    const failures = (results ?? []).flatMap(result => result.failures ?? []);
    if (failures.length) {
      throw new Error(`Codex Claude session import ${importId} failed: ${failures.map(failure => `${failure.itemType} (${failure.failureStage}): ${failure.message}`).join("; ")}. No task turn was started. Retry the import or use a normal task brief.`);
    }
    if (!results?.some(result => result.itemType === "SESSIONS" && result.successes?.length)) {
      throw new Error(`Codex Claude session import ${importId} reported no successful SESSIONS import. No task turn was started. Check the Codex app-server logs or use a normal task brief.`);
    }
    return { importId };
  } finally {
    clearTimeout(timeout);
    client.setNotificationHandler(previousHandler ?? null);
  }
}

// The unsupported signal must name the registration field itself: an unrelated
// error ("model config: unsupported model") or serde's list of *accepted* fields
// ("unknown field `x`, expected one of `config`, ...") is not a registration rejection.
const REGISTRATION_FIELDS = { bridge: "config|mcp_servers", dynamic: "dynamicTools|dynamic_tools" };
function parentRegistrationUnsupported(error, registration) {
  const field = `[\`'"]?(?:[\\w./]*[./])?(?:${REGISTRATION_FIELDS[registration]})[\`'"]?(?![\\w])`;
  const rejected = new RegExp(`(?:unknown|unrecognized|unexpected|unsupported) (?:field|parameter|param|key)s?:? ${field}|(?:^|[\\s(])${field} (?:is |are )?(?:not supported|unsupported|requires (?:the )?experimental)`, "i");
  return [-32600, -32601, -32602].includes(error.rpcCode) && rejected.test(String(error.message ?? ""));
}

async function startThread(client, cwd, options = {}) {
  let response;
  if (options.parentQuestions && options.parentBridge) {
    try { response = await client.request("thread/start", buildThreadParams(cwd, options)); }
    catch (error) {
      if (!parentRegistrationUnsupported(error, "bridge")) throw error;
      emitProgress(options.onProgress, "Parent question bridge unavailable in this runtime; retrying with the dynamic tool.", "starting");
    }
  }
  if (!response) {
    try { response = await client.request("thread/start", buildThreadParams(cwd, { ...options, parentBridge: null })); }
    catch (error) {
      if (!options.parentQuestions || !parentRegistrationUnsupported(error, "dynamic")) throw error;
      emitProgress(options.onProgress, "Parent questions unavailable in this runtime; final needs_input fallback remains enabled.", "starting");
      response = await client.request("thread/start", buildThreadParams(cwd, { ...options, parentQuestions: false }));
    }
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
    if (!options.parentBridge || !parentRegistrationUnsupported(error, "bridge")) throw error;
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

// These deadlines only stop a hung runtime from blocking forever. Keep them
// generous: availability runs before every task, and a loaded machine must
// never turn a slow but healthy runtime into "unavailable".
const READINESS_TIMEOUT_MS = 60000;
const EXECUTABLE_PROBE_TIMEOUT_MS = 20000;
const INITIALIZE_PROBE_TIMEOUT_MS = 30000;
const AUTH_REQUEST_TIMEOUT_MS = 20000;
const probeBudget = (deadline, limit) => Math.max(1, Math.min(limit, deadline - Date.now()));

async function getCodexAuthStatusFromClient(client, cwd, deadline) {
  try {
    const accountResponse = await client.request("account/read", { refreshToken: false }, { timeoutMs: probeBudget(deadline, AUTH_REQUEST_TIMEOUT_MS) });
    const configResponse = await client.request("config/read", {
      includeLayers: false,
      cwd
    }, { timeoutMs: probeBudget(deadline, AUTH_REQUEST_TIMEOUT_MS) });

    return buildAppServerAuthStatus(accountResponse, configResponse);
  } catch (error) {
    return buildAuthStatus({
      loggedIn: false,
      ...classifyRuntimeError(error),
      source: "app-server"
    });
  }
}

export function getCodexAvailability(cwd, { deadline = Date.now() + READINESS_TIMEOUT_MS, env = process.env } = {}) {
  const probe = args => binaryAvailable(resolveCodexBinary(env), args, { cwd, env: isolatedCodexEnv(env), timeoutMs: probeBudget(deadline, EXECUTABLE_PROBE_TIMEOUT_MS) });
  const versionStatus = probe(["--version"]);
  if (!versionStatus.available) {
    return versionStatus;
  }

  const appServerStatus = probe(["app-server", "--help"]);
  if (!appServerStatus.available) {
    return {
      available: false,
      status: appServerStatus.status ?? "unavailable",
      reason: appServerStatus.reason ?? "runtime-unavailable",
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
  const deadline = options.deadline ?? Date.now() + READINESS_TIMEOUT_MS;
  const availability = options.availability ?? getCodexAvailability(cwd, { deadline, env: options.env });
  if (!availability.available) {
    return {
      available: false,
      status: availability.status === "unreachable" ? "unreachable" : "unavailable",
      reason: availability.reason ?? "runtime-unavailable",
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
      connectTimeoutMs: probeBudget(deadline, INITIALIZE_PROBE_TIMEOUT_MS),
      reuseExistingBroker: true
    });
    return await getCodexAuthStatusFromClient(client, cwd, deadline);
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

/**
 * @param {Awaited<ReturnType<typeof CodexAppServerClient.connect>>} client
 * @param {string} threadId
 * @returns {Promise<{ cleaned: boolean, detail: string | null }>}
 */
async function cleanBackgroundTerminals(client, threadId) {
  let timeout;
  try {
    await Promise.race([
      // Experimental in Codex 0.146.0; the generated stable request map omits it.
      client.request(/** @type {any} */ ("thread/backgroundTerminals/clean"), { threadId }),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("Background terminal cleanup timed out.")), 3000); })
    ]);
    return { cleaned: true, detail: null };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const unsupported = error?.rpcCode === -32601 || /(?:unknown|unsupported|not found).*method|method.*(?:unknown|unsupported|not found)/i.test(detail);
    return { cleaned: false, detail: unsupported ? "thread/backgroundTerminals/clean is unsupported." : shorten(detail, 200) || "Background terminal cleanup failed." };
  } finally {
    clearTimeout(timeout);
  }
}

export async function cleanAppServerBackgroundTerminals(cwd, threadId) {
  const abort = new AbortController(), timeout = setTimeout(() => abort.abort(), 10000);
  let client;
  try {
    client = await CodexAppServerClient.connect(cwd, { reuseExistingBroker: true, signal: abort.signal });
    return await cleanBackgroundTerminals(client, threadId);
  } catch (error) { return { cleaned: false, detail: error.message }; }
  finally { clearTimeout(timeout); await client?.close(); }
}

export async function interruptAppServerTurn(cwd, { threadId, turnId }) {
  const backgroundTerminals = { cleaned: false, detail: "No turn interrupt was sent." };
  if (!threadId || !turnId) {
    return {
      attempted: false,
      interrupted: false,
      transport: null,
      detail: "missing threadId or turnId",
      backgroundTerminals
    };
  }

  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    return {
      attempted: false,
      interrupted: false,
      transport: null,
      detail: availability.detail,
      backgroundTerminals
    };
  }

  let client = null, interruptSent = false;
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 10000);
  try {
    client = await CodexAppServerClient.connect(cwd, { reuseExistingBroker: true, signal: abort.signal });
    let interruptError = null;
    try {
      try {
        interruptSent = true;
        await client.request("turn/interrupt", { threadId, turnId });
      } catch (error) {
        // A replacement app-server may know the persisted thread but not have
        // loaded it. Resume only that thread, without overriding its settings.
        if (!/thread.*(?:not found|not loaded|unknown)|(?:no|unknown) (?:active )?thread/i.test(error.message)) throw error;
        await client.request("thread/resume", { threadId });
        await client.request("turn/interrupt", { threadId, turnId });
      }
    } catch (error) {
      if (connectionFailure(error, client)) throw error;
      // The turn may have finished just before the interrupt. Its terminal
      // record, never the interrupt error itself, can establish resolution.
      interruptError = error;
    }
    // RPC acknowledgement is not proof that the turn stopped. Read the exact
    // handle until terminal; never resolve from a later turn on this thread.
    let result = null;
    for (const deadline = Date.now() + 5000; Date.now() < deadline;) {
      const response = await client.request("thread/read", { threadId, includeTurns: true });
      result = appServerTurnResult(response, threadId, turnId);
      if (!result || result.turnEnded) break;
      if (interruptError) throw interruptError;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return {
      attempted: true,
      interrupted: Boolean(result?.turnEnded),
      result,
      backgroundTerminals,
      transport: client.transport,
      detail: result?.turnEnded ? `Confirmed ${turnId} on ${threadId} is ${result.turnStatus}.` : `The server has not confirmed that ${turnId} stopped.${interruptError ? ` ${interruptError.message}` : ""}`
    };
  } catch (error) {
    return {
      attempted: true,
      interrupted: false,
      backgroundTerminals,
      transport: client?.transport ?? null,
      detail: error instanceof Error ? error.message : String(error)
    };
  } finally {
    clearTimeout(timeout);
    // Also clean when the exact-turn poll times out or fails. Cleanup is a
    // separate outcome and never changes interruption confirmation or errors.
    if (client && interruptSent) Object.assign(backgroundTerminals, await cleanBackgroundTerminals(client, threadId));
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

    const inferredCompletion = await confirmInferredCompletion(client, turnState);
    return {
      ...inferredCompletion,
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

  const snapshot = snapshotClaudeSession(cwd, options.sourcePath, process.env, {
    sessionId: options.sessionId, explicitSource: options.explicitSource
  });
  try {
    const snapshotSha256 = sourceContentSha256(snapshot.snapshotPath);
    return await withDirectAppServer(cwd, async (client) => {
      emitProgress(options.onProgress, "Importing Claude session into Codex.", "transferring");
      let imported;
      try {
        imported = await requestExternalAgentSessionImport(client, externalAgentSessionMigration(snapshot.snapshotPath, cwd));
      } catch (error) {
        if (error?.rpcCode === -32601) {
          throw new Error(
            "This Codex version does not support Claude session transfer. Update Codex with `npm install -g @openai/codex@latest`, then retry.",
            { cause: error }
          );
        }
        throw error;
      }
      const threadId = importedThreadIdForSource(snapshot.snapshotPath, snapshotSha256);
      if (!threadId) {
        const stderr = cleanCodexStderr(client.stderr);
        throw new Error(
          `Codex reported that the Claude import completed, but did not record an imported thread.${stderr ? `\n${stderr}` : " Check the Codex app-server logs for the underlying import error."}`
        );
      }
      emitProgress(options.onProgress, `Claude session imported (${threadId}).`, "completed", { threadId });
      return {
        threadId,
        sourceSha256: snapshot.sourceSha256,
        forkSlice: snapshot.forkSlice,
        importId: imported.importId,
        stderr: cleanCodexStderr(client.stderr)
      };
    });
  } finally {
    snapshot.cleanup();
  }
}

export async function runAppServerTurn(cwd, options = {}) {
  // Broker and job state use the workspace root; tasks may execute below it.
  const executionCwd = options.executionCwd ?? cwd;
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

  const serverRequestBlockers = [];
  const onServerRequestLog = summary => {
    emitProgress(options.onProgress, `Server request ${JSON.stringify(summary)}`, null);
    if (summary.kind === "computer-use-app" && !["approved", "pending"].includes(summary.decision) && summary.app) {
      serverRequestBlockers.push({ code: "computer_use_app_not_approved", app: summary.app, message: `Computer Use elicitation for ${summary.app} ${summary.decision} (${summary.reason})` });
    } else if (summary.kind !== "computer-use-app" && ["cancelled", "unsupported"].includes(summary.decision)) {
      // The message repeats only these safe identifiers, never request content.
      serverRequestBlockers.push({ code: summary.decision === "cancelled" ? "approval_denied" : "approval_unsupported",
        message: `Codex request ${summary.method} (${summary.kind})${summary.server ? ` from ${summary.server}` : ""}${summary.origin ? ` for ${summary.origin}` : ""} was ${summary.decision === "cancelled" ? "declined" : "not supported"}; Duet workers cannot approve it.`,
        method: summary.method, kind: summary.kind, requestId: summary.requestId,
        ...(summary.app ? { app: summary.app } : {}),
        ...(summary.server ? { server: summary.server } : {}),
        ...(summary.origin ? { origin: summary.origin } : {}) });
    }
  };
  const approvalPolicy = approvalPolicyFor(options);
  return withAppServer(cwd, async (client) => {
    // A busy broker can retry this callback with a private client. Each
    // attempt owns its approval closure and grants, including late answers.
    let releaseComputerApps = () => {};
    const taskGrants = [];
    const grantOwner = { token: crypto.randomUUID(), jobId: options.jobId ?? null, cwd };
    let turnFinishing = false;
    const onApprovalRequest = options.onApprovalRequest ? async request => {
      if (turnFinishing) return { action: "cancel", reason: "turn-ended" };
      const choice = await options.onApprovalRequest(request);
      if (turnFinishing) return { action: "cancel", reason: "turn-ended" };
      if (!APPROVAL_CHOICES.includes(choice) || choice === "deny") return { action: "cancel", reason: choice === "deny" ? "parent-denied" : "parent-unavailable" };
      if (choice === "task") taskGrants.push(grantTaskComputerApps(request.threadId, [request.app], grantOwner));
      if (choice === "always") computerUseSetup({ allow: [request.app] });
      emitProgress(options.onProgress, `Computer Use app ${request.app} approved by the parent (${choice}).`, null);
      return { action: "accept", reason: `parent-${choice}` };
    } : undefined;
    client.options = { ...client.options, onApprovalRequest };
    if (options.signal?.aborted) throw new Error("Task interrupted during startup.");
    let threadId;
    let threadPolicy;
    let threadSettings = {};

    const threadBegan = Date.now();
    if (options.resumeThreadId) {
      emitProgress(options.onProgress, `Resuming thread ${options.resumeThreadId}.`, "starting");
      const response = await resumeThread(client, options.resumeThreadId, executionCwd, {
        developerInstructions: options.developerInstructions,
        model: options.model,
        sandbox: options.sandbox,
        approvalPolicy,
        ephemeral: false,
        onProgress: options.onProgress,
        parentBridge: options.onParentQuestion && options.parentBridge ? options.parentBridge : null
      });
      threadId = response.thread.id;
      threadPolicy = response.sandbox;
      threadSettings = response;
    } else {
      emitProgress(options.onProgress, "Starting Codex task thread.", "starting");
      const response = await startThread(client, executionCwd, {
        developerInstructions: options.developerInstructions,
        model: options.model,
        sandbox: options.sandbox,
        approvalPolicy,
        ephemeral: options.persistThread ? false : true,
        threadName: options.persistThread ? options.threadName : options.threadName ?? null,
        onProgress: options.onProgress,
        parentQuestions: Boolean(options.onParentQuestion),
        parentBridge: options.onParentQuestion && options.parentBridge && options.jobId
          ? { ...options.parentBridge, threadId: null, jobId: options.jobId } : null
      });
      threadId = response.thread.id;
      threadPolicy = response.sandbox;
      threadSettings = response;
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
    // Per-call Computer Use approval: node_repl consults the isolated home's
    // sessions/<thread>.toml on every app request, so the listed apps are
    // allowed for this thread while the turn runs and withdrawn afterwards.
    const approvedComputerApps = options.approvedComputerApps ?? [];
    let turnState;
    let releaseAdmission = null;
    const busy = turnIds => {
      const blocker = options.onThreadBusy?.(threadId, turnIds) ?? {
        code: "thread_busy", message: `Codex thread ${threadId} already has a turn running or awaiting acceptance.`
      };
      return { status: 0, threadId, turnId: null, finalMessage: blocker.message, blockers: [blocker], turnEnded: true };
    };
    const recordedJobs = () => recordedThreadJobs(threadId).jobs.filter(job => job.id !== options.jobId);
    const recordedTurns = jobs => jobs.filter(job =>
      job.turnId && (ACTIVE.has(job.status) || unresolvedTask(job))).map(job => job.turnId);
    try {
      if (options.resumeThreadId) {
        const directory = path.join(resolveIsolatedCodexHome(), "duet", "thread-admission");
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        releaseAdmission = tryAcquirePidLock(path.join(directory, `${crypto.createHash("sha256").update(threadId).digest("hex")}.lock`),
          { deadOwnerGraceMs: THREAD_ADMISSION_SETTLE_MS });
        if (!releaseAdmission) return busy(recordedTurns(recordedJobs()));
        // Every connection, including the broker-busy direct retry, reserves
        // this interval. Recheck both the server and durable accepted handles.
        const response = await client.request("thread/read", { threadId, includeTurns: true });
        if (response.thread?.id !== threadId || !Array.isArray(response.thread.turns)) throw new Error("Cannot read existing thread turns; refusing to start another turn.");
        const recorded = recordedJobs();
        const active = [...new Set([...response.thread.turns.filter(turn => turn.status === "inProgress").map(turn => turn.id), ...recordedTurns(recorded)])];
        // Fresh threads publish their live job before submitting the first
        // turn. A terminal wrapper still exiting must not block a continuation.
        // A wrapper that crashed moments ago, before recording a turn or any
        // outcome, may still have its turn/start awaiting acceptance.
        const settling = job => !job.turnId && ACTIVE.has(job.status) &&
          Date.now() - Date.parse(job.startedAt ?? job.createdAt) < THREAD_ADMISSION_SETTLE_MS;
        if (active.length || recorded.some(job => (ACTIVE.has(job.status) && processAlive(job.pid)) || settling(job))) return busy(active);
      }
      releaseStaleTaskComputerGrants(threadId);
      if (approvedComputerApps.length) {
        releaseComputerApps = grantTaskComputerApps(threadId, approvedComputerApps, grantOwner);
        emitProgress(options.onProgress, `Computer Use apps approved for this call: ${approvedComputerApps.join(", ")}.`, "starting");
      }
      turnState = await captureTurn(
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
            approvalPolicy,
            ...(options.explicitSandbox ? { sandboxPolicy: turnPolicy } : {})
          }),
        { onProgress: options.onProgress, safeProgress: true, onTiming, signal: options.signal,
          onStarted: turnId => {
            if (!turnId) throw new Error("Codex did not return a turn handle; recover this job before continuing.");
            if (options.jobId) updateJob(cwd, options.jobId, job => job.threadId === threadId && job.turnId === turnId ? null : { threadId, turnId });
            releaseAdmission?.();
            releaseAdmission = null;
          } }
      );
    } finally {
      releaseAdmission?.();
      turnFinishing = true;
      // The durable journal restores this attempt's baseline once; subsequent
      // releases are no-ops, including the per-call grant below.
      for (const release of taskGrants.reverse()) release();
      releaseComputerApps();
    }

    const inferredCompletion = await confirmInferredCompletion(client, turnState);
    const codexErrorInfo = normalizeCodexErrorInfo(turnState.error?.codexErrorInfo);
    return {
      ...inferredCompletion,
      status: buildResultStatus(turnState),
      sandbox,
      sandboxPolicy: options.explicitSandbox ? turnPolicy : threadPolicy,
      approvalPolicy: approvalPolicyLabel(approvalPolicy),
      // What this turn ran with: the per-turn request, else the thread's setting.
      model: options.model ?? threadSettings.model ?? null,
      effort: options.effort ?? threadSettings.reasoningEffort ?? null,
      serviceTier: options.serviceTier ?? threadSettings.serviceTier ?? null,
      approvedBrowserOrigins: options.approvedBrowserOrigins ?? [],
      approvedComputerApps,
      blockers: dedupeBlockers([...turnState.blockers, ...serverRequestBlockers]),
      threadId,
      turnId: turnState.turnId,
      finalMessage: turnState.lastAgentMessage,
      reasoningSummary: turnState.reasoningSummary,
      turn: turnState.finalTurn,
      error: turnState.error,
      ...(codexErrorInfo !== null ? { codexErrorInfo } : {}),
      stderr: cleanCodexStderr(client.stderr),
      fileChanges: turnState.fileChanges,
      touchedFiles: collectTouchedFiles(turnState.fileChanges),
      commandExecutions: turnState.commandExecutions,
      ...(turnState.usage ? { usage: turnState.usage } : {}),
      startupTimings, startupWarning, turnEnded: Boolean(turnState.turnEndedObserved)
    };
  }, {
    approvedBrowserOrigins: options.approvedBrowserOrigins ?? [],
    approvedComputerApps: options.approvedComputerApps ?? [],
    onParentQuestion: options.onParentQuestion,
    signal: options.signal,
    connectTimeoutMs: options.connectTimeoutMs,
    onRuntimeEvent: runtimeEvent,
    onServerRequestLog
  });
}

// Recovery is read-only: never resume a thread or submit another turn.
export async function readAppServerTurn(cwd, job, { admittingJobId = null, env = process.env, deadline = null, privateWhenBusy = false } = {}) {
  let { threadId, turnId } = job;
  const abort = new AbortController();
  let client;
  const timeout = setTimeout(() => {
    abort.abort();
    // Automatic maintenance has a whole-pass deadline, not a task's interrupt
    // grace. Close even a client still waiting for initialize at that deadline.
    if (deadline !== null) void client?.close().catch(() => {});
  }, deadline === null ? 10000 : Math.max(1, deadline - Date.now()));
  try {
    if (deadline !== null && Date.now() >= deadline) throw new Error("Turn recovery budget expired.");
    const connect = extra => CodexAppServerClient.connect(cwd, { env, reuseExistingBroker: true, signal: abort.signal, ...extra,
      ...(deadline === null ? {} : { onClient: candidate => { client = candidate; } }) });
    client = await connect({});
    let response;
    try { response = await client.request("thread/read", { threadId, includeTurns: true }); }
    catch (error) {
      // A shared broker streaming another job refuses other clients' reads.
      // A follow-up's admission check reads the persisted thread through a
      // private runtime instead; status and maintenance keep the cheap refusal.
      if (!privateWhenBusy || client.transport !== "broker" || error?.rpcCode !== BROKER_BUSY_RPC_CODE) throw error;
      await client.close();
      client = await connect({ disableBroker: true });
      response = await client.request("thread/read", { threadId, includeTurns: true });
    }
    if (!turnId) {
      // A dead wrapper may have stopped before turn/start, or after sending it
      // but before saving its reply. Never infer absence from an unreadable list.
      if (response.thread?.id !== threadId || !Array.isArray(response.thread.turns)) return null;
      const inventory = recordedThreadJobs(threadId);
      if (!inventory.complete) return null;
      const owned = new Set(inventory.jobs.filter(candidate => candidate.id !== job.id || candidate.workspaceRoot !== job.workspaceRoot).map(candidate => candidate.turnId).filter(Boolean));
      const unclaimed = response.thread.turns.filter(turn => !owned.has(turn.id));
      // Null timestamps, multiple turns, or overlapping wrapper start windows
      // cannot establish provenance, regardless of whether a turn has ended.
      if (turnInJobStartWindow(job, 0) === null || unclaimed.some(turn => !Number.isFinite(turn.startedAt))) return null;
      const candidates = unclaimed.filter(turn => turnInJobStartWindow(job, turn.startedAt));
      if (candidates.length > 1) return null;
      if (!candidates.length) return { threadId, turnId: null, turnStatus: "notStarted" };
      if (!uniqueTurnAttribution(job, candidates[0], inventory, admittingJobId)) return null;
      turnId = candidates[0].id;
    }
    return appServerTurnResult(response, threadId, turnId);
  } finally { clearTimeout(timeout); await client?.close(); }
}

function appServerTurnResult(response, threadId, turnId) {
    const turn = response.thread?.turns?.find(candidate => candidate.id === turnId);
    if (!turn) return null;
    const items = turn.items ?? [];
    const fileChanges = items.filter(item => item.type === "fileChange");
    return {
      status: turn.status === "completed" ? 0 : 1,
      turnStatus: turn.status,
      turnStartedAt: turn.startedAt ?? null,
      turnEnded: ["completed", "failed", "interrupted"].includes(turn.status),
      turnEndedAt: typeof turn.completedAt === "number" && Number.isFinite(turn.completedAt) ? new Date(turn.completedAt * 1000).toISOString() : null,
      threadId,
      turnId: turn.id,
      finalMessage: items.filter(item => item.type === "agentMessage").at(-1)?.text ?? "",
      error: turn.error,
      stderr: turn.error?.message ?? "",
      reasoningSummary: items.filter(item => item.type === "reasoning").flatMap(item => extractReasoningSections(item.summary)),
      touchedFiles: collectTouchedFiles(fileChanges),
      commandExecutions: items.filter(item => item.type === "commandExecution")
    };
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
