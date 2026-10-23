import "./test-environment.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { makeTempDir, initGitRepo, run } from "./helpers.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");

function read(relativePath) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, relativePath), "utf8");
}

test("hooks keep session-end cleanup and stop gating enabled", () => {
  const source = read("hooks/hooks.json");
  assert.match(source, /SessionStart/);
  assert.match(source, /SessionEnd/);
  assert.match(source, /stop-review-gate-hook\.mjs/);
  assert.match(source, /session-lifecycle-hook\.mjs/);
});

test("duet works through a symlink without companion/session env, forwards stdin and preserves exit codes", () => {
  const dir = makeTempDir("duet14-a-"), repo = path.join(dir, "repo");
  fs.mkdirSync(repo); initGitRepo(repo); installFakeCodex(dir);
  const launcher = path.join(PLUGIN_ROOT, "bin", "duet"), link = path.join(dir, "duet");
  fs.symlinkSync(launcher, link);
  const env = { ...buildEnv(dir), CODEX_COMPANION: undefined, CODEX_COMPANION_SESSION_ID: undefined, CODEX_COMPANION_HOME: path.join(dir, "isolated") };
  const result = run(link, ["task", "--cwd", repo], { cwd: dir, env, input: "Review this synthetic fixture. $(literal) `literal`\n" });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout.trim().split("\n").at(-1));
  assert.equal(report.status, "completed");
  const stored = run(link, ["result", report.worker, "--cwd", repo, "--json"], { cwd: dir, env });
  assert.equal(stored.status, 0, stored.stderr);
  assert.equal(JSON.parse(stored.stdout).storedJob.sessionId, null);
  const state = JSON.parse(fs.readFileSync(path.join(dir, "fake-codex-state.json")));
  assert.ok(state.lastTurnStart.prompt.startsWith("Review this synthetic fixture. $(literal) `literal`"));
  assert.equal(state.threads.length, 1);
  const failed = run(link, ["task", "--cwd", repo, "--sandbox", "invalid"], { env, input: "Must not start." });
  assert.equal(failed.status, 1);
  assert.equal(JSON.parse(failed.stdout).status, "error");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "fake-codex-state.json"))).nextTurnId, state.nextTurnId);
});
