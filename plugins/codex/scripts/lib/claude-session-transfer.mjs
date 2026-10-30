import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ensureAbsolutePath } from "./fs.mjs";
import { readClaudeTranscript } from "./claude-memory.mjs";

export const TRANSCRIPT_PATH_ENV = "CODEX_COMPANION_TRANSCRIPT_PATH";
export const IMPORT_MAX_BYTES_ENV = "CODEX_COMPANION_IMPORT_MAX_BYTES";
const DEFAULT_IMPORT_MAX_BYTES = 20 * 1024 * 1024;
const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";
const MAX_PROJECT_ENTRIES = 10000;
// Match retention's configured-profile precedence; relative config roots are
// not profiles and must not make instruction/import selection depend on cwd.
export function resolveClaudeConfigRoot(env = process.env) {
  return env.CLAUDE_CONFIG_DIR && path.isAbsolute(env.CLAUDE_CONFIG_DIR)
    ? path.resolve(env.CLAUDE_CONFIG_DIR)
    : path.join(env.HOME || env.USERPROFILE || os.homedir(), ".claude");
}
const projectsDirectory = (env = process.env) => path.join(resolveClaudeConfigRoot(env), "projects");
const IMPORT_MAX_AGE_MS = 60 * 60 * 1000;
const IMPORT_MARKER = ".duet-import.json";
const importMarker = directory => JSON.stringify({ version: 1, kind: "duet-claude-import", directory: path.basename(directory) });
const sameFile = (left, right) => left.dev === right.dev && left.ino === right.ino;

function resolveUserPath(cwd, value, env) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  if (value === "~") {
    return home;
  }
  if (String(value).startsWith("~/")) {
    return path.join(home, String(value).slice(2));
  }
  return ensureAbsolutePath(cwd, value);
}

function findSessionTranscript(sessionId, env) {
  if (!sessionId || /[\\/\0]/.test(sessionId)) return null;
  // Only inspect the named leaf in direct project directories. Never recurse,
  // follow project aliases, or choose the first match from an ambiguous scan.
  let found = null, visited = 0;
  try {
    const projects = projectsDirectory(env), directory = fs.opendirSync(projects);
    try {
      for (let entry; (entry = directory.readSync());) {
        if (++visited > MAX_PROJECT_ENTRIES) return null;
        if (!entry.isDirectory() || entry.name.startsWith(".duet-import-")) continue;
        const candidate = path.join(projects, entry.name, `${sessionId}.jsonl`);
        if (!fs.lstatSync(candidate, { throwIfNoEntry: false })?.isFile()) continue;
        if (found) return null;
        found = candidate;
      }
    } finally { directory.closeSync(); }
  } catch { return null; }
  return found;
}

function validateClaudeSessionPath(cwd, options = {}, env = process.env) {
  const sessionId = options.sessionId;
  const explicitSource = options.explicitSource ?? Boolean(options.source);
  const requestedPath = options.source || (sessionId && readClaudeTranscript(sessionId, env)) ||
    findSessionTranscript(sessionId, env) ||
    ((!sessionId || env[SESSION_ID_ENV] === sessionId) && env[TRANSCRIPT_PATH_ENV]);
  if (!requestedPath) {
    throw new Error("Could not identify the current Claude transcript. Retry with --source <path-to-claude-jsonl>.");
  }

  const sourcePath = resolveUserPath(cwd, requestedPath, env);
  const requireSessionBasename = file => {
    // An explicit source intentionally selects a transcript; only inferred
    // paths must belong to the dispatching session. All stay projects-confined.
    if (!explicitSource && sessionId && path.basename(file) !== `${sessionId}.jsonl`) {
      throw new Error(`Claude session source must be named ${sessionId}.jsonl for the current session: ${file}`);
    }
  };
  requireSessionBasename(sourcePath);
  if (path.extname(sourcePath) !== ".jsonl") {
    throw new Error(`Claude session source must be a JSONL file: ${sourcePath}`);
  }

  let source;
  let projects;
  try {
    source = fs.realpathSync(sourcePath);
    projects = fs.realpathSync(projectsDirectory(env));
  } catch {
    throw new Error(`Claude session file not found: ${sourcePath}`);
  }
  requireSessionBasename(source);
  const relative = path.relative(projects, source);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Codex can import Claude sessions only from ${projectsDirectory(env)}: ${source}`);
  }
  const stat = fs.lstatSync(source);
  if (!stat.isFile()) throw new Error(`Claude session source must be a regular file: ${source}`);
  if (fs.realpathSync(source) !== source || fs.realpathSync(projectsDirectory(env)) !== projects) throw new Error("Claude session source changed during validation.");
  return { source, projects, stat };
}

export function resolveClaudeSessionPath(cwd, options = {}, env = process.env) {
  return validateClaudeSessionPath(cwd, options, env).source;
}

function inspectImportDirectory(directory, cutoff) {
  const uid = process.getuid?.(), stat = fs.lstatSync(directory);
  // Names and private layouts do not prove ownership: require Duet's marker.
  // Fork/transfer staging has no released pre-marker copies to support.
  if (uid === undefined || !/^\.duet-import-[A-Za-z0-9]{6}$/.test(path.basename(directory)) ||
      !stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o777) !== 0o700 || stat.mtimeMs >= cutoff ||
      fs.realpathSync(directory) !== directory) return null;
  const names = fs.readdirSync(directory);
  if (!names.includes(IMPORT_MARKER) || names.filter(name => name !== IMPORT_MARKER).length > 1 || names.some(name => name !== IMPORT_MARKER && !name.endsWith(".jsonl"))) return null;
  const files = [];
  for (const name of names) {
    const file = path.join(directory, name), identity = fs.lstatSync(file);
    if (!identity.isFile() || identity.uid !== uid || (identity.mode & 0o777) !== 0o600 || identity.mtimeMs >= cutoff) return null;
    if (name === IMPORT_MARKER) {
      if (identity.size > 256) return null;
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        if (!sameFile(identity, fs.fstatSync(fd)) || fs.readFileSync(fd, "utf8") !== importMarker(directory)) return null;
      } finally { fs.closeSync(fd); }
    }
    files.push({ path: file, dev: identity.dev, ino: identity.ino, bytes: identity.size });
  }
  return { path: directory, dev: stat.dev, ino: stat.ino, bytes: files.reduce((sum, file) => sum + file.bytes, 0), files };
}

export function planClaudeImports({ now = Date.now(), env = process.env } = {}) {
  const imports = [], errors = [], cutoff = Number(new Date(now)) - IMPORT_MAX_AGE_MS;
  try {
    if (!Number.isFinite(cutoff)) throw new Error("Invalid Claude import retention date.");
    const projects = fs.realpathSync(projectsDirectory(env));
    for (const entry of fs.readdirSync(projects, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\.duet-import-[A-Za-z0-9]{6}$/.test(entry.name)) continue;
      const directory = path.join(projects, entry.name);
      try {
        const candidate = inspectImportDirectory(directory, cutoff);
        if (candidate) imports.push(candidate);
      } catch (error) { if (error.code !== "ENOENT") errors.push({ path: directory, message: error.message }); }
    }
  } catch (error) { if (error.code !== "ENOENT") errors.push({ scope: "claude-imports", message: error.message }); }
  return { imports, errors };
}

export function sweepClaudeImports({ now = Date.now(), env = process.env, files = null } = {}) {
  const planned = planClaudeImports({ now, env });
  const result = { importsDeleted: 0, bytesFreed: 0, errors: [...planned.errors] };
  const selected = files && new Map(files.map(file => [file.path, file]));
  const cutoff = Number(new Date(now)) - IMPORT_MAX_AGE_MS;
  for (const candidate of planned.imports) {
    if (selected && (!selected.has(candidate.path) || !sameFile(candidate, selected.get(candidate.path)))) continue;
    try {
      if (path.dirname(candidate.path) !== fs.realpathSync(projectsDirectory(env))) continue;
      const current = inspectImportDirectory(candidate.path, cutoff);
      if (!current || !sameFile(candidate, current)) continue;
      for (const file of current.files) {
        const stat = fs.lstatSync(file.path);
        if (!stat.isFile() || !sameFile(stat, file) || stat.mtimeMs >= cutoff) throw new Error("Claude import changed during cleanup.");
        fs.unlinkSync(file.path);
        result.bytesFreed += stat.size;
      }
      // A new file or child directory wins over cleanup. Never use recursive rm.
      fs.rmdirSync(candidate.path);
      result.importsDeleted++;
    } catch (error) { if (error.code !== "ENOENT") result.errors.push({ path: candidate.path, message: error.message }); }
  }
  return result;
}

// Stage inside the importer's accepted projects tree, in a new owner-only
// directory per import. A unique source path also prevents ledger reuse by a
// second --fork of unchanged content.
export function snapshotClaudeSession(cwd, sourcePath, env = process.env, provenance = {}) {
  const { sessionId, explicitSource } = /** @type {{ sessionId?: string, explicitSource?: boolean }} */ (provenance);
  sweepClaudeImports({ env });
  // A resolved path is not necessarily a user-selected --source. Preserve its
  // provenance when rechecking the realpath immediately before staging it.
  const { source, projects, stat: validated } = validateClaudeSessionPath(cwd, { source: sourcePath, sessionId, explicitSource }, env);
  const maxBytes = Number(env[IMPORT_MAX_BYTES_ENV] ?? DEFAULT_IMPORT_MAX_BYTES);
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error(`${IMPORT_MAX_BYTES_ENV} must be a positive integer byte limit.`);
  }
  const input = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  let directory;
  try {
    const stat = fs.fstatSync(input);
    if (!stat.isFile()) throw new Error(`Claude session source must be a regular file: ${source}`);
    if (!sameFile(stat, validated) || !sameFile(stat, fs.lstatSync(source)) ||
        fs.realpathSync(source) !== source || fs.realpathSync(projectsDirectory(env)) !== projects) {
      throw new Error("Claude session source changed after validation; import refused.");
    }
    if (stat.size > maxBytes) {
      throw new Error(`Claude transcript is ${stat.size} bytes, above the ${maxBytes}-byte import limit. Use a normal duet task brief without --fork, or explicitly raise ${IMPORT_MAX_BYTES_ENV}.`);
    }
    directory = fs.mkdtempSync(path.join(projects, ".duet-import-"));
    fs.chmodSync(directory, 0o700);
    fs.writeFileSync(path.join(directory, IMPORT_MARKER), importMarker(directory), { flag: "wx", mode: 0o600 });
    const snapshotPath = path.join(directory, path.basename(source));
    const output = fs.openSync(snapshotPath, "wx", 0o600);
    try {
      // Copy only the length observed at open, so an appending session cannot
      // grow beyond the budget or change the bytes hashed by the importer.
      const buffer = Buffer.alloc(Math.min(stat.size, 64 * 1024));
      let offset = 0;
      while (offset < stat.size) {
        const bytes = fs.readSync(input, buffer, 0, Math.min(buffer.length, stat.size - offset), offset);
        if (!bytes) throw new Error("Claude transcript changed while taking its snapshot. Retry --fork or use a normal brief.");
        let written = 0;
        while (written < bytes) written += fs.writeSync(output, buffer, written, bytes - written);
        offset += bytes;
      }
    } finally {
      fs.closeSync(output);
    }
    return { sourcePath: source, snapshotPath, cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
  } catch (error) {
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  } finally {
    fs.closeSync(input);
  }
}
