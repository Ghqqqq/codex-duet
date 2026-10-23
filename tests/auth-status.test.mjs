import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTempDir, run } from "./helpers.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { classifyRuntimeError } from "../plugins/codex/scripts/lib/runtime-errors.mjs";
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
});
