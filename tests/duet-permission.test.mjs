import "./test-environment.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { run, makeTempDir } from "./helpers.mjs";
import { COMMAND_OPTIONS } from "../plugins/codex/scripts/lib/command-options.mjs";

const script = fileURLToPath(new URL("../plugins/codex/scripts/duet-permission-hook.mjs", import.meta.url));
const launcher = fs.realpathSync(fileURLToPath(new URL("../plugins/codex/bin/duet", import.meta.url)));
const quotedLauncher = `'${launcher.replace(/'/g, `'"'"'`)}'`;

test("PreToolUse permits only the single-command duet grammar with trusted session and launcher", t => {
  const heredoc = (head, delimiter = "DUET_TASK") => `${head} <<'${delimiter}'\nLiteral $(body); pipes | and \"quotes\"\n${delimiter}`;
  const rows = [
    [heredoc("duet task --model gpt-6-astra --effort xhigh --normal"), true, { dangerouslyDisableSandbox: true }],
    [heredoc("duet task --sandbox read-only --cwd '/tmp/a b'"), true, { dangerouslyDisableSandbox: true }],
    [heredoc("duet task --sandbox workspace-write"), true],
    [heredoc("duet task --fork"), true],
    [heredoc("duet task --fork --source '/tmp/a b/session.jsonl'"), true],
    [heredoc("duet task --fresh --no-claude-md"), true],
    [heredoc("duet task --continue job_1 --cwd '/tmp/a b'"), true],
    [heredoc("duet task --to Ada --sandbox read-only --normal"), true],
    [heredoc("duet task --resume-last --owner owner_1 --lease-sec 1800 --question-timeout-sec 900 --report"), true],
    [heredoc("duet task --resume -m gpt-6-astra -C '/tmp/a b' --sandbox=read-only --quiet=true"), true],
    ["duet task --timeout-sec 570", true], ["duet wait Ada --timeout-sec 570", true],
    [heredoc("duet task --fresh --model gpt-6-astra --effort xhigh --normal --cwd '/tmp/a b'"), true],
    [heredoc("duet task --to Ada --fast --quiet --timeout-sec 30"), true],
    [heredoc("duet task --thread thread_1 --direct --session session-a"), true],
    [heredoc("duet answer Ada", "DUET_ANSWER"), true],
    [heredoc("duet answer Ada --question question_1 --owner owner_1 --direct --quiet --timeout-sec 30", "DUET_ANSWER"), true, { dangerouslyDisableSandbox: true }],
    ["duet wait job_1 --owner 'owner_1' --after-question question_1 --report", true, { dangerouslyDisableSandbox: true }],
    ["duet wait Ada", true], ["duet result Ada", true],
    ["duet wait Ada --timeout-sec 30 --quiet --details", true],
    ["duet result Ada --details --cwd /tmp", true],
    ["duet result --thread thread_1 --report --json", true],
    ["duet status Ada --all --json --wait --timeout-ms 1000 --poll-interval-ms 100 --owner owner_1", true],
    ["duet status --thread thread_1", true], ["duet cancel Ada --json", true],
    ["duet wait --help", true], ["duet result -h", true],
    ["duet status", true], ["duet cancel Ada", true], ["duet task --help", true],
    ["duet status | cat", false], ["duet status; id", false], ["duet status && id", false],
    ["duet status > /tmp/report", false], ["X=1 duet status", false], ["duet task --cwd $(pwd)", false],
    ['duet task --cwd "/tmp"', false], ["duet task --unknown", false], ["duet setup", false],
    ["duet transfer", false], ["duet journal show", false], ["duet cleanup", false],
    ["duet task --approve-browser-origin https://example.com", false],
    ["duet task --approve-computer-app com.example.App", false],
    ["duet task --write", false], ["duet task --write=false", false],
    ["duet task --approval-policy never", false],
    ["duet task --sandbox invalid", false], ["duet task --source '/tmp/session.jsonl'", false],
    ["duet task --fork --thread thread_1", false], ["duet task --continue job_1 --sandbox read-only", false],
    ["duet task --fork --source", false], ["duet task --no-claude-md false", false],
    ["duet task --lease-sec 0", false], ["duet wait Ada --sandbox read-only", false],
    ["duet task --json", false], ["duet wait Ada --feed-limit 10", false], ["duet answer Ada --json", false],
    ["duet task --direct=false", false],
    [heredoc("duet task <<'SECOND'"), false], [heredoc("duet task") + "\nid", false],
    ["duet status", true, { dangerouslyDisableSandbox: true }],
    ["duet status; id", false, { dangerouslyDisableSandbox: true }],
    ["duet task --approve-browser-origin https://example.com", false, { dangerouslyDisableSandbox: true }],
    ["duet status --session another-session", false], ["duet status --session session-a --session session-a", false],
    ["duet task --fast --normal", false], ["duet task --to Ada --fresh", false],
    ["duet task brief-on-command-line", false], ["duet wait Ada <<'DUET_TASK'\ntext\nDUET_TASK", false],
    ["duet task <<DUET_TASK\ntext\nDUET_TASK", false], ["duet task --prompt-file /tmp/brief", false],
    ["duet status\r\n", false], ["duet status\0", false], ["duet task --effort impossible", false],
    ["duet answer Ada --timeout-sec 0", false], ["duet task --sandbox danger-full-access", true],
    ['node "$CODEX_COMPANION" status', false], [heredoc("duet task", "ABC"), true],
    ["duet status\n", true], [`${quotedLauncher} status`, true], [`${launcher} status`, true],
    ["/tmp/duet status", false], ["'duet' status", false], ["duet 'status'", false],
    ["duet task --tool-use-id tool-a", false], ["duet task --tool-use-id foreign", false],
    ["duet answer Ada --tool-use-id foreign", false], ["duet wait Ada --tool-use-id foreign", false]
  ];
  assert.deepEqual(COMMAND_OPTIONS.task.internalValueOptions, ["session-cwd", "dispatch-nonce", "tool-use-id"]);
  for (const [verb, schema] of Object.entries(COMMAND_OPTIONS)) {
    for (const name of schema.internalValueOptions ?? []) {
      assert.ok(!schema.valueOptions.includes(name), `${verb} --${name} is internal`);
      const value = name === "session-cwd" ? "/tmp/session" : name === "tool-use-id" ? "tool-a" : "x";
      for (const separator of [" ", "="]) {
        const head = `duet ${verb}${verb === "task" ? "" : " Ada"} --${name}${separator}${value}`;
        rows.push([verb === "wait" ? head : heredoc(head), false]);
      }
    }
  }
  const config = makeTempDir("duet14-fx6-permission-");
  const env = { ...process.env, CLAUDE_CONFIG_DIR: config, PATH: path.dirname(process.execPath) };
  const input = (command, extra = {}) => ({ hook_event_name: "PreToolUse", tool_name: "Bash", permission_mode: "default",
    session_id: "session-a", tool_use_id: "tool-a", cwd: process.cwd(), tool_input: { command, run_in_background: true, timeout: 1000, description: "Fixture", ...extra } });
  const invoke = (payload, overrides = {}) => {
    const result = run(process.execPath, [script], { env: { ...env, ...overrides }, input: JSON.stringify(payload) });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  for (const [command, allowed, extra] of rows) {
    const payload = input(command, extra), result = invoke(payload);
    t.diagnostic(JSON.stringify({ command, ...(extra ?? {}), output: result }));
    if (!allowed) { assert.deepEqual(result, {}, command); continue; }
    const updated = result.hookSpecificOutput;
    assert.equal(updated.permissionDecision, "allow", command);
    assert.deepEqual({ ...updated.updatedInput, command }, payload.tool_input);
    const head = command.split("\n")[0];
    const insertion = head.includes(" <<'") ? head.indexOf(" <<'") : head.length;
    const executable = command.startsWith("duet ") ? "duet" : command.startsWith(quotedLauncher) ? quotedLauncher : launcher;
    const words = command.slice(executable.length, insertion).match(/'[^']*'|[^ \t]+/g).map(word => word.startsWith("'") ? word.slice(1, -1) : word);
    const binding = [...(command.includes("--session session-a") ? [] : ["--session", "session-a"]),
      ...(["task", "answer", "wait"].includes(words[0]) ? ["--tool-use-id", "tool-a"] : [])];
    const expected = `${quotedLauncher} ${[...words, ...binding].map(word => `'${word}'`).join(" ")}${command.slice(insertion)}`;
    assert.equal(updated.updatedInput.command, expected);
    const repeated = invoke({ ...payload, tool_input: updated.updatedInput });
    if (expected.includes("--tool-use-id")) assert.deepEqual(repeated, {}, "an internal binding supplied in a command is never auto-approved");
    else assert.equal(repeated.hookSpecificOutput.updatedInput.command, expected);
  }
  const probe = path.join(config, "probe"), log = path.join(config, "calls.jsonl"), shellFile = path.join(config, "command.sh");
  fs.writeFileSync(probe, `#!${process.execPath}\nconst fs = require('node:fs'); fs.appendFileSync(process.env.PROBE_LOG, JSON.stringify({ argv: process.argv.slice(2), stdin: fs.readFileSync(0, 'utf8') }) + '\\n');\n`, { mode: 0o755 });
  for (const value of ["G", "L", "=duet", "=nonexistent_duet"]) {
    const original = heredoc(`duet task --cwd ${value}`);
    const rewritten = invoke(input(original)).hookSpecificOutput.updatedInput.command;
    fs.writeFileSync(shellFile, `'${probe}'${rewritten.slice(quotedLauncher.length)}`);
    for (const shell of ["/bin/bash", "/bin/zsh"].filter(fs.existsSync)) {
      fs.writeFileSync(log, "");
      const aliases = shell.endsWith("zsh") ? "alias -g G='x; extra_probe' L='| extra_probe' session-a=foreign tool-a=other-tool task=other-task --session=--foreign-session\n" : "";
      const executed = run(shell, [...(shell.endsWith("zsh") ? ["-f"] : ["--noprofile", "--norc"]), "-c",
        `extra_probe() { printf '%s\\n' extra >> '${log}'; }\n${aliases}source '${shellFile}'`], { env: { ...env, PROBE_LOG: log } });
      assert.equal(executed.status, 0, executed.stderr);
      assert.deepEqual(fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse), [{
        argv: ["task", "--cwd", value, "--session", "session-a", "--tool-use-id", "tool-a"],
        stdin: original.slice(original.indexOf("\n") + 1, original.lastIndexOf("DUET_TASK"))
      }]);
    }
  }
  const collision = makeTempDir("duet14-c-path-");
  fs.writeFileSync(path.join(collision, "duet"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  assert.deepEqual(invoke(input("duet status"), { PATH: `${collision}:${env.PATH}` }), {});
  assert.deepEqual(invoke(input("duet status"), { BASH_FUNC_duet__: "() { :; }", "BASH_FUNC_duet%%": "() { :; }" }), {});
  for (const permission_mode of ["default", "bypassPermissions", "acceptEdits", "dontAsk", "auto"]) {
    const result = invoke({ ...input("duet task", { dangerouslyDisableSandbox: true }), permission_mode }).hookSpecificOutput;
    assert.equal(result.permissionDecision, "allow");
    assert.equal(result.updatedInput.dangerouslyDisableSandbox, true);
    assert.equal(result.updatedInput.command, `${quotedLauncher} 'task' '--session' 'session-a' '--tool-use-id' 'tool-a'`);
  }
  for (const permission_mode of [undefined, "plan"]) assert.deepEqual(invoke({ ...input("duet task"), permission_mode }), {});
  for (const verb of ["task", "answer Ada", "wait Ada"]) {
    for (const tool_use_id of [undefined, "", "foreign;id", "x".repeat(129)]) assert.deepEqual(invoke({ ...input(`duet ${verb}`), tool_use_id }), {});
  }
});

test("harmless aliases and helper text never suppress the absolute launcher or delivery bindings", () => {
  const root = makeTempDir("duet14-first-context-shell-");
  const env = { ...process.env, HOME: root, CLAUDE_CONFIG_DIR: "", PATH: `${path.dirname(launcher)}:${process.env.PATH}`, CODEX_COMPANION_HOME: path.join(root, "isolated") };
  const snapshots = path.join(root, ".claude", "shell-snapshots"), snapshot = path.join(snapshots, "snapshot-bash-fixture.sh");
  const invoke = (permission_mode, command = "duet wait Ada") => {
    const result = run(process.execPath, [script], { env, input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", permission_mode,
      session_id: "session-a", tool_use_id: "tool-a", cwd: root, tool_input: { command } }) });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const expected = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow",
    updatedInput: { command: `${quotedLauncher} 'wait' 'Ada' '--session' 'session-a' '--tool-use-id' 'tool-a'` } } };
  const check = () => {
    for (const mode of ["default", "bypassPermissions"]) assert.deepEqual(invoke(mode), expected);
    assert.deepEqual(invoke("plan"), {});
  };
  check(); // Missing snapshots do not suppress binding.
  fs.mkdirSync(snapshots, { recursive: true });
  fs.writeFileSync(snapshot, `alias duet=${quotedLauncher}\nhelper() { printf '%s\\n' 'Use duet() in examples'; }\n`);
  check();
  fs.utimesSync(snapshot, new Date(0), new Date(0));
  check(); // Stale setup has no effect either.
  const command = invoke("default", "duet status").hookSpecificOutput.updatedInput.command;
  const pinned = run("/bin/bash", ["--noprofile", "--norc", "-c", command], { cwd: root, env });
  const direct = run(launcher, ["status", "--session", "session-a"], { cwd: root, env });
  assert.equal(pinned.status, 0, pinned.stderr);
  assert.equal(pinned.stdout, direct.stdout);
});
