/**
 * @typedef {Error & { data?: unknown, rpcCode?: number }} ProtocolError
 * @typedef {import("./app-server-protocol").AppServerMethod} AppServerMethod
 * @typedef {import("./app-server-protocol").AppServerNotification} AppServerNotification
 * @typedef {import("./app-server-protocol").AppServerNotificationHandler} AppServerNotificationHandler
 * @typedef {import("./app-server-protocol").ClientInfo} ClientInfo
 * @typedef {import("./app-server-protocol").CodexAppServerClientOptions} CodexAppServerClientOptions
 * @typedef {import("./app-server-protocol").InitializeCapabilities} InitializeCapabilities
 */
import fs from "node:fs";
import net from "node:net";
import process from "node:process";
import { spawnOwned as spawn } from "./process.mjs";
import readline from "node:readline";
import { parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { ensureBrokerSession, loadBrokerSession } from "./broker-lifecycle.mjs";
import { isolatedCodexArgs, isolatedCodexEnv, resolveCodexBinary, resolveCodexRuntimeIdentity, resolveIsolatedCodexHome } from "./codex-home.mjs";
import { stopOwnedProcessGroup } from "./process.mjs";
import { isParentQuestion } from "./job-runtime.mjs";
import { decideServerRequest, logServerRequest, normalizeBrowserOrigins, normalizeBundleIds } from "./server-requests.mjs";

const PLUGIN_MANIFEST_URL = new URL("../../.claude-plugin/plugin.json", import.meta.url);
const PLUGIN_MANIFEST = JSON.parse(fs.readFileSync(PLUGIN_MANIFEST_URL, "utf8"));

export const BROKER_ENDPOINT_ENV = "CODEX_COMPANION_APP_SERVER_ENDPOINT";
export const BROKER_BUSY_RPC_CODE = -32001;

/** @type {ClientInfo} */
const DEFAULT_CLIENT_INFO = {
  title: "Codex Plugin",
  name: "Claude Code",
  version: PLUGIN_MANIFEST.version ?? "0.0.0"
};

/** @type {InitializeCapabilities} */
const DEFAULT_CAPABILITIES = {
  experimentalApi: true,
  requestAttestation: false,
  optOutNotificationMethods: [
    "item/agentMessage/delta",
    "item/reasoning/summaryTextDelta",
    "item/reasoning/summaryPartAdded",
    "item/reasoning/textDelta"
  ]
};

function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

function createProtocolError(message, data) {
  const error = /** @type {ProtocolError} */ (new Error(message));
  error.data = data;
  if (data?.code !== undefined) {
    error.rpcCode = data.code;
  }
  return error;
}

function brokerClosedError() {
  return Object.assign(new Error("Codex broker connection closed during startup."), { code: "BROKER_CONNECTION_CLOSED" });
}

class AppServerClientBase {
  constructor(cwd, options = {}) {
    this.cwd = cwd;
    this.options = options;
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = "";
    this.closed = false;
    this.exitError = null;
    /** @type {AppServerNotificationHandler | null} */
    this.notificationHandler = null;
    this.lineBuffer = "";
    this.transport = "unknown";
    this.serverRequestHandler = null;
    this.serverRequestPolicy = { approvedBrowserOrigins: normalizeBrowserOrigins(options.approvedBrowserOrigins ?? []), approvedComputerApps: normalizeBundleIds(options.approvedComputerApps ?? []), threadId: null, turnId: null };
    this.abortHandler = () => { this.abortTimer ??= setTimeout(() => { void this.close(); }, 4500); };
    options.signal?.addEventListener("abort", this.abortHandler);

    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  setNotificationHandler(handler) {
    this.notificationHandler = handler;
  }

  /**
   * @template {AppServerMethod} M
   * @param {M} method
   * @param {import("./app-server-protocol").AppServerRequestParams<M>} params
   * @returns {Promise<import("./app-server-protocol").AppServerResponse<M>>}
   */
  request(method, params) {
    if (this.closed || this.exitResolved) {
      throw this.exitError ?? new Error("codex app-server client is closed.");
    }

    const id = this.nextId;
    this.nextId += 1;

    return new Promise((resolve, reject) => {
      const threadId = params && typeof params === "object" && "threadId" in params ? params.threadId : null;
      if (method === "turn/start") this.setServerRequestContext(threadId, null);
      this.pending.set(id, { resolve, reject, method, threadId });
      this.sendMessage({ id, method, params });
    });
  }

  notify(method, params = {}) {
    if (this.closed || this.exitResolved) {
      return;
    }
    this.sendMessage({ method, params });
  }

  handleChunk(chunk) {
    this.lineBuffer += chunk;
    let newlineIndex = this.lineBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.lineBuffer.slice(0, newlineIndex);
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
      this.handleLine(line);
      newlineIndex = this.lineBuffer.indexOf("\n");
    }
  }

  handleLine(line) {
    if (!line.trim()) {
      return;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.handleExit(createProtocolError(`Failed to parse codex app-server JSONL: ${error.message}`, { line }));
      return;
    }

    if (message.id !== undefined && message.method) {
      this.handleServerRequest(message);
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);

      if (message.error) {
        pending.reject(createProtocolError(message.error.message ?? `codex app-server ${pending.method} failed.`, message.error));
      } else {
        if (pending.method === "turn/start") this.setServerRequestContext(pending.threadId, message.result?.turn?.id ?? null);
        pending.resolve(message.result ?? {});
      }
      return;
    }

    if (message.method === "duet/runtime") this.options.onRuntimeEvent?.(message.params);
    if (message.method === "mcpServer/startupStatus/updated" && message.params?.status === "ready") this.options.onRuntimeEvent?.({ mcpReady: true });
    if (message.method && this.notificationHandler) {
      this.notificationHandler(/** @type {AppServerNotification} */ (message));
    }
  }

  handleServerRequest(message) {
    if (this.serverRequestHandler) { this.serverRequestHandler(message); return; }
    if (this.options.onParentQuestion && isParentQuestion(message, this.serverRequestPolicy)) {
      const { summary } = decideServerRequest(message, this.serverRequestPolicy);
      logServerRequest({ ...summary, kind: "parent-question", decision: "pending", reason: "ask-parent" }, this.options.onServerRequestLog);
      Promise.resolve(this.options.onParentQuestion(message)).then(result => {
        if (!this.closed) this.sendMessage({ id: message.id, result });
      }).catch(() => { if (!this.closed) this.sendMessage({ id: message.id, result: { success: false, contentItems: [{ type: "inputText", text: "Parent question unavailable. Proceed conservatively and report missing essential input." }] } }); });
      return;
    }
    const { reply, summary } = decideServerRequest(message, this.serverRequestPolicy);
    // A Computer Use elicitation for this turn that no per-call flag covers is
    // the parent's decision: the owner answers through the question bridge and
    // the reply is accept or cancel, never a persistence instruction to Codex.
    if (summary.kind === "computer-use-app" && summary.decision !== "approved" && summary.reason !== "turn-mismatch" && this.options.onApprovalRequest) {
      logServerRequest({ ...summary, decision: "pending", reason: "ask-parent" }, this.options.onServerRequestLog);
      const meta = message.params?._meta ?? {};
      Promise.resolve(this.options.onApprovalRequest({ kind: summary.kind, app: summary.app, threadId: message.params.threadId, toolName: typeof meta.tool_name === "string" ? meta.tool_name.slice(0, 80) : null }))
        .then(decision => ({ action: decision?.action === "accept" ? "accept" : "cancel", reason: decision?.reason ?? "parent-unavailable" }), () => ({ action: "cancel", reason: "parent-unavailable" }))
        .then(decision => {
          if (this.closed) return;
          logServerRequest({ ...summary, decision: decision.action === "accept" ? "approved" : "cancelled", reason: decision.reason }, this.options.onServerRequestLog);
          this.sendMessage(decision.action === "accept" ? { id: message.id, result: { action: "accept" } } : reply);
        });
      return;
    }
    // Logging precedes the reply; a logging failure must never grant access.
    logServerRequest(summary, this.options.onServerRequestLog);
    this.sendMessage(reply);
  }

  setServerRequestContext(threadId, turnId) {
    this.serverRequestPolicy.threadId = threadId;
    this.serverRequestPolicy.turnId = turnId;
  }

  handleExit(error) {
    clearTimeout(this.abortTimer);
    this.options.signal?.removeEventListener("abort", this.abortHandler);
    if (this.exitResolved) {
      return;
    }

    this.exitResolved = true;
    this.exitError = error ?? null;

    for (const pending of this.pending.values()) {
      pending.reject(this.exitError ?? new Error("codex app-server connection closed."));
    }
    this.pending.clear();
    this.resolveExit(undefined);
  }

  sendMessage(_message) {
    throw new Error("sendMessage must be implemented by subclasses.");
  }
}

class SpawnedCodexAppServerClient extends AppServerClientBase {
  constructor(cwd, options = {}) {
    super(cwd, options);
    this.transport = "direct";
  }

  async initialize() {
    const env = isolatedCodexEnv(this.options.env ?? process.env);
    this.proc = spawn(resolveCodexBinary(env), isolatedCodexArgs(["app-server"], env), {
      cwd: this.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32" ? (process.env.SHELL || true) : false,
      windowsHide: true,
      detached: process.platform !== "win32"
    });

    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");

    this.proc.stderr.on("data", (chunk) => {
      this.stderr += chunk;
      const recent = this.stderr.slice(-2048);
      if (!this.startupWarning && /websocket|switching to http|falling back.*http/i.test(recent) && /retry|timed? ?out|timeout|fallback|falling back|switching/i.test(recent)) {
        this.startupWarning = "WebSocket retry/fallback observed. Consider setup --transport http after reviewing the transport trade-offs; restart the runtime. Defaults were not changed.";
        this.options.onRuntimeEvent?.({ startupWarning: this.startupWarning });
      }
    });

    this.proc.on("error", (error) => {
      this.handleExit(error);
    });

    this.proc.on("exit", (code, signal) => {
      const stderr = this.stderr.trim();
      const detail =
        code === 0
          ? null
          : createProtocolError(
              `codex app-server exited unexpectedly (${signal ? `signal ${signal}` : `exit ${code}`}).${stderr ? `\n${stderr}` : ""}`
            );
      this.handleExit(detail);
    });

    this.readline = readline.createInterface({ input: this.proc.stdout });
    this.readline.on("line", (line) => {
      this.handleLine(line);
    });

    await this.request("initialize", {
      clientInfo: this.options.clientInfo ?? DEFAULT_CLIENT_INFO,
      capabilities: this.options.capabilities ?? DEFAULT_CAPABILITIES
    });
    this.notify("initialized", {});
  }

  async close() {
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      this.closed = true;
      this.readline?.close();
      this.proc?.stdin.end();
      await stopOwnedProcessGroup(this.proc, 150);
      await Promise.race([this.exitPromise, new Promise(resolve => setTimeout(resolve, 500))]);
    })();
    return this.closePromise;
  }

  sendMessage(message) {
    const line = `${JSON.stringify(message)}\n`;
    const stdin = this.proc?.stdin;
    if (!stdin) {
      throw new Error("codex app-server stdin is not available.");
    }
    stdin.write(line);
  }
}

class BrokerCodexAppServerClient extends AppServerClientBase {
  constructor(cwd, options = {}) {
    super(cwd, options);
    this.transport = "broker";
    this.endpoint = options.brokerEndpoint;
  }

  async initialize() {
    await new Promise((resolve, reject) => {
      const target = parseBrokerEndpoint(this.endpoint);
      this.socket = net.createConnection({ path: target.path });
      this.socket.setEncoding("utf8");
      this.socket.on("connect", resolve);
      this.socket.on("data", (chunk) => {
        this.handleChunk(chunk);
      });
      this.socket.on("error", (error) => {
        if (!this.exitResolved) {
          reject(error);
        }
        this.handleExit(error);
      });
      this.socket.on("close", () => {
        const error = this.exitError ?? (this.closed ? null : brokerClosedError());
        // Also settle a connection that closes before emitting connect.
        reject(error ?? brokerClosedError());
        this.handleExit(error);
      });
    });

    const identity = await this.request("initialize", {
      clientInfo: this.options.clientInfo ?? DEFAULT_CLIENT_INFO,
      capabilities: this.options.capabilities ?? DEFAULT_CAPABILITIES
    });
    this.options.onRuntimeEvent?.({ startupTimings: identity.startupTimings ?? {}, startupWarning: identity.startupWarning ?? null });
    if (identity.codexCompanionHome !== resolveIsolatedCodexHome(this.options.env ?? process.env)) {
      this.socket.destroy();
      throw new Error("Codex broker isolation identity does not match the requested home. Restart the Claude session.");
    }
    if (identity.codexCompanionRuntime !== resolveCodexRuntimeIdentity(this.options.env ?? process.env)) {
      this.socket.destroy();
      throw new Error("Codex broker runtime has changed. Restart the Claude session to use the selected executable.");
    }
    this.notify("initialized", {});
  }

  async close() {
    if (this.closed) {
      await this.exitPromise;
      return;
    }

    this.closed = true;
    if (this.socket) {
      this.socket.end();
      const deadline = setTimeout(() => this.socket.destroy(), 300);
      await this.exitPromise;
      clearTimeout(deadline);
    } else {
      this.handleExit(null);
    }
  }

  sendMessage(message) {
    const line = `${JSON.stringify(message)}\n`;
    const socket = this.socket;
    if (!socket) {
      throw new Error("codex app-server broker connection is not connected.");
    }
    socket.write(line);
  }
}

export class CodexAppServerClient {
  static async connect(cwd, options = {}) {
    if (options.signal?.aborted) throw new Error("Task interrupted before runtime connection.");
    const began = Date.now();
    resolveIsolatedCodexHome(options.env ?? process.env);
    let brokerEndpoint = null;
    if (!options.disableBroker) {
      brokerEndpoint = options.brokerEndpoint ?? options.env?.[BROKER_ENDPOINT_ENV] ?? process.env[BROKER_ENDPOINT_ENV] ?? null;
      if (!brokerEndpoint && options.reuseExistingBroker) {
        brokerEndpoint = loadBrokerSession(cwd)?.endpoint ?? null;
      }
      if (!brokerEndpoint && !options.reuseExistingBroker) {
        const brokerSession = await ensureBrokerSession(cwd, { env: options.env });
        brokerEndpoint = brokerSession?.endpoint ?? null;
      }
    }
    if (options.signal?.aborted) throw new Error("Task interrupted during broker startup.");
    const client = brokerEndpoint
      ? new BrokerCodexAppServerClient(cwd, { ...options, brokerEndpoint })
      : new SpawnedCodexAppServerClient(cwd, options);
    options.onClient?.(client);
    options.onRuntimeEvent?.({ timing: { phase: "brokerConnectSpawn", durationMs: Date.now() - began } });
    const initializeAt = Date.now();
    try { await client.initialize(); } catch (error) {
      await client.close().catch(() => {});
      if (client.transport === "broker" && !options.signal?.aborted &&
          ["BROKER_CONNECTION_CLOSED", "ECONNRESET", "EPIPE", "ENOENT", "ECONNREFUSED"].includes(error.code)) {
        // initialize is the only RPC sent here. Retry a private spawn once,
        // without killing/replacing another session's broker or replaying work.
        options.onRuntimeEvent?.({ brokerStartupRetry: true });
        return CodexAppServerClient.connect(cwd, { ...options, disableBroker: true });
      }
      throw error;
    }
    client.startupTimings = { appServerInitialize: Date.now() - initializeAt };
    options.onRuntimeEvent?.({ timing: { phase: client.transport === "broker" ? "brokerHandshake" : "appServerInitialize", durationMs: Date.now() - initializeAt } });
    return client;
  }
}
