import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDir, run } from "./helpers.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { installCuaFixture } from "./cua-config-fixture.mjs";
import { getToolAvailability, readToolConfig, syncToolConfig, NODE_REPL_ENV_KEYS } from "../plugins/codex/scripts/lib/tool-config.mjs";

const script = new URL("../plugins/codex/scripts/codex-companion.mjs", import.meta.url).pathname;
function fixture() {
  const base = makeTempDir();
  const cua = installCuaFixture(base);
  const env = { HOME: base, CODEX_HOME: path.join(base, "normal"), CODEX_COMPANION_HOME: path.join(base, "isolated") };
  fs.mkdirSync(env.CODEX_HOME);
  const source = path.join(env.CODEX_HOME, "config.toml");
  const destination = path.join(env.CODEX_COMPANION_HOME, "config.toml");
  const config = `model = "keep-source-model-out"
api_key = "DO-NOT-COPY"
instructions = """Unrelated multiline text
[plugins.fake]
"""
[marketplaces.openai-bundled]
source_type = "local"
source = "${base}/normal/.tmp/bundled-marketplaces/openai-bundled"
token = "DO-NOT-COPY"
[plugins."browser@openai-bundled"]
enabled = true
auth = "DO-NOT-COPY"
[plugins.'chrome@openai-bundled']
enabled = false
[plugins."computer-use@openai-bundled"]
enabled = true
[plugins."unified-computer-use@openai-bundled"]
enabled = true
[plugins."unlisted@openai-bundled"]
enabled = true
[mcp_servers.node_repl]
command = "${cua.resources}/cua_node/bin/node_repl"
args = [ # multiline array
]
startup_timeout_sec = 120
bearer_token = "DO-NOT-COPY"
[mcp_servers.node_repl.env]
CODEX_HOME = "${env.CODEX_HOME}"
NODE_REPL_TRUSTED_CODE_PATHS = "${env.CODEX_HOME}:${env.CODEX_HOME}/plugins/cache/openai-bundled:/app/modules"
NODE_REPL_TRUSTED_SERVICES = '{"browser":"${env.CODEX_HOME}/plugins/cache/browser/service.mjs","sky":"@oai/sky/service"}'
${NODE_REPL_ENV_KEYS.filter(k => !["CODEX_HOME", "NODE_REPL_TRUSTED_CODE_PATHS", "NODE_REPL_TRUSTED_SERVICES"].includes(k)).map(k => `${k} = "/fixture/${k}"`).join("\n")}
OPENAI_API_KEY = "DO-NOT-COPY"
UNKNOWN_PATH = "/DO-NOT-COPY"
[mcp_servers.other]
token = "DO-NOT-COPY"
`;
  fs.writeFileSync(source, config);
  return { base, env, source, destination, config };
}

test("tool sync uses exact env/plugin allowlists, preserves code sources and backs up once", () => {
  const f = fixture();
  fs.mkdirSync(f.env.CODEX_COMPANION_HOME);
  const before = 'model = "private-model"\n# preserve this comment\n[projects."/repo"]\ntrust_level = "trusted"\n';
  fs.writeFileSync(f.destination, before);
  const preview = syncToolConfig({ env: f.env, dryRun: true });
  assert.equal(preview.added.length, 8);
  assert.equal(fs.readFileSync(f.destination, "utf8"), before);
  assert.equal(fs.readdirSync(f.env.CODEX_COMPANION_HOME).length, 1);
  const result = syncToolConfig({ env: f.env });
  assert.equal(fs.readFileSync(result.backup, "utf8"), before);
  const after = fs.readFileSync(f.destination, "utf8");
  assert.ok(after.startsWith(before));
  assert.doesNotMatch(after, /DO-NOT-COPY|unlisted|keep-source-model/);
  const config = readToolConfig(after);
  const replEnv = config.mcp_servers.node_repl.env;
  assert.deepEqual(Object.keys(replEnv).sort(), [...NODE_REPL_ENV_KEYS].sort());
  assert.equal(replEnv.CODEX_HOME, f.env.CODEX_COMPANION_HOME);
  assert.equal(replEnv.NODE_REPL_TRUSTED_CODE_PATHS, `${f.env.CODEX_COMPANION_HOME}:${f.env.CODEX_HOME}/plugins/cache/openai-bundled:/app/modules`);
  assert.equal(JSON.parse(replEnv.NODE_REPL_TRUSTED_SERVICES).browser, `${f.env.CODEX_HOME}/plugins/cache/browser/service.mjs`);
  assert.equal(replEnv.CODEX_CLI_PATH, "/fixture/CODEX_CLI_PATH");
  assert.equal(config.marketplaces["openai-bundled"].source_type, "local");
  assert.equal(config.plugins["chrome@openai-bundled"].enabled, false);
  assert.ok(result.skipped.some(s => s.includes("OPENAI_API_KEY")));
  assert.doesNotMatch(JSON.stringify(result), /DO-NOT-COPY/);
  const again = syncToolConfig({ env: f.env });
  assert.equal(again.changed, false);
  assert.equal(again.present.length, 7);
  assert.equal(again.backup, null);
  assert.equal(fs.readFileSync(f.destination, "utf8"), after);
  assert.equal(getToolAvailability(f.env).browser, "available");
});

test("reference-style preexisting tables including separate env table are a byte-exact no-op", () => {
  const f = fixture();
  fs.mkdirSync(f.env.CODEX_COMPANION_HOME);
  fs.writeFileSync(f.destination, f.config.replaceAll(f.env.CODEX_HOME, f.env.CODEX_COMPANION_HOME) + '\n[mcp_servers.cua_repl]\ncommand = "existing-cua"\n[mcp_servers.cua_repl.env]\nCUA_REPL_ENABLED_SURFACES = "browser"\n');
  const before = fs.readFileSync(f.destination, "utf8");
  assert.equal(syncToolConfig({ env: f.env }).changed, false);
  assert.equal(fs.readFileSync(f.destination, "utf8"), before);
});

test("dry run does not create home and rejects home/config aliases", () => {
  const f = fixture();
  assert.equal(syncToolConfig({ env: f.env, dryRun: true }).changed, true);
  assert.equal(fs.existsSync(f.env.CODEX_COMPANION_HOME), false);
  for (const home of [f.env.CODEX_HOME, path.join(f.env.CODEX_HOME, "child"), f.base]) {
    assert.throws(() => syncToolConfig({ env: { ...f.env, CODEX_COMPANION_HOME: home } }), /overlap/);
  }
  fs.symlinkSync(f.env.CODEX_HOME, f.env.CODEX_COMPANION_HOME);
  assert.throws(() => syncToolConfig({ env: f.env }), /overlap/);
  fs.unlinkSync(f.env.CODEX_COMPANION_HOME);
  fs.mkdirSync(f.env.CODEX_COMPANION_HOME);
  fs.symlinkSync(f.source, f.destination);
  assert.throws(() => syncToolConfig({ env: f.env }), /symlink/);
});

test("unsupported selected TOML fails safely; availability reports unknown or missing", () => {
  const f = fixture();
  assert.equal(getToolAvailability(f.env).browser, "missing");
  fs.mkdirSync(f.env.CODEX_COMPANION_HOME);
  fs.writeFileSync(f.destination, '[mcp_servers.node_repl]\ncommand = """unsupported"""\n');
  assert.equal(getToolAvailability(f.env).browser, "unknown");
  assert.throws(() => syncToolConfig({ env: f.env }), /Unsupported/);
  assert.equal(fs.readdirSync(f.env.CODEX_COMPANION_HOME).length, 1);
});

test("setup dry-run is offline; setup JSON reports configured availability", () => {
  const f = fixture();
  installFakeCodex(f.base);
  const env = { ...buildEnv(f.base), ...f.env };
  const preview = run(process.execPath, [script, "setup", "--sync-tools", "--dry-run", "--json"], { env });
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).toolSync.dryRun, true);
  assert.equal(fs.existsSync(f.env.CODEX_COMPANION_HOME), false);
  assert.equal(fs.existsSync(path.join(f.base, "fake-codex-state.json")), false);
  const setup = run(process.execPath, [script, "setup", "--sync-tools", "--json"], { env });
  assert.equal(setup.status, 0, setup.stderr);
  assert.equal(JSON.parse(setup.stdout).tools.browser, "available");
});
