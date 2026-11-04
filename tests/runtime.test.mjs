import { isolatedCodexCommand } from "../plugins/codex/scripts/lib/codex-home.mjs";
import fs from "node:fs";
import path from "node:path";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnOwned as spawn } from "../plugins/codex/scripts/lib/process.mjs";
import { fileURLToPath } from "node:url";

import { buildEnv as fixtureEnv, installFakeCodex as generateFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo as initializeGitRepo, makeTempDir, run, requireLocalSockets, readyBroker } from "./helpers.mjs";
import { loadBrokerSession, saveBrokerSession } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { resolveStateDir, upsertJob, updateJob, writeJobFile, setConfig } from "../plugins/codex/scripts/lib/state.mjs";
import { resolveClaudeSessionPath } from "../plugins/codex/scripts/lib/claude-session-transfer.mjs";
import { splitRawArgumentString, splitReviewArgumentString } from "../plugins/codex/scripts/lib/args.mjs";
import { claudeSnapshotFile, recordClaudeTranscript, readClaudeTranscript, readClaudeSnapshot, writeClaudeSnapshot,
  planClaudeSnapshots, pruneClaudeSnapshots } from "../plugins/codex/scripts/lib/claude-memory.mjs";
import { instructionInventory } from "../plugins/codex/hooks/claude-memory.mjs";
import { runWithDelayedStdin } from "./stdin-fixture.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "codex-companion.mjs");
const STOP_HOOK = path.join(PLUGIN_ROOT, "scripts", "stop-review-gate-hook.mjs");
const SESSION_HOOK = path.join(PLUGIN_ROOT, "scripts", "session-lifecycle-hook.mjs");

// Reuse executable bytes across fixtures; only their state files differ. On
// macOS the first execution of each new script dominates these short runs.
const executableCache = new Map();
const cacheRoot = makeTempDir("runtime-codex-");
let gitTemplate;
function initGitRepo(cwd) {
  if (fs.existsSync(path.join(cwd, ".git"))) return initializeGitRepo(cwd);
  if (!gitTemplate) {
    gitTemplate = path.join(cacheRoot, "repo");
    fs.mkdirSync(gitTemplate);
    initializeGitRepo(gitTemplate);
  }
  // A separate empty repository per fixture; no objects, refs or worktrees
  // are shared. Git initialization/configuration is setup, not this contract.
  fs.cpSync(path.join(gitTemplate, ".git"), path.join(cwd, ".git"), { recursive: true });
}
const fixtureStatePath = dir => path.join(dir, "fake-codex-state.json");
function installFakeCodex(dir, behavior = "review-ok", { mutable = false } = {}) {
  if (mutable) return generateFakeCodex(dir, behavior);
  if (!executableCache.has(behavior)) {
    const cached = fs.mkdtempSync(path.join(cacheRoot, "bin-"));
    generateFakeCodex(cached, behavior);
    const file = path.join(cached, "codex"), original = fs.readFileSync(file, "utf8");
    const literal = JSON.stringify(fixtureStatePath(cached));
    const source = original.replace(`const STATE_PATH = ${literal};`,
      "const STATE_PATH = process.env.CODEX_FIXTURE_STATE_PATH;").replace("function taskPayload(prompt, resume) {",
      "function taskPayload(prompt, resume) { if (process.env.CODEX_FIXTURE_TASK_OUTPUT !== undefined) return process.env.CODEX_FIXTURE_TASK_OUTPUT;");
    assert.notEqual(source, original);
    fs.writeFileSync(file, source);
    executableCache.set(behavior, file);
  }
  const file = path.join(dir, "codex");
  fs.rmSync(file, { force: true });
  fs.symlinkSync(executableCache.get(behavior), file);
}
const buildEnv = dir => ({ ...fixtureEnv(dir), CODEX_FIXTURE_STATE_PATH: fixtureStatePath(dir) });

function runtimeFixture(behavior = "review-ok") {
  const repo = makeTempDir(), binDir = makeTempDir();
  installFakeCodex(binDir, behavior);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  return { repo, binDir, env: buildEnv(binDir) };
}

function seedLegacyJobs(workspace, jobs, config = {}) {
  const stateDir = resolveStateDir(workspace), jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "state.json"), JSON.stringify({ version: 1, config, jobs }));
  for (const job of jobs) fs.writeFileSync(path.join(jobsDir, `${job.id}.json`), JSON.stringify(job));
  return { stateDir, jobsDir };
}

after(() => fs.rmSync(cacheRoot, { recursive: true, force: true }));

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

function helpFixture() {
  const dir = makeTempDir(), repo = path.join(dir, "repo");
  fs.mkdirSync(repo);
  installFakeCodex(dir);
  const env = { ...buildEnv(dir), CODEX_COMPANION_HOME: path.join(dir, "isolated"),
    CLAUDE_PLUGIN_DATA: path.join(dir, "data"), CODEX_COMPANION_SESSION_ID: "help-session" };
  const before = fs.readdirSync(dir, { recursive: true }).sort();
  return { dir, repo, env,
    call: (...args) => run(process.execPath, [SCRIPT, ...args], { cwd: repo, env }),
    unchanged: () => assert.deepEqual(fs.readdirSync(dir, { recursive: true }).sort(), before,
      "no runtime home, state/job file, marker, or fake Codex thread/startup record created") };
}

test("help runs without side effects even with incomplete options", () => {
  const f = helpFixture();
  const result = f.call("task", "--direct", "--model", "--help");
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.length);
  f.unchanged();
});

test("task passes help and unknown flags after -- as literal prompt text", () => {
  const f = helpFixture();
  initGitRepo(f.repo);
  const direct = f.call("task", "--direct", "--", "--help", "--json", "--follow", "-x");
  assert.equal(direct.status, 0, direct.stderr);
  // Direct mode prints /tasks progress first; the payload is the last line starting with "{".
  assert.equal(JSON.parse(direct.stdout.trimEnd().split("\n").filter(line => line.startsWith("{")).at(-1)).status, "completed");
  const state = JSON.parse(fs.readFileSync(path.join(f.dir, "fake-codex-state.json"), "utf8"));
  assert.ok(state.lastTurnStart.prompt.startsWith("--help --json --follow -x\n"));
});

test("setup readiness uses app-server auth and config, without requiring npm", () => {
  for (const [behavior, ready, authMethod] of [
    ["review-ok", true], ["api-key-account-only", true, "apiKey"],
    ["env-key-provider", true, null], ["config-read-fails", false]
  ]) {
    const binDir = makeTempDir();
    installFakeCodex(binDir, behavior);
    fs.symlinkSync(process.execPath, path.join(binDir, "node"));
    const result = run(process.execPath, [SCRIPT, "setup", "--json"], {
      cwd: ROOT, env: { ...buildEnv(binDir), PATH: binDir }
    });
    assert.equal(result.status, 0, `${behavior}: ${result.stderr}`);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ready, ready, behavior);
    assert.equal(payload.auth.loggedIn, ready, behavior);
    assert.equal(payload.npm.available, false);
    assert.equal(payload.defaultMode, "off");
    if (authMethod !== undefined) assert.equal(payload.auth.authMethod, authMethod);
  }
});

test("slash commands preserve stdin arguments and review native terminal results", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "review-ok", { mutable: true });
  const fake = path.join(binDir, "codex"), source = fs.readFileSync(fake, "utf8");
  const nativeText = '"Reviewed uncommitted changes.\\nNo material issues found."';
  const reply = 'send({ id: message.id, result: { turn: buildTurn(turnId), reviewThreadId: reviewThread.id } });';
  assert.ok(source.includes(nativeText));
  assert.ok(source.includes(reply));
  fs.writeFileSync(fake, source
    .replace("function structuredReviewPayload(prompt) {", `function structuredReviewPayload(prompt) {
      if (process.env.CODEX_FIXTURE_REVIEW_RAW !== undefined) return process.env.CODEX_FIXTURE_REVIEW_RAW;`)
    .replace(nativeText, `(process.env.CODEX_FIXTURE_EMPTY_NATIVE ? "" : ${nativeText})`)
    .replace(reply, `${reply}
      if (process.env.CODEX_FIXTURE_NATIVE_FAILURE) {
        send({ method: "turn/completed", params: { threadId: reviewThread.id, turn: buildTurn(turnId, "failed", { message: "SYNTHETIC_REVIEW_FAILURE", codexErrorInfo: "internalServerError", additionalDetails: null }) } });
        break;
      }`));
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 1;\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");

  const env = { ...buildEnv(binDir), CODEX_COMPANION_APP_SERVER_ENDPOINT: `unix:${path.join(binDir, "missing.sock")}` };
  const result = run("node", [SCRIPT, "review", "--args-stdin"], {
    cwd: repo,
    env,
    input: "--json --scope working-tree"
  });

  assert.equal(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.codex.status, 0);
  assert.equal(payload.turnEnded, true);
  assert.ok(payload.threadId);

  // cli-5: ordinary argv already contains one complete, shell-quoted token.
  const spacedCwd = path.join(repo, "sub space"); fs.mkdirSync(spacedCwd);
  const statusAt = args => run(process.execPath, [SCRIPT, "status", ...args], { cwd: binDir, env });
  const separateCwd = statusAt(["--cwd", spacedCwd]);
  const inlineCwd = statusAt([`--cwd=${spacedCwd}`]);
  assert.equal(separateCwd.status, 0);
  assert.equal(inlineCwd.status, 0);
  const rawCwd = run(process.execPath, [SCRIPT, "status", "--args-stdin"], { cwd: binDir, env, input: `--cwd '${spacedCwd}'` });
  assert.equal(rawCwd.status, 0);

  const sourcePath = path.join(env.HOME, ".claude", "projects", "My Projects", "session.jsonl");
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, `${JSON.stringify({ type: "user", cwd: repo,
    message: { role: "user", content: "Quoted source fixture" } })}\n`);
  const stdinCall = (command, input, ...args) => run("node", [SCRIPT, command, ...args, "--args-stdin"], {
    cwd: repo, env: { ...env, CODEX_COMPANION_TRANSCRIPT_PATH: sourcePath }, input
  });

  const reviewId = /Job handle: ([^;]+);/.exec(result.stderr)[1];
  const cancelId = "args-cancel", logFile = path.join(resolveStateDir(repo), "jobs", `${cancelId}.log`);
  fs.writeFileSync(logFile, "");
  const cancelJob = { id: cancelId, status: "running", jobClass: "task", workspaceRoot: repo,
    updatedAt: new Date().toISOString(), logFile };
  upsertJob(repo, cancelJob);
  writeJobFile(repo, cancelId, cancelJob);
  const shellMarkers = ["args-dollar", "args-backtick", "args-semicolon"].map(name => path.join(binDir, name));
  const sessionLiteral = `$(touch ${shellMarkers[0]}) \`touch ${shellMarkers[1]}\`;touch ${shellMarkers[2]};$HOME`;
  for (const [command, raw, expectedExit, check] of [
    ["transfer", `--source "${sourcePath}" --json`, 0, value => assert.equal(value.sourcePath, fs.realpathSync(sourcePath))],
    ["status", `"${reviewId}" --json --wait --timeout-ms 1`, 0, value => assert.equal(value.job.id, reviewId)],
    ["result", `"${reviewId}" --details`, 0, value => assert.equal(value.jobId, reviewId)],
    ["cancel", `"${cancelId}" --json`, 2, value => {
      assert.equal(value.jobId, cancelId);
      assert.equal(value.confirmation, "unconfirmed");
    }]
  ]) {
    const template = fs.readFileSync(path.join(PLUGIN_ROOT, "commands", `${command}.md`), "utf8")
      .match(/```bash\n([\s\S]*?)\n```/)[1];
    const shell = template.replaceAll("${CLAUDE_PLUGIN_ROOT}", PLUGIN_ROOT)
      .replaceAll("$ARGUMENTS", `${raw} --cwd "${repo}" --session '${sessionLiteral}'`);
    const response = run("bash", ["-c", shell], { cwd: repo, env });
    assert.equal(response.status, expectedExit, response.stderr);
    check(JSON.parse(response.stdout));
    assert.deepEqual(shellMarkers.map(marker => fs.existsSync(marker)), [false, false, false]);
    // Empty stdin contributes no tokens, including when CLI flags/targets remain.
    const empty = stdinCall(command, "", ...(command === "transfer" ? ["--json"]
      : command === "status" ? [reviewId, "--json"]
      : command === "result" ? [reviewId, "--details"] : [cancelId, "--json"]));
    assert.equal(empty.status, expectedExit, empty.stderr);
    check(JSON.parse(empty.stdout));
  }

  const marker = path.join(binDir, "focus-executed");
  const literal = `reject --focus-on-races but allow --focus-on-errors; $(touch ${marker}) \`touch ${marker}\` $HOME`;
  for (const command of ["review", "adversarial-review"]) {
    const templates = fs.readFileSync(path.join(PLUGIN_ROOT, "commands", `${command}.md`), "utf8");
    for (const [, template] of templates.matchAll(/```bash\n([\s\S]*?)\n```/g)) {
      const shell = template.replaceAll("${CLAUDE_PLUGIN_ROOT}", PLUGIN_ROOT)
        .replaceAll("$ARGUMENTS", `--wait --background --scope working-tree --json ${literal}`);
      const reviewed = run("bash", ["-c", shell], { cwd: repo, env });
      // Native review rejects focus; adversarial review sends it as data.
      assert.equal(reviewed.status, command === "review" ? 1 : 0, reviewed.stderr);
      assert.equal(fs.existsSync(marker), false);
      if (command === "adversarial-review") {
        const state = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
        assert.ok(state.lastTurnStart.prompt.includes(literal));
      }
    }
  }

  const focus = String.raw`check "x" and /\bnull\b/; don't miss 'y'` + "\n  --help\t--baes main";
  const focused = run(process.execPath, [SCRIPT, "adversarial-review", "--args-stdin"], {
    cwd: path.join(repo, "src"), env, input: `--scope working-tree --json\n--\n${focus}\n`
  });
  assert.equal(focused.status, 0, focused.stderr);
  const focusedState = JSON.parse(fs.readFileSync(fixtureStatePath(binDir)));
  assert.equal(focusedState.lastThreadStart.cwd, repo);
  assert.equal(focusedState.lastTurnStart.prompt.split("User focus: ")[1].split("\n</task>")[0], focus);

  const callReview = (command = "adversarial-review") => run("node", [SCRIPT, command, "--json"], { cwd: repo, env });
  const storedReview = result => {
    const id = /Job handle: ([^;]+);/.exec(result.stderr)[1];
    const compact = JSON.parse(run("node", [SCRIPT, "result", id], { cwd: repo, env }).stdout);
    const details = JSON.parse(run("node", [SCRIPT, "result", id, "--details"], { cwd: repo, env }).stdout);
    const stored = JSON.parse(run("node", [SCRIPT, "status", id, "--json"], { cwd: repo, env }).stdout).job;
    assert.equal(compact.status, stored.status);
    assert.equal(details.status, stored.status);
    assert.equal(details.rawOutputFile, stored.rawOutputFile);
    assert.equal(details.resultFile, stored.resultFile);
    assert.deepEqual(JSON.parse(fs.readFileSync(details.resultFile, "utf8")), JSON.parse(result.stdout));
    // cli-2/cli-3: wait and result agree for successful and failed reviews;
    // review threads never advertise task continuation.
    assert.equal(compact.next, null);
    assert.equal(details.continuationCommand ?? null, null);
    const waited = run(process.execPath, [SCRIPT, "wait", id, "--direct", "--quiet", "--details"], { cwd: repo, env });
    assert.equal(waited.status, stored.status === "completed" ? 0 : 1);
    const report = JSON.parse(waited.stdout);
    assert.equal(report.status, stored.status);
    assert.equal(report.summary, details.summary);
    assert.equal(report.question, undefined);
    assert.deepEqual(report.findings, details.findings);
    assert.equal(report.reviewOutput, details.reviewOutput);
    assert.equal(report.errorCode, details.errorCode);
    return { compact, details };
  };
  storedReview(result);
  const validReview = {
    verdict: "needs-attention", summary: "Review findings.", next_steps: [],
    findings: Array.from({ length: 24 }, (_, index) => ({ severity: "high", title: `Finding ${index}`,
      body: "Concrete failure scenario. ".repeat(22), file: "src/app.js", line_start: 1, line_end: 2,
      confidence: 0.9, recommendation: `Guard case ${index}.` }))
  };
  const inject = raw => { env.CODEX_FIXTURE_REVIEW_RAW = raw; };
  inject(JSON.stringify(validReview));
  const longReview = callReview();
  assert.equal(longReview.status, 0, longReview.stderr);
  const complete = storedReview(longReview);
  assert.equal(complete.compact.summaryTruncated, true);
  assert.equal(complete.compact.summary.length, 8000);
  assert.ok(complete.compact.details.includes("--details"));
  assert.deepEqual(complete.details.findings, validReview.findings);
  assert.ok(complete.details.reviewOutput.includes(validReview.findings.at(-1).recommendation));
  assert.equal(fs.readFileSync(complete.details.rawOutputFile, "utf8"), JSON.stringify(validReview));
  inject("not valid JSON");
  const invalid = callReview();
  assert.equal(invalid.status, 1, invalid.stderr);
  assert.equal(JSON.parse(invalid.stdout).errorCode, "review_output_invalid");
  const { compact, details } = storedReview(invalid);
  assert.equal(compact.status, "failed");
  assert.equal(compact.blockers[0].code, "review_output_invalid");
  assert.equal(details.errorCode, "review_output_invalid");
  assert.equal(fs.readFileSync(details.rawOutputFile, "utf8"), "not valid JSON");
  env.CODEX_FIXTURE_EMPTY_NATIVE = "1";
  const emptyNative = callReview("review");
  assert.equal(emptyNative.status, 1, emptyNative.stderr);
  const emptyStored = storedReview(emptyNative);
  assert.equal(emptyStored.compact.blockers[0].code, "review_output_invalid");
  assert.equal(fs.readFileSync(emptyStored.details.rawOutputFile, "utf8"), "");

  delete env.CODEX_FIXTURE_EMPTY_NATIVE;
  env.CODEX_FIXTURE_NATIVE_FAILURE = "1";
  const failed = run("node", [SCRIPT, "review", "--json"], { cwd: repo, env });
  assert.equal(failed.status, 1, failed.stderr);
  const failure = JSON.parse(failed.stdout);
  assert.equal(failure.codex.status, 1);
  assert.equal(failure.turnEnded, true);
  assert.equal(failure.error, "SYNTHETIC_REVIEW_FAILURE");
  const jobId = /Job handle: ([^;]+);/.exec(failed.stderr)[1];
  const stored = JSON.parse(run("node", [SCRIPT, "status", jobId, "--json"], { cwd: repo, env }).stdout).job;
  assert.equal(stored.status, "failed");
  assert.ok(stored.summary.includes(failure.error));
  const reported = run("node", [SCRIPT, "result", jobId], { cwd: repo, env });
  assert.equal(reported.status, 1);
  const report = JSON.parse(reported.stdout);
  assert.equal(report.status, "failed");
  assert.ok(report.summary.includes(failure.error));
});

test("task lets Codex handle provider auth, refresh and rejected credentials", () => {
  for (const [behavior, expectedStatus] of [["provider-no-auth", 0], ["refreshable-auth", 0], ["auth-run-fails", 1]]) {
    const { repo, binDir, env } = runtimeFixture(behavior);
    const result = run(process.execPath, [SCRIPT, "task", "check authentication"], { cwd: repo, env });
    assert.equal(result.status, expectedStatus, `${behavior}: ${result.stderr}`);
    if (expectedStatus === 0) {
      const state = JSON.parse(fs.readFileSync(fixtureStatePath(binDir)));
      assert.equal(state.threads[0].turns[0].status, "completed");
    }
  }
});

test("transfer imports the selected Claude session over inherited paths and honors explicit sources", () => {
  const home = makeTempDir();
  const repo = path.join(home, "repo");
  const binDir = makeTempDir();
  const sessionId = "sess-native-transfer";
  fs.mkdirSync(repo, { recursive: true });
  const projectDir = path.join(home, ".claude", "projects", "-repo");
  const sourcePath = path.join(projectDir, `${sessionId}.jsonl`);
  const parentPath = path.join(projectDir, "parent-session.jsonl");
  fs.mkdirSync(projectDir, { recursive: true });
  installFakeCodex(binDir);
  initGitRepo(repo);

  fs.writeFileSync(
    sourcePath,
    [
      { type: "custom-title", customTitle: "Native transfer" },
      { type: "user", cwd: repo, message: { role: "user", content: "Initial request" } },
      { type: "assistant", cwd: repo, message: { role: "assistant", content: "Initial answer" } },
      { type: "user", cwd: repo, message: { role: "user", content: "/fugato:transfer" } }
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    "utf8"
  );
  fs.writeFileSync(parentPath, JSON.stringify({ type: "user", cwd: repo,
    message: { role: "user", content: "Parent transcript" } }) + "\n");
  const env = { ...buildEnv(binDir), HOME: home, CODEX_HOME: path.join(home, ".codex"),
    CODEX_COMPANION_SESSION_ID: "parent-session", CODEX_COMPANION_TRANSCRIPT_PATH: parentPath };
  recordClaudeTranscript({ sessionId, transcriptPath: sourcePath }, env);
  const result = run("node", [SCRIPT, "transfer", "--session", sessionId, "--json"], { cwd: repo, env });

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
  assert.equal(fakeState.threads[0].name, null, "non-conversational title records are excluded from the slice");
  assert.notEqual(fakeState.lastExternalAgentImport.sourcePath, canonicalSourcePath);
  assert.equal(fs.existsSync(fakeState.lastExternalAgentImport.sourcePath), false);
  assert.deepEqual(
    fakeState.threads[0].visibleMessages.map((message) => message.text),
    ["Initial request", "Initial answer", "/fugato:transfer"]
  );
  const explicit = run("node", [SCRIPT, "transfer", "--session", sessionId, "--source", parentPath, "--json"], { cwd: repo, env });
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.equal(JSON.parse(explicit.stdout).sourcePath, fs.realpathSync(parentPath));
  const explicitState = JSON.parse(fs.readFileSync(fixtureStatePath(binDir), "utf8"));
  assert.deepEqual(explicitState.lastExternalAgentImport.messages.map(message => message.text), ["Parent transcript"]);
});

test("quoted slash-command arguments preserve backslashes, empty values and separator boundaries", () => {
  const raw = String.raw`--cwd 'C:\work\repo'`;
  const expected = ["--cwd", String.raw`C:\work\repo`];
  assert.deepEqual(splitRawArgumentString(raw), expected);
  assert.deepEqual(splitReviewArgumentString(raw, { valueOptions: ["cwd"] }), expected);
  const separated = String.raw`--cwd 'C:\work\repo\' -- check 'literal focus'`;
  const separatedTokens = ["--cwd", "C:\\work\\repo\\", "--", "check 'literal focus'"];
  assert.deepEqual(splitRawArgumentString(separated, { literalAfterSeparator: true }), separatedTokens);
  assert.deepEqual(splitReviewArgumentString(separated, { valueOptions: ["cwd"] }), separatedTokens);

  const { repo, binDir, env } = runtimeFixture();
  const emptyEnv = { ...env, CODEX_COMPANION_HOME: path.join(binDir, "empty-setup") };
  const direct = run(process.execPath, [SCRIPT, "setup", "--default-sandbox", "", "danger-full-access"], {
    cwd: repo, env: emptyEnv
  });
  const stdin = run(process.execPath, [SCRIPT, "setup", "--args-stdin"], {
    cwd: repo, env: emptyEnv, input: "--default-sandbox '' danger-full-access"
  });
  assert.equal(direct.status, 1, direct.stderr);
  assert.match(direct.stderr, /Missing value for --default-sandbox/);
  assert.equal(stdin.status, 1, stdin.stderr);
  assert.match(stdin.stderr, /Missing value for --default-sandbox/);
  assert.equal(fs.existsSync(emptyEnv.CODEX_COMPANION_HOME), false, "invalid setup saves nothing");
  assert.deepEqual(splitRawArgumentString("'' \"\" tail"), ["", "", "tail"]);
  assert.deepEqual(splitReviewArgumentString("--cwd '' focus", { valueOptions: ["cwd"] }), ["--cwd", "", "--", "focus"]);
  assert.deepEqual(splitReviewArgumentString('--cwd "" -- focus', { valueOptions: ["cwd"] }), ["--cwd", "", "--", "focus"]);
  const directory = path.join(repo, "quoted\\repo");
  fs.mkdirSync(directory, { recursive: true });
  const status = run(process.execPath, [SCRIPT, "status", "--args-stdin"], {
    cwd: binDir, env, input: `--cwd '${directory}' --json`
  });
  assert.equal(status.status, 0, status.stderr);
  const review = run(process.execPath, [SCRIPT, "adversarial-review", "--args-stdin"], {
    cwd: binDir, env, input: `--cwd '${directory}' --scope working-tree --json`
  });
  assert.equal(review.status, 0, review.stderr);
  const state = JSON.parse(fs.readFileSync(fixtureStatePath(binDir), "utf8"));
  assert.equal(state.lastThreadStart.cwd, fs.realpathSync(repo));
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
  const source = path.join(projects, "-repo", "fork-contract.jsonl");
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

test("fork session source priority is explicit, recorded, unique lookup, then matching environment", () => {
  const f = forkFixture(), sessionId = "fork-contract";
  const put = (directory, name = sessionId) => {
    const file = path.join(f.projects, directory, `${name}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, f.contents);
    return file;
  };
  const explicit = put("explicit"), recorded = put("recorded"), inherited = put("parent", "parent-session");
  const env = { ...f.env, CODEX_COMPANION_SESSION_ID: "parent-session", CODEX_COMPANION_TRANSCRIPT_PATH: inherited };
  const resolve = (options = {}, environment = env) => resolveClaudeSessionPath(f.repo, { sessionId, ...options }, environment);
  recordClaudeTranscript({ sessionId, transcriptPath: recorded }, env);
  assert.equal(resolve({ source: explicit }), fs.realpathSync(explicit));
  assert.equal(resolve(), fs.realpathSync(recorded), "the SessionStart record wins over ambiguous lookup and inherited env");
  recordClaudeTranscript({ sessionId, transcriptPath: inherited }, env);
  assert.throws(() => resolve(), /must be named fork-contract.jsonl/, "a wrong recorded path fails closed");
  fs.unlinkSync(claudeSnapshotFile(sessionId, env));
  assert.throws(() => resolve(), /Could not identify the current Claude transcript/, "ambiguous lookup cannot pick a project");
  assert.equal(resolve({}, f.env), fs.realpathSync(f.source), "matching Bash environment is allowed after ambiguous lookup");
  assert.equal(resolveClaudeSessionPath(f.repo, {}, env), fs.realpathSync(inherited), "legacy no-session callers retain their env path");
  fs.unlinkSync(explicit); fs.unlinkSync(recorded);
  assert.equal(resolve(), fs.realpathSync(f.source), "the unique current-session leaf beats the parent environment");
  assert.equal(resolve({ source: inherited }), fs.realpathSync(inherited), "explicit source can select another session");
  const alias = put("alias"); fs.unlinkSync(alias); fs.symlinkSync(inherited, alias);
  recordClaudeTranscript({ sessionId, transcriptPath: alias }, env);
  assert.throws(() => resolve(), /must be named fork-contract.jsonl/, "canonical basename is also checked for implicit sources");
  fs.unlinkSync(claudeSnapshotFile(sessionId, env));
  fs.unlinkSync(f.source);
  assert.throws(() => resolve(), /Could not identify the current Claude transcript/);
  const disguised = put("nested/deeper");
  assert.throws(() => resolve({}, { ...env, CODEX_COMPANION_TRANSCRIPT_PATH: disguised }), /Could not identify/,
    "a matching basename cannot relabel an environment path belonging to another session");
});

test("fork session fallback stays one project level deep and honors the Claude config root", () => {
  const f = forkFixture(), sessionId = "fork-contract";
  const config = path.join(f.directory, "configured-profile"), projects = path.join(config, "projects");
  const env = { ...f.env, CLAUDE_CONFIG_DIR: config, CODEX_COMPANION_SESSION_ID: "parent", CODEX_COMPANION_TRANSCRIPT_PATH: f.source };
  const resolve = () => resolveClaudeSessionPath(f.repo, { sessionId }, env);
  const deep = path.join(projects, "project", "subagents", `${sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(deep), { recursive: true }); fs.writeFileSync(deep, f.contents);
  fs.symlinkSync(path.dirname(f.source), path.join(projects, "project-alias"));
  const staging = path.join(projects, ".duet-import-abcdef"); fs.mkdirSync(staging);
  fs.writeFileSync(path.join(staging, `${sessionId}.jsonl`), f.contents);
  assert.throws(resolve, /Could not identify/, "nested transcripts, project aliases and import staging do not count");
  const current = path.join(projects, "project", `${sessionId}.jsonl`); fs.writeFileSync(current, f.contents);
  assert.equal(resolve(), fs.realpathSync(current));
  assert.throws(() => resolveClaudeSessionPath(f.repo, { sessionId, source: f.source }, env), /only from/);
  assert.equal(resolveClaudeSessionPath(f.repo, { sessionId }, { ...env, CLAUDE_CONFIG_DIR: "relative-profile" }), fs.realpathSync(f.source));
});

test("session transcript records preserve instruction snapshots and share SessionEnd and retention cleanup", () => {
  const f = forkFixture(), sessionId = "fork-contract", file = claudeSnapshotFile(sessionId, f.env);
  const start = () => {
    const result = run(process.execPath, [SESSION_HOOK, "SessionStart"], { cwd: f.repo,
      env: { ...f.env, CODEX_COMPANION_CLAUDE_MD: "0", CLAUDE_ENV_FILE: "" },
      input: JSON.stringify({ session_id: sessionId, transcript_path: f.source, cwd: f.repo }) });
    assert.equal(result.status, 0, result.stderr);
  };
  start();
  assert.equal(readClaudeTranscript(sessionId, f.env), f.source, "recording works with instruction capture disabled and no env file");
  assert.equal(readClaudeSnapshot(sessionId, f.env), null, "a transcript-only record is not an instruction snapshot");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  const snapshot = writeClaudeSnapshot({ sessionId, cwd: f.repo,
    ...instructionInventory([{ path: "/fixture/CLAUDE.md", kind: "project", content: "Recorded instructions." }]) }, f.env);
  assert.equal(readClaudeTranscript(sessionId, f.env), f.source);
  start();
  assert.deepEqual(readClaudeSnapshot(sessionId, f.env), snapshot, "record refresh does not change the inventory or its hash");
  recordClaudeTranscript({ sessionId: "other", transcriptPath: f.source }, f.env);
  const end = run(process.execPath, [SESSION_HOOK, "SessionEnd"], { cwd: f.repo, env: f.env,
    input: JSON.stringify({ session_id: sessionId, cwd: f.repo }) });
  assert.equal(end.status, 0, end.stderr); assert.equal(fs.existsSync(file), false);
  assert.equal(readClaudeTranscript("other", f.env), f.source);
  start();
  const cutoff = Date.now() - 1000;
  fs.utimesSync(file, new Date(cutoff - 1000), new Date(cutoff - 1000));
  const plan = planClaudeSnapshots(cutoff, { env: f.env });
  assert.deepEqual(plan.errors, []); assert.deepEqual(plan.snapshots.map(item => item.path), [file]);
  const pruned = pruneClaudeSnapshots(plan.snapshots, cutoff, { env: f.env });
  assert.equal(pruned.snapshotsDeleted, 1); assert.deepEqual(pruned.errors, []);
  assert.equal(readClaudeTranscript(sessionId, f.env), null); assert.equal(readClaudeTranscript("other", f.env), f.source);
});

test("fork with --session never imports the parent transcript inherited by a nested host", () => {
  const f = forkFixture(), sessionId = "nested-child", child = path.join(f.projects, "-repo", `${sessionId}.jsonl`);
  fs.writeFileSync(child, JSON.stringify({ type: "user", message: { content: "Only the child conversation." } }) + "\n");
  const result = f.json(f.call("task", "--fork", "--session", sessionId));
  assert.equal(result.status, "completed");
  assert.deepEqual(f.state().threads[0].visibleMessages.map(message => message.text), ["Only the child conversation."]);
  const imported = f.state().lastExternalAgentImport;
  fs.unlinkSync(child);
  const refused = f.call("task", "--fork", "--session", sessionId);
  assert.equal(refused.status, 1); assert.match(refused.stdout + refused.stderr, /Could not identify the current Claude transcript/);
  assert.deepEqual(f.state().lastExternalAgentImport, imported, "no parent import after the child source disappears");
  const disguised = path.join(f.projects, "-repo", "subagents", `${sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(disguised)); fs.copyFileSync(f.source, disguised);
  f.env.CODEX_COMPANION_TRANSCRIPT_PATH = disguised;
  const wrongOwner = f.call("task", "--fork", "--session", sessionId);
  assert.equal(wrongOwner.status, 1); assert.match(wrongOwner.stdout + wrongOwner.stderr, /Could not identify/);
  assert.deepEqual(f.state().lastExternalAgentImport, imported, "--session parsing cannot relabel an inherited env path");
});

test("Bash fork still sources the SessionStart env file and accepts an explicit source", () => {
  const f = forkFixture(), envFile = path.join(f.directory, "claude-env.sh"), sessionId = "fork-contract";
  const started = run(process.execPath, [SESSION_HOOK, "SessionStart"], { cwd: f.repo,
    env: { ...f.env, CLAUDE_ENV_FILE: envFile },
    input: JSON.stringify({ session_id: sessionId, transcript_path: f.source, cwd: f.repo }) });
  assert.equal(started.status, 0, started.stderr);
  // Emulate a pre-upgrade session without a record. Duplicate leaf names make
  // lookup ambiguous, so success proves the shell's exported path was used.
  fs.unlinkSync(claudeSnapshotFile(sessionId, f.env));
  const duplicate = path.join(f.projects, "duplicate", `${sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(duplicate)); fs.writeFileSync(duplicate, "{}\n");
  const result = f.json(run("bash", ["-c", '. "$1"\nexec "$2" task --fork', "fork-env", envFile, path.join(PLUGIN_ROOT, "bin", "duet")],
    { cwd: f.repo, env: { ...f.env, CODEX_COMPANION_TRANSCRIPT_PATH: "", CODEX_COMPANION_SESSION_ID: "" }, input: "Synthetic fork brief." }));
  assert.equal(result.status, "completed");
  assert.deepEqual(f.state().threads[0].visibleMessages.map(message => message.text), ["Synthetic prior request", "Synthetic prior answer"]);
  f.env.CODEX_COMPANION_TRANSCRIPT_PATH = path.join(f.projects, "wrong-session.jsonl");
  assert.equal(f.json(f.call("task", "--fork", "--source", f.source)).status, "completed");
});

test("fork explicit --source imports another session despite the current session environment", () => {
  const f = forkFixture(), source = path.join(f.projects, "other-project", "other-session.jsonl");
  fs.mkdirSync(path.dirname(source));
  fs.writeFileSync(source, JSON.stringify({ type: "user", message: { content: "Explicitly selected conversation." } }) + "\n");
  assert.equal(f.env.CODEX_COMPANION_SESSION_ID, "fork-contract");
  assert.equal(f.json(f.call("task", "--fork", "--source", source)).status, "completed");
  assert.deepEqual(f.state().threads[0].visibleMessages.map(message => message.text), ["Explicitly selected conversation."]);
});

test("fork rejects an implicit session transcript swapped to a parent symlink between resolution and snapshot", () => {
  const f = forkFixture(), parent = path.join(path.dirname(f.source), "parent-session.jsonl");
  fs.writeFileSync(parent, JSON.stringify({ type: "user", message: { content: "Only the parent conversation." } }) + "\n");
  const preload = path.join(f.directory, "swap-transcript.mjs");
  fs.writeFileSync(preload, `
    import fs from "node:fs";
    import childProcess from "node:child_process";
    import { syncBuiltinESMExports } from "node:module";
    const spawnSync = childProcess.spawnSync;
    let swapped = false;
    Error.stackTraceLimit = 20;
    childProcess.spawnSync = function(command, args, ...rest) {
      // Availability runs after executeTransfer resolves the source, before
      // importExternalAgentSession takes its snapshot of the resolved path.
      if (!swapped && args?.[0] === "--version" && new Error().stack.includes("importExternalAgentSession")) {
        swapped = true;
        fs.unlinkSync(${JSON.stringify(f.source)});
        fs.symlinkSync(${JSON.stringify(parent)}, ${JSON.stringify(f.source)});
      }
      return spawnSync(command, args, ...rest);
    };
    syncBuiltinESMExports();
  `);
  const result = run(process.execPath, ["--import", preload, path.join(PLUGIN_ROOT, "bin", "duet"), "task", "--fork"],
    { cwd: f.repo, env: f.env, input: "Synthetic fork brief." });
  assert.ok(fs.lstatSync(f.source).isSymbolicLink(), "the resolution-to-snapshot swap occurred");
  assert.equal(result.status, 1, "an implicit fork must reject the swapped parent transcript");
  assert.match(result.stdout + result.stderr, /must be named fork-contract.jsonl/);
  assert.equal(f.state()?.lastExternalAgentImport, undefined, "no parent transcript was imported");
  assert.deepEqual(fs.readdirSync(f.projects), ["-repo"], "no transcript was staged");
});

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
  const fixtures = [];
  for (const command of [["transfer", "--json"], ["task", "--fork"]]) {
    const f = forkFixture();
    fixtures.push(f);
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
  assert.equal(fs.realpathSync(path.join(fixtures[0].directory, "codex")), fs.realpathSync(path.join(fixtures[1].directory, "codex")));
  assert.notEqual(fs.realpathSync(fixtureStatePath(fixtures[0].directory)), fs.realpathSync(fixtureStatePath(fixtures[1].directory)));
  for (const f of fixtures) {
    assert.equal(f.state().externalAgentImports.length, 1);
    assert.ok(f.state().lastExternalAgentImport.sourcePath.startsWith(f.projects + path.sep));
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
  assert.equal(job.request.forkSlice.fromCompactBoundary, false);
  assert.equal(job.request.forkSlice.sourceBytes, Buffer.byteLength(f.contents));
  assert.ok(job.request.forkSlice.slicedBytes <= 2 * 1024 * 1024);
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

test("fork slices a 30 MiB source through the companion and records the original hash and bounded slice", t => {
  const f = forkFixture(), budgetBytes = 4096;
  f.env.CODEX_COMPANION_FORK_BUDGET_BYTES = String(budgetBytes);
  const row = (type, uuid, parentUuid, extra = {}) => ({ type, uuid, parentUuid,
    sessionId: "fork-contract", cwd: f.repo, ...extra });
  const entries = [row("user", "old", null, { message: { content: "Pre-compaction conversation" } }),
    row("system", "boundary", null, { subtype: "compact_boundary", logicalParentUuid: "old" }),
    row("attachment", "attachment", "boundary"),
    row("user", "summary", "attachment", { isCompactSummary: true, message: { content: "Synthetic compact summary" } })];
  for (let i = 0; i < 60; i++) entries.push(row("user", `turn-${i}`, i ? `turn-${i - 1}` : "summary", { message: { content: `Turn ${i}: ${"x".repeat(1000)}` } }));
  entries.push(row("assistant", "tool", "turn-59", { message: { content: [{ type: "tool_use", id: "call", name: "Synthetic", input: {} }] } }),
    row("user", "result", "tool", { message: { content: [{ type: "tool_result", tool_use_id: "call", content: "x".repeat(1024 * 1024) }] },
      toolUseResult: { stdout: "x".repeat(1024 * 1024) } }),
    row("user", "latest", "result", { message: { content: "POST_COMPACTION_FACT_SENTINEL" } }));
  const tail = entries.map(entry => JSON.stringify(entry)).join("\n") + "\n";
  const padding = { type: "api-request-blob", data: "" };
  padding.data = "x".repeat(30 * 1024 * 1024 - Buffer.byteLength(tail) - Buffer.byteLength(JSON.stringify(padding)) - 1);
  const contents = JSON.stringify(padding) + "\n" + tail;
  fs.writeFileSync(f.source, contents);
  assert.equal(fs.statSync(f.source).size, 30 * 1024 * 1024);
  const result = f.json(f.call("task", "--fork")), job = f.stored(result.jobId);
  assert.equal(result.status, "completed");
  assert.equal(job.request.forkSourceSha256, createHash("sha256").update(contents).digest("hex"));
  const meta = job.request.forkSlice;
  assert.equal(meta.sourceBytes, 30 * 1024 * 1024);
  assert.equal(meta.fromCompactBoundary, true);
  assert.equal(meta.tailCapped, true);
  assert.equal(meta.trimmedToolResults, 2);
  assert.ok(meta.slicedBytes <= budgetBytes);
  const messages = f.state().lastExternalAgentImport.messages.map(message => message.text);
  assert.equal(messages[0], "Synthetic compact summary");
  assert.equal(messages.at(-1), "POST_COMPACTION_FACT_SENTINEL");
  assert.ok(!messages.includes("Pre-compaction conversation"));
  assert.equal(path.basename(f.state().lastExternalAgentImport.sourcePath), "fork-contract.jsonl");
  assert.deepEqual(fs.readdirSync(f.projects), ["-repo"], "staged import was cleaned up");
  t.diagnostic(JSON.stringify(meta));
});

test("fork rejects incompatible targets and oversized sources before import, and import failure never starts a turn", () => {
  const f = forkFixture("external-import-fails");
  const incompatible = f.call("task", "--fork", "--to", "UnknownWorker");
  assert.equal(incompatible.status, 1);
  assert.match(incompatible.stderr, /--fork.*--to/);
  assert.equal(f.state(), null);
  const descriptor = fs.openSync(f.source, "r+");
  fs.ftruncateSync(descriptor, 128 * 1024 * 1024 + 1);
  fs.closeSync(descriptor);
  const oversized = f.call("task", "--fork");
  assert.equal(oversized.status, 1);
  assert.match(oversized.stderr, /134217728-byte import limit/);
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

test("adversarial base review returns structured findings and asks Codex to collect larger diffs", () => {
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
  run("git", ["checkout", "-b", "feature"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "a.js"), 'export const value = "PROMPT_SELF_COLLECT_A";\n');
  fs.writeFileSync(path.join(repo, "src", "b.js"), 'export const value = "PROMPT_SELF_COLLECT_B";\n');
  fs.writeFileSync(path.join(repo, "src", "c.js"), 'export const value = "PROMPT_SELF_COLLECT_C";\n');

  run("git", ["add", "src"], { cwd: repo });
  run("git", ["commit", "-m", "feature"], { cwd: repo });

  const result = run("node", [SCRIPT, "adversarial-review", "--base", "main", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.codex.status, 0);
  assert.equal(payload.turnEnded, true);
  assert.ok(payload.threadId);
  assert.equal(payload.target.baseRef, "main");
  assert.equal(payload.result.verdict, "needs-attention");
  assert.ok(payload.result.findings.length);
  assert.equal(payload.parseError, null);
  const state = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.doesNotMatch(state.lastTurnStart.prompt, /PROMPT_SELF_COLLECT_[ABC]/);
});
test("stdin base review logs reasoning/output and tasks keep their progress log readable", () => {
  const { repo, binDir } = runtimeFixture("with-reasoning");
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  for (const scope of ["staged", "not-a-scope"]) {
    const rejected = run("node", [SCRIPT, "review", "--base", "main", "--scope", scope], { cwd: repo, env: buildEnv(binDir) });
    assert.equal(rejected.status, 1, rejected.stderr);
    assert.match(rejected.stderr, /Unsupported review scope/);
  }
  const result = run("node", [SCRIPT, "review", "--args-stdin"], {
    cwd: repo,
    env: buildEnv(binDir),
    input: "--base main --scope working-tree --json"
  });

  assert.equal(result.status, 0, result.stderr);
  const stateDir = resolveStateDir(repo);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const log = fs.readFileSync(state.jobs[0].logFile, "utf8");
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.codex.status, 0);
  assert.equal(payload.turnEnded, true);
  assert.ok(payload.threadId);
  assert.equal(payload.target.baseRef, "main");
  assert.ok(payload.codex.reasoning.length);
  assert.ok(log.includes(payload.codex.reasoning));
  assert.ok(log.includes(payload.codex.stdout));
  const task = run("node", [SCRIPT, "task", "investigate the failing test"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(task.status, 0, task.stderr);
  const taskState = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  fs.readFileSync(taskState.jobs.find(job => job.jobClass === "task").logFile, "utf8");
});

test("task reads a delayed 10 MiB shell pipe through EOF without losing brief bytes", { skip: process.platform === "win32" }, async () => {
  const repo = makeTempDir(), binDir = makeTempDir();
  initGitRepo(repo);
  installFakeCodex(binDir);
  const prompt = `${"x".repeat(65535)}字🙂${"y".repeat(10 * 1024 * 1024 - 65542)}`;
  assert.equal(Buffer.byteLength(prompt), 10 * 1024 * 1024);
  const env = buildEnv(binDir);
  const result = await runWithDelayedStdin(path.join(PLUGIN_ROOT, "bin", "duet"), ["task", "--quiet"], prompt, {
    cwd: repo, env
  });
  assert.equal(result.waited, true, "the producer waits until stdin would block");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, "completed");
  const state = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.ok(state.lastTurnStart.prompt.startsWith(`${prompt}\n\n`), "the runtime receives the full brief before its worker instructions");
  const index = JSON.parse(fs.readFileSync(path.join(resolveStateDir(repo, env), "state.json"), "utf8"));
  const job = JSON.parse(fs.readFileSync(path.join(resolveStateDir(repo, env), "jobs", `${index.jobs[0].id}.json`), "utf8"));
  assert.equal(createHash("sha256").update(job.request.prompt).digest("hex"), createHash("sha256").update(prompt).digest("hex"));
});

test("task --fresh preserves the prompt and --resume resumes the persisted task thread", () => {
  const { repo, binDir } = runtimeFixture();

  const firstRun = run("node", [SCRIPT, "task", "--fresh", "diagnose the flaky test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(firstRun.status, 0, firstRun.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"))).lastTurnStart.prompt, "diagnose the flaky test");

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

test("task resume discovery stays in the current Claude session", () => {
  const { repo, binDir, env } = runtimeFixture();
  env.CODEX_COMPANION_SESSION_ID = "sess-current";
  const jobs = [
    { id: "task-current", jobClass: "task", sessionId: "sess-current", threadId: "thr_current" },
    { id: "task-other", jobClass: "task", sessionId: "sess-other", threadId: "thr_other" },
    { id: "review-current", jobClass: "review", sessionId: "sess-current", threadId: "thr_review" },
    { id: "gate-current", jobClass: "task", title: "Codex Stop Gate Review", sessionId: "sess-current", threadId: "thr_gate" },
    { id: "task-running", jobClass: "task", sessionId: "sess-other", status: "running" }
  ].map((job, index) => ({ status: "completed", updatedAt: `2026-03-24T20:0${index}:00.000Z`, ...job }));
  seedLegacyJobs(repo, jobs);
  const call = (...args) => run(process.execPath, [SCRIPT, ...args], { cwd: repo, env });
  const candidate = call("task-resume-candidate", "--json");
  assert.equal(candidate.status, 0, candidate.stderr);
  assert.equal(JSON.parse(candidate.stdout).candidate.id, "task-current");
  assert.equal(JSON.parse(candidate.stdout).candidate.threadId, "thr_current");
  seedLegacyJobs(repo, jobs.filter(job => job.id !== "task-current"));
  assert.equal(JSON.parse(call("task-resume-candidate", "--json").stdout).available, false);
  assert.deepEqual(JSON.parse(call("status", "--json").stdout).running, []);
  assert.equal(call("task", "--resume-last", "follow up").status, 1);
  assert.equal(fs.existsSync(fixtureStatePath(binDir)), false, "foreign tasks cannot start a resumed turn");
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
  assert.ok(output.hookSpecificOutput.additionalContext.length);
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

test("task collaboration returns the parent result and filters subagent progress", () => {
  for (const behavior of ["with-subagent", "with-late-subagent-message", "with-subagent-no-main-turn-completed"]) {
    const { repo, env } = runtimeFixture(behavior);
    env.CODEX_FIXTURE_TASK_OUTPUT = "PARENT_FINAL_SENTINEL";
    const result = run(process.execPath, [SCRIPT, "task", "challenge the current design"], { cwd: repo, env });
    assert.equal(result.status, 0, `${behavior}: ${result.stderr}`);
    assert.equal(result.stdout.trim(), env.CODEX_FIXTURE_TASK_OUTPUT);
    if (behavior === "with-subagent") {
      const index = JSON.parse(fs.readFileSync(path.join(resolveStateDir(repo), "state.json")));
      const log = fs.readFileSync(index.jobs[0].logFile, "utf8");
      assert.match(log, /collabAgentToolCall/);
      assert.doesNotMatch(log, /Questioned the retry strategy|The design assumes retries|Subagent design-challenger reasoning/);
    }
  }
});

test("task --background enqueues a detached worker and exposes per-job status", async () => {
  const { repo, binDir } = runtimeFixture("slow-task");

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
    [SCRIPT, "status", launchPayload.jobId, "--wait", "--timeout-ms", "15000", "--poll-interval-ms", "100", "--json"],
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

test("review accepts --background while still running as a tracked review job", () => {
  const { repo, binDir } = runtimeFixture();
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

test("status scopes jobs to the current session and --all recovers workspace sessions", () => {
  const f = helpFixture();
  const jobs = [
    { id: "task-active", status: "running", phase: "reviewing", sessionId: "session-a" },
    { id: "task-finished", status: "completed", sessionId: "session-a" },
    { id: "task-legacy", jobClass: "task", status: "completed", ownerId: "legacy-session-with-long-id" },
    { id: "task-unowned", status: "completed", sessionId: null }
  ].map((job, index) => ({ ...job, updatedAt: `2026-03-18T15:0${9 - index}:00.000Z` }));
  // Use this fixture's isolated home for both the legacy index and CLI reads.
  const stateDir = resolveStateDir(f.repo, f.env);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "state.json"), JSON.stringify({ version: 1, config: {}, jobs }));
  const empty = f.call("status", "--json");
  assert.equal(empty.status, 0, empty.stderr);
  assert.deepEqual(JSON.parse(empty.stdout).running, []);
  assert.equal(JSON.parse(empty.stdout).latestFinished, null);
  assert.equal(f.call("result").status, 1);
  const all = f.call("status", "--all", "--json");
  assert.equal(all.status, 0, all.stderr);
  const snapshot = JSON.parse(all.stdout);
  const listed = [...snapshot.running, snapshot.latestFinished, ...snapshot.recent];
  assert.deepEqual(listed.map(job => job.id), jobs.map(job => job.id));
  for (const job of listed) assert.ok(job.sessionLabel.length);
  const human = f.call("status", "--all");
  assert.equal(human.status, 0, human.stderr);
  for (const job of listed) assert.ok(human.stdout.includes(job.id) && human.stdout.includes(job.sessionLabel));
  const own = run(process.execPath, [SCRIPT, "status", "--json"], {
    cwd: f.repo, env: { ...f.env, CODEX_COMPANION_SESSION_ID: "session-a" }
  });
  assert.equal(own.status, 0, own.stderr);
  const scoped = JSON.parse(own.stdout);
  assert.deepEqual([scoped.running[0].id, scoped.latestFinished.id], ["task-active", "task-finished"]);
  assert.equal(scoped.running[0].phase, "reviewing");
  assert.ok(!Object.hasOwn(scoped.running[0], "sessionLabel"));
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.writeFileSync(path.join(jobsDir, "task-legacy.json"), "{malformed");
  fs.writeFileSync(path.join(jobsDir, "task-finished.json"), JSON.stringify({ ...jobs[1],
    usage: { inputTokens: 10, cachedInputTokens: 4, outputTokens: 3, totalTokens: 13 } }));
  const damaged = f.call("status", "--all", "--json");
  const intact = damaged.status === 0 && JSON.parse(damaged.stdout);
  assert.deepEqual(intact && { jobs: [...intact.running, intact.latestFinished, ...intact.recent].map(job => job.id),
    usageTotals: intact.usageTotals }, { jobs: jobs.map(job => job.id), usageTotals: {
    inputTokens: 10, cachedInputTokens: 4, outputTokens: 3, totalTokens: 13, jobsWithUsage: 1, jobsWithoutUsage: 3 } }, damaged.stderr);
  const usage = { inputTokens: 10, cachedInputTokens: 4, outputTokens: 3, totalTokens: 13 };
  fs.writeFileSync(path.join(jobsDir, "task-finished.json"), JSON.stringify({ ...jobs[1], result: { usage } }));
  fs.writeFileSync(path.join(jobsDir, "task-active.json"), JSON.stringify({ ...jobs[0], result: { usage } }));
  fs.writeFileSync(path.join(stateDir, "state.json"), JSON.stringify({ version: 1, config: {},
    jobs: jobs.map(job => ({ ...job, usage: null })) }));
  const nullCached = f.call("status", "--all", "--json");
  assert.deepEqual(nullCached.status === 0 && JSON.parse(nullCached.stdout).usageTotals,
    { ...usage, jobsWithUsage: 1, jobsWithoutUsage: 3 }, nullCached.stderr);
  const indexed = run(process.execPath, ["--input-type=module", "-e", `
    import fs from "node:fs";
    import { updateJob, listJobs } from ${JSON.stringify(new URL("../plugins/codex/scripts/lib/state.mjs", import.meta.url).href)};
    import { buildStatusSnapshot } from ${JSON.stringify(new URL("../plugins/codex/scripts/lib/job-control.mjs", import.meta.url).href)};
    updateJob(process.cwd(), "task-finished", () => ({ status: "completed" }));
    fs.unlinkSync(${JSON.stringify(path.join(jobsDir, "task-finished.json"))});
    console.log(JSON.stringify({ usage: listJobs(process.cwd()).find(job => job.id === "task-finished").usage,
      usageTotals: buildStatusSnapshot(process.cwd(), { all: true }).usageTotals }));
  `], { cwd: f.repo, env: f.env });
  assert.deepEqual(indexed.status === 0 && JSON.parse(indexed.stdout), { usage,
    usageTotals: { ...usage, jobsWithUsage: 1, jobsWithoutUsage: 3 } }, indexed.stderr);
});

test("status previews recent structured activity and identifies the worker and run settings", () => {
  const workspace = makeTempDir(), logFile = path.join(workspace, "worker.log");
  fs.writeFileSync(logFile, "[now] Activity recorded.\n");
  const job = { id: "task-activity", jobClass: "task", status: "running", pid: process.pid,
    agentName: "StatusWorker", request: { model: "fixture-model", effort: "high", sandbox: "workspace-write" }, logFile };
  seedLegacyJobs(workspace, [job]);
  const activity = [
    ...Array.from({ length: 8 }, (_, i) => ({ type: "agentMessage", text: `Older message ${i}` })),
    { type: "commandExecution", command: "npm run build", lifecycle: "completed", status: "completed", exitCode: 0 },
    { type: "commandExecution", command: "npm test", lifecycle: "started", status: "inProgress" },
    { type: "commandExecution", command: "npm test", lifecycle: "completed", status: "failed", exitCode: 4 },
    { type: "fileChange", path: "src/fix.mjs", kind: "update", status: "completed", added: 2, removed: 1 },
    { type: "agentMessage", text: "\x1b[31mChecking\x1b[0m the fix\nwith evidence.\u202e" }
  ].map((event, index) => ({ ...event, seq: index + 1 }));
  // The index deliberately has no activity: status must consult the private record.
  writeJobFile(workspace, job.id, { ...job, activity, activityPendingTools: { private: 1 } });
  const call = (...args) => run(process.execPath, [SCRIPT, "status", ...args], { cwd: workspace });
  const response = call("StatusWorker", "--json");
  assert.equal(response.status, 0, response.stderr);
  const current = JSON.parse(response.stdout).job;
  assert.equal(current.model, job.request.model);
  assert.equal(current.effort, job.request.effort);
  assert.equal(current.sandbox, job.request.sandbox);
  assert.equal(current.progressPreview.length, 8);
  assert.match(current.progressPreview.join("\n"), /Bash\(npm test\).*running/);
  assert.match(current.progressPreview.join("\n"), /Bash\(npm test\).*exit 4/);
  assert.match(current.progressPreview.join("\n"), /Bash\(npm run build\).*exit 0/);
  assert.match(current.progressPreview.join("\n"), /Update\(src\/fix.mjs\)/);
  assert.match(current.progressPreview.at(-1), /Codex: Checking the fix with evidence/);
  assert.doesNotMatch(current.progressPreview.join("\n"), /Activity recorded|Older message 0|[\x1b\u202e]/);
  assert.equal(current.activity, undefined);
  assert.equal(current.activityPendingTools, undefined);
  for (const args of [[job.id], ["--all"]]) {
    const human = call(...args);
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /StatusWorker/);
    assert.match(human.stdout, /fixture-model.*high/);
    assert.match(human.stdout, /workspace-write/);
  }
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

test("human review and result displays neutralize controls while artifacts and JSON retain worker text", async () => {
  const render = await import("../plugins/codex/scripts/lib/render.mjs");
  const raw = "MARK\x1b[2K\x1b]marker\x07\x85\u202e\r\n\tTAIL";
  const clean = "MARK ]marker    \n\tTAIL";
  const meta = { reviewLabel: "Review", targetLabel: "fixture", reasoningSummary: [raw] };
  const review = { verdict: "approve", summary: raw, findings: [{ severity: "low", title: raw,
    body: raw, file: raw, line_start: 1, line_end: 1, confidence: 1, recommendation: raw }], next_steps: [raw] };
  const { repo, env } = runtimeFixture();
  const result = run(process.execPath, [SCRIPT, "task", "Return the harmless display marker."],
    { cwd: repo, env: { ...env, CODEX_FIXTURE_TASK_OUTPUT: raw } });
  assert.equal(result.status, 0, result.stderr);
  const status = run(process.execPath, [SCRIPT, "status", "--json"], { cwd: repo, env });
  assert.equal(status.status, 0, status.stderr);
  const job = JSON.parse(status.stdout).latestFinished;
  const stored = run(process.execPath, [SCRIPT, "result", job.id, "--json"], { cwd: repo, env });
  assert.equal(stored.status, 0, stored.stderr);
  const full = JSON.parse(stored.stdout), before = fs.readFileSync(job.resultFile);
  const active = { ...full.job, status: "running", summary: raw, pendingQuestion: { text: raw, options: [raw] } };
  const outputs = [result.stdout, render.renderTaskResult({ rawOutput: raw }),
    render.renderTaskResult({ failureMessage: raw }),
    render.renderStoredJobResult(full.job, full.storedJob),
    render.renderReviewResult({ parsed: review }, meta),
    render.renderReviewResult({ parseError: raw, rawOutput: raw }, meta),
    render.renderReviewResult({ parsed: {}, rawOutput: raw }, meta),
    render.renderNativeReviewResult({ stdout: raw, stderr: raw, status: 0 }, meta),
    render.renderStatusReport({ sessionRuntime: { label: "fixture" }, config: {}, running: [active], recent: [] }),
    render.renderJobStatusReport(active), render.renderCancelReport(active)];
  assert.deepEqual(outputs.map(output => ({ marker: output.includes(clean),
    controls: /[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(output) })),
    outputs.map(() => ({ marker: true, controls: false })));
  assert.equal(fs.readFileSync(job.rawOutputFile, "utf8"), raw);
  assert.equal(JSON.parse(before).rawOutput, raw);
  assert.equal(full.storedJob.result.rawOutput, raw);
  assert.deepEqual(fs.readFileSync(job.resultFile), before);
  assert.equal(render.renderReviewDetails({}, { result: { result: review } }).summary, raw);
});

test("status --wait returns an active job with a timeout marker", () => {
  const workspace = makeTempDir();
  seedLegacyJobs(workspace, [{ id: "task-live", status: "running", jobClass: "task" }]);
  const result = run(process.execPath, [SCRIPT, "status", "task-live", "--wait", "--timeout-ms", "1", "--json"], { cwd: workspace });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.job.id, "task-live");
  assert.equal(payload.job.status, "running");
  assert.equal(payload.waitTimedOut, true);
});

test("result selects the latest finished job in scope and preserves its stored output", () => {
  const workspace = makeTempDir();
  const jobs = ["current", "other"].map((name, index) => ({
    id: `review-${name}`, status: "completed", jobClass: "review", sessionId: `sess-${name}`,
    threadId: `thr_${name}`, updatedAt: `2026-03-18T15:${10 + index}:00.000Z`,
    result: { codex: { stdout: `OUTPUT_${name}` } }
  }));
  seedLegacyJobs(workspace, jobs);
  const call = (env, ...args) => run(process.execPath, [SCRIPT, "result", ...args], { cwd: workspace, env });
  for (const [env, expected] of [[{}, jobs[1]], [{ CODEX_COMPANION_SESSION_ID: "sess-current" }, jobs[0]]]) {
    const result = call(env);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, "completed");
    assert.equal(report.jobId, expected.id);
    assert.equal(report.summary, expected.result.codex.stdout);
    assert.equal(report.next, null);
    const details = call(env, "--details");
    assert.equal(details.status, 0, details.stderr);
    assert.equal(JSON.parse(details.stdout).threadId, expected.threadId);
  }
});

test("cancel across sessions does not kill an unverified legacy PID or claim confirmation", async (t) => {
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
  fs.writeFileSync(logFile, "");
  const jobFile = path.join(jobsDir, "task-live.json");
  const jobs = [{ id: "task-live", status: "running", jobClass: "task", sessionId: "sess-other",
    pid: sleeper.pid, logFile, updatedAt: "2026-03-18T15:30:02.000Z" }];
  seedLegacyJobs(workspace, jobs);
  const scoped = run(process.execPath, [SCRIPT, "cancel", "--session", "sess-current", "--json"], { cwd: workspace });
  assert.equal(scoped.status, 1);
  assert.equal(JSON.parse(fs.readFileSync(jobFile)).cancelRequested, undefined);

  const cancelResult = run("node", [SCRIPT, "cancel", "task-live", "--session", "sess-current", "--json"], {
    cwd: workspace
  });

  assert.equal(cancelResult.status, 2, cancelResult.stderr);
  assert.equal(JSON.parse(cancelResult.stdout).jobId, "task-live");
  assert.equal(JSON.parse(cancelResult.stdout).confirmation, "unconfirmed");
  assert.doesNotThrow(() => process.kill(sleeper.pid, 0));
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.equal(state.jobs.find(job => job.id === "task-live").status, "running");
  assert.equal(state.jobs.find(job => job.id === "task-live").cancelRequested.reason, "cancelled_by_user");
  assert.equal(JSON.parse(fs.readFileSync(jobFile)).status, "running");

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

  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: repo,
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

  seedLegacyJobs(repo, [
    { id: "review-completed", status: "completed", sessionId: "sess-current", logFile: completedLog },
    { id: "review-running", status: "running", sessionId: "sess-current", pid: sleeper.pid, logFile: runningLog },
    { id: "review-other", status: "completed", sessionId: "sess-other", logFile: otherSessionLog }
  ]);

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

test("stop hook blocks on findings once and skips review when stop_hook_active is true", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const env = { ...buildEnv(binDir), CODEX_COMPANION_HOME: path.join(binDir, "isolated"),
    CODEX_COMPANION_SESSION_ID: "sess-stop-review",
    CODEX_FIXTURE_TASK_OUTPUT: "BLOCK: Missing empty-state guard in src/app.js:4-6.\nHandle empty input.\nPreserve retries.\nAdd a regression check.\nOmitted fifth line." };
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir, "refreshable-auth");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const setup = run("node", [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo,
    env
  });
  assert.equal(setup.status, 0, setup.stderr);
  const setupPayload = JSON.parse(setup.stdout);
  assert.equal(setupPayload.reviewGateEnabled, true);

  const taskResult = run("node", [SCRIPT, "task", "--write", "fix the issue"], {
    cwd: repo,
    env
  });
  assert.equal(taskResult.status, 0, taskResult.stderr);
  const taskThread = JSON.parse(fs.readFileSync(fakeStatePath, "utf8")).lastTurnStart.threadId;
  fs.writeFileSync(path.join(repo, "README.md"), "changed\n");

  const blocked = run("node", [STOP_HOOK], {
    cwd: repo,
    env,
    input: JSON.stringify({
      cwd: repo,
      session_id: "sess-stop-review",
      last_assistant_message: "I completed the refactor and updated the retry logic."
    })
  });
  assert.equal(blocked.status, 0, blocked.stderr);
  const blockedPayload = JSON.parse(blocked.stdout);
  assert.equal(blockedPayload.decision, "block");
  assert.match(blockedPayload.reason, /src\/app\.js:4-6/);

  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  const statePath = path.join(resolveStateDir(repo, env), "state.json");
  const jobsBefore = JSON.parse(fs.readFileSync(statePath, "utf8")).jobs;
  const gateJob = jobsBefore.find(job => job.title === "Codex Stop Gate Review");
  assert.ok(gateJob);
  assert.ok(blockedPayload.reason.includes(`fugato result ${gateJob.id}`));
  assert.match(blockedPayload.reason, /Handle empty input\.\nPreserve retries\.\nAdd a regression check\./);
  assert.doesNotMatch(blockedPayload.reason, /Omitted fifth line/);
  assert.equal(fakeState.lastThreadStart.ephemeral, true);

  {
    const allowed = run("node", [STOP_HOOK], {
      cwd: repo,
      env,
      input: JSON.stringify({
        cwd: repo,
        session_id: "sess-stop-review",
        stop_hook_active: true,
        last_assistant_message: "I fixed the review findings."
      })
    });
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.equal(allowed.stdout.trim(), "");
    assert.deepEqual(JSON.parse(fs.readFileSync(fakeStatePath, "utf8")), fakeState,
      "stop-hook continuation must not start another Codex review turn");
    assert.deepEqual(JSON.parse(fs.readFileSync(statePath, "utf8")).jobs, jobsBefore,
      "stop-hook continuation must not create another review job");
  }

  const status = run("node", [SCRIPT, "status"], {
    cwd: repo,
    env
  });
  assert.equal(status.status, 0, status.stderr);
  const resumed = run(process.execPath, [SCRIPT, "task", "--resume-last", "follow up"], {
    cwd: repo, env
  });
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(JSON.parse(fs.readFileSync(fakeStatePath, "utf8")).lastTurnStart.threadId, taskThread);

  const quoted = run(process.execPath, [SCRIPT, "task", "--fresh", "--json",
    'Explain the sentence "Run a stop-gate review of the previous Claude turn."'], { cwd: repo, env });
  const quotedState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  const followQuoted = run(process.execPath, [SCRIPT, "task", "--resume-last", "--json", "follow up on the explanation"], { cwd: repo, env });
  assert.deepEqual({ exit: quoted.status, persistent: !quotedState.lastThreadStart.ephemeral, resumed: followQuoted.status,
    sameThread: JSON.parse(fs.readFileSync(fakeStatePath, "utf8")).lastTurnStart.threadId === quotedState.lastTurnStart.threadId },
  { exit: 0, persistent: true, resumed: 0, sameThread: true }, "quoting the gate prompt stays an ordinary resumable task");
});

test("stop hook skips clean workspaces and active writers from any session without starting a review", () => {
  const { repo, binDir, env } = runtimeFixture();
  setConfig(repo, "stopReviewGate", true);
  const stop = () => run(process.execPath, [STOP_HOOK], { cwd: repo, env,
    input: JSON.stringify({ cwd: repo, session_id: "sess-current" }) });
  const clean = stop();
  assert.equal(clean.status, 0, clean.stderr);
  assert.equal(clean.stdout, "");
  assert.match(clean.stderr, /no (?:workspace )?changes/i);
  assert.equal(fs.existsSync(fixtureStatePath(binDir)), false);

  const { repo: outer } = runtimeFixture(), { repo: inner } = runtimeFixture();
  run("git", ["-c", "protocol.file.allow=always", "submodule", "add", inner, "inner"], { cwd: outer });
  run("git", ["config", "-f", ".gitmodules", "submodule.inner.ignore", "all"], { cwd: outer });
  run("git", ["commit", "-am", "inner"], { cwd: outer });
  run("git", ["-c", "protocol.file.allow=always", "submodule", "add", outer, "outer"], { cwd: repo });
  run("git", ["commit", "-am", "outer"], { cwd: repo });
  run("git", ["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive"], { cwd: repo });
  run("git", ["config", "submodule.outer.ignore", "all"], { cwd: repo });
  const nestedFile = path.join(repo, "outer", "inner", "untracked.txt");
  fs.writeFileSync(nestedFile, "nested reviewable work\n");
  const singleStatus = run("git", ["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"], { cwd: repo });
  const nested = stop();
  assert.deepEqual({ statusExit: singleStatus.status, singleStatus: singleStatus.stdout,
    decision: JSON.parse(nested.stdout || "null")?.decision },
  { statusExit: 0, singleStatus: "", decision: "block" }, "nested ignore settings require the bounded recursive check");
  fs.unlinkSync(nestedFile);
  const afterNested = JSON.parse(fs.readFileSync(fixtureStatePath(binDir), "utf8"));

  fs.writeFileSync(path.join(repo, "untracked.txt"), "reviewable work\n");
  upsertJob(repo, { id: "writer-other-session", status: "running", jobClass: "task",
    sessionId: "sess-other", sandbox: "workspace-write", pid: process.pid });
  const writing = stop();
  assert.equal(writing.status, 0, writing.stderr);
  assert.equal(writing.stdout, "");
  assert.match(writing.stderr, /writer-other-session/);
  assert.deepEqual(JSON.parse(fs.readFileSync(fixtureStatePath(binDir), "utf8")), afterNested);

  upsertJob(repo, { id: "writer-other-session", status: "completed", pid: null, result: { turnEnded: true } });
  upsertJob(repo, { id: "writer-stale", status: "running", jobClass: "task", sandbox: "workspace-write",
    pid: 2147483647, updatedAt: "2000-01-01T00:00:00.000Z" });
  upsertJob(repo, { id: "writer-abandoned", status: "queued", jobClass: "task", sandbox: "workspace-write",
    createdAt: "2000-01-01T00:00:00.000Z", updatedAt: "2000-01-01T00:00:00.000Z", launcherPid: 2147483647 });
  const stale = stop();
  const unresolved = { id: "writer-unresolved", status: "failed", jobClass: "task", sandbox: "workspace-write",
    turnId: "turn-unresolved", result: { failureSource: "transport", turnEnded: false } };
  upsertJob(repo, { ...unresolved, result: undefined });
  writeJobFile(repo, unresolved.id, unresolved);
  const stillWriting = stop();
  assert.deepEqual({ staleReview: JSON.parse(stale.stdout || "null")?.decision, unresolvedOutput: stillWriting.stdout,
    unresolvedWriter: stillWriting.stderr.includes(unresolved.id) },
  { staleReview: "block", unresolvedOutput: "", unresolvedWriter: true }, "stale launch records allow review while an unresolved writable turn defers it");
  upsertJob(repo, { id: unresolved.id, recovered: true });
  writeJobFile(repo, unresolved.id, { ...unresolved, recovered: true });
  upsertJob(repo, { id: "writer-stale", status: "completed", result: { turnEnded: true } });
  upsertJob(repo, { id: "writer-abandoned", status: "cancelled" });
  const changed = stop();
  assert.equal(changed.status, 0, changed.stderr);
  assert.equal(JSON.parse(changed.stdout).decision, "block", "untracked work must still be reviewed");
});

test("stop gate protects accepted handleless writers only within their owner lease", () => {
  const { repo, env } = runtimeFixture();
  setConfig(repo, "stopReviewGate", true);
  fs.writeFileSync(path.join(repo, "README.md"), "changed\n");
  const now = Date.now();
  const acceptedWriter = { id: "accepted-writer", jobClass: "task", status: "running", sandbox: "workspace-write",
    threadId: "accepted-thread", pid: 2147483647, leaseExpiresAt: now + 60000 };
  upsertJob(repo, acceptedWriter);
  writeJobFile(repo, acceptedWriter.id, acceptedWriter);
  const stop = () => run(process.execPath, [STOP_HOOK], { cwd: repo, env, input: JSON.stringify({ cwd: repo }) });
  const leased = stop();
  updateJob(repo, acceptedWriter.id, () => ({ leaseExpiresAt: now - 1 }));
  const legacyWriter = { id: "legacy-accepted-writer", jobClass: "task", status: "running", sandbox: "workspace-write",
    threadId: "legacy-thread", pid: 2147483647, leaseSec: 3600, updatedAt: new Date(now - 600000).toISOString() };
  upsertJob(repo, legacyWriter);
  writeJobFile(repo, legacyWriter.id, legacyWriter);
  const legacy = stop();
  updateJob(repo, legacyWriter.id, () => ({ leaseExpiresAt: now - 1 }));
  const expired = stop();
  assert.deepEqual({ exits: [leased.status, legacy.status, expired.status], leased: leased.stdout,
    leasedWriter: leased.stderr.includes("task accepted-writer"), legacy: legacy.stdout,
    legacyWriter: legacy.stderr.includes("task legacy-accepted-writer"), expired: JSON.parse(expired.stdout || "null")?.decision },
  { exits: [0, 0, 0], leased: "", leasedWriter: true, legacy: "", legacyWriter: true, expired: "block" });
});

test("stop gate reads recent writable completed records without scanning old or read-only history", () => {
  const { repo, binDir, env } = runtimeFixture();
  setConfig(repo, "stopReviewGate", true);
  fs.writeFileSync(path.join(repo, "README.md"), "changed\n");
  upsertJob(repo, { id: "old-writer", jobClass: "task", status: "completed", sandbox: "workspace-write",
    updatedAt: new Date(Date.now() - 30000).toISOString(), leaseSec: 1, turnId: "old-turn" });
  writeJobFile(repo, "old-writer", { result: { inferredCompletion: true, turnEnded: false } });
  upsertJob(repo, { id: "reader", jobClass: "task", status: "failed", sandbox: "read-only" });
  writeJobFile(repo, "reader", { status: "failed" });
  upsertJob(repo, { id: "inferred-writer", jobClass: "task", status: "completed", sandbox: "workspace-write",
    updatedAt: new Date(Date.now() - 60000).toISOString(), turnId: "open-turn" });
  writeJobFile(repo, "inferred-writer", { jobClass: "task", status: "completed", sandbox: "workspace-write",
    turnId: "open-turn", result: { inferredCompletion: true, turnEnded: false } });
  upsertJob(repo, { id: "unreadable-writer", jobClass: "task", status: "running", sandbox: "workspace-write", pid: process.pid });
  fs.writeFileSync(path.join(resolveStateDir(repo), "jobs", "unreadable-writer.json"), "{broken");
  const preload = path.join(binDir, "record-reads.mjs"), capture = path.join(binDir, "reads.json");
  fs.writeFileSync(preload, `
    import fs from "node:fs";
    const readFileSync = fs.readFileSync, reads = [];
    fs.readFileSync = function(file, ...args) {
      if (/(?:old-writer|reader|inferred-writer|unreadable-writer)\\.json$/.test(String(file))) reads.push(String(file).split(/[\\\\/]/).at(-1));
      return readFileSync.call(this, file, ...args);
    };
    process.on("exit", () => fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify(reads)));
  `);
  const result = run(process.execPath, ["--import", preload, STOP_HOOK], { cwd: repo, env, input: JSON.stringify({ cwd: repo }) });
  assert.deepEqual({ exit: result.status, output: result.stdout, writer: result.stderr.includes("task inferred-writer"),
    reads: JSON.parse(fs.readFileSync(capture, "utf8")), reviewed: fs.existsSync(fixtureStatePath(binDir)) },
  { exit: 0, output: "", writer: true, reads: ["unreadable-writer.json", "inferred-writer.json"], reviewed: false });
});

test("stop gate reviews when clean index metadata exceeds the limit", () => {
  const { repo, binDir, env } = runtimeFixture();
  setConfig(repo, "stopReviewGate", true);
  const preload = path.join(binDir, "large-index.mjs"), capture = path.join(binDir, "fallback.json");
  fs.writeFileSync(preload, `
    import fs from "node:fs";
    import childProcess from "node:child_process";
    import { syncBuiltinESMExports } from "node:module";
    const spawnSync = childProcess.spawnSync;
    childProcess.spawnSync = function(command, args, options) {
      if (command === "git" && args[0] === "ls-files" && args.includes("--stage")) {
        return { status: null, error: Object.assign(new Error("large index"), { code: "ENOBUFS" }) };
      }
      if (command === "git" && args.includes("--porcelain")) {
        fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ args,
          bounded: options.timeout > 0 && options.timeout <= 10000 && options.maxBuffer > 0 }));
      }
      return spawnSync(command, args, options);
    };
    syncBuiltinESMExports();
  `);
  const result = run(process.execPath, ["--import", preload, STOP_HOOK], { cwd: repo, env, input: JSON.stringify({ cwd: repo }) });
  assert.deepEqual({ exit: result.status, decision: JSON.parse(result.stdout || "null")?.decision,
    reviewed: fs.existsSync(fixtureStatePath(binDir)),
    fallback: fs.existsSync(capture) ? JSON.parse(fs.readFileSync(capture, "utf8")) : null },
  { exit: 0, decision: "block", reviewed: true, fallback: null });
});

test("stop gate bounds every clean-check git call including nested modules and reviews on timeout", () => {
  const { repo, binDir, env } = runtimeFixture();
  setConfig(repo, "stopReviewGate", true);
  fs.mkdirSync(path.join(repo, "nested"));
  fs.writeFileSync(path.join(repo, "nested", ".git"), "fixture gitlink\n");
  const preload = path.join(binDir, "git-clock.mjs"), capture = path.join(binDir, "git-timeouts.json");
  fs.writeFileSync(preload, `
    import fs from "node:fs";
    import childProcess from "node:child_process";
    import { syncBuiltinESMExports } from "node:module";
    import { performance } from "node:perf_hooks";
    let elapsed = 865000, roots = 0;
    const calls = [];
    Object.defineProperty(performance, "now", { value: () => elapsed });
    const spawnSync = childProcess.spawnSync;
    childProcess.spawnSync = function(command, args, options) {
      if (command === "git") {
        if (args[0] === "rev-parse" && ++roots === 1) return { status: 0, stdout: ${JSON.stringify(repo + "\n")} };
        calls.push({ timeout: options?.timeout ?? null, nested: options.cwd.endsWith("/nested") });
        elapsed += 100;
        if (options.cwd.endsWith("/nested")) return { status: null, error: Object.assign(new Error("slow submodule"), { code: "ETIMEDOUT" }) };
        const stdout = args[0] === "rev-parse" ? ${JSON.stringify(repo + "\n")} :
          args[0] === "ls-files" && args.includes("--stage") ? "160000 abcdef 0\\tnested\\0" : "";
        return { status: 0, stdout };
      }
      if (args?.[0] === "--version" || (args?.[0] === "app-server" && args[1] === "--help")) return { status: 0, stdout: "fixture" };
      if (args?.[0] === ${JSON.stringify(SCRIPT)} && args[1] === "task") {
        fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ calls, reviewTimeout: options.timeout }));
        return { status: 0, stdout: JSON.stringify({ rawOutput: "BLOCK: Review after Git timeout." }) };
      }
      return spawnSync(command, args, options);
    };
    syncBuiltinESMExports();
  `);
  const result = run(process.execPath, ["--import", preload, STOP_HOOK], { cwd: repo, env, input: JSON.stringify({ cwd: repo }) });
  assert.deepEqual({ exit: result.status, decision: JSON.parse(result.stdout || "null")?.decision,
    recorded: JSON.parse(fs.readFileSync(capture, "utf8")) },
  { exit: 0, decision: "block", recorded: { calls: [5000, 4900, 4800, 4700, 4600, 4500, 4400]
    .map((timeout, index) => ({ timeout, nested: index === 6 })), reviewTimeout: 4300 } });
});

test("stop hook allows clean, disabled, unavailable and failed reviews", () => {
  for (const [behavior, options = {}] of [
    ["adversarial-clean"], ["review-ok", { disabled: true }], ["review-ok", { unavailable: true }],
    ["auth-run-fails", { failure: true }], ["verbose-task", { failure: true }],
    ["review-ok", { raw: "BLOCK:   \n", failure: true }]
  ]) {
    const { repo, env } = runtimeFixture(behavior);
    fs.writeFileSync(path.join(repo, "README.md"), "changed\n");
    setConfig(repo, "stopReviewGate", !options.disabled);
    if (options.disabled) {
      upsertJob(repo, { id: "task-live", status: "running", jobClass: "task", sessionId: "sess-current" });
    }
    if (options.unavailable) env.PATH = "";
    if (options.raw !== undefined) env.CODEX_FIXTURE_TASK_OUTPUT = options.raw;
    const result = run(process.execPath, [STOP_HOOK], { cwd: repo,
      env: { ...env, CODEX_COMPANION_SESSION_ID: "sess-current" },
      input: JSON.stringify({ cwd: repo, stop_hook_active: false }) });
    assert.equal(result.status, 0, `${behavior}: ${result.stderr}`);
    assert.equal(result.stdout.trim(), "", `${behavior}: technical failures cannot block a stop`);
    if (options.failure) assert.ok(result.stderr.trim().length);
  }
});

test("stop review reserves exit time from process start across backward clock steps and reports timeout without blocking", () => {
  const { repo, env } = runtimeFixture(), preload = path.join(repo, "stop-clock.mjs"), capture = path.join(repo, "stop-timeout.json");
  setConfig(repo, "stopReviewGate", true);
  fs.writeFileSync(preload, `
    import fs from "node:fs";
    import childProcess from "node:child_process";
    import { syncBuiltinESMExports } from "node:module";
    import { performance } from "node:perf_hooks";
    const started = Math.floor(performance.timeOrigin);
    let elapsed = 1000; // Simulate module-loading time before the hook runs.
    let wallOffset = 0;
    Object.defineProperty(performance, "now", { value: () => elapsed });
    Date.now = () => started + elapsed + wallOffset;
    process.stdin.prependOnceListener("data", () => { elapsed += 2000; wallOffset -= 60000; });
    const spawnSync = childProcess.spawnSync;
    childProcess.spawnSync = function(command, args, options) {
      if (args?.[0] === "--version" || (args?.[0] === "app-server" && args[1] === "--help")) {
        elapsed += 500;
        return { status: 0, stdout: "codex fixture", stderr: "" };
      }
      if (args?.[0] === ${JSON.stringify(SCRIPT)} && args[1] === "task") {
        fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ elapsed, timeout: options.timeout }));
        return { status: null, error: Object.assign(new Error("review timeout"), { code: "ETIMEDOUT" }) };
      }
      return spawnSync(command, args, options);
    };
    syncBuiltinESMExports();
  `);
  const result = run(process.execPath, ["--import", preload, STOP_HOOK], { cwd: repo, env,
    input: JSON.stringify({ cwd: repo }) });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /timed out/);
  const recorded = JSON.parse(fs.readFileSync(capture, "utf8"));
  assert.equal(recorded.elapsed, 4000);
  assert.equal(recorded.timeout, 900000 - 30000 - recorded.elapsed);
  assert.ok(recorded.timeout > 0);
  assert.ok(recorded.timeout <= 870000);
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
