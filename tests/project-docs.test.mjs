import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDir, initGitRepo, run } from "./helpers.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { projectDocsSetup, ensureProjectDocs } from "../plugins/codex/scripts/lib/setup-config.mjs";

const script = new URL("../plugins/codex/scripts/codex-companion.mjs", import.meta.url).pathname;

function fixture() {
  const dir = makeTempDir(); installFakeCodex(dir);
  const repo = path.join(dir, "repo"); fs.mkdirSync(repo); initGitRepo(repo);
  const env = { ...buildEnv(dir), CODEX_COMPANION_HOME: path.join(dir, "isolated"), CLAUDE_PLUGIN_DATA: path.join(dir, "data") };
  const configFile = path.join(env.CODEX_COMPANION_HOME, "config.toml");
  const call = (...args) => run(process.execPath, [script, ...args], { cwd: repo, env });
  const json = result => { assert.equal(result.status, 0, result.stderr + result.stdout); return JSON.parse(result.stdout); };
  const config = () => fs.existsSync(configFile) ? fs.readFileSync(configFile, "utf8") : null;
  return { dir, repo, env, configFile, call, json, config };
}

test("workers read CLAUDE.md through Codex's own fallback setting; the user can keep AGENTS.md only", () => {
  const f = fixture();
  const preview = projectDocsSetup({ env: f.env, dryRun: true });
  assert.deepEqual([preview.projectDocs, preview.fallbackFilenames, preview.custom, preview.dryRun], ["claude-md", ["CLAUDE.md"], false, true]);
  assert.equal(f.config(), null, "a dry run writes nothing");
  // Before a task the key is written once into the isolated home's config.toml.
  fs.mkdirSync(f.env.CODEX_COMPANION_HOME, { recursive: true });
  fs.writeFileSync(f.configFile, 'model = "gpt-6-astra"\n\n[mcp_servers.node_repl]\ncommand = "fixture"\n');
  const first = ensureProjectDocs({ env: f.env });
  assert.deepEqual(first.fallbackFilenames, ["CLAUDE.md"]);
  assert.equal(first.changedFiles.length, 1);
  assert.equal(f.config(), '"project_doc_fallback_filenames" = ["CLAUDE.md"]\nmodel = "gpt-6-astra"\n\n[mcp_servers.node_repl]\ncommand = "fixture"\n', "a top-level key precedes every table");
  assert.deepEqual(ensureProjectDocs({ env: f.env }).changedFiles, [], "idempotent");
  const backups = fs.readdirSync(f.env.CODEX_COMPANION_HOME).filter(name => name.startsWith("config.toml.backup-"));
  assert.equal(backups.length, 1);
  // agents-only removes Duet's list and is remembered; claude-md restores it.
  const off = f.json(f.call("setup", "--project-docs", "agents-only", "--json")).projectDocs;
  assert.deepEqual([off.projectDocs, off.fallbackFilenames], ["agents-only", []]);
  assert.doesNotMatch(f.config(), /project_doc_fallback_filenames/);
  assert.deepEqual(ensureProjectDocs({ env: f.env }).fallbackFilenames, [], "the preference survives the next task");
  assert.doesNotMatch(f.config(), /project_doc_fallback_filenames/);
  const on = f.json(f.call("setup", "--project-docs", "claude-md", "--json")).projectDocs;
  assert.deepEqual(on.fallbackFilenames, ["CLAUDE.md"]);
  assert.match(f.config(), /^"project_doc_fallback_filenames" = \["CLAUDE\.md"\]$/m);
  // A hand-written list is the user's: reported as custom and left alone in both modes.
  fs.writeFileSync(f.configFile, f.config().replace('"project_doc_fallback_filenames" = ["CLAUDE.md"]', 'project_doc_fallback_filenames = ["CLAUDE.md", "NOTES.md"]'));
  const custom = ensureProjectDocs({ env: f.env });
  assert.deepEqual([custom.fallbackFilenames, custom.changedFiles], [["CLAUDE.md", "NOTES.md"], []]);
  assert.equal(f.json(f.call("setup", "--project-docs", "agents-only", "--json")).projectDocs.custom, true);
  assert.match(f.config(), /NOTES\.md/);
  for (const args of [["--project-docs", "both"], ["--project-docs", "claude-md", "--default-sandbox", "read-only"], ["--project-docs", "claude-md", "--sync-tools"]]) {
    const rejected = f.call("setup", ...args, "--json");
    assert.notEqual(rejected.status, 0, args.join(" "));
  }
  assert.throws(() => projectDocsSetup({ mode: "both", env: f.env }), /--project-docs must be/);
  // A task applies the preference before Codex starts; setup reports it read-only.
  fs.writeFileSync(f.configFile, 'model = "gpt-6-astra"\n');
  f.json(f.call("setup", "--project-docs", "claude-md", "--json"));
  const task = f.json(f.call("task", "--json", "investigate"));
  assert.equal(task.status, 0);
  assert.match(f.config(), /project_doc_fallback_filenames/);
  assert.deepEqual(f.json(f.call("setup", "--json")).projectDocs.fallbackFilenames, ["CLAUDE.md"]);
});
