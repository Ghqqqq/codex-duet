import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDir, initGitRepo, run } from "./helpers.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { DEFAULT_DUEL_ROUNDS, DEFAULT_MAX_WORKERS, MODE_NAMES, PAIR_MAX_REWORK_ROUNDS, PROTOCOL_PATH, ULTRA_SCALES, clearMode, effectiveMaxWorkers, isModeCommandPrompt, protocolVersion, readMode, reminderText, setMode, modeFile } from "../plugins/codex/scripts/lib/ultra-codex-mode.mjs";
import { resolveStateDir } from "../plugins/codex/scripts/lib/state.mjs";
import { defaultModeSetup, readTomlField } from "../plugins/codex/scripts/lib/setup-config.mjs";

const script = new URL("../plugins/codex/scripts/codex-companion.mjs", import.meta.url).pathname;
const promptHook = new URL("../plugins/codex/scripts/ultra-codex-hook.mjs", import.meta.url).pathname;
const lifecycleHook = new URL("../plugins/codex/scripts/session-lifecycle-hook.mjs", import.meta.url).pathname;
const BUILTIN_MODELS = { model: "gpt-6-astra", effort: "xhigh", routineModel: "gpt-6.1-sol" };
const MODELS_LINE = "models: worker gpt-6-astra/xhigh, ultra routine gpt-6.1-sol\n";
const SESSION = "11111111-aaaa-4bbb-8ccc-000000000001";
const MODES = [
  { name: "ultra", verb: "ultra-codex", label: "Ultra-codex", heading: "Ultra mode", options: { scale: "auto", maxWorkers: "auto" }, flags: ["--thorough", "--max-workers", "4"], saved: { scale: "thorough", maxWorkers: 4 }, repeated: { scale: "auto", maxWorkers: 4 }, usage: "[on [--quick|--thorough] [--max-workers <n|auto|unlimited>] [<task>] | off | status | [--quick|--thorough] [--max-workers <n|auto|unlimited>] <task>]" },
  { name: "pair", verb: "pair", label: "Pair", heading: "Pair mode", options: {}, flags: [], saved: {}, repeated: {}, usage: "[on [<task>] | off | status | <task>]" },
  { name: "duel", verb: "duel", label: "Duel", heading: "Duel mode", options: { rounds: 3 }, flags: ["--rounds", "2"], saved: { rounds: 2 }, repeated: { rounds: 2 }, usage: "[on [--rounds <n>] [<task>] | off | status | [--rounds <n>] <task>]" }
];

function fixture() {
  const dir = makeTempDir(); installFakeCodex(dir);
  const repo = path.join(dir, "repo"); fs.mkdirSync(repo); initGitRepo(repo);
  const baseEnv = { ...buildEnv(dir), CODEX_COMPANION_HOME: path.join(dir, "isolated"), CLAUDE_PLUGIN_DATA: path.join(dir, "data") };
  const env = { ...baseEnv, CODEX_COMPANION_SESSION_ID: SESSION };
  // Inject CPU count into CLI/hook subprocesses without relying on the host.
  const cpuModule = path.join(dir, "cpu-count.mjs");
  fs.writeFileSync(cpuModule, 'import os from "node:os"; os.availableParallelism = () => Number(process.env.MODE_TEST_CPU_COUNT);\n');
  const callCpu = (cpuCount, ...args) => run(process.execPath, ["--import", cpuModule, script, ...args], { cwd: repo, env: { ...env, MODE_TEST_CPU_COUNT: String(cpuCount) } });
  const call = (...args) => run(process.execPath, [script, ...args], { cwd: repo, env });
  const json = result => { assert.equal(result.status, 0, result.stderr + result.stdout); return JSON.parse(result.stdout); };
  const prompt = (text, sessionId = SESSION, extra = {}) => run(process.execPath, [promptHook], { cwd: repo, env: baseEnv, input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: sessionId, cwd: repo, prompt: text, ...extra }) });
  const lifecycle = (event, input) => run(process.execPath, [lifecycleHook, event], { cwd: repo, env: baseEnv, input: JSON.stringify({ hook_event_name: event, cwd: repo, ...input }) });
  const promptCpu = (cpuCount, text) => run(process.execPath, ["--import", cpuModule, promptHook], { cwd: repo, env: { ...baseEnv, MODE_TEST_CPU_COUNT: String(cpuCount) }, input: JSON.stringify({ session_id: SESSION, cwd: repo, prompt: text }) });
  return { dir, repo, env, baseEnv, call, callCpu, json, prompt, promptCpu, lifecycle, modeFile: sessionId => modeFile(repo, sessionId, baseEnv) };
}

test("default-mode setup saves every choice, previews without writes, and reports the shared preference", () => {
  const f = fixture(), file = path.join(f.env.CODEX_COMPANION_HOME, "duet", "config.toml");
  assert.equal(defaultModeSetup({ env: f.env }).defaultMode, "off");
  const before = fs.readdirSync(f.dir, { recursive: true }).sort();
  for (const mode of ["off", ...MODE_NAMES]) {
    const preview = f.json(f.call("setup", "--default-mode", mode, "--dry-run", "--json"));
    assert.deepEqual(preview, { file, defaultMode: mode, changedFiles: [file], backups: [], dryRun: true });
    assert.deepEqual(fs.readdirSync(f.dir, { recursive: true }).sort(), before);
  }
  f.json(f.call("setup", "--default-sandbox", "read-only", "--json"));
  fs.appendFileSync(file, '# Keep this preference and comment.\n[custom]\nvalue = "untouched"\n');
  const original = fs.readFileSync(file, "utf8");
  for (const mode of [...MODE_NAMES, "off"]) {
    const bytes = fs.readFileSync(file, "utf8"), names = fs.readdirSync(path.dirname(file)).sort();
    assert.equal(f.json(f.call("setup", "--default-mode", mode, "--dry-run", "--json")).defaultMode, mode);
    assert.equal(fs.readFileSync(file, "utf8"), bytes);
    assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), names, "dry-run creates no backup or lock");
    const saved = f.json(f.call("setup", "--default-mode", mode));
    assert.equal(saved.defaultMode, mode);
    assert.deepEqual(saved.changedFiles, [file]);
    assert.equal(fs.readFileSync(saved.backups[0], "utf8"), bytes);
    assert.equal(fs.readFileSync(file, "utf8"), `"defaultMode" = "${mode}"\n${original}`);
    assert.equal(readTomlField(fs.readFileSync(file, "utf8"), ["defaultMode"]), mode);
    assert.deepEqual(f.json(f.call("setup", "--default-mode", mode, "--json")).changedFiles, [], "idempotent save");
    const status = f.json(f.call("setup", "--json"));
    assert.equal(status.defaultMode, mode);
    assert.equal(status.defaultSandbox, "read-only");
    const human = f.call("setup");
    assert.equal(human.status, 0, human.stderr);
    assert.ok(human.stdout.includes(`Default mode: ${mode}.\n`));
    const terminalEnv = { ...f.env, CLAUDE_PLUGIN_DATA: undefined };
    assert.equal(defaultModeSetup({ env: terminalEnv }).defaultMode, mode, "terminal and Claude use the same preference");
  }
});

test("default-mode rejects invalid values and combined setup changes before any write", () => {
  const f = fixture();
  const combinations = [
    ["--default-sandbox", "read-only"], ["--sync-tools"], ["--transport", "http"],
    ["--browser-approval", "ask"], ["--allow-browser-origin", "https://example.com"],
    ["--revoke-browser-origin", "https://example.com"], ["--list-browser-origins"],
    ["--computer-use-approval", "ask"], ["--allow-computer-app", "com.example.App"],
    ["--revoke-computer-app", "com.example.App"], ["--list-computer-apps"],
    ["--project-docs", "agents-only"], ["--enable-review-gate"], ["--disable-review-gate"],
    ["--sync-tools", "--profile", "chrome"], ["--sync-tools", "--replace-cua"],
    ["--sync-tools", "--cua-template", path.join(f.dir, "template")],
    ["--sync-tools", "--chatgpt-resources", f.dir]
  ];
  const snapshot = () => fs.readdirSync(f.dir, { recursive: true }).sort().map(name => {
    const file = path.join(f.dir, name);
    return [name, fs.statSync(file).isFile() ? fs.readFileSync(file).toString("base64") : null];
  });
  for (const existing of [false, true]) {
    if (existing) f.json(f.call("setup", "--default-mode", "pair", "--json"));
    const before = snapshot();
    for (const mode of ["invalid", "PAIR", "", "false", "ultra-codex"]) {
      const result = f.call("setup", "--default-mode", mode);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /--default-mode must be off, ultra, pair, or duel\./);
      assert.deepEqual(snapshot(), before);
    }
    assert.equal(f.call("setup", "--default-mode").status, 1);
    assert.deepEqual(snapshot(), before);
    for (const flags of combinations) {
      const result = f.call("setup", "--default-mode", "pair", ...flags);
      assert.equal(result.status, 1, flags.join(" "));
      assert.match(result.stderr, /Run --default-mode separately from other setup changes\./);
      assert.deepEqual(snapshot(), before, flags.join(" "));
    }
  }
});

for (const mode of MODES) {
  test(`saved ${mode.name} defaults initialize startup and clear with fresh options and normal reminders`, () => {
    const f = fixture();
    const setup = f.json(f.call("setup", "--default-mode", mode.name, "--json"));
    const preference = fs.readFileSync(setup.file, "utf8");
    const reference = setMode(f.repo, "reference-session", { name: mode.name }, f.env);
    for (const source of ["startup", "clear"]) {
      const stale = setMode(f.repo, SESSION, { name: mode.name, options: mode.saved }, f.env);
      const old = { schemaVersion: 2, sessionId: SESSION, name: mode.name, options: mode.saved, since: "2020-01-01T00:00:00.000Z" };
      fs.writeFileSync(stale.file, JSON.stringify(old));
      const start = Date.now(), result = f.lifecycle("SessionStart", { session_id: SESSION, source });
      assert.equal(result.status, 0, result.stderr);
      const record = JSON.parse(fs.readFileSync(stale.file, "utf8"));
      assert.deepEqual(record, { schemaVersion: 2, sessionId: SESSION, name: mode.name, options: reference.options, since: record.since });
      assert.ok(Date.parse(record.since) >= start && Date.parse(record.since) <= Date.now());
      assert.equal(fs.statSync(stale.file).mode & 0o777, 0o600);
      const reminder = f.prompt("substantive request");
      assert.equal(reminder.status, 0, reminder.stderr);
      assert.equal(reminder.stdout, `${reminderText(record)}\n`);
      assert.equal(fs.readFileSync(setup.file, "utf8"), preference);
    }
    assert.equal(f.lifecycle("SessionEnd", { session_id: SESSION }).status, 0);
    assert.equal(fs.existsSync(f.modeFile(SESSION)), false);
    assert.equal(fs.readFileSync(setup.file, "utf8"), preference);
  });
}

test("saved defaults leave resumed choices, per-session overrides, and unknown start sources unchanged", () => {
  const f = fixture(), setup = f.json(f.call("setup", "--default-mode", "pair", "--json"));
  const preference = fs.readFileSync(setup.file, "utf8");
  for (const source of ["resume", "compact"]) {
    for (const mode of MODES) {
      f.json(f.call(mode.verb, "on", ...mode.flags, "--json"));
      const bytes = fs.readFileSync(f.modeFile(SESSION), "utf8");
      assert.equal(f.lifecycle("SessionStart", { session_id: SESSION, source }).status, 0);
      assert.equal(fs.readFileSync(f.modeFile(SESSION), "utf8"), bytes);
      f.json(f.call(mode.verb, "off", "--json"));
      assert.equal(f.lifecycle("SessionStart", { session_id: SESSION, source }).status, 0);
      assert.equal(fs.existsSync(f.modeFile(SESSION)), false, `${source} must preserve off`);
      assert.equal(f.prompt("substantive request").stdout, "");
      assert.equal(fs.readFileSync(setup.file, "utf8"), preference);
    }
  }
  for (const source of [undefined, "unknown"]) {
    f.json(f.call("duel", "on", "--rounds", "1", "--json"));
    assert.equal(f.lifecycle("SessionStart", { session_id: SESSION, source }).status, 0);
    assert.equal(fs.existsSync(f.modeFile(SESSION)), false, "only startup and clear opt in");
  }
  for (const session_id of [undefined, "../invalid"]) {
    assert.equal(f.lifecycle("SessionStart", { session_id, source: "startup" }).status, 0);
    assert.equal(fs.existsSync(f.modeFile(SESSION)), false);
  }
  assert.equal(fs.readFileSync(setup.file, "utf8"), preference);
});

test("off and invalid defaults keep fresh-start output identical, clear state, and never emit reminders", () => {
  const f = fixture(), file = path.join(f.env.CODEX_COMPANION_HOME, "duet", "config.toml");
  const baseline = f.lifecycle("SessionStart", { session_id: SESSION, source: "startup" });
  assert.equal(baseline.status, 0, baseline.stderr);
  const offStatus = f.call("pair", "status").stdout;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'defaultMode = "off"\n' + '"x"'.repeat(28) + '\n');
  const start = performance.now();
  assert.equal(defaultModeSetup({ env: f.env }).defaultMode, "off");
  assert.ok(performance.now() - start < 1000, "malformed quoted keys must not stall SessionStart");
  for (const text of ['', 'defaultMode = "off"\n', 'defaultMode = "unknown"\n', 'defaultMode = true\n', 'defaultMode = 1\n', 'defaultMode = ["pair"]\n', 'defaultMode = { name = "pair" }\n', 'defaultMode = pair\n', 'defaultMode = "pair"\ndefaultMode = "ultra"\n']) {
    fs.writeFileSync(file, text);
    assert.equal(defaultModeSetup({ env: f.env }).defaultMode, "off");
    assert.equal(f.json(f.call("pair", "status", "--json")).defaultMode, "off");
    assert.equal(f.call("pair", "status").stdout, offStatus);
    for (const source of ["startup", "clear"]) {
      setMode(f.repo, SESSION, { name: "pair" }, f.env);
      const result = f.lifecycle("SessionStart", { session_id: SESSION, source });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, baseline.stdout);
      assert.equal(result.stderr, baseline.stderr);
      assert.equal(fs.existsSync(f.modeFile(SESSION)), false);
      assert.equal(f.prompt("substantive request").stdout, "");
      assert.equal(fs.readFileSync(file, "utf8"), text);
    }
  }
  fs.rmSync(file);
  fs.mkdirSync(file); // An unreadable preference must not break SessionStart.
  setMode(f.repo, SESSION, { name: "pair" }, f.env);
  const failedRead = f.lifecycle("SessionStart", { session_id: SESSION, source: "startup" });
  assert.equal(failedRead.status, 0, failedRead.stderr);
  assert.equal(failedRead.stdout, baseline.stdout);
  assert.equal(fs.existsSync(f.modeFile(SESSION)), false);
});

test("every mode status appends the saved default without changing existing output or session state", () => {
  const f = fixture();
  for (const active of [null, ...MODES]) {
    clearMode(f.repo, SESSION, f.env);
    if (active) setMode(f.repo, SESSION, { name: active.name, options: active.saved }, f.env);
    f.json(f.call("setup", "--default-mode", "off", "--json"));
    const baseline = MODES.map(mode => ({ text: f.call(mode.verb, "status").stdout, json: f.json(f.call(mode.verb, "status", "--json")) }));
    for (const name of MODE_NAMES) {
      f.json(f.call("setup", "--default-mode", name, "--json"));
      for (const [index, mode] of MODES.entries()) {
        assert.equal(f.call(mode.verb, "status").stdout, `${baseline[index].text}default mode: ${name} (duet setup --default-mode)\n`);
        assert.deepEqual(f.json(f.call(mode.verb, "status", "--json")), { ...baseline[index].json, defaultMode: name });
      }
    }
  }
  const noSession = f.json(run(process.execPath, [script, "pair", "status", "--json"], { cwd: f.repo, env: f.baseEnv }));
  assert.equal(noSession.sessionId, null);
  assert.equal(noSession.activeMode, null);
  assert.equal(noSession.defaultMode, "duel");
});

test("ultra-codex mode is a per-session switch: on/off/status, the prompt reminder, and session cleanup", () => {
  const f = fixture();
  const other = path.join(f.dir, "other"); fs.mkdirSync(other); initGitRepo(other);
  const legacy = (cwd, sessionId = SESSION) => {
    const file = path.join(resolveStateDir(cwd, f.env), "ultra-codex", `${sessionId}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ sessionId, scale: "quick", maxWorkers: 1 }));
    return file;
  };
  const oldModes = () => [legacy(f.repo), legacy(other)];
  const assertRemoved = files => files.forEach(file => assert.equal(fs.existsSync(file), false));
  const ignored = oldModes();
  // Off by default; status never needs the session id and the preamble points to the protocol.
  const off = f.json(f.call("ultra-codex", "status", "--json"));
  assert.deepEqual([off.mode, off.sessionId, off.protocolFile], ["off", SESSION, PROTOCOL_PATH]);
  assertRemoved(ignored);
  const forCommand = f.call("ultra-codex", "status", "--for-command");
  assert.equal(forCommand.status, 0, forCommand.stderr);
  assert.equal(run(process.execPath, [script, "ultra-codex", "status", "--json"], { cwd: f.repo, env: f.baseEnv }).status, 0, "status without a session id still answers");
  assert.equal(f.prompt("refactor the parser").stdout, "", "no reminder while the mode is off");
  // Validation happens before anything is written.
  for (const args of [["on", "--quick", "--thorough"], ["on", "--max-workers", "0"], ["on", "--max-workers", "many"], ["toggle"], ["on", "extra"], ["on", "--for-command"]]) {
    const rejected = f.call("ultra-codex", ...args, "--json");
    assert.notEqual(rejected.status, 0, args.join(" "));
    assert.equal(fs.existsSync(f.modeFile(SESSION)), false, args.join(" "));
  }
  const noSession = run(process.execPath, [script, "ultra-codex", "on", "--json"], { cwd: f.repo, env: f.baseEnv });
  assert.notEqual(noSession.status, 0);
  assert.match(noSession.stderr, /CODEX_COMPANION_SESSION_ID/);
  // On: file keyed by the session; reminder on ordinary prompts only.
  const on = f.json(f.call("ultra-codex", "on", "--thorough", "--max-workers", "4", "--json"));
  assert.deepEqual([on.mode, on.scale, on.maxWorkers], ["on", "thorough", 4]);
  assert.ok(fs.existsSync(f.modeFile(SESSION)));
  // cli-7: action-specific options are rejected without altering the mode.
  for (const action of ["off", "status"]) {
    for (const args of [["--quick"], ["--thorough=false"], ["--max-workers", "3"], ["--max-workers", "not-a-number"],
      ...(action === "off" ? [["--for-command"], ["--for-command=false"]] : [])]) {
      assert.equal(f.call("ultra-codex", action, ...args, "--json").status, 1);
      assert.deepEqual(f.json(f.call("ultra-codex", "status", "--json")), { ...on, defaultMode: "off", models: BUILTIN_MODELS });
    }
  }
  assert.equal(fs.statSync(f.modeFile(SESSION)).mode & 0o777, 0o600);
  assert.equal(modeFile(other, SESSION, f.env), f.modeFile(SESSION));
  const shared = f.json(f.call("ultra-codex", "status", "--cwd", other, "--json"));
  assert.deepEqual(shared, { ...on, defaultMode: "off", models: BUILTIN_MODELS });
  assert.ok(f.prompt("refactor in another workspace", SESSION, { cwd: other }).stdout.trim().length > 0);
  const reminder = f.prompt("refactor the parser so it streams");
  assert.equal(reminder.status, 0, reminder.stderr);
  assert.ok(reminder.stdout.trim().length > 0);
  const fromPrompt = oldModes();
  assert.equal(f.prompt("/codex:ultra-codex off", SESSION, { cwd: other }).stdout, "", "the command's own prompt gets no reminder");
  assertRemoved(fromPrompt);
  assert.equal(f.prompt("/ultra-codex status").stdout, "", "nor the user-level alias");
  assert.equal(f.prompt("refactor", "22222222-aaaa-4bbb-8ccc-000000000002").stdout, "", "another session in the same repository is unaffected");
  assert.equal(f.prompt("refactor", undefined, { session_id: undefined }).stdout, "", "no session id, no reminder");
  assert.equal(run(process.execPath, [promptHook], { cwd: f.repo, env: f.baseEnv, input: "not json" }).status, 0, "a broken hook input never blocks the prompt");
  // on again keeps `since` and the worker cap unless given; scale follows the flags.
  const fromOn = oldModes();
  const again = f.json(f.call("ultra-codex", "on", "--cwd", other, "--json"));
  assertRemoved(fromOn);
  assert.deepEqual([again.scale, again.maxWorkers, again.since], ["auto", 4, on.since]);
  // Resume and compact keep the mode; a fresh start or /clear for the same id drops it.
  for (const source of ["resume", "compact"]) {
    const fromStart = oldModes();
    assert.equal(f.lifecycle("SessionStart", { session_id: SESSION, source, cwd: other }).status, 0, source);
    assertRemoved(fromStart);
    assert.ok(fs.existsSync(f.modeFile(SESSION)), `${source} keeps the mode`);
  }
  assert.equal(f.lifecycle("SessionStart", { session_id: SESSION, source: "clear" }).status, 0);
  assert.equal(fs.existsSync(f.modeFile(SESSION)), false, "/clear starts without the mode");
  // Off: idempotent, reports what ran, and the reminder stops.
  f.json(f.call("ultra-codex", "on", "--json"));
  const fromOff = oldModes();
  const turnedOff = f.json(f.call("ultra-codex", "off", "--cwd", other, "--json"));
  assertRemoved(fromOff);
  assert.deepEqual([turnedOff.mode, turnedOff.wasOn, turnedOff.runningJobs], ["off", true, []]);
  assert.equal(fs.existsSync(f.modeFile(SESSION)), false);
  assert.equal(f.prompt("refactor the parser").stdout, "");
  const alreadyOff = f.call("ultra-codex", "off");
  assert.equal(alreadyOff.status, 0, alreadyOff.stderr);
  // SessionEnd clears a mode left on.
  f.json(f.call("ultra-codex", "on", "--json"));
  const fromEnd = oldModes(), foreign = legacy(other, "foreign-session");
  assert.equal(f.lifecycle("SessionEnd", { session_id: SESSION, cwd: other }).status, 0);
  assertRemoved(fromEnd);
  assert.ok(fs.existsSync(foreign), "another session's recent legacy record is left for retention");
  assert.equal(fs.existsSync(f.modeFile(SESSION)), false, "SessionEnd removes the mode");
  // A stale file from a session that never ended is pruned at the next start.
  const stale = setMode(f.repo, "33333333-aaaa-4bbb-8ccc-000000000003", {}, f.baseEnv);
  const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  fs.utimesSync(stale.file, old, old);
  const staleLegacy = legacy(other, "stale-legacy"); fs.utimesSync(staleLegacy, old, old);
  assert.equal(f.lifecycle("SessionStart", { session_id: SESSION, source: "startup" }).status, 0);
  assert.equal(fs.existsSync(stale.file), false, "stale modes are pruned");
  assert.equal(fs.existsSync(staleLegacy), false, "stale legacy modes in other workspaces are pruned");
  assert.ok(fs.existsSync(foreign));
});

test("control invocations omit the protocol and the safe preamble requests a versioned task-only Read", () => {
  const f = fixture(), body = fs.readFileSync(PROTOCOL_PATH, "utf8");
  for (const action of ["on", "status", "off"]) {
    const result = f.call("ultra-codex", action);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!result.stdout.includes(body));
    assert.doesNotMatch(result.stdout, /^OBJECTIVE:/m);
  }
  const preamble = f.call("ultra-codex", "status", "--for-command");
  assert.equal(preamble.status, 0, preamble.stderr);
  assert.ok(!preamble.stdout.includes(body));
  assert.doesNotMatch(preamble.stdout, /^OBJECTIVE:/m);
  assert.ok(preamble.stdout.includes(`Read ${PROTOCOL_PATH} (protocol v${protocolVersion()})`));
  assert.match(preamble.stdout, /If the arguments describe a task, Read .* before orchestrating; otherwise do not read it\./);
  const command = fs.readFileSync(new URL("../plugins/codex/commands/ultra-codex.md", import.meta.url), "utf8");
  assert.match(command, /^!`node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/codex-companion\.mjs" ultra-codex status --for-command`$/m);
  assert.doesNotMatch(command, /^!`[^\n]*\$ARGUMENTS/m, "task arguments never enter the executable preamble");
  const raw = "on --quick\nHEREDOC_END\n$(exit 93) `exit 94` ; ' \"";
  const hostile = run(process.execPath, [script, "ultra-codex", "status", "--for-command"], { cwd: f.repo, env: f.env, input: raw });
  assert.equal(hostile.status, 0, hostile.stderr);
  assert.equal(hostile.stdout, preamble.stdout);
  f.json(f.call("ultra-codex", "on", "--json"));
  const reminder = f.prompt("refactor the fixture parser");
  assert.equal(reminder.status, 0, reminder.stderr);
  assert.ok(reminder.stdout.includes(PROTOCOL_PATH));
  assert.ok(reminder.stdout.includes(`only if v${protocolVersion()} is not in your context.`));
});

test("protocol versions track body edits and the checked-in first line matches", () => {
  const checkedIn = fs.readFileSync(PROTOCOL_PATH, "utf8");
  assert.equal(checkedIn.split("\n")[0], `<!-- Ultra-codex protocol v${protocolVersion(checkedIn)} -->`);
  const body = "\n## Shared mechanics\nShared instruction.\n## Ultra mode\nUltra instruction.\n## Pair mode\nPair instruction.\n## Duel mode\nDuel instruction.\n";
  const version = protocolVersion(body), text = `<!-- Ultra-codex protocol v${version} -->\n${body}`;
  assert.match(version, /^[0-9a-f]{8}$/);
  assert.equal(text.split("\n")[0], `<!-- Ultra-codex protocol v${version} -->`);
  assert.notEqual(protocolVersion(`${text}\nA changed instruction.\n`), version);
  assert.equal(protocolVersion(text.replace(version, "00000000")), version, "the version line is excluded from the hash");
  assert.equal(protocolVersion(text.replace(" -->\n", " -->\r\n")), version);
  assert.equal(protocolVersion(text), protocolVersion(body), "the following blank line is retained");
  assert.notEqual(protocolVersion(body.slice(1)), version, "removing that blank line changes the hash");
  assert.notEqual(protocolVersion(body.replaceAll("\n", "\r\n")), version, "body line endings are not normalized");
  const dir = makeTempDir(), file = path.join(dir, "protocol.md");
  for (const section of ["Shared", "Ultra", "Pair", "Duel"]) {
    const changedText = text.replace(`${section} instruction.`, `${section} changed instruction.`);
    assert.notEqual(protocolVersion(changedText), version, `${section} edits invalidate the shared hash`);
    for (const mode of MODES) {
      const record = { name: mode.name, options: mode.saved };
      fs.writeFileSync(file, text);
      const initial = reminderText(record, file);
      fs.writeFileSync(file, changedText);
      const changed = reminderText(record, file);
      assert.notEqual(initial, changed, "the next prompt hashes current contents, not a cached version or stale header");
      assert.ok(changed.includes(`v${protocolVersion(changedText)}`));
    }
  }
  fs.writeFileSync(file, text);
  assert.equal(reminderText({ scale: "auto", maxWorkers: 6 }, file), reminderText({ name: "ultra", options: { scale: "auto", maxWorkers: 6 } }, file), "the old direct reminder API remains supported");
});

test("dispatch guidance defers fallback recipes to a model-invocable skill", () => {
  const root = new URL("../plugins/codex/", import.meta.url);
  const read = relative => fs.readFileSync(new URL(relative, root), "utf8");
  const pointer = "If native dispatch returns `native_adapter_unavailable` or `native_capacity`, needs a per-call option the `DUET:` line rejects, or you must follow up a worker launched through Bash, load the `codex:native-fallback` skill and follow it.";
  for (const file of ["prompts/ultra-codex-protocol.md", "scripts/session-lifecycle-hook.mjs", "hooks/native-agent.mjs",
    "agents/codex-native.md", ...MODES.map(mode => `commands/${mode.verb}.md`)]) {
    const source = read(file);
    assert.ok(source.includes(pointer), file);
    assert.doesNotMatch(source, /DUET_TASK|duet task|background.Bash|run_in_background|codex:codex-worker/, file);
  }
  const skill = read("skills/native-fallback/SKILL.md");
  const frontmatter = /^---\n([\s\S]+?)\n---\n/.exec(skill)?.[1];
  assert.ok(frontmatter);
  assert.match(frontmatter, /^name: native-fallback$/m);
  assert.match(frontmatter, /^description: Load ONLY when/m);
  assert.doesNotMatch(frontmatter, /^(?:user-invocable:\s*false|disable-model-invocation:\s*true)$/m);
  assert.match(skill, /duet task[^\n]+<<'DUET_TASK'\n<brief>\nDUET_TASK/);
  for (const flag of ["--run", "--approve-browser-origin", "--approve-computer-app", "--lease-sec", "--question-timeout-sec",
    "--to", "--thread", "--continue", "--fork", "--question", "dangerouslyDisableSandbox"]) {
    assert.ok(skill.includes(flag), `fallback contract retains ${flag}`);
  }
  assert.match(skill, /codex:codex-worker/);
  const fallback = JSON.parse(read("agents/codex-native.md").split("\n").find(line => line.startsWith('{"status":')));
  assert.equal(fallback.status, "blocked");
  assert.equal(fallback.blockers[0].code, "native_adapter_unavailable");
  assert.equal(fallback.next, pointer);
  // The rescue wrapper's own foreground procedure remains a scoped exception.
  const rescue = read("skills/codex-cli-runtime/SKILL.md");
  assert.ok(rescue.includes(pointer));
  assert.match(rescue, /^user-invocable: false$/m);
  assert.match(rescue, /Keep the inner helper call in the foreground/);
});

test("ultra cap settings and mode inputs validate before any write", () => {
  assert.equal(DEFAULT_MAX_WORKERS, "auto");
  assert.equal(PAIR_MAX_REWORK_ROUNDS, 2);
  assert.equal(DEFAULT_DUEL_ROUNDS, 3);
  assert.deepEqual(MODE_NAMES, ["ultra", "pair", "duel"]);
  assert.deepEqual(ULTRA_SCALES, ["auto", "quick", "thorough"]);
  for (const [cpuCount, cap] of [[4, 2], [18, 16], [1, 1]]) {
    assert.equal(effectiveMaxWorkers("auto", cpuCount), cap);
    assert.equal(effectiveMaxWorkers("unlimited", cpuCount), null);
    for (const fixed of [1, 6, 64, 80]) assert.equal(effectiveMaxWorkers(fixed, cpuCount), fixed);
  }
  assert.equal(effectiveMaxWorkers("auto", 64), 16);
  const f = fixture(), file = f.modeFile(SESSION);
  const badInputs = [null, [], "ultra", { name: "unknown" }, { options: {} }, { name: "pair", scale: "quick" },
    { name: "pair", options: [] }, { name: "pair", options: { scale: "quick" } }, { name: "duel", options: { maxWorkers: 4 } },
    { scale: "invalid" }, { unrelated: true }, { name: "ultra", options: { rounds: 2 } },
    ...[0, 65, 1.5, NaN, Infinity, "4", "bad", undefined].map(maxWorkers => ({ maxWorkers })),
    ...[0, 4, 1.5, undefined].map(rounds => ({ name: "duel", options: { rounds } }))];
  for (const input of badInputs) {
    assert.throws(() => setMode(f.repo, SESSION, input, f.env));
    assert.equal(fs.existsSync(path.dirname(file)), false, "invalid input does not even create the mode directory");
  }
  assert.throws(() => modeFile(f.repo, "../bad", f.env), /Orchestration mode needs the Claude session id/);
  assert.throws(() => setMode(f.repo, null, {}, f.env), /Orchestration mode needs the Claude session id/);
  assert.equal(clearMode(f.repo, null, f.env), false);
  assert.equal(readMode(f.repo, null, f.env), null);
  const workspaceLegacy = path.join(resolveStateDir(f.repo, f.env), "ultra-codex", `${SESSION}.json`);
  fs.mkdirSync(path.dirname(workspaceLegacy), { recursive: true });
  const legacyBytes = JSON.stringify({ scale: "quick", maxWorkers: 6 });
  fs.writeFileSync(workspaceLegacy, legacyBytes);
  for (const [verb, flag, values] of [["ultra-codex", "--max-workers", ["0", "65", "1.5"]], ["duel", "--rounds", ["0", "4", "1.5"]]]) {
    for (const value of values) {
      assert.equal(f.call(verb, "on", flag, value).status, 1);
      assert.equal(fs.existsSync(file), false);
      assert.equal(fs.readFileSync(workspaceLegacy, "utf8"), legacyBytes, "invalid CLI input does not trigger legacy cleanup");
    }
  }
  const fresh = setMode(f.repo, SESSION, {}, f.env);
  assert.deepEqual(fresh.options, { scale: "auto", maxWorkers: "auto" });
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  for (const input of badInputs) {
    const before = fs.readFileSync(file, "utf8");
    assert.throws(() => setMode(f.repo, SESSION, input, f.env));
    assert.equal(fs.readFileSync(file, "utf8"), before);
  }
  for (const setting of [1, 64, "auto", "unlimited"]) {
    const record = setMode(f.repo, SESSION, { scale: "quick", maxWorkers: setting }, f.env);
    assert.deepEqual(record.options, { scale: "quick", maxWorkers: setting });
    assert.equal(record.since, fresh.since);
    const on = f.json(f.callCpu(18, "ultra-codex", "on", "--max-workers", String(setting), "--json"));
    assert.equal(on.maxWorkersSetting, setting);
    assert.equal(on.maxWorkers, effectiveMaxWorkers(setting, 18));
    assert.deepEqual(on.activeMode.options, { scale: "auto", maxWorkers: setting });
    assert.deepEqual(f.json(f.callCpu(18, "ultra-codex", "status", "--json")), { ...on, defaultMode: "off", models: BUILTIN_MODELS });
  }
  for (const value of ["0", "65", "1.5", "many", "NaN", "Infinity"]) {
    const before = fs.readFileSync(file, "utf8");
    const rejected = f.call("ultra-codex", "on", "--max-workers", value, "--json");
    assert.equal(rejected.status, 1);
    assert.ok(rejected.stderr.includes("--max-workers must be an integer from 1 to 64, auto or unlimited."));
    assert.equal(fs.readFileSync(file, "utf8"), before);
  }
  clearMode(f.repo, SESSION, f.env);
  const freshCli = f.json(f.callCpu(4, "ultra-codex", "on", "--json"));
  assert.deepEqual([freshCli.maxWorkersSetting, freshCli.maxWorkers], ["auto", 2]);
  assert.deepEqual(Object.keys(freshCli).sort(), ["mode", "modeName", "sessionId", "activeMode", "protocolFile", "protocolVersion", "since", "scale", "maxWorkers", "maxWorkersSetting"].sort());
});

test("saved unlimited caps survive bare and quick ultra activation through the library and CLI", () => {
  for (const source of ["library", "CLI"]) {
    for (const { input, args, scale } of [
      { input: {}, args: [], scale: "auto" },
      { input: { scale: "quick" }, args: ["--quick"], scale: "quick" }
    ]) {
      const f = fixture();
      const initial = source === "library"
        ? setMode(f.repo, SESSION, { scale: "thorough", maxWorkers: "unlimited" }, f.env)
        : f.json(f.call("ultra-codex", "on", "--thorough", "--max-workers", "unlimited", "--json"));
      const activeMode = { name: "ultra", options: { scale, maxWorkers: "unlimited" }, since: initial.since };
      const record = { schemaVersion: 2, sessionId: SESSION, ...activeMode };
      const expected = { mode: "on", modeName: "ultra", sessionId: SESSION, activeMode, protocolFile: PROTOCOL_PATH, protocolVersion: protocolVersion(), since: initial.since, scale, maxWorkers: null, maxWorkersSetting: "unlimited" };
      if (source === "library") {
        assert.deepEqual(setMode(f.repo, SESSION, input, f.env), { ...record, file: f.modeFile(SESSION) });
      } else {
        assert.deepEqual(f.json(f.call("ultra-codex", "on", ...args, "--json")), expected);
      }
      assert.deepEqual(readMode(f.repo, SESSION, f.env), { ...record, file: f.modeFile(SESSION) });
      assert.deepEqual(JSON.parse(fs.readFileSync(f.modeFile(SESSION), "utf8")), record);
      assert.deepEqual(f.json(f.call("ultra-codex", "status", "--json")), { ...expected, defaultMode: "off", models: BUILTIN_MODELS });
      const status = f.call("ultra-codex", "status");
      assert.equal(status.status, 0, status.stderr);
      assert.equal(status.stdout, `Ultra-codex mode: on for this session since ${initial.since} (scale: ${scale}; max workers: unlimited). Turn it off with /codex:ultra-codex off.\n${MODELS_LINE}`);
    }
  }
});

for (const mode of MODES) {
  test(`${mode.name} shares its session across workspaces and preserves lifecycle isolation`, () => {
    const f = fixture(), other = path.join(f.dir, "other");
    fs.mkdirSync(other); initGitRepo(other);
    const legacy = (cwd, sessionId = SESSION) => {
      const file = path.join(resolveStateDir(cwd, f.env), "ultra-codex", `${sessionId}.json`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ sessionId, scale: "quick", maxWorkers: 1 }));
      return file;
    };
    const on = f.json(f.call(mode.verb, "on", ...mode.flags, "--json"));
    assert.deepEqual(on.activeMode, { name: mode.name, options: mode.saved, since: on.since });
    assert.deepEqual(f.json(f.call(mode.verb, "status", "--cwd", other, "--json")), { ...on, defaultMode: "off", models: BUILTIN_MODELS });
    assert.equal(modeFile(other, SESSION, f.env), f.modeFile(SESSION));
    assert.ok(f.prompt("substantive task", SESSION, { cwd: other }).stdout.length > 0);
    assert.equal(f.prompt("substantive task", "another-session").stdout, "");
    assert.equal(f.prompt("substantive task", undefined, { session_id: undefined }).stdout, "");
    for (const source of ["resume", "compact"]) {
      const oldFiles = [legacy(f.repo), legacy(other)];
      assert.equal(f.lifecycle("SessionStart", { session_id: SESSION, source, cwd: other }).status, 0);
      for (const file of oldFiles) assert.equal(fs.existsSync(file), false);
      assert.deepEqual(f.json(f.call(mode.verb, "status", "--json")), { ...on, defaultMode: "off", models: BUILTIN_MODELS });
    }
    const repeated = f.json(f.call(mode.verb, "on", "--cwd", other, "--json"));
    assert.deepEqual(repeated.activeMode.options, mode.repeated);
    assert.equal(repeated.since, on.since);
    for (const source of ["clear", "startup"]) {
      assert.equal(f.lifecycle("SessionStart", { session_id: SESSION, source }).status, 0);
      assert.equal(fs.existsSync(f.modeFile(SESSION)), false);
      f.json(f.call(mode.verb, "on", "--json"));
    }
    const stale = setMode(f.repo, "stale-session", { name: mode.name }, f.env);
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    fs.utimesSync(stale.file, old, old);
    const staleLegacy = legacy(other, "stale-legacy"); fs.utimesSync(staleLegacy, old, old);
    const recent = setMode(f.repo, "recent-session", { name: mode.name }, f.env);
    assert.equal(f.lifecycle("SessionStart", { session_id: SESSION, source: "resume" }).status, 0);
    assert.equal(fs.existsSync(stale.file), false);
    assert.equal(fs.existsSync(staleLegacy), false);
    assert.equal(fs.existsSync(recent.file), true);
    const oldEnd = legacy(other);
    assert.equal(f.lifecycle("SessionEnd", { session_id: SESSION, cwd: other }).status, 0);
    assert.equal(fs.existsSync(f.modeFile(SESSION)), false);
    assert.equal(fs.existsSync(oldEnd), false);
    assert.equal(fs.existsSync(recent.file), true);
  });
}

test("mode replacement and targeted off preserve the single active record and running jobs", () => {
  const f = fixture(), file = f.modeFile(SESSION), stateDir = resolveStateDir(f.repo, f.env);
  fs.mkdirSync(stateDir, { recursive: true });
  const jobs = [
    { id: "task-running", sessionId: SESSION, workspaceRoot: f.repo, agentName: "Euler", title: "Fixture task", status: "running" },
    { id: "task-queued", sessionId: SESSION, workspaceRoot: f.repo, status: "queued" },
    { id: "task-done", sessionId: SESSION, workspaceRoot: f.repo, status: "completed" },
    { id: "task-foreign", sessionId: "foreign-session", workspaceRoot: f.repo, status: "running" }
  ];
  const stateFile = path.join(stateDir, "state.json");
  fs.writeFileSync(stateFile, JSON.stringify({ jobs, config: {} }));
  const running = [{ jobId: "task-running", agentName: "Euler", title: "Fixture task", status: "running" }, { jobId: "task-queued", title: null, status: "queued" }];
  f.json(f.call("ultra-codex", "on", "--quick", "--max-workers", "6", "--json"));
  for (const next of [MODES[1], MODES[2], MODES[0]]) {
    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    stored.since = "2000-01-01T00:00:00.000Z";
    fs.writeFileSync(file, JSON.stringify(stored));
    const previous = { name: stored.name, options: stored.options, since: stored.since };
    const on = f.json(f.callCpu(18, next.verb, "on", "--json"));
    assert.equal(on.mode, "on");
    assert.equal(on.modeName, next.name);
    assert.deepEqual(on.replacedMode, previous);
    assert.deepEqual(on.activeMode, { name: next.name, options: next.options, since: on.since });
    assert.notEqual(on.since, previous.since);
    assert.deepEqual(on.runningJobs, running);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), [`${SESSION}.json`]);
    const canonical = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(canonical, { schemaVersion: 2, sessionId: SESSION, ...on.activeMode });
    if (next.name === "ultra") assert.deepEqual([on.maxWorkersSetting, on.maxWorkers], ["auto", 16]);
    else for (const key of ["scale", "maxWorkers", "maxWorkersSetting"]) assert.equal(Object.hasOwn(on, key), false);
    const current = f.json(f.callCpu(18, next.verb, "status", "--json"));
    const { replacedMode, runningJobs, ...normalOn } = on;
    assert.deepEqual(current, { ...normalOn, defaultMode: "off", models: BUILTIN_MODELS });
    const other = MODES.find(mode => mode.name !== next.name);
    const otherStatus = f.json(f.call(other.verb, "status", "--json"));
    assert.deepEqual([otherStatus.mode, otherStatus.modeName, otherStatus.activeMode], ["off", other.name, on.activeMode]);
    const before = fs.readFileSync(file, "utf8");
    const off = f.json(f.call(other.verb, "off", "--json"));
    assert.deepEqual([off.wasOn, off.activeMode, off.runningJobs], [false, on.activeMode, running]);
    assert.equal(fs.readFileSync(file, "utf8"), before);
    for (const args of [["pair", "on", "--rounds", "2"], ["duel", "on", "--rounds", "4"], ["ultra-codex", "on", "--max-workers", "80"]]) {
      assert.equal(f.call(...args).status, 1);
      assert.equal(fs.readFileSync(file, "utf8"), before, "failed replacement leaves bytes intact");
    }
    assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs, jobs, "controls do not cancel or alter jobs");
  }
  const off = f.json(f.call("ultra-codex", "off", "--json"));
  assert.deepEqual(off, { mode: "off", modeName: "ultra", sessionId: SESSION, wasOn: true, activeMode: null, protocolFile: PROTOCOL_PATH, protocolVersion: protocolVersion(), runningJobs: running });
  assert.equal(fs.existsSync(file), false);
  assert.equal(f.json(f.call("ultra-codex", "off", "--json")).wasOn, false);
  const text = f.call("ultra-codex", "off");
  assert.equal(text.stdout, "Ultra-codex mode was already off for this session.\nHandle requests normally from here on; spawn Codex workers only when asked.\nCodex jobs from this session still running: task-running (running), task-queued (queued). Cancel them only if the user asks:\n/codex:cancel task-running\n/codex:cancel task-queued\n");
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs, jobs);
});

test("legacy global ultra records normalize without losing saved caps or rewriting on read", () => {
  const f = fixture(), file = f.modeFile(SESSION), since = "2026-01-01T00:00:00.000Z";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const [stored, setting] of [[6, 6], [4, 4], [80, 80], [undefined, "auto"], [0, "auto"], [-1, "auto"], [1.5, "auto"], ["bad", "auto"], [null, "auto"]]) {
    const bytes = JSON.stringify({ sessionId: SESSION, scale: "thorough", maxWorkers: stored, since, ignored: "metadata" });
    fs.writeFileSync(file, bytes);
    assert.deepEqual(readMode(f.repo, SESSION, f.env), { schemaVersion: 2, sessionId: SESSION, name: "ultra", options: { scale: "thorough", maxWorkers: setting }, since, file });
    const status = f.json(f.callCpu(18, "ultra-codex", "status", "--json"));
    assert.deepEqual([status.maxWorkersSetting, status.maxWorkers, status.since], [setting, effectiveMaxWorkers(setting, 18), since]);
    const capText = setting === "auto" ? "max 16 workers (auto)" : `max ${setting} workers`;
    assert.equal(f.promptCpu(18, "substantive request").stdout, `Ultra-codex mode on (thorough, ${capText}, routine gpt-6.1-sol, strong gpt-6-astra). Apply protocol v${protocolVersion()} to substantive tasks; re-read ${PROTOCOL_PATH} only if v${protocolVersion()} is not in your context.\n`);
    assert.equal(fs.readFileSync(file, "utf8"), bytes, "status and hook only normalize in memory");
    assert.equal(f.call("ultra-codex", "on", "--max-workers", "80").status, 1);
    assert.equal(fs.readFileSync(file, "utf8"), bytes);
    const on = f.json(f.callCpu(18, "ultra-codex", "on", "--json"));
    assert.deepEqual(on.activeMode, { name: "ultra", options: { scale: "auto", maxWorkers: setting }, since });
    const canonical = { schemaVersion: 2, sessionId: SESSION, ...on.activeMode };
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), canonical);
    assert.deepEqual(readMode(f.repo, SESSION, f.env), { ...canonical, file }, "grandfathered schema-2 caps remain readable");
    const scaled = f.json(f.callCpu(18, "ultra-codex", "on", "--quick", "--json"));
    assert.deepEqual([scaled.scale, scaled.maxWorkersSetting, scaled.since], ["quick", setting, since]);
  }
  fs.writeFileSync(file, JSON.stringify({ scale: "quick", maxWorkers: 6 }));
  assert.equal(readMode(f.repo, SESSION, f.env).since, null);
  const rewritten = setMode(f.repo, SESSION, {}, f.env);
  assert.equal(rewritten.sessionId, SESSION);
  assert.match(rewritten.since, /^\d{4}-\d\d-\d\dT/);
});

test("malformed or explicitly versioned invalid records stay inactive and hooks stay silent", () => {
  const f = fixture(), file = f.modeFile(SESSION);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const invalid = ["broken JSON", "null", "[]", "42", JSON.stringify({ scale: "bogus" }),
    ...[
      { schemaVersion: 1, scale: "auto" }, { schemaVersion: null, scale: "auto" }, { schemaVersion: 2, name: "unknown", options: {} },
      { schemaVersion: 2, name: "pair", options: [] }, { schemaVersion: 2, name: "pair", options: { maxWorkers: 4 } },
      { schemaVersion: 2, name: "duel", options: { rounds: 0 } }, { schemaVersion: 2, name: "duel", options: { rounds: 4 } },
      { schemaVersion: 2, name: "duel", options: { rounds: 1.5 } }, { schemaVersion: 2, name: "duel", options: {} },
      { schemaVersion: 2, name: "ultra", scale: "auto", options: { scale: "auto" } },
      ...[0, -1, 1.5, "6", "bad", null].map(maxWorkers => ({ schemaVersion: 2, name: "ultra", options: { scale: "quick", maxWorkers } })),
      { schemaVersion: 2, name: "ultra", options: { scale: "auto", maxWorkers: 6, rounds: 2 } },
      { schemaVersion: 2, name: "ultra", options: { scale: "bogus", maxWorkers: 6 } },
      { sessionId: "different-session", scale: "quick", maxWorkers: 6 },
      { schemaVersion: 2, sessionId: "different-session", name: "pair", options: {} }
    ].map(value => JSON.stringify(value))];
  for (const bytes of invalid) {
    fs.writeFileSync(file, bytes);
    assert.equal(readMode(f.repo, SESSION, f.env), null, bytes);
    assert.equal(f.json(f.call("pair", "status", "--json")).activeMode, null, bytes);
    assert.equal(f.prompt("substantive request").stdout, "", bytes);
    assert.equal(fs.readFileSync(file, "utf8"), bytes);
  }
  for (const mode of MODES) {
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 2, name: mode.name, options: mode.options, ignored: true }));
    const record = readMode(f.repo, SESSION, f.env);
    assert.deepEqual(record.options, mode.options);
    assert.equal(record.since, null);
    const written = setMode(f.repo, SESSION, { name: mode.name }, f.env);
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, "utf8"))).sort(), ["schemaVersion", "sessionId", "name", "options", "since"].sort());
    assert.notEqual(written.since, null);
  }
});

test("all reminders have exact mode settings and suppress every mode command", () => {
  const f = fixture(), version = protocolVersion();
  const suffix = `v${version} to substantive tasks; re-read ${PROTOCOL_PATH} only if v${version} is not in your context.`;
  const cases = [];
  for (const scale of ULTRA_SCALES) {
    for (const [maxWorkers, cap] of [["auto", "max 16 workers (auto)"], [6, "max 6 workers"], ["unlimited", "no worker cap"]]) {
      cases.push({ name: "ultra", options: { scale, maxWorkers }, expected: `Ultra-codex mode on (${scale}, ${cap}, routine gpt-6.1-sol, strong gpt-6-astra). Apply protocol ${suffix}` });
    }
  }
  cases.push({ name: "pair", options: {}, expected: `Pair mode on (one primary Codex worker on gpt-6-astra/xhigh, max 2 rework rounds). Apply pair protocol ${suffix}` });
  for (const rounds of [1, 2, 3]) cases.push({ name: "duel", options: { rounds }, expected: `Duel mode on (Claude vs Codex on gpt-6-astra/xhigh, max ${rounds} rounds). Apply duel protocol ${suffix}` });
  for (const entry of cases) {
    setMode(f.repo, SESSION, { name: entry.name, options: entry.options }, f.env);
    const result = f.promptCpu(18, "substantive task");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${entry.expected}\n`);
    if (entry.options.maxWorkers !== "auto") assert.equal(reminderText({ name: entry.name, options: entry.options }), entry.expected);
    for (const command of MODES.flatMap(mode => [`/codex:${mode.verb} task`, ` /${mode.verb} status`])) {
      assert.equal(isModeCommandPrompt(command), true);
      assert.equal(f.prompt(command).stdout, "", `${entry.name} must not prefix ${command}`);
    }
    for (const lookalike of ["/pair-review fix the parser", "/codex:duel.md explain"]) {
      assert.equal(isModeCommandPrompt(lookalike), false);
      assert.equal(f.promptCpu(18, lookalike).stdout, `${entry.expected}\n`, `${entry.name} still reminds for ${lookalike}`);
    }
  }
  for (const prompt of [null, undefined, "pair", "/pairing", "/codex:duelish", "/ultra-codexish", "please /pair task", 42]) assert.equal(isModeCommandPrompt(prompt), false);
  assert.equal(run(process.execPath, [promptHook], { cwd: f.repo, env: f.baseEnv, input: "not json" }).stdout, "");
  assert.equal(f.json(f.call("duel", "off", "--json")).wasOn, true);
  assert.equal(f.prompt("substantive task").stdout, "");
});

test("human status shows effective auto caps with injected CPU counts and preserves all templates", () => {
  const f = fixture(), since = "2026-01-01T00:00:00.000Z";
  for (const [setting, cpuCount, shown] of [["auto", 4, "2 (auto)"], ["auto", 18, "16 (auto)"], ["auto", 1, "1 (auto)"], [6, 4, "6"], ["unlimited", 18, "unlimited"]]) {
    setMode(f.repo, SESSION, { maxWorkers: setting }, f.env);
    const record = JSON.parse(fs.readFileSync(f.modeFile(SESSION), "utf8"));
    record.since = since; fs.writeFileSync(f.modeFile(SESSION), JSON.stringify(record));
    const result = f.callCpu(cpuCount, "ultra-codex", "status");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `Ultra-codex mode: on for this session since ${since} (scale: auto; max workers: ${shown}). Turn it off with /codex:ultra-codex off.\n${MODELS_LINE}`);
    const payload = f.json(f.callCpu(cpuCount, "ultra-codex", "status", "--json"));
    assert.equal(payload.maxWorkers, effectiveMaxWorkers(setting, cpuCount));
    assert.equal(payload.maxWorkersSetting, setting);
  }
  clearMode(f.repo, SESSION, f.env);
  let active = null;
  for (const mode of MODES) {
    const description = mode.name === "ultra" ? "scale: auto; max workers: 16 (auto)" : mode.name === "pair" ? "one primary Codex worker; max rework rounds: 2" : "Claude vs Codex; max rounds: 3";
    const on = f.callCpu(18, mode.verb, "on");
    assert.equal(on.status, 0, on.stderr);
    const current = f.json(f.callCpu(18, mode.verb, "status", "--json"));
    const line = `${mode.label} mode: on for this session since ${current.since} (${description}). Turn it off with /codex:${mode.verb} off.`;
    assert.equal(on.stdout, `${active ? `Replaced ${active} mode with ${mode.name} mode for this session. Existing jobs are unchanged; cancel them only if the user asks.\n` : ""}${line}\nFrom now on every substantive prompt in this session uses ${mode.name} orchestration (a reminder is attached to each prompt); conversational turns and trivial mechanical edits stay inline.\n${active ? "No Codex jobs from this session are still running.\n" : ""}`);
    assert.equal(f.callCpu(18, mode.verb, "status").stdout, `${line}\n${MODELS_LINE}`);
    const other = MODES.find(candidate => candidate.name !== mode.name);
    assert.equal(f.callCpu(18, other.verb, "status").stdout, `${other.label} mode: off for this session. Active mode: ${mode.name}. Turn it off with /codex:${mode.verb} off.\n${MODELS_LINE}`);
    assert.equal(f.callCpu(18, other.verb, "off").stdout, `${other.label} mode was already off for this session. Active mode ${mode.name} is unchanged.\n${line}\nNo Codex jobs from this session are still running.\n`);
    active = mode.name;
  }
  for (const mode of MODES) {
    f.json(f.call(mode.verb, "on", "--json"));
    assert.equal(f.call(mode.verb, "off").stdout, `${mode.label} mode: off. Orchestration has ended for this session.\nHandle requests normally from here on; spawn Codex workers only when asked.\nNo Codex jobs from this session are still running.\n`);
    assert.equal(f.call(mode.verb, "off").stdout, `${mode.label} mode was already off for this session.\nHandle requests normally from here on; spawn Codex workers only when asked.\nNo Codex jobs from this session are still running.\n`);
    assert.equal(f.call(mode.verb, "status").stdout, `${mode.label} mode: off for this session. No orchestration mode is active. Turn it on with /codex:${mode.verb} on; a task given as arguments is orchestrated once without changing the mode.\n${MODELS_LINE}`);
  }
  fs.writeFileSync(f.modeFile(SESSION), JSON.stringify({ schemaVersion: 2, name: "pair", options: {} }));
  assert.equal(f.call("pair", "status").stdout, "Pair mode: on for this session since unknown (one primary Codex worker; max rework rounds: 2). Turn it off with /codex:pair off.\n" + MODELS_LINE);
});

test("mode CLI flags, defaults, global session override and absent-session JSON remain strict", () => {
  const f = fixture(), file = f.modeFile(SESSION);
  for (const mode of MODES) {
    const noSession = run(process.execPath, [script, mode.verb, "status", "--json"], { cwd: f.repo, env: f.baseEnv });
    assert.deepEqual(f.json(noSession), { mode: "off", modeName: mode.name, sessionId: null, activeMode: null, protocolFile: PROTOCOL_PATH, protocolVersion: protocolVersion(), defaultMode: "off", models: BUILTIN_MODELS });
    for (const action of ["on", "off"]) {
      const result = run(process.execPath, [script, mode.verb, action], { cwd: f.repo, env: f.baseEnv });
      assert.equal(result.status, 1);
      assert.ok(result.stderr.includes("Orchestration mode needs the Claude session id"));
      assert.equal(f.call(mode.verb, action, "--session", "../invalid").status, 1);
    }
    const on = f.json(f.call(mode.verb, "on", "--json"));
    assert.deepEqual(on.activeMode.options, mode.options);
    assert.deepEqual(f.json(f.call(mode.verb, "--json")), { ...on, defaultMode: "off", models: BUILTIN_MODELS }, "omitted action means status");
    assert.deepEqual(f.json(f.call(mode.verb, "status", "--for-command", "--json")), { ...on, defaultMode: "off", models: BUILTIN_MODELS });
    const before = fs.readFileSync(file, "utf8");
    const invalid = [["toggle"], ["on", "task text"], ["status", "task text"], ["off", "task text"], ["on", "--unknown"], ["on", "--for-command"], ["on", "--for-command=false"], ["off", "--for-command"], ["off", "--for-command=false"]];
    const ownFlags = mode.name === "ultra" ? [["--quick"], ["--quick=false"], ["--thorough"], ["--thorough=false"], ["--max-workers", "3"], ["--max-workers=bad"]] : mode.name === "duel" ? [["--rounds", "2"], ["--rounds=false"]] : [];
    for (const action of ["off", "status"]) for (const flags of ownFlags) invalid.push([action, ...flags]);
    const foreignFlags = mode.name === "ultra" ? [["--rounds", "2"], ["--quick", "--thorough"]] : mode.name === "pair" ? [["--quick"], ["--thorough=false"], ["--max-workers", "4"], ["--rounds", "2"]] : [["--quick"], ["--thorough=false"], ["--max-workers", "4"], ...["0", "4", "1.5", "many", "Infinity"].map(value => ["--rounds", value])];
    for (const flags of foreignFlags) invalid.push(["on", ...flags]);
    for (const args of invalid) {
      assert.equal(f.call(mode.verb, ...args, "--json").status, 1, `${mode.name} ${args.join(" ")}`);
      assert.equal(fs.readFileSync(file, "utf8"), before);
    }
    const other = f.json(f.call(mode.verb, "on", "--session", "overridden-session", "-C", f.repo, "--json"));
    assert.equal(other.sessionId, "overridden-session");
    assert.deepEqual(other.activeMode.options, mode.options);
    assert.equal(fs.readFileSync(file, "utf8"), before, "session override does not alter the environment's session");
    f.json(f.call(mode.verb, "off", "--session", "overridden-session", "--json"));
    f.json(f.call(mode.verb, "off", "--json"));
  }
  for (const rounds of [1, 3]) {
    const on = f.json(f.call("duel", "on", "--rounds", String(rounds), "--json"));
    assert.equal(on.activeMode.options.rounds, rounds);
    assert.deepEqual(f.json(f.call("duel", "on", "--json")), on);
  }
  const rejected = f.call("duel", "on", "--rounds", "4");
  assert.ok(rejected.stderr.includes("--rounds must be an integer from 1 to 3."));
});

test("every safe command preamble selects only its requested section and leaves session state unchanged", () => {
  const f = fixture(), body = fs.readFileSync(PROTOCOL_PATH, "utf8");
  for (const mode of MODES) {
    f.json(f.call("ultra-codex", "on", "--max-workers", "6", "--json"));
    const command = fs.readFileSync(new URL(`../plugins/codex/commands/${mode.verb}.md`, import.meta.url), "utf8");
    assert.ok(command.includes(`!\`node "\${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" ${mode.verb} status --for-command\``));
    assert.doesNotMatch(command, /^!`[^\n]*\$ARGUMENTS/m);
    assert.match(command, /one-shot[^\n]*(?:never|do not|does not|must not)[^\n]*(?:writ|chang|replac|clear)/i, "one-shot routing explicitly leaves saved state alone");
    const before = fs.readFileSync(f.modeFile(SESSION), "utf8");
    const preamble = f.call(mode.verb, "status", "--for-command");
    assert.equal(preamble.status, 0, preamble.stderr);
    assert.equal(preamble.stdout, `${f.call(mode.verb, "status").stdout}Usage: /codex:${mode.verb} ${mode.usage}\nIf the arguments describe a task, Read ${PROTOCOL_PATH} (protocol v${protocolVersion()}) before orchestrating; otherwise do not read it.\nFor this task, apply the shared sections and "${mode.heading}" only. Task-prefix options override saved options; a one-shot task leaves the session mode unchanged.\n`);
    assert.equal(fs.readFileSync(f.modeFile(SESSION), "utf8"), before);
    const raw = "on --quick\nHEREDOC_END\n$(exit 93) `exit 94` ; ' \"";
    const hostile = run(process.execPath, [script, mode.verb, "status", "--for-command"], { cwd: f.repo, env: f.env, input: raw });
    assert.equal(hostile.status, 0, hostile.stderr);
    assert.equal(hostile.stdout, preamble.stdout);
    for (const result of [preamble, f.call(mode.verb, "on"), f.call(mode.verb, "status"), f.call(mode.verb, "off")]) {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.includes(body), false);
      assert.doesNotMatch(result.stdout, /^OBJECTIVE:/m);
    }
  }
});

test("all mode help bodies are complete and take precedence without side effects", () => {
  const f = fixture();
  const helpLines = {
    ultra: [
      "  --quick, --thorough  Scale for on (default auto); choose at most one.",
      "  --max-workers <n|auto|unlimited>  Advisory concurrent-worker cap for on (1-64; fresh default auto).",
      "  Auto follows native Ultracode: min(16, CPU count - 2) workers in flight, at least 1 (16 on an 18-core Mac).",
      "  --max-workers raises or lowers concurrency; unlimited removes the cap. The cap never limits coverage; existing saved caps are retained.",
      "  Twelve concurrent workers were measured on the shared runtime; larger fan-out for heavy or mutating work is not yet a measured guarantee."
    ],
    pair: ["  Pair uses one primary Codex thread and at most two rework rounds; it has no mode options."],
    duel: ["  --rounds <n>  Total adversarial rounds for on, including the first (1-3; default 3)."]
  };
  const before = fs.readdirSync(f.dir, { recursive: true }).sort();
  for (const mode of MODES) {
    const expected = [
      `Usage: duet ${mode.verb} [on|off|status] [options]`,
      `Set or inspect ${mode.name} orchestration for this Claude session (default action: status).`,
      `  on replaces another active mode; off disables ${mode.name} only; status reports the active mode.`,
      ...helpLines[mode.name],
      "  --for-command  With status, print a versioned task-only protocol Read instruction.",
      "  --cwd, -C <dir>  Workspace; --session <id>  Override the Claude session id.",
      "  --json  JSON output; --help, -h  Show help without changing mode.",
      `Tasks run through /codex:${mode.verb} <task>; this CLI accepts controls only.`, ""
    ].join("\n");
    for (const help of ["--help", "-h"]) {
      const result = f.call(mode.verb, "off", "extra", "--quick", "--thorough", "--rounds", "4", "--max-workers", "invalid", "--unknown", "--session", help);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, expected);
      assert.equal(result.stderr, "");
      assert.deepEqual(fs.readdirSync(f.dir, { recursive: true }).sort(), before);
    }
    assert.ok(f.call("--help").stdout.includes(`  duet ${mode.verb} [on|off|status] [options]\n`));
  }
});
