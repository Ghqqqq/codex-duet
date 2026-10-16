import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDir, run } from "./helpers.mjs";
import { installCuaFixture } from "./cua-config-fixture.mjs";
import { syncToolConfig, readToolConfig } from "../plugins/codex/scripts/lib/tool-config.mjs";
import { browserOriginSetup, defaultSandboxSetup } from "../plugins/codex/scripts/lib/setup-config.mjs";

const script = new URL("../plugins/codex/scripts/codex-companion.mjs", import.meta.url).pathname;
function fixture() {
  const base = makeTempDir(), app = installCuaFixture(base);
  const env = { ...process.env, HOME: base, CODEX_HOME: path.join(base, "normal"), CODEX_COMPANION_HOME: path.join(base, "isolated"), CLAUDE_PLUGIN_DATA: path.join(base, "data") };
  const modules = path.join(app.resources, "cua_node/lib/node_modules");
  const config = { ...app.config, command: path.join(app.resources, "cua_node/bin/node"),
    args: [path.join(modules, "@oai/cua-repl/bin/cua-repl.mjs")], enabled: true, env_vars: [], env: {
      CODEX_HOME: env.CODEX_HOME, NODE_REPL_TRUSTED_CODE_PATHS: `${env.CODEX_HOME}:${modules}:${env.CODEX_HOME}/plugins/cache`,
      CUA_REPL_ENABLED_SURFACES: "browser,computer", BROWSER_USE_AVAILABLE_BACKENDS: "chrome,iab,mcpapps",
      CUA_REPL_NODE_REPL_PATH: path.join(app.resources, "cua_node/bin/node_repl"),
      NODE_REPL_TRUSTED_SERVICES: '{"browser":"@oai/browser-desktop/service","sky":"@oai/sky/service"}',
      SKY_CUA_SERVICE_PATH: path.join(env.CODEX_HOME, "computer-use/Codex Computer Use.app"),
      NODE_REPL_INSTRUCTIONS_USE_CASE_BROWSER: 'Browser instructions\nwith "quotes" and # characters.',
      NODE_REPL_INSTRUCTIONS_USE_CASE_CHROME: "Chrome instructions", NODE_REPL_INSTRUCTIONS_USE_CASE_COMPUTER_USE: "Desktop instructions"
    } };
  fs.writeFileSync(app.template, JSON.stringify({ mcpServers: { cua_repl: config, other: { token: "DO-NOT-COPY" } } }));
  const options = { env, profile: "codex-app", cuaTemplate: app.template };
  const destination = path.join(env.CODEX_COMPANION_HOME, "config.toml");
  const call = (...args) => run(process.execPath, [script, "setup", ...args], { env });
  return { base, env, app, config, options, destination, call };
}
const plain = value => JSON.parse(JSON.stringify(value));

test("codex-app mirrors the template exactly except two home fields, without inventing a timeout", () => {
  const f = fixture();
  const preview = syncToolConfig({ ...f.options, dryRun: true });
  assert.equal(fs.existsSync(f.env.CODEX_COMPANION_HOME), false);
  assert.equal(preview.requiresReplace, false);
  assert.deepEqual(preview.surfaces, ["browser", "computer"]);
  assert.deepEqual(preview.backends, ["chrome", "iab", "mcpapps"]);
  const expected = structuredClone(f.config);
  expected.env.CODEX_HOME = f.env.CODEX_COMPANION_HOME;
  expected.env.NODE_REPL_TRUSTED_CODE_PATHS = expected.env.NODE_REPL_TRUSTED_CODE_PATHS.replace(f.env.CODEX_HOME, f.env.CODEX_COMPANION_HOME);
  assert.deepEqual(plain(readToolConfig(preview.append).mcp_servers.cua_repl), expected);
  assert.doesNotMatch(preview.append, /tool_timeout_sec|DO-NOT-COPY/);
  const applied = syncToolConfig(f.options);
  assert.equal(applied.backup, null);
  assert.equal(fs.readFileSync(f.destination, "utf8"), preview.append);
  assert.equal(syncToolConfig(f.options).changed, false);
});

test("codex-app discovers the newest numeric cache version and honors an explicit template", () => {
  const f = fixture(), cache = path.join(f.env.CODEX_HOME, "plugins/cache/openai-bundled/unified-computer-use");
  for (const version of ["26.9.9", "26.10.10"]) {
    fs.mkdirSync(path.join(cache, version), { recursive: true });
    fs.copyFileSync(f.app.template, path.join(cache, version, ".mcp.json"));
  }
  fs.mkdirSync(path.join(cache, "99.0.0")); // Incomplete installation has no template.
  const options = { env: f.env, profile: "codex-app", dryRun: true };
  assert.equal(syncToolConfig(options).cuaSource.template, path.join(cache, "26.10.10/.mcp.json"));
  assert.equal(syncToolConfig({ ...options, cuaTemplate: f.app.template }).cuaSource.template, f.app.template);
  fs.rmSync(cache, { recursive: true });
  assert.throws(() => syncToolConfig(options), /cache template not found/);
  assert.equal(fs.existsSync(f.env.CODEX_COMPANION_HOME), false);
});

test("codex-app previews replacement safely, refuses clobber, backs up and removes the whole old block", () => {
  const f = fixture();
  const prefix = 'model = "keep"\n[mcp_servers.other]\ncommand = "unrelated"\n';
  const suffix = '[projects."/keep"]\ntrust_level = "trusted"\n';
  const before = prefix + '[mcp_servers.cua_repl]\ncommand = "old"\ntool_timeout_sec = 30\nbearer_token = "DO-NOT-COPY"\n[mcp_servers.cua_repl.env]\nCUA_REPL_ENABLED_SURFACES = "browser"\nOPENAI_API_KEY = "DO-NOT-COPY"\n[mcp_servers.cua_repl.tools.js]\noutput_token_limit = 10\n' + suffix;
  fs.mkdirSync(f.env.CODEX_COMPANION_HOME); fs.writeFileSync(f.destination, before);
  const preview = syncToolConfig({ ...f.options, dryRun: true });
  assert.equal(preview.requiresReplace, true);
  assert.ok(preview.diff.some(d => d.field === "tool_timeout_sec" && d.operation === "remove"));
  assert.doesNotMatch(JSON.stringify(preview), /DO-NOT-COPY/);
  assert.deepEqual(fs.readdirSync(f.env.CODEX_COMPANION_HOME), ["config.toml"]);
  assert.throws(() => syncToolConfig(f.options), /refusing to clobber.*--replace-cua/);
  assert.equal(fs.readFileSync(f.destination, "utf8"), before);
  assert.equal(syncToolConfig({ ...f.options, replaceCua: true, dryRun: true }).requiresReplace, false);
  assert.equal(fs.readFileSync(f.destination, "utf8"), before);
  const result = syncToolConfig({ ...f.options, replaceCua: true });
  assert.deepEqual(result.replaced, ["mcp_servers.cua_repl"]);
  assert.equal(fs.readFileSync(result.backup, "utf8"), before);
  assert.equal(fs.statSync(result.backup).mode & 0o777, 0o600);
  const after = fs.readFileSync(f.destination, "utf8");
  assert.ok(after.startsWith(prefix + suffix));
  assert.doesNotMatch(after, /tool_timeout_sec|DO-NOT-COPY/);
  assert.equal(readToolConfig(after).mcp_servers.cua_repl.tools.js.output_token_limit, 25000);
  assert.equal(syncToolConfig({ ...f.options, replaceCua: true }).changed, false);
});

test("CUA replacement handles dotted/inline server definitions and refuses a closed parent", () => {
  for (const before of ['mcp_servers.cua_repl = { enabled = false }\n', '[mcp_servers]\ncua_repl = { enabled = false }\n', '[mcp_servers.cua_repl.env]\nCODEX_HOME = "/old"\n']) {
    const f = fixture(); fs.mkdirSync(f.env.CODEX_COMPANION_HOME); fs.writeFileSync(f.destination, before);
    syncToolConfig({ ...f.options, replaceCua: true });
    assert.equal(readToolConfig(fs.readFileSync(f.destination, "utf8")).mcp_servers.cua_repl.enabled, true);
  }
  const f = fixture(); fs.mkdirSync(f.env.CODEX_COMPANION_HOME);
  const before = 'mcp_servers = { cua_repl = { enabled = false }, other = { command = "keep" } }\n';
  fs.writeFileSync(f.destination, before);
  assert.throws(() => syncToolConfig({ ...f.options, replaceCua: true }), /inline tool table/);
  assert.equal(fs.readFileSync(f.destination, "utf8"), before);
});

test("codex-app rejects credential-bearing/unknown schemas before writing or echoing values", () => {
  const f = fixture();
  for (const changes of [{ bearer_token: "DO-NOT-COPY" }, { env_vars: ["OPENAI_API_KEY"] }, { args: ["--token=DO-NOT-COPY"] }, { env: { ...f.config.env, OPENAI_API_KEY: "DO-NOT-COPY" } }, { tools: { js: { output_token_limit: 25, extra: "DO-NOT-COPY" } } }]) {
    fs.writeFileSync(f.app.template, JSON.stringify({ mcpServers: { cua_repl: { ...f.config, ...changes } } }));
    assert.throws(() => syncToolConfig(f.options), e => /CUA/.test(e.message) && !/DO-NOT-COPY/.test(e.message));
    assert.equal(fs.existsSync(f.env.CODEX_COMPANION_HOME), false);
  }
});

test("codex-app CLI exposes offline diff/surfaces and validates selectors before writes", () => {
  const f = fixture();
  const args = ["--sync-tools", "--profile", "codex-app", "--cua-template", f.app.template];
  const result = f.call(...args, "--dry-run", "--json");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).toolSync.surfaces, ["browser", "computer"]);
  assert.equal(fs.existsSync(f.env.CODEX_COMPANION_HOME), false);
  for (const flags of [["--profile", "codex-app"], ["--replace-cua"], ["--sync-tools", "--profile", "unknown"], [...args, "--chatgpt-resources", f.app.resources], ["--browser-approval", "never-ask", "--profile", "codex-app"]]) {
    assert.notEqual(f.call(...flags).status, 0);
    assert.equal(fs.existsSync(f.env.CODEX_COMPANION_HOME), false);
  }
  fs.mkdirSync(f.env.CODEX_COMPANION_HOME);
  const before = '[mcp_servers.cua_repl]\nenabled = false\ntool_timeout_sec = 30\n';
  fs.writeFileSync(f.destination, before);
  assert.equal(JSON.parse(f.call(...args, "--dry-run", "--json").stdout).toolSync.requiresReplace, true);
  assert.match(f.call(...args).stderr, /refusing to clobber/);
  assert.equal(fs.readFileSync(f.destination, "utf8"), before);
  const applied = f.call(...args, "--replace-cua", "--json");
  assert.equal(applied.status, 0, applied.stderr);
  assert.deepEqual(JSON.parse(applied.stdout).toolSync.replaced, ["mcp_servers.cua_repl"]);
  assert.equal(readToolConfig(fs.readFileSync(f.destination, "utf8")).mcp_servers.cua_repl.tool_timeout_sec, undefined);
});

test("browser approval merges only the top-level key, backs up, removes and reports the setting", () => {
  const f = fixture(), dir = path.join(f.env.CODEX_COMPANION_HOME, "browser"), file = path.join(dir, "config.toml");
  const before = '# keep\ndownload_approval_mode = "ask"\nupload_approval_mode = "ask"\nhistory_approval_mode = "ask"\n[origins]\nallowed = ["https://example.com"]\ndenied = ["https://denied.example"]\n[other]\napproval_mode = "keep"\n';
  fs.mkdirSync(path.join(dir, "sessions"), { recursive: true }); fs.writeFileSync(file, before);
  const session = path.join(dir, "sessions/thread.toml"); fs.writeFileSync(session, '[origins]\ndenied = ["https://example.com"]\n');
  const setup = options => browserOriginSetup({ env: f.env, ...options });
  assert.equal(setup({ approval: "never-ask", dryRun: true }).approval, "never-ask");
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["config.toml", "sessions"]);
  const result = setup({ approval: "never-ask" });
  assert.deepEqual(result.changedFiles, [file]);
  assert.equal(fs.readFileSync(result.backups[0], "utf8"), before);
  assert.equal(fs.statSync(result.backups[0]).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(file, "utf8"), '"approval_mode" = "never_ask"\n' + before);
  assert.deepEqual(setup({ approval: "never-ask" }).changedFiles, []);
  assert.equal(JSON.parse(f.call("--list-browser-origins", "--json").stdout).browserOrigins.approval, "never-ask");
  const removed = setup({ approval: "ask" });
  assert.equal(removed.approval, "ask"); assert.equal(removed.backups.length, 1);
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.equal(fs.readFileSync(session, "utf8"), '[origins]\ndenied = ["https://example.com"]\n');
  assert.deepEqual(setup({ approval: "ask" }).changedFiles, []);
  fs.writeFileSync(file, 'approval_mode = "ask" # local choice\n' + before);
  setup({ approval: "never-ask" });
  assert.match(fs.readFileSync(file, "utf8"), /^"approval_mode" = "never_ask" # local choice/);
  assert.equal(f.call("--browser-approval", "invalid").status, 1);
});

test("browser approval dry-run and ask do not create a missing home; mixed changes reject", () => {
  const f = fixture();
  for (const args of [["--browser-approval", "never-ask", "--dry-run"], ["--browser-approval", "ask"]]) assert.equal(f.call(...args, "--json").status, 0);
  assert.equal(fs.existsSync(f.env.CODEX_COMPANION_HOME), false);
  for (const args of [["--default-sandbox", "danger-full-access", "--browser-approval", "never-ask"], ["--sync-tools", "--browser-approval", "never-ask"], ["--transport", "http", "--browser-approval", "never-ask"]]) assert.notEqual(f.call(...args).status, 0);
  assert.equal(fs.existsSync(f.env.CODEX_COMPANION_HOME), false);
});

test("default sandbox persists plugin-wide in the isolated home regardless of CLAUDE_PLUGIN_DATA", () => {
  const f = fixture(), root = path.join(f.env.CODEX_COMPANION_HOME, "duet"), file = path.join(root, "config.toml");
  const setup = options => defaultSandboxSetup({ env: f.env, ...options });
  assert.equal(setup().defaultSandbox, "danger-full-access", "built-in default: full access, like the user's own Codex app");
  assert.equal(setup({ mode: "read-only", dryRun: true }).defaultSandbox, "read-only");
  assert.equal(fs.existsSync(root), false);
  fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(file, 'keep = "value"\n');
  const result = setup({ mode: "read-only" });
  assert.equal(result.file, file);
  assert.equal(fs.readFileSync(result.backups[0], "utf8"), 'keep = "value"\n');
  assert.equal(setup().defaultSandbox, "read-only");
  assert.deepEqual(setup({ mode: "read-only" }).changedFiles, []);
  assert.equal(setup({ mode: "danger-full-access" }).defaultSandbox, "danger-full-access");
  assert.throws(() => setup({ mode: "full" }), /--default-sandbox/);
  // A terminal (no plugin data) and a Claude session (plugin data set) read the same file.
  const terminal = defaultSandboxSetup({ env: { ...f.env, CLAUDE_PLUGIN_DATA: "" }, mode: "workspace-write" });
  assert.equal(terminal.file, file);
  assert.equal(setup().defaultSandbox, "workspace-write");
  assert.equal(fs.existsSync(path.join(f.env.CLAUDE_PLUGIN_DATA, "config.toml")), false);
});
