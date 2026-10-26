import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { binaryAvailable } from "./process.mjs";

// Resolve existing ancestors too, so a not-yet-created child of a symlink is checked.
function canonicalPath(value) {
  const absolute = path.resolve(value);
  try { return fs.realpathSync.native(absolute); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    const parent = path.dirname(absolute);
    if (parent === absolute) throw error;
    return path.join(canonicalPath(parent), path.basename(absolute));
  }
}
function contains(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function resolveIsolatedCodexHome(env = process.env) {
  const userHome = env.HOME || env.USERPROFILE || os.homedir();
  const requested = env.CODEX_COMPANION_HOME || path.join(userHome, ".claude", "codex-isolated");
  if (!path.isAbsolute(requested)) throw new Error("CODEX_COMPANION_HOME must be an absolute isolated directory.");
  const isolated = canonicalPath(requested);
  if (env.CODEX_COMPANION_TEST_MODE === "1") {
    const root = env.CODEX_COMPANION_TEST_ROOT;
    if (!root || !contains(canonicalPath(root), isolated)) throw new Error("Test-home guard: isolated home must stay inside this test's temporary root; real Codex homes are forbidden.");
    for (const value of [env.CODEX_HOME, env.CODEX_SQLITE_HOME, env.CLAUDE_PLUGIN_DATA]) {
      if (value && !contains(canonicalPath(root), canonicalPath(value))) throw new Error("Test-home guard: Codex homes and plugin data must be temporary.");
    }
  }
  const normalHomes = [
    path.join(userHome, ".codex"),
    env.CODEX_COMPANION_NORMAL_HOME || env.CODEX_HOME,
    env.CODEX_COMPANION_NORMAL_SQLITE_HOME || env.CODEX_SQLITE_HOME
  ].filter(Boolean);
  for (const normalHome of normalHomes) {
    const normal = canonicalPath(normalHome);
    if (contains(normal, isolated) || contains(isolated, normal)) {
      throw new Error("Isolated Codex home must not overlap the normal Codex home or SQLite storage (including symlinks).");
    }
  }
  return isolated;
}

// A private runtime pointer lets this integration use a verified CLI without changing PATH globally.
export function resolveCodexSelection(env = process.env) {
  let selected = env.CODEX_COMPANION_BIN;
  let source = selected ? "CODEX_COMPANION_BIN" : "PATH";
  const runtimeFile = path.join(resolveIsolatedCodexHome(env), "runtime.json");
  if (!selected) {
    if (fs.existsSync(runtimeFile)) selected = JSON.parse(fs.readFileSync(runtimeFile, "utf8")).codexBinary;
    if (selected) source = "runtime.json";
  }
  if (env.CODEX_COMPANION_TEST_MODE === "1") {
    const root = canonicalPath(env.CODEX_COMPANION_TEST_ROOT);
    const explicit = Boolean(selected);
    selected ||= (env.PATH || "").split(path.delimiter).map(dir => path.join(dir, "codex")).find(file => fs.existsSync(file));
    if (!selected || !path.isAbsolute(selected) || !contains(root, canonicalPath(selected))) {
      if (explicit) throw new Error("Test-home guard: refusing a non-fixture Codex executable.");
      // An unavailable fixture is reported as unavailable, never resolved from
      // the developer's PATH or installed application's executable.
      return { binary: path.join(root, "missing-codex-fixture"), source, runtimeFile };
    }
  }
  if (!selected) return { binary: "codex", source, runtimeFile };
  if (typeof selected !== "string" || !path.isAbsolute(selected)) {
    throw new Error("The isolated Codex runtime must be an absolute executable path.");
  }
  return { binary: selected, source, runtimeFile };
}

export function resolveCodexBinary(env = process.env) {
  return resolveCodexSelection(env).binary;
}

export function executableOnPath(name, env = process.env) {
  const suffixes = process.platform === "win32" ? (env.PATHEXT || ".EXE;.CMD;.BAT").split(";") : [""];
  return (env.PATH || "").split(path.delimiter).flatMap(dir => suffixes.map(ext => path.resolve(dir, name + ext))).find(candidate => {
    try { fs.accessSync(candidate, fs.constants.X_OK); return fs.statSync(candidate).isFile(); }
    catch { return false; }
  }) ?? null;
}

// Diagnose the selected runtime, never silently bypass a broken private pin.
// Optional PATH probes share the caller's readiness deadline; they only enrich
// guidance and must never hang setup after the selected runtime has failed.
const DIAGNOSTIC_PROBE_TIMEOUT_MS = 20000;
export function codexRuntimeDiagnostic(cwd, availability, env = process.env, { deadline = Date.now() + DIAGNOSTIC_PROBE_TIMEOUT_MS } = {}) {
  const { binary, source, runtimeFile } = resolveCodexSelection(env);
  const executable = path.isAbsolute(binary) ? binary : executableOnPath(binary, env) ?? binary;
  const result = { executable, source, pathCodex: null, guidance: null };
  if (availability.available) return result;
  if (source === "PATH") {
    const repair = executable === "codex"
      ? "Install Codex with `npm install -g @openai/codex`, then rerun setup."
      : `Repair or replace ${executable}, or change PATH to select a working Codex runtime.`;
    result.guidance = `Selected executable ${executable} (source: PATH) is unavailable. ${repair}`;
    return result;
  }
  const candidate = executableOnPath("codex", env);
  // Diagnostic probes obey the same fixture boundary as normal runtime startup.
  const allowed = candidate && (env.CODEX_COMPANION_TEST_MODE !== "1" || contains(canonicalPath(env.CODEX_COMPANION_TEST_ROOT), canonicalPath(candidate)));
  if (allowed) {
    const probe = args => {
      const remaining = Math.min(DIAGNOSTIC_PROBE_TIMEOUT_MS, deadline - Date.now());
      return remaining > 0 ? binaryAvailable(candidate, args, { cwd, env: isolatedCodexEnv(env), timeoutMs: remaining }) : { available: false };
    };
    result.pathCodex = { path: candidate, available: probe(["--version"]).available && probe(["app-server", "--help"]).available };
  }
  const setting = source === "CODEX_COMPANION_BIN" ? "CODEX_COMPANION_BIN" : `codexBinary in ${runtimeFile}`;
  const fallback = result.pathCodex?.available ? ` PATH has a working Codex at ${candidate}.` : "";
  result.guidance = `Selected executable ${executable} (source: ${source}) is ${fs.existsSync(executable) ? "unusable" : "missing"}.${fallback} Fix or remove ${setting}; a global install cannot override this pin.`;
  return result;
}

// Capture this before spawning a broker; recomputing it during handshake could
// mislabel an old process after runtime.json or the executable has changed.
export function resolveCodexRuntimeIdentity(env = process.env) {
  const binary = resolveCodexBinary(env);
  let executable = binary;
  if (!path.isAbsolute(executable)) {
    const suffixes = process.platform === "win32" ? (env.PATHEXT || ".EXE;.CMD;.BAT").split(";") : [""];
    const candidates = (env.PATH || "").split(path.delimiter).flatMap(dir => suffixes.map(ext => path.resolve(dir, binary + ext)));
    executable = candidates.find(candidate => {
      try { fs.accessSync(candidate, fs.constants.X_OK); return fs.statSync(candidate).isFile(); }
      catch { return false; }
    });
    if (!executable) throw new Error("Cannot resolve the isolated Codex executable on PATH.");
  }
  const resolved = fs.realpathSync.native(executable);
  const stat = fs.statSync(resolved);
  return JSON.stringify({ path: resolved, inode: stat.ino, size: stat.size, modified: stat.mtimeMs });
}

export function isolatedCodexEnv(env = process.env) {
  const home = resolveIsolatedCodexHome(env);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  return {
    ...env,
    CODEX_COMPANION_NORMAL_HOME: env.CODEX_COMPANION_NORMAL_HOME || env.CODEX_HOME || path.join(env.HOME || os.homedir(), ".codex"),
    CODEX_COMPANION_NORMAL_SQLITE_HOME: env.CODEX_COMPANION_NORMAL_SQLITE_HOME || env.CODEX_SQLITE_HOME || env.CODEX_COMPANION_NORMAL_HOME || env.CODEX_HOME || path.join(env.HOME || os.homedir(), ".codex"),
    CODEX_COMPANION_HOME: home,
    CODEX_HOME: home,
    CODEX_SQLITE_HOME: home
  };
}

export function isolatedCodexArgs(args, env = process.env) {
  const home = resolveIsolatedCodexHome(env);
  return [...args,
    "-c", `sqlite_home=${JSON.stringify(home)}`,
    "-c", `log_dir=${JSON.stringify(path.join(home, "log"))}`,
    "-c", 'cli_auth_credentials_store="file"',
    "-c", 'mcp_oauth_credentials_store="file"'
  ];
}

function quote(value) { return `'${String(value).replace(/'/g, `'"'"'`)}'`; }
export function isolatedCodexCommand(args, env = process.env) {
  const wrapper = fileURLToPath(new URL("../codex-isolated.mjs", import.meta.url));
  return [process.execPath, wrapper, "--home", resolveIsolatedCodexHome(env), ...args].map(quote).join(" ");
}
