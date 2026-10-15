import test from "node:test";
import assert from "node:assert/strict";
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
  assert.ok(report.nextSteps.some(s => s.includes("dangerouslyDisableSandbox: true")));
  assert.doesNotMatch(report.nextSteps.join("\n"), /codex-isolated\.mjs.*login/);
});
test("confirmed logout still prints isolated login, unknown runtime errors do not", () => {
  const bin = makeTempDir();
  installFakeCodex(bin, "logged-out");
  const result = run(process.execPath, [script, "setup", "--json"], { env: buildEnv(bin) });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.auth.status, "unauthenticated");
  assert.match(report.nextSteps.join("\n"), /codex-isolated\.mjs.*login/);
  assert.equal(classifyRuntimeError(new Error("config/read failed")).status, "unknown");
  assert.equal(classifyRuntimeError(new Error("authentication expired")).status, "unauthenticated");
});
