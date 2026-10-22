import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import os from "node:os";
import { keyPath, statements, valueOf } from "./tool-config.mjs";
import { normalizeBrowserOrigin, normalizeBrowserOrigins, normalizeBundleId, normalizeBundleIds } from "./server-requests.mjs";
import { resolveIsolatedCodexHome } from "./codex-home.mjs";

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function scan(text) {
  let section = [], offset = 0;
  return statements(text).map(raw => {
    const start = offset; offset += raw.length + 1;
    const line = raw.trim(), header = /^\[([^\n]+)\]\s*(?:#.*)?$/.exec(line);
    if (header && !line.startsWith("[[")) { section = keyPath(header[1]); return { start, end: Math.min(offset, text.length), section, header: true }; }
    if (line.startsWith("[")) section = ["unsupported-array-table"];
    const m = /^((?:"(?:\\.|[^"\\])*"|'[^']*'|[^=])+)=([\s\S]*)$/.exec(line);
    return { start, end: Math.min(offset, text.length), section, keys: m ? [...section, ...keyPath(m[1].trim())] : null, value: m?.[2] };
  });
}
export function readTomlField(text, keys) {
  const entries = scan(text), found = entries.filter(e => same(e.keys, keys));
  if (found.length > 1) throw new Error("Duplicate selected TOML setting; no configuration changed.");
  if (entries.some(e => e.keys && e.keys.length < keys.length && e.keys.every((k, i) => keys[i] === k))) throw new Error("Selected setting uses a closed inline table; convert it to ordinary TOML tables first.");
  return found.length ? valueOf(found[0].value) : undefined;
}
export function setTomlField(text, keys, value) {
  if (same(readTomlField(text, keys), value)) return text;
  const entries = scan(text), found = entries.find(e => same(e.keys, keys));
  if (value === undefined) return found ? text.slice(0, found.start) + text.slice(found.end) : text;
  if (found) {
    // Preserve an inline comment without interpreting quoted '#' characters.
    let quote = null, escaped = false, comment = "";
    for (let i = 0; i < found.value.length; i++) {
      const c = found.value[i];
      if (escaped) { escaped = false; continue; }
      if (quote === '"' && c === "\\") { escaped = true; continue; }
      if (quote) { if (c === quote) quote = null; continue; }
      if (c === '"' || c === "'") quote = c;
      else if (c === "#") { comment = ` ${found.value.slice(i).split("\n")[0]}`; break; }
    }
    const relative = keys.slice(found.section.length).map(k => JSON.stringify(k)).join(".");
    return text.slice(0, found.start) + `${relative} = ${JSON.stringify(value)}${comment}\n` + text.slice(found.end);
  }
  const section = keys.slice(0, -1), line = `${JSON.stringify(keys.at(-1))} = ${JSON.stringify(value)}\n`;
  if (!section.length) return line + text;
  const header = entries.find(e => e.header && same(e.section, section));
  if (header) return text.slice(0, header.end) + (header.end && text[header.end - 1] !== "\n" ? "\n" : "") + line + text.slice(header.end);
  return `${text}${text.endsWith("\n") || !text ? "" : "\n"}\n[${section.map(k => JSON.stringify(k)).join(".")}]\n${line}`;
}
function safeFile(home, file) {
  if (fs.existsSync(home) && fs.lstatSync(home).isSymbolicLink()) throw new Error("Configuration editing refuses symlinked paths.");
  const relative = path.relative(home, file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Configuration path escaped isolated home.");
  let current = home;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error("Configuration editing refuses symlinked paths.");
  }
  if (fs.existsSync(file) && fs.statSync(file).isFile() && fs.statSync(file).nlink > 1) throw new Error("Configuration editing refuses hard-linked files.");
}
function read(home, file) { safeFile(home, file); try { return fs.readFileSync(file, "utf8"); } catch (e) { if (e.code === "ENOENT") return ""; throw e; } }
function apply(home, edits, dryRun, { backup = true } = {}) {
  const changed = edits.filter(e => e.before !== e.after), backups = [];
  if (dryRun) return { changedFiles: changed.map(e => e.file), backups, dryRun };
  for (const edit of changed) {
    safeFile(home, edit.file);
    fs.mkdirSync(path.dirname(edit.file), { recursive: true, mode: 0o700 });
    const lock = `${edit.file}.duet-lock`, temp = `${edit.file}.${randomUUID()}.tmp`;
    const fd = fs.openSync(lock, "wx", 0o600);
    try {
      if (read(home, edit.file) !== edit.before) throw new Error("Configuration changed concurrently; retry setup.");
      if (backup && fs.existsSync(edit.file)) {
        const backup = `${edit.file}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
        fs.writeFileSync(backup, edit.before, { flag: "wx", mode: 0o600 }); backups.push(backup);
      }
      fs.writeFileSync(temp, edit.after, { flag: "wx", mode: 0o600 });
      if (read(home, edit.file) !== edit.before) throw new Error("Configuration changed concurrently; retry setup.");
      fs.renameSync(temp, edit.file);
    } finally { fs.closeSync(fd); fs.rmSync(temp, { force: true }); fs.unlinkSync(lock); }
  }
  return { changedFiles: changed.map(e => e.file), backups, dryRun };
}
const matches = (a, b) => { try { return normalizeBrowserOrigin(a) === b; } catch { return false; } };
function origins(text, key) {
  const values = readTomlField(text, ["origins", key]) ?? [];
  if (!Array.isArray(values) || values.some(v => typeof v !== "string")) throw new Error("Browser origins must be string arrays; no configuration changed.");
  return values;
}
// Plugin-wide preferences live in <isolated home>/duet/config.toml: one location
// whether the caller runs inside a Claude session (CLAUDE_PLUGIN_DATA set) or
// from a plain terminal, so the default a user configures is the default every
// worker actually applies.
const duetConfig = env => { const root = path.join(resolveIsolatedCodexHome(env), "duet"); return { root, file: path.join(root, "config.toml") }; };

export const BROWSER_APPROVAL_MODES = ["never-ask", "ask"];
// Workers browse like the user's own Codex app: any website, no per-origin
// prompt, unless the user lowers this with setup --browser-approval ask.
export const BUILTIN_BROWSER_APPROVAL = "never-ask";
export function browserApprovalPreference(env = process.env) {
  const { root, file } = duetConfig(env);
  const value = readTomlField(read(root, file), ["browser_approval"]) ?? BUILTIN_BROWSER_APPROVAL;
  if (!BROWSER_APPROVAL_MODES.includes(value)) throw new Error("Invalid saved browser_approval; repair it with setup --browser-approval.");
  return value;
}
// The browser runtime reads only browser/config.toml, so the preference is
// mirrored there before each task. A missing key means "ask"; the built-in
// never-ask default fills it in. An explicit "ask" preference or a custom value
// written by hand is left alone.
export function ensureBrowserApproval({ env = process.env } = {}) {
  const preference = browserApprovalPreference(env), current = browserOriginSetup({ env });
  if (preference !== "never-ask" || current.approval !== "ask") return { browserApproval: preference, approval: current.approval, changedFiles: [], backups: [] };
  const result = browserOriginSetup({ env, approval: "never-ask", remember: false });
  return { browserApproval: preference, approval: result.approval, changedFiles: result.changedFiles, backups: result.backups };
}
/** @param {{ allow?: string[], revoke?: string[], approval?: string, env?: NodeJS.ProcessEnv, dryRun?: boolean, remember?: boolean }} [options] */
export function browserOriginSetup({ allow = [], revoke = [], approval, env = process.env, dryRun = false, remember = true } = {}) {
  if (approval !== undefined && !BROWSER_APPROVAL_MODES.includes(approval)) throw new Error("--browser-approval must be never-ask or ask.");
  allow = normalizeBrowserOrigins(allow); revoke = normalizeBrowserOrigins(revoke);
  if (allow.some(o => revoke.includes(o))) throw new Error("Do not allow and revoke the same browser origin together.");
  const home = resolveIsolatedCodexHome(env), file = path.join(home, "browser", "config.toml");
  const before = read(home, file); let after = before;
  const preference = duetConfig(env), preferenceBefore = read(home, preference.file);
  let preferenceAfter = preferenceBefore;
  if (approval !== undefined) {
    after = setTomlField(after, ["approval_mode"], approval === "never-ask" ? "never_ask" : undefined);
    // Remember an explicit choice so the next task does not reapply the built-in
    // default; applying that default itself leaves the preference file alone.
    if (remember) preferenceAfter = setTomlField(preferenceBefore, ["browser_approval"], approval);
  }
  let allowed = origins(before, "allowed"), denied = origins(before, "denied");
  for (const origin of allow) { if (!allowed.some(v => matches(v, origin))) allowed.push(origin); denied = denied.filter(v => !matches(v, origin)); }
  for (const origin of revoke) { allowed = allowed.filter(v => !matches(v, origin)); if (!denied.some(v => matches(v, origin))) denied.push(origin); }
  if (allow.length || revoke.length) {
    after = setTomlField(after, ["origins", "allowed"], allowed);
    after = setTomlField(after, ["origins", "denied"], denied);
  }
  const edits = [{ file, before, after }, { file: preference.file, before: preferenceBefore, after: preferenceAfter }], sessionDir = path.join(home, "browser", "sessions");
  if (allow.length && fs.existsSync(sessionDir)) {
    safeFile(home, sessionDir);
    for (const name of fs.readdirSync(sessionDir).sort()) {
      if (!/^[A-Za-z0-9_-]+\.toml$/.test(name)) continue;
      const file = path.join(sessionDir, name), before = read(home, file), old = origins(before, "denied");
      const next = old.filter(v => !allow.some(o => matches(v, o)));
      edits.push({ file, before, after: same(old, next) ? before : setTomlField(before, ["origins", "denied"], next) });
    }
  }
  const safeList = values => values.flatMap(v => { try { return [normalizeBrowserOrigin(v)]; } catch { return []; } });
  const approvalMode = readTomlField(after, ["approval_mode"]);
  const saved = readTomlField(preferenceAfter, ["browser_approval"]);
  return { file, approval: approvalMode === "never_ask" ? "never-ask" : approvalMode === undefined ? "ask" : "custom", preference: BROWSER_APPROVAL_MODES.includes(saved) ? saved : BUILTIN_BROWSER_APPROVAL, allowed: safeList(allowed), denied: safeList(denied), unsupportedEntries: allowed.length + denied.length - safeList(allowed).length - safeList(denied).length, ...apply(home, edits, dryRun) };
}

// Computer Use app approvals. node_repl (the MCP server hosting Codex's
// Computer Use JS) persists them under $CODEX_HOME/computer-use/: "always" in
// config.toml `[apps] allowed`, "this session" in sessions/<thread-id>.toml.
// An app listed there passes node_repl's elicitation through its persisted-state
// path, so no host prompt is needed. The isolated runtime reads the isolated
// home's copy; this module keeps it in step with the user's own Codex app.
export const COMPUTER_USE_APPROVAL_MODES = ["mirror", "ask"];
export const BUILTIN_COMPUTER_USE_APPROVAL = "mirror";
const CU_PREFERENCE = "computer_use_approval", CU_MIRRORED = "computer_use_mirrored_apps", CU_REVOKED = "computer_use_revoked_apps";
const computerUseFile = home => path.join(home, "computer-use", "config.toml");
export function computerUseSessionFile(home, threadId) {
  if (typeof threadId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(threadId)) throw new Error("A thread id is required for a per-call Computer Use approval.");
  return path.join(home, "computer-use", "sessions", `${threadId}.toml`);
}
// The user's own Codex home, read-only. Inside a worker CODEX_HOME already
// points at the isolated home, so that value is never taken as the source.
export function normalCodexHome(env = process.env) {
  const isolated = resolveIsolatedCodexHome(env);
  const candidates = [env.CODEX_COMPANION_NORMAL_HOME, env.CODEX_HOME, path.join(env.HOME || env.USERPROFILE || os.homedir(), ".codex")].filter(Boolean);
  return candidates.find(c => path.resolve(c) !== isolated) ?? path.join(env.HOME || os.homedir(), ".codex");
}
function appList(text, keys, label) {
  const values = readTomlField(text, keys);
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.some(v => typeof v !== "string")) throw new Error(`${label} must be a string array; no configuration changed.`);
  return values;
}
const validApps = values => values.flatMap(v => { try { return [normalizeBundleId(v)]; } catch { return []; } });
// Only `[apps] allowed` of the user's global file counts as "always allowed".
// Session files, the denied list and anything unreadable are ignored; the
// user's home is never written.
export function readCodexAppComputerUseApprovals(env = process.env) {
  const file = computerUseFile(normalCodexHome(env));
  try {
    if (!fs.existsSync(file)) return { file, allowed: [], readable: false };
    return { file, allowed: validApps(appList(fs.readFileSync(file, "utf8"), ["apps", "allowed"], "Codex app Computer Use approvals")), readable: true };
  } catch { return { file, allowed: [], readable: false }; }
}
export function computerUseApprovalPreference(env = process.env) {
  const { root, file } = duetConfig(env);
  const value = readTomlField(read(root, file), [CU_PREFERENCE]) ?? BUILTIN_COMPUTER_USE_APPROVAL;
  if (!COMPUTER_USE_APPROVAL_MODES.includes(value)) throw new Error("Invalid saved computer_use_approval; repair it with setup --computer-use-approval.");
  return value;
}
// One idempotent pass: the isolated `[apps] allowed` list becomes
// (current − previously mirrored − revoked) ∪ (mirror ? user's always-allowed − revoked : ∅) ∪ allow.
// Explicit and hand-written entries persist; mirrored ones follow the source;
// everything else in the file (denied list, other tables) is left alone.
/** @param {{ allow?: string[], revoke?: string[], approval?: string, env?: NodeJS.ProcessEnv, dryRun?: boolean }} [options] */
export function computerUseSetup({ allow = [], revoke = [], approval, env = process.env, dryRun = false } = {}) {
  if (approval !== undefined && !COMPUTER_USE_APPROVAL_MODES.includes(approval)) throw new Error("--computer-use-approval must be mirror or ask.");
  allow = normalizeBundleIds(allow); revoke = normalizeBundleIds(revoke);
  if (allow.some(a => revoke.includes(a))) throw new Error("Do not allow and revoke the same Computer Use app together.");
  const home = resolveIsolatedCodexHome(env), file = computerUseFile(home), before = read(home, file);
  const preference = duetConfig(env), preferenceBefore = read(home, preference.file);
  let preferenceAfter = approval === undefined ? preferenceBefore : setTomlField(preferenceBefore, [CU_PREFERENCE], approval);
  const mode = readTomlField(preferenceAfter, [CU_PREFERENCE]) ?? BUILTIN_COMPUTER_USE_APPROVAL;
  if (!COMPUTER_USE_APPROVAL_MODES.includes(mode)) throw new Error("Invalid saved computer_use_approval; repair it with setup --computer-use-approval.");
  const previouslyMirrored = validApps(appList(preferenceBefore, [CU_MIRRORED], "computer_use_mirrored_apps"));
  let revoked = validApps(appList(preferenceBefore, [CU_REVOKED], "computer_use_revoked_apps"));
  revoked = [...new Set([...revoked.filter(a => !allow.includes(a)), ...revoke])];
  const source = readCodexAppComputerUseApprovals(env);
  const mirrored = mode === "mirror" ? source.allowed.filter(a => !revoked.includes(a)) : [];
  const current = appList(before, ["apps", "allowed"], "Isolated Computer Use approvals");
  const kept = current.filter(a => !previouslyMirrored.includes(a) && !revoked.includes(a) && !revoke.includes(a));
  const allowed = [...new Set([...kept, ...mirrored, ...allow])];
  const after = same(allowed, current) ? before : setTomlField(before, ["apps", "allowed"], allowed);
  // An app the user allowed explicitly (or wrote by hand) stays explicit even
  // while the Codex app also lists it, so it survives a later switch to ask.
  const mirroredRecord = mirrored.filter(a => !kept.includes(a) && !allow.includes(a));
  if (!same(mirroredRecord, previouslyMirrored)) preferenceAfter = setTomlField(preferenceAfter, [CU_MIRRORED], mirroredRecord.length ? mirroredRecord : undefined);
  if (!same(revoked, validApps(appList(preferenceBefore, [CU_REVOKED], "computer_use_revoked_apps")))) preferenceAfter = setTomlField(preferenceAfter, [CU_REVOKED], revoked.length ? revoked : undefined);
  const result = apply(home, [{ file, before, after }, { file: preference.file, before: preferenceBefore, after: preferenceAfter }], dryRun);
  return {
    file, preference: mode,
    allowed: validApps(allowed).map(app => ({ app, source: mirroredRecord.includes(app) ? "mirrored" : "explicit" })),
    revoked, codexApp: source, unsupportedEntries: allowed.length - validApps(allowed).length,
    ...result
  };
}
// Before every task; never raises into the task flow.
export function ensureComputerUseApproval({ env = process.env } = {}) {
  const result = computerUseSetup({ env });
  return { computerUseApproval: result.preference, allowed: result.allowed.map(a => a.app), changedFiles: result.changedFiles, backups: result.backups };
}
// A per-call approval: the listed apps are allowed for exactly this thread while
// the turn runs, via node_repl's session-scoped persisted state. The caller
// restores the file when the turn ends.
export function grantComputerAppsForThread(threadId, apps, env = process.env) {
  const home = resolveIsolatedCodexHome(env), file = computerUseSessionFile(home, threadId);
  const before = read(home, file), current = appList(before, ["apps", "allowed"], "Session Computer Use approvals");
  const allowed = [...new Set([...current, ...normalizeBundleIds(apps)])];
  if (same(allowed, current)) return () => {};
  apply(home, [{ file, before, after: setTomlField(before, ["apps", "allowed"], allowed) }], false, { backup: false });
  return () => {
    try {
      if (!before) { safeFile(home, file); fs.rmSync(file, { force: true }); return; }
      apply(home, [{ file, before: read(home, file), after: before }], false, { backup: false });
    } catch { /* a stale per-thread grant is reported by the next task's cleanup */ }
  };
}

// Project instructions. Codex discovers AGENTS.md on its own (repository root
// down to the working directory). Claude Code projects usually keep theirs in
// CLAUDE.md, which Codex ignores unless its `project_doc_fallback_filenames`
// lists it; with that key a worker reads CLAUDE.md wherever AGENTS.md is
// missing, under Codex's own size limit (`project_doc_max_bytes`). The key lives
// in the isolated home's config.toml; the user-level ~/.claude/CLAUDE.md and
// ~/.codex are never involved.
export const PROJECT_DOC_MODES = ["claude-md", "agents-only"];
export const BUILTIN_PROJECT_DOCS = "claude-md";
export const CLAUDE_MD_FALLBACKS = ["CLAUDE.md"];
/** @param {{ mode?: string, env?: NodeJS.ProcessEnv, dryRun?: boolean }} [options] */
export function projectDocsSetup({ mode, env = process.env, dryRun = false } = {}) {
  if (mode !== undefined && !PROJECT_DOC_MODES.includes(mode)) throw new Error("--project-docs must be claude-md or agents-only.");
  const home = resolveIsolatedCodexHome(env), file = path.join(home, "config.toml"), before = read(home, file);
  const preference = duetConfig(env), preferenceBefore = read(preference.root, preference.file);
  const preferenceAfter = mode === undefined ? preferenceBefore : setTomlField(preferenceBefore, ["project_docs"], mode);
  const projectDocs = readTomlField(preferenceAfter, ["project_docs"]) ?? BUILTIN_PROJECT_DOCS;
  if (!PROJECT_DOC_MODES.includes(projectDocs)) throw new Error("Invalid saved project_docs; repair it with setup --project-docs.");
  const current = readTomlField(before, ["project_doc_fallback_filenames"]);
  if (current !== undefined && (!Array.isArray(current) || current.some(v => typeof v !== "string"))) throw new Error("project_doc_fallback_filenames must be a string array; no configuration changed.");
  // A hand-written list that already covers CLAUDE.md (or lists other names) is
  // the user's; only Duet's own default list is added or removed.
  const custom = current !== undefined && !same(current, CLAUDE_MD_FALLBACKS);
  const wanted = projectDocs === "claude-md" ? (custom ? current : CLAUDE_MD_FALLBACKS) : (custom ? current : undefined);
  const after = same(current, wanted) ? before : setTomlField(before, ["project_doc_fallback_filenames"], wanted);
  const result = apply(home, [{ file, before, after }, { file: preference.file, before: preferenceBefore, after: preferenceAfter }], dryRun);
  return { file, projectDocs, fallbackFilenames: wanted ?? [], custom, ...result };
}
// Before every task; never raises into the task flow.
export function ensureProjectDocs({ env = process.env } = {}) {
  const result = projectDocsSetup({ env });
  return { projectDocs: result.projectDocs, fallbackFilenames: result.fallbackFilenames, changedFiles: result.changedFiles };
}

export const SANDBOX_MODES = ["read-only", "workspace-write", "danger-full-access"];
// Workers run like the user's own Codex app in full-access mode unless the user
// lowers the default here or the parent narrows one call with --sandbox.
export const BUILTIN_DEFAULT_SANDBOX = "danger-full-access";
/** @param {{ mode?: string, env?: NodeJS.ProcessEnv, dryRun?: boolean }} [options] */
export function defaultSandboxSetup({ mode, env = process.env, dryRun = false } = {}) {
  if (mode !== undefined && !SANDBOX_MODES.includes(mode)) throw new Error("--default-sandbox must be read-only, workspace-write, or danger-full-access.");
  const { root, file } = duetConfig(env), before = read(root, file);
  const after = mode === undefined ? before : setTomlField(before, ["default_sandbox"], mode);
  const defaultSandbox = readTomlField(after, ["default_sandbox"]) ?? BUILTIN_DEFAULT_SANDBOX;
  if (!SANDBOX_MODES.includes(defaultSandbox)) throw new Error("Invalid saved default_sandbox; repair it with setup --default-sandbox.");
  return { file, defaultSandbox, ...apply(root, [{ file, before, after }], dryRun) };
}
export function transportSetup({ mode = "status", env = process.env, dryRun = false } = {}) {
  if (!["http", "websocket", "status"].includes(mode)) throw new Error("--transport must be http, websocket or status.");
  const home = resolveIsolatedCodexHome(env), file = path.join(home, "config.toml"), before = read(home, file);
  let after = before, provider = readTomlField(before, ["model_provider"]) ?? "openai";
  if (mode !== "status") {
    if (!["openai", "openai-http", "openai-websocket"].includes(provider)) throw new Error("Transport setup supports the ChatGPT/OpenAI provider only; preserve your custom endpoint/auth and change its supports_websockets setting manually.");
    provider = mode === "http" ? "openai-http" : "openai-websocket";
    const prefix = ["model_providers", provider];
    const defaults = { name: mode === "http" ? "OpenAI HTTP" : "OpenAI WebSocket", base_url: "https://chatgpt.com/backend-api/codex", wire_api: "responses", requires_openai_auth: true };
    for (const [key, value] of Object.entries(defaults)) {
      const existing = readTomlField(after, [...prefix, key]);
      if (existing !== undefined && key !== "name" && existing !== value) throw new Error("Existing named provider has a different endpoint/auth configuration; refusing to replace it.");
      if (existing === undefined) after = setTomlField(after, [...prefix, key], value);
    }
    after = setTomlField(after, [...prefix, "supports_websockets"], mode === "websocket");
    after = setTomlField(after, ["model_provider"], provider);
  }
  const enabled = readTomlField(after, ["model_providers", provider, "supports_websockets"]);
  return { file, provider: /^[a-z0-9_-]{1,64}$/i.test(provider) ? provider : "custom", transport: enabled === false ? "http" : enabled === true ? "websocket" : "default", restartRequired: before !== after, ...apply(home, [{ file, before, after }], dryRun) };
}
