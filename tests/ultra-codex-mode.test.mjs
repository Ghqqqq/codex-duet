import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDir, initGitRepo, run } from "./helpers.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { PROTOCOL_PATH, protocolVersion, readMode, reminderText, setMode } from "../plugins/codex/scripts/lib/ultra-codex-mode.mjs";
import { resolveStateDir } from "../plugins/codex/scripts/lib/state.mjs";

const script = new URL("../plugins/codex/scripts/codex-companion.mjs", import.meta.url).pathname;
const promptHook = new URL("../plugins/codex/scripts/ultra-codex-hook.mjs", import.meta.url).pathname;
const lifecycleHook = new URL("../plugins/codex/scripts/session-lifecycle-hook.mjs", import.meta.url).pathname;
const SESSION = "11111111-aaaa-4bbb-8ccc-000000000001";

function fixture() {
  const dir = makeTempDir(); installFakeCodex(dir);
  const repo = path.join(dir, "repo"); fs.mkdirSync(repo); initGitRepo(repo);
  const baseEnv = { ...buildEnv(dir), CODEX_COMPANION_HOME: path.join(dir, "isolated"), CLAUDE_PLUGIN_DATA: path.join(dir, "data") };
  const env = { ...baseEnv, CODEX_COMPANION_SESSION_ID: SESSION };
  const call = (...args) => run(process.execPath, [script, ...args], { cwd: repo, env });
  const json = result => { assert.equal(result.status, 0, result.stderr + result.stdout); return JSON.parse(result.stdout); };
  const prompt = (text, sessionId = SESSION, extra = {}) => run(process.execPath, [promptHook], { cwd: repo, env: baseEnv, input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: sessionId, cwd: repo, prompt: text, ...extra }) });
  const lifecycle = (event, input) => run(process.execPath, [lifecycleHook, event], { cwd: repo, env: baseEnv, input: JSON.stringify({ hook_event_name: event, cwd: repo, ...input }) });
  const modeFile = sessionId => path.join(resolveStateDir(repo, baseEnv), "ultra-codex", `${sessionId}.json`);
  return { dir, repo, env, baseEnv, call, json, prompt, lifecycle, modeFile };
}
test("ultra-codex mode is a per-session switch: on/off/status, the prompt reminder, and session cleanup", () => {
  const f = fixture();
  // Off by default; status never needs the session id and the preamble points to the protocol.
  const off = f.json(f.call("ultra-codex", "status", "--json"));
  assert.deepEqual([off.mode, off.sessionId, off.protocolFile], ["off", SESSION, PROTOCOL_PATH]);
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
  assert.equal(fs.statSync(f.modeFile(SESSION)).mode & 0o777, 0o600);
  const reminder = f.prompt("refactor the parser so it streams");
  assert.equal(reminder.status, 0, reminder.stderr);
  assert.ok(reminder.stdout.trim().length > 0);
  assert.equal(f.prompt("/codex:ultra-codex off").stdout, "", "the command's own prompt gets no reminder");
  assert.equal(f.prompt("/ultra-codex status").stdout, "", "nor the user-level alias");
  assert.equal(f.prompt("refactor", "22222222-aaaa-4bbb-8ccc-000000000002").stdout, "", "another session in the same repository is unaffected");
  assert.equal(f.prompt("refactor", undefined, { session_id: undefined }).stdout, "", "no session id, no reminder");
  assert.equal(run(process.execPath, [promptHook], { cwd: f.repo, env: f.baseEnv, input: "not json" }).status, 0, "a broken hook input never blocks the prompt");
  // on again keeps `since` and the worker cap unless given; scale follows the flags.
  const again = f.json(f.call("ultra-codex", "on", "--json"));
  assert.deepEqual([again.scale, again.maxWorkers, again.since], ["auto", 4, on.since]);
  // Resume and compact keep the mode; a fresh start or /clear for the same id drops it.
  for (const source of ["resume", "compact"]) {
    assert.equal(f.lifecycle("SessionStart", { session_id: SESSION, source }).status, 0, source);
    assert.ok(fs.existsSync(f.modeFile(SESSION)), `${source} keeps the mode`);
  }
  assert.equal(f.lifecycle("SessionStart", { session_id: SESSION, source: "clear" }).status, 0);
  assert.equal(fs.existsSync(f.modeFile(SESSION)), false, "/clear starts without the mode");
  // Off: idempotent, reports what ran, and the reminder stops.
  f.json(f.call("ultra-codex", "on", "--json"));
  const turnedOff = f.json(f.call("ultra-codex", "off", "--json"));
  assert.deepEqual([turnedOff.mode, turnedOff.wasOn, turnedOff.runningJobs], ["off", true, []]);
  assert.equal(fs.existsSync(f.modeFile(SESSION)), false);
  assert.equal(f.prompt("refactor the parser").stdout, "");
  const alreadyOff = f.call("ultra-codex", "off");
  assert.equal(alreadyOff.status, 0, alreadyOff.stderr);
  // SessionEnd clears a mode left on.
  f.json(f.call("ultra-codex", "on", "--json"));
  assert.equal(f.lifecycle("SessionEnd", { session_id: SESSION }).status, 0);
  assert.equal(fs.existsSync(f.modeFile(SESSION)), false, "SessionEnd removes the mode");
  // A stale file from a session that never ended is pruned at the next start.
  const stale = setMode(f.repo, "33333333-aaaa-4bbb-8ccc-000000000003", {}, f.baseEnv);
  const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  fs.utimesSync(stale.file, old, old);
  assert.equal(f.lifecycle("SessionStart", { session_id: SESSION, source: "startup" }).status, 0);
  assert.equal(fs.existsSync(stale.file), false, "stale modes are pruned");
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
  const text = fs.readFileSync(PROTOCOL_PATH, "utf8");
  const version = protocolVersion(text);
  assert.match(version, /^[0-9a-f]{8}$/);
  assert.equal(text.split("\n")[0], `<!-- Ultra-codex protocol v${version} -->`);
  assert.notEqual(protocolVersion(`${text}\nA changed instruction.\n`), version);
  assert.equal(protocolVersion(text.replace(version, "00000000")), version, "the version line is excluded from the hash");
  const dir = makeTempDir(), file = path.join(dir, "protocol.md");
  fs.writeFileSync(file, text);
  const initial = reminderText({ scale: "auto", maxWorkers: 6 }, file);
  fs.appendFileSync(file, "Changed protocol body.\n");
  const changed = reminderText({ scale: "auto", maxWorkers: 6 }, file);
  assert.notEqual(initial, changed, "the next prompt hashes the current protocol, not a cached version");
  assert.ok(changed.includes(`v${protocolVersion(fs.readFileSync(file, "utf8"))}`));
});
