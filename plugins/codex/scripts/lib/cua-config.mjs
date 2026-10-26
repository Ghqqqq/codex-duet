import fs from "node:fs";
import path from "node:path";

// The Chrome-only profile rebuilds this allowlist; no instruction overrides,
// IPC, identities, credentials, env forwarding or arbitrary arguments cross it.
export const CUA_SETTING_KEYS = ["command", "args", "enabled", "enabled_tools", "omit_tools_from", "startup_timeout_sec", "tool_timeout_sec"];
export const CUA_ENV_KEYS = [
  "CODEX_HOME", "CUA_REPL_NODE_REPL_PATH", "CUA_REPL_ENABLED_SURFACES",
  "NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS", "NODE_REPL_NODE_MODULE_DIRS", "NODE_REPL_NODE_PATH",
  "NODE_REPL_TRUSTED_CODE_PATHS", "NODE_REPL_TRUSTED_SERVICES", "BROWSER_USE_AVAILABLE_BACKENDS",
  "BROWSER_USE_TINYSKY_ENABLED", "BROWSER_USE_CODEX_APP_BUILD_FLAVOR", "BROWSER_USE_CODEX_APP_VERSION", "CODEX_CLI_PATH"
];
const toolNames = ["js", "js_reset", "turn_ended"];
const visibility = ["code_mode", "deferred"];
const templateSuffix = "plugins/openai-bundled/plugins/unified-computer-use/.mcp.json";
const nodeSuffix = "cua_node/bin/node";

// The opt-in app profile mirrors the resolved cache entry, including its tool
// instructions. Reject schema additions instead of accidentally importing auth.
const APP_SETTING_KEYS = [...CUA_SETTING_KEYS, "tools", "env_vars", "env"];
const APP_ENV_KEYS = [...CUA_ENV_KEYS, "SKY_CUA_SERVICE_PATH",
  "NODE_REPL_INSTRUCTIONS_USE_CASE_BROWSER", "NODE_REPL_INSTRUCTIONS_USE_CASE_CHROME",
  "NODE_REPL_INSTRUCTIONS_USE_CASE_COMPUTER_USE"];

export function buildCodexAppCuaConfig({ normal, isolated, cuaTemplate, chatgptResources }) {
  if (chatgptResources) throw new Error("--chatgpt-resources is only supported by the chrome profile; codex-app preserves template paths.");
  let templateFile = cuaTemplate && absolute(cuaTemplate, "CUA template");
  if (!templateFile) {
    const cache = path.join(normal, "plugins/cache/openai-bundled/unified-computer-use");
    const versions = exists(cache) ? fs.readdirSync(cache).sort((a, b) => b.localeCompare(a, "en", { numeric: true })) : [];
    templateFile = versions.map(v => path.join(cache, v, ".mcp.json")).find(exists);
  }
  if (!templateFile) throw new Error("Codex App CUA cache template not found; provide --cua-template /absolute/.mcp.json. No configuration was written.");
  const template = readTemplate(templateFile);
  const reject = () => { throw new Error("Unsupported Codex App CUA template schema; credentials, env forwarding and unknown fields are never imported. No configuration was written."); };
  if (Object.keys(template).some(k => !APP_SETTING_KEYS.includes(k))) reject();
  absolute(template.command, "node executable");
  if (!template.command.endsWith(`/${nodeSuffix}`) || !Array.isArray(template.args) || template.args.length !== 1) reject();
  absolute(template.args[0], "CUA launcher");
  if (!template.args[0].endsWith("/@oai/cua-repl/bin/cua-repl.mjs")) reject();
  for (const [label, file] of [["node executable", template.command], ["launcher", template.args[0]]]) {
    try {
      if (!fs.statSync(file).isFile()) throw new Error("Not a file");
      fs.accessSync(file, label === "node executable" ? fs.constants.X_OK : fs.constants.R_OK);
    } catch {
      throw new Error(`Codex App CUA ${label} is missing or ${label === "node executable" ? "not executable" : "unreadable"}; repair the app or select a current template. No configuration was written.`);
    }
  }
  if (template.enabled !== undefined && typeof template.enabled !== "boolean") reject();
  exactList(template.enabled_tools, toolNames, "enabled_tools");
  exactList(template.omit_tools_from, visibility, "omit_tools_from");
  for (const key of ["startup_timeout_sec", "tool_timeout_sec"]) numberSetting(template[key], undefined, key, 600);
  if (template.env_vars !== undefined && (!Array.isArray(template.env_vars) || template.env_vars.length)) reject();
  if (template.tools !== undefined) {
    if (!template.tools || Object.keys(template.tools).some(k => k !== "js") || !template.tools.js ||
        Object.keys(template.tools.js).some(k => k !== "output_token_limit") ||
        !Number.isInteger(template.tools.js.output_token_limit) || template.tools.js.output_token_limit < 1) reject();
  }
  if (!template.env || Array.isArray(template.env) || typeof template.env !== "object" ||
      Object.entries(template.env).some(([k, v]) => !APP_ENV_KEYS.includes(k) || typeof v !== "string")) reject();
  const originalHome = absolute(template.env.CODEX_HOME, "template CODEX_HOME");
  const trust = template.env.NODE_REPL_TRUSTED_CODE_PATHS;
  if (typeof trust !== "string" || !trust) reject();
  const trustedPaths = trust.split(path.delimiter).map(p => {
    if (p === "~/.codex" || p === originalHome || p === normal) return isolated;
    absolute(p, "trusted code");
    return p;
  });
  if (!trustedPaths.includes(isolated)) reject();
  const { env: templateEnv, ...settings } = template;
  return { settings, env: { ...templateEnv, CODEX_HOME: isolated, NODE_REPL_TRUSTED_CODE_PATHS: trustedPaths.join(path.delimiter) }, template: templateFile, resources: resourcesFromCommand(template.command) };
}

function exists(file) { return fs.existsSync(file); }
function absolute(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value) || /[\r\n\0;$`]/.test(value)) {
    throw new Error(`CUA sync requires an absolute ${label} path (no shell expressions).`);
  }
  return path.normalize(value);
}
function readTemplate(file) {
  let value;
  try { value = JSON.parse(fs.readFileSync(file, "utf8"))?.mcpServers?.cua_repl; }
  catch { throw new Error("Cannot read CUA template JSON; check --cua-template. No configuration was written."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("CUA template must contain mcpServers.cua_repl.");
  return value;
}
function resourcesFromCommand(command) {
  if (typeof command !== "string" || !path.isAbsolute(command)) return null;
  for (const suffix of [nodeSuffix, "cua_node/bin/node_repl"]) {
    if (command.endsWith(`/${suffix}`)) return command.slice(0, -suffix.length - 1);
  }
  return null;
}
function numberSetting(value, fallback, label, max) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`Invalid CUA ${label}; no values included in diagnostics.`);
  return value;
}
function exactList(value, expected, label) {
  if (!Array.isArray(value) || value.length !== expected.length || !expected.every(v => value.includes(v))) {
    throw new Error(`Unsupported CUA ${label} in bundled template; update the app/template before syncing.`);
  }
  return [...expected];
}

export function buildCuaConfig({ normal, isolated, env, source, cuaTemplate, chatgptResources }) {
  // Explicit resource selection is hermetic: never fall back to the real app.
  const home = env.HOME || env.USERPROFILE;
  const resourceCandidates = chatgptResources ? [absolute(chatgptResources, "ChatGPT Resources")] : [
    resourcesFromCommand(source.mcp_servers?.node_repl?.command),
    "/Applications/ChatGPT.app/Contents/Resources",
    home && path.join(home, "Applications/ChatGPT.app/Contents/Resources")
  ].filter(Boolean);
  let templateFile;
  if (cuaTemplate) templateFile = absolute(cuaTemplate, "CUA template");
  else {
    const candidates = resourceCandidates.map(root => path.join(root, templateSuffix));
    if (!chatgptResources) {
      const cache = path.join(normal, "plugins/cache/openai-bundled/unified-computer-use");
      if (exists(cache)) {
        for (const version of fs.readdirSync(cache).sort((a, b) => b.localeCompare(a, "en", { numeric: true }))) {
          candidates.push(path.join(cache, version, ".mcp.json"));
        }
      }
      candidates.push(path.join(normal, ".tmp/bundled-marketplaces/openai-bundled/plugins/unified-computer-use/.mcp.json"));
    }
    templateFile = candidates.find(exists);
  }
  if (!templateFile) throw new Error("CUA bundled template not found. Install/update ChatGPT, or provide --cua-template /absolute/.mcp.json and --chatgpt-resources /absolute/ChatGPT.app/Contents/Resources. No configuration was written.");
  const template = readTemplate(templateFile);
  if (!chatgptResources) {
    const inferred = resourcesFromCommand(template.command);
    if (inferred) resourceCandidates.unshift(inferred);
  }
  const resources = resourceCandidates.find(root => exists(path.join(root, nodeSuffix)));
  if (!resources) throw new Error("CUA app resources not found. Install/update ChatGPT or set --chatgpt-resources /absolute/ChatGPT.app/Contents/Resources. No configuration was written.");
  absolute(resources, "ChatGPT Resources");
  const modules = path.join(resources, "cua_node/lib/node_modules");
  const assets = {
    node: path.join(resources, nodeSuffix),
    repl: path.join(resources, "cua_node/bin/node_repl"),
    launcher: path.join(modules, "@oai/cua-repl/bin/cua-repl.mjs"),
    browser: path.join(modules, "@oai/browser-desktop/scripts/browser-service.mjs"),
    cli: path.join(resources, "codex-cli/CodexCLI.app/Contents/MacOS/codex")
  };
  for (const [name, file] of Object.entries(assets)) {
    if (!exists(file) || !fs.statSync(file).isFile()) throw new Error(`CUA ${name} asset missing under selected resources; install/update ChatGPT or correct --chatgpt-resources. No configuration was written.`);
    if (["node", "repl", "cli"].includes(name)) {
      try { fs.accessSync(file, fs.constants.X_OK); }
      catch { throw new Error(`CUA ${name} asset is not executable; repair the selected app resources.`); }
    }
  }
  const settings = {
    command: assets.node, args: [assets.launcher], enabled: true,
    enabled_tools: exactList(template.enabled_tools, toolNames, "enabled_tools"),
    omit_tools_from: exactList(template.omit_tools_from, visibility, "omit_tools_from"),
    startup_timeout_sec: numberSetting(template.startup_timeout_sec, 120, "startup_timeout_sec", 600),
    tool_timeout_sec: numberSetting(template.tool_timeout_sec, 30, "tool_timeout_sec", 600)
  };
  // Rebuild all home/trust/asset paths. Never retain a desktop session's homes,
  // backend paths, computer surface, arbitrary service modules or credentials.
  const safeEnv = {
    CODEX_HOME: isolated,
    CUA_REPL_NODE_REPL_PATH: assets.repl,
    CUA_REPL_ENABLED_SURFACES: "browser",
    NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS: "1000",
    NODE_REPL_NODE_MODULE_DIRS: modules,
    NODE_REPL_NODE_PATH: assets.node,
    NODE_REPL_TRUSTED_CODE_PATHS: `${isolated}:${modules}`,
    NODE_REPL_TRUSTED_SERVICES: JSON.stringify({ browser: "@oai/browser-desktop/service" }),
    BROWSER_USE_AVAILABLE_BACKENDS: "chrome",
    BROWSER_USE_TINYSKY_ENABLED: "1",
    CODEX_CLI_PATH: assets.cli
  };
  const templateEnv = template.env ?? {};
  for (const [key, pattern] of /** @type {[string, RegExp][]} */ ([
    ["NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS", /^(?:[1-9]\d{0,3}|10000)$/],
    ["BROWSER_USE_TINYSKY_ENABLED", /^[01]$/],
    ["BROWSER_USE_CODEX_APP_BUILD_FLAVOR", /^(?:prod|beta|alpha|dev)$/],
    ["BROWSER_USE_CODEX_APP_VERSION", /^\d{1,6}(?:\.\d{1,6}){2,3}$/]
  ])) {
    if (typeof templateEnv[key] === "string" && pattern.test(templateEnv[key])) safeEnv[key] = templateEnv[key];
  }
  // XML app metadata is optional; never guess a channel/version for another app.
  const plist = path.join(resources, "../Info.plist");
  if (exists(plist)) {
    const text = fs.readFileSync(plist, "utf8");
    const version = /<key>CFBundleShortVersionString<\/key>\s*<string>(\d{1,6}(?:\.\d{1,6}){2,3})<\/string>/.exec(text)?.[1];
    if (version) safeEnv.BROWSER_USE_CODEX_APP_VERSION = version;
    if (/<key>CFBundleIdentifier<\/key>\s*<string>com\.openai\.codex<\/string>/.test(text)) safeEnv.BROWSER_USE_CODEX_APP_BUILD_FLAVOR = "prod";
  }
  return { settings, env: safeEnv, template: templateFile, resources };
}
