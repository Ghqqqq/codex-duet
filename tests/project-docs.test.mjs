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
import { claudeSnapshotFile, readClaudeSnapshot, writeClaudeSnapshot, prepareClaudeInstructions, renderClaudeInstructions, EXECUTOR_FRAMING, INSTRUCTION_LIMIT } from "../plugins/codex/scripts/lib/claude-memory.mjs";

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

test("first prompt.context wins, preserves loaded instructions, and leaves incomplete sessions on approximate fallback", async () => {
  const f = fixture(); let sessionId = "captured-session";
  const hooks = new Map();
  const load = () => { hooks.clear(); register((name, matcher, hook) => {
    const handler = typeof matcher === "function" ? matcher : ($, e, next) =>
      Object.entries(matcher).every(([key, value]) => e[key] === value) ? hook($, e, next) : next(e);
    const previous = hooks.get(name);
    hooks.set(name, previous ? ($, e, next) => previous($, e, forwarded => handler($, forwarded, next)) : handler);
    return { catch() {} };
  }); };
  load();
  const observe = (...args) => hooks.get("prompt.context")(...args), start = (...args) => hooks.get("classic.SubagentStart")(...args);
  let captures = 0;
  const store = new Map();
  const files = [
    { path: "/managed/CLAUDE.md", kind: "managed", content: "Managed rules." },
    { path: "/loaded/CLAUDE.md", kind: "user", content: "Loaded user rules, not re-read from disk." },
    { path: "/loaded/import.md", kind: "user", content: "Imported identity.\n" + "用户规则".repeat(15000), parent: "/loaded/CLAUDE.md" },
    { path: "/loaded/MEMORY.md", kind: "memory", content: "AUTO_MEMORY_SECRET" },
    { path: "/project/CLAUDE.md", kind: "project", content: "Project testing standard." }
  ];
  const event = { blocks: [{ name: "claudeMd", text: "Rendered instruction block including AUTO_MEMORY_SECRET" }, { name: "other", text: "PRIVATE_CONTEXT" }], instructionFiles: files };
  const before = structuredClone(event);
  const $ = { plugin: { root: path.dirname(path.dirname(script)) }, env: { get: async name => f.env[name] },
    session: { id: async () => sessionId, cwd: async () => f.repo },
    store: { get: async key => store.get(key), set: async (key, value) => store.set(key, value), delete: async key => store.delete(key), keys: async () => [...store.keys()] },
    process: { run: async (argv, init) => {
      captures++;
      assert.doesNotMatch(init.stdin, /AUTO_MEMORY_SECRET|PRIVATE_CONTEXT/);
      const result = run(process.execPath, argv.slice(1), { cwd: f.repo, env: f.env, input: init.stdin });
      assert.equal(result.status, 0, result.stderr); return { exitCode: result.status };
    } } };
  assert.equal(await observe($, event, async forwarded => { assert.equal(forwarded, event); return event; }), event);
  assert.deepEqual(event, before);
  const saved = readClaudeSnapshot(sessionId, f.env);
  assert.equal(saved.complete, true);
  assert.deepEqual(saved.entries, files.filter(file => file.kind !== "memory").map(file => ({ path: file.path, tier: file.kind, text: file.content, importer: file.parent ?? null })));
  const file = claudeSnapshotFile(sessionId, f.env);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.doesNotMatch(fs.readFileSync(file, "utf8"), /AUTO_MEMORY_SECRET|PRIVATE_CONTEXT/);
  const capped = renderClaudeInstructions({ ...saved, entries: [saved.entries[0], { ...saved.entries[1], text: "x".repeat(INSTRUCTION_LIMIT) }, ...saved.entries.slice(2)] });
  assert.ok(capped.developerInstructions.length <= INSTRUCTION_LIMIT);
  assert.ok(capped.developerInstructions.includes(saved.entries[0].text));
  assert.ok(!capped.developerInstructions.includes("xxx"));
  assert.deepEqual(capped.omittedPaths, saved.entries.slice(1).map(entry => entry.path));
  for (const [input, output] of [[{ blocks: event.blocks }, { blocks: event.blocks }], [event, { blocks: [{ name: "claudeMd", text: "Rewritten" }] }]]) {
    assert.equal(await observe($, input, async forwarded => { assert.equal(forwarded, input); return output; }), output);
    assert.deepEqual(readClaudeSnapshot(sessionId, f.env), saved, "incomplete context cannot replace the loaded hierarchy");
  }
  // Later contexts have no reliable agent attribution: every shape is ignored,
  // with or without a SubagentStart, including equal/higher-tier inventories.
  const later = [[], files.filter(file => file.kind === "project"), files.filter(file => !file.parent),
    files.map(file => ({ ...file, content: `${file.content}\nReloaded.` })),
    [...files, { path: "/local/CLAUDE.local.md", kind: "local", content: "Later local rules." }]];
  for (const agent_type of [null, "Explore", "Plan", "codex:codex-native"]) {
    if (agent_type) {
      const started = { hook_event_name: "SubagentStart", session_id: sessionId, agent_id: `subagent-${agent_type}`, agent_type };
      assert.equal(await start($, started, async forwarded => forwarded), started);
    }
    for (const instructionFiles of later) {
      const context = { blocks: [], instructionFiles };
      assert.equal(await observe($, context, async forwarded => forwarded), context);
      assert.deepEqual(readClaudeSnapshot(sessionId, f.env), saved);
      assert.deepEqual(writeClaudeSnapshot({ sessionId, cwd: f.repo, ...instructionInventory(instructionFiles) }, f.env), saved,
        "the host writer also refuses replacement");
    }
  }
  load();
  await observe($, event, async forwarded => forwarded);
  assert.equal(captures, 1, "only the first context reaches the capture helper, including after hook reload");

  const edited = { ...event, instructionFiles: [{ path: "/new/CLAUDE.md", kind: "user", content: "Next session rules." }] };
  sessionId = "next-session";
  // Claim the first context before downstream work can enter another one.
  await observe($, edited, async forwarded => { await observe($, event, async other => other); return forwarded; });
  assert.deepEqual(readClaudeSnapshot(sessionId, f.env).entries, instructionInventory(edited.instructionFiles).entries);
  for (const [index, incomplete] of [{ blocks: event.blocks }, { ...event, instructionFiles: [
    { path: "/unreadable/CLAUDE.md", kind: "user", content: undefined }
  ] }].entries()) {
    sessionId = `incomplete-session-${index}`;
    await observe($, incomplete, async forwarded => forwarded);
    load();
    await observe($, event, async forwarded => forwarded);
    assert.equal(readClaudeSnapshot(sessionId, f.env), null);
    assert.equal(fs.existsSync(claudeSnapshotFile(sessionId, f.env)), false);
    const fallback = prepareClaudeInstructions({ sessionId, cwd: f.repo }, f.env);
    assert.equal(fallback.claudeMd.approximate, true);
    assert.equal(fallback.claudeMd.source, "scan");
  }
  assert.equal(captures, 4, "one attempt per session even when the first capture is incomplete");
  const removed = { path: path.join(f.repo, "CLAUDE.md"), kind: "project", content: "FILTERED_FROM_CONTEXT" };
  fs.writeFileSync(removed.path, removed.content);
  const input = { blocks: [{ name: "claudeMd", text: "Loaded instructions" }], instructionFiles: [files[0], removed] };
  const filteredSessions = [];
  for (const [index, instructionFiles] of [[files[0]], []].entries()) {
    sessionId = `filtered-session-${index}`; filteredSessions.push(sessionId);
    const filtered = { blocks: instructionFiles.length ? [{ name: "claudeMd", text: files[0].content }] : [], instructionFiles };
    assert.equal(await observe($, input, async () => filtered), filtered);
    const snapshot = readClaudeSnapshot(sessionId, f.env);
    assert.equal(snapshot.complete, true);
    assert.deepEqual(snapshot.entries, instructionInventory(instructionFiles).entries);
    load();
    await observe($, input, async forwarded => forwarded);
    assert.deepEqual(readClaudeSnapshot(sessionId, f.env), snapshot, "a reload cannot restore filtered files");
    const prepared = prepareClaudeInstructions({ sessionId, cwd: f.repo }, f.env);
    assert.equal(prepared.claudeMd.source, "capture");
    assert.equal(prepared.claudeMd.approximate, false);
    assert.equal(prepared.developerInstructions.includes(removed.content), false);
    assert.equal(prepared.developerInstructions.includes(files[0].content), instructionFiles.length > 0);
  }
  for (const [index, result] of [{ blocks: [] }, { blocks: [], instructionFiles: [{ ...removed, content: undefined }] }].entries()) {
    sessionId = `rewritten-incomplete-${index}`; filteredSessions.push(sessionId);
    await observe($, input, async () => result);
    assert.equal(readClaudeSnapshot(sessionId, f.env), null, "rewritten text without an inventory and unreadable content remain incomplete");
    assert.equal(prepareClaudeInstructions({ sessionId, cwd: f.repo }, f.env).claudeMd.source, "scan");
  }
  assert.equal(captures, 8);
  for (const [index, instructionFiles] of [
    Array.from({ length: 257 }, (_, i) => ({ path: `/virtual/${i}.md`, kind: "project", content: `Allowed ${i}` })),
    [{ path: "/oversized/CLAUDE.md", kind: "user", content: "x".repeat(1000001) }],
    [{ path: `/${"long/".repeat(1000)}CLAUDE.md`, kind: "project", content: "Long virtual path" }]
  ].entries()) {
    sessionId = `bounded-session-${index}`; filteredSessions.push(sessionId);
    await observe($, { ...input, instructionFiles: [...instructionFiles, removed] }, async () => ({ blocks: [], instructionFiles }));
    const snapshot = readClaudeSnapshot(sessionId, f.env);
    assert.equal(snapshot.inventoryAvailable, true);
    assert.equal(snapshot.complete, false);
    assert.equal(snapshot.bounded, true);
    assert.equal(snapshot.entries.length, index === 0 ? 256 : 0);
    assert.equal(snapshot.omittedCount, 1);
    assert.deepEqual(snapshot.omittedPaths, index === 2 ? [] : [instructionFiles.at(-1).path]);
    load(); await observe($, input, async forwarded => forwarded);
    assert.deepEqual(readClaudeSnapshot(sessionId, f.env), snapshot);
    const prepared = prepareClaudeInstructions({ sessionId, cwd: f.repo }, f.env);
    assert.equal(prepared.claudeMd.source, "capture");
    assert.equal(prepared.claudeMd.approximate, false);
    assert.equal(prepared.claudeMd.bounded, true);
    assert.equal(prepared.claudeMd.omittedCount, 1);
    assert.equal(prepared.developerInstructions.includes(removed.content), false);
  }
  // Both logical memory paths and aliases resolving into real memory paths
  // are excluded, including when .claude itself is a directory symlink.
  for (const linkedConfig of [false, true]) {
    const home = path.join(f.dir, `scan-home-${linkedConfig}`), config = path.join(home, ".claude");
    fs.mkdirSync(home);
    if (linkedConfig) {
      const target = path.join(home, "config-target"); fs.mkdirSync(target); fs.symlinkSync(target, config);
    } else fs.mkdirSync(config);
    for (const name of ["projects/p/memory", "agent-memory/reviewer", "agent-memory-local/reviewer"]) {
      const storage = path.join(config, name.replaceAll("/", "-"));
      fs.mkdirSync(storage); fs.writeFileSync(path.join(storage, "MEMORY.md"), "EXCLUDED_AUTO_MEMORY");
      fs.mkdirSync(path.dirname(path.join(config, name)), { recursive: true });
      fs.symlinkSync(storage, path.join(config, name));
      const alias = name.replaceAll("/", "-") + "-alias.md";
      fs.symlinkSync(path.join(config, name, "MEMORY.md"), path.join(config, alias));
    }
    const realMemory = path.join(config, "projects/real/memory"); fs.mkdirSync(realMemory, { recursive: true });
    fs.writeFileSync(path.join(realMemory, "MEMORY.md"), "EXCLUDED_AUTO_MEMORY");
    fs.symlinkSync(realMemory, path.join(config, "alias"));
    fs.writeFileSync(path.join(config, "CLAUDE.md"), "USER_SCAN_RULE\n@inside.md\n@projects/p/memory/MEMORY.md\n@agent-memory/reviewer/MEMORY.md\n@agent-memory-local/reviewer/MEMORY.md\n@alias/MEMORY.md");
    fs.appendFileSync(path.join(config, "CLAUDE.md"), "\n@projects-p-memory-alias.md\n@agent-memory-reviewer-alias.md\n@agent-memory-local-reviewer-alias.md");
    fs.writeFileSync(path.join(config, "inside.md"), "SAFE_IMPORT");
    const prepared = prepareClaudeInstructions({ sessionId: `scan-links-${linkedConfig}`, cwd: f.repo }, { ...f.env, HOME: home });
    assert.equal(prepared.claudeMd.source, "scan");
    assert.match(prepared.developerInstructions, /USER_SCAN_RULE/);
    assert.match(prepared.developerInstructions, /SAFE_IMPORT/);
    assert.doesNotMatch(prepared.developerInstructions, /EXCLUDED_AUTO_MEMORY/);
  }
  for (const session_id of ["captured-session", "next-session", "incomplete-session-0", "incomplete-session-1", ...filteredSessions]) {
    const ended = { session_id, hook_event_name: "SessionEnd" };
    assert.equal(await hooks.get("classic.SessionEnd")($, ended, async forwarded => forwarded), ended);
  }
  assert.equal(store.size, 0, "SessionEnd cleans first-context markers");
});

test("workers send captured instructions separately, freeze them on cold resume, and expose approximate fallback and opt-out", t => {
  const f = fixture(), transcript = []; let sessionId = "worker-instruction-session";
  f.env.CODEX_COMPANION_SESSION_ID = sessionId;
  const sessionProject = path.join(f.dir, "session project"), envProject = path.join(f.dir, "env-project");
  fs.mkdirSync(sessionProject); fs.mkdirSync(envProject);
  fs.writeFileSync(path.join(sessionProject, "CLAUDE.md"), "SESSION_PROJECT_RULE");
  fs.mkdirSync(path.join(sessionProject, ".claude", "rules"), { recursive: true });
  fs.writeFileSync(path.join(sessionProject, ".claude", "rules", "always.md"), "SESSION_PROJECT_UNCONDITIONAL_RULE");
  fs.writeFileSync(path.join(envProject, "CLAUDE.md"), "ENV_PROJECT_RULE");
  f.env.CODEX_COMPANION_SESSION_CWD = envProject;
  // An absent endpoint forces a private server each invocation: a genuine
  // cold resume of the fixture's persisted thread, not a running-thread rejoin.
  f.env.CODEX_COMPANION_APP_SERVER_ENDPOINT = `unix:${path.join(f.dir, "absent.sock")}`;
  const files = [
    { path: "/captured/global/CLAUDE.md", kind: "user", content: "GLOBAL_RULE_SENTINEL" },
    { path: "/captured/global/import.md", kind: "user", content: "IMPORT_RULE_SENTINEL", parent: "/captured/global/CLAUDE.md" },
    { path: "/captured/project/CLAUDE.md", kind: "project", content: "PROJECT_RULE_SENTINEL" }
  ];
  const capture = () => writeClaudeSnapshot({ sessionId, cwd: f.repo, ...instructionInventory(files) }, f.env);
  const snapshot = capture();
  const state = () => JSON.parse(fs.readFileSync(path.join(f.dir, "fake-codex-state.json"), "utf8"));
  const record = label => { const saved = state(); transcript.push({ label, appServerStarts: saved.appServerStarts, threadStart: saved.lastThreadStart, threadResume: saved.lastThreadResume, turnStart: saved.lastTurnStart }); return saved; };
  const first = f.json(f.call("task", "--json", "--fresh", "--session-cwd", sessionProject, "The assignment brief stays unchanged."));
  const started = record("captured start"), text = started.lastThreadStart.developerInstructions;
  assert.equal(text, EXECUTOR_FRAMING + files.map(file => `\n\n### ${file.path}\n${file.content}`).join(""));
  assert.equal(started.lastTurnStart.prompt, "The assignment brief stays unchanged.");
  const stored = f.json(f.call("status", first.jobId, "--json")).job;
  assert.equal(stored.request.developerInstructions, text);
  assert.equal(stored.request.claudeMd.snapshotHash, snapshot.hash);
  assert.equal(stored.request.claudeMd.sessionCwd, f.repo, "a captured inventory ignores flag and environment scan roots");
  assert.equal(stored.request.claudeMd.sessionCwdSource, "capture");
  assert.match(stored.request.claudeMd.renderedHash, /^[a-f0-9]{64}$/);
  files[0].content = "CHANGED_RULE_SENTINEL";
  assert.deepEqual(capture(), snapshot, "edits do not refresh this session");
  sessionId = "worker-instruction-next-session"; f.env.CODEX_COMPANION_SESSION_ID = sessionId;
  const changed = capture();
  const duet = path.join(path.dirname(path.dirname(script)), "bin", "duet");
  const resumed = f.json(run(process.execPath, [duet, "task", "--thread", first.threadId, "--quiet"], { cwd: f.repo, env: f.env, input: "Follow-up brief." }));
  const cold = record("cold resume in next session after changed instructions");
  assert.ok(cold.appServerStarts > started.appServerStarts);
  assert.equal(cold.lastThreadResume.threadId, first.threadId);
  assert.equal(cold.lastThreadResume.developerInstructions, text);
  const workerContract = fs.readFileSync(new URL("../plugins/codex/prompts/worker-task.md", import.meta.url), "utf8").trim();
  assert.equal(cold.lastTurnStart.prompt, `Follow-up brief.\n\n${workerContract}`);
  assert.equal(f.json(f.call("status", resumed.jobId, "--json")).job.request.prompt, "Follow-up brief.");
  const details = f.json(f.call("result", resumed.jobId, "--details"));
  assert.equal(details.claudeMd.snapshotChanged, true);
  assert.equal(details.claudeMd.observedSnapshotHash, changed.hash);
  assert.equal(details.claudeMd.renderedHash, stored.request.claudeMd.renderedHash);
  assert.equal(Object.hasOwn(f.json(f.call("result", resumed.jobId)), "claudeMd"), false);

  fs.unlinkSync(claudeSnapshotFile(sessionId, f.env));
  delete f.env.CODEX_COMPANION_SESSION_CWD;
  const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  put(path.join(f.env.HOME, ".claude", "CLAUDE.md"), "FALLBACK_USER\n@inside.md\n@../outside.md");
  put(path.join(f.env.HOME, ".claude", "inside.md"), "FALLBACK_IMPORT");
  put(path.join(f.env.HOME, "outside.md"), "EXTERNAL_IMPORT_EXCLUDED");
  put(path.join(f.env.HOME, ".claude", "rules", "nested", "global.md"), "FALLBACK_USER_RULE");
  put(path.join(f.dir, "CLAUDE.md"), "FALLBACK_ANCESTOR");
  put(path.join(f.repo, "CLAUDE.md"), "FALLBACK_PROJECT");
  put(path.join(f.repo, ".claude", "CLAUDE.md"), "FALLBACK_DOT_PROJECT");
  put(path.join(f.repo, ".claude", "rules", "always.md"), "FALLBACK_RULE");
  put(path.join(f.repo, ".claude", "rules", "scoped.md"), "---\npaths: ['src/**']\n---\nPATH_RULE_EXCLUDED");
  put(path.join(f.repo, "CLAUDE.local.md"), "FALLBACK_LOCAL");
  // Launch outside the worker repository so the final fallback is --cwd,
  // independent of the companion process's current directory.
  const fallback = f.json(run(process.execPath, [script, "task", "--json", "--fresh", "--cwd", f.repo, "Fallback brief."], { cwd: f.dir, env: f.env }));
  const scanned = record("approximate fallback").lastThreadStart.developerInstructions;
  let position = -1;
  for (const rule of ["FALLBACK_USER", "FALLBACK_IMPORT", "FALLBACK_USER_RULE", "FALLBACK_ANCESTOR", "FALLBACK_PROJECT", "FALLBACK_DOT_PROJECT", "FALLBACK_RULE", "FALLBACK_LOCAL"]) {
    const next = scanned.indexOf(rule); assert.ok(next > position, rule); position = next;
  }
  assert.doesNotMatch(scanned, /EXTERNAL_IMPORT_EXCLUDED|PATH_RULE_EXCLUDED/);
  transcript.at(-1).claudeMd = f.json(f.call("result", fallback.jobId, "--details")).claudeMd;
  assert.equal(transcript.at(-1).claudeMd.approximate, true);
  assert.equal(transcript.at(-1).claudeMd.sessionCwd, f.repo);
  assert.equal(transcript.at(-1).claudeMd.sessionCwdSource, "cwd");

  f.env.CODEX_COMPANION_SESSION_CWD = envProject;
  const flagged = f.json(run(process.execPath, [duet, "task", "--fresh", "--cwd", f.repo, "--session-cwd", sessionProject, "--quiet"],
    { cwd: f.dir, env: f.env, input: "Session project brief." }));
  const flaggedState = record("approximate fallback from --session-cwd overriding environment");
  assert.equal(flaggedState.lastThreadStart.cwd, f.repo);
  assert.match(flaggedState.lastThreadStart.developerInstructions, /SESSION_PROJECT_RULE/);
  assert.match(flaggedState.lastThreadStart.developerInstructions, /SESSION_PROJECT_UNCONDITIONAL_RULE/);
  assert.doesNotMatch(flaggedState.lastThreadStart.developerInstructions, /ENV_PROJECT_RULE|FALLBACK_PROJECT|FALLBACK_DOT_PROJECT|FALLBACK_RULE|FALLBACK_LOCAL/);
  transcript.at(-1).claudeMd = f.json(f.call("result", flagged.jobId, "--details")).claudeMd;
  assert.equal(transcript.at(-1).claudeMd.source, "scan");
  assert.equal(transcript.at(-1).claudeMd.approximate, true);
  assert.equal(transcript.at(-1).claudeMd.sessionCwd, sessionProject);
  assert.equal(transcript.at(-1).claudeMd.sessionCwdSource, "flag");

  const fromEnv = f.json(run(process.execPath, [script, "task", "--json", "--fresh", "--cwd", f.repo, "Environment project brief."], { cwd: f.dir, env: f.env }));
  const envState = record("approximate fallback from CODEX_COMPANION_SESSION_CWD");
  assert.equal(envState.lastThreadStart.cwd, f.repo);
  assert.match(envState.lastThreadStart.developerInstructions, /ENV_PROJECT_RULE/);
  assert.doesNotMatch(envState.lastThreadStart.developerInstructions, /SESSION_PROJECT_RULE|SESSION_PROJECT_UNCONDITIONAL_RULE|FALLBACK_PROJECT|FALLBACK_DOT_PROJECT|FALLBACK_RULE|FALLBACK_LOCAL/);
  transcript.at(-1).claudeMd = f.json(f.call("result", fromEnv.jobId, "--details")).claudeMd;
  assert.equal(transcript.at(-1).claudeMd.source, "scan");
  assert.equal(transcript.at(-1).claudeMd.approximate, true);
  assert.equal(transcript.at(-1).claudeMd.sessionCwd, envProject);
  assert.equal(transcript.at(-1).claudeMd.sessionCwdSource, "env");

  for (const invalid of ["", "relative", path.join(f.dir, "missing"), path.join(sessionProject, "CLAUDE.md")]) {
    const rejected = f.call("task", "--json", "--fresh", "--session-cwd", invalid, "Invalid root.");
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /--session-cwd requires an absolute existing directory/);
  }
  const missing = f.call("task", "--session-cwd");
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /Missing value for --session-cwd/);
  assert.equal(state().appServerStarts, envState.appServerStarts, "invalid roots never dispatch a worker");
  assert.throws(() => prepareClaudeInstructions({ cwd: f.repo }, { ...f.env, CODEX_COMPANION_SESSION_CWD: "relative" }), /CODEX_COMPANION_SESSION_CWD requires an absolute existing directory/);
  const help = f.call("task", "--help");
  assert.equal(help.status, 0, help.stderr);
  assert.doesNotMatch(help.stdout, /--session-cwd/);

  const permissionTranscript = [];
  for (const suffix of ["", ` --session-cwd '${sessionProject}'`, ` --session-cwd=${envProject}`]) {
    const command = `'${duet}' task --fresh${suffix}`;
    const result = approveDuet({ hook_event_name: "PreToolUse", tool_name: "Bash", permission_mode: "default", session_id: sessionId,
      tool_use_id: "fixture-tool", cwd: f.repo, tool_input: { command } }, f.env);
    if (suffix) assert.deepEqual(result, {}, "internal session roots are not auto-approved from user commands");
    else assert.equal(result.hookSpecificOutput.permissionDecision, "allow");
    permissionTranscript.push({ command, output: result });
  }
  const optedOut = run(process.execPath, [duet, "task", "--fresh", "--no-claude-md", "--quiet"], { cwd: f.repo, env: f.env, input: "Opt-out brief." });
  assert.equal(optedOut.status, 0, optedOut.stderr + optedOut.stdout);
  assert.equal(record("CLI opt-out without capture").lastThreadStart.developerInstructions, undefined);
  capture(); f.env.CODEX_COMPANION_CLAUDE_MD = "0";
  f.json(f.call("task", "--fresh", "--json", "Environment opt-out brief."));
  assert.equal(record("environment opt-out with capture").lastThreadStart.developerInstructions, undefined);
  const evidence = path.join(f.dir, "claude-memory-transcript.json");
  fs.writeFileSync(evidence, JSON.stringify({ transcript, permissionTranscript, originalMetadata: stored.request.claudeMd, resumedMetadata: details.claudeMd }, null, 2));
  t.diagnostic(`Synthetic RPC transcript: ${evidence}`);
});
