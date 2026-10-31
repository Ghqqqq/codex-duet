import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ensureAbsolutePath } from "./fs.mjs";
import { readClaudeTranscript } from "./claude-memory.mjs";

export const TRANSCRIPT_PATH_ENV = "CODEX_COMPANION_TRANSCRIPT_PATH";
export const IMPORT_MAX_BYTES_ENV = "CODEX_COMPANION_IMPORT_MAX_BYTES";
export const FORK_BUDGET_BYTES_ENV = "CODEX_COMPANION_FORK_BUDGET_BYTES";
const DEFAULT_IMPORT_MAX_BYTES = 128 * 1024 * 1024;
const DEFAULT_FORK_BUDGET_BYTES = 2 * 1024 * 1024;
const DEFAULT_TOOL_RESULT_MAX_BYTES = 16 * 1024;
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

const contentBytes = value => Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value));
const toolPlaceholder = bytes => `[Duet: tool output trimmed for fork import, ${bytes} bytes]`;

/**
 * Slice JSONL text, or an array of lines (each assumed newline-terminated).
 * Returned lines omit terminators; slicedBytes includes one LF per line.
 * sourceBytes measures the original input, before filtering or serialization.
 */
export function sliceClaudeTranscript(lines, {
  budgetBytes = DEFAULT_FORK_BUDGET_BYTES, toolResultMaxBytes = DEFAULT_TOOL_RESULT_MAX_BYTES
} = {}) {
  for (const [name, value] of Object.entries({ budgetBytes, toolResultMaxBytes })) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer byte limit.`);
  }
  const source = typeof lines === "string" ? lines : lines.length ? lines.join("\n") + "\n" : "";
  const meta = { fromCompactBoundary: false, sourceBytes: Buffer.byteLength(source), slicedBytes: 0,
    droppedEntries: 0, trimmedToolResults: 0, trimmedImages: 0, droppedUnpairedTools: 0, tailCapped: false };
  const entries = [], parents = new Map(), replays = new Map(), ambiguous = new Set();
  const validUuid = value => typeof value === "string" && value.length > 0 && value.length <= 256;
  let start = 0, sourceEntries = 0;
  for (const [index, line] of source.split("\n").entries()) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); }
    catch { throw new Error(`Invalid Claude transcript JSON at line ${index + 1}. Retry --fork after the session finishes writing.`); }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`Invalid Claude transcript entry at line ${index + 1}.`);
    sourceEntries++;
    if (typeof entry.uuid === "string" && entry.uuid) {
      // Fingerprint source entries, before any repair. Canonical keys also
      // recognise identical replays with a different JSON property order.
      const fingerprint = crypto.createHash("sha256").update(JSON.stringify(entry, (_key, value) =>
        value && typeof value === "object" && !Array.isArray(value)
          ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : value)).digest("hex");
      let variants = replays.get(entry.uuid);
      if (variants?.has(fingerprint)) continue;
      if (!variants) replays.set(entry.uuid, variants = new Set());
      else ambiguous.add(entry.uuid);
      variants.add(fingerprint);
    }
    if (entry.type === "system" && entry.subtype === "compact_boundary" && !entry.isSidechain) {
      start = entries.length;
      meta.fromCompactBoundary = true;
    }
    entries.push(entry);
  }
  // Conflicting UUIDs cannot name an unambiguous parent. Keep their entries,
  // but never use those IDs (or oversized IDs) as link targets.
  const linkUuid = value => validUuid(value) && !ambiguous.has(value) ? value : null;
  for (const entry of entries) {
    const uuid = linkUuid(entry.uuid);
    if (uuid) parents.set(uuid, linkUuid(entry.parentUuid));
  }

  const trimBlocks = content => {
    if (!Array.isArray(content)) return content;
    return content.filter(block => !["thinking", "redacted_thinking"].includes(block?.type)).map(block => {
      if (block?.type === "image" && contentBytes(block) > toolResultMaxBytes) {
        meta.trimmedImages++;
        return { type: "text", text: "[Duet: image omitted for fork import]" };
      }
      if (block?.type === "tool_result" && block.content !== undefined) {
        // Handle images inside tool results too, without discarding small text
        // accompanying an omitted image. Keep the tool_result/id envelope.
        const content = trimBlocks(block.content);
        if (contentBytes(content) > toolResultMaxBytes) {
          meta.trimmedToolResults++;
          return { ...block, content: toolPlaceholder(contentBytes(block.content)) };
        }
        return { ...block, content };
      }
      return block;
    });
  };
  let kept = [];
  for (const entry of entries.slice(start)) {
    if (entry.isSidechain || !["user", "assistant", "system"].includes(entry.type)) continue;
    if (entry.message?.content !== undefined) {
      const content = trimBlocks(entry.message.content);
      // Claude records thinking as separate assistant entries. Empty messages
      // carry no conversational context and need not reach the importer.
      if (Array.isArray(content) && !content.length && entry.message.content.length) continue;
      entry.message = { ...entry.message, content };
    }
    // Claude often duplicates the tool payload here, outside message.content.
    // Count each replaced payload, including this auxiliary copy.
    if (entry.toolUseResult !== undefined && contentBytes(entry.toolUseResult) > toolResultMaxBytes) {
      meta.trimmedToolResults++;
      entry.toolUseResult = toolPlaceholder(contentBytes(entry.toolUseResult));
    }
    kept.push(entry);
  }

  const toolBlocks = entry => Array.isArray(entry.message?.content)
    ? entry.message.content.filter(block => ["tool_use", "tool_result"].includes(block?.type)) : [];
  const toolId = block => block.type === "tool_use" ? block.id : block.tool_use_id;
  const dropUnpaired = selected => {
    const uses = new Set(), results = new Set();
    for (const entry of selected) for (const block of toolBlocks(entry)) {
      const id = toolId(block);
      if (typeof id === "string" && id) (block.type === "tool_use" ? uses : results).add(id);
    }
    return selected.flatMap(entry => {
      if (!Array.isArray(entry.message?.content)) return [entry];
      const content = entry.message.content.filter(block => {
        if (!["tool_use", "tool_result"].includes(block?.type)) return true;
        const paired = uses.has(toolId(block)) && results.has(toolId(block));
        if (!paired) meta.droppedUnpairedTools++;
        return paired;
      });
      if (content.length === entry.message.content.length) return [entry];
      return content.length ? [{ ...entry, message: { ...entry.message, content } }] : [];
    });
  };
  kept = dropUnpaired(kept);

  const link = function* (selected) {
    const active = new Map(), resolved = new Map(), ancestors = new Array(selected.length);
    for (const entry of selected) {
      const uuid = linkUuid(entry.uuid);
      if (uuid) active.set(uuid, (active.get(uuid) ?? 0) + 1);
    }
    // Work backwards: active contains exactly the UUIDs preceding each entry.
    // A compressed path ends at an active ancestor (or a permanent miss). When
    // that ancestor is removed, later lookups follow its own parent. This also
    // preserves the forward-reference semantics without invalidating caches.
    for (let index = selected.length - 1; index >= 0; index--) {
      const entry = selected[index];
      const uuid = linkUuid(entry.uuid);
      if (uuid) {
        const count = active.get(uuid) - 1;
        if (count) active.set(uuid, count);
        else active.delete(uuid);
      }
      let parent = linkUuid(entry.parentUuid);
      const visited = new Set();
      while (parent && !active.has(parent) && !visited.has(parent)) {
        visited.add(parent);
        parent = resolved.has(parent) ? resolved.get(parent) : parents.get(parent);
      }
      if (!active.has(parent)) parent = null;
      for (const uuid of visited) resolved.set(uuid, parent);
      ancestors[index] = parent;
    }
    let previous = null;
    for (const [index, entry] of selected.entries()) {
      // Missing ancestors can occur in an already sliced source. Stay rooted
      // in this slice; never change logicalParentUuid or compactMetadata.
      const parent = index === 0 ? null : ancestors[index] ?? previous;
      const uuid = linkUuid(entry.uuid);
      if (uuid) previous = uuid;
      // Entries without a parent link stay byte-identical in shape.
      yield Object.hasOwn(entry, "parentUuid") ? { ...entry, parentUuid: parent } : entry;
    }
  };
  const serialize = selected => {
    const lines = [];
    let bytes = 0;
    for (const entry of link(selected)) {
      const line = JSON.stringify(entry), size = Buffer.byteLength(line) + 1;
      // Never materialise the remainder of an over-budget repaired transcript.
      if (bytes + size > budgetBytes) return { lines, bytes, overflow: true };
      lines.push(line);
      bytes += size;
    }
    return { lines, bytes, overflow: false };
  };
  let selected = kept, sliced = serialize(selected);
  if (sliced.overflow) {
    meta.tailCapped = true;
    const summary = meta.fromCompactBoundary ? kept.find(entry => entry.isCompactSummary) : null;

    // Entries sharing a tool exchange form one indivisible selection unit.
    // One entry may contain several calls/results, joining multiple exchanges.
    const roots = kept.map((_entry, index) => index), firstToolEntry = new Map();
    const root = index => {
      let ancestor = index;
      while (roots[ancestor] !== ancestor) ancestor = roots[ancestor];
      while (roots[index] !== index) { const next = roots[index]; roots[index] = ancestor; index = next; }
      return ancestor;
    };
    for (const [index, entry] of kept.entries()) for (const block of toolBlocks(entry)) {
      const id = toolId(block);
      if (firstToolEntry.has(id)) roots[root(index)] = root(firstToolEntry.get(id));
      else firstToolEntry.set(id, index);
    }
    const grouped = new Map();
    for (const [index, entry] of kept.entries()) {
      const id = root(index);
      if (!grouped.has(id)) grouped.set(id, { entries: [], newest: index, pinned: false, minimumBytes: 0 });
      const group = grouped.get(id);
      group.entries.push(entry);
      group.newest = index;
      if (meta.fromCompactBoundary && (entry === kept[0] || entry === summary)) group.pinned = true;
    }
    const groups = [...grouped.values()].sort((a, b) => a.newest - b.newest);
    const head = new Set(groups.filter(group => group.pinned).flatMap(group => group.entries));
    const headSlice = serialize(kept.filter(entry => head.has(entry)));
    if (headSlice.overflow) {
      throw new Error(`Claude compact boundary and summary exceed the ${budgetBytes}-byte fork budget. Raise ${FORK_BUDGET_BYTES_ENV} or use a normal brief without --fork.`);
    }

    const baseSizes = new Map();
    const baseSize = entry => {
      if (!baseSizes.has(entry)) {
        // Measure source-sized entries, retaining the parent's absent shape.
        // Cache only a number, never a potentially amplified repaired line.
        const base = Object.hasOwn(entry, "parentUuid") ? { ...entry, parentUuid: null } : entry;
        baseSizes.set(entry, Buffer.byteLength(JSON.stringify(base)) + 1);
      }
      return baseSizes.get(entry);
    };
    const selectionSize = selection => {
      let total = 0, index = 0;
      for (const entry of link(selection)) {
        total += baseSize(selection[index++]);
        if (Object.hasOwn(entry, "parentUuid")) total += Buffer.byteLength(JSON.stringify(entry.parentUuid)) - 4;
      }
      return total;
    };
    const tail = [];
    let remaining = budgetBytes - headSlice.bytes;
    for (let index = groups.length - 1; index >= 0; index--) {
      const group = groups[index];
      if (group.pinned) continue;
      // A one-character UUID is one byte shorter than null; all repaired
      // parent values are bounded IDs or null.
      group.minimumBytes = group.entries.reduce((sum, entry) => sum + baseSize(entry) - (Object.hasOwn(entry, "parentUuid") ? 1 : 0), 0);
      if (group.minimumBytes > remaining) continue;
      tail.push(group);
      remaining -= group.minimumBytes;
    }
    tail.reverse();
    const selection = () => {
      const included = new Set([...head, ...tail.flatMap(group => group.entries)]);
      return kept.filter(entry => included.has(entry));
    };
    selected = selection();
    let size = selectionSize(selected);
    while (size > budgetBytes && tail.length) {
      let excess = size - budgetBytes, count = 0;
      // Repair can grow parents; remove whole oldest exchanges in batches.
      do { excess -= tail[count++].minimumBytes; } while (excess > 0 && count < tail.length);
      tail.splice(0, count);
      selected = selection();
      size = selectionSize(selected);
    }
    selected = dropUnpaired(selected);
    sliced = serialize(selected);
    if (!sliced.lines.length && kept.length) throw new Error(`No Claude conversation entry fits the fork budget. Raise ${FORK_BUDGET_BYTES_ENV} or use a normal brief without --fork.`);
  }
  if (sliced.overflow) throw new Error("Claude fork slice exceeded its byte budget after repairing links.");
  meta.slicedBytes = sliced.bytes;
  meta.droppedEntries = sourceEntries - sliced.lines.length;
  return { lines: sliced.lines, meta };
}

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
  const budgetBytes = Number(env[FORK_BUDGET_BYTES_ENV] ?? DEFAULT_FORK_BUDGET_BYTES);
  if (!Number.isSafeInteger(budgetBytes) || budgetBytes <= 0) {
    throw new Error(`${FORK_BUDGET_BYTES_ENV} must be a positive integer byte limit.`);
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
    // Read only the length observed at open. Appends cannot grow the source
    // read or change the original bytes used for fork provenance.
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      const bytes = fs.readSync(input, buffer, offset, Math.min(64 * 1024, stat.size - offset), offset);
      if (!bytes) throw new Error("Claude transcript changed while taking its snapshot. Retry --fork or use a normal brief.");
      offset += bytes;
    }
    const sourceSha256 = crypto.createHash("sha256").update(buffer).digest("hex");
    const sliced = sliceClaudeTranscript(buffer.toString("utf8"), { budgetBytes });
    // Use the observed byte count even if the source contained malformed UTF-8.
    sliced.meta.sourceBytes = stat.size;
    directory = fs.mkdtempSync(path.join(projects, ".duet-import-"));
    fs.chmodSync(directory, 0o700);
    fs.writeFileSync(path.join(directory, IMPORT_MARKER), importMarker(directory), { flag: "wx", mode: 0o600 });
    const snapshotPath = path.join(directory, path.basename(source));
    fs.writeFileSync(snapshotPath, sliced.lines.length ? sliced.lines.join("\n") + "\n" : "", { flag: "wx", mode: 0o600 });
    return { sourcePath: source, sourceSha256, snapshotPath, forkSlice: sliced.meta,
      cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
  } catch (error) {
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  } finally {
    fs.closeSync(input);
  }
}
