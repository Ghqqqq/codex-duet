import test from 'node:test';
import assert from 'node:assert/strict';
import { lifecycleHarness } from './fake-codex-fixture.mjs';
const {
  fs, path, makeTempDir, initGitRepo, buildEnv, installFakeCodex, resolveStateDir, delay, run, browserOriginSetup, transportSetup, resolveIsolatedCodexHome, redactActivity, itemActivity, planActivity, activityReader, writeJobFile, upsertJob, updateJob, readJobFile, resolveJobFile, JobRuntime, pauseAdjustment, renewLease, markOwnerAttachment, leaseSnapshot, questionMessage, adoptJob, ownershipNotice, answerQuestion, askParentQuestion, ownerLost, PARENT_BRIDGE_ENV, resolveSessionMarkersRoot, AGENT_NAMES, pickAgentName, splitRawArgumentString, bridgeScript, spawnOwned, script, alive, fixture, json, directLines, direct, directError, waitUntil, patchJob, job
} = await lifecycleHarness();

// Direct-mode backpressure fixture: a fake Codex burst while the parent leaves stdout undrained.
async function until(check, timeout = 15000) {
  for (const end = Date.now() + timeout; Date.now() < end;) {
    const result = check();
    if (result) return result;
    await delay(50);
  }
  throw new Error("Backpressure fixture deadline expired");
}

// Extend only the generated temporary binary, not the shared fake fixture. Each
// fileChange notification adds 100 real activity events in one state update.
// A file gate starts the burst only after the direct owner has attached.
function installBurstCodex(dir) {
  installFakeCodex(dir, "w5-working");
  const binary = path.join(dir, "codex"), gate = path.join(dir, "burst-start");
  const branch = 'if (BEHAVIOR === "w5-parent" || BEHAVIOR === "w5-working") {';
  let source = fs.readFileSync(binary, "utf8");
  assert.ok(source.includes(branch));
  source = source.replace(branch, `${branch}
          let burst = 0;
          const burstTimer = setInterval(() => {
            if (!fs.existsSync(${JSON.stringify(gate)})) return;
            if (loadState().lastInterrupt || burst === 35) { clearInterval(burstTimer); return; }
            burst += 1;
            const changes = Array.from({ length: 100 }, (_, i) => ({
              path: "synthetic/" + burst + "/" + i + "/" + "x".repeat(170), kind: { type: "update" }
            }));
            send({ method: "item/completed", params: { threadId: thread.id, turnId,
              item: { id: "burst-" + burst, type: "fileChange", changes } } });
          }, 100);
  `);
  // D11a holds shared working turns open. Restore this fixture's existing
  // nine-second completion only in its generated w5 branch.
  const heldTimer = "const timer = null; // Held open until an explicit fixture release or turn/interrupt.";
  const completionTimer = 'const timer = setTimeout(() => emitTurnCompleted(thread.id, turnId, { completed: { type: "agentMessage", id: "fixture-done", text: "Completed fixture work.", phase: "final_answer" } }), 9000);';
  const branchStart = source.indexOf(branch);
  assert.ok(source.indexOf(heldTimer, branchStart) >= 0);
  source = source.slice(0, branchStart) + source.slice(branchStart).replace(heldTimer, completionTimer);
  fs.writeFileSync(binary, source);
  return gate;
}

async function cleanupBackpressure(dir, env) {
  const ledger = env.CODEX_COMPANION_TEST_PROCESSES;
  const records = () => fs.existsSync(ledger) ? fs.readdirSync(ledger).filter(name => name.endsWith(".json")).map(name => JSON.parse(fs.readFileSync(path.join(ledger, name)))) : [];
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    for (const record of records()) {
      if (record.exited || !alive(record.pid)) continue;
      try { process.kill(record.detached && process.platform !== "win32" ? -record.pid : record.pid, signal); }
      catch (error) {
        if (error.code === "ESRCH" || !alive(record.pid)) continue;
        if (error.code !== "EPERM") throw error;
        try { process.kill(record.pid, signal); } catch (inner) { if (inner.code !== "ESRCH") throw inner; }
      }
    }
    await delay(signal === "SIGTERM" ? 700 : 300);
  }
  assert.deepEqual(records().filter(record => !record.exited && alive(record.pid)).map(record => record.pid), [], "fixture processes stopped");
  fs.rmSync(dir, { recursive: true, force: true });
}

async function backpressureScenario(script, { timeoutSec = 30 } = {}) {
  const dir = makeTempDir("bp-"), repo = path.join(dir, "repo");
  fs.mkdirSync(repo); initGitRepo(repo);
  const gate = installBurstCodex(dir);
  const env = { ...buildEnv(dir), CODEX_COMPANION_BIN: path.join(dir, "codex"),
    CLAUDE_PLUGIN_DATA: path.join(dir, "data"), CODEX_COMPANION_HOME: path.join(dir, "isolated"),
    CODEX_COMPANION_SESSION_ID: "d2-synthetic", CODEX_COMPANION_OWNER_GRACE_SEC: "2",
    CODEX_COMPANION_TEST_MODE: "1", CODEX_COMPANION_TEST_PROCESSES: path.join(dir, "processes") };
  const began = Date.now();
  let owner;
  try {
    const launched = run(process.execPath, [script, "task", "--fresh", "--detached", "--json", "Synthetic backpressure fixture"], { cwd: repo, env });
    assert.equal(launched.status, 0, launched.stderr);
    const launch = JSON.parse(launched.stdout);
    const file = path.join(resolveStateDir(repo, env), "jobs", `${launch.jobId}.json`);
    const read = () => JSON.parse(fs.readFileSync(file, "utf8"));
    owner = spawnOwned(process.execPath, [script, "wait", launch.jobId, "--owner", launch.ownerId, "--direct", "--timeout-sec", String(timeoutSec)], { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", code;
    const closed = new Promise((resolve, reject) => { owner.once("error", reject); owner.once("close", status => { code = status; resolve(); }); });
    owner.stderr.on("data", chunk => { stderr += chunk; });
    // No stdout data listener until after the grace. The read end stays open.
    const attached = await until(() => { const current = read(); return current.ownerAttached && current.turnId && current; });
    const pausedAt = Date.now();
    fs.writeFileSync(gate, "start");
    await delay(6500);
    const beforeDrain = read(), undrainedMs = Date.now() - pausedAt;
    const heartbeatAgeMs = Date.now() - beforeDrain.leaseRenewedAt;
    owner.stdout.on("data", chunk => { stdout += chunk; });
    let deadline;
    try {
      await Promise.race([closed, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("Owner did not finish after draining stdout")), 15000); })]);
    } finally { clearTimeout(deadline); }
    const saved = read(), lines = stdout.trimEnd().split("\n"), final = JSON.parse(lines.at(-1));
    const omissionLines = lines.filter(line => /^… \d+ progress lines omitted$/.test(line));
    return { code, stderr, stdout, final, saved, omissionLines,
      measurements: { undrainedMs, graceMs: 2000, heartbeatAdvanceMs: beforeDrain.leaseRenewedAt - attached.leaseRenewedAt,
        heartbeatAgeMs, statusBeforeDrain: beforeDrain.status, activityEvents: final.activityCount,
        progressLines: lines.length - 1, omittedLines: omissionLines.reduce((sum, line) => sum + Number(line.split(" ")[1]), 0),
        omissionNotices: omissionLines.length, elapsedMs: Date.now() - began } };
  } finally {
    owner?.stdout.resume();
    await cleanupBackpressure(dir, env);
  }
}

test("agent names avoid collisions when the pool is exhausted", () => {
  assert.equal(new Set(AGENT_NAMES).size, AGENT_NAMES.length);
  const first = pickAgentName([], () => 0);
  assert.ok(AGENT_NAMES.includes(first));
  assert.notEqual(pickAgentName([first], () => 0), first);
  const exhausted = pickAgentName(AGENT_NAMES, () => 0);
  assert.ok(!AGENT_NAMES.includes(exhausted));
  assert.notEqual(pickAgentName([...AGENT_NAMES, exhausted], () => 0), exhausted);
});

test("simultaneous dispatches reserve different names while both jobs are active", async () => {
  const f = fixture();
  const preload = path.join(f.dir, "fixed-name-choice.mjs");
  fs.writeFileSync(preload, 'const random = Math.random; Math.random = () => new Error().stack.includes("pickAgentName") ? 0 : random();');
  const dispatch = () => new Promise((resolve, reject) => {
    const child = spawnOwned(process.execPath, ["--import", preload, script, "task", "--fresh", "--detached", "--json", "fixture"],
      { cwd: f.repo, env: f.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => { stdout += data; });
    child.stderr.on("data", data => { stderr += data; });
    child.on("error", reject);
    child.on("close", status => { try { resolve(json({ status, stdout, stderr })); } catch (error) { reject(error); } });
  });
  const launches = await Promise.all([dispatch(), dispatch()]);
  try {
    assert.deepEqual(launches.map(launch => launch.agentName).sort(), ["Ada", "Turing"]);
    for (const launch of launches) {
      const saved = job(f, launch.jobId);
      assert.ok(["queued", "running"].includes(saved.status));
      assert.equal(saved.agentName, launch.agentName);
    }
  } finally {
    for (const launch of launches) json(f.call("cancel", launch.jobId, "--json"));
  }
});

test("names avoid active and recent jobs, use newest thread identity, and never backfill legacy records", () => {
  const f = fixture("slow-task"), now = Date.now();
  const stateModule = new URL("../plugins/codex/scripts/lib/state.mjs", import.meta.url).href;
  const markerModule = new URL("../plugins/codex/scripts/lib/session-markers.mjs", import.meta.url).href;
  const records = [
    { id: "active-old", status: "running", agentName: "Ada", age: 48 },
    { id: "recent", status: "completed", agentName: "Turing", age: 1 },
    { id: "expired", status: "completed", agentName: "Hopper", age: 25 },
    { id: "thread-old", status: "completed", agentName: "Curie", threadId: "known-thread", age: 30 },
    { id: "thread-new", status: "completed", agentName: "Noether", threadId: "known-thread", age: 26 },
    { id: "legacy", status: "completed", threadId: "legacy-thread", age: 20 },
  ].map(({ age, ...record }) => ({ ...record, createdAt: new Date(now - age * 3600000).toISOString(),
    jobClass: "task", workspaceRoot: f.repo, sessionId: "fixture-session" }));
  const seeded = run(process.execPath, ["--input-type=module", "-e", `
    import { writeJobFile, upsertJob, resolveJobFile } from ${JSON.stringify(stateModule)};
    import { writeSessionMarker } from ${JSON.stringify(markerModule)};
    const records = ${JSON.stringify(records)};
    for (const record of records) {
      writeJobFile(process.cwd(), record.id, record); upsertJob(process.cwd(), record); writeSessionMarker(record);
    }
    console.log(JSON.stringify(records.map(record => resolveJobFile(process.cwd(), record.id))));
  `], { cwd: f.repo, env: f.env });
  const files = json(seeded), originals = files.map(file => fs.readFileSync(file, "utf8"));
  const legacyMarker = path.join(resolveSessionMarkersRoot(f.env), "fixture-session", "legacy.json");
  const markerText = fs.readFileSync(legacyMarker, "utf8");
  assert.equal(Object.hasOwn(JSON.parse(markerText), "name"), false);
  assert.equal(job(f, "legacy").agentName, undefined);
  const preload = path.join(f.dir, "fixed-name-choice.mjs");
  fs.writeFileSync(preload, 'const random = Math.random; Math.random = () => new Error().stack.includes("pickAgentName") ? 0 : random();');
  const fresh = direct(run(process.execPath, ["--import", preload, script, "task", "--fresh", "--direct", "fixture"], { cwd: f.repo, env: f.env }));
  assert.equal(fresh.agentName, "Hopper", "old ended names are reusable; old active and recent names are reserved");
  const fake = f.state();
  fake.threads.push(...["known-thread", "legacy-thread"].map(id => ({ ...fake.threads[0], id, turns: [] })));
  fs.writeFileSync(path.join(f.dir, "fake-codex-state.json"), JSON.stringify(fake));
  const threaded = direct(f.call("task", "--thread", "known-thread", "--direct", "fixture"));
  assert.equal(threaded.agentName, "Noether");
  const continued = direct(f.call("task", "--continue", "thread-old", "--direct", "fixture"));
  assert.equal(continued.agentName, "Curie", "continue names the specified job, not the newest job on its thread");
  const legacy = direct(f.call("task", "--continue", "legacy", "--direct", "fixture"));
  assert.ok(AGENT_NAMES.includes(legacy.agentName));
  assert.deepEqual(files.map(file => fs.readFileSync(file, "utf8")), originals);
  assert.equal(fs.readFileSync(legacyMarker, "utf8"), markerText);
});

test("detached wait returns bounded safe progress, startup phases and confirmed cancellation", () => {
  const f = fixture(); const launch = json(f.call("task", "--detached", "--report", "--json", "fixture work"));
  const snapshot = json(f.call("wait", launch.jobId, "--timeout-sec", "4", "--json", "--report"));
  assert.equal(snapshot.status, "running"); assert.ok(snapshot.headline.length <= 60);
  assert.equal(snapshot.completedItems.find(i => i.type === "commandExecution").exitCode, 0);
  for (const phase of ["brokerConnectSpawn", "appServerInitialize", "threadStart", "turnStart", "firstModelEvent", "firstToolCall", "mcpReady"]) assert.ok(snapshot.startupTimings[phase], phase);
  assert.match(snapshot.startupWarning, /WebSocket/);
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_FIXTURE/);
  const cancellation = json(f.call("cancel", launch.jobId, "--json")); assert.equal(cancellation.confirmation, "confirmed");
  const result = json(f.call("wait", launch.jobId, "--json", "--report"), 1);
  assert.equal(result.status, "cancelled"); assert.equal(result.interruptionConfirmed, true);
  assert.equal(f.state().lastInterrupt.turnId, snapshot.turnId);
  assert.deepEqual(result.activity, []); // This observer already consumed the command/plan events.
  assert.ok(result.cursor > 0);
  assert.doesNotMatch(fs.readFileSync(job(f, launch.jobId).logFile, "utf8"), /PRIVATE_FIXTURE/);
});

test("parent question and stdin answer continue the same turn; reports do not log answer text", () => {
  const f = fixture("w5-parent"), launch = json(f.call("task", "--detached", "--json", "ask fixture question"));
  const pending = json(f.call("wait", launch.jobId, "--json", "--report"));
  assert.equal(pending.status, "needs_answer"); assert.deepEqual(pending.question.options, ["Small", "Broad"]);
  const began = Date.now();
  const stillPending = json(f.call("wait", launch.jobId, "--after-question", pending.question.id, "--timeout-sec", "1", "--json"));
  assert.equal(stillPending.question.id, pending.question.id);
  assert.equal(json(f.answer(launch.jobId, pending.question.id, "Small PRIVATE_FIXTURE_ANSWER")).status, "answer_submitted");
  const done = json(f.call("wait", launch.jobId, "--json", "--report"));
  assert.equal(done.status, "completed"); assert.equal(done.turnId, pending.turnId);
  const ended = json(f.call("adopt", launch.jobId, "--json"), 2);
  assert.equal(ended.status, "job_ended"); assert.equal(ended.jobStatus, "completed");
  assert.ok(ended.continuationCommand.includes(`task --continue '${launch.jobId}'`));
  assert.equal(ended.ownerId, launch.ownerId);
  assert.equal(f.state().nextTurnId, 2); assert.equal(f.state().capabilities.experimentalApi, true);
  assert.deepEqual(f.state().serverRequestReplies[0].result, { success: true, contentItems: [{ type: "inputText", text: "Small PRIVATE_FIXTURE_ANSWER" }] });
  assert.doesNotMatch(fs.readFileSync(job(f, launch.jobId).logFile, "utf8"), /PRIVATE_FIXTURE_ANSWER|Which fixture/);
  assert.notEqual(f.answer(launch.jobId, pending.question.id, "late").status, 0);
});

test("parent question timeout persists its resolution with a controlled clock", async t => {
  const cwd = makeTempDir(), id = "question-timeout";
  let now = 100000;
  t.mock.method(Date, "now", () => now);
  writeJobFile(cwd, id, { id, status: "running", ownerId: "owner", questionTimeoutSec: 1 });
  const reply = askParentQuestion(cwd, id, { question: "Which path?" });
  const pending = readJobFile(resolveJobFile(cwd, id)).pendingQuestion;
  now = pending.expiresAt;
  const result = await reply;
  assert.equal(result.resolution, "timeout");
  const saved = readJobFile(resolveJobFile(cwd, id));
  assert.equal(saved.pendingQuestion, null);
  assert.equal(saved.lastQuestion.resolution, "timeout");
});

test("an answer accepted before the deadline survives a worker poll after the deadline unless stopped", async t => {
  const cwd = makeTempDir();
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  for (const stop of [null, "cancel", "abort"]) {
    const id = `deadline-${stop ?? "answered"}`, controller = new AbortController();
    writeJobFile(cwd, id, { id, status: "running", ownerId: "owner", questionTimeoutSec: 1 });
    const reply = askParentQuestion(cwd, id, { question: "Which way?" }, { signal: controller.signal });
    const pending = readJobFile(resolveJobFile(cwd, id)).pendingQuestion;
    now = pending.expiresAt - 1;
    assert.equal(answerQuestion(cwd, id, pending.id, "Use the accepted answer\nwith details", "owner").pendingQuestion.answer, "Use the accepted answer\nwith details");
    if (stop === "cancel") updateJob(cwd, id, () => ({ cancelRequested: { reason: "cancelled_by_user" } }));
    if (stop === "abort") controller.abort();
    now = pending.expiresAt + 1;
    const result = await reply;
    assert.equal(result.resolution, stop ? "interrupted" : "answered");
    if (!stop) assert.equal(result.text, "Use the accepted answer\nwith details");
    const saved = readJobFile(resolveJobFile(cwd, id));
    assert.equal(saved.pendingQuestion, null); assert.equal(saved.lastQuestion.resolution, result.resolution);
  }
});

test("owner lease expiry interrupts a running worker; a foreign owner cannot renew it", async () => {
  const f = fixture(), launch = json(f.call("task", "--detached", "--json", "--lease-sec", "180", "--owner", "fixture-owner", "fixture"));
  await waitUntil(() => job(f, launch.jobId).turnId);
  patchJob(f, launch.jobId, { leaseExpiresAt: Date.now() - 1 });
  await waitUntil(() => job(f, launch.jobId).status === "interrupted");
  const result = json(f.call("wait", launch.jobId, "--timeout-sec", "6", "--json", "--report"), 1);
  assert.equal(result.status, "interrupted"); assert.equal(result.interruptionReason, "lease_expired"); assert.equal(result.interruptionConfirmed, true);
  assert.ok(result.continuationCommand.includes(`task --continue '${launch.jobId}' --cwd '${f.repo}' --follow --report --json`));
  const late = json(f.call("wait", launch.jobId, "--owner", launch.ownerId, "--json"), 1);
  assert.equal(late.interruptionReason, "lease_expired");
  assert.equal(f.state().nextTurnId, 2, "Late owner polling must not start a new turn");
  assert.equal(json(f.call("result", launch.jobId, "--report", "--json"), 1).continuationCommand, result.continuationCommand);
  const expired = json(f.call("adopt", launch.jobId, "--json"), 2);
  assert.equal(expired.status, "lease_expired"); assert.equal(expired.adopted, false);
  assert.equal(expired.continuationCommand, result.continuationCommand);
  assert.equal(job(f, launch.jobId).ownerId, launch.ownerId);
  assert.equal(f.state().nextTurnId, 2, "Expired adoption never starts another turn");
});

test("test-home guard rejects real homes and symlink aliases before creating them", () => {
  const f = fixture();
  for (const value of ["/fixture-real-home/.claude/codex-isolated", "/fixture-real-home/.codex"]) assert.throws(() => resolveIsolatedCodexHome({ ...f.env, CODEX_COMPANION_HOME: value }), /Test-home guard/);
  const alias = path.join(f.dir, "outside"); fs.symlinkSync(path.dirname(process.env.CODEX_COMPANION_TEST_ROOT), alias);
  assert.throws(() => resolveIsolatedCodexHome({ ...f.env, CODEX_COMPANION_HOME: alias }), /Test-home guard/);
});

test("task-worker SIGTERM resolves a pending question and confirms its turn interruption", async () => {
  const f = fixture("w5-parent"), launch = json(f.call("task", "--detached", "--json", "fixture"));
  const pending = json(f.call("wait", launch.jobId, "--json"));
  const owned = job(f, launch.jobId);
  process.kill(owned.pid, "SIGTERM"); // This worker was just spawned by this fixture.
  const done = json(f.call("wait", launch.jobId, "--after-question", pending.question.id, "--json", "--report"), 1);
  assert.equal(done.interruptionReason, "signal_sigterm"); assert.equal(done.interruptionConfirmed, true);
  assert.equal(done.turnId, pending.turnId);
  await waitUntil(() => !alive(owned.pid));
});

test("cancel also interrupts a currently running review without killing a saved PID", async () => {
  const f = fixture("w5-review");
  const child = spawnOwned(process.execPath, [script, "review", "--scope", "working-tree", "--json"], { cwd: f.repo, env: f.env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = ""; child.stderr.on("data", chunk => { stderr += chunk; });
  const id = await waitUntil(() => /Job handle: ([^;]+);/.exec(stderr)?.[1]);
  await waitUntil(() => job(f, id).turnId);
  const cancelled = json(f.call("cancel", id, "--json"));
  assert.equal(cancelled.confirmation, "confirmed");
  assert.equal(f.state().lastInterrupt.turnId, job(f, id).turnId);
  await waitUntil(() => !alive(child.pid));
});

test("transport setup is opt-in, merges the hand-written provider, backs up once and is idempotent", () => {
  const f = fixture(), home = f.env.CODEX_COMPANION_HOME; fs.mkdirSync(home);
  const file = path.join(home, "config.toml"), before = 'model_provider = "openai-http"\n# retained\n[model_providers.openai-http]\nname = "OpenAI HTTP"\nbase_url = "https://chatgpt.com/backend-api/codex"\nwire_api = "responses"\nrequires_openai_auth = true\nsupports_websockets = false\n'; fs.writeFileSync(file, before);
  assert.deepEqual(transportSetup({ mode: "http", env: f.env }).changedFiles, []);
  assert.equal(transportSetup({ env: f.env }).transport, "http"); assert.equal(fs.readFileSync(file, "utf8"), before);
  const changed = transportSetup({ mode: "websocket", env: f.env }); assert.equal(changed.backups.length, 1); assert.equal(fs.readFileSync(changed.backups[0], "utf8"), before);
  assert.match(fs.readFileSync(file, "utf8"), /# retained/); assert.deepEqual(transportSetup({ mode: "websocket", env: f.env }).changedFiles, []);
  assert.equal(json(f.call("setup", "--transport", "status", "--json")).transport.transport, "websocket");
  assert.throws(() => transportSetup({ mode: "auto", env: f.env }), /must be/);
});

test("browser origin allow/revoke merges global settings and removes exact stale denies only", () => {
  const f = fixture(), browser = path.join(f.env.CODEX_COMPANION_HOME, "browser"), sessions = path.join(browser, "sessions"); fs.mkdirSync(sessions, { recursive: true });
  const global = path.join(browser, "config.toml"), session = path.join(sessions, "fixture-thread.toml");
  const before = '# retained\n[origins]\nallowed = ["https://other.example"] # preserved comment\ndenied = ["https://EXAMPLE.COM:443"]\n[other]\nkeep = "value"\n';
  fs.writeFileSync(global, before); fs.writeFileSync(session, '[origins]\nallowed = []\ndenied = ["https://example.com", "https://child.example.com"]\n[other]\nkeep = true\n');
  assert.equal(browserOriginSetup({ allow: ["HTTPS://EXAMPLE.COM:443"], env: f.env, dryRun: true }).changedFiles.length, 2); assert.equal(fs.readFileSync(global, "utf8"), before);
  const result = browserOriginSetup({ allow: ["https://example.com"], env: f.env }); assert.equal(result.changedFiles.length, 2); assert.equal(result.backups.length, 2);
  assert.match(fs.readFileSync(global, "utf8"), /# preserved comment/); assert.match(fs.readFileSync(session, "utf8"), /child.example.com/); assert.match(fs.readFileSync(session, "utf8"), /keep = true/);
  assert.deepEqual(browserOriginSetup({ allow: ["https://example.com"], env: f.env }).changedFiles, []);
  const revoked = browserOriginSetup({ revoke: ["https://example.com"], env: f.env }); assert.ok(revoked.denied.includes("https://example.com")); assert.ok(!revoked.allowed.includes("https://example.com"));
  assert.ok(json(f.call("setup", "--list-browser-origins", "--json")).browserOrigins.denied.includes("https://example.com"));
  assert.throws(() => browserOriginSetup({ allow: ["https://example.com/path"], env: f.env }), /requires an HTTP/);
});

test("activity keeps text as written (no credential heuristics), strips terminal noise and selects no tool payloads", () => {
  for (const value of ["ANSWER=Yes", "KEY=assignment-value", "Authorization: Bearer header-value", "https://user:pw@example.com/path", "sk-fixture123", "npm test src/example.mjs"]) {
    assert.equal(redactActivity(value), value);
  }
  assert.equal(redactActivity("\x1b[31mred\x1b[0m\u202eflip\x07"), "red flip ", "ANSI escapes are removed; control/bidi characters become spaces");
  const starts = new Map();
  const tool = { type: "mcpToolCall", server: "fixture", tool: "inspect", status: "completed", arguments: "PRIVATE_ARGS", result: "PRIVATE_RESULT", output: "PRIVATE_OUTPUT" };
  assert.doesNotMatch(JSON.stringify(itemActivity(tool, "completed", starts, "t")), /PRIVATE/);
  const message = itemActivity({ type: "agentMessage", text: "word ".repeat(100) + " TOKEN=secret" }, "completed", starts, "m")[0];
  assert.equal(message.text.length, 300);
  assert.equal(message.body, "word ".repeat(100) + " TOKEN=secret");
  const multiline = itemActivity({ type: "agentMessage", text: "\x1b[31mFirst\x1b[0m\nSecond\u202e" }, "completed", starts, "m")[0];
  assert.equal(multiline.text, "First Second"); assert.equal(multiline.body, "First\nSecond ");
  assert.equal(itemActivity({ type: "agentMessage", text: "x".repeat(4100) }, "completed", starts, "m")[0].body.length, 4000);
  const final = itemActivity({ type: "agentMessage", text: JSON.stringify({ status: "completed", summary: "Fixed it.\nVerified it.", key_findings: ["PRIVATE_REPORT_FIELD"] }) }, "completed", starts, "m")[0];
  assert.equal(final.body, "Fixed it.\nVerified it.");
  assert.doesNotMatch(JSON.stringify(final), /PRIVATE_REPORT_FIELD/);
  assert.deepEqual(itemActivity({ type: "agentMessage", text: "hello" }, "started", starts, "m"), []);
  const command = itemActivity({ type: "commandExecution", command: "echo " + "word ".repeat(100) }, "started", starts, "c", 100)[0];
  assert.equal(command.command.length, 160);
  assert.equal(itemActivity({ type: "commandExecution" }, "completed", starts, "c", 225)[0].durationMs, 125);
  assert.equal(planActivity([{ step: "word ".repeat(100) }])[0].steps[0].length, 80);
  const plan = planActivity(["pending", "inProgress", "completed", "unknown", undefined].map((status, i) => ({ step: `Step ${i}`, status })))[0];
  assert.deepEqual(plan.statuses, ["pending", "inProgress", "completed", "pending", "pending"]);
  assert.equal(plan.statuses.length, plan.steps.length);
  const diff = "--- a/file\n+++ b/file\n@@ -1,2 +1,3 @@\n-PRIVATE_OLD\n+PRIVATE_NEW\n+PRIVATE_EXTRA\n context\n\\ No newline at end of file";
  const changes = itemActivity({ type: "fileChange", changes: [
    { path: "v2", kind: "update", diff }, { path: "v1", kind: { type: "update", unified_diff: diff } },
    { path: "add", kind: "add", content: "PRIVATE_ONE\nPRIVATE_TWO\n" },
    { path: "add-v1", kind: { type: "add", content: "PRIVATE_ONE\nPRIVATE_TWO" } },
    { path: "empty", kind: "add", content: "" }, { path: "blank", kind: "add", content: "\n" },
    { path: "unknown", kind: "delete" }
  ] }, "completed", starts, "f");
  for (const change of changes.slice(0, 2)) { assert.equal(change.added, 2); assert.equal(change.removed, 1); }
  assert.deepEqual(changes.slice(2).map(change => change.added), [2, 2, 0, 1, undefined]);
  for (const change of changes.slice(2)) assert.equal(Object.hasOwn(change, "removed"), false);
  assert.equal(Object.hasOwn(changes.at(-1), "added"), false);
  assert.doesNotMatch(JSON.stringify(changes), /PRIVATE|diff|content/);

  assert.equal(itemActivity({ type: "commandExecution", command: 'FOO="first\nsecond-line" node script\nPRIVATE_BODY' }, "completed", starts, "c")[0].command, 'FOO="first', "only the first command line is shown");
});

test("wait persists independent owner and observer activity cursors", () => {
  const cwd = makeTempDir(), id = "cursor-job";
  const activity = Array.from({ length: 4 }, (_, i) => ({ seq: i + 1, type: "message", text: `event-${i}` }));
  const record = { id, workspaceRoot: cwd, jobClass: "task", status: "completed", activity, activitySeq: 4,
    result: { status: 0, rawOutput: "fixture-output" } };
  writeJobFile(cwd, id, record); upsertJob(cwd, record);
  const read = (...extra) => json(run(process.execPath, [script, "wait", id, "--json", ...extra], { cwd }));
  const first = read("--owner", "reader-a");
  assert.equal(first.activityCount, 4);
  assert.equal(read("--owner", "reader-a").activityCount, 0);
  assert.equal(read("--owner", "reader-b").activityCount, 4);
  assert.equal(read().activityCount, 4);
  const stored = readJobFile(resolveJobFile(cwd, id));
  for (const owner of ["reader-a", "reader-b", undefined]) assert.equal(stored.activityCursors[activityReader(owner)], 4);
});

test("per-job owners ignore ambient identity; adoption transfers the same turn and rejects the old owner", async () => {
  const f = fixture("w5-parent"); f.env.CODEX_COMPANION_OWNER_ID = "ambient-owner";
  const first = json(f.call("task", "--detached", "--json", "--lease-sec", "180", "first"));
  const second = json(f.call("task", "--detached", "--json", "second"));
  assert.notEqual(first.ownerId, second.ownerId); assert.notEqual(first.ownerId, "fixture-session"); assert.notEqual(first.ownerId, "ambient-owner");
  assert.equal(first.sessionId, "fixture-session");
  const initial = job(f, first.jobId).leaseExpiresAt;
  f.call("status", "--json"); f.call("result", first.jobId, "--json", "--report");
  json(f.call("wait", first.jobId, "--timeout-sec", "1", "--json"));
  json(f.call("status", first.jobId, "--owner", second.ownerId, "--json"));
  assert.equal(job(f, first.jobId).leaseExpiresAt, initial);
  // Orphan thresholds are covered with an explicit clock in the pause-policy test.
  // An old wait already in flight must notice rotation, too.
  const pending = json(f.call("wait", first.jobId, "--owner", first.ownerId, "--json"));
  const oldWait = spawnOwned(process.execPath, [script, "wait", first.jobId, "--owner", first.ownerId, "--after-question", pending.question.id, "--timeout-sec", "30", "--json"], { cwd: f.repo, env: f.env, stdio: ["ignore", "pipe", "pipe"] });
  let oldOutput = ""; oldWait.stdout.on("data", chunk => { oldOutput += chunk; });
  const oldDone = new Promise((resolve, reject) => { oldWait.on("close", resolve); oldWait.on("error", reject); });
  await waitUntil(() => job(f, first.jobId).ownerAttached);
  f.env.CODEX_COMPANION_SESSION_ID = "replacement-session";
  const adopted = json(f.call("adopt", first.jobId, "--json"));
  assert.equal(adopted.status, "adopted"); assert.equal(adopted.adopted, true);
  assert.notEqual(adopted.ownerId, first.ownerId); assert.equal(adopted.sessionId, "replacement-session");
  assert.equal(adopted.threadId, pending.threadId); assert.equal(adopted.turnId, pending.turnId);
  assert.ok(adopted.waitCommand.includes(`wait '${first.jobId}' --owner '${adopted.ownerId}'`));
  assert.equal(await oldDone, 2); assert.equal(JSON.parse(oldOutput).status, "ownership_moved");
  const initialAdopted = job(f, first.jobId).leaseExpiresAt;
  for (const cmd of ["status", "wait"]) {
    const moved = json(f.call(cmd, first.jobId, "--owner", first.ownerId, "--json"), 2);
    assert.equal(moved.status, "ownership_moved"); assert.equal(moved.ownerId, adopted.ownerId);
  }
  const rejectedAnswer = run(process.execPath, [script, "answer", first.jobId, "--owner", first.ownerId, "--question", pending.question.id, "--json"], { cwd: f.repo, env: f.env, input: "Do not deliver" });
  assert.equal(json(rejectedAnswer, 2).status, "ownership_moved");
  assert.equal(job(f, first.jobId).pendingQuestion.answer, undefined);
  assert.equal(job(f, first.jobId).leaseExpiresAt, initialAdopted);
  assert.equal(json(f.call("status", "--json")).running.some(j => j.id === first.jobId), true);
  const attached = json(f.call("wait", first.jobId, "--owner", adopted.ownerId, "--json"));
  assert.equal(attached.status, "needs_answer"); assert.equal(attached.orphaned, false);
  assert.equal(attached.questionMessage, pending.questionMessage);
  assert.deepEqual(attached.activity, [], "Adoption inherits the last delivered owner cursor");
  assert.equal(attached.cursor, pending.cursor);
  assert.ok(job(f, first.jobId).leaseExpiresAt > initialAdopted);
  const renewed = job(f, first.jobId).leaseExpiresAt;
  json(f.call("status", first.jobId, "--owner", adopted.ownerId, "--json"));
  assert.ok(job(f, first.jobId).leaseExpiresAt > renewed);
  const answer = run(process.execPath, [script, "answer", first.jobId, "--owner", adopted.ownerId, "--question", attached.question.id, "--json"], { cwd: f.repo, env: f.env, input: "Small" });
  assert.equal(json(answer).status, "answer_submitted");
  const done = json(f.call("wait", first.jobId, "--owner", adopted.ownerId, "--json"));
  assert.equal(done.status, "completed"); assert.equal(done.turnId, attached.turnId);
  assert.equal(f.state().nextTurnId, 3, "Adoption does not submit a new turn");
  json(f.call("cancel", second.jobId, "--json"));
});

test("pause adjustment excludes suspended time, caps timestamps and preserves owner-loss grace", t => {
  let now = 100000, tick;
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "setInterval", callback => { tick = callback; return null; });
  const cwd = makeTempDir(), gap = 7000;
  for (const first of ["worker", "owner"]) {
    const id = `pause-${first}`;
    const record = { id, status: "running", ownerId: "owner", ownerAttached: true,
      leaseSec: 6, leaseRenewedAt: now, leaseExpiresAt: now + 6000 };
    writeJobFile(cwd, id, record);
    const runtime = new JobRuntime(cwd, id);
    try {
      now += gap;
      if (first === "owner") assert.equal(renewLease(cwd, id, "owner").leaseExpiresAt, record.leaseExpiresAt);
      tick();
      const shifted = readJobFile(resolveJobFile(cwd, id));
      assert.equal(runtime.reason, null);
      assert.equal(shifted.lastPauseMs, gap);
      assert.equal(shifted.leaseRenewedAt, now);
      assert.equal(shifted.leaseExpiresAt, now + 6000);
      assert.equal(renewLease(cwd, id, "owner").leaseExpiresAt, now + 6000);
      assert.equal(ownerLost(shifted, now + 4999), false);
      assert.equal(ownerLost(shifted, now + 5000), true);
      const renewedFirst = { ...record, leaseRenewedAt: now, leaseExpiresAt: now + 6000 };
      assert.equal(pauseAdjustment(renewedFirst, gap, now).leaseRenewedAt, now);
      assert.equal(pauseAdjustment({ ...record, cancelRequested: {} }, gap, now), null);
      assert.equal(pauseAdjustment({ ...record, status: "completed" }, gap, now), null);
    } finally { runtime.close(); }
  }
  const lease = { status: "running", leaseSec: 180, leaseRenewedAt: 1000, leaseExpiresAt: 181000 };
  assert.equal(leaseSnapshot(lease, 65999).orphaned, false);
  assert.equal(leaseSnapshot(lease, 66000).orphaned, true);
  const directLease = { ...lease, direct: true, leaseSec: 1800, leaseExpiresAt: 1801000 };
  assert.equal(leaseSnapshot(directLease, 900999).orphaned, false);
  assert.equal(leaseSnapshot(directLease, 901000).orphaned, true);
});

test("an owner renewal refused just after wake succeeds after the worker's pause adjustment", t => {
  const cwd = makeTempDir(), gap = 30 * 60 * 1000, now = Date.now();
  t.mock.method(Date, "now", () => now);
  const record = { id: "paused-owner-test", ownerId: "owner", status: "running", ownerAttached: true, leaseSec: 180, leaseRenewedAt: now - gap - 500, leaseExpiresAt: now - gap - 500 + 180000 };
  writeJobFile(cwd, record.id, record);
  assert.deepEqual(renewLease(cwd, record.id, "owner"), record, "expiry still refuses renewal before the wake tick");
  const shifted = updateJob(cwd, record.id, current => pauseAdjustment(current, gap, now));
  assert.equal(shifted.leaseRenewedAt, now - 500);
  const renewed = renewLease(cwd, record.id, "owner");
  assert.equal(renewed.leaseRenewedAt, now); assert.equal(renewed.leaseExpiresAt, now + 180000);
});

test("expired leases cannot be revived before the worker observes expiry", () => {
  const cwd = makeTempDir(), now = Date.now();
  const record = { id: "expired-owner-test", ownerId: "owner", status: "running", jobClass: "task", workspaceRoot: cwd, threadId: "expired-thread", leaseSec: 180, leaseRenewedAt: now - 180001, leaseExpiresAt: now - 1 };
  writeJobFile(cwd, record.id, record); upsertJob(cwd, record);
  assert.equal(renewLease(cwd, record.id, "owner").leaseExpiresAt, record.leaseExpiresAt);
  assert.equal(renewLease(cwd, record.id).leaseExpiresAt, record.leaseExpiresAt);
  const beforeAttachment = renewLease(cwd, record.id, "owner");
  assert.deepEqual(markOwnerAttachment(cwd, record.id, "owner"), beforeAttachment, "attachment must leave an expired lease and its owner state untouched");
  const adopted = adoptJob(cwd, record.id, "new-session");
  assert.equal(adopted.status, "lease_expired"); assert.equal(adopted.ownerId, record.ownerId);
  assert.ok(adopted.continuationCommand.includes("task --continue 'expired-owner-test'"));
  const runtime = new JobRuntime(cwd, record.id, { foreground: true });
  try { assert.equal(runtime.reason, "lease_expired"); } finally { runtime.close(); }
});

test("adoption preserves legacy session scope, rotates every time and rejects cancellation", () => {
  const cwd = makeTempDir();
  const record = { id: "legacy-adopt", ownerId: "legacy-session", status: "running", jobClass: "task", workspaceRoot: cwd, leaseSec: 180, leaseExpiresAt: Date.now() + 180000 };
  writeJobFile(cwd, record.id, record); upsertJob(cwd, record);
  const first = adoptJob(cwd, record.id);
  assert.equal(first.status, "adopted"); assert.equal(first.sessionId, "legacy-session");
  const second = adoptJob(cwd, record.id);
  assert.equal(second.status, "adopted"); assert.notEqual(second.ownerId, first.ownerId);
  const stored = renewLease(cwd, record.id, "legacy-session");
  assert.equal(ownershipNotice(stored, first.ownerId).status, "ownership_moved");
  assert.equal(ownershipNotice(stored, "legacy-session").status, "ownership_moved");
  writeJobFile(cwd, record.id, { ...stored, cancelRequested: { reason: "cancelled_by_user" } });
  const stopping = adoptJob(cwd, record.id);
  assert.equal(stopping.status, "interrupting"); assert.equal(stopping.ownerId, second.ownerId);
  assert.equal(stopping.continuationCommand, null);
  writeJobFile(cwd, record.id, { ...stored, sessionId: null });
  assert.equal(adoptJob(cwd, record.id).sessionId, null, "Known absence of a session is not a legacy session-ID owner");
});

test("an owner wait that dies abruptly interrupts the worker after the grace period", async () => {
  const f = fixture(); f.env.CODEX_COMPANION_OWNER_GRACE_SEC = "2";
  const launch = json(f.call("task", "--detached", "--json", "fixture"));
  const owner = spawnOwned(process.execPath, [script, "wait", launch.jobId, "--owner", launch.ownerId, "--timeout-sec", "60", "--json"], { cwd: f.repo, env: f.env, stdio: ["ignore", "pipe", "pipe"] });
  await waitUntil(() => job(f, launch.jobId).ownerAttached && job(f, launch.jobId).turnId);
  owner.kill("SIGKILL"); // Simulates Claude Code killing the Bash command when the user stops the agent.
  const killedAt = Date.now();
  const result = json(f.call("wait", launch.jobId, "--timeout-sec", "15", "--json", "--report"), 1);
  assert.equal(result.status, "interrupted"); assert.equal(result.interruptionReason, "owner_lost"); assert.equal(result.interruptionConfirmed, true);

  assert.ok(result.continuationCommand.includes(`task --continue '${launch.jobId}'`));
  assert.equal(f.state().lastInterrupt.turnId, result.turnId);
});

test("a signalled owner wait stops the worker immediately; only a silent owner gets the grace period", async () => {
  const f = fixture();
  const launch = json(f.call("task", "--detached", "--json", "fixture"));
  const owner = spawnOwned(process.execPath, [script, "wait", launch.jobId, "--owner", launch.ownerId, "--timeout-sec", "60", "--direct"], { cwd: f.repo, env: f.env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  owner.stdout.on("data", chunk => { stdout += chunk; }); owner.stderr.on("data", chunk => { stderr += chunk; });
  const ownerClosed = new Promise(resolve => owner.on("close", resolve));
  await waitUntil(() => stdout.includes("\n") && job(f, launch.jobId).ownerAttached && job(f, launch.jobId).turnId);
  owner.kill("SIGTERM"); // Claude Code stopping the agent's Bash call, or Ctrl+C on a terminal --follow.
  const signalledAt = Date.now();
  const code = await ownerClosed;
  assert.equal(code, 130);
  const lines = directLines(stdout);
  assert.ok(lines.length > 1, "progress precedes the owner_stopped report"); assert.equal(stderr, "");
  const stopped = JSON.parse(lines.at(-1));
  assert.deepEqual(stopped, { status: "owner_stopped", jobId: launch.jobId, agentName: launch.agentName, ownerId: launch.ownerId,
    threadId: job(f, launch.jobId).threadId, turnId: job(f, launch.jobId).turnId,
    interruptionReason: "owner_stopped", continuationCommand: stopped.continuationCommand });
  assert.deepEqual(splitRawArgumentString(stopped.continuationCommand), ["node", script, "task", "--continue", launch.jobId, "--cwd", f.repo, "--direct"]);
  const result = json(f.call("wait", launch.jobId, "--timeout-sec", "10", "--json", "--report"), 1);
  assert.equal(result.status, "interrupted"); assert.equal(result.interruptionReason, "owner_stopped"); assert.equal(result.interruptionConfirmed, true);

  assert.ok(result.continuationCommand.includes(`task --continue '${launch.jobId}'`));
  const detached = job(f, launch.jobId);
  assert.equal(detached.ownerAttached, false); assert.equal(detached.ownerDetachReason, "signal");
  // ownerLost semantics, evaluated directly (this process uses the default 5 s grace).
  const active = { ...detached, status: "running" };
  assert.equal(ownerLost(active, active.ownerDetachedAt + 1), true, "signal/parent_exit/stdout_closed detaches count immediately");
  assert.equal(ownerLost({ ...active, ownerDetachReason: "returned" }, active.ownerDetachedAt + 60000), false, "a clean return falls back to the lease");
  assert.equal(ownerLost({ ...active, ownerDetachReason: null, ownerDetachedAt: null }, active.ownerDetachedAt + 60000), false, "never attached: lease only");
  const silent = { ...active, ownerAttached: true, leaseRenewedAt: 1000 };
  assert.equal(ownerLost(silent, 1000 + 4999), false); assert.equal(ownerLost(silent, 1000 + 5000), true, "a silent heartbeat is given 5 s");

});

test("closed stdout during direct progress stops the owner without a crash", async () => {
  for (const mode of ["progress"]) {
    const f = fixture(), launch = json(f.call("task", "--detached", "--json", "fixture"));
    // Consume feed events first, so even feed mode fails on its final JSON write.
    if (mode !== "progress") json(f.call("wait", launch.jobId, "--owner", launch.ownerId, "--timeout-sec", "1", "--json"));
    const began = Date.now();
    const owner = spawnOwned(process.execPath, [script, "wait", launch.jobId, "--owner", launch.ownerId, "--timeout-sec", mode === "progress" ? "60" : "2", mode === "progress" ? "--direct" : mode], { cwd: f.repo, env: f.env, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = ""; owner.stderr.on("data", chunk => { stderr += chunk; });
    const closed = new Promise(resolve => owner.on("close", resolve));
    owner.stdout.destroy();
    assert.equal(await closed, 130, stderr); assert.equal(stderr, "");
    assert.equal(job(f, launch.jobId).ownerDetachReason, "stdout_closed");
    const result = json(f.call("wait", launch.jobId, "--timeout-sec", "10", "--json"), 1);
    assert.equal(result.status, "interrupted"); assert.equal(result.interruptionReason, "owner_stopped"); assert.equal(result.interruptionConfirmed, true);
  }
});

test("a direct wait whose parent exits prints one owner_stopped report and stops its worker", async () => {
  const f = fixture(), launch = json(f.call("task", "--detached", "--json", "fixture"));
  const processModule = new URL("../plugins/codex/scripts/lib/process.mjs", import.meta.url).href;
  const wrapper = spawnOwned(process.execPath, ["--input-type=module", "-e", `
    import { spawnOwned } from ${JSON.stringify(processModule)};
    const wait = spawnOwned(process.execPath, ${JSON.stringify([script, "wait", launch.jobId, "--owner", launch.ownerId, "--timeout-sec", "60", "--direct"])}, { stdio: ['ignore', 1, 2] });
    wait.on('exit', code => { process.exitCode = code; });
  `], { cwd: f.repo, env: f.env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  wrapper.stdout.on("data", chunk => { stdout += chunk; }); wrapper.stderr.on("data", chunk => { stderr += chunk; });
  const closed = new Promise(resolve => wrapper.on("close", resolve));
  await waitUntil(() => job(f, launch.jobId).ownerAttached && job(f, launch.jobId).turnId);
  wrapper.kill("SIGTERM");
  await closed;
  const lines = directLines(stdout); assert.equal(stderr, "");
  const stopped = JSON.parse(lines.at(-1));
  assert.equal(stopped.status, "owner_stopped"); assert.equal(stopped.jobId, launch.jobId); assert.equal(stopped.ownerId, launch.ownerId);
  assert.ok(stopped.threadId); assert.ok(stopped.turnId); assert.equal(stopped.interruptionReason, "owner_stopped");
  assert.match(stopped.continuationCommand, / --direct$/);
  assert.equal(job(f, launch.jobId).ownerDetachReason, "parent_exit");
  const result = json(f.call("wait", launch.jobId, "--timeout-sec", "10", "--json"), 1);
  assert.equal(result.interruptionReason, "owner_stopped"); assert.equal(result.interruptionConfirmed, true);
});

test("a direct owner renews while stdout is undrained longer than the owner grace", async t => {
  const result = await backpressureScenario(script);
  t.diagnostic(JSON.stringify(result.measurements));
  const payload = direct({ status: result.code, stdout: result.stdout, stderr: result.stderr });
  assert.equal(result.stderr, "");
  assert.equal(payload.status, "completed");
  assert.equal(result.saved.result.interruptionReason, null);
  assert.equal(result.saved.ownerDetachReason, "returned");
  assert.ok(result.measurements.undrainedMs > result.measurements.graceMs * 3);
  assert.ok(result.measurements.heartbeatAdvanceMs >= 4000, "renewal continues before the reader resumes");
  assert.ok(result.measurements.heartbeatAgeMs < result.measurements.graceMs);
  assert.equal(result.measurements.statusBeforeDrain, "running");
  assert.ok(result.omissionLines.length >= 1, "the undrained pipe overflows the progress queue");
  assert.ok(result.measurements.omittedLines > 200, "the bounded queue sheds excess progress");
  assert.equal(result.measurements.progressLines - result.omissionLines.length + result.measurements.omittedLines, payload.activityCount, "display omissions do not lose event accounting");
});

test("a direct wait replaces a previously stored follow continuation after cancellation", () => {
  const f = fixture(), launch = json(f.call("task", "--follow", "--json", "--timeout-sec", "1", "fixture"));
  json(f.call("cancel", launch.jobId, "--json"));
  const before = json(f.call("result", launch.jobId, "--report", "--json"), 1);
  assert.match(before.continuationCommand, / --follow --report --json$/);
  const done = direct(f.call("wait", launch.jobId, "--owner", launch.ownerId, "--direct"), 1);
  assert.match(done.continuationCommand, / --direct$/);
  assert.equal(json(f.call("result", launch.jobId, "--report", "--json"), 1).continuationCommand, done.continuationCommand);
  assert.equal(job(f, launch.jobId).direct, true);
});

test("direct mode validates incompatible options before creating state", () => {
  const f = fixture();
  assert.equal(f.call("task", "--quiet", "fixture").status, 1);
  for (const args of [["--direct", "--json"], ["--direct", "--timeout-sec", "3601"],
    ["--direct", "--lease-sec", "bad"], ["--direct", "--prompt-file", path.join(f.repo, "missing")]]) {
    directError(f.call("task", ...args, "fixture"));
  }
  directError(f.call("wait", "missing-job", "--direct", "--json"));
  assert.equal(fs.existsSync(path.join(f.env.CODEX_COMPANION_HOME, "duet", "state")), false);
  assert.equal(fs.existsSync(resolveSessionMarkersRoot(f.env)), false);
});

test("the default feed streams 60 events while JSON retains its existing activity accounting", () => {
  const cwd = makeTempDir(), id = "feed-default", createdAt = new Date().toISOString();
  const record = { id, workspaceRoot: cwd, jobClass: "task", status: "completed", createdAt, report: { status: "completed", jobId: id },
    activity: Array.from({ length: 75 }, (_, i) => ({ type: "message", text: `event ${i}`, seq: i + 1, at: createdAt })) };
  writeJobFile(cwd, id, record); upsertJob(cwd, record);
  const feed = run(process.execPath, [script, "wait", id, "--owner", "feed-reader"], { cwd });
  assert.equal(feed.status, 0, feed.stderr);
  const lines = feed.stdout.trim().split("\n");
  assert.equal(lines.length, 62);
  const summary = JSON.parse(lines.at(-1)); assert.equal(summary.activityCount, 75); assert.equal(summary.activityOmitted, 63);
  const snapshot = json(run(process.execPath, [script, "wait", id, "--json"], { cwd }));
  assert.equal(snapshot.activity.length, 12); assert.equal(snapshot.activityCount, 75); assert.equal(snapshot.cursor, 75);
});

test("task --continue resumes the job's thread with its recorded authorization and a parent bridge", async () => {
  const f = fixture("slow-task");
  const first = json(f.call("task", "--detached", "--json", "--sandbox", "workspace-write", "first assignment"));
  const done = json(f.call("wait", first.jobId, "--json", "--report"));
  assert.equal(done.status, "completed"); assert.equal(done.sandbox, "workspace-write");
  for (const extra of [["--write"], ["--sandbox", "read-only"], ["--thread", done.threadId], ["--model", "other"], ["--approve-browser-origin", "https://example.com"]]) {
    const rejected = f.call("task", "--continue", first.jobId, ...extra, "--json");
    assert.notEqual(rejected.status, 0); assert.match(rejected.stderr, /--continue/);
  }

  const second = json(f.call("task", "--continue", first.jobId, "--follow", "--report", "--json", "continue with the next step"));
  assert.equal(second.status, "completed"); assert.notEqual(second.jobId, first.jobId); assert.equal(second.threadId, done.threadId);
  assert.equal(second.sandbox, "workspace-write", "the original job's narrowed sandbox is inherited, not the full-access default");
  const resume = f.state().lastThreadResume;
  assert.equal(resume.threadId, done.threadId); assert.equal(resume.sandbox, "workspace-write");
  const bridge = resume.config.mcp_servers.duet_parent;
  assert.equal(bridge.command, process.execPath); assert.match(bridge.args[0], /parent-bridge-mcp\.mjs$/);
  assert.equal(bridge.env[PARENT_BRIDGE_ENV.threadId], done.threadId, "the bridge is bound to the thread, not the job"); assert.equal(bridge.env[PARENT_BRIDGE_ENV.cwd], f.repo);
  assert.equal(fs.realpathSync(bridge.env.CODEX_COMPANION_HOME), fs.realpathSync(f.env.CODEX_COMPANION_HOME), "the bridge reaches job state through the isolated home"); assert.equal(bridge.tool_timeout_sec, 900 + 120);
  assert.equal(Object.keys(bridge.env).filter(k => !["CODEX_COMPANION_HOME", "TMPDIR", PARENT_BRIDGE_ENV.threadId, PARENT_BRIDGE_ENV.cwd].includes(k)).length, 0, "no other environment leaks into the bridge");
  assert.deepEqual(bridge.omit_tools_from, ["code_mode", "deferred"], "the tool must stay out of the deferred set or the model never sees it");
  assert.equal(bridge.tools.ask_parent.approval_mode, "approve", "approvalPolicy never would otherwise reject the call");
  assert.match(f.state().lastTurnStart.prompt, /continue with the next step/);
  assert.equal(job(f, second.jobId).request.continuedFrom, first.jobId);
  assert.equal(f.state().lastThreadStart.config, undefined, "new threads keep the in-process dynamic tool");
  const active = fixture();
  const running = json(active.call("task", "--detached", "--json", "third"));
  await waitUntil(() => job(active, running.jobId).turnId);
  assert.notEqual(active.call("task", "--continue", running.jobId, "--json").status, 0);
  json(active.call("cancel", running.jobId, "--json"));
});

test("the parent bridge answers ask_parent through the job file and reports cancellation", async () => {
  const cwd = makeTempDir(), id = "bridge-job", threadId = "thread-bridge";
  writeJobFile(cwd, id, { id, status: "running", jobClass: "task", workspaceRoot: cwd, ownerId: "owner", questionTimeoutSec: 5, threadId });
  upsertJob(cwd, { id, status: "running", jobClass: "task", workspaceRoot: cwd, threadId, createdAt: "2026-01-01T00:00:00.000Z" });
  const env = { ...process.env, [PARENT_BRIDGE_ENV.cwd]: cwd, [PARENT_BRIDGE_ENV.threadId]: threadId };
  const bridge = spawnOwned(process.execPath, [bridgeScript], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  const replies = []; let buffer = "";
  bridge.stdout.on("data", chunk => { buffer += chunk; let i; while ((i = buffer.indexOf("\n")) >= 0) { replies.push(JSON.parse(buffer.slice(0, i))); buffer = buffer.slice(i + 1); } });
  const send = message => bridge.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const reply = id => waitUntil(() => replies.find(r => r.id === id));
  send({ id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
  assert.equal((await reply(1)).result.serverInfo.name, "duet-parent-bridge");
  send({ method: "notifications/initialized" });
  send({ id: 2, method: "tools/list" });
  assert.deepEqual((await reply(2)).result.tools.map(t => t.name), ["ask_parent"]);
  send({ id: 3, method: "tools/call", params: { name: "ask_parent", arguments: { question: "Which way?", options: ["A", "B"] } } });
  const pending = await waitUntil(() => readJobFile(resolveJobFile(cwd, id)).pendingQuestion);
  assert.equal(pending.text, "Which way?"); assert.deepEqual(pending.options, ["A", "B"]);
  answerQuestion(cwd, id, pending.id, "Go with A", "owner");
  const answered = await reply(3);
  assert.equal(answered.result.isError, false); assert.equal(answered.result.content[0].text, "Go with A");
  send({ id: 4, method: "tools/call", params: { name: "ask_parent", arguments: { question: "x".repeat(1001) } } });
  assert.equal((await reply(4)).result.isError, true);
  updateJob(cwd, id, () => ({ cancelRequested: { reason: "cancelled_by_user", at: new Date().toISOString() } }));
  send({ id: 5, method: "tools/call", params: { name: "ask_parent", arguments: { question: "Still there?" } } });
  assert.equal((await reply(5)).result.isError, false);
  // The broker keeps a thread loaded across runs, so one bridge process outlives
  // the job that spawned it: once that job is over, calls bind to the thread's
  // newest active job, and with none active the tool reports it instead of hanging.
  updateJob(cwd, id, () => ({ status: "completed", cancelRequested: null }));
  upsertJob(cwd, { id, status: "completed" });
  send({ id: 6, method: "tools/call", params: { name: "ask_parent", arguments: { question: "Anyone?" } } });
  const nobody = await reply(6);
  assert.equal(nobody.result.isError, true);
  const next = "bridge-job-2";
  writeJobFile(cwd, next, { id: next, status: "running", jobClass: "task", workspaceRoot: cwd, ownerId: "owner-2", questionTimeoutSec: 5, threadId });
  upsertJob(cwd, { id: next, status: "running", jobClass: "task", workspaceRoot: cwd, threadId, createdAt: "2026-01-02T00:00:00.000Z" });
  send({ id: 7, method: "tools/call", params: { name: "ask_parent", arguments: { question: "Next job?" } } });
  const nextPending = await waitUntil(() => readJobFile(resolveJobFile(cwd, next)).pendingQuestion);
  assert.equal(nextPending.text, "Next job?"); assert.equal(readJobFile(resolveJobFile(cwd, id)).pendingQuestion, null, "the finished job is left alone");
  answerQuestion(cwd, next, nextPending.id, "Yes", "owner-2");
  assert.equal((await reply(7)).result.content[0].text, "Yes");
  bridge.stdin.end();
  await waitUntil(() => !alive(bridge.pid));
});

function startQuestionCommand(f, command, input = "") {
  const child = spawnOwned(process.execPath, splitRawArgumentString(command).slice(1), { cwd: f.repo, env: f.env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
  const result = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", status => resolve({ status, stdout, stderr }));
  });
  child.stdin.end(input);
  return { child, result };
}

// Extend only the generated fixture, keeping the shared fake runtime unchanged.
function changeQuestionReply(f, code) {
  const binary = path.join(f.dir, "codex"), source = fs.readFileSync(binary, "utf8");
  const marker = '      if (!serverRequests.size && state.lastInterrupt?.turnId !== pending.turnId) emitTurnCompleted';
  assert.ok(source.includes(marker));
  fs.writeFileSync(binary, source.replace(marker, `${code}\n${marker}`));
}


test("answer --direct submits once and completes the same turn while refusing a second live wait", async () => {
  const f = fixture("w5-parent"), gate = path.join(f.dir, "answer-finish");
  changeQuestionReply(f, `      while (!fs.existsSync(${JSON.stringify(gate)})) await new Promise(resolve => setTimeout(resolve, 25));`);
  const pending = direct(f.call("task", "--direct", "--owner", "parent's owner", "fixture"));
  assert.equal(pending.status, "needs_answer");
  assert.deepEqual(splitRawArgumentString(pending.answerAndWaitCommand), ["node", script, "answer", pending.jobId,
    "--cwd", f.repo, "--owner", pending.ownerId, "--question", pending.question.id, "--direct"]);
  assert.deepEqual(splitRawArgumentString(pending.waitCommand), ["node", script, "wait", pending.jobId,
    "--cwd", f.repo, "--owner", pending.ownerId, "--direct", "--after-question", pending.question.id]);
  assert.deepEqual(splitRawArgumentString(pending.answerCommand), ["node", script, "answer", pending.jobId,
    "--cwd", f.repo, "--owner", pending.ownerId, "--question", pending.question.id, "--json"]);
  const before = job(f, pending.jobId);
  const read = () => readJobFile(before.logFile.replace(/\.log$/, ".json"));
  const wrongOwner = splitRawArgumentString(pending.answerAndWaitCommand).slice(1);
  wrongOwner[wrongOwner.indexOf("--owner") + 1] = "unrelated-owner";
  directError(run(process.execPath, wrongOwner, { cwd: f.repo, env: f.env, input: "rejected" }));
  assert.equal(read().pendingQuestion.answer, undefined);
  assert.equal(read().ownerAttached, false);
  assert.equal(f.state().serverRequestReplies?.length ?? 0, 0);

  const answer = "Small PRIVATE_FIXTURE_ANSWER\nKeep $(literal) and `literal` text.";
  const owner = startQuestionCommand(f, pending.answerAndWaitCommand, answer);
  try {
    await waitUntil(() => f.state().serverRequestReplies?.length === 1);
    const attached = read();
    assert.equal(attached.ownerAttached, true);
    assert.equal(attached.ownerWaitPid, owner.child.pid);
    directError(f.call(...splitRawArgumentString(pending.waitCommand).slice(2)));
    directError(run(process.execPath, splitRawArgumentString(pending.answerAndWaitCommand).slice(1), {
      cwd: f.repo, env: f.env, input: "retry"
    }));
    const protectedOwner = read();
    assert.equal(protectedOwner.ownerAttached, true);
    assert.equal(protectedOwner.ownerWaitToken, attached.ownerWaitToken);
    assert.equal(protectedOwner.ownerId, pending.ownerId);
    assert.equal(f.state().serverRequestReplies.length, 1);
    await waitUntil(() => read().leaseRenewedAt > attached.leaseRenewedAt);
    fs.writeFileSync(gate, "finish");
    const output = await owner.result, done = direct(output), saved = read();
    assert.equal(done.status, "completed"); assert.equal(done.turnId, "turn_1");
    assert.equal(saved.ownerAttached, false); assert.equal(saved.ownerDetachReason, "returned");
    assert.equal(saved.leaseSec, before.leaseSec);
    assert.equal(saved.result.interruptionReason, null);
    assert.equal(f.state().lastInterrupt, null);
    assert.equal(f.state().nextTurnId, 2);
    assert.equal(f.state().serverRequestReplies.length, 1);
    assert.equal(f.state().serverRequestReplies[0].result.contentItems[0].text, answer);
    assert.doesNotMatch(output.stdout, /PRIVATE_FIXTURE_ANSWER/);
  } finally {
    fs.writeFileSync(gate, "finish");
    owner.child.kill("SIGTERM");
    await owner.result;
  }
});

test("a SIGKILLed owner wait is replaced by wait and answer --direct without interrupting the turn", async () => {
  const f = fixture("w5-parent"), pending = direct(f.call("task", "--direct", "fixture"));
  const jobFile = job(f, pending.jobId).logFile.replace(/\.log$/, ".json");
  const read = () => readJobFile(jobFile);
  const waits = [];
  try {
    const first = startQuestionCommand(f, pending.waitCommand); waits.push(first);
    const original = await waitUntil(() => { const current = read(); return current.ownerAttached && current.ownerWaitPid === first.child.pid && current; });
    assert.ok(original.ownerWaitToken);
    first.child.kill("SIGKILL"); await first.result;
    assert.equal(first.child.signalCode, "SIGKILL");

    const replacement = startQuestionCommand(f, pending.waitCommand); waits.push(replacement);
    const recovered = await waitUntil(() => { const current = read(); return current.ownerAttached && current.ownerWaitPid === replacement.child.pid && current; });
    assert.equal(recovered.ownerId, pending.ownerId);
    assert.notEqual(recovered.ownerWaitToken, original.ownerWaitToken);
    await waitUntil(() => read().leaseRenewedAt > recovered.leaseRenewedAt);
    assert.equal(read().status, "running");
    assert.equal(f.state().lastInterrupt, null);

    replacement.child.kill("SIGKILL"); await replacement.result;
    assert.equal(replacement.child.signalCode, "SIGKILL");
    const answering = startQuestionCommand(f, pending.answerAndWaitCommand, "Small"); waits.push(answering);
    const done = direct(await answering.result), saved = read();
    assert.equal(done.status, "completed"); assert.equal(done.turnId, "turn_1");
    assert.equal(saved.ownerWaitPid, answering.child.pid);
    assert.notEqual(saved.ownerWaitToken, recovered.ownerWaitToken);
    assert.equal(saved.ownerId, pending.ownerId);
    assert.equal(saved.ownerAttached, false); assert.equal(saved.ownerDetachReason, "returned");
    assert.equal(saved.result.interruptionReason, null);
    assert.equal(f.state().lastInterrupt, null);
    assert.equal(f.state().nextTurnId, 2);
    assert.equal(f.state().serverRequestReplies.length, 1);
    assert.equal(f.state().serverRequestReplies[0].result.contentItems[0].text, "Small");
  } finally {
    for (const wait of waits) wait.child.kill("SIGTERM");
    await Promise.all(waits.map(wait => wait.result));
  }
});
