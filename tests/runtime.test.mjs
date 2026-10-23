import { isolatedCodexCommand } from "../plugins/codex/scripts/lib/codex-home.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnOwned as spawn } from "../plugins/codex/scripts/lib/process.mjs";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run, requireLocalSockets, readyBroker } from "./helpers.mjs";
import { loadBrokerSession, saveBrokerSession } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { resolveStateDir, upsertJob, writeJobFile } from "../plugins/codex/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "codex-companion.mjs");
const STOP_HOOK = path.join(PLUGIN_ROOT, "scripts", "stop-review-gate-hook.mjs");
const SESSION_HOOK = path.join(PLUGIN_ROOT, "scripts", "session-lifecycle-hook.mjs");

async function waitFor(predicate, { timeoutMs = 60000, intervalMs = 50 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition.");
}

const HELP_COMMANDS = ["task", "setup", "review", "adversarial-review", "transfer", "status", "result", "wait", "adopt", "answer", "cancel", "cleanup", "ultra-codex", "task-worker", "task-resume-candidate"];

function helpFixture() {
  const dir = makeTempDir(), repo = path.join(dir, "repo");
  fs.mkdirSync(repo);
  installFakeCodex(dir, "slow-task");
  const env = { ...buildEnv(dir), CODEX_COMPANION_HOME: path.join(dir, "isolated"),
    CLAUDE_PLUGIN_DATA: path.join(dir, "data"), CODEX_COMPANION_SESSION_ID: "help-session" };
  const before = fs.readdirSync(dir, { recursive: true }).sort();
  return { dir, repo, env,
    call: (...args) => run(process.execPath, [SCRIPT, ...args], { cwd: repo, env }),
    unchanged: () => assert.deepEqual(fs.readdirSync(dir, { recursive: true }).sort(), before,
      "no runtime home, state/job file, marker, or fake Codex thread/startup record created") };
}

test("help takes precedence over malformed task options without side effects", () => {
  const f = helpFixture();
  const result = f.call("task", "--direct", "--json", "--model", "--help");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  f.unchanged();
});

for (const command of ["task"]) {
  test(`${command} rejects unknown options before side effects`, () => {
    const f = helpFixture();
    for (const option of ["--frobnicate"]) {
      const result = f.call(command, option, "x");
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      f.unchanged();
    }
  });
}

test("task unknown options retain direct JSON errors and cannot hide as option values", () => {
  const f = helpFixture();
  const result = f.call("task", "--direct", "--model", "--frobnicate");
  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(payload), ["status", "worker", "jobId", "summary", "next", "details"]);
  assert.equal(payload.status, "error");
  assert.ok(payload.summary.length);
  f.unchanged();
});

test("task passes help and unknown flags after -- as literal prompt text", () => {
  const f = helpFixture();
  initGitRepo(f.repo);
  for (const literal of [["--help", "--frobnicate"]]) {
    const result = f.call("task", "--", ...literal);
    assert.equal(result.status, 0, result.stderr);
    const state = JSON.parse(fs.readFileSync(path.join(f.dir, "fake-codex-state.json"), "utf8"));
    assert.equal(state.lastTurnStart.prompt, literal.join(" "));
  }
  const direct = f.call("task", "--direct", "--", "--help", "--json", "--follow", "-x");
  assert.equal(direct.status, 0, direct.stderr);
  // Direct mode prints /tasks progress first; the payload is the last line starting with "{".
  assert.equal(JSON.parse(direct.stdout.trimEnd().split("\n").filter(line => line.startsWith("{")).at(-1)).status, "completed");
  const state = JSON.parse(fs.readFileSync(path.join(f.dir, "fake-codex-state.json"), "utf8"));
  assert.ok(state.lastTurnStart.prompt.startsWith("--help --json --follow -x\n"));
});

test("adversarial-review preserves unknown focus flags and literal help", () => {
  const f = helpFixture();
  initGitRepo(f.repo);
  fs.writeFileSync(path.join(f.repo, "README.md"), "fixture\n");
  for (const focus of [["--frobnicate", "-x"], ["--", "--help"]]) {
    const result = f.call("adversarial-review", "--scope", "working-tree", ...focus);
    assert.equal(result.status, 0, result.stderr);
    const state = JSON.parse(fs.readFileSync(path.join(f.dir, "fake-codex-state.json"), "utf8"));
    assert.ok(state.lastTurnStart.prompt.includes(focus.filter(token => token !== "--").join(" ")));
  }
});
test("adversarial-review rejects target typos before startup and preserves compatible focus text", () => {
  const f = helpFixture();
  installFakeCodex(f.dir);
  initGitRepo(f.repo);
  fs.writeFileSync(path.join(f.repo, "README.md"), "fixture\n");
  run("git", ["add", "README.md"], { cwd: f.repo });
  run("git", ["commit", "-m", "fixture"], { cwd: f.repo });
  fs.writeFileSync(path.join(f.repo, "untracked.txt"), "dirty fixture\n");
  const before = fs.readdirSync(f.dir, { recursive: true }).sort();
  for (const args of [["--baes", "main"], ["--baes main"], ["--baes=main"], ["--scpoe", "branch"]]) {
    const result = f.call("adversarial-review", ...args);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /Unknown option: --(?:baes(?:=main)? \(did you mean --base\?\)|scpoe \(did you mean --scope\?\))/);
    assert.match(result.stderr, /Usage:.*adversarial-review/);
    assert.equal(result.stdout, "");
    assert.deepEqual(fs.readdirSync(f.dir, { recursive: true }).sort(), before,
      "no job, review thread, or runtime startup for a typo");
  }
  for (const [args, focus, target] of [
    [["--base", "main"], null, "branch diff against main"],
    [["focus", "on", "race", "conditions"], "focus on race conditions", "working tree diff"],
    [["--focus-on-races"], "--focus-on-races", "working tree diff"],
    [["--", "--baes", "main"], "--baes main", "working tree diff"]
  ]) {
    const result = f.call("adversarial-review", ...args);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(`Target: ${target}`), result.stdout);
    const state = JSON.parse(fs.readFileSync(path.join(f.dir, "fake-codex-state.json"), "utf8"));
    if (focus) assert.ok(state.lastTurnStart.prompt.includes(focus));
  }
});

test("setup is ready without npm when Codex is already installed and authenticated", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  fs.symlinkSync(process.execPath, path.join(binDir, "node"));

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PATH: binDir
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.npm.available, false);
  assert.equal(payload.codex.available, true);
  assert.equal(payload.auth.loggedIn, true);
});

test("setup trusts app-server API key auth even when login status alone would fail", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir, "api-key-account-only");

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.auth.loggedIn, true);
  assert.equal(payload.auth.authMethod, "apiKey");
  assert.equal(payload.auth.source, "app-server");

});
test("setup treats custom providers with app-server-ready config as ready", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir, "env-key-provider");

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.auth.loggedIn, true);
  assert.equal(payload.auth.authMethod, null);
  assert.equal(payload.auth.source, "app-server");

});

test("setup reports not ready when app-server config read fails", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir, "config-read-fails");

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, false);
  assert.equal(payload.auth.loggedIn, false);
  assert.equal(payload.auth.source, "app-server");

});

test("native review returns a finished turn and structured result", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 1;\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");

  const result = run("node", [SCRIPT, "review", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.codex.status, 0);
  assert.equal(payload.turnEnded, true);
  assert.ok(payload.threadId);
});

test("task runs when the active provider does not require OpenAI login", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "provider-no-auth");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "check auth preflight"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const state = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json")));
  assert.equal(state.threads[0].turns[0].status, "completed");
});

test("task runs without auth preflight so Codex can refresh an expired session", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "refreshable-auth");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "check refreshable auth"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const state = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json")));
  assert.equal(state.threads[0].turns[0].status, "completed");
});

test("transfer delegates the current Claude session directly to native import", () => {
  const home = makeTempDir();
  const repo = path.join(home, "repo");
  const binDir = makeTempDir();
  const sessionId = "sess-native-transfer";
  fs.mkdirSync(repo, { recursive: true });
  const projectDir = path.join(home, ".claude", "projects", "-repo");
  const sourcePath = path.join(projectDir, `${sessionId}.jsonl`);
  fs.mkdirSync(projectDir, { recursive: true });
  installFakeCodex(binDir);
  initGitRepo(repo);

  fs.writeFileSync(
    sourcePath,
    [
      { type: "custom-title", customTitle: "Native transfer" },
      { type: "user", cwd: repo, message: { role: "user", content: "Initial request" } },
      { type: "assistant", cwd: repo, message: { role: "assistant", content: "Initial answer" } },
      { type: "user", cwd: repo, message: { role: "user", content: "/codex:transfer" } }
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    "utf8"
  );
  const result = run("node", [SCRIPT, "transfer", "--json"], {
    cwd: repo,
    env: {
      ...buildEnv(binDir),
      HOME: home,
      CODEX_HOME: path.join(home, ".codex"),
      CODEX_COMPANION_TRANSCRIPT_PATH: sourcePath
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  const canonicalSourcePath = fs.realpathSync(sourcePath);
  assert.equal(payload.threadId, "thr_1");
  assert.equal(payload.resumeCommand, isolatedCodexCommand(["resume", "thr_1"], { ...buildEnv(binDir), HOME: home, CODEX_HOME: path.join(home, ".codex") }));
  assert.equal(payload.sourcePath, canonicalSourcePath);
  assert.equal(payload.sessionId, sessionId);

  const fakeState = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.equal(fakeState.threads.length, 1);
  assert.equal(fakeState.threads[0].ephemeral, false);
  assert.equal(fakeState.threads[0].name, "Native transfer");
  assert.notEqual(fakeState.lastExternalAgentImport.sourcePath, canonicalSourcePath);
  assert.equal(fs.existsSync(fakeState.lastExternalAgentImport.sourcePath), false);
  assert.deepEqual(
    fakeState.threads[0].visibleMessages.map((message) => message.text),
    ["Initial request", "Initial answer", "/codex:transfer"]
  );
});

test("transfer reports an actionable upgrade error when native import is unsupported", () => {
  const home = makeTempDir();
  const repo = path.join(home, "repo");
  const binDir = makeTempDir();
  const projectDir = path.join(home, ".claude", "projects", "-repo");
  const sourcePath = path.join(projectDir, "session.jsonl");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  installFakeCodex(binDir, "external-import-unsupported");
  initGitRepo(repo);
  fs.writeFileSync(
    sourcePath,
    `${JSON.stringify({ type: "user", cwd: repo, message: { role: "user", content: "Continue this work." } })}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "transfer", "--source", sourcePath, "--json"], {
    cwd: repo,
    env: {
      ...buildEnv(binDir),
      HOME: home,
      CODEX_HOME: path.join(home, ".codex")
    }
  });

  assert.notEqual(result.status, 0);
});

test("transfer fails visibly when native import completes without a ledger record", () => {
  const home = makeTempDir();
  const repo = path.join(home, "repo");
  const binDir = makeTempDir();
  const projectDir = path.join(home, ".claude", "projects", "-repo");
  const sourcePath = path.join(projectDir, "session.jsonl");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  installFakeCodex(binDir, "external-import-no-ledger");
  initGitRepo(repo);
  fs.writeFileSync(
    sourcePath,
    `${JSON.stringify({ type: "user", cwd: repo, message: { role: "user", content: "Do not lose this request." } })}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "transfer", "--source", sourcePath], {
    cwd: repo,
    env: {
      ...buildEnv(binDir),
      HOME: home,
      CODEX_HOME: path.join(home, ".codex")
    }
  });

  assert.notEqual(result.status, 0);
});

test("transfer rejects sources outside the Claude projects directory", () => {
  const home = makeTempDir();
  const repo = path.join(home, "repo");
  const binDir = makeTempDir();
  const sourcePath = path.join(home, "session.jsonl");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(path.join(home, ".claude", "projects"), { recursive: true });
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(
    sourcePath,
    `${JSON.stringify({ type: "user", cwd: repo, message: { role: "user", content: "Outside source." } })}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "transfer", "--source", sourcePath], {
    cwd: repo,
    env: { ...buildEnv(binDir), HOME: home }
  });

  assert.notEqual(result.status, 0);
});

function forkFixture(behavior = "review-ok") {
  const directory = makeTempDir("duet14-f-");
  const repo = path.join(directory, "repo");
  fs.mkdirSync(repo);
  initGitRepo(repo);
  installFakeCodex(directory, behavior);
  const env = { ...buildEnv(directory), CODEX_COMPANION_HOME: path.join(directory, "isolated"),
    CLAUDE_PLUGIN_DATA: path.join(directory, "data"), CODEX_COMPANION_SESSION_ID: "fork-contract" };
  const projects = path.join(env.HOME, ".claude", "projects");
  const source = path.join(projects, "-repo", "fork-session.jsonl");
  fs.mkdirSync(path.dirname(source), { recursive: true });
  const contents = [
    { type: "user", message: { content: "Synthetic prior request" } },
    { type: "assistant", message: { content: "Synthetic prior answer" } }
  ].map(row => JSON.stringify(row)).join("\n") + "\n";
  fs.writeFileSync(source, contents);
  env.CODEX_COMPANION_TRANSCRIPT_PATH = source;
  const call = (...args) => run(path.join(PLUGIN_ROOT, "bin", "duet"), args, { cwd: repo, env, input: "Synthetic fork brief." });
  const json = result => {
    assert.equal(result.status, 0, result.stderr || result.stdout);
    try { return JSON.parse(result.stdout); }
    catch { return JSON.parse(result.stdout.trim().split("\n").at(-1)); }
  };
  const statePath = path.join(directory, "fake-codex-state.json");
  return { directory, repo, env, source, projects, contents, call, json,
    state: () => fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath)) : null,
    stored: id => json(call("result", id, "--json")).storedJob };
}

test("session snapshots refuse a leaf replaced after validation before reading any content", () => {
  const f = forkFixture();
  const module = new URL("../plugins/codex/scripts/lib/claude-session-transfer.mjs", import.meta.url).href;
  const probe = run(process.execPath, ["--input-type=module", "-e", `
    import fs from 'node:fs';
    import path from 'node:path';
    import assert from 'node:assert/strict';
    import { snapshotClaudeSession } from ${JSON.stringify(module)};
    const source = ${JSON.stringify(f.source)}, outside = ${JSON.stringify(path.join(f.directory, "outside.jsonl"))};
    const open = fs.openSync, read = fs.readSync;
    fs.writeFileSync(outside, 'OUTSIDE_CONTENT');
    for (const replacement of ['symlink', 'regular']) {
      let swapped = false, reads = 0;
      fs.readSync = (...args) => { reads++; return read(...args); };
      fs.openSync = (file, ...args) => {
        if (file === source && !swapped) {
          swapped = true;
          fs.renameSync(source, source + '.validated');
          if (replacement === 'symlink') fs.symlinkSync(outside, source);
          else fs.copyFileSync(outside, source);
        }
        return open(file, ...args);
      };
      try {
        assert.throws(() => snapshotClaudeSession(process.cwd(), source),
          replacement === 'symlink' ? { code: 'ELOOP' } : /changed after validation/);
        assert.equal(swapped, true);
        assert.equal(reads, 0);
        assert.deepEqual(fs.readdirSync(path.dirname(path.dirname(source))), ['-repo']);
      } finally {
        fs.openSync = open; fs.readSync = read;
        fs.unlinkSync(source); fs.renameSync(source + '.validated', source);
      }
    }
    assert.equal(fs.readFileSync(outside, 'utf8'), 'OUTSIDE_CONTENT');
  `], { cwd: f.repo, env: f.env });
  assert.equal(probe.status, 0, probe.stderr);
});

test("transfer and fork sweep abandoned private copies but preserve fresh and unrelated directories", () => {
  const module = new URL("../plugins/codex/scripts/lib/claude-session-transfer.mjs", import.meta.url).href;
  for (const command of [["transfer", "--json"], ["task", "--fork"]]) {
    const f = forkFixture();
    const copies = run(process.execPath, ["--input-type=module", "-e", `
      import { snapshotClaudeSession } from ${JSON.stringify(module)};
      console.log(JSON.stringify([0, 1].map(() => snapshotClaudeSession(process.cwd(), ${JSON.stringify(f.source)}).snapshotPath)));
    `], { cwd: f.repo, env: f.env });
    const [old, fresh] = f.json(copies).map(file => path.dirname(file));
    const date = new Date(Date.now() - 2 * 3600000);
    for (const file of fs.readdirSync(old)) fs.utimesSync(path.join(old, file), date, date);
    fs.utimesSync(old, date, date);
    const unrelated = path.join(f.projects, ".duet-import-custom"); fs.mkdirSync(unrelated);
    fs.writeFileSync(path.join(unrelated, "keep.txt"), "unrelated"); fs.utimesSync(unrelated, date, date);
    const backup = path.join(f.projects, ".duet-import-backup"); fs.mkdirSync(backup, { mode: 0o700 });
    const backupFile = path.join(backup, "keep.jsonl"); fs.writeFileSync(backupFile, "user backup", { mode: 0o600 });
    fs.utimesSync(backupFile, date, date); fs.utimesSync(backup, date, date);
    f.json(f.call(...command));
    assert.equal(fs.existsSync(old), false);
    assert.ok(fs.existsSync(fresh));
    assert.equal(fs.readFileSync(path.join(unrelated, "keep.txt"), "utf8"), "unrelated");
    assert.equal(fs.readFileSync(backupFile, "utf8"), "user backup");
  }
});

test("fork imports a private snapshot despite live appends and early completion, then follows up with task settings", () => {
  const f = forkFixture("external-import-early");
  f.json(run(process.execPath, [SCRIPT, "setup", "--default-sandbox", "read-only", "--json"], { cwd: f.repo, env: f.env }));
  const result = f.json(f.call("task", "--fork", "--model", "fixture-fork", "--effort", "high", "--fast"));
  assert.equal(result.status, "completed");
  const job = f.stored(result.jobId);
  const imported = f.state().lastExternalAgentImport;
  assert.equal(job.threadId, imported.threadId);
  assert.equal(f.state().lastThreadResume.threadId, imported.threadId);
  assert.equal(f.state().lastTurnStart.threadId, imported.threadId);
  assert.ok(f.state().lastTurnStart.prompt.includes("Synthetic fork brief."));
  assert.equal(job.request.forked, true);
  assert.equal(job.request.forkSourceSha256, createHash("sha256").update(f.contents).digest("hex"));
  assert.equal(job.request.forkImportId, imported.importId);
  assert.equal(job.request.threadId, imported.threadId);
  assert.deepEqual([job.request.model, job.request.effort, job.request.sandbox, job.request.serviceTier], ["fixture-fork", "high", "read-only", "priority"]);
  assert.equal(f.state().lastThreadResume.model, "fixture-fork");
  assert.equal(f.state().lastTurnStart.effort, "high");
  assert.equal(f.state().lastTurnStart.serviceTier, "priority");
  assert.equal(f.state().lastTurnStart.sandboxPolicy.type, "readOnly");
  assert.ok(fs.statSync(f.source).size > Buffer.byteLength(f.contents));
  assert.deepEqual(imported.messages.map(message => message.text), ["Synthetic prior request", "Synthetic prior answer"]);
  const migration = f.state().externalAgentImports[0];
  assert.notEqual(migration.sourcePath, fs.realpathSync(f.source));
  assert.equal(fs.existsSync(path.dirname(migration.sourcePath)), false);
  if (process.platform !== "win32") assert.deepEqual([migration.sourceMode, migration.directoryMode], [0o600, 0o700]);
  assert.deepEqual(migration.params.migrationItems.map(item => item.itemType), ["SESSIONS"]);
  for (const key of ["plugins", "mcpServers", "hooks", "subagents", "commands"]) assert.deepEqual(migration.params.migrationItems[0].details[key], []);
  const details = f.json(f.call("result", result.worker, "--details"));
  for (const key of ["forked", "forkSourceSha256", "forkImportId", "forkLabel", "threadId"]) {
    assert.equal(details[key], job.request[key]);
    assert.equal(Object.hasOwn(result, key), false, "fork provenance stays out of the compact report");
  }
  // Identical content still creates a fresh imported thread.
  fs.writeFileSync(f.source, f.contents);
  const second = f.json(f.call("task", "--fork", "--source", f.source));
  const secondJob = f.stored(second.jobId);
  assert.notEqual(secondJob.threadId, job.threadId);
  assert.notEqual(secondJob.request.forkImportId, job.request.forkImportId);
  assert.equal(secondJob.request.forkSourceSha256, job.request.forkSourceSha256);
  const followup = f.json(f.call("task", "--to", result.worker));
  const followupJob = f.stored(followup.jobId);
  assert.equal(followup.worker, result.worker);
  assert.equal(followupJob.threadId, job.threadId);
  assert.deepEqual([followupJob.request.model, followupJob.request.effort, followupJob.request.sandbox, followupJob.request.serviceTier], ["fixture-fork", "high", "read-only", "priority"]);
  assert.equal(f.state().externalAgentImports.length, 2);
});

test("fork rejects incompatible targets and oversized sources before import, and import failure never starts a turn", () => {
  const f = forkFixture("external-import-fails");
  const incompatible = f.call("task", "--fork", "--to", "UnknownWorker");
  assert.equal(incompatible.status, 1);
  assert.match(incompatible.stderr, /--fork.*--to/);
  assert.equal(f.state(), null);
  const descriptor = fs.openSync(f.source, "r+");
  fs.ftruncateSync(descriptor, 20 * 1024 * 1024 + 1);
  fs.closeSync(descriptor);
  const oversized = f.call("task", "--fork");
  assert.equal(oversized.status, 1);
  assert.match(oversized.stderr, /import limit/);
  assert.equal(f.state()?.externalAgentImports?.length ?? 0, 0);
  fs.writeFileSync(f.source, f.contents);
  f.env.CODEX_COMPANION_IMPORT_MAX_BYTES = String(Buffer.byteLength(f.contents) - 1);
  assert.equal(f.call("task", "--fork").status, 1);
  assert.equal(f.state()?.externalAgentImports?.length ?? 0, 0);
  delete f.env.CODEX_COMPANION_IMPORT_MAX_BYTES;
  const failed = f.call("task", "--fork");
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /SESSIONS.*conversion.*Synthetic transcript conversion failed/);
  assert.equal(f.state().externalAgentImports.length, 1);
  assert.equal(f.state().threads.length, 0);
  assert.equal(f.state().lastTurnStart, undefined);
  assert.deepEqual(fs.readdirSync(f.projects), ["-repo"], "failed imports remove their snapshots");
});

test("task reports the actual Codex auth error when the run is rejected", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "auth-run-fails");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "check failed auth"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.notEqual(result.status, 0);
});

test("review accepts the quoted raw argument style for built-in base-branch review", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 1;\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");

  const result = run("node", [SCRIPT, "review", "--base main --json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.codex.status, 0);
  assert.equal(payload.turnEnded, true);
  assert.ok(payload.threadId);
  assert.equal(payload.target.baseRef, "main");
});

test("adversarial review returns structured findings for an explicit base branch", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0];\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0].id;\n");

  const result = run("node", [SCRIPT, "adversarial-review", "--base", "main", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.codex.status, 0);
  assert.equal(payload.turnEnded, true);
  assert.ok(payload.threadId);
  assert.equal(payload.target.baseRef, "main");
  assert.equal(payload.result.verdict, "needs-attention");
  assert.ok(payload.result.findings.length);
  assert.equal(payload.parseError, null);
});
test("adversarial review asks Codex to inspect larger diffs itself", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  for (const name of ["a.js", "b.js", "c.js"]) {
    fs.writeFileSync(path.join(repo, "src", name), `export const value = "${name}-v1";\n`);
  }
  run("git", ["add", "src/a.js", "src/b.js", "src/c.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "a.js"), 'export const value = "PROMPT_SELF_COLLECT_A";\n');
  fs.writeFileSync(path.join(repo, "src", "b.js"), 'export const value = "PROMPT_SELF_COLLECT_B";\n');
  fs.writeFileSync(path.join(repo, "src", "c.js"), 'export const value = "PROMPT_SELF_COLLECT_C";\n');

  const result = run("node", [SCRIPT, "adversarial-review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const state = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.doesNotMatch(state.lastTurnStart.prompt, /PROMPT_SELF_COLLECT_[ABC]/);
});
test("review logs reasoning summaries and review output to the job log", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-reasoning");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const result = run("node", [SCRIPT, "review", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const stateDir = resolveStateDir(repo);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const log = fs.readFileSync(state.jobs[0].logFile, "utf8");
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.codex.status, 0);
  assert.equal(payload.turnEnded, true);
  assert.ok(payload.threadId);
  assert.ok(payload.codex.reasoning.length);
  assert.ok(log.includes(payload.codex.reasoning));
  assert.ok(log.includes(payload.codex.stdout));
});

test("task --resume-last resumes the latest persisted task thread", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const firstRun = run("node", [SCRIPT, "task", "initial task"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(firstRun.status, 0, firstRun.stderr);

  const result = run("node", [SCRIPT, "task", "--resume", "follow up"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const state = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json")));
  assert.equal(state.lastThreadResume.threadId, state.threads[0].id);
  assert.equal(state.threads.length, 1);
  assert.equal(state.nextTurnId, 3);
});

test("task-resume-candidate returns the latest rescue thread from the current session", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-current",
            status: "completed",
            title: "Codex Task",
            jobClass: "task",
            sessionId: "sess-current",
            threadId: "thr_current",
            summary: "Investigate the flaky test",
            updatedAt: "2026-03-24T20:00:00.000Z"
          },
          {
            id: "task-other-session",
            status: "completed",
            title: "Codex Task",
            jobClass: "task",
            sessionId: "sess-other",
            threadId: "thr_other",
            summary: "Old rescue run",
            updatedAt: "2026-03-24T20:05:00.000Z"
          },
          {
            id: "review-current",
            status: "completed",
            title: "Codex Review",
            jobClass: "review",
            sessionId: "sess-current",
            threadId: "thr_review",
            summary: "Review main...HEAD",
            updatedAt: "2026-03-24T20:10:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "task-resume-candidate", "--json"], {
    cwd: workspace,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.available, true);
  assert.equal(payload.sessionId, "sess-current");
  assert.equal(payload.candidate.id, "task-current");
  assert.equal(payload.candidate.threadId, "thr_current");
});

test("task --resume-last does not resume a task from another Claude session", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const otherEnv = {
    ...buildEnv(binDir),
    CODEX_COMPANION_SESSION_ID: "sess-other"
  };
  const currentEnv = {
    ...buildEnv(binDir),
    CODEX_COMPANION_SESSION_ID: "sess-current"
  };

  const firstRun = run("node", [SCRIPT, "task", "initial task"], {
    cwd: repo,
    env: otherEnv
  });
  assert.equal(firstRun.status, 0, firstRun.stderr);

  const candidate = run("node", [SCRIPT, "task-resume-candidate", "--json"], {
    cwd: repo,
    env: currentEnv
  });
  assert.equal(candidate.status, 0, candidate.stderr);
  assert.equal(JSON.parse(candidate.stdout).available, false);

  const resume = run("node", [SCRIPT, "task", "--resume-last", "follow up"], {
    cwd: repo,
    env: currentEnv
  });
  assert.equal(resume.status, 1);

  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.threadId, "thr_1");
  assert.equal(fakeState.lastTurnStart.prompt, "initial task");
});

test("task --resume-last ignores running tasks from other Claude sessions", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const stateDir = resolveStateDir(repo);
  fs.mkdirSync(path.join(stateDir, "jobs"), { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-other-running",
            status: "running",
            title: "Codex Task",
            jobClass: "task",
            sessionId: "sess-other",
            threadId: "thr_other",
            summary: "Other session active task",
            updatedAt: "2026-03-24T20:05:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const env = {
    ...buildEnv(binDir),
    CODEX_COMPANION_SESSION_ID: "sess-current"
  };
  const status = run("node", [SCRIPT, "status", "--json"], {
    cwd: repo,
    env
  });
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout).running, []);

  const resume = run("node", [SCRIPT, "task", "--resume-last", "follow up"], {
    cwd: repo,
    env
  });
  assert.equal(resume.status, 1);
});

test("session start hook exports unchanged environment and adds compact dispatch context", () => {
  const repo = makeTempDir();
  const envFile = path.join(makeTempDir(), "claude-env.sh");
  fs.writeFileSync(envFile, "", "utf8");
  const pluginDataDir = makeTempDir();
  const transcriptPath = path.join(repo, "session.jsonl");

  const result = run("node", [SESSION_HOOK, "SessionStart"], {
    cwd: repo,
    env: {
      ...process.env,
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PLUGIN_DATA: pluginDataDir,
      CODEX_COMPANION_HOME: path.join(repo,"isolated")
    },
    input: JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: "sess-current",
      transcript_path: transcriptPath,
      cwd: repo
    })
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    fs.readFileSync(envFile, "utf8"),
    `export CODEX_COMPANION='${SCRIPT}'\nexport CODEX_COMPANION_SESSION_ID='sess-current'\nexport CODEX_COMPANION_SESSION_CWD='${repo}'\nexport CODEX_COMPANION_TRANSCRIPT_PATH='${transcriptPath}'\nexport CLAUDE_PLUGIN_DATA='${pluginDataDir}'\nexport CODEX_COMPANION_HOME='${path.join(repo,"isolated")}'\n`
  );
  const output = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(output), ["hookSpecificOutput"]);
  assert.equal(output.hookSpecificOutput.hookEventName, "SessionStart");
  assert.equal(typeof output.hookSpecificOutput.additionalContext, "string");
  // The event can also come from stdin, with no environment file available.
  const stdinEvent = run(process.execPath, [SESSION_HOOK], { cwd: repo,
    env: { ...process.env, CLAUDE_ENV_FILE: "", CODEX_COMPANION_HOME: path.join(repo, "isolated") },
    input: JSON.stringify({ hook_event_name: "SessionStart", cwd: repo }) });
  assert.equal(stdinEvent.status, 0, stdinEvent.stderr);
  assert.deepEqual(JSON.parse(stdinEvent.stdout), output);
  const otherEvent = run(process.execPath, [SESSION_HOOK, "SessionEnd"], { cwd: repo,
    env: { ...process.env, CODEX_COMPANION_SESSION_ID: "" }, input: "{}" });
  assert.equal(otherEvent.stdout, "", "context is emitted only for SessionStart");
});

test("task --fresh is treated as routing control and does not leak into the prompt", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "--fresh", "diagnose the flaky test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.prompt, "diagnose the flaky test");
});
test("task progress log omits reasoning and assistant message bodies", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-reasoning");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "investigate the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const stateDir = resolveStateDir(repo);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const log = fs.readFileSync(state.jobs[0].logFile, "utf8");

});

test("task progress reports collaboration activity without subagent message bodies", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-subagent");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "challenge the current design"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const stateDir = resolveStateDir(repo);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const log = fs.readFileSync(state.jobs[0].logFile, "utf8");
  assert.match(log, /collabAgentToolCall/);
  assert.doesNotMatch(log, /Questioned the retry strategy|The design assumes retries|Subagent design-challenger reasoning/);
});

test("task waits for the main thread to complete before returning the final result", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-subagent");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "challenge the current design"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");
});

test("task ignores later subagent messages when choosing the final returned output", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-late-subagent-message");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "challenge the current design"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");
});

test("task can finish after subagent work even if the parent turn/completed event is missing", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-subagent-no-main-turn-completed");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "challenge the current design"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");
});
test("task --background enqueues a detached worker and exposes per-job status", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "slow-task");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const launched = run("node", [SCRIPT, "task", "--background", "--json", "investigate the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  assert.equal(launchPayload.status, "queued");
  assert.match(launchPayload.jobId, /^task-/);

  const waitedStatus = run(
    "node",
    [SCRIPT, "status", launchPayload.jobId, "--wait", "--timeout-ms", "15000", "--json"],
    {
      cwd: repo,
      env: buildEnv(binDir)
    }
  );

  assert.equal(waitedStatus.status, 0, waitedStatus.stderr);
  const waitedPayload = JSON.parse(waitedStatus.stdout);
  assert.equal(waitedPayload.job.id, launchPayload.jobId);
  assert.equal(waitedPayload.job.status, "completed");

  const resultPayload = await waitFor(() => {
    const result = run("node", [SCRIPT, "result", launchPayload.jobId, "--json"], {
      cwd: repo,
      env: buildEnv(binDir)
    });
    if (result.status !== 0) {
      return null;
    }
    return JSON.parse(result.stdout);
  });

  assert.equal(resultPayload.job.id, launchPayload.jobId);
  assert.equal(resultPayload.job.status, "completed");
});

test("review rejects focus text because it is native-review only", () => {
  const repo = makeTempDir(), binDir = makeTempDir();
  installFakeCodex(binDir); initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "fixture.txt"), "fixture");
  for (const args of [["review", "focus text"], ["review", "--scope", "staged"], ["adversarial-review", "--scope", "staged"]]) {
    const result = run(process.execPath, [SCRIPT, ...args], { cwd: repo, env: buildEnv(binDir) });
    assert.notEqual(result.status, 0);
  }
});

test("review accepts --background while still running as a tracked review job", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const launched = run("node", [SCRIPT, "review", "--background", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  assert.equal(launchPayload.review, "Review");

  const status = run("node", [SCRIPT, "status", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).latestFinished.status, "completed");
});

test("status shows phases, hints, and the latest finished job", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, "review-live.log");
  fs.writeFileSync(
    logFile,
    [
      "[2026-03-18T15:30:00.000Z] Starting Codex Review.",
      "[2026-03-18T15:30:01.000Z] Thread ready (thr_1).",
      "[2026-03-18T15:30:02.000Z] Turn started (turn_1).",
      "[2026-03-18T15:30:03.000Z] Reviewer started: current changes"
    ].join("\n"),
    "utf8"
  );

  const finishedJobFile = path.join(jobsDir, "review-done.json");
  fs.writeFileSync(
    finishedJobFile,
    JSON.stringify(
      {
        id: "review-done",
        status: "completed",
        title: "Codex Review",
        rendered: "# Codex Review\n\nReviewed uncommitted changes.\nNo material issues found.\n"
      },
      null,
      2
    ),
    "utf8"
  );

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "review-live",
            kind: "review",
            kindLabel: "review",
            status: "running",
            title: "Codex Review",
            jobClass: "review",
            phase: "reviewing",
            threadId: "thr_1",
            summary: "Review working tree diff",
            logFile,
            createdAt: "2026-03-18T15:30:00.000Z",
            updatedAt: "2026-03-18T15:30:03.000Z"
          },
          {
            id: "review-done",
            status: "completed",
            title: "Codex Review",
            jobClass: "review",
            threadId: "thr_done",
            summary: "Review main...HEAD",
            createdAt: "2026-03-18T15:10:00.000Z",
            startedAt: "2026-03-18T15:10:05.000Z",
            completedAt: "2026-03-18T15:11:10.000Z",
            updatedAt: "2026-03-18T15:11:10.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "status", "--json"], {
    cwd: workspace
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.running[0].id, "review-live");
  assert.equal(payload.running[0].phase, "reviewing");
  assert.equal(payload.latestFinished.id, "review-done");
});

test("human status exposes the pending question and choices without changing the job or JSON", () => {
  const workspace = makeTempDir();
  const job = { id: "task-question", jobClass: "task", status: "running", phase: "needs_answer", pid: process.pid,
    ownerId: "fixture-owner", leaseRenewedAt: Date.now(), leaseExpiresAt: Date.now() + 60000,
    pendingQuestion: { id: "q1", kind: "question", text: "Which fixture approach?", options: ["Small", "Broad"] } };
  upsertJob(workspace, job);
  const jobFile = writeJobFile(workspace, job.id, job);
  const before = fs.readFileSync(jobFile, "utf8");
  const call = (...args) => run(process.execPath, [SCRIPT, "status", ...args], { cwd: workspace });
  const beforeJson = call(job.id, "--json");
  assert.equal(beforeJson.status, 0, beforeJson.stderr);
  for (const args of [[job.id], []]) {
    const human = call(...args);
    assert.equal(human.status, 0, human.stderr);
    for (const value of [job.pendingQuestion.text, ...job.pendingQuestion.options]) assert.ok(human.stdout.includes(value));
  }
  const afterJson = call(job.id, "--json");
  assert.equal(afterJson.status, beforeJson.status, afterJson.stderr);
  assert.deepEqual(JSON.parse(afterJson.stdout).job.pendingQuestion, job.pendingQuestion);
  assert.deepEqual(JSON.parse(beforeJson.stdout).job.pendingQuestion, job.pendingQuestion);
  assert.equal(fs.readFileSync(jobFile, "utf8"), before, "observation cannot answer or renew the lease");
});

test("human blocked rendering from the full report preserves summary and identifiers without changing stored JSON", async () => {
  const workspace = makeTempDir();
  const report = { status: "blocked", summary: "Stopped: fixture dependency unavailable.\n  Detail stays unchanged.\n",
    blockers: [{ code: "stale_browser_tab_claim", message: "Fixture tab already claimed", app: "Chrome", tabId: "tab-1", sessionId: "session-1" }] };
  const job = { id: "task-blocked", status: "blocked", jobClass: "task", threadId: "thr_blocked" };
  upsertJob(workspace, job);
  const jobFile = writeJobFile(workspace, job.id, { ...job, result: { rawOutput: report.summary }, report });
  const stored = fs.readFileSync(jobFile, "utf8");
  const call = (...args) => run(process.execPath, [SCRIPT, "result", job.id, ...args], { cwd: workspace });
  const beforeJson = call("--json"), beforeReport = call("--report", "--json");
  const { renderStoredJobResult } = await import("../plugins/codex/scripts/lib/render.mjs");
  const full = JSON.parse(beforeJson.stdout);
  const human = renderStoredJobResult(full.job, full.storedJob);
  assert.ok(human.includes(report.summary));
  for (const value of Object.values(report.blockers[0])) assert.ok(human.includes(value));
  const afterJson = call("--json"), afterReport = call("--report", "--json");
  assert.equal(beforeJson.status, 0, beforeJson.stderr);
  assert.equal(afterJson.status, beforeJson.status, afterJson.stderr);
  assert.equal(beforeReport.status, 2, beforeReport.stderr);
  assert.equal(afterReport.status, beforeReport.status, afterReport.stderr);
  assert.equal(afterJson.stdout, beforeJson.stdout);
  assert.equal(afterReport.stdout, beforeReport.stdout);
  assert.deepEqual(JSON.parse(afterJson.stdout).storedJob.report, report);
  assert.equal(fs.readFileSync(jobFile, "utf8"), stored);
});

test("status without a job id only shows jobs from the current Claude session", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const currentLog = path.join(jobsDir, "review-current.log");
  const otherLog = path.join(jobsDir, "review-other.log");
  fs.writeFileSync(currentLog, "[2026-03-18T15:30:00.000Z] Reviewer started: current changes\n", "utf8");
  fs.writeFileSync(otherLog, "[2026-03-18T15:31:00.000Z] Reviewer started: old changes\n", "utf8");

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "review-current",
            kind: "review",
            kindLabel: "review",
            status: "running",
            title: "Codex Review",
            jobClass: "review",
            phase: "reviewing",
            sessionId: "sess-current",
            threadId: "thr_current",
            summary: "Current session review",
            logFile: currentLog,
            createdAt: "2026-03-18T15:30:00.000Z",
            updatedAt: "2026-03-18T15:30:00.000Z"
          },
          {
            id: "review-other",
            kind: "review",
            kindLabel: "review",
            status: "completed",
            title: "Codex Review",
            jobClass: "review",
            sessionId: "sess-other",
            threadId: "thr_other",
            summary: "Previous session review",
            createdAt: "2026-03-18T15:20:00.000Z",
            startedAt: "2026-03-18T15:20:05.000Z",
            completedAt: "2026-03-18T15:21:00.000Z",
            updatedAt: "2026-03-18T15:21:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "status"], {
    cwd: workspace,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    [...new Set(result.stdout.match(/review-(?:current|other)/g) ?? [])],
    ["review-current"]
  );
});
test("status --all recovers workspace sessions with labels and session-scoped empty hints", () => {
  const f = helpFixture();
  const stateDir = resolveStateDir(f.repo, f.env);
  fs.mkdirSync(stateDir, { recursive: true });
  const jobs = [
    { id: "task-active", status: "running", sessionId: "session-a" },
    { id: "task-finished", status: "completed", sessionId: "session-a" },
    { id: "task-legacy", status: "completed", ownerId: "legacy-session-with-long-id" },
    { id: "task-unowned", status: "completed", sessionId: null }
  ].map((job, index) => ({ ...job, updatedAt: `2026-03-18T15:0${9 - index}:00.000Z` }));
  fs.writeFileSync(path.join(stateDir, "state.json"), JSON.stringify({ version: 1, config: {}, jobs }));
  const plain = f.call("status");
  assert.equal(plain.status, 0, plain.stderr);
  assert.match(plain.stdout, /No jobs in this session.*\/codex:status --all/);
  const emptyResult = f.call("result");
  assert.equal(emptyResult.status, 1);
  assert.match(emptyResult.stderr, /No finished Codex jobs in this session.*\/codex:status --all/);
  const all = f.call("status", "--all", "--json");
  assert.equal(all.status, 0, all.stderr);
  const snapshot = JSON.parse(all.stdout);
  const listed = [...snapshot.running, snapshot.latestFinished, ...snapshot.recent];
  assert.deepEqual(listed.map(job => job.id), jobs.map(job => job.id));
  assert.deepEqual(listed.map(job => job.sessionLabel), ["session-a", "session-a", "legacy-s…g-id", "unknown"]);
  const human = f.call("status", "--all");
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /Claude session/);
  for (const job of listed) assert.ok(human.stdout.includes(`${job.id} | ${job.status}`) && human.stdout.includes(`session: ${job.sessionLabel}`));
  const own = run(process.execPath, [SCRIPT, "status", "--json"], {
    cwd: f.repo, env: { ...f.env, CODEX_COMPANION_SESSION_ID: "session-a" }
  });
  const scoped = JSON.parse(own.stdout);
  assert.deepEqual([scoped.running[0].id, scoped.latestFinished.id], ["task-active", "task-finished"]);
  assert.ok(!Object.hasOwn(scoped.running[0], "sessionLabel"), "ordinary status JSON shape is unchanged");
});

test("status --wait times out cleanly when a job is still active", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, "task-live.log");
  fs.writeFileSync(logFile, "[2026-03-18T15:30:00.000Z] Starting Codex Task.\n", "utf8");
  fs.writeFileSync(
    path.join(jobsDir, "task-live.json"),
    JSON.stringify(
      {
        id: "task-live",
        status: "running",
        title: "Codex Task",
        logFile
      },
      null,
      2
    ),
    "utf8"
  );

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-live",
            status: "running",
            title: "Codex Task",
            jobClass: "task",
            summary: "Investigate flaky test",
            logFile,
            createdAt: "2026-03-18T15:30:00.000Z",
            startedAt: "2026-03-18T15:30:01.000Z",
            updatedAt: "2026-03-18T15:30:02.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "status", "task-live", "--wait", "--timeout-ms", "25", "--json"], {
    cwd: workspace
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.job.id, "task-live");
  assert.equal(payload.job.status, "running");
  assert.equal(payload.waitTimedOut, true);
});

test("result returns the stored output for the latest finished job by default", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  fs.writeFileSync(
    path.join(jobsDir, "review-finished.json"),
    JSON.stringify(
      {
        id: "review-finished",
        status: "completed",
        title: "Codex Review",
        rendered: "# Codex Review\n\nReviewed uncommitted changes.\nNo material issues found.\n",
        result: {
          codex: {
            stdout: "Reviewed uncommitted changes.\nNo material issues found."
          }
        },
        threadId: "thr_review_finished"
      },
      null,
      2
    ),
    "utf8"
  );

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "review-finished",
            status: "completed",
            title: "Codex Review",
            jobClass: "review",
            threadId: "thr_review_finished",
            summary: "Review working tree diff",
            createdAt: "2026-03-18T15:00:00.000Z",
            updatedAt: "2026-03-18T15:01:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "result"], {
    cwd: workspace
  });

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "completed"); assert.equal(report.jobId, "review-finished");
  assert.equal(report.summary, "Reviewed uncommitted changes.\nNo material issues found.");
  assert.equal(report.next, null); assert.equal(report.details, "duet result review-finished --details");
  const details = JSON.parse(run("node", [SCRIPT, "result", "--details"], { cwd: workspace }).stdout);
  assert.equal(details.threadId, "thr_review_finished");
});

test("result without a job id prefers the latest finished job from the current Claude session", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  fs.writeFileSync(
    path.join(jobsDir, "review-current.json"),
    JSON.stringify(
      {
        id: "review-current",
        status: "completed",
        title: "Codex Review",
        threadId: "thr_current",
        result: {
          codex: {
            stdout: "Current session output."
          }
        }
      },
      null,
      2
    ),
    "utf8"
  );

  fs.writeFileSync(
    path.join(jobsDir, "review-other.json"),
    JSON.stringify(
      {
        id: "review-other",
        status: "completed",
        title: "Codex Review",
        threadId: "thr_other",
        result: {
          codex: {
            stdout: "Old session output."
          }
        }
      },
      null,
      2
    ),
    "utf8"
  );

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "review-current",
            status: "completed",
            title: "Codex Review",
            jobClass: "review",
            sessionId: "sess-current",
            threadId: "thr_current",
            summary: "Current session review",
            createdAt: "2026-03-18T15:10:00.000Z",
            updatedAt: "2026-03-18T15:11:00.000Z"
          },
          {
            id: "review-other",
            status: "completed",
            title: "Codex Review",
            jobClass: "review",
            sessionId: "sess-other",
            threadId: "thr_other",
            summary: "Old session review",
            createdAt: "2026-03-18T15:20:00.000Z",
            updatedAt: "2026-03-18T15:21:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "result"], {
    cwd: workspace,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "completed"); assert.equal(report.jobId, "review-current");
  assert.equal(report.summary, "Current session output.");
  const details = JSON.parse(run("node", [SCRIPT, "result", report.jobId, "--details"], { cwd: workspace }).stdout);
  assert.equal(details.threadId, "thr_current");
});
test("cancel does not kill an unverified legacy PID or claim confirmation", async (t) => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: workspace,
    detached: true,
    stdio: "ignore"
  });
  sleeper.unref();

  t.after(() => {
    try {
      process.kill(-sleeper.pid, "SIGTERM");
    } catch {
      try {
        process.kill(sleeper.pid, "SIGTERM");
      } catch {
        // Ignore missing process.
      }
    }
  });

  const logFile = path.join(jobsDir, "task-live.log");
  const jobFile = path.join(jobsDir, "task-live.json");
  fs.writeFileSync(logFile, "[2026-03-18T15:30:00.000Z] Starting Codex Task.\n", "utf8");
  fs.writeFileSync(
    jobFile,
    JSON.stringify(
      {
        id: "task-live",
        status: "running",
        title: "Codex Task",
        logFile
      },
      null,
      2
    ),
    "utf8"
  );
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-live",
            status: "running",
            title: "Codex Task",
            jobClass: "task",
            summary: "Investigate flaky test",
            pid: sleeper.pid,
            logFile,
            createdAt: "2026-03-18T15:30:00.000Z",
            startedAt: "2026-03-18T15:30:01.000Z",
            updatedAt: "2026-03-18T15:30:02.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const cancelResult = run("node", [SCRIPT, "cancel", "task-live", "--json"], {
    cwd: workspace
  });

  assert.equal(cancelResult.status, 2, cancelResult.stderr);
  assert.equal(JSON.parse(cancelResult.stdout).confirmation, "unconfirmed");
  assert.doesNotThrow(() => process.kill(sleeper.pid, 0));
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.equal(state.jobs.find(job => job.id === "task-live").cancelRequested.reason, "cancelled_by_user");
  assert.equal(JSON.parse(fs.readFileSync(jobFile)).status, "running");

});

test("cancel without a job id ignores active jobs from other Claude sessions", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, "task-other.log");
  fs.writeFileSync(logFile, "", "utf8");
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-other",
            status: "running",
            title: "Codex Task",
            jobClass: "task",
            sessionId: "sess-other",
            summary: "Other session run",
            updatedAt: "2026-03-24T20:05:00.000Z",
            logFile
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const env = {
    ...process.env,
    CODEX_COMPANION_SESSION_ID: "sess-current"
  };
  const status = run("node", [SCRIPT, "status", "--json"], {
    cwd: workspace,
    env
  });
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout).running, []);

  const cancel = run("node", [SCRIPT, "cancel", "--json"], {
    cwd: workspace,
    env
  });
  assert.equal(cancel.status, 1);

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.equal(state.jobs[0].status, "running");
});

test("cancel with a job id can still target an active job from another Claude session", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const logFile = path.join(jobsDir, "task-other.log");
  fs.writeFileSync(logFile, "", "utf8");
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-other",
            status: "running",
            title: "Codex Task",
            jobClass: "task",
            sessionId: "sess-other",
            summary: "Other session run",
            updatedAt: "2026-03-24T20:05:00.000Z",
            logFile
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const env = {
    ...process.env,
    CODEX_COMPANION_SESSION_ID: "sess-current"
  };
  const cancel = run("node", [SCRIPT, "cancel", "task-other", "--json"], {
    cwd: workspace,
    env
  });
  assert.equal(cancel.status, 2, cancel.stderr);
  assert.equal(JSON.parse(cancel.stdout).jobId, "task-other");

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.equal(state.jobs[0].status, "running");
  assert.equal(state.jobs[0].cancelRequested.reason, "cancelled_by_user");
});

test("cancel confirms turn interruption through the shared app-server", async (t) => {
  if (!await requireLocalSockets(t)) return;
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir, "interruptible-slow-task");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const env = buildEnv(binDir);
  const broker = await readyBroker(repo, env); t.after(broker.close);
  const launched = run("node", [SCRIPT, "task", "--background", "--json", "investigate the flaky worker timeout"], {
    cwd: repo,
    env
  });

  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  const jobId = launchPayload.jobId;
  assert.ok(jobId);

  const stateDir = resolveStateDir(repo);
  const runningJob = await waitFor(() => {
    const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
    const job = state.jobs.find((candidate) => candidate.id === jobId);
    if (job?.status === "running" && job.threadId && job.turnId) {
      return job;
    }
    return null;
  }, { timeoutMs: 15000 });

  assert.ok(loadBrokerSession(repo), "cancellation must exercise broker transport");
  const cancelResult = run("node", [SCRIPT, "cancel", jobId, "--json"], {
    cwd: repo,
    env
  });

  assert.equal(cancelResult.status, 0, cancelResult.stderr);
  const cancelPayload = JSON.parse(cancelResult.stdout);
  assert.equal(cancelPayload.status, "cancelled");
  assert.equal(cancelPayload.turnInterruptAttempted, true);
  assert.equal(cancelPayload.turnInterrupted, true);

  await waitFor(() => {
    const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
    return fakeState.lastInterrupt ?? null;
  });

  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.deepEqual(fakeState.lastInterrupt, {
    threadId: runningJob.threadId,
    turnId: runningJob.turnId
  });

  const cleanup = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      cwd: repo
    })
  });
  assert.equal(cleanup.status, 0, cleanup.stderr);
});

test("session end requests scoped interrupts and retains history without killing legacy PIDs", async (t) => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const stateDir = resolveStateDir(repo);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const completedLog = path.join(jobsDir, "completed.log");
  const runningLog = path.join(jobsDir, "running.log");
  const otherSessionLog = path.join(jobsDir, "other.log");
  const completedJobFile = path.join(jobsDir, "review-completed.json");
  const runningJobFile = path.join(jobsDir, "review-running.json");
  const otherJobFile = path.join(jobsDir, "review-other.json");
  fs.writeFileSync(completedLog, "completed\n", "utf8");
  fs.writeFileSync(runningLog, "running\n", "utf8");
  fs.writeFileSync(otherSessionLog, "other\n", "utf8");
  fs.writeFileSync(completedJobFile, JSON.stringify({ id: "review-completed" }, null, 2), "utf8");
  fs.writeFileSync(otherJobFile, JSON.stringify({ id: "review-other" }, null, 2), "utf8");

  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: repo,
    detached: true,
    stdio: "ignore"
  });
  sleeper.unref();
  fs.writeFileSync(runningJobFile, JSON.stringify({ id: "review-running" }, null, 2), "utf8");

  t.after(() => {
    try {
      process.kill(-sleeper.pid, "SIGTERM");
    } catch {
      try {
        process.kill(sleeper.pid, "SIGTERM");
      } catch {
        // Ignore missing process.
      }
    }
  });

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "review-completed",
            status: "completed",
            title: "Codex Review",
            sessionId: "sess-current",
            logFile: completedLog,
            createdAt: "2026-03-18T15:30:00.000Z",
            updatedAt: "2026-03-18T15:31:00.000Z"
          },
          {
            id: "review-running",
            status: "running",
            title: "Codex Review",
            sessionId: "sess-current",
            pid: sleeper.pid,
            logFile: runningLog,
            createdAt: "2026-03-18T15:32:00.000Z",
            updatedAt: "2026-03-18T15:33:00.000Z"
          },
          {
            id: "review-other",
            status: "completed",
            title: "Codex Review",
            sessionId: "sess-other",
            logFile: otherSessionLog,
            createdAt: "2026-03-18T15:34:00.000Z",
            updatedAt: "2026-03-18T15:35:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    },
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      session_id: "sess-current",
      cwd: repo
    })
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(otherSessionLog), true);
  assert.equal(fs.existsSync(otherJobFile), true);
  assert.equal(fs.existsSync(completedJobFile), true);
  assert.equal(fs.existsSync(runningJobFile), true);
  assert.doesNotThrow(() => process.kill(sleeper.pid, 0));
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.equal(state.jobs.find(job => job.id === "review-running").cancelRequested.reason, "session_end");
  assert.equal(state.jobs.find(job => job.id === "review-other").cancelRequested, undefined);
});

test("stop hook runs a stop-time review task and blocks on findings when the review gate is enabled", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const setup = run("node", [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(setup.status, 0, setup.stderr);
  const setupPayload = JSON.parse(setup.stdout);
  assert.equal(setupPayload.reviewGateEnabled, true);

  const taskResult = run("node", [SCRIPT, "task", "--write", "fix the issue"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(taskResult.status, 0, taskResult.stderr);

  const blocked = run("node", [STOP_HOOK], {
    cwd: repo,
    env: buildEnv(binDir),
    input: JSON.stringify({
      cwd: repo,
      session_id: "sess-stop-review",
      last_assistant_message: "I completed the refactor and updated the retry logic."
    })
  });
  assert.equal(blocked.status, 0, blocked.stderr);
  const blockedPayload = JSON.parse(blocked.stdout);
  assert.equal(blockedPayload.decision, "block");

  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));

  const status = run("node", [SCRIPT, "status"], {
    cwd: repo,
    env: {
      ...buildEnv(binDir),
      CODEX_COMPANION_SESSION_ID: "sess-stop-review"
    }
  });
  assert.equal(status.status, 0, status.stderr);
});

test("stop hook logs running tasks to stderr without blocking when the review gate is disabled", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const stateDir = resolveStateDir(repo);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  const runningLog = path.join(jobsDir, "task-running.log");
  fs.writeFileSync(runningLog, "running\n", "utf8");

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: {
          stopReviewGate: false
        },
        jobs: [
          {
            id: "task-live",
            status: "running",
            title: "Codex Task",
            jobClass: "task",
            sessionId: "sess-current",
            logFile: runningLog,
            createdAt: "2026-03-18T15:32:00.000Z",
            updatedAt: "2026-03-18T15:33:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const blocked = run("node", [STOP_HOOK], {
    cwd: repo,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    },
    input: JSON.stringify({ cwd: repo })
  });

  assert.equal(blocked.status, 0, blocked.stderr);
  assert.equal(blocked.stdout.trim(), "");
});

test("stop hook allows the stop when the review gate is enabled and the stop-time review task is clean", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "adversarial-clean");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const setup = run("node", [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(setup.status, 0, setup.stderr);

  const allowed = run("node", [STOP_HOOK], {
    cwd: repo,
    env: buildEnv(binDir),
    input: JSON.stringify({ cwd: repo, session_id: "sess-stop-clean" })
  });

  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout.trim(), "");
});

test("stop hook does not block when Codex is unavailable even if the review gate is enabled", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const setup = run(process.execPath, [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo
  });
  assert.equal(setup.status, 0, setup.stderr);

  const allowed = run(process.execPath, [STOP_HOOK], {
    cwd: repo,
    env: {
      ...process.env,
      PATH: ""
    },
    input: JSON.stringify({ cwd: repo })
  });

  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout.trim(), "");
});

test("stop hook runs the actual task when auth status looks stale", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "refreshable-auth");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const setup = run("node", [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(setup.status, 0, setup.stderr);

  const allowed = run("node", [STOP_HOOK], {
    cwd: repo,
    env: buildEnv(binDir),
    input: JSON.stringify({ cwd: repo })
  });

  assert.equal(allowed.status, 0, allowed.stderr);
  const payload = JSON.parse(allowed.stdout);
  assert.equal(payload.decision, "block");

});

test("review, adversarial review, setup and status reuse one ready shared app-server", async (t) => {
  if (!await requireLocalSockets(t)) return;
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");

  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const env = buildEnv(binDir);
  const ready = await readyBroker(repo, env); t.after(ready.close);

  const review = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env
  });
  assert.equal(review.status, 0, review.stderr);

  const brokerSession = loadBrokerSession(repo);
  assert.ok(brokerSession, "socket-capable runtime must start a broker");

  const adversarial = run("node", [SCRIPT, "adversarial-review"], {
    cwd: repo,
    env
  });
  assert.equal(adversarial.status, 0, adversarial.stderr);

  const setup = run(process.execPath, [SCRIPT, "setup", "--json"], { cwd: repo, env });
  assert.equal(setup.status, 0, setup.stderr);
  assert.equal(JSON.parse(setup.stdout).sessionRuntime.mode, "shared");
  const status = run(process.execPath, [SCRIPT, "status", "--json"], { cwd: repo, env });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).sessionRuntime.mode, "shared");
  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.equal(fakeState.appServerStarts, 1);

  const cleanup = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      cwd: repo
    })
  });
  assert.equal(cleanup.status, 0, cleanup.stderr);
});

test("setup and status honor --cwd when reading shared session runtime", () => {
  const targetWorkspace = makeTempDir();
  const invocationWorkspace = makeTempDir();

  saveBrokerSession(targetWorkspace, {
    endpoint: "unix:/tmp/fake-broker.sock"
  });

  const status = run("node", [SCRIPT, "status", "--json", "--cwd", targetWorkspace], {
    cwd: invocationWorkspace
  });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).sessionRuntime.endpoint, "unix:/tmp/fake-broker.sock");

  const setup = run("node", [SCRIPT, "setup", "--cwd", targetWorkspace, "--json"], {
    cwd: invocationWorkspace
  });
  assert.equal(setup.status, 0, setup.stderr);
  const payload = JSON.parse(setup.stdout);
  assert.equal(payload.sessionRuntime.mode, "shared");
  assert.equal(payload.sessionRuntime.endpoint, "unix:/tmp/fake-broker.sock");
});
