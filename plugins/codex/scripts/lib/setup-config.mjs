import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { keyPath, statements, valueOf } from "./tool-config.mjs";
import { normalizeBrowserOrigin, normalizeBrowserOrigins } from "./server-requests.mjs";
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
function apply(home, edits, dryRun) {
  const changed = edits.filter(e => e.before !== e.after), backups = [];
  if (dryRun) return { changedFiles: changed.map(e => e.file), backups, dryRun };
  for (const edit of changed) {
    safeFile(home, edit.file);
    fs.mkdirSync(path.dirname(edit.file), { recursive: true, mode: 0o700 });
    const lock = `${edit.file}.duet-lock`, temp = `${edit.file}.${randomUUID()}.tmp`;
    const fd = fs.openSync(lock, "wx", 0o600);
    try {
      if (read(home, edit.file) !== edit.before) throw new Error("Configuration changed concurrently; retry setup.");
      if (fs.existsSync(edit.file)) {
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
export function browserOriginSetup({ allow = [], revoke = [], approval, env = process.env, dryRun = false } = {}) {
  if (approval !== undefined && !["never-ask", "ask"].includes(approval)) throw new Error("--browser-approval must be never-ask or ask.");
  allow = normalizeBrowserOrigins(allow); revoke = normalizeBrowserOrigins(revoke);
  if (allow.some(o => revoke.includes(o))) throw new Error("Do not allow and revoke the same browser origin together.");
  const home = resolveIsolatedCodexHome(env), file = path.join(home, "browser", "config.toml");
  const before = read(home, file); let after = before;
  if (approval !== undefined) after = setTomlField(after, ["approval_mode"], approval === "never-ask" ? "never_ask" : undefined);
  let allowed = origins(before, "allowed"), denied = origins(before, "denied");
  for (const origin of allow) { if (!allowed.some(v => matches(v, origin))) allowed.push(origin); denied = denied.filter(v => !matches(v, origin)); }
  for (const origin of revoke) { allowed = allowed.filter(v => !matches(v, origin)); if (!denied.some(v => matches(v, origin))) denied.push(origin); }
  if (allow.length || revoke.length) {
    after = setTomlField(after, ["origins", "allowed"], allowed);
    after = setTomlField(after, ["origins", "denied"], denied);
  }
  const edits = [{ file, before, after }], sessionDir = path.join(home, "browser", "sessions");
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
  return { file, approval: approvalMode === "never_ask" ? "never-ask" : approvalMode === undefined ? "ask" : "custom", allowed: safeList(allowed), denied: safeList(denied), unsupportedEntries: allowed.length + denied.length - safeList(allowed).length - safeList(denied).length, ...apply(home, edits, dryRun) };
}

export const SANDBOX_MODES = ["read-only", "workspace-write", "danger-full-access"];
export function defaultSandboxSetup({ mode, env = process.env, dryRun = false } = {}) {
  if (mode !== undefined && !SANDBOX_MODES.includes(mode)) throw new Error("--default-sandbox must be read-only, workspace-write, or danger-full-access.");
  // Resolve even with plugin data set: retain isolation and the test-home guard.
  const isolated = resolveIsolatedCodexHome(env);
  const root = env.CLAUDE_PLUGIN_DATA || path.join(isolated, "duet");
  if (!path.isAbsolute(root)) throw new Error("CLAUDE_PLUGIN_DATA must be an absolute path for plugin configuration.");
  const file = path.join(root, "config.toml"), before = read(root, file);
  const after = mode === undefined ? before : setTomlField(before, ["default_sandbox"], mode);
  const defaultSandbox = readTomlField(after, ["default_sandbox"]) ?? "read-only";
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
