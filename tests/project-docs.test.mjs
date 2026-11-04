import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDir, initGitRepo, run } from "./helpers.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { projectDocsSetup, ensureProjectDocs } from "../plugins/codex/scripts/lib/setup-config.mjs";
import { instructionInventory } from "../plugins/codex/hooks/claude-memory.mjs";
import { register } from "../plugins/codex/hooks/register.mjs";
import { approveDuet } from "../plugins/codex/scripts/duet-permission-hook.mjs";
import { claudeSnapshotFile, readClaudeSnapshot, writeClaudeSnapshot, scanClaudeInstructions, prepareClaudeInstructions, renderClaudeInstructions, EXECUTOR_FRAMING, INSTRUCTION_LIMIT } from "../plugins/codex/scripts/lib/claude-memory.mjs";
import { resolveClaudeSessionPath, snapshotClaudeSession } from "../plugins/codex/scripts/lib/claude-session-transfer.mjs";

const script = new URL("../plugins/codex/scripts/codex-companion.mjs", import.meta.url).pathname;
const duet = new URL("../plugins/codex/bin/duet", import.meta.url).pathname;
function put(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }
function fixture() {
  const dir = makeTempDir(); installFakeCodex(dir);
  const repo = path.join(dir, "repo"); fs.mkdirSync(repo); initGitRepo(repo);
  const env = { ...buildEnv(dir), CODEX_COMPANION_HOME: path.join(dir, "isolated"), CLAUDE_PLUGIN_DATA: path.join(dir, "data") };
  const call = (...args) => {
    const result = run(process.execPath, [script, ...args], { cwd: repo, env });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return JSON.parse(result.stdout);
  };
  return { dir, repo, env, call, state: () => JSON.parse(fs.readFileSync(path.join(dir, "fake-codex-state.json"))) };
}

test("project documentation preferences preserve custom settings and apply before task startup", () => {
  const f = fixture(), config = path.join(f.env.CODEX_COMPANION_HOME, "config.toml");
  assert.equal(projectDocsSetup({ env: f.env, dryRun: true }).dryRun, true);
  assert.equal(fs.existsSync(config), false);
  put(config, 'model = "gpt-6-astra"\n[mcp_servers.fixture]\ncommand = "fixture"\n');
  assert.deepEqual(ensureProjectDocs({ env: f.env }).fallbackFilenames, ["CLAUDE.md"]);
  assert.match(fs.readFileSync(config, "utf8"), /^"project_doc_fallback_filenames" = \["CLAUDE.md"\]/);
  assert.deepEqual(ensureProjectDocs({ env: f.env }).changedFiles, []);
  assert.equal(fs.readdirSync(path.dirname(config)).filter(name => name.startsWith("config.toml.backup-")).length, 1);
  f.call("setup", "--project-docs", "agents-only", "--json");
  assert.deepEqual(ensureProjectDocs({ env: f.env }).fallbackFilenames, []);
  assert.doesNotMatch(fs.readFileSync(config, "utf8"), /project_doc_fallback_filenames/);
  f.call("setup", "--project-docs", "claude-md", "--json");
  fs.writeFileSync(config, 'model = "gpt-6-astra"\n');
  put(path.join(f.repo, "CLAUDE.md"), "PROJECT_RULE");
  f.call("task", "--json", "investigate");
  const started = f.state().lastThreadStart;
  assert.ok(started.developerInstructions.startsWith(EXECUTOR_FRAMING));
  assert.ok(started.developerInstructions.includes("PROJECT_RULE"));
  assert.deepEqual(started.config.project_doc_fallback_filenames, []);
  assert.ok(started.config.mcp_servers, "project documentation overrides retain the parent bridge");
  assert.deepEqual(f.call("setup", "--json").projectDocs.fallbackFilenames, ["CLAUDE.md"]);
  const projectConfig = path.join(f.dir, ".codex", "config.toml");
  put(projectConfig, 'project_doc_fallback_filenames = ["NOTES.md"]\n');
  f.call("task", "--fresh", "--json", "project fallback");
  assert.equal(f.state().lastThreadStart.config?.project_doc_fallback_filenames, undefined,
    "an ancestor project config retains its own fallback filenames");
  fs.rmSync(path.dirname(projectConfig), { recursive: true });
  const custom = 'project_doc_fallback_filenames = ["CLAUDE.md", "NOTES.md"]\n';
  fs.writeFileSync(config, custom);
  assert.equal(projectDocsSetup({ mode: "agents-only", env: f.env }).custom, true);
  assert.equal(fs.readFileSync(config, "utf8"), custom);
  f.call("task", "--fresh", "--json", "custom fallback");
  assert.equal(f.state().lastThreadStart.config?.project_doc_fallback_filenames, undefined);
  assert.equal(fs.readFileSync(config, "utf8"), custom);
});

test("first context captures only loaded instructions, freezes filtered inventories and keeps incomplete captures approximate", async () => {
  const f = fixture(), hooks = new Map(), store = new Map();
  let sessionId = "captured", captures = 0;
  const load = () => {
    hooks.clear();
    register((name, matcher, hook) => {
      const handler = typeof matcher === "function" ? matcher : ($, e, next) =>
        Object.entries(matcher).every(([key, value]) => e[key] === value) ? hook($, e, next) : next(e);
      const previous = hooks.get(name);
      hooks.set(name, previous ? ($, e, next) => previous($, e, forwarded => handler($, forwarded, next)) : handler);
      return { catch() {} };
    });
  };
  const $ = { plugin: { root: path.dirname(path.dirname(script)) }, env: { get: async name => f.env[name] },
    session: { id: async () => sessionId, cwd: async () => f.repo },
    store: { get: async key => store.get(key), set: async (key, value) => store.set(key, value), delete: async key => store.delete(key), keys: async () => [...store.keys()] },
    process: { run: async (argv, init) => {
      captures++;
      assert.doesNotMatch(init.stdin, /PRIVATE_CONTEXT|AUTO_MEMORY_SECRET/);
      const result = run(process.execPath, argv.slice(1), { cwd: f.repo, env: f.env, input: init.stdin });
      assert.equal(result.status, 0, result.stderr); return { exitCode: result.status };
    } } };
  const files = [
    { path: "/managed/CLAUDE.md", kind: "managed", content: "MANAGED_RULE" },
    { path: "/loaded/import.md", kind: "user", content: "LOADED_RULE", parent: "/loaded/CLAUDE.md" },
    { path: "/loaded/MEMORY.md", kind: "memory", content: "AUTO_MEMORY_SECRET" }
  ];
  const event = { blocks: [{ name: "other", text: "PRIVATE_CONTEXT" }], instructionFiles: files }, before = structuredClone(event);
  const observe = (input, next = async forwarded => forwarded) => hooks.get("prompt.context")($, input, next);
  load();
  assert.equal(await observe(event), event); assert.deepEqual(event, before);
  const saved = readClaudeSnapshot(sessionId, f.env), file = claudeSnapshotFile(sessionId, f.env);
  assert.equal(saved.complete, true);
  assert.deepEqual(saved.entries, instructionInventory(files).entries);
  assert.doesNotMatch(fs.readFileSync(file, "utf8"), /PRIVATE_CONTEXT|AUTO_MEMORY_SECRET/);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  const capped = renderClaudeInstructions({ ...saved, entries: [saved.entries[0], { ...saved.entries[1], text: "x".repeat(INSTRUCTION_LIMIT) }] });
  assert.ok(capped.developerInstructions.length <= INSTRUCTION_LIMIT);
  assert.deepEqual(capped.omittedPaths, [saved.entries[1].path]);
  await hooks.get("classic.SubagentStart")($, { agent_type: "fugato:codex-native" }, async forwarded => forwarded);
  load(); await observe({ ...event, instructionFiles: [] });
  assert.deepEqual(readClaudeSnapshot(sessionId, f.env), saved);
  assert.equal(captures, 1);
  assert.deepEqual(writeClaudeSnapshot({ sessionId, cwd: f.repo, ...instructionInventory([]) }, f.env), saved);

  // A complete empty downstream inventory is authoritative; incomplete and
  // bounded inventories must never restore files filtered out of the context.
  for (const [name, result, source] of [
    ["filtered", { blocks: [], instructionFiles: [] }, "capture"],
    ["incomplete", { blocks: [] }, "scan"],
    ["bounded", { blocks: [], instructionFiles: [{ path: "/large/CLAUDE.md", kind: "user", content: "x".repeat(1000001) }] }, "capture"]
  ]) {
    sessionId = name;
    await observe(name === "incomplete" ? result : event, async () => result);
    const snapshot = readClaudeSnapshot(sessionId, f.env);
    load(); await observe(event);
    assert.deepEqual(readClaudeSnapshot(sessionId, f.env), snapshot);
    const prepared = prepareClaudeInstructions({ sessionId, cwd: f.repo }, f.env);
    assert.equal(prepared.claudeMd.source, source);
    assert.equal(prepared.claudeMd.approximate, source === "scan");
    assert.doesNotMatch(prepared.developerInstructions, /LOADED_RULE/);
    if (name === "bounded") assert.equal(prepared.claudeMd.bounded, true);
  }
  for (const session_id of ["captured", "filtered", "incomplete", "bounded"]) {
    await hooks.get("classic.SessionEnd")($, { session_id, hook_event_name: "SessionEnd" }, async forwarded => forwarded);
  }
  assert.equal(store.size, 0);
});

test("workers freeze instructions on cold resume; fallback confines imports and supports opt-out", () => {
  const f = fixture(); f.env.CODEX_COMPANION_SESSION_ID = "worker-session";
  f.env.CODEX_COMPANION_APP_SERVER_ENDPOINT = `unix:${path.join(f.dir, "absent.sock")}`;
  put(path.join(f.repo, "CLAUDE.md"), "CAPTURED_PROJECT_RULE");
  const files = [{ path: "/loaded/CLAUDE.md", kind: "user", content: "CAPTURED_RULE" },
    { path: path.join(f.repo, "CLAUDE.md"), kind: "project", content: "CAPTURED_PROJECT_RULE" }];
  const capture = () => writeClaudeSnapshot({ sessionId: f.env.CODEX_COMPANION_SESSION_ID, cwd: f.repo, ...instructionInventory(files) }, f.env);
  const snapshot = capture(), first = f.call("task", "--json", "--fresh", "Assignment brief.");
  const initial = f.state(), text = initial.lastThreadStart.developerInstructions;
  assert.ok(text.includes("CAPTURED_RULE")); assert.equal(initial.lastTurnStart.prompt, "Assignment brief.");
  assert.deepEqual(initial.lastThreadStart.config.project_doc_fallback_filenames, []);
  const stored = f.call("status", first.jobId, "--json").job;
  assert.equal(stored.request.developerInstructions, text);
  assert.equal(stored.request.claudeMd.snapshotHash, snapshot.hash);
  files[0].content = "CHANGED_RULE";
  assert.deepEqual(capture(), snapshot);
  f.env.CODEX_COMPANION_SESSION_ID = "next-session"; capture();
  const resumed = f.call("task", "--thread", first.threadId, "--json", "Follow-up brief.");
  const cold = f.state();
  assert.ok(cold.appServerStarts > initial.appServerStarts);
  assert.equal(cold.lastThreadResume.threadId, first.threadId);
  assert.equal(cold.lastThreadResume.developerInstructions, text);
  assert.deepEqual(cold.lastThreadResume.config.project_doc_fallback_filenames, []);
  assert.ok(cold.lastThreadResume.config.mcp_servers);
  assert.equal(f.call("result", resumed.jobId, "--details").claudeMd.snapshotChanged, true);

  fs.unlinkSync(claudeSnapshotFile(f.env.CODEX_COMPANION_SESSION_ID, f.env));
  const config = path.join(f.dir, "profile"), memory = path.join(config, "projects", "p", "memory");
  f.env.CLAUDE_CONFIG_DIR = config;
  put(path.join(memory, "MEMORY.md"), "EXCLUDED_MEMORY");
  fs.symlinkSync(memory, path.join(config, "memory-alias"));
  put(path.join(config, "CLAUDE.md"), "USER_RULE\n@inside.md\n@memory-alias/MEMORY.md");
  put(path.join(config, "inside.md"), "SAFE_IMPORT");
  put(path.join(f.repo, "CLAUDE.md"), "PROJECT_RULE\n@escape.txt\n@../outside.txt");
  put(path.join(f.dir, "outside.txt"), "EXCLUDED_OUTSIDE");
  fs.symlinkSync(path.join(f.dir, "outside.txt"), path.join(f.repo, "escape.txt"));
  const outsideRules = path.join(f.dir, "outside-rules"); put(path.join(outsideRules, "rule.md"), "EXCLUDED_RULE");
  fs.mkdirSync(path.join(f.repo, ".claude")); fs.symlinkSync(outsideRules, path.join(f.repo, ".claude", "rules"));
  const fallback = f.call("task", "--fresh", "--json", "Fallback brief.");
  const scanned = f.state().lastThreadStart.developerInstructions;
  for (const rule of ["USER_RULE", "SAFE_IMPORT", "PROJECT_RULE"]) assert.ok(scanned.includes(rule));
  assert.doesNotMatch(scanned, /EXCLUDED_/);
  assert.equal(f.call("result", fallback.jobId, "--details").claudeMd.approximate, true);
  assert.deepEqual(f.state().lastThreadStart.config.project_doc_fallback_filenames, []);
  const source = path.join(config, "projects", "p", "session.jsonl"); put(source, '{"type":"user"}\n');
  const linked = path.join(config, "projects", "escape.jsonl"); fs.symlinkSync(path.join(f.dir, "outside.txt"), linked);
  assert.throws(() => resolveClaudeSessionPath(f.repo, { source: linked }, f.env));
  const staged = snapshotClaudeSession(f.repo, source, f.env);
  assert.equal(fs.readFileSync(staged.snapshotPath, "utf8"), fs.readFileSync(source, "utf8"));
  staged.cleanup(); assert.equal(fs.existsSync(staged.snapshotPath), false);

  const sessionProject = path.join(f.dir, "session-project"); put(path.join(sessionProject, "CLAUDE.md"), "SESSION_PROJECT_RULE");
  const prepared = prepareClaudeInstructions({ cwd: f.repo, sessionCwd: sessionProject }, f.env);
  assert.ok(prepared.developerInstructions.includes("SESSION_PROJECT_RULE"));
  assert.doesNotMatch(prepared.developerInstructions, /PROJECT_RULE\n/);
  assert.throws(() => prepareClaudeInstructions({ cwd: f.repo }, { ...f.env, CODEX_COMPANION_SESSION_CWD: "relative" }));
  const denied = approveDuet({ hook_event_name: "PreToolUse", tool_name: "Bash", permission_mode: "default", session_id: "next-session",
    tool_use_id: "fixture-tool", cwd: f.repo, tool_input: { command: `'${duet}' task --session-cwd '${sessionProject}'` } }, f.env);
  assert.deepEqual(denied, {});
  f.call("task", "--fresh", "--session-cwd", sessionProject, "--json", "Different project brief.");
  assert.equal(f.state().lastThreadStart.config?.project_doc_fallback_filenames, undefined);
  put(path.join(f.repo, "CLAUDE.md"), "PROJECT_OVER_BUDGET\n" + "x".repeat(INSTRUCTION_LIMIT));
  f.call("task", "--fresh", "--json", "Bounded forwarding brief.");
  assert.doesNotMatch(f.state().lastThreadStart.developerInstructions, /PROJECT_OVER_BUDGET/);
  assert.equal(f.state().lastThreadStart.config?.project_doc_fallback_filenames, undefined);
  f.call("task", "--fresh", "--no-claude-md", "--json", "Opt-out brief.");
  assert.equal(f.state().lastThreadStart.developerInstructions, undefined);
  assert.equal(f.state().lastThreadStart.config?.project_doc_fallback_filenames, undefined);
  f.env.CODEX_COMPANION_CLAUDE_MD = "0";
  f.call("task", "--fresh", "--json", "Environment opt-out brief.");
  assert.equal(f.state().lastThreadStart.developerInstructions, undefined);
  assert.equal(f.state().lastThreadStart.config?.project_doc_fallback_filenames, undefined);
  assert.deepEqual(ensureProjectDocs({ env: f.env }).fallbackFilenames, ["CLAUDE.md"]);
});

test("fallback scan bounds content reads and reports eligible omitted rules", t => {
  const f = fixture(), config = path.join(f.dir, "profile"), rules = path.join(config, "rules");
  const ruleSize = 8192;
  for (let index = 0; index < 1024; index++) {
    put(path.join(rules, `${String(index).padStart(4, "0")}.md`),
      (index === 122 || index === 1023 ? "@omitted-import.txt\n" : "RULE\n").padEnd(ruleSize, "x"));
  }
  put(path.join(rules, "omitted-import.txt"), "UNFOLLOWED_IMPORT");
  put(path.join(rules, "zz-conditional.md"), `---\npaths: src/**\n# ${"x".repeat(ruleSize)}\n---\nCONDITIONAL_RULE`);
  fs.symlinkSync(path.join(rules, "0000.md"), path.join(rules, "zz-duplicate.md"));
  const readFile = fs.readFileSync, read = fs.readSync;
  let fullReads = 0, fullCharacters = 0, prefixBytes = 0;
  t.mock.method(fs, "readFileSync", function(file, ...args) {
    const content = readFile.call(this, file, ...args);
    if (String(file).startsWith(rules + path.sep)) { fullReads++; fullCharacters += content.length; }
    return content;
  });
  t.mock.method(fs, "readSync", function(fd, buffer, offset, length, position) {
    assert.ok(length <= 4096, "omitted rules only need a small frontmatter prefix");
    const count = read.call(this, fd, buffer, offset, length, position);
    prefixBytes += count;
    return count;
  });
  const scanned = scanClaudeInstructions(f.repo, { ...f.env, CLAUDE_CONFIG_DIR: config });
  assert.equal(fullReads, Math.ceil(1000000 / ruleSize));
  assert.ok(fullReads <= 256 && fullCharacters <= 1000000 + ruleSize);
  assert.equal(prefixBytes, (1024 - fullReads + 1) * 4096);
  assert.equal(scanned.bounded, true);
  assert.equal(scanned.entries.length + scanned.omittedCount, 1024);
  const omitted = Array.from({ length: 256 }, (_, index) =>
    path.join(fs.realpathSync(rules), `${String(scanned.entries.length + index).padStart(4, "0")}.md`));
  assert.deepEqual(scanned.omittedPaths, omitted);
  const rendered = renderClaudeInstructions(scanned);
  assert.ok(rendered.developerInstructions.includes("Omitted instruction files (budget):"));
  assert.doesNotMatch(rendered.developerInstructions, /CONDITIONAL_RULE|UNFOLLOWED_IMPORT/);
});
