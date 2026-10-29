#!/usr/bin/env node

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";

import { resolveIsolatedCodexHome, resolveCodexRuntimeIdentity } from "./lib/codex-home.mjs";
import { parseArgs } from "./lib/args.mjs";
import { BROKER_BUSY_RPC_CODE, CodexAppServerClient, createJsonLineReader, createOutboundQueue } from "./lib/app-server.mjs";
import { parseBrokerEndpoint } from "./lib/broker-endpoint.mjs";
import { ServerRequestRelay, logServerRequest } from "./lib/server-requests.mjs";

const STREAMING_METHODS = new Set(["turn/start", "review/start", "thread/compact/start"]);

function buildStreamThreadIds(method, params, result) {
  const threadIds = new Set();
  if (params?.threadId) {
    threadIds.add(params.threadId);
  }
  if (method === "review/start" && result?.reviewThreadId) {
    threadIds.add(result.reviewThreadId);
  }
  return threadIds;
}

function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

const outbound = new WeakMap();
function send(socket, message) {
  if (socket.destroyed) {
    return;
  }
  outbound.get(socket)?.send(message);
}

function isInterruptRequest(message) {
  return message?.method === "turn/interrupt";
}

function writePidFile(pidFile) {
  if (!pidFile) {
    return;
  }
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, `${process.pid}\n`, "utf8");
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (subcommand !== "serve") {
    throw new Error("Usage: node scripts/app-server-broker.mjs serve --endpoint <value> [--cwd <path>] [--pid-file <path>]");
  }

  const { options } = parseArgs(argv, {
    valueOptions: ["cwd", "pid-file", "endpoint"]
  });

  if (!options.endpoint) {
    throw new Error("Missing required --endpoint.");
  }

  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  const endpoint = String(options.endpoint);
  const listenTarget = parseBrokerEndpoint(endpoint);
  const pidFile = options["pid-file"] ? path.resolve(options["pid-file"]) : null;
  writePidFile(pidFile);

  const runtimeIdentity = resolveCodexRuntimeIdentity();
  let activeRequestSocket = null;
  let activeStreamSocket = null;
  let activeStreamThreadIds = null;
  const activeTurns = new Map();
  const abandonedRequests = new Set();
  const abandonedGraceMs = process.env.CODEX_COMPANION_TEST_MODE === "1" && Number(process.env.CODEX_COMPANION_TEST_ABANDONED_TURN_GRACE_MS) > 0
    ? Number(process.env.CODEX_COMPANION_TEST_ABANDONED_TURN_GRACE_MS) : 30 * 60 * 1000;
  const forwardedRequests = new Set();
  const pendingStreamStarts = new Set();
  let appClient;
  const signals = ["SIGTERM", "SIGINT", "SIGHUP"];
  // Install before initialize: readiness timeout may stop this broker while
  // its separately grouped app-server is still waiting for initialize.
  const stopStarting = () => { void appClient?.close().catch(() => {}); };
  for (const signal of signals) process.on(signal, stopStarting);
  try {
    appClient = await CodexAppServerClient.connect(cwd, {
      disableBroker: true,
      onClient: client => { appClient = client; },
      onRuntimeEvent: event => {
        const owner = activeStreamSocket ?? activeRequestSocket;
        if (owner) send(owner, { method: "duet/runtime", params: event });
      }
    });
  } catch (error) {
    if (pidFile && fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
    throw error;
  } finally {
    for (const signal of signals) process.off(signal, stopStarting);
  }
  const sockets = new Set();
  const requests = new ServerRequestRelay({ send, respond: message => {
    if (!appClient.closed && !appClient.exitResolved) appClient.sendMessage(message);
  }, log: summary => logServerRequest(summary) });
  appClient.serverRequestHandler = message => {
    // All callbacks during a stream reach its job log, including unsupported
    // requests from child threads. The task policy checks exact thread/turn IDs.
    const owner = activeStreamSocket ?? activeRequestSocket;
    // A callback may share the stdout chunk containing turn/start's response.
    // Let that response reach the task first so it knows the acknowledged turn.
    queueMicrotask(() => requests.request(message, owner));
  };

  function forwardRequest(method, params) {
    const promise = appClient.request(method, params);
    forwardedRequests.add(promise);
    // Observe settlement without delaying the response ahead of notifications
    // delivered in the same stdout chunk.
    promise.then(() => forwardedRequests.delete(promise), () => forwardedRequests.delete(promise));
    return promise;
  }

  function clearSocketOwnership(socket) {
    requests.disconnect(socket);
    for (const [threadId, turn] of activeTurns) if (turn.owner === socket) {
      turn.owner = null;
      turn.abandonedAt ??= Date.now();
      interruptAbandonedTurn(threadId, turn);
    }
    // A pending RPC retains its owner even after disconnect: its callbacks
    // must fail closed, never be reassigned to a later client. It no longer
    // counts as activity, so an abandoned RPC cannot prevent idle shutdown.
    if (activeStreamSocket === socket) {
      activeStreamSocket = null;
      activeStreamThreadIds = null;
    }
  }

  function recordAbandonedTurn(threadId, turn, outcome) {
    // The broker's stderr is its existing private log. Never claim that an
    // interrupt acknowledgement proves completion; only a notification does.
    process.stderr.write(`${JSON.stringify({ event: "abandoned_turn", threadId, turnId: turn.id, outcome })}\n`);
  }

  function interruptAbandonedTurn(threadId, turn) {
    if (turn.interruptPending || closing) return;
    recordAbandonedTurn(threadId, turn, "interrupt_requested");
    let pending;
    try { pending = appClient.request("turn/interrupt", { threadId, turnId: turn.id }, { timeoutMs: 1000 }); }
    catch { recordAbandonedTurn(threadId, turn, "unconfirmed"); return; }
    turn.interruptPending = pending;
    abandonedRequests.add(pending);
    pending.then(() => {
      if (activeTurns.get(threadId) === turn) recordAbandonedTurn(threadId, turn, "acknowledged");
    }, () => recordAbandonedTurn(threadId, turn, "unconfirmed"))
      .finally(() => { abandonedRequests.delete(pending); turn.interruptPending = null; });
  }

  function expireAbandonedTurns(now) {
    for (const [threadId, turn] of activeTurns) {
      if (turn.owner || turn.abandonedAt == null || turn.expired || now - turn.abandonedAt < abandonedGraceMs) continue;
      turn.expired = true;
      recordAbandonedTurn(threadId, turn, "expired");
      interruptAbandonedTurn(threadId, turn);
    }
  }

  function routeNotification(message) {
    const target = activeRequestSocket ?? activeStreamSocket;
    if (message.method === "turn/completed") {
      const threadId = message.params?.threadId, turnId = message.params?.turn?.id;
      if (threadId && turnId) {
        for (const completed of pendingStreamStarts) completed.add(JSON.stringify([threadId, turnId]));
      }
      const active = activeTurns.get(threadId);
      if (active?.abandonedAt != null && active.id === turnId) recordAbandonedTurn(threadId, active, "completed");
      if (!active || !turnId || active.id === turnId) activeTurns.delete(threadId);
    }
    if (target) send(target, message);
    if (message.method === "turn/completed" && activeStreamSocket === target) {
      const threadId = message.params?.threadId ?? null;
      if (!threadId || !activeStreamThreadIds || activeStreamThreadIds.has(threadId)) {
        activeStreamSocket = null;
        activeStreamThreadIds = null;
      }
    }
  }

  let closing = false;
  let shutdownPromise;
  let lastBusy = Date.now();
  function shutdown(server) {
    if (shutdownPromise) return shutdownPromise;
    closing = true;
    clearInterval(idleTimer);
    shutdownPromise = (async () => {
      // Stop admission synchronously. Awaiting appClient.close() first leaves a
      // window where initialize succeeds against an already closed app-server.
      const listenerClosed = server.listening ? new Promise(resolve => server.close(resolve)) : Promise.resolve();
      for (const [threadId, turn] of activeTurns) {
        // request() throws synchronously when exitPromise initiated shutdown.
        try { void appClient.request("turn/interrupt", { threadId, turnId: turn.id }).catch(() => {}); }
        catch { /* The runtime already exited; continue closing sockets/files. */ }
      }
      for (const socket of sockets) {
        requests.disconnect(socket); socket.destroy();
      }
      await appClient.close().catch(() => {});
      await listenerClosed;
      if (listenTarget.kind === "unix" && fs.existsSync(listenTarget.path)) {
        fs.unlinkSync(listenTarget.path);
      }
      if (pidFile && fs.existsSync(pidFile)) {
        fs.unlinkSync(pidFile);
      }
    })();
    return shutdownPromise;
  }

  // A response and terminal notification may arrive in the same stdout chunk.
  // Record the response's active turn before routing its completion.
  appClient.setNotificationHandler(message => queueMicrotask(() => routeNotification(message)));

  const server = net.createServer((socket) => {
    // An accept already queued when shutdown started must not handshake.
    if (closing) { socket.destroy(); return; }
    outbound.set(socket, createOutboundQueue(socket, error => {
      process.stderr.write(`${JSON.stringify({ event: "transport_error", code: error.code, bufferedBytes: error.bufferedBytes, maxBytes: error.maxBytes })}\n`);
      socket.destroy(error);
    }));
    sockets.add(socket);
    lastBusy = Date.now();
    socket.setEncoding("utf8");
    let inputQueue = Promise.resolve();
    const readLines = createJsonLineReader(line => {
      if (!line.trim()) return;
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        send(socket, {
          id: null,
          error: buildJsonRpcError(-32700, `Invalid JSON: ${error.message}`)
        });
        return;
      }

      if (!message || typeof message !== "object" || Array.isArray(message)) return;
      // Callback replies must bypass the request queue: the in-flight RPC may
      // be waiting for one. Unknown/expired replies are never client requests.
      if (requests.response(message, socket) || message.method === undefined) return;
      // A rejected request must not stall every later request on this socket.
      inputQueue = inputQueue.then(() => handleRequest(message)).catch(() => {});
    });
    socket.on("data", chunk => {
      if (closing) { socket.destroy(); return; }
      readLines(chunk);
    });

    async function handleRequest(message) {
      if (closing || socket.destroyed) return;
      if (message.id !== undefined && message.method === "initialize") {
        send(socket, {
          id: message.id,
          result: {
            userAgent: "codex-companion-broker",
            codexCompanionHome: resolveIsolatedCodexHome(),
            codexCompanionRuntime: runtimeIdentity,
            startupTimings: appClient.startupTimings, startupWarning: appClient.startupWarning ?? null
          }
        });
        return;
      }

      if (message.method === "initialized" && message.id === undefined) {
        return;
      }

      if (message.id !== undefined && message.method === "broker/shutdown") {
        send(socket, { id: message.id, result: {} });
        await shutdown(server);
        process.exit(0);
      }

      if (message.id === undefined) {
        return;
      }

      const allowInterruptDuringActiveStream =
        isInterruptRequest(message) && activeStreamSocket && activeStreamSocket !== socket && !activeRequestSocket;

      if (
        ((activeTurns.size && !activeStreamSocket) || (activeRequestSocket && activeRequestSocket !== socket) || (activeStreamSocket && activeStreamSocket !== socket)) &&
        !allowInterruptDuringActiveStream
      ) {
        send(socket, {
          id: message.id,
          error: buildJsonRpcError(BROKER_BUSY_RPC_CODE, "Shared Codex broker is busy.")
        });
        return;
      }

      if (allowInterruptDuringActiveStream) {
        try {
          const result = await forwardRequest(message.method, message.params ?? {});
          send(socket, { id: message.id, result });
        } catch (error) {
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(error.rpcCode ?? -32000, error.message, error.code ? { transportCode: error.code } : undefined)
          });
        }
        return;
      }

      const isStreaming = STREAMING_METHODS.has(message.method);
      // Retain only completions observed while this start is outstanding;
      // settled requests leave no unbounded history of completed turns.
      const completedBeforeResponse = new Set();
      if (isStreaming) pendingStreamStarts.add(completedBeforeResponse);
      activeRequestSocket = socket;

      try {
        const result = await forwardRequest(message.method, message.params ?? {});
        send(socket, { id: message.id, result });
        if (isStreaming) {
          const streamThreadIds = buildStreamThreadIds(message.method, message.params ?? {}, result);
          const alreadyCompleted = [...streamThreadIds].some(threadId => completedBeforeResponse.has(JSON.stringify([threadId, result.turn?.id])));
          if (!alreadyCompleted) {
            activeStreamSocket = socket;
            activeStreamThreadIds = streamThreadIds;
            if (result.turn?.id) activeTurns.set(result.reviewThreadId ?? message.params.threadId, { id: result.turn.id, owner: socket });
            if (socket.destroyed) clearSocketOwnership(socket);
          }
        }
      } catch (error) {
        send(socket, {
          id: message.id,
          error: buildJsonRpcError(error.rpcCode ?? -32000, error.message, error.code ? { transportCode: error.code } : undefined)
        });
        // Stream ownership is installed only after a successful streaming
        // response. A failed request cannot end an already acknowledged turn.
      } finally {
        pendingStreamStarts.delete(completedBeforeResponse);
        if (activeRequestSocket === socket) activeRequestSocket = null;
      }
    }

    socket.on("close", () => {
      sockets.delete(socket);
      lastBusy = Date.now();
      clearSocketOwnership(socket);
    });

    socket.on("error", () => {
      sockets.delete(socket);
      lastBusy = Date.now();
      clearSocketOwnership(socket);
    });
  });

  const idleMs = Math.max(1000, (Number(process.env.CODEX_COMPANION_BROKER_IDLE_SEC) || 60) * 1000);
  const idleTimer = setInterval(() => {
    // Forwarded requests from disconnected clients are abandoned. Keep their
    // ownership until settlement, but let idle shutdown reap a hung server.
    expireAbandonedTurns(Date.now());
    // Preserve the existing prompt retirement after an unconfirmed owner-loss
    // interrupt, but never terminate a broker with a connected peer. Recheck
    // each tick so a peer that leaves later cannot strand the abandoned turn.
    if (!sockets.size && activeTurns.size && [...activeTurns.values()].every(turn =>
      !turn.owner && turn.abandonedAt != null && Date.now() - turn.abandonedAt >= 4000)) {
      void shutdown(server);
      return;
    }
    const internalRequests = appClient.pending.size > forwardedRequests.size + abandonedRequests.size;
    const ownedOrSettlingTurns = [...activeTurns.values()].some(turn => !turn.expired);
    if (sockets.size || ownedOrSettlingTurns || (activeRequestSocket && !activeRequestSocket.destroyed) || internalRequests) lastBusy = Date.now();
    else if (Date.now() - lastBusy >= idleMs) void shutdown(server);
  }, 250);
  for (const signal of signals) process.on(signal, () => { void shutdown(server); });
  appClient.exitPromise.then(() => { void shutdown(server); });
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(listenTarget.path, resolve); });
  } catch (error) { await shutdown(server); throw error; }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
