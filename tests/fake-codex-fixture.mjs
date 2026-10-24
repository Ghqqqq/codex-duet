import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { writeExecutable } from "./helpers.mjs";

export function installFakeCodex(binDir, behavior = "review-ok") {
  const statePath = path.join(binDir, "fake-codex-state.json");
  const scriptPath = path.join(binDir, "codex");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");

	const STATE_PATH = ${JSON.stringify(statePath)};
	const BEHAVIOR = ${JSON.stringify(behavior)};
	const interruptibleTurns = new Map();
  const loadedThreads = new Set();
  const serverRequests = new Map();

	function loadState() {
	  if (!fs.existsSync(STATE_PATH)) {
	    return { nextThreadId: 1, nextTurnId: 1, appServerStarts: 0, threads: [], capabilities: null, lastInterrupt: null };
	  }
	  return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
	}

function saveState(state) {
  const temporary = STATE_PATH + "." + process.pid + ".tmp";
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2));
  fs.renameSync(temporary, STATE_PATH);
}

function sendParentQuestion(threadId, turnId, index) {
  const callId = "fixture-call-" + index, id = "fixture-parent-request-" + index;
  const args = { question: index === 1 ? "Which fixture fallback?" : "Which fixture approach?", options: ["Small", "Broad"] };
  const item = { id: callId, type: "dynamicToolCall", namespace: null, tool: "ask_parent", arguments: args, status: "inProgress", contentItems: null, success: null };
  const request = { id, method: "item/tool/call", params: { threadId, turnId, callId, namespace: null, tool: "ask_parent", arguments: args } };
  const state = loadState();
  state.parentQuestionRequests = [...(state.parentQuestionRequests || []), request];
  state.parentQuestionItems = [...(state.parentQuestionItems || []), item];
  saveState(state);
  serverRequests.set(id, { threadId, turnId, questionItem: item, questionIndex: index });
  send({ method: "item/started", params: { threadId, turnId, item } });
  send(request);
}

function requiresExperimental(field, message, state) {
  if (!(field in (message.params || {}))) {
    return false;
  }
  return !state.capabilities || state.capabilities.experimentalApi !== true;
}

function now() {
  return Math.floor(Date.now() / 1000);
}

function buildThread(thread) {
  return {
    id: thread.id,
    preview: thread.preview || "",
    ephemeral: Boolean(thread.ephemeral),
    modelProvider: "openai",
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    status: { type: "idle" },
    path: null,
    cwd: thread.cwd,
    cliVersion: "fake-codex",
    source: "appServer",
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: thread.name || null,
    turns: []
  };
}

function threadSandbox(mode) {
  if (mode === "danger-full-access") return { type: "dangerFullAccess" };
  if (mode === "workspace-write") return { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
  return { type: "readOnly", networkAccess: false };
}

const turnStartedAt = new Map();
function buildTurn(id, status = "inProgress", error = null) {
  if (!turnStartedAt.has(id)) turnStartedAt.set(id, now());
  return { id, status, items: [], error, startedAt: turnStartedAt.get(id), completedAt: status === "inProgress" ? null : now() };
}

function buildAccountReadResult() {
  switch (BEHAVIOR) {
    case "logged-out":
    case "refreshable-auth":
    case "auth-run-fails":
      return { account: null, requiresOpenaiAuth: true };
    case "provider-no-auth":
    case "env-key-provider":
      return { account: null, requiresOpenaiAuth: false };
    case "api-key-account-only":
      return { account: { type: "apiKey" }, requiresOpenaiAuth: true };
    default:
      return {
        account: { type: "chatgpt", email: "test@example.com", planType: "plus" },
        requiresOpenaiAuth: true
      };
  }
}

function buildConfigReadResult() {
  switch (BEHAVIOR) {
    case "provider-no-auth":
      return {
        config: { model_provider: "ollama" },
        origins: {}
      };
    case "env-key-provider":
      return {
        config: {
          model_provider: "openai-custom",
          model_providers: {
            "openai-custom": {
              name: "OpenAI custom",
              env_key: "OPENAI_API_KEY",
              requires_openai_auth: false
            }
          }
        },
        origins: {}
      };
    default:
      return {
        config: { model_provider: "openai" },
        origins: {}
      };
  }
}

let outputQueue = Promise.resolve();
function send(message) {
  if (message.method === "item/completed") {
    const key = message.params.turnId;
    capturedItems.set(key, [...(capturedItems.get(key) || []), message.params.item]);
  }
  if (message.method === "turn/started" || message.method === "turn/completed") {
    const saved = loadState();
    const thread = saved.threads.find(t => t.id === message.params.threadId);
    if (thread) {
      const turn = { ...message.params.turn, items: capturedItems.get(message.params.turn.id) || [] };
      thread.turns = [...(thread.turns || []).filter(t => t.id !== turn.id), turn];
      saveState(saved);
    }
  }
  if (BEHAVIOR === "large-jsonl") {
    const output = Buffer.from(JSON.stringify(message) + "\\r\\n");
    // Preserve wire order while deliberately splitting a UTF-8 separator and
    // the CRLF terminator. Large records also span many pipe/socket reads.
    outputQueue = outputQueue.then(async () => {
      const separator = output.indexOf(Buffer.from("\\u2028"));
      const cuts = separator >= 0 ? [separator + 1, separator + 2, output.length - 1, output.length] : [output.length];
      let start = 0;
      for (const end of cuts) {
        await new Promise(resolve => process.stdout.write(output.subarray(start, end), resolve));
        start = end;
      }
    });
  } else process.stdout.write(JSON.stringify(message) + "\\n");
}
const capturedItems = new Map();

function nextThread(state, cwd, ephemeral) {
  const thread = {
    id: "thr_" + state.nextThreadId++,
    cwd: cwd || process.cwd(),
    name: null,
    preview: "",
    ephemeral: Boolean(ephemeral),
    createdAt: now(),
    updatedAt: now()
  };
  state.threads.unshift(thread);
  saveState(state);
  return thread;
}

function ensureThread(state, threadId) {
  const thread = state.threads.find((candidate) => candidate.id === threadId);
  if (!thread) {
    throw new Error("unknown thread " + threadId);
  }
  return thread;
}

function nextTurnId(state) {
  const turnId = "turn_" + state.nextTurnId++;
  saveState(state);
  return turnId;
}

function importLedgerPath() {
  return path.join(process.env.CODEX_HOME || path.join(process.env.HOME, ".codex"), "external_agent_session_imports.json");
}

function loadImportLedger() {
  const ledgerPath = importLedgerPath();
  return fs.existsSync(ledgerPath) ? JSON.parse(fs.readFileSync(ledgerPath, "utf8")) : { records: [] };
}

function saveImportLedger(ledger) {
  const ledgerPath = importLedgerPath();
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
}

function emitTurnCompleted(threadId, turnId, item) {
  const items = Array.isArray(item) ? item : [item];
  send({ method: "turn/started", params: { threadId, turn: buildTurn(turnId) } });
  for (const entry of items) {
    if (entry && entry.started) {
      send({ method: "item/started", params: { threadId, turnId, item: entry.started } });
    }
    if (entry && entry.completed) {
      send({ method: "item/completed", params: { threadId, turnId, item: entry.completed } });
    }
  }
  send({ method: "turn/completed", params: { threadId, turn: buildTurn(turnId, "completed") } });
}

function emitTurnCompletedLater(threadId, turnId, item, delayMs) {
  setTimeout(() => {
    emitTurnCompleted(threadId, turnId, item);
  }, delayMs);
}

function nativeReviewText(target) {
  if (target.type === "baseBranch") {
    return "Reviewed changes against " + target.branch + ".\\nNo material issues found.";
  }
  if (target.type === "custom") {
    return "Reviewed custom target.\\nNo material issues found.";
  }
  return "Reviewed uncommitted changes.\\nNo material issues found.";
}

function structuredReviewPayload(prompt) {
  if (prompt.includes("adversarial software review")) {
    if (BEHAVIOR === "adversarial-clean") {
      return JSON.stringify({
        verdict: "approve",
        summary: "No material issues found.",
        findings: [],
        next_steps: []
      });
    }

    return JSON.stringify({
      verdict: "needs-attention",
      summary: "One adversarial concern surfaced.",
      findings: [
        {
          severity: "high",
          title: "Missing empty-state guard",
          body: "The change assumes data is always present.",
          file: "src/app.js",
          line_start: 4,
          line_end: 6,
          confidence: 0.87,
          recommendation: "Handle empty collections before indexing."
        }
      ],
      next_steps: ["Add an empty-state test."]
    });
  }

  if (BEHAVIOR === "invalid-json") {
    return "not valid json";
  }

  return JSON.stringify({
    verdict: "approve",
    summary: "No material issues found.",
    findings: [],
    next_steps: []
  });
}

function taskPayload(prompt, resume) {
  if (BEHAVIOR === "question-only") return "Which database should I use?";
  if (BEHAVIOR === "unfinished-task") return "I will inspect the repository and then implement the change.";
  if (BEHAVIOR === "verbose-task") return Array.from({ length: 300 }, (_, i) => "Finding " + i + ": details from Codex").join("\\n");
  if (prompt.includes("<task>") && prompt.includes("Only review the work from the previous Claude turn.")) {
    if (BEHAVIOR === "adversarial-clean") {
      return "ALLOW: No blocking issues found in the previous turn.";
    }
    return "BLOCK: Missing empty-state guard in src/app.js:4-6.";
  }

  if (resume || prompt.includes("Continue from the current thread state") || prompt.includes("follow up")) {
    return "Resumed the prior run.\\nFollow-up prompt accepted.";
  }

  return "Handled the requested task.\\nTask prompt accepted.";
}

// The worker-report schema wraps the prose above as the summary. question-only
// declares needs_input; unfinished-task over-claims completed, which the parent
// must still catch from the summary; structured-blocked declares its blocker.
function structuredTaskPayload(text) {
  if (BEHAVIOR === "structured-blocked") {
    return JSON.stringify({ status: "blocked", summary: "Stopped: the fixture dependency is unavailable.\\nPRIVATE_FIXTURE_DETAIL", key_findings: ["Dependency missing"], assumptions: [], verification: [], blockers: [{ code: "missing_dependency", message: "fixture-dep is not installed", app: null, tab_id: null, session_id: null }], question: null });
  }
  const status = BEHAVIOR === "question-only" ? "needs_input" : "completed";
  return JSON.stringify({ status, summary: text, key_findings: ["Fixture finding one", "Fixture finding two"], assumptions: ["Fixture assumption"], verification: status === "completed" ? ["fixture check: passed"] : [], blockers: [], question: status === "needs_input" ? text : null });
}

const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("codex-cli test");
  process.exit(0);
}
if (args[0] === "app-server" && args[1] === "--help") {
  console.log("fake app-server help");
  process.exit(0);
}
if (args[0] === "login" && args[1] === "status") {
  if (BEHAVIOR === "logged-out" || BEHAVIOR === "refreshable-auth" || BEHAVIOR === "auth-run-fails" || BEHAVIOR === "provider-no-auth" || BEHAVIOR === "env-key-provider" || BEHAVIOR === "api-key-account-only") {
    console.error("not authenticated");
    process.exit(1);
  }
  console.log("logged in");
  process.exit(0);
}
if (args[0] === "login") {
  process.exit(0);
}
if (args[0] !== "app-server") {
  process.exit(1);
}
const bootState = loadState();
bootState.appServerStarts = (bootState.appServerStarts || 0) + 1;
bootState.launches = [...(bootState.launches || []), { pid: process.pid, home: process.env.CODEX_HOME, sqlite: process.env.CODEX_SQLITE_HOME, args }];

function readComputerUse(home, threadId) {
  const readFile = file => { try { return fs.readFileSync(file, "utf8"); } catch { return null; } };
  return home ? { session: readFile(path.join(home, "computer-use", "sessions", threadId + ".toml")), global: readFile(path.join(home, "computer-use", "config.toml")) } : null;
}
saveState(bootState);

process.stdin.setEncoding("utf8");
let inputBuffer = "";
process.stdin.on("data", chunk => {
  inputBuffer += chunk;
  for (let end; (end = inputBuffer.indexOf("\\n")) !== -1;) {
    const line = inputBuffer.slice(0, end);
    inputBuffer = inputBuffer.slice(end + 1);
    void handleLine(line);
  }
});
async function handleLine(line) {
  if (!line.trim()) {
    return;
  }

  const message = JSON.parse(line);
  if (["turn/start", "review/start", "turn/interrupt", "thread/resume", "thread/read", "thread/backgroundTerminals/clean"].includes(message.method)) {
    const params = ["turn/start", "review/start"].includes(message.method) ? { threadId: message.params.threadId } : message.params;
    fs.appendFileSync(STATE_PATH + ".requests.jsonl", JSON.stringify({ serverId: process.pid, method: message.method, params }) + "\\n");
  }
  const state = loadState();

  try {
    if (message.method === undefined && serverRequests.has(message.id)) {
      const pending = serverRequests.get(message.id);
      serverRequests.delete(message.id);
      // What node_repl would see right after this reply: the thread's and the
      // isolated home's Computer Use approval files.
      state.serverRequestReplies = [...(state.serverRequestReplies || []), { ...message, computerUse: readComputerUse(process.env.CODEX_HOME, pending.threadId) }];
      saveState(state);
      if (pending.questionItem) {
        send({ method: "item/completed", params: { threadId: pending.threadId, turnId: pending.turnId,
          item: { ...pending.questionItem, status: "completed", success: true, contentItems: message.result.contentItems } } });
        if (pending.questionIndex === 1) { sendParentQuestion(pending.threadId, pending.turnId, 2); return; }
      }
      if (!serverRequests.size && state.lastInterrupt?.turnId !== pending.turnId) emitTurnCompleted(pending.threadId, pending.turnId, { completed: { type: "agentMessage", id: "approval-result", text: "Completed fixture request handling.", phase: "final_answer" } });
      return;
    }
    switch (message.method) {
      case "initialize":
        if (state.unreachable) throw new Error("Fixture server unreachable");
        if (BEHAVIOR === "w5-initialize-hang") break;
        state.capabilities = message.params.capabilities || null;
        saveState(state);
        send({ id: message.id, result: { userAgent: "fake-codex-app-server" } });
        break;

      case "initialized":
        break;

      case "account/read":
        if (BEHAVIOR.startsWith("auth-error:")) throw new Error(BEHAVIOR.slice("auth-error:".length));
        send({ id: message.id, result: buildAccountReadResult() });
        break;

      case "config/read":
        if (BEHAVIOR === "config-read-fails") {
          throw new Error("config/read failed for cwd");
        }
        send({ id: message.id, result: buildConfigReadResult() });
        break;

      case "thread/read": {
        if (BEHAVIOR.startsWith("lost-turn:")) {
          state.turnReads = [...(state.turnReads || []), message.params];
          saveState(state);
          if (BEHAVIOR === "lost-turn:unreadable" || state.unreadable) throw new Error("Recorded turn unavailable in fixture");
        }
        const thread = ensureThread(state, message.params.threadId);
        send({ id: message.id, result: { thread: { ...buildThread(thread), turns: thread.turns || [] } } });
        break;
      }

      case "thread/start": {
        if (BEHAVIOR === "lost-turn:startup") { process.exit(0); break; }
        if (BEHAVIOR === "auth-run-fails") {
          throw new Error("authentication expired; run codex login");
        }
        if (requiresExperimental("persistExtendedHistory", message, state) || requiresExperimental("persistFullHistory", message, state)) {
          throw new Error("thread/start.persistFullHistory requires experimentalApi capability");
        }
        const thread = nextThread(state, message.params.cwd, message.params.ephemeral);
        loadedThreads.add(thread.id);
        state.lastThreadStart = message.params;
        thread.sandbox = threadSandbox(message.params.sandbox);
        saveState(state);
        send({ id: message.id, result: { thread: buildThread(thread), model: message.params.model || "gpt-5.4", modelProvider: "openai", serviceTier: null, cwd: thread.cwd, approvalPolicy: "never", sandbox: thread.sandbox, reasoningEffort: null } });
        send({ method: "thread/started", params: { thread: { id: thread.id } } });
        break;
      }

      case "thread/name/set": {
        const thread = ensureThread(state, message.params.threadId);
        thread.name = message.params.name;
        thread.updatedAt = now();
        saveState(state);
        send({ id: message.id, result: {} });
        break;
      }

      case "thread/list": {
        let threads = state.threads.slice();
        if (message.params.cwd) {
          threads = threads.filter((thread) => thread.cwd === message.params.cwd);
        }
        if (message.params.searchTerm) {
          threads = threads.filter((thread) => (thread.name || "").includes(message.params.searchTerm));
        }
        threads.sort((left, right) => right.updatedAt - left.updatedAt);
        send({ id: message.id, result: { data: threads.map(buildThread), nextCursor: null } });
        break;
      }

      case "thread/resume": {
        if (requiresExperimental("persistExtendedHistory", message, state) || requiresExperimental("persistFullHistory", message, state)) {
          throw new Error("thread/resume.persistFullHistory requires experimentalApi capability");
        }
        const thread = ensureThread(state, message.params.threadId);
        loadedThreads.add(thread.id);
        state.lastThreadResume = message.params;
        thread.sandbox = threadSandbox(message.params.sandbox);
        thread.updatedAt = now();
        saveState(state);
        send({ id: message.id, result: { thread: buildThread(thread), model: message.params.model || "gpt-5.4", modelProvider: "openai", serviceTier: null, cwd: thread.cwd, approvalPolicy: "never", sandbox: thread.sandbox, reasoningEffort: null } });
        break;
      }

      case "externalAgentConfig/import": {
        const importId = "import_" + ((state.externalAgentImports || []).length + 1);
        state.externalAgentImports = [...(state.externalAgentImports || []), { importId, params: message.params }];
        saveState(state);
        if (BEHAVIOR === "external-import-unsupported") {
          send({ id: message.id, error: { code: -32601, message: "Unsupported method: externalAgentConfig/import" } });
          break;
        }
        const success = { itemType: "SESSIONS", successes: [{ itemType: "SESSIONS", cwd: null, source: null, target: null }], failures: [] };
        if (BEHAVIOR === "external-import-fails" || BEHAVIOR === "external-import-no-ledger") {
          send({ id: message.id, result: { importId } });
          send({ method: "externalAgentConfig/import/completed", params: { importId, itemTypeResults: [BEHAVIOR === "external-import-fails"
            ? { itemType: "SESSIONS", successes: [], failures: [{ itemType: "SESSIONS", failureStage: "conversion", message: "Synthetic transcript conversion failed", errorType: null, subErrorType: null, source: null, cwd: null }] }
            : success] } });
          break;
        }
        const sessions = (message.params.migrationItems || [])
          .flatMap((item) => item.details && Array.isArray(item.details.sessions) ? item.details.sessions : []);
        const session = sessions[0];
        if (!session) {
          throw new Error("missing external session migration");
        }
        const sourcePath = fs.realpathSync(session.path);
        const contents = fs.readFileSync(sourcePath, "utf8");
        const latestImport = state.externalAgentImports.at(-1);
        latestImport.sourcePath = sourcePath;
        latestImport.sourceMode = fs.statSync(sourcePath).mode & 0o777;
        latestImport.directoryMode = fs.statSync(path.dirname(sourcePath)).mode & 0o777;
        if (BEHAVIOR === "external-import-early" && process.env.CODEX_COMPANION_TRANSCRIPT_PATH) {
          fs.appendFileSync(process.env.CODEX_COMPANION_TRANSCRIPT_PATH, JSON.stringify({ type: "user", message: { content: "Appended during import" } }) + "\\n");
        }
        const contentSha256 = crypto.createHash("sha256").update(contents).digest("hex");
        const ledger = loadImportLedger();
        let record = ledger.records.find(
          (candidate) => candidate.source_path === sourcePath && candidate.content_sha256 === contentSha256
        );
        let thread;
        if (record) {
          thread = ensureThread(state, record.imported_thread_id);
        } else {
          const records = contents.split(/\\r?\\n/).filter(Boolean).map((line) => JSON.parse(line));
          const title = records.find((entry) => entry.type === "custom-title")?.customTitle || null;
          const messages = records
            .filter((entry) => entry.type === "user" || entry.type === "assistant")
            .map((entry) => ({ role: entry.type, text: entry.message?.content || "" }));
          thread = nextThread(state, session.cwd, false);
          thread.name = title;
          thread.preview = messages.find((entry) => entry.role === "user")?.text || "";
          thread.visibleMessages = messages;
          state.lastExternalAgentImport = { sourcePath, threadId: thread.id, messages, importId };
          record = {
            source_path: sourcePath,
            content_sha256: contentSha256,
            imported_thread_id: thread.id,
            imported_at: now(),
            source_modified_at: null
          };
          ledger.records.push(record);
          saveState(state);
          saveImportLedger(ledger);
        }
        // Another import's completion must never satisfy the current request,
        // even when both completions precede its response.
        send({ method: "externalAgentConfig/import/completed", params: { importId: "unrelated-import", itemTypeResults: [] } });
        const completed = { method: "externalAgentConfig/import/completed", params: { importId, itemTypeResults: [success] } };
        if (BEHAVIOR === "external-import-early") send(completed);
        send({ id: message.id, result: { importId } });
        if (BEHAVIOR !== "external-import-early") send(completed);
        break;
      }

      case "review/start": {
        const thread = ensureThread(state, message.params.threadId);
        let reviewThread = thread;
        if (message.params.delivery === "detached") {
          reviewThread = nextThread(state, thread.cwd, true);
          send({ method: "thread/started", params: { thread: { id: reviewThread.id } } });
        }
        const turnId = nextTurnId(state);
        send({ id: message.id, result: { turn: buildTurn(turnId), reviewThreadId: reviewThread.id } });
        if (BEHAVIOR === "w5-review") {
          saveState(state);
          const timer = setTimeout(() => emitTurnCompleted(reviewThread.id, turnId, []), 30000);
          interruptibleTurns.set(turnId, { threadId: reviewThread.id, timer });
          break;
        }
        emitTurnCompleted(reviewThread.id, turnId, [
          {
            started: { type: "enteredReviewMode", id: turnId, review: "current changes" }
          },
          ...(BEHAVIOR === "with-reasoning"
            ? [
                {
                  completed: {
                    type: "reasoning",
                    id: "reasoning_" + turnId,
                    summary: [{ text: "Reviewed the changed files and checked the likely regression paths." }],
                    content: []
                  }
                }
              ]
            : []),
          {
            completed: { type: "exitedReviewMode", id: turnId, review: nativeReviewText(message.params.target) }
          }
        ]);
        break;
      }

	      case "turn/start": {
	        const thread = ensureThread(state, message.params.threadId);
	        const prompt = (message.params.input || [])
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("\\n");
        const turnId = nextTurnId(state);
        thread.updatedAt = now();
	        state.lastTurnStart = {
	          threadId: message.params.threadId,
	          turnId,
	          model: message.params.model ?? null,
	          effort: message.params.effort ?? null,
          serviceTier: message.params.serviceTier,
          sandboxPolicy: message.params.sandboxPolicy,
          approvalPolicy: message.params.approvalPolicy,
          outputSchema: message.params.outputSchema ?? null,
	          prompt,
          // What node_repl would see at this moment: the isolated home's
          // Computer Use approval files for this thread and globally.
          computerUse: readComputerUse(process.env.CODEX_HOME, thread.id)
	        };
	        saveState(state);

        // Model requests within one turn report separate last breakdowns.
        // Keep cumulative thread history and exercise updates on both sides
        // of the turn/start response (the first update must be buffered).
        thread.tokenUsage ??= { inputTokens: 1000, cachedInputTokens: 300, cacheWriteInputTokens: 0,
          outputTokens: 200, reasoningOutputTokens: 60, totalTokens: 1200 };
        const emitUsage = last => {
          thread.tokenUsage = Object.fromEntries(Object.entries(last).map(([key, value]) => [key, thread.tokenUsage[key] + value]));
          saveState(state);
          send({ method: "thread/tokenUsage/updated", params: { threadId: thread.id, turnId,
            tokenUsage: { last, total: thread.tokenUsage, modelContextWindow: 128000 } } });
        };
        emitUsage({ inputTokens: 100, cachedInputTokens: 30, cacheWriteInputTokens: 0,
          outputTokens: 20, reasoningOutputTokens: 6, totalTokens: 120 });
	        send({ id: message.id, result: { turn: buildTurn(turnId) } });
        emitUsage({ inputTokens: 50, cachedInputTokens: 10, cacheWriteInputTokens: 0,
          outputTokens: 10, reasoningOutputTokens: 4, totalTokens: 60 });

        if (BEHAVIOR === "large-jsonl") {
          emitTurnCompleted(thread.id, turnId, { completed: { type: "agentMessage", id: "large-message", text: prompt, phase: "final_answer" } });
          break;
        }

        if (BEHAVIOR === "computer-use-requests") {
          // node_repl's elicitation for an app that has no persisted approval.
          const id = "fixture-cua-request";
          serverRequests.set(id, { threadId: thread.id, turnId });
          send({ method: "turn/started", params: { threadId: thread.id, turn: buildTurn(turnId) } });
          send({ id, method: "mcpServer/elicitation/request", params: { serverName: "node_repl", threadId: thread.id, turnId, mode: "form", message: "DO_NOT_LOG_FIXTURE", requestedSchema: { type: "object", properties: {} }, _meta: { codex_approval_kind: "mcp_tool_call", connector_id: "computer-use", connector_name: "Computer Use", persist: ["session", "always"], riskLevel: "medium", tool_name: "get_app_state", tool_params: { app: "com.google.Chrome" }, tool_params_display: "DO_NOT_LOG_FIXTURE" } } });
          break;
        }

        if (BEHAVIOR === "computer-use-denied") {
          // Codex resolved the elicitation itself; the tool call failed.
          send({ method: "turn/started", params: { threadId: thread.id, turn: buildTurn(turnId) } });
          const tool = { id: "cua-call", type: "mcpToolCall", server: "node_repl", tool: "js", status: "inProgress", arguments: { code: "PRIVATE_FIXTURE_ARGUMENTS" } };
          send({ method: "item/started", params: { threadId: thread.id, turnId, item: tool } });
          send({ method: "item/completed", params: { threadId: thread.id, turnId, item: { ...tool, status: "failed", error: { message: "Error: Computer Use was not approved to use Google Chrome\\n    at PRIVATE_FIXTURE_STACK" } } } });
          emitTurnCompleted(thread.id, turnId, { completed: { type: "agentMessage", id: "cua-final", text: "Blocked before capture: Chrome could not be used.\\nPRIVATE_FIXTURE_DETAIL", phase: "final_answer" } });
          break;
        }

        if (BEHAVIOR === "w9-feed") {
          send({ method: "turn/started", params: { threadId: thread.id, turn: buildTurn(turnId) } });
          const event = (method, item) => send({ method, params: { threadId: thread.id, turnId, item } });
          const command = { id: "feed-command", type: "commandExecution", command: "npm test TOKEN=SHOWN_FIXTURE_TOKEN https://user:SHOWN_FIXTURE_PASSWORD@example.com?token=SHOWN_FIXTURE_QUERY", status: "inProgress" };
          event("item/started", command);
          {
            event("item/completed", { ...command, status: "completed", exitCode: 0, durationMs: 425, aggregatedOutput: "PRIVATE_FIXTURE_OUTPUT" });
            event("item/completed", { id: "feed-message", type: "agentMessage", text: "Inspecting the fixture. PASSWORD=SHOWN_FIXTURE_MESSAGE " + "x".repeat(350), phase: "commentary" });
            event("item/completed", { id: "feed-file", type: "fileChange", changes: [{ path: "src/example.mjs", kind: { type: "update" }, diff: "PRIVATE_FIXTURE_DIFF" }] });
          }
          {
            for (const type of ["mcpToolCall", "dynamicToolCall"]) {
              const tool = { id: type, type, server: "fixture", tool: "inspect", status: "inProgress", arguments: { page: "PRIVATE_FIXTURE_ARGUMENTS" } };
              event("item/started", tool);
              event("item/completed", { ...tool, status: "completed", durationMs: 10, result: { text: "PRIVATE_FIXTURE_PAGE" }, contentItems: [{ text: "PRIVATE_FIXTURE_CONTENT" }] });
            }
            send({ method: "turn/plan/updated", params: { threadId: thread.id, turnId, plan: [{ step: "Inspect fixture", status: "completed" }, { step: "Verify " + "long title ".repeat(20), status: "pending" }] } });
          }
          const timer = null; // Held open until an explicit fixture release or turn/interrupt.
          interruptibleTurns.set(turnId, { threadId: thread.id, timer });
          if (process.env.CODEX_FIXTURE_TURN_GATE) {
            while (!fs.existsSync(process.env.CODEX_FIXTURE_TURN_GATE)) await new Promise(resolve => setTimeout(resolve, 25));
            clearTimeout(timer);
            interruptibleTurns.delete(turnId);
            emitTurnCompleted(thread.id, turnId, { completed: { type: "agentMessage", id: "fixture-done", text: "Completed fixture work.", phase: "final_answer" } });
          }
          break;
        }

        if (BEHAVIOR === "parent-question-sequence") {
          send({ method: "turn/started", params: { threadId: thread.id, turn: buildTurn(turnId) } });
          sendParentQuestion(thread.id, turnId, 1);
          interruptibleTurns.set(turnId, { threadId: thread.id, timer: null });
          break;
        }

        if (BEHAVIOR === "w5-parent" || BEHAVIOR === "w5-working") {
          send({ method: "turn/started", params: { threadId: thread.id, turn: buildTurn(turnId) } });
          send({ method: "mcpServer/startupStatus/updated", params: { name: "fixture", status: "ready", threadId: thread.id } });
          process.stderr.write("WebSocket timeout; retrying; falling back to HTTP\\n");
          send({ method: "item/started", params: { threadId: thread.id, turnId, item: { id: "fixture-command", type: "commandExecution", command: "npm test TOKEN=SHOWN_FIXTURE_ARGUMENT", status: "inProgress" } } });
          send({ method: "item/completed", params: { threadId: thread.id, turnId, item: { id: "fixture-command", type: "commandExecution", command: "npm test TOKEN=SHOWN_FIXTURE_ARGUMENT", exitCode: 0, status: "completed", aggregatedOutput: "PRIVATE_FIXTURE_OUTPUT" } } });
          send({ method: "turn/plan/updated", params: { threadId: thread.id, turnId, plan: [{ step: "Inspect fixture", status: "completed" }] } });
          if (BEHAVIOR === "w5-parent") {
            const id = "fixture-parent-request";
            serverRequests.set(id, { threadId: thread.id, turnId });
            send({ id, method: "item/tool/call", params: { threadId: thread.id, turnId, callId: "fixture-call", tool: "ask_parent", arguments: { question: "Which fixture approach?", options: ["Small", "Broad"] } } });
          }
          const timer = null; // Held open until an explicit fixture release or turn/interrupt.
          interruptibleTurns.set(turnId, { threadId: thread.id, timer });
          break;
        }

        if (BEHAVIOR === "server-requests") {
          const base = { itemId: "fixture-item", threadId: thread.id, turnId, startedAtMs: 0, command: null, reason: "DO_NOT_LOG_FIXTURE", networkApprovalContext: { protocol: "https", host: "EXAMPLE.COM:443" } };
          const requests = [
            { method: "item/commandExecution/requestApproval", params: base },
            { method: "item/commandExecution/requestApproval", params: { ...base, networkApprovalContext: { protocol: "https", host: "other.example" } } },
            { method: "item/commandExecution/requestApproval", params: { ...base, command: "DO_NOT_LOG_FIXTURE" } },
            { method: "item/commandExecution/requestApproval", params: { ...base, networkApprovalContext: { protocol: "https", host: "example.com/private" } } },
            { method: "mcpServer/elicitation/request", params: { serverName: "cua_repl", threadId: thread.id, turnId, mode: "form", message: "DO_NOT_LOG_FIXTURE", requestedSchema: { type: "object", properties: {} }, _meta: { origin: "https://example.com", tool_name: "access_browser_origin" } } },
            { method: "item/permissions/requestApproval", params: { threadId: thread.id, turnId, permissions: { network: { enabled: true } }, reason: "DO_NOT_LOG_FIXTURE" } },
            { method: "item/tool/requestUserInput", params: { threadId: thread.id, turnId, questions: ["DO_NOT_LOG_FIXTURE"] } },
            { method: "item/fileChange/requestApproval", params: { threadId: thread.id, turnId, reason: "DO_NOT_LOG_FIXTURE" } }
          ];
          for (const [index, request] of requests.entries()) {
            const id = "fixture-request-" + index;
            serverRequests.set(id, { threadId: thread.id, turnId });
            send({ id, ...request });
          }
          break;
        }

        if (BEHAVIOR === "dirty-workspace-task") {
          for (let i = 0; i < 26; i++) fs.appendFileSync(path.join(thread.cwd, "file-" + i + ".txt"), "worker edit\\n");
          // Deliberately emits no fileChange events: shell writes need snapshots.
        }

        const schemaProperties = (message.params.outputSchema && message.params.outputSchema.properties) || {};
        const payload = schemaProperties.verdict
          ? structuredReviewPayload(prompt)
          : schemaProperties.status
            ? structuredTaskPayload(taskPayload(prompt, thread.name && thread.name.startsWith("Codex Companion Task") && prompt.includes("Continue from the current thread state")))
            : taskPayload(prompt, thread.name && thread.name.startsWith("Codex Companion Task") && prompt.includes("Continue from the current thread state"));

        if (
          BEHAVIOR === "with-subagent" ||
          BEHAVIOR === "with-late-subagent-message" ||
          BEHAVIOR === "with-subagent-no-main-turn-completed"
        ) {
          const subThread = nextThread(state, thread.cwd, true);
          const subThreadRecord = ensureThread(state, subThread.id);
          subThreadRecord.name = "design-challenger";
          saveState(state);
          const subTurnId = nextTurnId(state);

          send({ method: "thread/started", params: { thread: { ...buildThread(subThreadRecord), name: "design-challenger", agentNickname: "design-challenger" } } });
          send({ method: "turn/started", params: { threadId: thread.id, turn: buildTurn(turnId) } });
          send({
            method: "item/started",
            params: {
              threadId: thread.id,
              turnId,
              item: {
                type: "collabAgentToolCall",
                id: "collab_" + turnId,
                tool: "wait",
                status: "inProgress",
                senderThreadId: thread.id,
                receiverThreadIds: [subThread.id],
                prompt: "Challenge the implementation approach",
                model: null,
                reasoningEffort: null,
                agentsStates: {
                  [subThread.id]: { status: "inProgress", message: "Investigating design tradeoffs" }
                }
              }
            }
          });
          if (BEHAVIOR === "with-late-subagent-message") {
            send({
              method: "item/completed",
              params: {
                threadId: thread.id,
                turnId,
                item: { type: "agentMessage", id: "msg_" + turnId, text: payload, phase: "final_answer" }
              }
            });
          }
          send({ method: "turn/started", params: { threadId: subThread.id, turn: buildTurn(subTurnId) } });
          send({
            method: "item/completed",
            params: {
              threadId: subThread.id,
              turnId: subTurnId,
              item: {
                type: "reasoning",
                id: "reasoning_" + subTurnId,
                summary: [{ text: "Questioned the retry strategy and the cache invalidation boundaries." }],
                content: []
              }
            }
          });
          send({
            method: "item/completed",
            params: {
              threadId: subThread.id,
              turnId: subTurnId,
              item: {
                type: "agentMessage",
                id: "msg_" + subTurnId,
                text: "The design assumes retries are harmless, but they can duplicate side effects without stronger idempotency guarantees.",
                phase: "analysis"
              }
            }
          });
          send({ method: "turn/completed", params: { threadId: subThread.id, turn: buildTurn(subTurnId, "completed") } });
          send({
            method: "item/completed",
            params: {
              threadId: thread.id,
              turnId,
              item: {
                type: "collabAgentToolCall",
                id: "collab_" + turnId,
                tool: "wait",
                status: "completed",
                senderThreadId: thread.id,
                receiverThreadIds: [subThread.id],
                prompt: "Challenge the implementation approach",
                model: null,
                reasoningEffort: null,
                agentsStates: {
                  [subThread.id]: { status: "completed", message: "Finished" }
                }
              }
            }
          });
          if (BEHAVIOR !== "with-late-subagent-message") {
            send({
              method: "item/completed",
              params: {
                threadId: thread.id,
                turnId,
                item: { type: "agentMessage", id: "msg_" + turnId, text: payload, phase: "final_answer" }
              }
            });
          }
          if (BEHAVIOR !== "with-subagent-no-main-turn-completed") {
            send({ method: "turn/completed", params: { threadId: thread.id, turn: buildTurn(turnId, "completed") } });
          }
          break;
        }

        const items = [
          ...(BEHAVIOR === "with-reasoning"
            ? [
                {
                  completed: {
                    type: "reasoning",
                    id: "reasoning_" + turnId,
                    summary: [{ text: "Inspected the prompt, gathered evidence, and checked the highest-risk paths first." }],
                    content: []
                  }
              }
            ]
            : []),
          {
            completed: { type: "agentMessage", id: "msg_" + turnId, text: payload, phase: "final_answer" }
          }
        ];

	        if (BEHAVIOR.startsWith("lost-turn:") && turnId === "turn_1") {
            send({ method: "turn/started", params: { threadId: thread.id, turn: buildTurn(turnId) } });
            for (let i = 1; i <= 36; i++) send({ method: "item/completed", params: { threadId: thread.id, turnId,
              item: { type: "agentMessage", id: "progress_" + i, text: "Fixture progress " + i, phase: "commentary" } } });
            // Keep the exact-turn state. Owner-stop stays attached until Duet
            // disconnects; other lost-turn modes lose delivery immediately.
            const saved = loadState();
            const persisted = ensureThread(saved, thread.id).turns.find(turn => turn.id === turnId);
            const status = BEHAVIOR === "lost-turn:owner-stop" ? "inProgress" : BEHAVIOR.slice("lost-turn:".length);
            Object.assign(persisted, { status: status === "unreadable" ? "completed" : status,
              completedAt: status === "inProgress" ? null : now(),
              items: status === "inProgress" ? [] : items.map(entry => entry.completed).filter(Boolean),
              error: status === "failed" ? { message: "Fixture worker failed" } : null });
            saveState(saved);
            if (BEHAVIOR === "lost-turn:owner-stop") interruptibleTurns.set(turnId, { threadId: thread.id, timer: null });
            else setTimeout(() => process.exit(0), 60);
            break;
          }

	        if (BEHAVIOR === "interruptible-slow-task") {
	          send({ method: "turn/started", params: { threadId: thread.id, turn: buildTurn(turnId) } });
	          interruptibleTurns.set(turnId, { threadId: thread.id, timer: null });
	        } else if (BEHAVIOR === "slow-recovery-task") {
            send({ method: "turn/started", params: { threadId: thread.id, turn: buildTurn(turnId) } });
            const gate = process.env.CODEX_FIXTURE_TURN_GATE;
            if (gate) {
              while (!fs.existsSync(gate)) await new Promise(resolve => setTimeout(resolve, 25));
              emitTurnCompleted(thread.id, turnId, items);
            } else emitTurnCompletedLater(thread.id, turnId, items, 2000);
	        } else if (BEHAVIOR === "slow-task") {
	          emitTurnCompletedLater(thread.id, turnId, items, 400);
	        } else {
	          emitTurnCompleted(thread.id, turnId, items);
	        }
	        break;
	      }

        case "thread/backgroundTerminals/clean": {
          ensureThread(state, message.params.threadId);
          const behavior = process.env.CODEX_FIXTURE_TERMINALS_CLEAN;
          if (behavior === "timeout") break;
          if (behavior === "unsupported") {
            send({ id: message.id, error: { code: -32601, message: "Method not found" } });
            break;
          }
          if (behavior === "unknown") throw new Error("Unknown method: thread/backgroundTerminals/clean");
          if (behavior === "failed") throw new Error("Fixture cleanup failed");
          send({ id: message.id, result: {} });
          break;
        }
	      case "turn/interrupt": {
          if (BEHAVIOR.startsWith("lost-turn:")) {
            if (!loadedThreads.has(message.params.threadId)) throw new Error("thread not loaded");
            const turn = ensureThread(state, message.params.threadId).turns.find(turn => turn.id === message.params.turnId);
            if (turn?.status === "inProgress" && !state.ignoreInterrupt) Object.assign(turn, { status: "interrupted", completedAt: now() });
          }
	        state.lastInterrupt = {
	          threadId: message.params.threadId,
	          turnId: message.params.turnId
	        };
	        saveState(state);
	        const pending = interruptibleTurns.get(message.params.turnId);
	        if (pending && !state.ignoreInterrupt) {
	          clearTimeout(pending.timer);
	          interruptibleTurns.delete(message.params.turnId);
	          send({
	            method: "turn/completed",
	            params: {
	              threadId: pending.threadId,
	              turn: buildTurn(message.params.turnId, "interrupted")
	            }
	          });
	        }
	        send({ id: message.id, result: {} });
	        break;
	      }

	      default:
	        send({ id: message.id, error: { code: -32601, message: "Unsupported method: " + message.method } });
        break;
    }
  } catch (error) {
    send({ id: message.id, error: { code: -32000, message: error.message } });
  }
}
`;
  writeExecutable(scriptPath, source);

  // On Windows, npm global binaries are invoked via .cmd wrappers.
  // Create a codex.cmd so the fake binary is discoverable by spawn with shell: true.
  if (process.platform === "win32") {
    const cmdWrapper = `@echo off\r\nnode "%~dp0codex" %*\r\n`;
    fs.writeFileSync(path.join(binDir, "codex.cmd"), cmdWrapper, { encoding: "utf8" });
  }
}

export function buildEnv(binDir) {
  const sep = process.platform === "win32" ? ";" : ":";
  return {
    ...process.env,
    HOME: path.join(binDir, "fixture-home"),
    USERPROFILE: path.join(binDir, "fixture-home"),
    CODEX_HOME: path.join(binDir, "fixture-home", ".codex"),
    CODEX_SQLITE_HOME: "",
    // Job state lives in the isolated home, so helper processes share the test
    // process's isolated home unless a fixture selects its own.
    CODEX_COMPANION_HOME: process.env.CODEX_COMPANION_HOME ?? "",
    CODEX_COMPANION_NORMAL_HOME: "",
    CODEX_COMPANION_NORMAL_SQLITE_HOME: "",
    CODEX_COMPANION_BIN: "",
    CODEX_COMPANION_APP_SERVER_ENDPOINT: "",
    CODEX_COMPANION_SESSION_ID: "",
    PATH: `${binDir}${sep}${process.env.PATH}`
  };
}

// Shared process/CLI fixture for lifecycle contracts across existing modules.
export async function lifecycleHarness() {
  const { default: assert } = await import("node:assert/strict");
const { default: fs } = await import("node:fs");
const { default: path } = await import("node:path");


const { makeTempDir, initGitRepo, run, requireLocalSockets } = await import("./helpers.mjs");

const { browserOriginSetup, transportSetup } = await import("../plugins/codex/scripts/lib/setup-config.mjs");
const { resolveIsolatedCodexHome } = await import("../plugins/codex/scripts/lib/codex-home.mjs");
const { redactActivity, itemActivity, planActivity, activityReader, formatActivity } = await import("../plugins/codex/scripts/lib/activity.mjs");
const { writeJobFile, upsertJob, updateJob, readJobFile, resolveJobFile, resolveStateDir } = await import("../plugins/codex/scripts/lib/state.mjs");
const { JobRuntime, pauseAdjustment, renewLease, markOwnerAttachment, leaseSnapshot, questionMessage, adoptJob, ownershipNotice, answerQuestion, askParentQuestion, ownerLost, directReport, progressSnapshot, PARENT_BRIDGE_ENV } = await import("../plugins/codex/scripts/lib/job-runtime.mjs");
const { buildWorkerReport } = await import("../plugins/codex/scripts/lib/worker-report.mjs");
const { resolveSessionMarkersRoot } = await import("../plugins/codex/scripts/lib/session-markers.mjs");
const { AGENT_NAMES, pickAgentName } = await import("../plugins/codex/scripts/lib/agent-names.mjs");
const { splitRawArgumentString } = await import("../plugins/codex/scripts/lib/args.mjs");
const bridgeScript = new URL("../plugins/codex/scripts/parent-bridge-mcp.mjs", import.meta.url).pathname;
const { spawnOwned } = await import("../plugins/codex/scripts/lib/process.mjs");
const script = new URL("../plugins/codex/scripts/codex-companion.mjs", import.meta.url).pathname;
const hook = new URL("../plugins/codex/scripts/session-lifecycle-hook.mjs", import.meta.url).pathname;
const brokerScript = new URL("../plugins/codex/scripts/app-server-broker.mjs", import.meta.url).pathname;
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } };
function fixture(behavior = "w5-working") {
  const dir = makeTempDir(), repo = path.join(dir, "repo"); fs.mkdirSync(repo); initGitRepo(repo); installFakeCodex(dir, behavior);
  const env = { ...buildEnv(dir), CLAUDE_PLUGIN_DATA: path.join(dir, "data"), CODEX_COMPANION_SESSION_ID: "fixture-session", CODEX_COMPANION_HOME: path.join(dir, "isolated") };
  return { dir, repo, env, call: (...args) => run(process.execPath, [script, ...args], { cwd: repo, env }), state: () => JSON.parse(fs.readFileSync(path.join(dir, "fake-codex-state.json"))), requests: () => fs.readFileSync(path.join(dir, "fake-codex-state.json.requests.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line)), answer: (job, id, text) => run(process.execPath, [script, "answer", job, "--question", id, "--json"], { cwd: repo, env, input: text }) };
}
function json(result, code = 0) { assert.equal(result.status, code, result.stderr + result.stdout); return JSON.parse(result.stdout); }
function directLines(stdout) {
  assert.ok(stdout.endsWith("\n"), "stdout ends with a newline");
  const lines = stdout.slice(0, -1).split("\n");
  assert.equal(lines.at(-1), JSON.stringify(JSON.parse(lines.at(-1))), "last line is compact JSON");
  for (const line of lines.slice(0, -1)) {
    assert.ok(line.length > 0 && line.length <= 200, "progress is compact and single-line");
    assert.ok(!line.startsWith("{"), "progress cannot be mistaken for JSON");
    assert.doesNotMatch(line, /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/, "progress has no terminal controls or embedded newlines");
  }
  return lines;
}
function direct(result, code = 0) {
  const payload = json({ ...result, stdout: directLines(result.stdout).at(-1) }, code);
  for (const key of ["activity", "activityOmitted", "cursor", "startupTimings", "currentItem", "completedItems", "questionMessage"]) assert.equal(Object.hasOwn(payload, key), false, key);
  return payload;
}
function directError(result) {
  const payload = json(result, 1);
  assert.equal(result.stdout.split("\n").length, 2, "exactly one error JSON line");
  assert.deepEqual(Object.keys(payload), ["status", "worker", "jobId", "summary", "next", "details"]);
  assert.equal(payload.status, "error"); assert.equal(typeof payload.summary, "string"); assert.ok(payload.summary.length);
  assert.equal(result.stderr, `${payload.summary}\n`);
  return payload;
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitUntil(fn) { for (const end = Date.now() + 60000; Date.now() < end;) { const result = fn(); if (result) return result; await delay(80); } throw new Error("Fixture deadline expired"); }
function patchJob(f, id, patch) {
  const module = new URL("../plugins/codex/scripts/lib/state.mjs", import.meta.url).href;
  const result = run(process.execPath, ["--input-type=module", "-e", `import { updateJob } from ${JSON.stringify(module)}; updateJob(process.cwd(), ${JSON.stringify(id)}, () => (${JSON.stringify(patch)}));`], { cwd: f.repo, env: f.env });
  assert.equal(result.status, 0, result.stderr);
}
function job(f, id) { return json(f.call("status", id, "--json")).job; }

return { fs, path, makeTempDir, initGitRepo, run, requireLocalSockets, buildEnv, installFakeCodex, browserOriginSetup, transportSetup, resolveIsolatedCodexHome, redactActivity, itemActivity, planActivity, activityReader, formatActivity, writeJobFile, upsertJob, updateJob, readJobFile, resolveJobFile, resolveStateDir, JobRuntime, pauseAdjustment, renewLease, markOwnerAttachment, leaseSnapshot, questionMessage, adoptJob, ownershipNotice, answerQuestion, askParentQuestion, ownerLost, directReport, progressSnapshot, PARENT_BRIDGE_ENV, buildWorkerReport, resolveSessionMarkersRoot, AGENT_NAMES, pickAgentName, splitRawArgumentString, bridgeScript, spawnOwned, script, hook, brokerScript, alive, fixture, json, directLines, direct, directError, delay, waitUntil, patchJob, job };
}
