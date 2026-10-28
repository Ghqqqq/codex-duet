import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTempDir, run } from "./helpers.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { classifyRuntimeError } from "../plugins/codex/scripts/lib/runtime-errors.mjs";
import { codexRuntimeDiagnostic } from "../plugins/codex/scripts/lib/codex-home.mjs";
const script = new URL("../plugins/codex/scripts/codex-companion.mjs", import.meta.url).pathname;
for (const [message, reason] of [
  ["workspace routing discovery timed out", "timeout"],
  ["connect EPERM /tmp/runtime.sock", "sandbox-or-permission"],
  ["connect ECONNREFUSED", "socket"],
  ["getaddrinfo ENOTFOUND api.example.test", "network"]
]) test(`setup classifies ${reason} without suggesting login`, () => {
  const bin = makeTempDir();
  installFakeCodex(bin, `auth-error:${message}`);
  const result = run(process.execPath, [script, "setup", "--json"], { env: buildEnv(bin) });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ready, false);
  assert.equal(report.auth.status, "unreachable");
  assert.equal(report.auth.reason, reason);
});
test("confirmed logout still prints isolated login, unknown runtime errors do not", () => {
  const bin = makeTempDir();
  installFakeCodex(bin, "logged-out");
  const result = run(process.execPath, [script, "setup", "--json"], { env: buildEnv(bin) });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.auth.status, "unauthenticated");
  assert.equal(classifyRuntimeError(new Error("config/read failed")).status, "unknown");
  assert.equal(classifyRuntimeError(new Error("authentication expired")).status, "unauthenticated");
});

test("setup reports an invokable duet when CODEX_COMPANION is unset", () => {
  const bin = makeTempDir("duet14-a-"); installFakeCodex(bin);
  const duet = new URL("../plugins/codex/bin/duet", import.meta.url).pathname;
  fs.symlinkSync(duet, path.join(bin, "duet"));
  const env = { ...buildEnv(bin), CODEX_COMPANION_HOME: path.join(bin, "isolated"), CODEX_COMPANION: undefined };
  const result = run(process.execPath, [script, "setup", "--json"], { cwd: bin, env });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ready, true);
  assert.deepEqual(report.invocation, { duet: { available: true, path: path.join(bin, "duet") }, companionEnv: { set: false, path: null } });
  assert.equal(report.codex.source, "PATH");
  assert.equal(report.codex.executable, path.join(bin, "codex"));
  const command = run(report.invocation.duet.path, ["status", "--json"], { cwd: bin, env });
  assert.equal(command.status, 0, command.stderr);
});

test("setup identifies the selected broken pin while a working PATH runtime remains available", () => {
  const bin = makeTempDir("duet14-a-"); installFakeCodex(bin);
  const home = path.join(bin, "isolated"), missing = path.join(bin, "missing-codex");
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, "runtime.json"), JSON.stringify({ codexBinary: missing }));
  const env = { ...buildEnv(bin), CODEX_COMPANION_HOME: home };
  for (const source of ["runtime.json", "CODEX_COMPANION_BIN"]) {
    if (source === "CODEX_COMPANION_BIN") env.CODEX_COMPANION_BIN = path.join(bin, "missing-env-codex");
    const result = run(process.execPath, [script, "setup", "--json"], { cwd: bin, env });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ready, false); assert.equal(report.codex.available, false);
    assert.equal(report.codex.source, source);
    assert.equal(report.codex.executable, env.CODEX_COMPANION_BIN || missing);
    assert.deepEqual(report.codex.pathCodex, { path: path.join(bin, "codex"), available: true });
  }
  delete env.CODEX_COMPANION_BIN;
  fs.rmSync(path.join(home, "runtime.json"));
  const repaired = run(process.execPath, [script, "setup", "--json"], { cwd: bin, env });
  assert.equal(repaired.status, 0, repaired.stderr);
  assert.equal(JSON.parse(repaired.stdout).ready, true, "removing the pin restores the existing PATH runtime without reinstalling");

  for (const location of [".codex/plugins/.plugin-appserver/codex-cli/bin/codex", "ChatGPT.app/Contents/Resources/codex-cli/codex", "stable/codex"]) {
    const executable = path.join(bin, location), managed = !location.startsWith("stable/");
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.copyFileSync(path.join(bin, "codex"), executable);
    const pin = JSON.stringify({ codexBinary: executable });
    fs.writeFileSync(path.join(home, "runtime.json"), pin);
    const setup = run(process.execPath, [script, "setup", "--json"], { cwd: bin, env });
    assert.equal(setup.status, 0, setup.stderr);
    const report = JSON.parse(setup.stdout);
    assert.equal(report.ready, true);
    assert.equal(report.codex.source, "runtime.json");
    assert.equal(report.codex.warning?.code ?? null, managed ? "desktop_managed_codex_runtime" : null);
    if (managed) assert.ok(report.nextSteps.includes(report.codex.warning.message));
    assert.equal(fs.readFileSync(path.join(home, "runtime.json"), "utf8"), pin);

    // A private override and PATH can both select a symlink into the app bundle.
    const aliasDir = path.join(bin, `alias-${managed ? location.split("/")[0] : "stable"}`);
    fs.mkdirSync(aliasDir, { recursive: true });
    const alias = path.join(aliasDir, "codex"); fs.symlinkSync(executable, alias);
    for (const source of ["CODEX_COMPANION_BIN", "PATH"]) {
      fs.rmSync(path.join(home, "runtime.json"), { force: true });
      const selected = { ...env, CODEX_COMPANION_BIN: source === "CODEX_COMPANION_BIN" ? alias : "", PATH: `${aliasDir}${path.delimiter}${env.PATH}` };
      const diagnostic = codexRuntimeDiagnostic(bin, { available: true }, selected);
      assert.equal(diagnostic.source, source);
      assert.equal(diagnostic.warning?.code ?? null, managed ? "desktop_managed_codex_runtime" : null);
    }
  }
});
