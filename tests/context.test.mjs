import "./test-environment.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { makeTempDir, initGitRepo, run, waitForCondition } from "./helpers.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { gitContext } from "../plugins/codex/scripts/lib/git-context.mjs";
import { agentMemoryFile, prepareAgentMemory } from "../plugins/codex/scripts/lib/agent-memory.mjs";
import { prepareClaudeSkills } from "../plugins/codex/scripts/lib/claude-memory.mjs";
import { skillInventory } from "../plugins/codex/hooks/claude-memory.mjs";
import { buildTurnInput } from "../plugins/codex/scripts/lib/codex.mjs";
import { contextSetup } from "../plugins/codex/scripts/lib/setup-config.mjs";
import { tryAcquireConcurrency, acquireConcurrency } from "../plugins/codex/scripts/lib/concurrency.mjs";
import { spawnOwned } from "../plugins/codex/scripts/lib/process.mjs";
import { once } from "node:events";

import { resolveStateDir } from "../plugins/codex/scripts/lib/state.mjs";

const script = new URL("../plugins/codex/scripts/codex-companion.mjs", import.meta.url).pathname;
const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
function fixture(t) {
  const root = makeTempDir("duet-context-"), repo = path.join(root, "repo");
  fs.mkdirSync(repo); initGitRepo(repo); installFakeCodex(root);
  const env = { ...buildEnv(root), CODEX_COMPANION_HOME: path.join(root, "isolated") };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const call = (...args) => {
    const result = run(process.execPath, [script, ...args], { cwd: repo, env });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return JSON.parse(result.stdout);
  };
  return { root, repo, env, call, state: () => JSON.parse(fs.readFileSync(path.join(root, "fake-codex-state.json"))) };
}

test("git context precedes the task, bounds changed paths and skips non-git/opt-out/failure", t => {
  const f = fixture(t);
  for (let index = 0; index < 48; index++) put(path.join(f.repo, `changed-${index}.txt`), "changed");
  const context = gitContext(f.repo, f.env);
  assert.match(context, /Branch\/upstream:.*main/);
  assert.equal(context.split("\n").filter(line => line.startsWith("?? ")).length, 40);
  assert.match(context, /8 additional changed paths omitted/);
  assert.ok(Buffer.byteLength(context) < 25 * 1024);
  assert.equal(gitContext(f.root, f.env), "");
  assert.equal(gitContext(f.repo, { ...f.env, CODEX_COMPANION_GIT_CONTEXT: "0" }), "");
  assert.equal(gitContext(f.repo, { ...f.env, PATH: path.join(f.root, "missing") }), "");
  f.call("task", "--json", "Context brief.");
  assert.ok(f.state().lastTurnStart.rawPrompt.startsWith(context + "Context brief."));
});

test("only declared agent skills cross over as supported items or bounded fallback text", t => {
  const f = fixture(t), pluginRoot = path.join(f.root, "plugin");
  const file = path.join(pluginRoot, "skills", "review", "SKILL.md");
  put(path.join(pluginRoot, "agents", "codex-native.md"), "---\nname: codex-native\nskills:\n  - codex:review\n---\nAgent.");
  put(file, "# Review\nFollow the review contract.");
  const options = { agentType: "codex:codex-native", pluginRoot, cwd: f.repo };
  const fallback = prepareClaudeSkills(options, f.env);
  assert.match(fallback.text, /Follow the review contract/);
  assert.deepEqual(fallback.skills, []);
  const supported = prepareClaudeSkills({ ...options, skillItemsSupported: true }, f.env);
  assert.equal(supported.text, "");
  assert.deepEqual(buildTurnInput("brief", supported.skills).at(-1), { type: "skill", name: "codex:review", path: file });
  assert.deepEqual(prepareClaudeSkills({ agentType: "unknown", pluginRoot, cwd: f.repo }, f.env), { text: "", skills: [] });
  assert.deepEqual(prepareClaudeSkills({ ...options, skills: [] }, f.env), { text: "", skills: [] });
  assert.deepEqual(skillInventory([{ name: "bad", text: "x".repeat(30001) }]), []);
  const many = Array.from({ length: 40 }, (_, i) => ({ name: `skill-${i}`, text: "x".repeat(4000) }));
  assert.ok(prepareClaudeSkills({ skills: many }, f.env).text.length < 31000);
  assert.equal(buildTurnInput("brief").length, 1);
  for (const directory of ["scripts", "hooks", "bin", "prompts", "schemas", ".claude-plugin"]) {
    const source = new URL(`../plugins/codex/${directory}`, import.meta.url);
    if (fs.existsSync(source)) fs.cpSync(source, path.join(pluginRoot, directory), { recursive: true });
  }
  const known = run(process.execPath, [path.join(pluginRoot, "scripts", "codex-companion.mjs"), "task", "--agent-name", "Ada", "--json", "Known skill."], { cwd: f.repo, env: f.env });
  assert.equal(known.status, 0, known.stderr + known.stdout);
  assert.match(f.state().lastThreadStart.developerInstructions, /Follow the review contract/);
  const first = f.state().lastThreadStart;
  put(file, "# Review\nChanged skill text for fresh threads only.");
  const resumed = run(process.execPath, [path.join(pluginRoot, "scripts", "codex-companion.mjs"), "task", "--thread", f.state().threads[0].id, "--json", "Continue skill."], { cwd: f.repo, env: f.env });
  assert.equal(resumed.status, 0, resumed.stderr + resumed.stdout);
  assert.equal(f.state().lastThreadResume.developerInstructions, first.developerInstructions);
  // No agent skills are declared by the shipped worker; parent session skills
  // and inventories are not consulted even when their files exist.
  put(path.join(f.env.HOME, ".claude", "skills", "private", "SKILL.md"), "PARENT_ONLY_SKILL");
  f.call("task", "--agent-name", "Curie", "--json", "Scoped skills.");
  assert.doesNotMatch(f.state().lastThreadStart.developerInstructions, /PARENT_ONLY_SKILL/);
});

test("agent memory is opt-in, scoped by workspace/role, bounded and injected without sandbox changes", t => {
  const f = fixture(t), options = { workspace: f.repo, role: "worker" };
  assert.deepEqual(prepareAgentMemory(options, f.env), { text: "", agentMemory: { enabled: false } });
  assert.equal(fs.existsSync(path.join(f.env.CODEX_COMPANION_HOME, "duet", "agent-memory")), false);
  const setup = f.call("setup", "--agent-memory", "on", "--json");
  assert.equal(setup.agentMemory, "on");
  const file = agentMemoryFile(f.repo, "worker", f.env);
  put(file, Array.from({ length: 250 }, (_, i) => `memory-line-${i}`).join("\n"));
  const memory = prepareAgentMemory(options, f.env);
  assert.match(memory.text, /memory-line-199\n/);
  assert.doesNotMatch(memory.text, /memory-line-200/);
  assert.equal(memory.agentMemory.bounded, true);
  assert.notEqual(file, agentMemoryFile(f.repo, "reviewer", f.env));
  assert.notEqual(file, agentMemoryFile(f.root, "worker", f.env));
  const launched = f.call("task", "--sandbox", "read-only", "--json", "Memory brief.");
  const first = f.state().lastThreadStart;
  assert.match(first.developerInstructions, /memory-line-199/);
  assert.match(first.developerInstructions, /only when the current sandbox already permits/);
  assert.equal(first.sandbox, "read-only");
  const firstJob = JSON.parse(fs.readFileSync(path.join(resolveStateDir(f.repo, f.env), "jobs", `${launched.jobId}.json`)));
  put(file, "Memory changed after dispatch.");
  f.call("setup", "--agent-memory", "off", "--json");
  const continuation = f.call("task", "--continue", firstJob.id, "--json", "Continue memory.");
  assert.equal(f.state().lastThreadResume.developerInstructions, first.developerInstructions);
  const resumedJob = JSON.parse(fs.readFileSync(path.join(resolveStateDir(f.repo, f.env), "jobs", `${continuation.jobId}.json`)));
  assert.deepEqual(resumedJob.request.agentMemory, firstJob.request.agentMemory);
  assert.deepEqual(resumedJob.request.skills, firstJob.request.skills);
  f.call("setup", "--agent-memory", "on", "--json");
  put(file, "x".repeat(50000));
  assert.ok(prepareAgentMemory(options, f.env).text.length < 27 * 1024);
  fs.unlinkSync(file); fs.symlinkSync(path.join(f.repo, "secret"), file);
  assert.equal(prepareAgentMemory(options, f.env).agentMemory.unavailable, true);
});

test("review reservations expire with their wrapper after review/start", async t => {
  const f = fixture(t);
  installFakeCodex(f.root, "w5-review");
  put(path.join(f.repo, "review.txt"), "Review fixture.");
  f.call("setup", "--max-concurrent", "1", "--json");
  const child = spawnOwned(process.execPath, [script, "review", "--scope", "working-tree", "--json"], { cwd: f.repo, env: f.env, stdio: "ignore" });
  const exited = once(child, "exit");
  t.after(() => { if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL"); });
  await waitForCondition(() => {
    const file = path.join(f.root, "fake-codex-state.json.requests.jsonl");
    return fs.existsSync(file) && fs.readFileSync(file, "utf8").includes('"method":"review/start"');
  }, "accepted review");
  const slotsFile = path.join(f.env.CODEX_COMPANION_HOME, "duet", "concurrency", "slots.json");
  const slots = JSON.parse(fs.readFileSync(slotsFile));
  child.kill("SIGKILL");
  await exited;
  const next = tryAcquireConcurrency({ limit: 1, env: f.env });
  try {
    assert.equal(slots[0].submitted, false);
    assert.ok(next, "a dead review wrapper must not strand the only slot");
  } finally { next?.release(); }
});

test("Duet concurrency is off by default and atomically queues across processes until confirmed end", async t => {
  const f = fixture(t), directory = path.join(f.env.CODEX_COMPANION_HOME, "duet", "concurrency");
  assert.equal(contextSetup({ env: f.env }).maxConcurrent, "off");
  tryAcquireConcurrency({ limit: "off", env: f.env }).release();
  assert.equal(fs.existsSync(directory), false);
  assert.equal(f.call("setup", "--max-concurrent", "1", "--json").maxConcurrent, 1);
  const held = tryAcquireConcurrency({ limit: 1, env: f.env });
  const module = new URL("../plugins/codex/scripts/lib/concurrency.mjs", import.meta.url).href;
  const attempt = submitted => run(process.execPath, ["--input-type=module", "-e", `
    import { tryAcquireConcurrency } from ${JSON.stringify(module)};
    const slot = tryAcquireConcurrency({limit: 1, jobFile: process.env.FIXTURE_JOB});
    console.log(Boolean(slot));
    if (slot) { ${submitted ? "slot.submitted();" : "slot.release();"} }
  `], { env: f.env });
  assert.equal(attempt(false).stdout.trim(), "false");
  const abort = new AbortController();
  let queued = false;
  await assert.rejects(acquireConcurrency({ env: f.env, signal: abort.signal, onQueued: () => { queued = true; abort.abort(); } }), /queue interrupted/);
  assert.equal(queued, true);
  const waiting = f.call("task", "--detached", "--report", "--json", "Wait for a slot.");
  const jobFile = path.join(resolveStateDir(f.repo, f.env), "jobs", `${waiting.jobId}.json`);
  const queuedJob = await waitForCondition(() => {
    const job = JSON.parse(fs.readFileSync(jobFile));
    return job.phase === "queued (concurrency limit)" ? job : null;
  }, "concurrency queue phase");
  assert.equal(queuedJob.status, "queued");
  assert.equal(fs.existsSync(path.join(f.root, "fake-codex-state.json")), false, "a queued worker does not admit a broker/thread turn");
  held.release();
  f.call("wait", waiting.jobId, "--owner", waiting.ownerId, "--timeout-sec", "30", "--json");
  assert.equal(attempt(false).stdout.trim(), "true");
  f.env.FIXTURE_JOB = path.join(f.root, "held-job.json");
  put(f.env.FIXTURE_JOB, JSON.stringify({ result: { turnEnded: false } }));
  assert.equal(attempt(true).stdout.trim(), "true");
  assert.equal(tryAcquireConcurrency({ limit: 1, env: f.env }), null, "dead wrapper cannot free an unconfirmed turn");
  put(f.env.FIXTURE_JOB, JSON.stringify({ result: { turnEnded: true } }));
  const released = tryAcquireConcurrency({ limit: 1, env: f.env });
  assert.ok(released); released.release();
  await assert.rejects(acquireConcurrency({ env: f.env, jobFile: f.env.FIXTURE_JOB, signal: AbortSignal.abort() }), /queue interrupted/);
  put(f.env.FIXTURE_JOB, JSON.stringify({ leaseExpiresAt: Date.now() - 1 }));
  await assert.rejects(acquireConcurrency({ env: f.env, jobFile: f.env.FIXTURE_JOB }), /lease expired/);
  // Exercise the real worker turn boundaries against the fake broker/runtime.
  const first = f.call("task", "--json", "Limited first turn.");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, "slots.json"))), []);
  f.call("task", "--thread", first.threadId, "--json", "Limited continuation.");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, "slots.json"))), []);
  assert.equal(f.call("setup", "--json").maxConcurrent, 1);
  assert.equal(f.call("setup", "--max-concurrent", "off", "--json").maxConcurrent, "off");
});
