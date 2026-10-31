import test from "node:test";
import assert from "node:assert/strict";
import { lifecycleHarness } from "./fake-codex-fixture.mjs";
import { readWorkerDefaults } from "../plugins/codex/scripts/lib/setup-config.mjs";

const { fs, path, fixture, json, direct, run, hook } = await lifecycleHarness();
const BUILTIN = { model: "gpt-6-astra", effort: "xhigh", routineModel: "gpt-6.1-sol" };
const SETTINGS = ["--default-model", "saved-worker", "--default-effort", "high", "--ultra-routine-model", "saved-routine"];
const preferenceFile = f => path.join(f.env.CODEX_COMPANION_HOME, "duet", "config.toml");
const snapshot = dir => fs.readdirSync(dir, { recursive: true }).sort().map(name => {
  const file = path.join(dir, name);
  return [name, fs.statSync(file).isFile() ? fs.readFileSync(file).toString("base64") : null];
});

test("worker defaults preview, save and reset together while preserving unrelated preferences", () => {
  const f = fixture(), file = preferenceFile(f), initial = snapshot(f.dir);
  assert.deepEqual(readWorkerDefaults(f.env), BUILTIN);
  json(f.call("setup", ...SETTINGS, "--dry-run", "--json"));
  assert.deepEqual(snapshot(f.dir), initial);
  json(f.call("setup", "--default-mode", "pair", "--json"));
  fs.appendFileSync(file, '# preserved\n[custom]\nvalue = "untouched"\n');
  const original = fs.readFileSync(file, "utf8");
  const saved = json(f.call("setup", ...SETTINGS, "--json"));
  assert.deepEqual(readWorkerDefaults({ ...f.env, CLAUDE_PLUGIN_DATA: undefined }), { model: "saved-worker", effort: "high", routineModel: "saved-routine" });
  assert.equal(fs.readFileSync(saved.backups[0], "utf8"), original);
  assert.deepEqual(json(f.call("setup", ...SETTINGS, "--json")).changedFiles, []);
  json(f.call("setup", "--default-model", "default", "--default-effort", "default", "--ultra-routine-model", "default", "--json"));
  assert.deepEqual(readWorkerDefaults(f.env), BUILTIN);
  assert.equal(fs.readFileSync(file, "utf8"), original);
});

test("worker defaults reject unsafe tokens and mixed setup changes without writes and tolerate malformed preferences", () => {
  const f = fixture(), file = preferenceFile(f), before = snapshot(f.dir);
  for (const args of [
    ["--default-model", "../model"], ["--ultra-routine-model", "has spaces"],
    ["--default-effort", "unlisted"], ["--default-model", "valid", "--sync-tools"]
  ]) {
    assert.equal(f.call("setup", ...args).status, 1, args.join(" "));
    assert.deepEqual(snapshot(f.dir), before);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const text of ['defaultModel = "unterminated', 'defaultModel = "bad/model"\ndefaultEffort = "HIGH"\n', 'defaultModel = "one"\ndefaultModel = "two"\n']) {
    fs.writeFileSync(file, text);
    assert.deepEqual(readWorkerDefaults(f.env), BUILTIN);
    assert.equal(fs.readFileSync(file, "utf8"), text);
  }
  fs.rmSync(file); fs.mkdirSync(file);
  assert.deepEqual(readWorkerDefaults(f.env), BUILTIN);
});

test("model setup validates both tiers against the isolated catalog and warns when it is unavailable", () => {
  const f = fixture(), file = preferenceFile(f), cache = path.join(f.env.CODEX_COMPANION_HOME, "models_cache.json");
  fs.mkdirSync(path.dirname(cache), { recursive: true });
  const models = [{ slug: "fixture-hidden", visibility: "hide" }];
  fs.writeFileSync(cache, JSON.stringify({ fetched_at: new Date().toISOString(), models }));
  const before = snapshot(f.dir);
  const unknown = f.call("setup", "--default-model", "unknown-model", "--json");
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /duet models/);
  assert.equal(f.call("setup", "--ultra-routine-model", "unknown-model").status, 1);
  assert.deepEqual(snapshot(f.dir), before);
  const saved = json(f.call("setup", "--default-model", "fixture-hidden", "--ultra-routine-model", "fixture-hidden", "--json"));
  assert.equal(saved.defaultModel.value, "fixture-hidden");
  assert.equal(saved.ultraRoutineModel.value, "fixture-hidden");
  json(f.call("setup", "--default-model", "default", "--ultra-routine-model", "default", "--json"));
  assert.deepEqual(readWorkerDefaults(f.env), BUILTIN);
  fs.writeFileSync(cache, JSON.stringify({ fetched_at: new Date(Date.now() - 48 * 3600000).toISOString(), models }));
  const stale = f.call("setup", "--default-model", "new-worker", "--json");
  fs.writeFileSync(cache, JSON.stringify({ models }));
  const undated = f.call("setup", "--ultra-routine-model", "new-routine", "--json");
  assert.deepEqual([stale, undated].map(result => ({ status: result.status,
    ageWarning: result.status === 0 && JSON.parse(result.stdout).warnings.some(warning => /cache.*(?:48 hours|unknown age).*duet models/.test(warning))
  })), [{ status: 0, ageWarning: true }, { status: 0, ageWarning: true }]);
  fs.rmSync(cache);
  const unchecked = json(f.call("setup", ...SETTINGS, "--json"));
  assert.ok(unchecked.warnings.some(warning => /could not be checked.*duet models/.test(warning)));
  assert.equal(readWorkerDefaults(f.env).model, "saved-worker");
  assert.ok(fs.existsSync(file));
});

test("tasks accept cached default efforts, explicit overrides and recorded follow-up settings", () => {
  const f = fixture("task-ok");
  fs.mkdirSync(f.env.CODEX_COMPANION_HOME, { recursive: true });
  fs.writeFileSync(path.join(f.env.CODEX_COMPANION_HOME, "models_cache.json"), JSON.stringify({ models: [
    { slug: "fixture-worker", visibility: "hide", supported_reasoning_levels: [{ effort: "ultra" }] },
    { slug: "saved-worker" }, { slug: "changed-worker" }
  ] }));
  json(f.call("setup", "--default-model", "saved-worker", "--default-effort", "ultra", "--json"));
  assert.equal(direct(f.call("task", "--direct", "--effort", "unlisted", "fixture"), 1).status, "error");
  assert.equal(fs.existsSync(path.join(f.dir, "fake-codex-state.json")), false);
  const task = (...flags) => {
    const report = direct(f.call("task", "--direct", ...flags, "fixture"));
    assert.equal(report.status, "completed");
    return { report, turn: f.state().lastTurnStart };
  };
  const saved = task();
  assert.deepEqual([saved.turn.model, saved.turn.effort], ["saved-worker", "ultra"]);
  const explicit = task("--model", "spark", "--effort", "max");
  assert.deepEqual([explicit.turn.model, explicit.turn.effort], ["gpt-5.3-codex-spark", "max"]);
  json(f.call("setup", "--default-model", "changed-worker", "--default-effort", "medium", "--json"));
  const resumed = task("--to", saved.report.worker);
  assert.deepEqual([resumed.turn.threadId, resumed.turn.model, resumed.turn.effort], [saved.turn.threadId, "saved-worker", "ultra"]);
});

test("reviews honor saved model and effort defaults, validate efforts and accept explicit overrides", () => {
  const f = fixture("review-ok");
  json(f.call("setup", "--default-model", "saved-reviewer", "--default-effort", "medium", "--json"));
  fs.writeFileSync(path.join(f.repo, "untracked.txt"), "reviewable work\n");
  for (const command of ["review", "adversarial-review"]) {
    const invalid = f.call(command, "--effort", "unlisted", "--json");
    assert.equal(invalid.status, 1, invalid.stderr);
    assert.match(invalid.stderr, /Unsupported reasoning effort/);
    const review = (...flags) => {
      json(f.call(command, "--scope", "working-tree", "--json", ...flags));
      const state = f.state();
      return command === "review"
        ? [state.lastThreadStart.model, state.lastThreadStart.config?.model_reasoning_effort]
        : [state.lastTurnStart.model, state.lastTurnStart.effort];
    };
    assert.deepEqual(review(), ["saved-reviewer", "medium"]);
    assert.deepEqual(review("--model", "explicit-reviewer", "--effort", "high"), ["explicit-reviewer", "high"]);
  }
});

test("startup, mode status and reminders expose effective worker models without starting a runtime", () => {
  const f = fixture();
  json(f.call("setup", ...SETTINGS, "--json"));
  f.env.CODEX_COMPANION_BIN = path.join(f.dir, "missing-codex");
  const start = run(process.execPath, [hook, "SessionStart"], { cwd: f.repo, env: f.env, input: JSON.stringify({ cwd: f.repo }) });
  assert.equal(start.status, 0, start.stderr);
  json(f.call("ultra-codex", "on", "--json"));
  const status = f.call("ultra-codex", "status");
  const reminder = run(process.execPath, [new URL("../plugins/codex/scripts/ultra-codex-hook.mjs", import.meta.url).pathname], {
    cwd: f.repo, env: f.env, input: JSON.stringify({ cwd: f.repo, session_id: f.env.CODEX_COMPANION_SESSION_ID, prompt: "task" })
  });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(reminder.status, 0, reminder.stderr);
  assert.ok(start.stdout.includes("saved-worker") && [status.stdout, reminder.stdout].every(text => ["saved-worker", "saved-routine"].every(model => text.includes(model))));
  assert.equal(fs.existsSync(path.join(f.dir, "fake-codex-state.json")), false);
});
