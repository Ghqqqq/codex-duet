import "./test-environment.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";

import { runCommand, spawnOwned, terminateProcessTree } from "../plugins/codex/scripts/lib/process.mjs";

test("duet launcher reports companion import failures and preserves its exit code", t => {
  const directory = fs.mkdtempSync(path.join(process.env.CODEX_COMPANION_TEST_ROOT, "launcher-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bin = path.join(directory, "bin"), scripts = path.join(directory, "scripts");
  fs.mkdirSync(bin); fs.mkdirSync(scripts);
  const launcher = path.join(bin, "duet"), companion = path.join(scripts, "codex-companion.mjs");
  fs.copyFileSync(new URL("../plugins/codex/bin/duet", import.meta.url), launcher);
  fs.copyFileSync(new URL("../plugins/codex/bin/package.json", import.meta.url), path.join(bin, "package.json"));
  const failure = 'throw new Error("fixture companion import failure");\n';
  fs.writeFileSync(companion, failure);
  const invoke = () => runCommand(process.execPath, ["--unhandled-rejections=warn", launcher, "status"], {
    env: { ...process.env, CODEX_COMPANION_SESSION_ID: "fixture-session" }
  });
  const failed = invoke();
  assert.match(failed.stderr, /fixture companion import failure/);
  assert.equal(failed.status, 1, failed.stderr);
  assert.doesNotMatch(failed.stderr, /UnhandledPromiseRejectionWarning/);
  fs.writeFileSync(companion, `process.exitCode = 23;\n${failure}`);
  const selected = invoke();
  assert.match(selected.stderr, /fixture companion import failure/);
  assert.equal(selected.status, 23, selected.stderr);
});

test("Windows npm shims use a quoted cmd invocation for launches and readiness probes", t => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32" });
  t.after(() => { Object.defineProperty(process, "platform", platform); t.mock.restoreAll(); syncBuiltinESMExports(); });
  const shim = String.raw`C:\Program Files\npm\codex.CMD`;
  const env = { ...process.env, PATH: String.raw`C:\missing;"C:\Program Files\npm"`, PATHEXT: ".EXE;.CMD", ComSpec: String.raw`C:\Windows\System32\cmd.exe`, SHELL: "bash.exe" };
  t.mock.method(fs, "accessSync", file => { if (file !== shim) throw Object.assign(new Error("missing"), { code: "ENOENT" }); });
  t.mock.method(fs, "statSync", () => ({ isFile: () => true }));
  const calls = [];
  t.mock.method(childProcess, "spawn", (command, args, options) => { calls.push({ command, args, options }); return {}; });
  t.mock.method(childProcess, "spawnSync", (command, args, options) => { calls.push({ command, args, options }); return { status: 0 }; });
  syncBuiltinESMExports();
  const args = ["login", "", 'sqlite_home="C:\\User Data\\isolated"', "a&b", "tail\\"];
  spawnOwned("codex", args, { env, stdio: "inherit" });
  runCommand("codex", args, { env });
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.command, env.ComSpec);
    assert.deepEqual(call.args, ["/d", "/s", "/c", String.raw`"C:\Program^ Files\npm\codex.CMD ^"login^" ^"^" ^"sqlite_home=\^"C:\User^ Data\isolated\^"^" ^"a^&b^" ^"tail\\^""`]);
    assert.equal(call.options.shell, false);
    assert.equal(call.options.windowsVerbatimArguments, true);
    assert.equal(call.options.env.CODEX_HOME, env.CODEX_HOME);
  }
  assert.equal(calls[0].options.stdio, "inherit");
  assert.deepEqual(args, ["login", "", 'sqlite_home="C:\\User Data\\isolated"', "a&b", "tail\\"]);
});

test("Windows native executable paths with spaces preserve literal argv without a shell", async t => {
  const directory = fs.mkdtempSync(path.join(process.env.CODEX_COMPANION_TEST_ROOT, "Bin Space-"));
  const executable = path.join(directory, "codex.exe");
  // A real native executable on Windows; a shebang fixture exercises the same
  // direct-spawn boundary on POSIX while selecting our win32 branch.
  if (process.platform === "win32") fs.copyFileSync(process.execPath, executable);
  else fs.writeFileSync(executable, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o755 });
  const args = ["", "value with spaces", 'sqlite_home="C:\\User Data\\isolated"', "a&b;%PATH%", "tail\\"];
  const commandArgs = process.platform === "win32" ? ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", "--", ...args] : args;
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32" });
  t.after(() => { Object.defineProperty(process, "platform", platform); fs.rmSync(directory, { recursive: true, force: true }); });
  const result = runCommand(executable, commandArgs, { env: { ...process.env, SHELL: "/bin/sh" } });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), args);
  const child = spawnOwned(executable, commandArgs, { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  assert.equal(code, 0, stderr);
  assert.deepEqual(JSON.parse(stdout), args);
});

test("terminateProcessTree uses taskkill on Windows", () => {
  let captured = null;
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      captured = { command, args };
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: "",
        stderr: "",
        error: null
      };
    },
    killImpl() {
      throw new Error("kill fallback should not run");
    }
  });

  assert.deepEqual(captured, {
    command: "taskkill",
    args: ["/PID", "1234", "/T", "/F"]
  });
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, "taskkill");
});

test("terminateProcessTree treats missing Windows processes as already stopped", () => {
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      return {
        command,
        args,
        status: 128,
        signal: null,
        stdout: "ERROR: The process \"1234\" not found.",
        stderr: "",
        error: null
      };
    }
  });

  assert.equal(outcome.attempted, true);
  assert.equal(outcome.method, "taskkill");
  assert.equal(outcome.result.status, 128);
  assert.match(outcome.result.stdout, /not found/i);
});
