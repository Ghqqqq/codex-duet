import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDir, initGitRepo, run } from "./helpers.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { PROTOCOL_PATH, readMode, reminderText, setMode } from "../plugins/codex/scripts/lib/ultra-codex-mode.mjs";
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

test("the protocol file carries the brief template and the acceptance protocol", () => {
  const protocol = fs.readFileSync(PROTOCOL_PATH, "utf8");
  for (const section of ["OBJECTIVE", "WHY", "CONTEXT I ALREADY KNOW", "INTERFACE CONTRACT", "OWNED PATHS", "NON-GOALS / DO NOT", "ACCEPTANCE CRITERIA", "VERIFY WITH", "WHEN TO ASK", "REPORT"]) assert.match(protocol, new RegExp(`^${section.replace(/[/]/g, "\\/")}:`, "m"), section);
  for (const step of ["Status gate", "Scope check", "Read the diff", "Criteria walk", "Verification audit", "Assumptions audit", "Decide"]) assert.match(protocol, new RegExp(`\\*\\*${step}`), step);
  for (const verdict of ["ACCEPT", "ACCEPT WITH GLUE", "REWORK", "REASSIGN"]) assert.match(protocol, new RegExp(`\\*\\*${verdict}\\*\\*`), verdict);
  for (const phase of ["Scout", "Understand", "Design", "Implement", "Accept", "Verify", "Integrate"]) assert.match(protocol, new RegExp(`\\*\\*${phase}\\*\\*`), phase);
  assert.match(protocol, /subagent_type: "codex:codex-worker"/);
  assert.match(protocol, /run_in_background: true/);
  assert.match(protocol, /create separate worktrees with `git worktree add`, pass each as `--cwd`/);
  assert.match(protocol, /## Writing a brief \(every Codex assignment\)/);
  assert.match(protocol, /Fallback only: use `Agent\(subagent_type: "codex:codex-worker"\)/);
  assert.match(protocol, /Never pass `model` or `effort` to that agent/);
  assert.match(protocol, /task --thread <threadId> --direct.*same `--cwd`/);
  assert.match(protocol, /Terminal status: run the acceptance protocol below, even if Bash exited nonzero/);
  assert.match(protocol, /0 for `completed`, 2 for `blocked`\/`needs_input`, and 1 for other terminal states; non-terminal returns exit 0/);
  assert.match(protocol, /default `--timeout-sec` is 3600 \(maximum 3600\); the default `--lease-sec` is 1800/);
  assert.match(protocol, /Do not combine `--direct` with `--follow`, `--detached`, `--background`, `--json`, `--feed-limit` or `--min-interval-sec`/);
  assert.match(protocol, /activityCount.*no `activity` list/);
  assert.match(protocol, /task --continue <jobId> --cwd <cwd> --direct/);
  assert.match(protocol, /never continue a user-stopped job automatically/);
  assert.match(protocol, /Substantive code is written by workers, not by you/);
  assert.match(protocol, /Drift is first a brief defect/);
  assert.match(protocol, /Never let a worker grade itself/);
  assert.match(protocol, /criterion → evidence → verdict/);
  assert.match(protocol, /## Scope of this protocol/);
  assert.doesNotMatch(protocol, /\$ARGUMENTS/, "arguments are substituted in the command file, not here");
});

test("ultra-codex mode is a per-session switch: on/off/status, the prompt reminder, and session cleanup", () => {
  const f = fixture();
  // Off by default; status never needs the session id and --for-command prints the protocol.
  const off = f.json(f.call("ultra-codex", "status", "--json"));
  assert.deepEqual([off.mode, off.sessionId, off.protocolFile], ["off", SESSION, PROTOCOL_PATH]);
  const forCommand = f.call("ultra-codex", "status", "--for-command");
  assert.equal(forCommand.status, 0, forCommand.stderr);
  assert.match(forCommand.stdout, /^Ultra-codex mode: off for this session/);
  assert.match(forCommand.stdout, /^OBJECTIVE:/m);
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
  assert.equal(reminder.stdout.trim(), reminderText(readMode(f.repo, SESSION, f.baseEnv)));
  assert.match(reminder.stdout, /scale: thorough; max workers: 4/);
  assert.match(reminder.stdout, /\/codex:ultra-codex off/);
  assert.ok(reminder.stdout.includes(PROTOCOL_PATH), "the reminder points at the protocol file");
  assert.ok(reminder.stdout.trim().split(/\s+/).length < 130, "the reminder stays short; it is paid on every prompt");
  assert.equal(f.prompt("/codex:ultra-codex off").stdout, "", "the command's own prompt gets no reminder");
  assert.equal(f.prompt("/ultra-codex status").stdout, "", "nor the user-level alias");
  assert.equal(f.prompt("refactor", "22222222-aaaa-4bbb-8ccc-000000000002").stdout, "", "another session in the same repository is unaffected");
  assert.equal(f.prompt("refactor", undefined, { session_id: undefined }).stdout, "", "no session id, no reminder");
  assert.equal(run(process.execPath, [promptHook], { cwd: f.repo, env: f.baseEnv, input: "not json" }).status, 0, "a broken hook input never blocks the prompt");
  // on again keeps `since` and the worker cap unless given; scale follows the flags.
  const again = f.json(f.call("ultra-codex", "on", "--json"));
  assert.deepEqual([again.scale, again.maxWorkers, again.since], ["auto", 4, on.since]);
  assert.match(f.call("ultra-codex", "status").stdout, /^Ultra-codex mode: on for this session since .* \(scale: auto; max workers: 4\)/);
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
  assert.match(alreadyOff.stdout, /already off/);
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

test("the slash command loads the protocol through its preamble and never passes task text through a shell", () => {
  const command = fs.readFileSync(new URL("../plugins/codex/commands/ultra-codex.md", import.meta.url), "utf8");
  assert.match(command, /^!`node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/codex-companion\.mjs" ultra-codex status --for-command`$/m);
  assert.match(command, /^`\$ARGUMENTS`$/m);
  assert.match(command, /ultra-codex off` with Bash/);
  assert.match(command, /ultra-codex on` with exactly those flags/);
  assert.match(command, /Never pass the task text through a shell command/);
  assert.doesNotMatch(command, /ultra-codex[^\n]*"\$ARGUMENTS"/, "the preamble takes no arguments");
});
