import test from "node:test";
import assert from "node:assert/strict";
import { lifecycleHarness } from "./fake-codex-fixture.mjs";
import { readTomlField, readWorkerDefaults, workerDefaultsSetup, VALID_REASONING_EFFORTS } from "../plugins/codex/scripts/lib/setup-config.mjs";
import { PROTOCOL_PATH, protocolVersion } from "../plugins/codex/scripts/lib/ultra-codex-mode.mjs";

const { fs, path, fixture, json, direct, run, hook } = await lifecycleHarness();
const BUILTIN = { model: "gpt-6-astra", effort: "xhigh", routineModel: "gpt-6.1-sol" };
const SETTINGS = [
  { key: "defaultModel", field: "model", flag: "--default-model", value: "vendor:worker-v2" },
  { key: "defaultEffort", field: "effort", flag: "--default-effort", value: "high" },
  { key: "ultraRoutineModel", field: "routineModel", flag: "--ultra-routine-model", value: "vendor:routine-v1" }
];
const preferenceFile = f => path.join(f.env.CODEX_COMPANION_HOME, "duet", "config.toml");
const summary = (values = BUILTIN, source = "built-in") => Object.fromEntries(SETTINGS.map(({ key, field }) => [key, { value: values[field], source }]));
const snapshot = dir => fs.readdirSync(dir, { recursive: true }).sort().map(name => {
  const file = path.join(dir, name);
  return [name, fs.statSync(file).isFile() ? fs.readFileSync(file).toString("base64") : null];
});

test("worker defaults setup saves and resets each key, supports combined dry-runs, and preserves unrelated settings", () => {
  const f = fixture("task-ok"), file = preferenceFile(f), initial = snapshot(f.dir);
  assert.deepEqual(readWorkerDefaults(f.env), BUILTIN);
  assert.deepEqual(workerDefaultsSetup({ env: f.env }), summary());
  const flags = SETTINGS.flatMap(({ flag, value }) => [flag, value]);
  const wanted = Object.fromEntries(SETTINGS.map(({ field, value }) => [field, value]));
  const preview = json(f.call("setup", ...flags, "--dry-run", "--json"));
  assert.deepEqual(preview, { file, ...summary(wanted, "saved"), changedFiles: [file], backups: [], dryRun: true });
  assert.deepEqual(snapshot(f.dir), initial);

  json(f.call("setup", "--default-mode", "pair", "--json"));
  fs.appendFileSync(file, '# Keep this comment.\n[custom]\nvalue = "untouched"\n');
  const original = fs.readFileSync(file, "utf8");
  for (const { key, field, flag, value } of SETTINGS) {
    const before = snapshot(f.dir);
    const dry = json(f.call("setup", flag, value, "--dry-run", "--json"));
    assert.deepEqual(dry[key], { value, source: "saved" });
    assert.deepEqual(snapshot(f.dir), before, "dry-run creates no backups or locks");
    const saved = json(f.call("setup", flag, value, "--json"));
    assert.deepEqual(saved[key], { value, source: "saved" });
    assert.deepEqual(saved.changedFiles, [file]);
    assert.equal(saved.backups.length, 1);
    assert.equal(fs.readFileSync(saved.backups[0], "utf8"), original);
    assert.equal(readTomlField(fs.readFileSync(file, "utf8"), [key]), value);
    assert.equal(readWorkerDefaults(f.env)[field], value);
    assert.deepEqual(json(f.call("setup", flag, value, "--json")).changedFiles, []);
    const savedSnapshot = snapshot(f.dir);
    assert.deepEqual(json(f.call("setup", flag, "default", "--dry-run", "--json"))[key], { value: BUILTIN[field], source: "built-in" });
    assert.deepEqual(snapshot(f.dir), savedSnapshot);
    assert.deepEqual(json(f.call("setup", flag, "default", "--json"))[key], { value: BUILTIN[field], source: "built-in" });
    assert.equal(fs.readFileSync(file, "utf8"), original);
  }
  const combined = json(f.call("setup", ...flags, "--json"));
  for (const { key } of SETTINGS) assert.deepEqual(combined[key], preview[key]);
  assert.deepEqual(readWorkerDefaults({ ...f.env, CLAUDE_PLUGIN_DATA: undefined }), wanted, "terminal and Claude share the preference");
  const reset = json(f.call("setup", ...SETTINGS.flatMap(({ flag }) => [flag, "default"]), "--json"));
  for (const { key } of SETTINGS) assert.deepEqual(reset[key], summary()[key]);
  assert.equal(fs.readFileSync(file, "utf8"), original);
});

test("worker defaults setup rejects invalid values and other setup changes before writing", () => {
  const f = fixture("task-ok");
  const incompatible = [
    ["--default-mode", "pair"], ["--default-sandbox", "read-only"], ["--sync-tools"], ["--transport", "http"],
    ["--browser-approval", "ask"], ["--allow-browser-origin", "https://example.com"],
    ["--revoke-browser-origin", "https://example.com"], ["--list-browser-origins"],
    ["--computer-use-approval", "ask"], ["--allow-computer-app", "com.example.App"],
    ["--revoke-computer-app", "com.example.App"], ["--list-computer-apps"],
    ["--project-docs", "agents-only"], ["--enable-review-gate"], ["--disable-review-gate"],
    ["--sync-tools", "--profile", "chrome"], ["--sync-tools", "--replace-cua"],
    ["--sync-tools", "--cua-template", path.join(f.dir, "template")],
    ["--sync-tools", "--chatgpt-resources", f.dir]
  ];
  for (const existing of [false, true]) {
    if (existing) json(f.call("setup", "--default-model", "saved-model", "--json"));
    const before = snapshot(f.dir);
    for (const { flag } of SETTINGS) {
      const invalid = flag === "--default-effort" ? ["", "invalid", "ultra", "HIGH"] : ["", "has spaces", "../model", "-model", "a".repeat(101), "model\nline"];
      for (const value of invalid) {
        const valid = flag === "--default-model" ? ["--default-effort", "high"] : ["--default-model", "valid-model"];
        const result = f.call("setup", ...valid, `${flag}=${value}`);
        assert.equal(result.status, 1, `${flag} ${value}`);
        assert.ok(result.stderr.includes(`${flag} must be`), result.stderr);
        assert.deepEqual(snapshot(f.dir), before);
      }
      assert.equal(f.call("setup", flag).status, 1);
      for (const extra of incompatible) {
        const result = f.call("setup", flag, "default", ...extra);
        assert.equal(result.status, 1, extra.join(" "));
        assert.match(result.stderr, /separately from other setup changes/);
        assert.deepEqual(snapshot(f.dir), before);
      }
    }
  }
  for (const value of VALID_REASONING_EFFORTS) {
    assert.deepEqual(json(f.call("setup", "--default-effort", value, "--dry-run", "--json")).defaultEffort, { value, source: "saved" });
  }
  assert.equal(json(f.call("setup", "--default-model", "  SPARK  ", "--ultra-routine-model", "spark", "--json")).defaultModel.value, "gpt-5.3-codex-spark");
  assert.equal(readWorkerDefaults(f.env).routineModel, "gpt-5.3-codex-spark");
  assert.equal(json(f.call("setup", "--default-model", "a".repeat(100), "--dry-run", "--json")).defaultModel.value.length, 100);
});

test("worker defaults reads ignore invalid, malformed and unreadable preferences without throwing", () => {
  const f = fixture(), file = preferenceFile(f);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const text of [
    'defaultModel = 123\ndefaultEffort = "ultra"\nultraRoutineModel = ["model"]\n',
    'defaultModel = "bad/model"\ndefaultEffort = "HIGH"\nultraRoutineModel = ""\n',
    'defaultModel = "unterminated',
    'defaultModel = "one"\ndefaultModel = "two"\n'
  ]) {
    fs.writeFileSync(file, text);
    assert.deepEqual(readWorkerDefaults(f.env), BUILTIN);
    assert.deepEqual(workerDefaultsSetup({ env: f.env }), summary());
    assert.equal(fs.readFileSync(file, "utf8"), text);
  }
  fs.writeFileSync(file, 'defaultModel = "spark"\ndefaultEffort = false\nultraRoutineModel = "custom_model.v1:latest"\n');
  assert.deepEqual(readWorkerDefaults(f.env), { model: "gpt-5.3-codex-spark", effort: "xhigh", routineModel: "custom_model.v1:latest" });
  fs.rmSync(file);
  fs.mkdirSync(file);
  assert.deepEqual(readWorkerDefaults(f.env), BUILTIN);
});

test("worker defaults setup status reports effective values and sources on fresh and configured installs", () => {
  const f = fixture("task-ok");
  for (const saved of [false, true]) {
    if (saved) json(f.call("setup", ...SETTINGS.flatMap(({ flag, value }) => [flag, value]), "--json"));
    const values = saved ? Object.fromEntries(SETTINGS.map(({ field, value }) => [field, value])) : BUILTIN;
    const report = json(f.call("setup", "--json"));
    for (const { key } of SETTINGS) assert.deepEqual(report[key], summary(values, saved ? "saved" : "built-in")[key]);
    const human = f.call("setup");
    assert.equal(human.status, 0, human.stderr);
    assert.ok(human.stdout.includes(`Default models: worker ${values.model}/${values.effort}, ultra routine ${values.routineModel}.\n`));
  }
});

test("task uses saved worker defaults, explicit flags override, and follow-ups retain recorded settings", () => {
  const f = fixture("task-ok");
  const task = (...flags) => {
    const report = direct(f.call("task", "--direct", ...flags, "fixture"));
    assert.equal(report.status, "completed");
    return { report, turn: f.state().lastTurnStart };
  };
  const builtin = task();
  assert.equal(builtin.turn.model, BUILTIN.model);
  assert.equal(builtin.turn.effort, BUILTIN.effort);
  json(f.call("setup", "--default-model", "saved-worker", "--default-effort", "high", "--json"));
  const saved = task();
  assert.equal(saved.turn.model, "saved-worker");
  assert.equal(saved.turn.effort, "high");
  const explicit = task("--model", "explicit-worker", "--effort", "low");
  assert.equal(explicit.turn.model, "explicit-worker");
  assert.equal(explicit.turn.effort, "low");
  json(f.call("setup", "--default-model", "changed-worker", "--default-effort", "medium", "--json"));
  const resumed = task("--to", saved.report.worker);
  assert.equal(resumed.turn.threadId, saved.turn.threadId);
  assert.equal(resumed.turn.model, "saved-worker");
  assert.equal(resumed.turn.effort, "high");
  const override = task("--to", saved.report.worker, "--model", "spark", "--effort", "max");
  assert.equal(override.turn.threadId, saved.turn.threadId);
  assert.equal(override.turn.model, "gpt-5.3-codex-spark");
  assert.equal(override.turn.effort, "max");
});

test("SessionStart interpolates worker defaults and malformed preferences promptly restore the built-in context", () => {
  const f = fixture(), file = preferenceFile(f);
  const start = () => {
    const result = run(process.execPath, [hook, "SessionStart"], { cwd: f.repo, env: { ...f.env, CODEX_COMPANION_BIN: path.join(f.dir, "missing-codex") }, input: JSON.stringify({ cwd: f.repo }) });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
  };
  const baseline = start();
  json(f.call("setup", "--default-model", "custom-worker", "--default-effort", "medium", "--json"));
  assert.equal(start(), baseline.replace("--model gpt-6-astra --effort xhigh", "--model custom-worker --effort medium"));
  fs.writeFileSync(file, 'defaultModel = "unterminated');
  const before = Date.now();
  assert.equal(start(), baseline);
  assert.ok(Date.now() - before < 5000, "invalid preferences do not stall the hook");
});

test("all mode reminders and statuses expose configured worker and routine models", () => {
  const f = fixture(), models = { model: "configured-strong", effort: "medium", routineModel: "configured-routine" };
  json(f.call("setup", "--default-model", models.model, "--default-effort", models.effort, "--ultra-routine-model", models.routineModel, "--json"));
  const suffix = `v${protocolVersion()} to substantive tasks; re-read ${PROTOCOL_PATH} only if v${protocolVersion()} is not in your context.\n`;
  const cases = [
    { verb: "pair", flags: [], reminder: `Pair mode on (one primary Codex worker on configured-strong/medium, max 2 rework rounds). Apply pair protocol ${suffix}` },
    { verb: "duel", flags: ["--rounds", "2"], reminder: `Duel mode on (Claude vs Codex on configured-strong/medium, max 2 rounds). Apply duel protocol ${suffix}` },
    { verb: "ultra-codex", flags: ["--quick", "--max-workers", "3"], reminder: `Ultra-codex mode on (quick, max 3 workers, routine configured-routine, strong configured-strong). Apply protocol ${suffix}` }
  ];
  const promptHook = new URL("../plugins/codex/scripts/ultra-codex-hook.mjs", import.meta.url).pathname;
  for (const { verb, flags, reminder } of cases) {
    assert.deepEqual(json(f.call(verb, "status", "--json")).models, models, "off status includes models");
    json(f.call(verb, "on", ...flags, "--json"));
    assert.deepEqual(json(f.call(verb, "status", "--json")).models, models);
    assert.ok(f.call(verb, "status").stdout.includes("models: worker configured-strong/medium, ultra routine configured-routine\n"));
    const result = run(process.execPath, [promptHook], { cwd: f.repo, env: f.env, input: JSON.stringify({ cwd: f.repo, session_id: f.env.CODEX_COMPANION_SESSION_ID, prompt: "substantive work" }) });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, reminder);
  }
});
