/**
 * @typedef {Error & { data?: unknown, rpcCode?: number, code?: string, failureSource?: string }} ProtocolError
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
import { parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { ensureBrokerSession, loadBrokerSession } from "./broker-lifecycle.mjs";
import { isolatedCodexArgs, isolatedCodexEnv, resolveCodexBinary, resolveCodexRuntimeIdentity, resolveIsolatedCodexHome } from "./codex-home.mjs";
import { stopOwnedProcessGroup } from "./process.mjs";
import { isParentQuestion } from "./job-runtime.mjs";
import { decideServerRequest, logServerRequest, normalizeBrowserOrigins, normalizeBundleIds } from "./server-requests.mjs";
import { bestEffortDiagnostic } from "./tracked-jobs.mjs";

const PLUGIN_MANIFEST_URL = new URL("../../.claude-plugin/plugin.json", import.meta.url);
const PLUGIN_MANIFEST = JSON.parse(fs.readFileSync(PLUGIN_MANIFEST_URL, "utf8"));

export const BROKER_ENDPOINT_ENV = "CODEX_COMPANION_APP_SERVER_ENDPOINT";
export const BROKER_BUSY_RPC_CODE = -32001;
export const DEFAULT_CONNECT_TIMEOUT_MS = 60000;
// Task, review and transfer connections share this default and its override.
export function defaultConnectTimeoutMs(env = process.env) {
  const value = Number(env.CODEX_COMPANION_CONNECT_TIMEOUT_MS);
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_CONNECT_TIMEOUT_MS;
}
export const MAX_OUTBOUND_BYTES = 32 * 1024 * 1024;
export const MAX_STDERR_BYTES = 64 * 1024;
const STDERR_TRUNCATED = "[earlier stderr truncated]\n";

function transportError(message, code = "CODEX_TRANSPORT_CLOSED", cause = undefined) {
  return Object.assign(new Error(message, { cause }), { code, failureSource: "transport" });
}

// Never await drain in the input path: an outstanding RPC may need a server
// callback reply before it can finish. Bound each peer independently instead.
export function createOutboundQueue(stream, onError) {
  let queue = [], queuedBytes = 0, blocked = false, closed = false, exempt = 0, writing = 0, idle = [];
  // An oversized frame accepted on an idle peer is not backlog while it drains.
  const bufferedBytes = () => queuedBytes + Math.max(0, stream.writableLength - exempt);
  // A true write() return signals capacity, not completion: count callbacks.
  const flushedNow = () => !blocked && !queue.length && !writing;
  const settle = () => { for (const resolve of idle.splice(0)) resolve(); };
  const close = () => {
    closed = true; queue = []; queuedBytes = 0;
    stream.off("drain", drain);
    settle();
  };
  const fail = error => {
    if (closed) return;
    close();
    onError(error);
  };
  const write = frame => {
    if (frame.length > MAX_OUTBOUND_BYTES) exempt += frame.length;
    writing++;
    try {
      blocked = !stream.write(frame, () => { writing--; if (flushedNow()) settle(); });
    } catch (error) { writing--; fail(transportError(`Codex transport write failed: ${error.message}`, error.code, error)); }
  };
  function drain() {
    blocked = false; exempt = 0;
    while (!closed && !blocked && queue.length) {
      const frame = queue.shift();
      queuedBytes -= frame.length;
      write(frame);
    }
    if (flushedNow()) settle();
  }
  stream.on("drain", drain);
  // Keep the error listener through destruction: late EPIPE/error events must
  // remain observed even after close() has discarded the outbound queue.
  stream.on("error", error => fail(transportError(`Codex transport write failed: ${error.message}`, error.code, error)));
  stream.once("close", close);
  return {
    get bufferedBytes() { return bufferedBytes(); },
    close,
    // Resolves once every accepted frame reached the stream's kernel side.
    flushed: () => closed || flushedNow() ? Promise.resolve() : new Promise(resolve => idle.push(resolve)),
    send(message) {
      if (closed) return;
      const line = `${JSON.stringify(message)}\n`;
      const bytes = Buffer.byteLength(line);
      // The cap bounds backlog; one large frame (a long thread/read) on a
      // physically idle peer is already in memory and must still be deliverable.
      const physicallyIdle = !blocked && !queue.length && !stream.writableLength;
      if (!physicallyIdle && bufferedBytes() + bytes > MAX_OUTBOUND_BYTES) {
        fail(Object.assign(transportError("Codex transport peer exceeded the outbound buffer limit.", "CODEX_TRANSPORT_BACKPRESSURE"), { bufferedBytes: bufferedBytes(), maxBytes: MAX_OUTBOUND_BYTES }));
        return;
      }
      const frame = Buffer.from(line);
      if (blocked) { queue.push(frame); queuedBytes += bytes; }
      else write(frame);
    }
  };
}

// Feed decoded UTF-8 chunks; only LF terminates a JSONL record. Unicode line
// separators are valid JSON string data, and partial records span reads.
export function createJsonLineReader(onLine) {
  let buffer = "";
  return chunk => {
    buffer += chunk;
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      onLine(line);
    }
  };
}

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
  if (typeof data?.data?.transportCode === "string") {
    error.code = data.data.transportCode;
    error.failureSource = "transport";
  }
  return error;
}

function brokerClosedError() {
  return Object.assign(new Error("Codex broker connection closed during startup."), { code: "BROKER_CONNECTION_CLOSED" });
}

class AppServerClientBase {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  abortTimer;
  /** @type {{ appServerInitialize: number } | undefined} */
  startupTimings;

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
    this.readLines = createJsonLineReader(line => this.handleLine(line));
    this.transport = "unknown";
    this.serverRequestHandler = null;
    this.serverRequestPolicy = { approvedBrowserOrigins: normalizeBrowserOrigins(options.approvedBrowserOrigins ?? []), approvedComputerApps: normalizeBundleIds(options.approvedComputerApps ?? []), threadId: null, turnId: null };
    // Concrete transports provide close().
    this.abortHandler = () => { this.abortTimer ??= setTimeout(() => { void /** @type {any} */ (this).close(); }, 4500); };
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
   * @param {{ timeoutMs?: number }} [options]
   * @returns {Promise<import("./app-server-protocol").AppServerResponse<M>>}
   */
  request(method, params, { timeoutMs } = {}) {
    if (this.closed || this.exitResolved) {
      throw this.exitError ?? new Error("codex app-server client is closed.");
    }

    const id = this.nextId;
    this.nextId += 1;

    return new Promise((resolve, reject) => {
      const timer = timeoutMs === undefined ? null : setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error(`Codex ${method} probe timed out.`), { code: "ETIMEDOUT" }));
      }, Math.max(1, timeoutMs));
      const settle = callback => value => { clearTimeout(timer); callback(value); };
      const threadId = params && typeof params === "object" && "threadId" in params ? params.threadId : null;
      if (method === "turn/start") this.setServerRequestContext(threadId, null);
      this.pending.set(id, { resolve: settle(resolve), reject: settle(reject), method, threadId });
      try { this.sendMessage({ id, method, params }); }
      catch (error) { this.pending.delete(id); settle(reject)(error); }
    });
  }

  notify(method, params = {}) {
    if (this.closed || this.exitResolved) {
      return;
    }
    this.sendMessage({ method, params });
  }

  handleChunk(chunk) {
    this.readLines(chunk);
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

    if (!message || typeof message !== "object" || Array.isArray(message)) return;
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
    if (!this.closed) void /** @type {any} */ (this).close().catch(() => {});
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

    this.outbound = createOutboundQueue(this.proc.stdin, error => this.handleExit(error));
    this.procExited = new Promise(resolve => this.proc.once("exit", resolve));

    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");

    this.proc.stderr.on("data", (chunk) => {
      const diagnostic = Buffer.from(this.stderr + chunk);
      if (diagnostic.length > MAX_STDERR_BYTES) {
        this.stderrTruncated = true;
        let start = diagnostic.length - (MAX_STDERR_BYTES - Buffer.byteLength(STDERR_TRUNCATED));
        // Do not cut through a UTF-8 sequence at the beginning of the tail.
        while ((diagnostic[start] & 0xc0) === 0x80) start++;
        this.stderr = STDERR_TRUNCATED + diagnostic.subarray(start).toString("utf8");
      } else this.stderr = diagnostic.toString("utf8");
      const recent = this.stderr;
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
          : Object.assign(createProtocolError(
              `codex app-server exited unexpectedly (${signal ? `signal ${signal}` : `exit ${code}`}).${stderr ? `\n${stderr}` : ""}`
            ), { code: "CODEX_RUNTIME_EXITED", failureSource: "transport" });
      this.handleExit(detail);
    });

    // JSONL records end only at LF. readline also splits on Unicode U+2028 /
    // U+2029 in newer Node versions, although those are valid JSON string data.
    // Keep partial records (and UTF-8 sequences via setEncoding) across reads,
    // just as the broker socket does; a stream chunk is not a message boundary.
    this.stdoutHandler = (chunk) => this.handleChunk(chunk);
    this.proc.stdout.on("data", this.stdoutHandler);
    // data callbacks consume every complete JSONL record before end/close.
    // A dying runtime closes stdout just before its exit event; give that
    // event a moment so its code/signal diagnostic wins.
    const stdoutClosed = () => setTimeout(() => {
      const stderr = this.stderr.trim();
      if (!this.closed) this.handleExit(transportError(`codex app-server connection closed.${stderr ? `\n${stderr}` : ""}`));
    }, 50);
    this.proc.stdout.on("end", stdoutClosed);
    this.proc.stdout.on("close", stdoutClosed);
    this.proc.stdout.on("error", error => this.handleExit(transportError(`Codex app-server stdout failed: ${error.message}`, /** @type {NodeJS.ErrnoException} */ (error).code, error)));

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
      this.outbound?.close();
      this.handleExit(null);
      if (this.stdoutHandler) this.proc?.stdout.off("data", this.stdoutHandler);
      this.proc?.stdin.destroy();
      await stopOwnedProcessGroup(this.proc, 150);
      if (this.proc && this.proc.exitCode === null && this.proc.signalCode === null) {
        let timer;
        await Promise.race([this.procExited, new Promise(resolve => { timer = setTimeout(resolve, 500); })]);
        clearTimeout(timer);
      }
    })();
    return this.closePromise;
  }

  sendMessage(message) {
    if (!this.outbound) {
      throw new Error("codex app-server stdin is not available.");
    }
    this.outbound.send(message);
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
      this.outbound = createOutboundQueue(this.socket, error => this.handleExit(error));
      this.socket.setEncoding("utf8");
      this.socket.on("connect", resolve);
      this.socket.on("data", (chunk) => {
        this.handleChunk(chunk);
      });
      this.socket.on("error", (error) => {
        reject(error);
        this.handleExit(error);
      });
      this.socket.on("close", () => {
        const error = this.exitError ?? (this.closed ? null : brokerClosedError());
        // Also settle a connection that closes before emitting connect.
        reject(error ?? brokerClosedError());
        this.handleExit(error);
      });
      this.socket.on("end", () => this.handleExit(this.closed ? null : brokerClosedError()));
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
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      this.closed = true;
      // A healthy close still delivers accepted frames (a final answer or an
      // interrupt) within a short grace; a broken transport closes at once.
      if (!this.exitResolved && this.socket && !this.socket.destroyed && this.outbound) {
        let timer;
        await Promise.race([this.outbound.flushed(), new Promise(resolve => { timer = setTimeout(resolve, 300); })]);
        clearTimeout(timer);
      }
      this.outbound?.close();
      this.socket?.destroy();
      this.handleExit(null);
    })();
    return this.closePromise;
  }

  sendMessage(message) {
    if (!this.outbound) {
      throw new Error("codex app-server broker connection is not connected.");
    }
    this.outbound.send(message);
  }
}

export class CodexAppServerClient {
  static async connect(cwd, options = {}) {
    const timeoutMs = options.connectTimeoutMs ?? defaultConnectTimeoutMs(options.env ?? process.env);
    const onRuntimeEvent = options.onRuntimeEvent;
    options = { ...options, connectTimeoutMs: timeoutMs, connectDeadline: options.connectDeadline ?? Date.now() + timeoutMs,
      onRuntimeEvent: onRuntimeEvent ? event => bestEffortDiagnostic(() => onRuntimeEvent(event)) : undefined };
    const timedOut = () => transportError("Codex initialize timed out.", "ETIMEDOUT");
    if (Date.now() >= options.connectDeadline) throw timedOut();
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
        const brokerSession = await ensureBrokerSession(cwd, { env: options.env, connectDeadline: options.connectDeadline });
        brokerEndpoint = brokerSession?.endpoint ?? null;
      }
    }
    if (options.signal?.aborted) throw new Error("Task interrupted during broker startup.");
    if (Date.now() >= options.connectDeadline) throw timedOut();
    const client = brokerEndpoint
      ? new BrokerCodexAppServerClient(cwd, { ...options, brokerEndpoint })
      : new SpawnedCodexAppServerClient(cwd, options);
    try {
      options.onClient?.(client);
      options.onRuntimeEvent?.({ timing: { phase: "brokerConnectSpawn", durationMs: Date.now() - began } });
      const initializeAt = Date.now();
      let connectTimer;
      try {
        const initialize = client.initialize();
        await Promise.race([initialize, new Promise((_, reject) => {
          connectTimer = setTimeout(() => reject(timedOut()), Math.max(1, options.connectDeadline - Date.now()));
        })]);
      } catch (error) {
        client.handleExit(error);
        await client.close().catch(() => {});
        if (client.transport === "broker" && !options.signal?.aborted &&
            ["BROKER_CONNECTION_CLOSED", "ECONNRESET", "EPIPE", "ENOENT", "ECONNREFUSED"].includes(error.code)) {
          // initialize is the only RPC sent here. Retry a private spawn once,
          // without killing/replacing another session's broker or replaying work.
          options.onRuntimeEvent?.({ brokerStartupRetry: true });
          return CodexAppServerClient.connect(cwd, { ...options, disableBroker: true });
        }
        throw error;
      } finally { clearTimeout(connectTimer); }
      client.startupTimings = { appServerInitialize: Date.now() - initializeAt };
      options.onRuntimeEvent?.({ timing: { phase: client.transport === "broker" ? "brokerHandshake" : "appServerInitialize", durationMs: Date.now() - initializeAt } });
      return client;
    } catch (error) {
      // Ownership has not reached the caller, including failures in onClient
      // or bookkeeping after initialize has succeeded.
      await client.close().catch(() => {});
      throw error;
    }
  }
}
