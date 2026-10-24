// Session snapshots are write-once, from the first prompt.context only. The
// hook also remembers incomplete attempts so later subagent contexts cannot
// supply a replacement. CLAUDE.md edits apply from the next Claude session.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveStateRoot, withJournalLock } from "./state.mjs";
import { instructionInventory } from "../../hooks/claude-memory.mjs";

export const EXECUTOR_FRAMING = "The following are the user's Claude Code instruction files (CLAUDE.md and rules), included so you follow the same user rules as Claude's own subagents. You are a delegated worker executing one assignment: apply only the instructions relevant to your assignment and your owned paths; do not delegate to other agents or start other workers; if an instruction conflicts with your assignment brief, follow the brief and report the conflict.";
export const INSTRUCTION_LIMIT = 60000; // UTF-16 units, including framing and omissions.
const SNAPSHOT_BYTES = 8 * 1024 * 1024;
const FALLBACK_NOTE = "Approximate startup scan: readable managed policy, ~/.claude/CLAUDE.md and rules, then session-cwd ancestors (CLAUDE.md, .claude/CLAUDE.md, unconditional rules, CLAUDE.local.md). Scan root: --session-cwd, then CODEX_COMPANION_SESSION_CWD, then the worker cwd. Imports stay within their directory tree, at most four hops. Scan budget: 256 files, 1,000,000 characters, 2,048 rule directories. Effective settings, exclusions, external-import approvals, inline policy, AGENTS fallback and later path-triggered rules cannot be reproduced without Claude's loaded inventory.";
const hash = value => createHash("sha256").update(value).digest("hex");
const digest = value => hash(JSON.stringify(value));
export const CLAUDE_MEMORY_DIR = "claude-memory";
const snapshotDirectory = env => path.join(resolveStateRoot(env), CLAUDE_MEMORY_DIR);

function requireSnapshotDirectory(env) {
  const directory = snapshotDirectory(env);
  if (!fs.lstatSync(directory).isDirectory() || fs.realpathSync(directory) !== directory) throw new Error("Unsafe Claude snapshot directory.");
  return directory;
}

export function claudeSnapshotFile(sessionId, env = process.env) {
  return sessionId ? path.join(snapshotDirectory(env), `${hash(sessionId)}.json`) : null;
}

function snapshotOf(payload) {
  const inventory = instructionInventory(payload.entries.map(entry => ({ path: entry.path, kind: entry.tier, content: entry.text, parent: entry.importer })));
  const data = { version: 1, sessionId: payload.sessionId, cwd: payload.cwd,
    ...inventory, complete: payload.complete === true && inventory.complete,
    inventoryAvailable: payload.inventoryAvailable === true && inventory.inventoryAvailable,
    omittedPaths: [...(payload.omittedPaths ?? []), ...inventory.omittedPaths].slice(0, 256),
    omittedCount: (payload.omittedCount ?? 0) + inventory.omittedCount,
    bounded: Boolean(payload.bounded || inventory.bounded) };
  return { ...data, hash: digest(data), capturedAt: new Date().toISOString() };
}

export function writeClaudeSnapshot(payload, env = process.env) {
  if (env.CODEX_COMPANION_CLAUDE_MD === "0") return null;
  const file = claudeSnapshotFile(payload.sessionId, env);
  if (!file) return null;
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  requireSnapshotDirectory(env);
  fs.chmodSync(dir, 0o700);
  return withJournalLock(dir, () => {
    const previous = readClaudeSnapshot(payload.sessionId, env);
    if (previous) return previous;
    const snapshot = snapshotOf(payload), serialized = JSON.stringify(snapshot);
    if (!snapshot.inventoryAvailable) return null;
    if (Buffer.byteLength(serialized) > SNAPSHOT_BYTES) throw new Error("Claude instruction snapshot exceeds its storage budget.");
    const temporary = path.join(dir, `.${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temporary, serialized, { flag: "wx", mode: 0o600 });
      fs.renameSync(temporary, file);
    } finally { fs.rmSync(temporary, { force: true }); }
    return snapshot;
  }, { lockTimeoutMs: 1000 });
}

export function readClaudeSnapshot(sessionId, env = process.env) {
  try {
    const file = claudeSnapshotFile(sessionId, env);
    if (!file || fs.statSync(file).size > SNAPSHOT_BYTES) return null;
    const { hash: savedHash, capturedAt, ...data } = JSON.parse(fs.readFileSync(file, "utf8"));
    if (data.version !== 1 || data.sessionId !== sessionId || !Array.isArray(data.entries) || digest(data) !== savedHash) return null;
    return { ...data, hash: savedHash, capturedAt };
  } catch { return null; }
}

export function deleteClaudeSnapshot(sessionId, env = process.env) {
  const file = claudeSnapshotFile(sessionId, env);
  if (!file) return false;
  try {
    const directory = requireSnapshotDirectory(env);
    return withJournalLock(directory, () => {
      requireSnapshotDirectory(env);
      if (!fs.lstatSync(file, { throwIfNoEntry: false })?.isFile()) return false;
      fs.unlinkSync(file);
      return true;
    }, { lockTimeoutMs: 1000 });
  } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

export function planClaudeSnapshots(cutoff, { env = process.env } = {}) {
  const snapshots = [], errors = [];
  try {
    const directory = requireSnapshotDirectory(env);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
      const file = path.join(directory, entry.name), stat = fs.lstatSync(file);
      if (stat.isFile() && stat.mtimeMs < cutoff) snapshots.push({ path: file, bytes: stat.size });
    }
  } catch (error) { if (error.code !== "ENOENT") errors.push({ scope: "claude-snapshots", message: error.message }); }
  return { snapshots, errors };
}

export function pruneClaudeSnapshots(files, cutoff, { env = process.env } = {}) {
  const result = { snapshotsDeleted: 0, bytesFreed: 0, errors: [] };
  if (!files.length) return result;
  try {
    const directory = requireSnapshotDirectory(env), selected = new Set(files.map(file => file.path));
    withJournalLock(directory, () => {
      const current = planClaudeSnapshots(cutoff, { env });
      result.errors.push(...current.errors);
      for (const file of current.snapshots) {
        if (!selected.has(file.path)) continue;
        try {
          requireSnapshotDirectory(env);
          const stat = fs.lstatSync(file.path);
          if (!stat.isFile() || stat.mtimeMs >= cutoff) continue;
          fs.unlinkSync(file.path);
          result.snapshotsDeleted++;
          result.bytesFreed += stat.size;
        } catch (error) { if (error.code !== "ENOENT") result.errors.push({ path: file.path, message: error.message }); }
      }
    }, { lockTimeoutMs: 1000 });
  } catch (error) { if (error.code !== "ENOENT") result.errors.push({ scope: "claude-snapshots", message: error.message }); }
  return result;
}

const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
};
const autoMemory = file => /[\\/]\.claude[\\/](?:projects[\\/].*[\\/]memory|agent-memory(?:-local)?)[\\/]/.test(file);

// Deliberately approximate, never a second implementation of Claude's loader.
// Do not follow symlinks/imports out of the containing tree or read auto memory.
export function scanClaudeInstructions(cwd, env = process.env) {
  const files = [], seen = new Set();
  const managed = process.platform === "darwin" ? "/Library/Application Support/ClaudeCode" : process.platform === "win32" ? path.join(env.ProgramFiles || "C:\\Program Files", "ClaudeCode") : "/etc/claude-code";
  const user = path.join(env.HOME || env.USERPROFILE || os.homedir(), ".claude");
  const ancestors = [];
  for (let dir = path.resolve(cwd); path.dirname(dir) !== dir; dir = path.dirname(dir)) ancestors.unshift(dir);
  const memoryRoots = new Set();
  const excludeDirectory = directory => {
    try {
      const real = fs.realpathSync(directory);
      if (fs.statSync(real).isDirectory()) memoryRoots.add(real);
    } catch { /* Missing or unreadable memory directories cannot be resolved. */ }
  };
  // Discover physical memory roots before loading any imports: aliases may
  // erase both the .claude spelling and the official memory directory name.
  for (const config of new Set([user, path.join(managed, ".claude"), ...ancestors.map(dir => path.join(dir, ".claude"))])) {
    for (const name of ["projects", "agent-memory", "agent-memory-local"]) {
      const directory = path.join(config, name);
      if (name !== "projects") excludeDirectory(directory);
      try {
        for (const child of fs.readdirSync(directory)) {
          excludeDirectory(name === "projects" ? path.join(directory, child, "memory") : path.join(directory, child));
        }
      } catch { /* No readable memory inventory at this location. */ }
    }
  }
  let bytes = 0, bounded = false, visited = 0;
  function add(candidate, kind, root = path.dirname(candidate), parent, depth = 0, rule = false, logical = candidate) {
    if (files.length >= 256 || bytes >= 1000000) { bounded = true; return; }
    try {
      const file = fs.realpathSync(candidate), tree = fs.realpathSync(root);
      if (!inside(tree, file) || seen.has(file) || autoMemory(logical) || autoMemory(file)
          || autoMemory(path.resolve(root, path.relative(tree, file)))
          || [...memoryRoots].some(memory => inside(memory, file))) return;
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > 4 * 1024 * 1024) return;
      const raw = fs.readFileSync(file, "utf8"), frontmatter = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
      if (rule && frontmatter && /^\s*paths\s*:/m.test(frontmatter[1])) return;
      const content = raw.slice(frontmatter?.[0].length ?? 0).replace(/<!--[\s\S]*?-->/g, "");
      files.push({ path: file, kind, content, parent }); seen.add(file); bytes += content.length;
      if (depth >= 4) return;
      const imports = content.replace(/^\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s*\1[^\n]*$/gm, "").replace(/`+[^`]*`+/g, "");
      for (const match of imports.matchAll(/(?:^|\s)@([^\s<>"'`]+)/g)) {
        const target = match[1];
        // No expansion of ~, absolute imports, or directory traversal outside
        // the original importing file's tree, even through a symlink.
        if (target.startsWith("~") || path.isAbsolute(target)) continue;
        // Keep the logical spelling through imports: realpath can erase a
        // symlinked .claude or memory directory before the exclusion runs.
        add(path.resolve(path.dirname(file), target), kind, root, file, depth + 1, rule,
          path.resolve(path.dirname(logical), target));
      }
    } catch { /* Unreadable policy and missing files are not loaded. */ }
  }
  function rules(root, kind, dir = root) {
    if (++visited > 2048) { bounded = true; return; }
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); } catch { return; }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) rules(root, kind, file);
      else if (entry.name.endsWith(".md")) add(file, kind, root, undefined, 0, true);
    }
  }
  add(path.join(managed, "CLAUDE.md"), "managed"); rules(path.join(managed, ".claude", "rules"), "managed");
  add(path.join(user, "CLAUDE.md"), "user"); rules(path.join(user, "rules"), "user");
  for (const dir of ancestors) {
    add(path.join(dir, "CLAUDE.md"), "project");
    add(path.join(dir, ".claude", "CLAUDE.md"), "project");
    rules(path.join(dir, ".claude", "rules"), "project");
    add(path.join(dir, "CLAUDE.local.md"), "local");
  }
  const inventory = instructionInventory(files);
  return snapshotOf({ sessionId: null, cwd: path.resolve(cwd), ...inventory, complete: false, bounded });
}

export function renderClaudeInstructions(snapshot) {
  const entries = snapshot.entries;
  const blocks = entries.map(entry => `\n\n### ${entry.path}\n${entry.text}`);
  function omissions(count) {
    const paths = [...entries.slice(count).map(entry => entry.path), ...snapshot.omittedPaths];
    const total = entries.length - count + snapshot.omittedCount;
    if (!total) return "";
    let tail = "\n\nOmitted instruction files (budget):", listed = 0;
    for (const file of paths) {
      if (tail.length + file.length + 3 > INSTRUCTION_LIMIT / 2) break;
      tail += `\n- ${file}`; listed++;
    }
    if (total > listed) tail += `\n- ${total - listed} additional paths omitted from this list.`;
    return tail;
  }
  let count = 0, text = EXECUTOR_FRAMING;
  while (count < entries.length && text.length + blocks[count].length + omissions(count + 1).length <= INSTRUCTION_LIMIT) text += blocks[count++];
  text += omissions(count);
  return { developerInstructions: text, omittedPaths: [...entries.slice(count).map(entry => entry.path), ...snapshot.omittedPaths], omittedCount: entries.length - count + snapshot.omittedCount };
}

function requireSessionCwd(value, source) {
  try {
    if (typeof value === "string" && path.isAbsolute(value) && fs.statSync(value).isDirectory()) return path.resolve(value);
  } catch { /* Report invalid, absent, or inaccessible directories consistently. */ }
  throw new Error(`${source} requires an absolute existing directory.`);
}

export function prepareClaudeInstructions({ sessionId, cwd, sessionCwd, previousRequest, resuming = false, disabled = false }, env = process.env) {
  if (sessionCwd !== undefined) sessionCwd = requireSessionCwd(sessionCwd, "--session-cwd");
  disabled ||= env.CODEX_COMPANION_CLAUDE_MD === "0";
  const previous = previousRequest?.claudeMd;
  if (resuming) {
    if (disabled && previousRequest?.developerInstructions) throw new Error("This thread already has Claude instructions. Use --fresh --no-claude-md to opt out without changing an existing thread.");
    const current = !disabled && !previous?.disabled ? readClaudeSnapshot(sessionId, env) : null;
    return { developerInstructions: previousRequest?.developerInstructions ?? null,
      claudeMd: { ...(previous ?? { version: 1, source: "unrecorded", complete: false, note: "Existing thread predates captured instructions; start a fresh thread to apply them." }),
        ...(current && previous?.snapshotHash && current.hash !== previous.snapshotHash ? { snapshotChanged: true, observedSnapshotHash: current.hash, note: "The session snapshot changed; this thread retains its original developer instructions. Start a fresh thread to use the new snapshot." } : {}) } };
  }
  if (disabled) return { developerInstructions: null, claudeMd: { version: 1, disabled: true, approximate: false, snapshotHash: null, renderedHash: null } };
  const capture = readClaudeSnapshot(sessionId, env);
  const approximate = !capture?.inventoryAvailable;
  const sessionCwdSource = !approximate ? "capture" : sessionCwd !== undefined ? "flag" : env.CODEX_COMPANION_SESSION_CWD ? "env" : "cwd";
  const scanCwd = sessionCwd ?? (approximate && env.CODEX_COMPANION_SESSION_CWD
    ? requireSessionCwd(env.CODEX_COMPANION_SESSION_CWD, "CODEX_COMPANION_SESSION_CWD") : cwd);
  const snapshot = approximate ? scanClaudeInstructions(scanCwd, env) : capture;
  const rendered = renderClaudeInstructions(snapshot);
  return { developerInstructions: rendered.developerInstructions,
    claudeMd: { version: 1, source: approximate ? "scan" : "capture", approximate, complete: snapshot.complete && rendered.omittedCount === 0,
      snapshotHash: capture?.hash ?? snapshot.hash, renderedHash: hash(rendered.developerInstructions), capturedAt: snapshot.capturedAt,
      sessionCwd: snapshot.cwd, sessionCwdSource, bounded: snapshot.bounded, omittedPaths: rendered.omittedPaths, omittedCount: rendered.omittedCount,
      ...(approximate ? { note: FALLBACK_NOTE } : {}) } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === "capture") {
  try {
    let raw = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) {
      raw += chunk;
      if (Buffer.byteLength(raw) > SNAPSHOT_BYTES) throw new Error("Claude instruction capture exceeds its storage budget.");
    }
    writeClaudeSnapshot(JSON.parse(raw));
  } catch { process.exitCode = 1; }
}
