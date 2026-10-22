import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDir, run } from "./helpers.mjs";
import { installCuaFixture } from "./cua-config-fixture.mjs";
import { syncToolConfig, readToolConfig, getToolAvailability } from "../plugins/codex/scripts/lib/tool-config.mjs";
import { CUA_SETTING_KEYS, CUA_ENV_KEYS } from "../plugins/codex/scripts/lib/cua-config.mjs";

const script = new URL("../plugins/codex/scripts/codex-companion.mjs", import.meta.url).pathname;
function fixture() {
  const base = makeTempDir();
  const app = installCuaFixture(base);
  const env = { HOME: base, CODEX_HOME: path.join(base, "normal"), CODEX_COMPANION_HOME: path.join(base, "isolated") };
  const options = { env, cuaTemplate: app.template, chatgptResources: app.resources };
  const destination = path.join(env.CODEX_COMPANION_HOME, "config.toml");
  return { base, app, env, options, destination };
}
function setTemplate(f, changes) {
  fs.writeFileSync(f.app.template, JSON.stringify({ mcpServers: { cua_repl: { ...f.app.config, ...changes } } }));
}

test("CUA rebuilds a disabled bundled template with exact offline preview and private backup", () => {
  const f = fixture();
  const before = '# preserve destination\nmodel = "private"';
  fs.mkdirSync(f.env.CODEX_COMPANION_HOME);
  fs.writeFileSync(f.destination, before);
  const preview = syncToolConfig({ ...f.options, dryRun: true });
  assert.equal(preview.sourceFound, false);
  assert.deepEqual(preview.added, ["mcp_servers.cua_repl", "mcp_servers.cua_repl.env"]);
  assert.equal(fs.readFileSync(f.destination, "utf8"), before);
  assert.deepEqual(fs.readdirSync(f.env.CODEX_COMPANION_HOME), ["config.toml"]);
  const result = syncToolConfig(f.options);
  assert.equal(fs.readFileSync(f.destination, "utf8"), before + preview.append);
  assert.equal(fs.readFileSync(result.backup, "utf8"), before);
  assert.match(path.basename(result.backup), /^config\.toml\.backup-\d{4}-\d\d-\d\dT/);
  assert.equal(fs.statSync(result.backup).mode & 0o777, 0o600);
  const config = readToolConfig(before + preview.append).mcp_servers.cua_repl;
  assert.deepEqual(Object.keys(config).filter(k => k !== "env").sort(), [...CUA_SETTING_KEYS].sort());
  assert.deepEqual(Object.keys(config.env).sort(), [...CUA_ENV_KEYS].sort());
  assert.equal(config.enabled, true);
  assert.equal(config.env.CODEX_HOME, f.env.CODEX_COMPANION_HOME);
  assert.equal(config.env.NODE_REPL_TRUSTED_CODE_PATHS, `${f.env.CODEX_COMPANION_HOME}:${f.app.resources}/cua_node/lib/node_modules`);
  assert.equal(config.tool_timeout_sec, 30);
  assert.equal(config.startup_timeout_sec, 120);
  assert.equal(config.env.BROWSER_USE_AVAILABLE_BACKENDS, "chrome");
  const again = syncToolConfig(f.options);
  assert.equal(again.append, "");
  assert.equal(again.backup, null);
  assert.equal(again.changed, false);
  assert.equal(getToolAvailability(f.env).browser, "available");
  assert.equal(getToolAvailability(f.env).computerUse, "missing");
  assert.equal(getToolAvailability(f.env).cuaRepl, "available");
});

test("CUA ignores arbitrary settings, credentials, desktop identities and secret-like allowed env values", () => {
  const f = fixture();
  setTemplate(f, {
    command: "DO-NOT-COPY", args: ["--token=DO-NOT-COPY"],
    bearer_token: "DO-NOT-COPY", env_vars: ["DO-NOT-COPY"], cwd: "DO-NOT-COPY",
    env: Object.fromEntries([...CUA_ENV_KEYS, "HOME", "CODEX_SQLITE_HOME", "CODEX_COMPANION_HOME", "OPENAI_API_KEY", "CODEX_SESSION_ID", "BROWSER_USE_BACKEND_PATHS", "BROWSER_USE_ACCESS_EXECUTOR_ID", "NODE_REPL_JS_BANNER", "NODE_REPL_TOOL_OVERRIDES", "NODE_REPL_INSTRUCTIONS_USE_CASE_BROWSER"].map(k => [k, "DO-NOT-COPY"]))
  });
  const preview = syncToolConfig({ ...f.options, dryRun: true });
  assert.doesNotMatch(JSON.stringify(preview), /DO-NOT-COPY/);
  assert.equal(fs.existsSync(f.env.CODEX_COMPANION_HOME), false);
  const cua = readToolConfig(preview.append).mcp_servers.cua_repl;
  assert.equal(cua.env.NODE_REPL_TRUSTED_SERVICES, '{"browser":"@oai/browser-desktop/service"}');
  assert.ok(!Object.hasOwn(cua, "env_vars"));
});

test("existing hand-written CUA plus env is byte-exact without any template/app access", () => {
  const f = fixture();
  const initial = syncToolConfig({ ...f.options, dryRun: true }).append;
  const before = initial.replace('["mcp_servers"."cua_repl"]', '[mcp_servers.cua_repl]').replace('["mcp_servers"."cua_repl"."env"]', '[mcp_servers.cua_repl.env]');
  fs.mkdirSync(f.env.CODEX_COMPANION_HOME);
  fs.writeFileSync(f.destination, before);
  fs.rmSync(path.join(f.base, "Relocated ChatGPT.app"), { recursive: true });
  const prior = fs.statSync(f.destination);
  const result = syncToolConfig(f.options);
  assert.deepEqual(result.present, ["mcp_servers.cua_repl"]);
  assert.equal(result.changed, false);
  assert.equal(result.cuaSource, null);
  assert.equal(fs.readFileSync(f.destination, "utf8"), before);
  assert.equal(fs.statSync(f.destination).mtimeMs, prior.mtimeMs);
  assert.deepEqual(fs.readdirSync(f.env.CODEX_COMPANION_HOME), ["config.toml"]);
});

test("disabled, inline and env-only existing CUA definitions are preserved", () => {
  for (const before of [
    '[mcp_servers.cua_repl]\nenabled = false\n',
    'mcp_servers = { cua_repl = { enabled = false } }\n',
    '[mcp_servers."cua_repl".env]\nCODEX_HOME = "/existing"\n'
  ]) {
    const f = fixture();
    fs.mkdirSync(f.env.CODEX_COMPANION_HOME);
    fs.writeFileSync(f.destination, before);
    assert.equal(syncToolConfig(f.options).changed, false);
    assert.equal(fs.readFileSync(f.destination, "utf8"), before);
  }
});

test("missing template/resources/assets fail before any write, including planned node_repl changes", () => {
  for (const failure of ["template", "resources", "launcher", "executable"]) {
    const f = fixture();
    fs.mkdirSync(f.env.CODEX_HOME);
    fs.writeFileSync(path.join(f.env.CODEX_HOME, "config.toml"), '[mcp_servers.node_repl]\ncommand = "node_repl"\n');
    if (failure === "template") fs.unlinkSync(f.app.template);
    if (failure === "resources") f.options.chatgptResources = path.join(f.base, "absent");
    if (failure === "launcher") fs.unlinkSync(path.join(f.app.resources, "cua_node/lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs"));
    if (failure === "executable") fs.chmodSync(path.join(f.app.resources, "cua_node/bin/node"), 0o600);
    assert.throws(() => syncToolConfig(f.options), /CUA.*(?:template|resources|asset)/);
    assert.equal(fs.existsSync(f.env.CODEX_COMPANION_HOME), false);
  }
});

test("invalid CUA schemas/settings reject safely; resource-only lookup is hermetic", () => {
  const f = fixture();
  assert.equal(syncToolConfig({ env: f.env, chatgptResources: f.app.resources, dryRun: true }).cuaSource.template, f.app.template);
  for (const changes of [{ enabled_tools: ["DO-NOT-COPY"] }, { omit_tools_from: [] }, { startup_timeout_sec: "DO-NOT-COPY" }, { tool_timeout_sec: -1 }]) {
    setTemplate(f, changes);
    assert.throws(() => syncToolConfig(f.options), e => /CUA/.test(e.message) && !/DO-NOT-COPY/.test(e.message));
    assert.equal(fs.existsSync(f.env.CODEX_COMPANION_HOME), false);
  }
  fs.writeFileSync(f.app.template, '{"invalid": "DO-NOT-COPY"');
  assert.throws(() => syncToolConfig(f.options), /Cannot read CUA template JSON/);
  fs.unlinkSync(f.app.template);
  assert.throws(() => syncToolConfig({ env: f.env, chatgptResources: f.app.resources }), /CUA bundled template not found/);
});

test("CUA refuses to append inside a closed TOML inline parent", () => {
  const f = fixture();
  fs.mkdirSync(f.env.CODEX_COMPANION_HOME);
  const before = 'mcp_servers = { node_repl = { command = "node_repl" } }\n';
  fs.writeFileSync(f.destination, before);
  assert.throws(() => syncToolConfig(f.options), /Cannot extend an inline tool table/);
  assert.equal(fs.readFileSync(f.destination, "utf8"), before);
  assert.deepEqual(fs.readdirSync(f.env.CODEX_COMPANION_HOME), ["config.toml"]);
});

test("CUA CLI flags support relocated fixtures, offline dry-run and strict option validation", () => {
  const f = fixture();
  const flags = ["--cua-template", f.app.template, "--chatgpt-resources", f.app.resources];
  const result = run(process.execPath, [script, "setup", "--sync-tools", "--dry-run", "--json", ...flags], { env: { ...process.env, ...f.env } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(JSON.parse(result.stdout).toolSync.append, /cua_repl/);
  assert.equal(fs.existsSync(f.env.CODEX_COMPANION_HOME), false);
  for (const args of [["--cua-template", f.app.template], ["--sync-tools", "--cua-template", ""], ["--sync-tools", "--chatgpt-resources", "relative"], ["--sync-tools", "--cua-template"]]) {
    const invalid = run(process.execPath, [script, "setup", ...args], { env: { ...process.env, ...f.env } });
    assert.notEqual(invalid.status, 0);

  }
});
