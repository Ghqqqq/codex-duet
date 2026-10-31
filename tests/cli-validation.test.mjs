import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDir, initGitRepo } from "./helpers.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { resolveStateDir } from "../plugins/codex/scripts/lib/state.mjs";

const cli = new URL("../plugins/codex/scripts/codex-companion.mjs", import.meta.url).pathname;
const launcher = new URL("../plugins/codex/bin/duet", import.meta.url).pathname;

function snapshot(file) {
  if (!fs.existsSync(file)) return null;
  return fs.lstatSync(file).isDirectory()
    ? fs.readdirSync(file).sort().map(name => [name, snapshot(path.join(file, name))])
    : fs.readFileSync(file, "utf8");
}

test("CLI rejects malformed input before side effects and sanitizes diagnostics", () => {
  const dir = makeTempDir("cli-validation-"), repo = path.join(dir, "repo");
  fs.mkdirSync(repo);
  initGitRepo(repo);
  installFakeCodex(dir);
  const env = { ...buildEnv(dir), CODEX_COMPANION_HOME: path.join(dir, "isolated"),
    CLAUDE_PLUGIN_DATA: path.join(dir, "data"), HOME: path.join(dir, "home"),
    USERPROFILE: path.join(dir, "home"), CODEX_HOME: path.join(dir, "normal"),
    CODEX_SQLITE_HOME: path.join(dir, "normal"), CODEX_COMPANION_SESSION_ID: "cli-validation" };
  const stateDir = resolveStateDir(repo, env), jobs = [];
  fs.mkdirSync(path.join(stateDir, "jobs"), { recursive: true });
  for (const [id, status, createdAt] of [["task-first", "completed", "2026-01-01"],
    ["task-latest", "completed", "2026-01-02"], ["task-active", "queued", "2026-01-03"]]) {
    const job = { id, status, createdAt, updatedAt: createdAt, workspaceRoot: repo,
      sessionId: env.CODEX_COMPANION_SESSION_ID, jobClass: "task", leaseExpiresAt: 0,
      threadId: `thread-${id}`, report: { status: "completed", summary: id } };
    jobs.push(job);
    fs.writeFileSync(path.join(stateDir, "jobs", `${id}.json`), JSON.stringify(job));
  }
  fs.writeFileSync(path.join(stateDir, "state.json"), JSON.stringify({ version: 1, config: { defaultSandbox: "read-only" }, jobs }));
  // Complete the fixture's legacy migration before checking invalid commands.
  const initialized = spawnSync(process.execPath, [cli, "status", "--json"], { cwd: repo, env, encoding: "utf8" });
  assert.equal(initialized.status, 0, initialized.stderr);
  const notDirectory = path.join(dir, "file");
  fs.writeFileSync(notDirectory, "ordinary file");
  const reference = "absent\nInjected\r\t\x1b[31m\x7f\u0085\u2028";
  const cases = [
    { args: ["task", "--quiet"], input: " \n\t ", launcher: true },
    { args: ["task", "--quiet", "--sandbox", "invalid"], error: /sandbox/, launcher: true },
    { args: ["task", "--write", "--sandbox", "read-only"], error: /sandbox/ },
    { args: ["task", "--fast", "--normal"], error: /fast.*normal/ },
    { args: ["setup", "--enable-review-gate=garbage"], error: /boolean/ },
    { args: ["setup", "--default-sandbox", "read-only", "EXTRA"], error: /positional/ },
    { args: ["cancel", "task-active", "EXTRA", "--json"], error: /positional/ },
    { args: ["cancel", "--all", "task-active", "--json"], error: /--all/ },
    { args: ["runtime", "status", "EXTRA", "--json"], error: /positional/ },
    { args: ["runtime", "restart", "EXTRA", "--json"], error: /positional/ },
    { args: ["runtime", "unknown", "--json"], error: /status.*restart/ },
    { args: ["task", "--cwd", path.join(dir, "missing")], input: "Valid brief", error: /cwd/ },
    { args: ["journal", "start", "--cwd", notDirectory], input: '{"goal":"No phantom run","criteria":[]}', error: /cwd/ },
    { args: ["result", reference], sanitized: true },
    { args: ["task", "--continue", reference], sanitized: true },
    { args: ["result", "task-first", "--thread="], error: /thread/ },
    { args: ["task", "--direct", "--model", "--frobnicate"], direct: true },
    { args: ["adversarial-review", "--args-stdin"], input: "--baes main" },
    { args: ["review", "--args-stdin"], input: "--model --wait --json" },
    { args: ["review", "focus text"] },
    { args: ["adversarial-review", "--scope", "staged"], error: /scope/ }
  ];
  const state = () => ["isolated", "data", "home", "normal", "fake-codex-state.json", "processes"]
    .map(name => [name, snapshot(path.join(dir, name))]);
  const before = state();
  for (const entry of cases) {
    const label = JSON.stringify(entry.args), input = path.join(dir, "stdin");
    fs.writeFileSync(input, entry.input ?? "");
    const fd = fs.openSync(input, "r");
    let result;
    try {
      result = spawnSync(process.execPath, [entry.launcher ? launcher : cli, ...entry.args], {
        cwd: repo, env, stdio: [fd, "pipe", "pipe"], encoding: "utf8", timeout: 60000
      });
    } finally { fs.closeSync(fd); }
    assert.equal(result.status, 1, `${label}: ${result.stderr}`);
    if (entry.error) assert.match(result.stderr, entry.error, label);
    if (entry.direct) {
      const report = JSON.parse(result.stdout);
      assert.equal(report.status, "error");
      assert.ok(report.summary.length);
    }
    if (entry.sanitized) {
      assert.doesNotMatch(result.stderr.trimEnd(), /[\x00-\x1f\x7f-\x9f\u2028\u2029]/, label);
      assert.match(result.stderr, /absent\\nInjected/, label);
    }
    assert.deepEqual(state(), before, `${label}: invalid input must not mutate preferences, jobs or runtime state`);
  }
});
