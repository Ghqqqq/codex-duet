import { spawnSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

function windowsEnv(env, name) {
  const key = Object.keys(env).sort().find(key => key.toUpperCase() === name);
  return key ? env[key] : undefined;
}

export function executableOnPath(name, env = process.env) {
  const windows = process.platform === "win32";
  const paths = windows ? path.win32 : path;
  const suffixes = windows && !paths.extname(name) ? (windowsEnv(env, "PATHEXT") || ".EXE;.CMD;.BAT").split(";") : [""];
  const directories = windows && /[\\/]/.test(name) ? [""] :
    (windows ? windowsEnv(env, "PATH") || "" : env.PATH || "").split(windows ? ";" : path.delimiter);
  return directories.flatMap(dir => suffixes.map(ext => paths.resolve(windows ? dir.replace(/^"(.*)"$/, "$1") : dir, name + ext))).find(candidate => {
    try { fs.accessSync(candidate, fs.constants.X_OK); return fs.statSync(candidate).isFile(); }
    catch { return false; }
  }) ?? null;
}

const CMD_META = /([()\][%!^"`<>&|;, *?])/g;
function quoteCmdArgument(value, doubleEscape) {
  // Preserve embedded quotes and trailing backslashes through Windows argv
  // parsing, then protect cmd.exe metacharacters (including the quote marks).
  let quoted = `"${String(value).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
  quoted = quoted.replace(CMD_META, "^$1");
  return doubleEscape ? quoted.replace(CMD_META, "^$1") : quoted;
}

function commandInvocation(command, args, options) {
  if (process.platform !== "win32" || options.shell != null) return { command, args, options };
  const env = options.env ?? process.env;
  const executable = executableOnPath(command, env) ?? command;
  if (!/\.(?:cmd|bat)$/i.test(executable)) return { command: executable, args, options: { ...options, shell: false } };
  // npm's local .bin shims parse arguments an extra time while forwarding %*.
  const doubleEscape = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(executable);
  const line = [executable.replace(CMD_META, "^$1"), ...args.map(arg => quoteCmdArgument(arg, doubleEscape))].join(" ");
  return {
    command: windowsEnv(env, "COMSPEC") || "cmd.exe",
    args: ["/d", "/s", "/c", `"${line}"`],
    options: { ...options, shell: false, windowsVerbatimArguments: true }
  };
}

// Tests share only a fresh suite-owned process ledger. Never discover/kill by
// executable name, inherited broker PID, or a user's existing runtime state.
export function spawnOwned(command, args, options = {}) {
  if (process.env.CODEX_COMPANION_TEST_MODE === "1") options = { ...options, env: { ...process.env, ...options.env } };
  const invocation = commandInvocation(command, args, options);
  const child = spawn(invocation.command, invocation.args, invocation.options);
  const env = options.env ?? process.env;
  if (env.CODEX_COMPANION_TEST_MODE === "1" && env.CODEX_COMPANION_TEST_PROCESSES && child.pid) {
    const dir = env.CODEX_COMPANION_TEST_PROCESSES;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `${child.pid}.json`);
    const record = { pid: child.pid, detached: Boolean(options.detached), spawnedBy: process.pid, exited: false };
    fs.writeFileSync(file, JSON.stringify(record), { mode: 0o600 });
    child.once("exit", () => { try { fs.writeFileSync(file, JSON.stringify({ ...record, exited: true })); } catch {} });
  }
  return child;
}

// A new process group alone is still in the caller's descendant tree. Reap a
// short-lived launcher before returning, so tree-based shell stops cannot reach
// the target. spawnOwned runs in the launcher to ledger the real target PID.
export function spawnDetached(command, args = [], options = {}) {
  if (process.env.CODEX_COMPANION_TEST_MODE === "1") options = { ...options, env: { ...process.env, ...options.env } };
  try {
    /** @type {import("node:child_process").StdioOptions} */
    const launcherStdio = ["ignore", "pipe", "pipe"];
    const requestedStdio = options.stdio ?? "ignore";
    const targetStdio = (Array.isArray(requestedStdio) ? requestedStdio : [requestedStdio, requestedStdio, requestedStdio]).map((entry, index) => {
      if (entry === "ignore") return "ignore";
      // Reserve stdout for the PID handshake. Forward open files/streams through
      // extra launcher descriptors; their numbers can differ in the target.
      if (entry === "inherit") entry = index;
      if (typeof entry !== "number" && !Number.isInteger(entry?.fd)) throw new Error("Unsupported detached stdio");
      return launcherStdio.push(entry) - 1;
    });
    const launch = `
      import fs from "node:fs";
      import { spawnOwned } from ${JSON.stringify(import.meta.url)};
      const { command, args, options } = JSON.parse(process.argv[1]);
      const child = spawnOwned(command, args, options);
      child.once("error", () => { process.exitCode = 1; });
      child.once("spawn", () => {
        child.unref();
        fs.writeSync(1, String(child.pid) + "\\n");
      });
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", launch, JSON.stringify({
      command, args, options: { ...options, env: undefined, detached: true, stdio: targetStdio }
    })], { env: options.env, stdio: launcherStdio, encoding: "utf8", timeout: 1500, killSignal: "SIGKILL", windowsHide: true });
    const pid = Number(result.stdout?.trim());
    if (result.error || result.status !== 0 || !Number.isSafeInteger(pid) || pid <= 0) throw new Error("Detached launcher failed");
    return { pid };
  } catch {
    try { fs.writeSync(2, "codex-companion: detached launcher failed; using direct detached spawn.\n"); } catch { /* a closed stderr must not prevent fallback */ }
    const child = spawnOwned(command, args, { ...options, detached: true, stdio: options.stdio ?? "ignore" });
    // Failed spawns emit error asynchronously even when no PID was returned.
    child.once("error", () => {});
    if (!child.pid) throw new Error("Detached fallback spawn failed");
    child.unref();
    return { pid: child.pid };
  }
}

export async function stopOwnedProcessGroup(child, graceMs = 500) {
  if (!child?.pid) return;
  const signal = value => {
    try { if (process.platform === "win32") terminateProcessTree(child.pid); else process.kill(-child.pid, value); }
    catch (e) {
      if (e.code === "ESRCH") return;
      if (e.code !== "EPERM") throw e;
      // macOS reports EPERM for a group holding a zombie. Still signal the
      // leader itself while Node has not reaped it (so its PID is still ours).
      if (child.exitCode !== null || child.signalCode !== null) return;
      try { process.kill(child.pid, value); } catch (inner) { if (!["ESRCH", "EPERM"].includes(inner.code)) throw inner; }
    }
  };
  signal("SIGTERM");
  await new Promise(resolve => setTimeout(resolve, graceMs));
  // Also kill descendants whose group leader exited first.
  signal("SIGKILL");
}

export function runCommand(command, args = [], options = {}) {
  const invocation = commandInvocation(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer,
    timeout: options.timeoutMs,
    killSignal: options.timeoutMs ? "SIGKILL" : undefined,
    stdio: options.stdio ?? "pipe",
    shell: options.shell,
    windowsHide: true
  });
  const result = spawnSync(invocation.command, invocation.args, invocation.options);

  return {
    command,
    args,
    status: result.status ?? 0,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

export function runCommandChecked(command, args = [], options = {}) {
  const result = runCommand(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return result;
}

export function binaryAvailable(command, versionArgs = ["--version"], options = {}) {
  const result = runCommand(command, versionArgs, options);
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") {
    return { available: false, detail: "not found" };
  }
  if (result.error) {
    if (/** @type {NodeJS.ErrnoException} */ (result.error).code === "ETIMEDOUT") {
      return { available: false, status: "unreachable", reason: "timeout", detail: `${command} ${versionArgs.join(" ")} probe timed out.` };
    }
    return { available: false, detail: result.error.message };
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    return { available: false, detail };
  }
  return { available: true, detail: result.stdout.trim() || result.stderr.trim() || "ok" };
}

function looksLikeMissingProcessMessage(text) {
  return /not found|no running instance|cannot find|does not exist|no such process/i.test(text);
}

export function terminateProcessTree(pid, options = {}) {
  if (!Number.isFinite(pid)) {
    return { attempted: false, delivered: false, method: null };
  }

  const platform = options.platform ?? process.platform;
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const killImpl = options.killImpl ?? process.kill.bind(process);

  if (platform === "win32") {
    const result = runCommandImpl("taskkill", ["/PID", String(pid), "/T", "/F"], {
      cwd: options.cwd,
      env: options.env
    });

    if (!result.error && result.status === 0) {
      return { attempted: true, delivered: true, method: "taskkill", result };
    }

    const combinedOutput = `${result.stderr}\n${result.stdout}`.trim();
    if (!result.error && looksLikeMissingProcessMessage(combinedOutput)) {
      return { attempted: true, delivered: false, method: "taskkill", result };
    }

    if (result.error?.code === "ENOENT") {
      try {
        killImpl(pid);
        return { attempted: true, delivered: true, method: "kill" };
      } catch (error) {
        if (error?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "kill" };
        }
        throw error;
      }
    }

    if (result.error) {
      throw result.error;
    }

    throw new Error(formatCommandFailure(result));
  }

  try {
    killImpl(-pid, "SIGTERM");
    return { attempted: true, delivered: true, method: "process-group" };
  } catch (error) {
    if (error?.code !== "ESRCH") {
      try {
        killImpl(pid, "SIGTERM");
        return { attempted: true, delivered: true, method: "process" };
      } catch (innerError) {
        if (innerError?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "process" };
        }
        throw innerError;
      }
    }

    return { attempted: true, delivered: false, method: "process-group" };
  }
}

export function formatCommandFailure(result) {
  const parts = [`${result.command} ${result.args.join(" ")}`.trim()];
  if (result.signal) {
    parts.push(`signal=${result.signal}`);
  } else {
    parts.push(`exit=${result.status}`);
  }
  const stderr = (result.stderr || "").trim();
  const stdout = (result.stdout || "").trim();
  if (stderr) {
    parts.push(stderr);
  } else if (stdout) {
    parts.push(stdout);
  }
  return parts.join(": ");
}
