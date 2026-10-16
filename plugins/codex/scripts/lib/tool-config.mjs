import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { resolveIsolatedCodexHome } from "./codex-home.mjs";
import { buildCuaConfig } from "./cua-config.mjs";

export const TOOL_PLUGINS = ["browser", "chrome", "computer-use", "unified-computer-use"];
export const NODE_REPL_ENV_KEYS = [
  "NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS", "NODE_REPL_NODE_MODULE_DIRS", "NODE_REPL_NODE_PATH",
  "NODE_REPL_TRUSTED_CODE_PATHS", "CODEX_HOME", "BROWSER_USE_AVAILABLE_BACKENDS", "BROWSER_USE_TINYSKY_ENABLED",
  "NODE_REPL_INSTRUCTIONS_USE_CASE_BROWSER", "NODE_REPL_INSTRUCTIONS_USE_CASE_CHROME",
  "NODE_REPL_INSTRUCTIONS_USE_CASE_COMPUTER_USE", "BROWSER_USE_CODEX_APP_BUILD_FLAVOR",
  "BROWSER_USE_CODEX_APP_VERSION", "NODE_REPL_TRUSTED_SERVICES", "SKY_CUA_SERVICE_PATH", "CODEX_CLI_PATH"
];
const selected = keys => keys[0] === "marketplaces" ||
  (keys[0] === "plugins" && TOOL_PLUGINS.some(name => keys[1] === `${name}@openai-bundled`)) ||
  (keys[0] === "mcp_servers" && ["node_repl", "cua_repl"].includes(keys[1]));

// A conservative TOML reader for tool settings. Unrelated statements are kept
// byte-for-byte. Unsupported selected values fail closed, never copied as text.
function tokens(text) {
  const out = [];
  for (let i = 0; i < text.length;) {
    if (/\s/.test(text[i])) { i++; continue; }
    if (text[i] === "#") { while (i < text.length && text[i] !== "\n") i++; continue; }
    const quote = text[i];
    if (quote === '"' || quote === "'") {
      const start = i++;
      while (i < text.length && text[i] !== quote) {
        if (quote === '"' && text[i] === "\\") i++;
        i++;
      }
      if (i === text.length) throw new Error("Unterminated tool config string.");
      const raw = text.slice(start, ++i);
      try { out.push({ value: quote === '"' ? JSON.parse(raw) : raw.slice(1, -1), string: true }); }
      catch { throw new Error("Unsupported TOML basic string; no values are included in diagnostics."); }
    } else if ("[].={},".includes(text[i])) out.push({ value: text[i++] });
    else {
      const start = i;
      while (i < text.length && !/[\s\[\].={},#]/.test(text[i])) i++;
      out.push({ value: text.slice(start, i) });
    }
  }
  return out;
}

export function keyPath(text) {
  const parts = tokens(text);
  if (!parts.length || parts.some((t, i) => i % 2 ? t.value !== "." || t.string : !t.string && !/^[\w-]+$/.test(t.value)) || parts.length % 2 === 0) throw new Error("Unsupported TOML tool key.");
  return parts.filter((_, i) => i % 2 === 0).map(t => t.value);
}

export function valueOf(text) {
  const parts = tokens(text);
  let i = 0;
  function value() {
    const t = parts[i++];
    if (!t) throw new Error("Missing TOML tool value.");
    if (t.string) return t.value;
    if (t.value === "true" || t.value === "false") return t.value === "true";
    if (/^\d+$/.test(t.value)) return Number(t.value);
    if (t.value === "[") {
      const result = [];
      while (parts[i]?.value !== "]") {
        result.push(value());
        if (parts[i]?.value !== ",") break;
        i++;
      }
      if (parts[i++]?.value !== "]") throw new Error("Unsupported TOML tool array.");
      return result;
    }
    if (t.value === "{") {
      const result = Object.create(null);
      while (parts[i]?.value !== "}") {
        const key = parts[i++];
        if (!key || (!key.string && !/^[\w-]+$/.test(key.value)) || parts[i++]?.value !== "=" || Object.hasOwn(result, key.value)) throw new Error("Unsupported TOML tool inline table.");
        result[key.value] = value();
        if (parts[i]?.value !== ",") break;
        i++;
      }
      if (parts[i++]?.value !== "}") throw new Error("Unsupported TOML tool inline table.");
      return result;
    }
    throw new Error("Unsupported TOML tool value; use strings, booleans, integers, arrays or inline tables.");
  }
  const result = value();
  if (i !== parts.length) throw new Error("Unsupported TOML tool value suffix.");
  return result;
}

// Split only at top-level newlines (including unrelated multiline strings).
export function statements(text) {
  const result = [];
  let start = 0, quote = null, triple = false, depth = 0, comment = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (comment && c !== "\n") continue;
    if (comment) comment = false;
    if (quote) {
      if (c === "\\" && quote === '"') { i++; continue; }
      if (c === quote && (!triple || text.slice(i, i + 3) === quote.repeat(3))) {
        if (triple) i += 2;
        quote = null;
      }
      continue;
    }
    if (c === "#") comment = true;
    else if (c === '"' || c === "'") {
      quote = c; triple = text.slice(i, i + 3) === c.repeat(3);
      if (triple) i += 2;
    } else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth--;
    if (c === "\n" && depth === 0) { result.push(text.slice(start, i)); start = i + 1; }
  }
  if (quote || depth) throw new Error("Unbalanced TOML config; no tool settings changed.");
  result.push(text.slice(start));
  return result;
}

function assign(root, keys, value) {
  let target = root;
  for (const key of keys.slice(0, -1)) {
    if (Object.hasOwn(target, key) && (!target[key] || typeof target[key] !== "object" || Array.isArray(target[key]))) throw new Error("Conflicting TOML tool keys.");
    target = target[key] ??= Object.create(null);
  }
  const last = keys.at(-1);
  if (Object.hasOwn(target, last)) throw new Error("Duplicate TOML tool key.");
  target[last] = value;
}

export function readToolConfig(text, { inlineTables = [] } = {}) {
  const result = Object.create(null);
  let section = [];
  for (const statement of statements(text)) {
    const line = statement.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      const header = /^\[([^\n]+)\]\s*(?:#.*)?$/.exec(line);
      if (!header || line.startsWith("[[")) {
        if (/marketplaces|plugins|node_repl|cua_repl/.test(line)) throw new Error("Unsupported tool table header.");
        section = ["ignored-array-table"];
      } else {
        section = keyPath(header[1]);
        if (selected(section)) {
          let target = result;
          for (const key of section) target = target[key] ??= Object.create(null);
        }
      }
      continue;
    }
    // Locate '=' outside a quoted key.
    const match = /^((?:"(?:\\.|[^"\\])*"|'[^']*'|[^=])+)=([\s\S]*)$/.exec(line);
    if (!match) { if (selected(section)) throw new Error("Unsupported tool assignment."); continue; }
    const keys = [...section, ...keyPath(match[1].trim())];
    if (selected(keys) || (keys.length === 1 && ["plugins", "mcp_servers"].includes(keys[0]))) {
      const value = valueOf(match[2]);
      if (value && typeof value === "object" && !Array.isArray(value)) inlineTables.push(keys);
      assign(result, keys, value);
    }
  }
  return result;
}

function configPaths(env) {
  const isolated = resolveIsolatedCodexHome(env);
  const normal = path.resolve(env.CODEX_COMPANION_NORMAL_HOME || env.CODEX_HOME || path.join(env.HOME || env.USERPROFILE || os.homedir(), ".codex"));
  return { isolated, normal, source: path.join(normal, "config.toml"), destination: path.join(isolated, "config.toml") };
}

function readOptional(file) {
  try { return fs.readFileSync(file, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return ""; throw error; }
}

function toml(value) {
  if (Array.isArray(value)) return `[${value.map(toml).join(", ")}]`;
  if (value && typeof value === "object") return `{ ${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)} = ${toml(v)}`).join(", ")} }`;
  return JSON.stringify(value);
}

export function syncToolConfig({ env = process.env, dryRun = false, cuaTemplate, chatgptResources } = {}) {
  const paths = configPaths(env);
  // Refuse aliases of config files as well as overlapping home directories.
  for (const file of [paths.source, paths.destination]) {
    if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error("Tool sync refuses symlinked config.toml files.");
  }
  if (fs.existsSync(paths.source) && fs.existsSync(paths.destination)) {
    const a = fs.statSync(paths.source), b = fs.statSync(paths.destination);
    if (a.dev === b.dev && a.ino === b.ino) throw new Error("Tool sync refuses overlapping config files.");
  }
  const sourceText = readOptional(paths.source);
  const before = readOptional(paths.destination);
  const inlineTables = [];
  const source = readToolConfig(sourceText), destination = readToolConfig(before, { inlineTables });
  const added = [], present = [], skipped = [], sections = [];
  // Only path-shaped data is portable. No arbitrary env, shell code, headers,
  // credentials, token arguments, remote marketplace URLs or provider config.
  const safePath = value => typeof value === "string" && (path.isAbsolute(value) || value.startsWith("~/")) && !/[\n\r\0;$`]/.test(value);
  function add(keys, values) {
    const label = keys.join(".");
    let existing = destination;
    for (const key of keys) existing = existing?.[key];
    if (existing !== undefined) { present.push(label); return; }
    if (!Object.keys(values).length) return;
    if (inlineTables.some(parent => parent.length < keys.length && parent.every((key, i) => keys[i] === key))) {
      throw new Error("Cannot extend an inline tool table; convert it to ordinary TOML tables before syncing. No configuration was written.");
    }
    added.push(label);
    sections.push(`[${keys.map(k => JSON.stringify(k)).join(".")}]\n${Object.entries(values).map(([k, v]) => `${JSON.stringify(k)} = ${toml(v)}`).join("\n")}\n`);
  }
  for (const [name, config] of Object.entries(source.marketplaces ?? {})) {
    const safe = {};
    if (safePath(config?.source)) safe.source = config.source;
    else if (config?.source && typeof config.source === "object") {
      const kind = config.source.source ?? config.source.type;
      if (kind === "local" && safePath(config.source.path)) safe.source = { [config.source.source ? "source" : "type"]: "local", path: config.source.path };
    } else if (config?.source === "local" && safePath(config.path)) { safe.source = "local"; safe.path = config.path; }
    if (Object.keys(safe).length && config.source_type === "local") safe.source_type = "local";
    if (!Object.keys(safe).length) skipped.push(`marketplaces.${name}: only local sources are portable`);
    else add(["marketplaces", name], safe);
  }
  for (const name of TOOL_PLUGINS) {
    const id = `${name}@openai-bundled`;
    if (typeof source.plugins?.[id]?.enabled === "boolean") add(["plugins", id], { enabled: source.plugins[id].enabled });
  }
  const repl = source.mcp_servers?.node_repl;
  if (repl) {
    const safe = {};
    // Executables/scripts continue to refer to their installed location. Only
    // writable data/trust paths are remapped, not tool assets that weren't copied.
    if (safePath(repl.command) || ["node", "node_repl"].includes(repl.command)) safe.command = repl.command;
    if (Array.isArray(repl.args) && repl.args.every(v => safePath(v) || /^--(?:experimental-[\w-]+|no-warnings)$/.test(v))) safe.args = repl.args;
    else if (repl.args !== undefined) skipped.push("mcp_servers.node_repl.args: unsupported arguments");
    for (const key of ["enabled", "startup_timeout_sec", "tool_timeout_sec"]) if (typeof repl[key] === "boolean" || typeof repl[key] === "number") safe[key] = repl[key];
    safe.env = { CODEX_HOME: paths.isolated };
    for (const [key, value] of Object.entries(repl.env ?? {})) {
      if (!NODE_REPL_ENV_KEYS.includes(key) || typeof value !== "string") {
        skipped.push(`mcp_servers.node_repl.env.${key}: not an allowed string setting`);
        continue;
      }
      if (key === "CODEX_HOME") continue;
      if (key === "NODE_REPL_TRUSTED_CODE_PATHS") {
        // Trust code in the existing plugin cache and app modules without
        // redirecting asset paths to nonexistent copies in the isolated home.
        const sources = value.split(":").filter(v => v && v !== paths.normal && v !== "~/.codex");
        safe.env[key] = [...new Set([paths.isolated, ...sources])].join(":");
      } else safe.env[key] = value;
    }
    safe.env.NODE_REPL_TRUSTED_CODE_PATHS ??= paths.isolated;
    if (!safe.command || (repl.args !== undefined && !safe.args)) skipped.push("mcp_servers.node_repl: incomplete safe launch configuration; not copied");
    else add(["mcp_servers", "node_repl"], safe);
  }
  let cuaSource = null;
  // Presence is checked before discovery: an existing hand-written (even
  // disabled/partial) server and its env remain byte-exact, without an app lookup.
  if (destination.mcp_servers?.cua_repl !== undefined) present.push("mcp_servers.cua_repl");
  else {
    const cua = buildCuaConfig({ ...paths, env, source, cuaTemplate, chatgptResources });
    add(["mcp_servers", "cua_repl"], cua.settings);
    add(["mcp_servers", "cua_repl", "env"], cua.env);
    cuaSource = { template: cua.template, resources: cua.resources };
  }
  // Exact append-only preview; never echo existing destination text, which may
  // contain credentials. Dry runs do not create a home, lock, backup or runtime.
  const append = sections.length ? `${before.endsWith("\n") ? "" : "\n"}\n${sections.join("\n")}` : "";
  const report = { dryRun, source: paths.source, destination: paths.destination, sourceFound: Boolean(sourceText), cuaSource, added, present, skipped, append, backup: null, changed: added.length > 0 };
  if (dryRun || !report.changed) return report;
  fs.mkdirSync(paths.isolated, { recursive: true, mode: 0o700 });
  // Serialize writers and refuse a config modified since the read.
  const lock = `${paths.destination}.sync-lock`;
  const fd = fs.openSync(lock, "wx", 0o600);
  const temporary = `${paths.destination}.${randomUUID()}.tmp`;
  try {
    if (readOptional(paths.destination) !== before) throw new Error("Config changed during tool sync; retry.");
    if (fs.existsSync(paths.destination)) {
      report.backup = `${paths.destination}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
      fs.writeFileSync(report.backup, before, { flag: "wx", mode: 0o600 });
    }
    fs.writeFileSync(temporary, `${before}${append}`, { flag: "wx", mode: 0o600 });
    if (readOptional(paths.destination) !== before) throw new Error("Config changed during tool sync; retry.");
    fs.renameSync(temporary, paths.destination);
  } finally {
    fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
    fs.unlinkSync(lock);
  }
  return report;
}

export function getToolAvailability(env = process.env) {
  const home = resolveIsolatedCodexHome(env);
  try {
    const config = readToolConfig(readOptional(path.join(home, "config.toml")));
    const enabled = name => config.plugins?.[`${name}@openai-bundled`]?.enabled === true;
    const repl = config.mcp_servers?.node_repl;
    const nodeRepl = Boolean(repl?.command) && repl.enabled !== false;
    const cua = config.mcp_servers?.cua_repl;
    const cuaRepl = Boolean(cua?.command) && cua.enabled !== false;
    const cuaBrowser = cuaRepl && cua.env?.CUA_REPL_ENABLED_SURFACES?.split(",").includes("browser");
    const cuaComputer = cuaRepl && cua.env?.CUA_REPL_ENABLED_SURFACES?.split(",").includes("computer");
    const marketplace = Boolean(config.marketplaces?.["openai-bundled"]);
    return {
      browser: cuaBrowser || marketplace && nodeRepl && (enabled("browser") || enabled("chrome")) ? "available" : "missing",
      computerUse: cuaComputer || marketplace && nodeRepl && (enabled("computer-use") || enabled("unified-computer-use")) ? "available" : "missing",
      nodeRepl: nodeRepl ? "available" : "missing",
      cuaRepl: cuaRepl ? "available" : "missing",
      basis: "configuration-only; assets, extension connection and live tools are not probed"
    };
  } catch {
    return { browser: "unknown", computerUse: "unknown", nodeRepl: "unknown", cuaRepl: "unknown", basis: "config could not be read safely" };
  }
}
