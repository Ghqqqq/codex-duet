import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { binaryAvailable, executableOnPath, spawnDetached } from "./process.mjs";
import { fileURLToPath } from "node:url";
import { createBrokerEndpoint, parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { resolveStateDir, tryAcquirePidLock } from "./state.mjs";
import { resolveIsolatedCodexHome, resolveCodexRuntimeIdentity, resolveCodexSelection } from "./codex-home.mjs";
import { stopOwnedProcessGroup } from "./process.mjs";

export const PID_FILE_ENV = "CODEX_COMPANION_APP_SERVER_PID_FILE";
export const LOG_FILE_ENV = "CODEX_COMPANION_APP_SERVER_LOG_FILE";
const BROKER_STATE_FILE = "broker.json";

export function createBrokerSessionDir(prefix = "cxc-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function connectToEndpoint(endpoint) {
  const target = parseBrokerEndpoint(endpoint);
  return net.createConnection({ path: target.path });
}

export async function waitForBrokerEndpoint(endpoint, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await new Promise((resolve) => {
      const socket = connectToEndpoint(endpoint);
      const finish = value => { clearTimeout(timer); socket.destroy(); resolve(value); };
      const timer = setTimeout(() => finish(false), Math.max(1, deadline - Date.now()));
      socket.on("connect", () => finish(true));
      socket.on("error", () => finish(false));
      socket.on("close", () => finish(false));
    });
    if (ready) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(50, deadline - Date.now()))));
  }
  return false;
}

export async function sendBrokerShutdown(endpoint) {
  await new Promise((resolve) => {
    const socket = connectToEndpoint(endpoint);
    const timer = setTimeout(() => { socket.destroy(); resolve(); }, 1000);
    socket.once("close", () => clearTimeout(timer));
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id: 1, method: "broker/shutdown", params: {} })}\n`);
    });
    socket.on("data", () => {
      socket.end();
      resolve();
    });
    socket.on("error", resolve);
    socket.on("close", resolve);
  });
}

export function spawnBrokerProcess({ scriptPath, cwd, endpoint, pidFile, logFile, env = process.env }) {
  const logFd = fs.openSync(logFile, "a");
  try {
    return spawnDetached(process.execPath, [scriptPath, "serve", "--endpoint", endpoint, "--cwd", cwd, "--pid-file", pidFile], {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", logFd, logFd]
    });
  } finally {
    fs.closeSync(logFd);
  }
}

function resolveBrokerStateFile(cwd) {
  return path.join(resolveStateDir(cwd), BROKER_STATE_FILE);
}

export function loadBrokerSession(cwd) {
  const stateFile = resolveBrokerStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return null;
  }
}

export function saveBrokerSession(cwd, session) {
  const stateDir = resolveStateDir(cwd);
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(resolveBrokerStateFile(cwd), `${JSON.stringify(session, null, 2)}\n`, "utf8");
}

function unlinkIfPresent(file) {
  try { fs.unlinkSync(file); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}

export function clearBrokerSession(cwd) {
  unlinkIfPresent(resolveBrokerStateFile(cwd));
}

async function inspectBrokerRuntime(endpoint, { env = process.env, timeoutMs = 1000, restart = false } = {}) {
  const home = resolveIsolatedCodexHome(env);
  let runtimeIdentity = null;
  try { runtimeIdentity = resolveCodexRuntimeIdentity(env); } catch { /* A missing selected binary must not hide the saved broker. */ }
  const result = { reachable: false, homeMatches: null, runtimeMatches: null, busy: null, shutdown: false,
    reason: "unreachable", detail: "The saved broker did not confirm idle shutdown; no process was force-stopped." };
  if (!endpoint || timeoutMs <= 0) return result;
  return new Promise(resolve => {
    let socket, buffer = "";
    const finish = () => { clearTimeout(timer); socket?.destroy(); resolve(result); };
    const timer = setTimeout(finish, timeoutMs);
    try { socket = connectToEndpoint(endpoint); } catch { finish(); return; }
    const send = message => socket.write(`${JSON.stringify(message)}\n`);
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      result.reachable = true;
      send({ id: 1, method: "initialize", params: { ...(runtimeIdentity ? { codexCompanionRuntime: runtimeIdentity } : {}) } });
    });
    socket.on("data", chunk => {
      buffer += chunk;
      for (let at; (at = buffer.indexOf("\n")) >= 0;) {
        const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
        let message;
        try { message = JSON.parse(line); } catch { finish(); return; }
        if (message?.id === 1 && message.result) {
          const identity = message.result;
          result.homeMatches = identity.codexCompanionHome === home;
          result.runtimeMatches = runtimeIdentity && typeof identity.codexCompanionRuntime === "string"
            ? identity.codexCompanionRuntime === runtimeIdentity : null;
          if (!restart) { result.reason = result.detail = null; finish(); return; }
          if (!result.homeMatches) {
            result.reason = "home_mismatch";
            result.detail = "The saved broker belongs to a different isolated Codex home; no shutdown was requested.";
            finish(); return;
          }
          if (!Array.isArray(identity.codexCompanionBrokerControls) || !identity.codexCompanionBrokerControls.includes("shutdownIfIdle") || typeof identity.codexCompanionRuntime !== "string") {
            result.reason = "unsupported_control";
            result.detail = "The broker does not advertise safe idle shutdown; no shutdown was requested.";
            finish(); return;
          }
          send({ id: 2, method: "broker/shutdownIfIdle", params: { runtimeIdentity: identity.codexCompanionRuntime } });
        } else if (message?.id === 2 && typeof message.result?.shutdown === "boolean") {
          result.shutdown = message.result.shutdown;
          result.busy = !result.shutdown;
          result.reason = result.shutdown ? null : "busy";
          result.detail = result.shutdown ? "The shared broker is retiring. The next task starts a fresh broker."
            : "The broker refused idle shutdown: connected peers, active turns or pending requests may still be using it.";
          finish(); return;
        } else if (message?.error) { finish(); return; }
      }
      if (buffer.length > 65536) finish();
    });
    socket.on("error", finish);
    socket.on("close", finish);
  });
}

function brokerStatus(session, probe) {
  let alive = probe.reachable;
  if (Number.isInteger(session.pid) && session.pid > 0) {
    try { process.kill(session.pid, 0); alive = true; }
    catch (error) { if (error.code === "EPERM") alive = true; }
  }
  return { pid: session.pid ?? null, alive, endpoint: session.endpoint ?? null,
    reachable: probe.reachable, homeMatches: probe.homeMatches, runtimeMatches: probe.runtimeMatches, busy: probe.busy };
}

export async function getWorkspaceRuntimeStatus(cwd, options = {}) {
  const env = options.env ?? process.env, selection = resolveCodexSelection(env);
  const executable = path.isAbsolute(selection.binary) ? selection.binary : executableOnPath(selection.binary, env) ?? selection.binary;
  const home = resolveIsolatedCodexHome(env);
  const version = binaryAvailable(executable, ["--version"], { cwd, timeoutMs: 5000,
    env: { ...env, CODEX_HOME: home, CODEX_SQLITE_HOME: home } });
  const session = loadBrokerSession(cwd);
  const probe = session ? await inspectBrokerRuntime(session.endpoint, options) : null;
  return { runtime: { binary: selection.binary, executable, source: selection.source,
    version: version.available ? version.detail : null, available: version.available,
    ...(version.available ? {} : { detail: version.detail }) }, broker: session ? brokerStatus(session, probe) : null };
}

export async function restartBrokerRuntime(cwd, options = {}) {
  const session = loadBrokerSession(cwd);
  if (!session) return { status: "not_running", reason: null, broker: null,
    detail: "No shared broker is recorded for this workspace. The next task starts a fresh broker." };
  const probe = await inspectBrokerRuntime(session.endpoint, { ...options, restart: true });
  if (probe.shutdown) {
    const current = loadBrokerSession(cwd);
    if (current?.endpoint === session.endpoint && current?.pid === session.pid) clearBrokerSession(cwd);
  }
  return { status: probe.shutdown ? "retired" : "refused", reason: probe.reason,
    broker: brokerStatus(session, probe), detail: probe.detail };
}

async function probeBrokerRuntime(endpoint, { env = process.env, timeoutMs = 1000 } = {}) {
  if (!endpoint || timeoutMs <= 0) return null;
  const home = resolveIsolatedCodexHome(env), runtimeIdentity = resolveCodexRuntimeIdentity(env);
  return new Promise(resolve => {
    let socket, reachable = false, stale = false, buffer = "";
    const finish = () => {
      clearTimeout(timer); socket?.destroy();
      resolve(reachable ? { stale } : null);
    };
    const timer = setTimeout(finish, timeoutMs);
    try { socket = connectToEndpoint(endpoint); }
    catch { finish(); return; }
    const send = message => socket.write(`${JSON.stringify(message)}\n`);
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      reachable = true;
      send({ id: 1, method: "initialize", params: { codexCompanionRuntime: runtimeIdentity } });
    });
    socket.on("data", chunk => {
      buffer += chunk;
      for (let at; (at = buffer.indexOf("\n")) >= 0;) {
        const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
        let message;
        try { message = JSON.parse(line); } catch { finish(); return; }
        if (message?.id === 1) {
          const identity = message.result;
          if (identity?.codexCompanionHome !== home || identity.codexCompanionRuntime === runtimeIdentity) {
            finish(); return;
          }
          stale = true;
          // Older brokers forward unknown controls to Codex. Only inspect
          // their identity, then leave the task to use its private runtime.
          if (!Array.isArray(identity.codexCompanionBrokerControls) || !identity.codexCompanionBrokerControls.includes("shutdownIfIdle")) {
            finish(); return;
          }
          send({ id: 2, method: "broker/shutdownIfIdle", params: { runtimeIdentity: identity.codexCompanionRuntime } });
        } else if (message?.id === 2) {
          finish(); return;
        }
      }
    });
    socket.on("error", finish);
    socket.on("close", finish);
  });
}

export async function ensureBrokerSession(cwd, options = {}) {
  const budget = ms => Math.max(0, Math.min(ms, (options.connectDeadline ?? Infinity) - Date.now()));
  const home = resolveIsolatedCodexHome(options.env ?? process.env);
  // Keep the lock beside, not inside, workspace state: a failed spawn must not
  // create a workspace record.
  const lockDir = path.join(home, "duet", "broker-spawn");
  fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  const lockDeadline = options.connectDeadline ?? Date.now() + (options.timeoutMs ?? 2000);
  let release;
  while (!(release = tryAcquirePidLock(path.join(lockDir, `${path.basename(resolveStateDir(cwd))}.lock`), { deadOwnerGraceMs: 30_000 }))) {
    const remaining = lockDeadline - Date.now();
    if (remaining <= 0) return null;
    await new Promise(resolve => setTimeout(resolve, Math.min(50, remaining)));
  }
  try {
    // Re-read only after admission: another caller may have published a broker.
    const existing = loadBrokerSession(cwd);
    if (existing) {
      const probe = await probeBrokerRuntime(existing.endpoint, { env: options.env, timeoutMs: budget(1000) });
      if (probe) {
        // An idle stale broker has been asked to retire; a busy one stays alive.
        // This task uses a private runtime, and a later ensure can start a broker.
        return probe.stale ? null : existing;
      }
    }
    if (!budget(Infinity)) return null;

    if (existing) {
      teardownBrokerSession({
        endpoint: existing.endpoint ?? null,
        pidFile: existing.pidFile ?? null,
        logFile: existing.logFile ?? null,
        sessionDir: existing.sessionDir ?? null,
        pid: existing.pid ?? null,
        killProcess: options.killProcess ?? null
      });
      clearBrokerSession(cwd);
    }

    const sessionDir = createBrokerSessionDir();
    const endpointFactory = options.createBrokerEndpoint ?? createBrokerEndpoint;
    const endpoint = endpointFactory(sessionDir, options.platform);
    const pidFile = path.join(sessionDir, "broker.pid");
    const logFile = path.join(sessionDir, "broker.log");
    const scriptPath =
      options.scriptPath ??
      fileURLToPath(new URL("../app-server-broker.mjs", import.meta.url));

    const child = spawnBrokerProcess({
      scriptPath,
      cwd,
      endpoint,
      pidFile,
      logFile,
      env: options.env ?? process.env
    });

    const ready = await waitForBrokerEndpoint(endpoint, budget(options.timeoutMs ?? 2000));
    if (!ready) {
      // This target PID was spawned here; never kill an inherited saved PID.
      await stopOwnedProcessGroup(child);
      teardownBrokerSession({
        endpoint,
        pidFile,
        logFile,
        sessionDir,
        pid: child.pid ?? null,
        killProcess: options.killProcess ?? null
      });
      return null;
    }

    const session = {
      endpoint,
      pidFile,
      logFile,
      sessionDir,
      pid: child.pid ?? null
    };
    saveBrokerSession(cwd, session);
    return session;
  } finally {
    release();
  }
}

export function teardownBrokerSession({ endpoint = null, pidFile, logFile, sessionDir = null, pid = null, killProcess = null }) {
  if (Number.isFinite(pid) && killProcess) {
    try {
      killProcess(pid);
    } catch {
      // Ignore missing or already-exited broker processes.
    }
  }

  if (pidFile) unlinkIfPresent(pidFile);

  if (logFile) unlinkIfPresent(logFile);

  if (endpoint) {
    try {
      const target = parseBrokerEndpoint(endpoint);
      if (target.kind === "unix" && fs.existsSync(target.path)) {
        fs.unlinkSync(target.path);
      }
    } catch {
      // Ignore malformed or already-removed broker endpoints during teardown.
    }
  }

  const resolvedSessionDir = sessionDir ?? (pidFile ? path.dirname(pidFile) : logFile ? path.dirname(logFile) : null);
  if (resolvedSessionDir && fs.existsSync(resolvedSessionDir)) {
    try {
      fs.rmdirSync(resolvedSessionDir);
    } catch {
      // Ignore non-empty or missing directories.
    }
  }
}
