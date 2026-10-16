#!/usr/bin/env node

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";

import { resolveIsolatedCodexHome, resolveCodexRuntimeIdentity } from "./lib/codex-home.mjs";
import { parseArgs } from "./lib/args.mjs";
import { BROKER_BUSY_RPC_CODE, CodexAppServerClient } from "./lib/app-server.mjs";
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

function send(socket, message) {
  if (socket.destroyed) {
    return;
  }
  socket.write(`${JSON.stringify(message)}\n`);
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
  const requests = new ServerRequestRelay({ send, respond: message => appClient.sendMessage(message), log: summary => logServerRequest(summary) });
  appClient.serverRequestHandler = message => {
    // All callbacks during a stream reach its job log, including unsupported
    // requests from child threads. The task policy checks exact thread/turn IDs.
    const owner = activeStreamSocket ?? activeRequestSocket;
    // A callback may share the stdout chunk containing turn/start's response.
    // Let that response reach the task first so it knows the acknowledged turn.
    queueMicrotask(() => requests.request(message, owner));
  };

  function clearSocketOwnership(socket) {
    requests.disconnect(socket);
    for (const [threadId, turn] of activeTurns) if (turn.owner === socket) {
      void appClient.request("turn/interrupt", { threadId, turnId: turn.id }).catch(() => {});
      // Lost owners cannot leave a still-running server behind indefinitely.
      setTimeout(() => { if (activeTurns.get(threadId) === turn) void shutdown(server); }, 4000).unref();
    }
    if (activeRequestSocket === socket) {
      activeRequestSocket = null;
    }
    if (activeStreamSocket === socket) {
      activeStreamSocket = null;
      activeStreamThreadIds = null;
    }
  }

  function routeNotification(message) {
    const target = activeRequestSocket ?? activeStreamSocket;
    if (message.method === "turn/completed") activeTurns.delete(message.params?.threadId);
    if (target) send(target, message);
    if (message.method === "turn/completed" && activeStreamSocket === target) {
      const threadId = message.params?.threadId ?? null;
      if (!threadId || !activeStreamThreadIds || activeStreamThreadIds.has(threadId)) {
        activeStreamSocket = null;
        activeStreamThreadIds = null;
        if (activeRequestSocket === target) {
          activeRequestSocket = null;
        }
      }
    }
  }

  let closing = false;
  async function shutdown(server) {
    if (closing) return;
    closing = true;
    clearInterval(idleTimer);
    for (const [threadId, turn] of activeTurns) void appClient.request("turn/interrupt", { threadId, turnId: turn.id }).catch(() => {});
    for (const socket of sockets) {
      requests.disconnect(socket); socket.destroy();
    }
    await appClient.close().catch(() => {});
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    if (listenTarget.kind === "unix" && fs.existsSync(listenTarget.path)) {
      fs.unlinkSync(listenTarget.path);
    }
    if (pidFile && fs.existsSync(pidFile)) {
      fs.unlinkSync(pidFile);
    }
  }

  // A response and terminal notification may arrive in the same stdout chunk.
  // Record the response's active turn before routing its completion.
  appClient.setNotificationHandler(message => queueMicrotask(() => routeNotification(message)));

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";

    socket.on("data", async (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");

        if (!line.trim()) {
          continue;
        }

        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          send(socket, {
            id: null,
            error: buildJsonRpcError(-32700, `Invalid JSON: ${error.message}`)
          });
          continue;
        }

        if (requests.response(message, socket)) continue;
        // A response with an unknown/expired server request ID is never a new
        // client request (nor permission to answer another job's callback).
        if (message.method === undefined) continue;

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
          continue;
        }

        if (message.method === "initialized" && message.id === undefined) {
          continue;
        }

        if (message.id !== undefined && message.method === "broker/shutdown") {
          send(socket, { id: message.id, result: {} });
          await shutdown(server);
          process.exit(0);
        }

        if (message.id === undefined) {
          continue;
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
          continue;
        }

        if (allowInterruptDuringActiveStream) {
          try {
            const result = await appClient.request(message.method, message.params ?? {});
            send(socket, { id: message.id, result });
          } catch (error) {
            send(socket, {
              id: message.id,
              error: buildJsonRpcError(error.rpcCode ?? -32000, error.message)
            });
          }
          continue;
        }

        const isStreaming = STREAMING_METHODS.has(message.method);
        activeRequestSocket = socket;

        try {
          const result = await appClient.request(message.method, message.params ?? {});
          send(socket, { id: message.id, result });
          if (isStreaming) {
            activeStreamSocket = socket;
            activeStreamThreadIds = buildStreamThreadIds(message.method, message.params ?? {}, result);
            if (result.turn?.id) activeTurns.set(message.params.threadId, { id: result.turn.id, owner: socket });
            if (socket.destroyed) clearSocketOwnership(socket);
          }
          if (activeRequestSocket === socket) {
            activeRequestSocket = null;
          }
        } catch (error) {
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(error.rpcCode ?? -32000, error.message)
          });
          if (activeRequestSocket === socket) {
            activeRequestSocket = null;
          }
          if (activeStreamSocket === socket && !isStreaming) {
            activeStreamSocket = null;
          }
        }
      }
    });

    socket.on("close", () => {
      sockets.delete(socket);
      clearSocketOwnership(socket);
    });

    socket.on("error", () => {
      sockets.delete(socket);
      clearSocketOwnership(socket);
    });
  });

  let lastBusy = Date.now();
  const idleMs = Math.max(1000, (Number(process.env.CODEX_COMPANION_BROKER_IDLE_SEC) || 60) * 1000);
  const idleTimer = setInterval(() => {
    if (sockets.size || activeTurns.size || activeRequestSocket) lastBusy = Date.now();
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
