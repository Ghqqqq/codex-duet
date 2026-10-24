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

async function backpressureScenario(script, { timeoutSec = 30, signalStop = false } = {}) {
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
    // Keep stdout undrained, but retain data if Node resumes it on child exit.
    owner.stdout.on("data", chunk => { stdout += chunk; });
    owner.stdout.pause();
    const attached = await until(() => { const current = read(); return current.ownerAttached && current.turnId && current; });
    const pausedAt = Date.now();
    fs.writeFileSync(gate, "start");
    await delay(6500);
    const beforeDrain = read(), undrainedMs = Date.now() - pausedAt;
    const heartbeatAgeMs = Date.now() - beforeDrain.leaseRenewedAt;
    if (signalStop) { owner.kill("SIGTERM"); await delay(300); }
    owner.stdout.resume();
    let deadline;
    try {
      await Promise.race([closed, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("Owner did not finish after draining stdout")), 15000); })]);
    } finally { clearTimeout(deadline); }
    const saved = read(), lines = stdout.trimEnd().split("\n"), final = JSON.parse(lines.at(-1));
    const omissionLines = lines.filter(line => /^… \d+ progress lines omitted$/.test(line));
    return { code, stderr, stdout, final, saved, omissionLines,
      measurements: { undrainedMs, graceMs: 2000, heartbeatAdvanceMs: beforeDrain.leaseRenewedAt - attached.leaseRenewedAt,
        heartbeatAgeMs, statusBeforeDrain: beforeDrain.status, activityEvents: saved.activity.length,
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

  // Hold one connection's empty pre-check snapshot while another workspace
  // attempts admission. The second caller must finish without entering it.
  const race = fixture("review-ok");
  const other = path.join(race.dir, "other"), ready = path.join(race.dir, "reads"), gate = path.join(race.dir, "release-read");
  const armed = path.join(race.dir, "hold-reads");
  fs.mkdirSync(other); initGitRepo(other); fs.mkdirSync(ready);
  const binary = path.join(race.dir, "codex"), source = fs.readFileSync(binary, "utf8");
  const reply = 'send({ id: message.id, result: { thread: { ...buildThread(thread), turns: thread.turns || [] } } });';
  assert.ok(source.includes(reply));
  fs.writeFileSync(binary, source.replace(reply, `
    if (!fs.existsSync(${JSON.stringify(armed)})) { ${reply} return; }
    fs.writeFileSync(${JSON.stringify(ready)} + '/' + process.pid, 'ready');
    const snapshot = { thread: { ...buildThread(thread), turns: thread.turns || [] } };
    const timer = setInterval(() => {
      if (fs.existsSync(${JSON.stringify(gate)})) { clearInterval(timer); send({ id: message.id, result: snapshot }); }
    }, 20);
  `));
  // Install the gate before starting the seed thread: its broker may stay warm
  // for the race, so replacing the executable afterwards misses that process.
  const first = direct(race.call("task", "--fresh", "--direct", "fixture"));
  const threadId = job(race, first.jobId).threadId;
  fs.writeFileSync(armed, "armed");
  const start = cwd => {
    const child = spawnOwned(process.execPath, [script, "task", "--thread", threadId, "--sandbox", "read-only", "--direct", "--quiet", "fixture"],
      { cwd, env: race.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; });
    return { child, done: new Promise(resolve => child.once("close", status => resolve({ status, stdout, stderr }))) };
  };
  const offset = race.requests().length, a = start(race.repo);
  let b;
  try {
    await waitUntil(() => fs.readdirSync(ready).length === 1);
    b = start(other);
    let secondDone = false;
    b.done.then(() => { secondDone = true; });
    await waitUntil(() => secondDone || fs.readdirSync(ready).length === 2);
    fs.writeFileSync(gate, "release");
    const results = await Promise.all([a.done, b.done]);
    const reports = results.map(result => direct(result, result.status));
    assert.deepEqual(reports.map(report => report.status).sort(), ["blocked", "completed"]);
    assert.equal(reports.find(report => report.status === "blocked").blockers[0].code, "thread_busy");
    assert.equal(race.requests().slice(offset).filter(request => request.method === "turn/start").length, 1);
  } finally {
    fs.writeFileSync(gate, "release");
    if (a.child.exitCode === null) a.child.kill("SIGTERM");
    if (b?.child.exitCode === null) b.child.kill("SIGTERM");
    await Promise.all([a.done, b?.done]);
  }

  // A fresh thread is published before its first turn is accepted. Its live
  // job must also exclude a cross-workspace follow-up without a turn handle.
  const fresh = fixture("review-ok"), remote = path.join(fresh.dir, "remote");
  fs.mkdirSync(remote); initGitRepo(remote);
  const freshBinary = path.join(fresh.dir, "codex"), freshSource = fs.readFileSync(freshBinary, "utf8");
  const held = path.join(fresh.dir, "first-start"), release = path.join(fresh.dir, "release-start");
  const startCase = 'case "turn/start": {';
  assert.ok(freshSource.includes(startCase));
  fs.writeFileSync(freshBinary, freshSource.replace(startCase, `${startCase}
    if (!fs.existsSync(${JSON.stringify(held)})) {
      fs.writeFileSync(${JSON.stringify(held)}, 'held');
      await new Promise(resolve => {
        const timer = setInterval(() => {
          if (fs.existsSync(${JSON.stringify(release)})) { clearInterval(timer); resolve(); }
        }, 20);
      });
    }
  `));
  const initial = json(fresh.call("task", "--fresh", "--detached", "--json", "fixture"));
  try {
    await waitUntil(() => fs.existsSync(held));
    const pending = job(fresh, initial.jobId);
    assert.ok(pending.threadId && !pending.turnId && alive(pending.pid));
    const refused = run(process.execPath, [script, "task", "--thread", pending.threadId, "--cwd", remote, "--sandbox", "read-only", "--direct", "--quiet", "fixture"],
      { cwd: remote, env: fresh.env });
    assert.equal(direct(refused, 2).blockers[0].code, "thread_busy");
    assert.equal(fresh.requests().filter(request => request.method === "turn/start").length, 1);
    fs.writeFileSync(release, "release");
    await waitUntil(() => job(fresh, initial.jobId).status === "completed");
    // A terminal predecessor can still have a live wrapper during teardown.
    patchJob(fresh, initial.jobId, { pid: process.pid });
    const continued = direct(fresh.call("task", "--to", initial.jobId, "--direct", "--quiet", "fixture"));
    assert.equal(continued.status, "completed");
    const cross = direct(run(process.execPath, [script, "task", "--thread", pending.threadId, "--cwd", remote, "--sandbox", "read-only", "--direct", "--quiet", "fixture"],
      { cwd: remote, env: fresh.env }));
    assert.equal(cross.status, "completed");
  } finally {
    fs.writeFileSync(release, "release");
    await waitUntil(() => ["completed", "failed"].includes(job(fresh, initial.jobId).status));
  }
});

test("names stay unique across a session's workspaces, preserve local reservations and thread identity, and never backfill legacy records", async t => {
  const f = fixture("slow-task"), now = Date.now();
  const other = path.join(f.dir, "other-workspace");
  fs.mkdirSync(other); initGitRepo(other);
  const stateModule = new URL("../plugins/codex/scripts/lib/state.mjs", import.meta.url).href;
  const markerModule = new URL("../plugins/codex/scripts/lib/session-markers.mjs", import.meta.url).href;
  const records = [
    { id: "active-old", status: "running", agentName: "Ada", age: 48 },
    { id: "recent", status: "completed", agentName: "Turing", age: 1 },
    { id: "expired", status: "completed", agentName: "Hopper", age: 25 },
    { id: "thread-old", status: "completed", agentName: "Curie", threadId: "known-thread", age: 30 },
    { id: "thread-new", status: "completed", agentName: "Noether", threadId: "known-thread", age: 26 },
    { id: "legacy", status: "completed", threadId: "legacy-thread", age: 20 },
    { id: "remote-old", status: "completed", agentName: "Euler", age: 72, workspaceRoot: other },
    { id: "foreign", status: "completed", agentName: "Kepler", age: 72, workspaceRoot: other, sessionId: "other-session" },
  ].map(({ age, ...record }) => ({ jobClass: "task", workspaceRoot: f.repo, sessionId: "fixture-session",
    ...record, createdAt: new Date(now - age * 3600000).toISOString() }));
  const seeded = run(process.execPath, ["--input-type=module", "-e", `
    import { writeJobFile, upsertJob, resolveJobFile } from ${JSON.stringify(stateModule)};
    import { writeSessionMarker } from ${JSON.stringify(markerModule)};
    const records = ${JSON.stringify(records)};
    for (const record of records) {
      writeJobFile(record.workspaceRoot, record.id, record); upsertJob(record.workspaceRoot, record); writeSessionMarker(record);
    }
    console.log(JSON.stringify(records.map(record => resolveJobFile(record.workspaceRoot, record.id))));
  `], { cwd: f.repo, env: f.env });
  const files = json(seeded), originals = files.map(file => fs.readFileSync(file, "utf8"));
  const legacyMarker = path.join(resolveSessionMarkersRoot(f.env), "fixture-session", "legacy.json");
  const markerText = fs.readFileSync(legacyMarker, "utf8");
  assert.equal(Object.hasOwn(JSON.parse(markerText), "name"), false);
  assert.equal(job(f, "legacy").agentName, undefined);
  const preload = path.join(f.dir, "fixed-name-choice.mjs");
  fs.writeFileSync(preload, 'const random = Math.random; Math.random = () => new Error().stack.includes("pickAgentName") ? 0 : random();');
  const fresh = direct(run(process.execPath, ["--import", preload, script, "task", "--fresh", "--direct", "fixture"], { cwd: f.repo, env: f.env }));
  assert.equal(fresh.worker, "Gauss", "session names stay reserved after 24 hours and across workspaces");
  t.diagnostic(JSON.stringify({ command: "task --fresh --direct (fixed choice, fixture-session)", workspace: "repo", ...fresh }));
  const local = direct(run(process.execPath, ["--import", preload, script, "task", "--fresh", "--direct", "fixture"], {
    cwd: f.repo, env: { ...f.env, CODEX_COMPANION_SESSION_ID: "" }
  }));
  assert.equal(local.worker, "Hopper", "without a session, old ended names remain reusable");
  t.diagnostic(JSON.stringify({ command: "task --fresh --direct (no session)", workspace: "repo", ...local }));
  const dispatch = cwd => new Promise((resolve, reject) => {
    const child = spawnOwned(process.execPath, ["--import", preload, script, "task", "--fresh", "--direct", "--cwd", cwd, "fixture"],
      { cwd: f.repo, env: f.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => { stdout += data; });
    child.stderr.on("data", data => { stderr += data; });
    child.on("error", reject);
    child.on("close", status => { try { resolve(direct({ status, stdout, stderr })); } catch (error) { reject(error); } });
  });
  const concurrent = await Promise.all([dispatch(f.repo), dispatch(other)]);
  assert.deepEqual(concurrent.map(result => result.worker).sort(), ["Faraday", "Kepler"], "atomic reservations span concurrent workspace dispatches; other sessions do not reserve names globally");
  concurrent.forEach((result, i) => t.diagnostic(JSON.stringify({ command: "task --fresh --direct --cwd <workspace> (concurrent)", workspace: i ? "other-workspace" : "repo", ...result })));
  const fake = f.state();
  fake.threads.push(...["known-thread", "legacy-thread"].map(id => ({ ...fake.threads[0], id, turns: [] })));
  fs.writeFileSync(path.join(f.dir, "fake-codex-state.json"), JSON.stringify(fake));
  const threaded = direct(f.call("task", "--thread", "known-thread", "--sandbox", "read-only", "--direct", "fixture"));
  assert.equal(threaded.worker, "Noether");
  const continued = direct(f.call("task", "--continue", "thread-old", "--sandbox", "read-only", "--direct", "fixture"));
  assert.equal(continued.worker, "Curie", "continue names the specified job, not the newest job on its thread");
  const legacy = direct(f.call("task", "--continue", "legacy", "--sandbox", "read-only", "--direct", "fixture"));
  assert.ok(AGENT_NAMES.includes(legacy.worker));
  assert.deepEqual(files.map(file => fs.readFileSync(file, "utf8")), originals);
  assert.equal(fs.readFileSync(legacyMarker, "utf8"), markerText);
  // Name reservations survive the normal 50-ended-job index cap as well.
  const pruned = json(run(process.execPath, ["--input-type=module", "-e", `
    import { updateJob, upsertJob, listSessionJobs } from ${JSON.stringify(stateModule)};
    updateJob(process.cwd(), "active-old", () => ({ status: "completed" }));
    for (const cwd of ${JSON.stringify([f.repo, other])}) {
      for (let i = 0; i < 55; i++) upsertJob(cwd, { id: "filler-" + i, status: "completed", sessionId: "fixture-session", workspaceRoot: cwd,
        createdAt: new Date(Date.now() + 1000 + i).toISOString() });
    }
    console.log(JSON.stringify(listSessionJobs(process.cwd(), "fixture-session").map(job => job.agentName).filter(Boolean)));
  `], { cwd: f.repo, env: f.env }));
  assert.deepEqual(new Set(pruned), new Set([...records.filter(record => record.sessionId === "fixture-session").map(record => record.agentName),
    fresh.worker, ...concurrent.map(result => result.worker), legacy.worker].filter(Boolean)));
  const retained = direct(run(process.execPath, ["--import", preload, script, "task", "--fresh", "--direct", "fixture"], { cwd: other, env: f.env }));
  assert.ok(![...records.filter(record => record.sessionId === "fixture-session").map(record => record.agentName),
    fresh.worker, ...concurrent.map(result => result.worker), legacy.worker].includes(retained.worker));
  t.diagnostic(JSON.stringify({ command: "task --fresh --direct (after index pruning)", workspace: "other-workspace", ...retained }));
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
  const f = fixture("parent-question-sequence"), launch = json(f.call("task", "--detached", "--json", "--question-timeout-sec", "3", "ask fixture question"));
  const first = json(f.call("wait", launch.jobId, "--json", "--report"));
  assert.equal(first.status, "needs_answer");
  patchJob(f, launch.jobId, { questionTimeoutSec: 30 });
  const pending = json(f.call("wait", launch.jobId, "--after-question", first.question.id, "--json", "--report"));
  assert.notEqual(first.question.id, pending.question.id);
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
  assert.deepEqual(f.state().serverRequestReplies[1].result, { success: true, contentItems: [{ type: "inputText", text: "Small PRIVATE_FIXTURE_ANSWER" }] });
  assert.doesNotMatch(fs.readFileSync(job(f, launch.jobId).logFile, "utf8"), /PRIVATE_FIXTURE_ANSWER|Which fixture/);
  const saved = job(f, launch.jobId), history = saved.questionHistory;
  assert.equal(history.length, 2);
  assert.deepEqual(history[0], { id: first.question.id, callId: "fixture-call-1", kind: "question", text: first.question.text, options: first.question.options,
    askedAt: history[0].askedAt, answeredAt: null, answer: null, resolution: "timeout" });
  assert.deepEqual(history[1], { id: pending.question.id, callId: "fixture-call-2", kind: "question", text: pending.question.text, options: pending.question.options,
    askedAt: history[1].askedAt, answeredAt: history[1].answeredAt, answer: "Small PRIVATE_FIXTURE_ANSWER", resolution: "answered" });
  const events = readJobFile(saved.logFile.replace(/\.log$/, ".json")).activity.filter(event => event.type === "dynamicToolCall" && event.tool === "ask_parent");
  for (const entry of history) {
    const request = f.state().parentQuestionRequests.find(request => request.params.callId === entry.callId);
    assert.ok(request); assert.notEqual(request.id, entry.callId, "the transport request ID is distinct");
    assert.equal(f.state().parentQuestionItems.find(item => item.id === entry.callId)?.id, request.params.callId);
    assert.deepEqual(events.filter(event => event.callId === entry.callId).map(event => event.lifecycle), ["started", "completed"]);
  }
  assert.ok(Number.isFinite(Date.parse(history[1].askedAt)) && Number.isFinite(Date.parse(history[1].answeredAt)));
  assert.equal(saved.pendingQuestion, null); assert.deepEqual(saved.lastQuestion, { id: pending.question.id, resolution: "answered" });
  assert.notEqual(f.answer(launch.jobId, pending.question.id, "late").status, 0);
});

test("question history caps entries and answer length and retains timeout resolution", async t => {
  const cwd = makeTempDir(), id = "question-timeout";
  let now = 100000;
  t.mock.method(Date, "now", () => now);
  writeJobFile(cwd, id, { id, status: "running", ownerId: "owner", questionTimeoutSec: 1,
    questionHistory: Array.from({ length: 20 }, (_, i) => ({ id: `old-${i}`, resolution: "answered" })) });
  const answered = askParentQuestion(cwd, id, { question: "Choose scope?", options: ["Small", "Broad"], kind: "approval" });
  const asking = readJobFile(resolveJobFile(cwd, id)).pendingQuestion;
  answerQuestion(cwd, id, asking.id, "字".repeat(2500), "owner");
  assert.equal((await answered).resolution, "answered");
  const bounded = readJobFile(resolveJobFile(cwd, id)).questionHistory;
  assert.equal(bounded.length, 20); assert.equal(bounded[0].id, "old-1");
  assert.deepEqual(bounded.at(-1), { id: asking.id, callId: null, kind: "approval", text: "Choose scope?", options: ["Small", "Broad"],
    askedAt: new Date(now).toISOString(), answeredAt: new Date(now).toISOString(), answer: "字".repeat(2000), resolution: "answered" });
  const reply = askParentQuestion(cwd, id, { question: "Which path?", callId: "timeout-call" });
  const pending = readJobFile(resolveJobFile(cwd, id)).pendingQuestion;
  now = pending.expiresAt;
  const result = await reply;
  assert.equal(result.resolution, "timeout");
  const saved = readJobFile(resolveJobFile(cwd, id));
  assert.equal(saved.pendingQuestion, null);
  assert.equal(saved.lastQuestion.resolution, "timeout");
  assert.equal(saved.questionHistory.length, 20); assert.equal(saved.questionHistory[0].id, "old-2");
  assert.deepEqual(saved.questionHistory.at(-1), { id: pending.id, callId: "timeout-call", kind: "question", text: "Which path?", options: [],
    askedAt: pending.askedAt, answeredAt: null, answer: null, resolution: "timeout" });
  const controller = new AbortController();
  const held = askParentQuestion(cwd, id, { question: "Keep waiting?", callId: "held-call" }, { signal: controller.signal });
  const waiting = readJobFile(resolveJobFile(cwd, id));
  const busy = await askParentQuestion(cwd, id, { question: "Another question?", options: ["Later"], callId: "busy-call" });
  assert.equal(busy.resolution, "busy");
  const busySaved = readJobFile(resolveJobFile(cwd, id));
  assert.deepEqual(busySaved.pendingQuestion, waiting.pendingQuestion); assert.deepEqual(busySaved.lastQuestion, waiting.lastQuestion);
  assert.deepEqual(busySaved.questionHistory.at(-1), { id: busySaved.questionHistory.at(-1).id, callId: "busy-call", kind: "question", text: "Another question?", options: ["Later"],
    askedAt: new Date(now).toISOString(), answeredAt: null, answer: null, resolution: "busy" });
  controller.abort(); assert.equal((await held).resolution, "interrupted");
  const interrupted = readJobFile(resolveJobFile(cwd, id));
  assert.equal(interrupted.questionHistory.at(-1).callId, "held-call"); assert.equal(interrupted.questionHistory.at(-1).resolution, "interrupted");
  updateJob(cwd, id, () => ({ status: "interrupted" }));
  assert.equal((await askParentQuestion(cwd, id, { question: "Already stopped?", callId: "stopped-call" })).resolution, "interrupted");
  const stopped = readJobFile(resolveJobFile(cwd, id));
  assert.equal(stopped.questionHistory.at(-1).callId, "stopped-call"); assert.equal(stopped.questionHistory.at(-1).resolution, "interrupted");
  assert.equal(stopped.questionHistory.length, 20); assert.deepEqual(stopped.lastQuestion, interrupted.lastQuestion); assert.equal(stopped.pendingQuestion, null);
  assert.equal(itemActivity({ type: "mcpToolCall", id: "mcp-call", tool: "ask_parent" }, "completed", new Map(), "mcp-call")[0].callId, "mcp-call");
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
  assert.equal(json(f.call("result", launch.jobId, "--json")).storedJob.report.continuationCommand, result.continuationCommand);
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
  assert.equal(job(f, first.jobId).dispatchSessionId, "fixture-session");
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
  assert.equal(job(f, first.jobId).dispatchSessionId, "fixture-session", "Adoption must not rewrite dispatch provenance");
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

test("a signalled owner wait stops the worker immediately; only a silent owner gets the grace period; interrupts clean background terminals", async t => {
  const cleanMethod = "thread/backgroundTerminals/clean";
  const storedJob = (f, id) => readJobFile(path.join(resolveStateDir(f.repo, f.env), "jobs", `${id}.json`));
  const checkCleanup = (f, id, scenario, cleaned, external = false) => {
    const stored = storedJob(f, id), outcome = stored.backgroundTerminals;
    assert.equal(outcome.cleaned, cleaned);
    if (cleaned) assert.equal(outcome.detail, null);
    else { assert.equal(typeof outcome.detail, "string"); assert.ok(outcome.detail.length > 0); }
    const requests = f.requests().filter(request => request.params.threadId === stored.threadId);
    const interrupts = requests.filter(request => request.method === "turn/interrupt");
    const cleans = requests.filter(request => request.method === cleanMethod);
    assert.ok(interrupts.length > 0); assert.equal(cleans.length, 1);
    assert.deepEqual(cleans[0].params, { threadId: stored.threadId });
    assert.deepEqual(interrupts.at(-1).params, { threadId: stored.threadId, turnId: stored.turnId });
    assert.ok(requests.indexOf(interrupts.at(-1)) < requests.indexOf(cleans[0]));
    assert.equal(cleans[0].serverId, interrupts.at(-1).serverId);
    if (external) {
      const reads = requests.filter(request => request.method === "thread/read");
      assert.ok(reads.length > 0);
      assert.ok(requests.indexOf(interrupts.at(-1)) < requests.indexOf(reads[0]));
      assert.ok(requests.indexOf(reads.at(-1)) < requests.indexOf(cleans[0]));
      for (const request of reads) assert.equal(request.serverId, cleans[0].serverId);
    } else assert.equal(cleans[0].serverId, requests.find(request => request.method === "turn/start").serverId);
    const code = stored.turnResolution === "in_progress" ? 0 : 1;
    assert.deepEqual(json(f.call("result", id, "--details"), code).backgroundTerminals, outcome);
    assert.equal(Object.hasOwn(json(f.call("result", id, "--report", "--json"), code), "backgroundTerminals"), false);
    const transcript = [];
    for (const request of requests) {
      const previous = transcript.at(-1);
      if (previous && previous.serverId === request.serverId && previous.method === request.method && JSON.stringify(previous.params) === JSON.stringify(request.params)) previous.count = (previous.count ?? 1) + 1;
      else transcript.push({ ...request });
    }
    t.diagnostic(JSON.stringify({ scenario, requests: transcript, backgroundTerminals: outcome }));
    return stored;
  };
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
  assert.deepEqual(stopped, { status: "owner_stopped", worker: launch.agentName, jobId: launch.jobId, summary: "",
    next: `duet task --to ${launch.agentName}`, details: `duet result '${launch.jobId}' --details` });
  const result = json(f.call("wait", launch.jobId, "--timeout-sec", "10", "--json", "--report"), 1);
  assert.equal(result.status, "interrupted"); assert.equal(result.interruptionReason, "owner_stopped"); assert.equal(result.interruptionConfirmed, true);

  assert.ok(result.continuationCommand.includes(`task --continue '${launch.jobId}'`));
  const detached = job(f, launch.jobId);
  assert.equal(detached.ownerAttached, false); assert.equal(detached.ownerDetachReason, "signal");
  checkCleanup(f, launch.jobId, "owner_stopped", true);
  // ownerLost semantics, evaluated directly (this process uses the default 5 s grace).
  const active = { ...detached, status: "running" };
  assert.equal(ownerLost(active, active.ownerDetachedAt + 1), true, "signal/parent_exit/stdout_closed detaches count immediately");
  assert.equal(ownerLost({ ...active, ownerDetachReason: "returned" }, active.ownerDetachedAt + 60000), false, "a clean return falls back to the lease");
  assert.equal(ownerLost({ ...active, ownerDetachReason: null, ownerDetachedAt: null }, active.ownerDetachedAt + 60000), false, "never attached: lease only");
  const silent = { ...active, ownerAttached: true, leaseRenewedAt: 1000 };
  assert.equal(ownerLost(silent, 1000 + 4999), false); assert.equal(ownerLost(silent, 1000 + 5000), true, "a silent heartbeat is given 5 s");

  // A live worker uses its own connection, including when cleanup fails.
  for (const behavior of ["supported", "unsupported", "unknown", "failed", "timeout"]) {
    const running = fixture(); running.env.CODEX_FIXTURE_TERMINALS_CLEAN = behavior;
    const started = json(running.call("task", "--detached", "--json", "fixture"));
    await waitUntil(() => storedJob(running, started.jobId).turnId);
    const cancelled = json(running.call("cancel", started.jobId, "--json"));
    assert.equal(cancelled.status, "cancelled"); assert.equal(cancelled.confirmation, "confirmed");
    assert.equal(cancelled.turnInterruptAttempted, true); assert.equal(cancelled.turnInterrupted, true);
    assert.equal(cancelled.reason, "cancelled_by_user");
    const saved = checkCleanup(running, started.jobId, `cancel_worker_${behavior}`, behavior === "supported");
    assert.equal(saved.status, "cancelled"); assert.equal(saved.result.interruptionConfirmed, true);
    assert.deepEqual(cancelled.backgroundTerminals, saved.backgroundTerminals);
  }

  // A lost wrapper is cancelled through the replacement broker. Even an
  // unconfirmed interrupt cleans after the last exact-turn poll.
  for (const behavior of ["supported", "unsupported", "unconfirmed"]) {
    const lost = fixture("lost-turn:inProgress"); lost.env.CODEX_FIXTURE_TERMINALS_CLEAN = behavior;
    const failed = lost.call("task", "--report", "--json", "fixture");
    assert.equal(failed.status, 1);
    const id = /Job handle: ([^;]+)/.exec(failed.stderr)?.[1]; assert.ok(id);
    const original = storedJob(lost, id);
    assert.equal(original.result.turnEnded, false);
    if (behavior === "unconfirmed") fs.writeFileSync(path.join(lost.dir, "fake-codex-state.json"), JSON.stringify({ ...lost.state(), ignoreInterrupt: true }));
    const confirmed = behavior !== "unconfirmed";
    const cancelled = json(lost.call("cancel", id, "--json"), confirmed ? 0 : 2);
    assert.equal(cancelled.status, confirmed ? "cancelled" : "interrupt_unconfirmed");
    assert.equal(cancelled.confirmation, confirmed ? "confirmed" : "unconfirmed");
    assert.equal(cancelled.turnInterruptAttempted, true); assert.equal(cancelled.turnInterrupted, confirmed);
    const saved = checkCleanup(lost, id, `cancel_broker_${behavior}`, behavior !== "unsupported", true);
    assert.deepEqual(cancelled.backgroundTerminals, saved.backgroundTerminals);
    if (confirmed) assert.equal(saved.result.interruptionConfirmed, true);
    else assert.deepEqual(saved.result, original.result);
  }

  const normal = fixture("task-ok"), completed = json(normal.call("task", "--fresh", "--json", "fixture"));
  assert.equal(storedJob(normal, completed.jobId).status, "completed");
  assert.equal(Object.hasOwn(storedJob(normal, completed.jobId), "backgroundTerminals"), false);
  assert.equal(normal.requests().some(request => ["turn/interrupt", cleanMethod].includes(request.method)), false);
  t.diagnostic(JSON.stringify({ scenario: "normal_completion", requests: normal.requests() }));

  // A killed worker cannot run its grant releases. Recovery restores the
  // preexisting session grant, while a live worker retains its task approval.
  const grant = fixture("computer-use-requests"), binary = path.join(grant.dir, "codex");
  fs.writeFileSync(binary, fs.readFileSync(binary, "utf8").replace("if (pending.questionItem) {", "if (BEHAVIOR === 'computer-use-requests') return;\n      if (pending.questionItem) {"));
  const granted = json(grant.call("task", "--detached", "--json", "fixture"));
  const question = await waitUntil(() => storedJob(grant, granted.jobId).pendingQuestion);
  const grantJob = storedJob(grant, granted.jobId);
  const grantFile = path.join(grant.env.CODEX_COMPANION_HOME, "computer-use", "sessions", `${grantJob.threadId}.toml`);
  const baseline = '[apps]\nallowed = ["com.apple.TextEdit"]\n';
  fs.mkdirSync(path.dirname(grantFile), { recursive: true }); fs.writeFileSync(grantFile, baseline);
  json(grant.answer(granted.jobId, question.id, "Allow for this task"));
  await waitUntil(() => fs.readFileSync(grantFile, "utf8").includes("com.google.Chrome"));
  json(grant.call("status", granted.jobId, "--json"));
  assert.ok(fs.readFileSync(grantFile, "utf8").includes("com.google.Chrome"));
  process.kill(grantJob.pid, "SIGKILL"); await waitUntil(() => !alive(grantJob.pid));
  json(grant.call("status", granted.jobId, "--json"));
  assert.equal(fs.readFileSync(grantFile, "utf8"), baseline);
  assert.equal(storedJob(grant, granted.jobId).status, "failed");
  grant.call("cancel", granted.jobId, "--json");
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

test("a direct wait whose parent exits stops its worker; unconfirmed interruptions block thread reuse until resolved", async t => {
  const stored = (f, id) => readJobFile(path.join(resolveStateDir(f.repo, f.env), "jobs", `${id}.json`));
  const changeServer = (f, patch) => fs.writeFileSync(path.join(f.dir, "fake-codex-state.json"), JSON.stringify({ ...f.state(), ...patch }));
  const transcript = (scenario, f, offset = 0, outcome = {}) => t.diagnostic(JSON.stringify({ scenario,
    requests: f.requests().slice(offset).map(({ serverId, method, params }) => ({ serverId, method, params: { threadId: params.threadId,
      ...(params.turnId ? { turnId: params.turnId } : {}), ...(params.includeTurns ? { includeTurns: true } : {}) } })), ...outcome }));
  const stopOwner = async confirmed => {
    const f = fixture("lost-turn:owner-stop"), launch = json(f.call("task", "--detached", "--json", "fixture"));
    const processModule = new URL("../plugins/codex/scripts/lib/process.mjs", import.meta.url).href;
    const wrapper = spawnOwned(process.execPath, ["--input-type=module", "-e", `
      import { spawnOwned } from ${JSON.stringify(processModule)};
      const wait = spawnOwned(process.execPath, ${JSON.stringify([script, "wait", launch.jobId, "--owner", launch.ownerId, "--timeout-sec", "60", "--direct"])}, { stdio: ['ignore', 1, 2] });
      wait.on('exit', code => { process.exitCode = code; });
    `], { cwd: f.repo, env: f.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    wrapper.stdout.on("data", chunk => { stdout += chunk; }); wrapper.stderr.on("data", chunk => { stderr += chunk; });
    const closed = new Promise(resolve => wrapper.on("close", resolve));
    await waitUntil(() => stored(f, launch.jobId).ownerAttached && stored(f, launch.jobId).turnId);
    const workerPid = stored(f, launch.jobId).pid;
    changeServer(f, { ignoreInterrupt: !confirmed });
    wrapper.kill("SIGTERM");
    await closed;
    const lines = directLines(stdout); assert.equal(stderr, "");
    const stopped = JSON.parse(lines.at(-1));
    assert.equal(stopped.status, "owner_stopped"); assert.equal(stopped.jobId, launch.jobId); assert.equal(stopped.worker, launch.agentName);
    const stoppedJob = stored(f, launch.jobId);
    assert.equal(stoppedJob.ownerId, launch.ownerId); assert.ok(stoppedJob.threadId); assert.ok(stoppedJob.turnId);
    assert.equal(stopped.next, `duet task --to ${launch.agentName}`);
    assert.equal(stoppedJob.ownerDetachReason, "parent_exit");
    const result = json(f.call("wait", launch.jobId, "--timeout-sec", "10", "--json"), 1);
    assert.equal(result.interruptionReason, "owner_stopped"); assert.equal(result.interruptionConfirmed, confirmed);
    await waitUntil(() => !alive(workerPid));
    const original = stored(f, launch.jobId);
    assert.equal(original.status, "interrupted"); assert.equal(original.result.turnEnded, confirmed);
    transcript(confirmed ? "owner_stop_confirmed" : "owner_stop_unconfirmed", f, 0, { status: original.status, turnEnded: original.result.turnEnded });
    return { f, launch, original };
  };
  const preservedOutcome = (f, original, turnStatus) => {
    const saved = stored(f, original.id);
    assert.equal(saved.status, original.status); assert.equal(saved.completedAt, original.completedAt);
    assert.equal(saved.summary, original.summary); assert.equal(saved.errorMessage, original.errorMessage);
    assert.equal(saved.recovered, true); assert.equal(saved.turnResolution, turnStatus);
    assert.equal(saved.result.turnEnded, true); assert.equal(saved.result.interruptionConfirmed, true);
    assert.deepEqual([saved.recovery.source, saved.recovery.threadId, saved.recovery.turnId, saved.recovery.turnStatus], ["thread/read", original.threadId, original.turnId, turnStatus]);
    const withoutResolution = value => Object.fromEntries(Object.entries(value).filter(([key]) => !["recovered", "recoveredAt", "completedAt", "recovery", "turnEnded", "interruptionConfirmed"].includes(key)));
    assert.deepEqual(withoutResolution(saved.result), withoutResolution(original.result));
    assert.deepEqual(withoutResolution(saved.report), withoutResolution(original.report));
    assert.deepEqual(readJobFile(saved.resultFile), saved.result);
    assert.equal(fs.readFileSync(saved.rawOutputFile, "utf8"), original.result.rawOutput);
    assert.equal(json(f.call("result", original.id, "--details"), 1).status, original.status);
  };

  const confirmed = await stopOwner(true);
  let offset = confirmed.f.requests().length;
  const resumed = direct(confirmed.f.call("task", "--continue", confirmed.launch.jobId, "--direct", "follow up"));
  assert.equal(resumed.status, "completed");
  assert.equal(confirmed.f.requests().slice(offset).filter(request => request.method === "turn/start").length, 1);
  const admission = confirmed.f.requests().slice(offset);
  const check = admission.find(request => request.method === "thread/read");
  assert.equal(check.params.includeTurns, true);
  assert.equal(check.serverId, admission.find(request => request.method === "turn/start").serverId);
  assert.ok(admission.indexOf(check) < admission.findIndex(request => request.method === "turn/start"));
  transcript("confirmed_followup", confirmed.f, offset, { status: resumed.status });

  const { f, launch, original } = await stopOwner(false);
  offset = f.requests().length;
  const retiring = direct(f.call("task", "--thread", original.threadId, "--direct", "follow up"), 2);
  assert.equal(retiring.status, "blocked"); assert.equal(retiring.blockers[0].code, "thread_busy"); assert.ok(retiring.blockers[0].cancelCommand);
  assert.ok(f.requests().slice(offset).every(request => request.method === "thread/read"));
  transcript("blocked_while_broker_retires", f, offset, { status: retiring.status, blocker: retiring.blockers[0].code });
  // The existing broker retires an abandoned, unconfirmed stream. Once it has
  // exited, the replacement can read the fixture's persisted exact turn.
  await waitUntil(() => !alive(f.requests()[0].serverId));
  let cancelCommand;
  for (const args of [["--thread", original.threadId], ["--continue", launch.jobId], ["--to", launch.agentName]]) {
    offset = f.requests().length;
    const blocked = direct(f.call("task", ...args, "--direct", "follow up"), 2);
    assert.equal(blocked.status, "blocked"); assert.equal(blocked.blockers[0].code, "thread_busy");
    cancelCommand = blocked.blockers[0].cancelCommand; assert.ok(cancelCommand);
    assert.deepEqual(f.requests().slice(offset).map(request => request.method), ["thread/read"]);
    assert.equal(stored(f, launch.jobId).result.turnEnded, false);
    transcript(`blocked_${args[0]}`, f, offset, { status: blocked.status, blocker: blocked.blockers[0].code, cancelCommand });
  }
  changeServer(f, { unreadable: true });
  offset = f.requests().length;
  assert.equal(json(f.call("status", launch.jobId, "--json")).job.turnResolution, "unknown");
  assert.deepEqual(stored(f, launch.jobId).result, original.result);
  const unreadable = direct(f.call("task", "--thread", original.threadId, "--direct", "follow up"), 2);
  assert.equal(unreadable.blockers[0].code, "thread_busy"); assert.ok(unreadable.blockers[0].cancelCommand);
  assert.deepEqual(f.requests().slice(offset).map(request => request.method), ["thread/read", "thread/read"]);
  transcript("unreadable_stays_blocked", f, offset, { status: unreadable.status });

  changeServer(f, { ignoreInterrupt: false, unreadable: false });
  offset = f.requests().length;
  const cancelled = json(run("/bin/sh", ["-c", cancelCommand], { cwd: f.repo, env: f.env }));
  assert.equal(cancelled.confirmation, "confirmed"); assert.equal(cancelled.backgroundTerminals.cleaned, true);
  preservedOutcome(f, original, "interrupted");
  const cancellationRequests = f.requests().slice(offset);
  const interrupt = cancellationRequests.findLastIndex(request => request.method === "turn/interrupt");
  assert.deepEqual(cancellationRequests[interrupt].params, { threadId: original.threadId, turnId: original.turnId });
  assert.deepEqual(cancellationRequests.slice(interrupt + 1).map(request => request.method), ["thread/read", "thread/backgroundTerminals/clean"]);
  transcript("explicit_cancel_resolves_owner_stop", f, offset, { status: stored(f, launch.jobId).status, confirmation: cancelled.confirmation });
  offset = f.requests().length;
  const followup = direct(f.call("task", "--to", launch.agentName, "--direct", "follow up"));
  assert.equal(followup.status, "completed");
  assert.equal(f.requests().slice(offset).filter(request => request.method === "turn/start").length, 1);
  transcript("followup_after_cancel", f, offset, { status: followup.status });

  const userCancel = fixture("lost-turn:owner-stop"), userLaunch = json(userCancel.call("task", "--detached", "--json", "fixture"));
  await waitUntil(() => stored(userCancel, userLaunch.jobId).turnId);
  const userWorkerPid = stored(userCancel, userLaunch.jobId).pid;
  changeServer(userCancel, { ignoreInterrupt: true });
  assert.equal(json(userCancel.call("cancel", userLaunch.jobId, "--json"), 2).confirmation, "unconfirmed");
  await waitUntil(() => !alive(userWorkerPid));
  await waitUntil(() => !alive(userCancel.requests()[0].serverId));
  const cancelledOriginal = stored(userCancel, userLaunch.jobId);
  assert.equal(cancelledOriginal.status, "cancelled"); assert.equal(cancelledOriginal.result.turnEnded, false);
  assert.equal(direct(userCancel.call("task", "--continue", userLaunch.jobId, "--direct", "follow up"), 2).blockers[0].code, "thread_busy");

  // Independently observed terminal turns resolve safety without replacing
  // either stopped outcome, even when the server completed or failed later.
  for (const [runtime, stopped] of [[f, original], [userCancel, cancelledOriginal]]) {
    for (const turnStatus of ["completed", "interrupted", "failed"]) {
      patchJob(runtime, stopped.id, { ...stopped, recovered: false, recovery: null, turnResolution: "unknown" });
      const state = runtime.state(), turn = state.threads.find(thread => thread.id === stopped.threadId).turns.find(turn => turn.id === stopped.turnId);
      Object.assign(turn, { status: turnStatus, completedAt: Math.floor(Date.now() / 1000), error: turnStatus === "failed" ? { message: "Fixture server failed" } : null });
      changeServer(runtime, state);
      offset = runtime.requests().length;
      const status = json(runtime.call("status", stopped.id, "--json")).job;
      assert.equal(status.status, stopped.status); assert.equal(status.interruptionConfirmed, true);
      assert.deepEqual(runtime.requests().slice(offset), [{ serverId: runtime.requests().at(-1).serverId, method: "thread/read", params: { threadId: stopped.threadId, includeTurns: true } }]);
      preservedOutcome(runtime, stopped, turnStatus);
      json(runtime.call("status", stopped.id, "--json"));
      assert.equal(runtime.requests().length, offset + 1);
      transcript(`${stopped.status}_observed_${turnStatus}`, runtime, offset, { status: status.status, turnEnded: true, interruptionConfirmed: status.interruptionConfirmed });
    }
  }

  // Server admission also covers another workspace, even after an exact
  // terminal recovery has released the local predecessor's index entry.
  const cross = fixture("lost-turn:completed");
  const failed = cross.call("task", "--report", "--json", "fixture");
  assert.equal(failed.status, 1);
  const id = /Job handle: ([^;]+)/.exec(failed.stderr)[1], originalCross = stored(cross, id);
  patchJob(cross, id, { turnId: null, result: { ...originalCross.result, turnId: null } });
  const recovered = json(cross.call("status", id, "--json")).job;
  assert.equal(recovered.status, "completed"); assert.equal(recovered.turnId, originalCross.turnId);
  const state = cross.state();
  state.threads[0].turns.push({ id: "other-live-turn", status: "inProgress", items: [] });
  changeServer(cross, state);
  const other = path.join(cross.dir, "other"); fs.mkdirSync(other); initGitRepo(other);
  offset = cross.requests().length;
  const refused = direct(cross.call("task", "--thread", originalCross.threadId, "--cwd", other, "--sandbox", "read-only", "--direct", "fixture"), 2);
  assert.equal(refused.status, "blocked"); assert.equal(refused.blockers[0].code, "thread_busy");
  assert.equal(cross.requests().slice(offset).some(request => request.method === "turn/start"), false);
  assert.equal(cross.state().nextTurnId, 2);

  // Unreadable and ambiguous missing handles must produce an honest cancel
  // result, without submitting work or guessing which turn to interrupt.
  const missing = fixture("lost-turn:inProgress"), lost = missing.call("task", "--report", "--json", "fixture");
  const missingId = /Job handle: ([^;]+)/.exec(lost.stderr)[1], missingJob = stored(missing, missingId);
  patchJob(missing, missingId, { turnId: null, result: { ...missingJob.result, turnId: null } });
  changeServer(missing, { unreadable: true });
  assert.equal(json(missing.call("cancel", missingId, "--json"), 2).status, "interrupt_unconfirmed");
  const ambiguous = missing.state(); ambiguous.unreadable = false;
  ambiguous.threads[0].turns.push({ id: "another-turn", status: "inProgress", items: [] }); changeServer(missing, ambiguous);
  assert.equal(json(missing.call("cancel", missingId, "--json"), 2).status, "interrupt_unconfirmed");
  ambiguous.threads[0].turns.pop(); changeServer(missing, ambiguous);
  assert.equal(json(missing.call("cancel", missingId, "--json")).confirmation, "confirmed");

  // Dispatch can die after publishing its reservation but before writing the
  // private record. A live launcher is protected; abandoned launches release
  // admission without reading or claiming an earlier turn on the thread.
  const reservations = fixture("task-ok");
  const seed = direct(reservations.call("task", "--direct", "fixture"));
  const threadId = stored(reservations, seed.jobId).threadId;
  const stateModule = new URL("../plugins/codex/scripts/lib/state.mjs", import.meta.url).href;
  const { unresolvedTask } = await import(stateModule);
  const reserve = record => {
    const result = run(process.execPath, ["--input-type=module", "-e", `
      import { upsertJob } from ${JSON.stringify(stateModule)};
      upsertJob(process.cwd(), ${JSON.stringify(record)});
    `], { cwd: reservations.repo, env: reservations.env });
    assert.equal(result.status, 0, result.stderr);
  };
  const reservation = (id, patch = {}) => ({ id, jobClass: "task", kind: "task", workspaceRoot: reservations.repo,
    sessionId: reservations.env.CODEX_COMPANION_SESSION_ID, status: "queued", phase: "queued", threadId,
    pid: null, turnId: null, createdAt: new Date().toISOString(), ...patch });
  const privateFile = (f, id) => path.join(resolveStateDir(f.repo, f.env), "jobs", `${id}.json`);
  const launcher = spawnOwned(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: reservations.repo, env: reservations.env, stdio: "ignore" });
  const launcherClosed = new Promise(resolve => launcher.once("close", resolve));
  const live = reservation("task-live-reservation", { launcherPid: launcher.pid });
  try {
    reserve(live);
    assert.equal(json(reservations.call("status", live.id, "--json")).job.status, "queued");
    assert.equal(fs.existsSync(privateFile(reservations, live.id)), false);
    assert.equal(json(reservations.call("status", "--all", "--json")).running.some(job => job.id === live.id), false);
    const protectedFollowup = direct(reservations.call("task", "--thread", threadId, "--sandbox", "read-only", "--direct", "fixture"), 2);
    assert.equal(protectedFollowup.blockers[0].code, "thread_busy");
    assert.equal(reservations.state().nextTurnId, 2);
    assert.equal(fs.existsSync(privateFile(reservations, live.id)), false);
  } finally {
    launcher.kill("SIGKILL");
    await launcherClosed;
  }
  assert.equal(alive(launcher.pid), false);
  assert.equal(direct(reservations.call("task", "--thread", threadId, "--sandbox", "read-only", "--direct", "fixture")).status, "completed");
  const abandoned = stored(reservations, live.id);
  assert.equal(abandoned.status, "failed"); assert.equal(abandoned.recovery.turnStatus, "notStarted");
  assert.equal(unresolvedTask(abandoned), false); assert.ok(abandoned.errorMessage);
  assert.equal(json(reservations.call("result", live.id), 1).status, "failed");
  assert.equal(json(reservations.call("result", live.id, "--details"), 1).status, "failed");
  assert.equal(json(reservations.call("cancel", live.id, "--json")).confirmation, "confirmed");

  const legacy = reservation("task-aged-reservation", { createdAt: "2000-01-01T00:00:00.000Z" });
  reserve(legacy);
  const listed = json(reservations.call("status", "--all", "--json"));
  assert.equal(listed.running.some(job => job.id === legacy.id), false);
  assert.equal(stored(reservations, legacy.id).status, "failed");
  assert.equal(unresolvedTask(stored(reservations, legacy.id)), false);
  assert.equal(json(reservations.call("result", legacy.id, "--details"), 1).status, "failed");
  assert.equal(direct(reservations.call("task", "--thread", threadId, "--sandbox", "read-only", "--direct", "fixture")).status, "completed");

  const noThread = reservation("task-missing-before-thread", { status: "running", pid: launcher.pid, threadId: null });
  reserve(noThread);
  const notStarted = json(reservations.call("status", noThread.id, "--json")).job;
  assert.equal(notStarted.status, "failed"); assert.equal(notStarted.recovery.turnStatus, "notStarted");
  assert.equal(json(reservations.call("cancel", noThread.id, "--json")).confirmation, "confirmed");

  // Losing a started job's private record does not resolve its live server
  // turn. Exact views expose recovery, and the advertised cancel releases it.
  const indexOnly = fixture("lost-turn:owner-stop"), indexLaunch = json(indexOnly.call("task", "--detached", "--json", "fixture"));
  await waitUntil(() => stored(indexOnly, indexLaunch.jobId).turnId);
  const indexJob = stored(indexOnly, indexLaunch.jobId);
  changeServer(indexOnly, { ignoreInterrupt: true });
  process.kill(indexJob.pid, "SIGKILL");
  await waitUntil(() => !alive(indexJob.pid));
  await waitUntil(() => !alive(indexOnly.requests()[0].serverId));
  fs.unlinkSync(privateFile(indexOnly, indexJob.id));
  const missingStatus = json(indexOnly.call("status", indexJob.id, "--json"));
  assert.equal(missingStatus.job.status, "failed"); assert.ok(missingStatus.recovery.recoveryCommand);
  assert.equal(unresolvedTask(stored(indexOnly, indexJob.id)), true);
  const pending = json(indexOnly.call("result", indexJob.id), 2);
  assert.equal(pending.status, "unknown"); assert.ok(pending.blockers[0].recoveryCommand);
  assert.equal(json(indexOnly.call("result", indexJob.id, "--details"), 2).status, "unknown");
  assert.equal(direct(indexOnly.call("task", "--thread", indexJob.threadId, "--direct", "fixture"), 2).blockers[0].code, "thread_busy");
  changeServer(indexOnly, { ignoreInterrupt: false });
  const cancelMissing = json(run("/bin/sh", ["-c", pending.blockers[0].cancelCommand], { cwd: indexOnly.repo, env: indexOnly.env }));
  assert.equal(cancelMissing.confirmation, "confirmed");
  assert.equal(direct(indexOnly.call("task", "--thread", indexJob.threadId, "--direct", "fixture")).status, "completed");

  const reset = fixture("review-ok"), resetBinary = path.join(reset.dir, "codex");
  const resetSource = fs.readFileSync(resetBinary, "utf8");
  const usageMarker = 'if (BEHAVIOR === "large-jsonl") {\n          emitTurnCompleted';
  assert.ok(resetSource.includes(usageMarker));
  fs.writeFileSync(resetBinary, resetSource.replace(usageMarker, `
        const resetUsage = { inputTokens: 25, cachedInputTokens: 5, cacheWriteInputTokens: 0,
          outputTokens: 5, reasoningOutputTokens: 2, totalTokens: 30 };
        for (const key of Object.keys(resetUsage)) thread.tokenUsage[key] -= 2 * resetUsage[key];
        emitUsage(resetUsage);
        ${usageMarker}`));
  const resetResult = direct(reset.call("task", "--fresh", "--direct", "fixture"));
  assert.equal(Object.hasOwn(resetResult, "usage"), false);
  assert.equal(Object.hasOwn(stored(reset, resetResult.jobId).result, "usage"), false);
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
  assert.equal(result.measurements.progressLines - result.omissionLines.length + result.measurements.omittedLines, result.saved.activity.length, "display omissions do not lose event accounting");
  const stopped = await backpressureScenario(script, { signalStop: true });
  const final = direct({ status: stopped.code, stdout: stopped.stdout, stderr: stopped.stderr }, 130);
  assert.equal(final.status, "owner_stopped");
  assert.equal(final.jobId, stopped.saved.id);
  assert.equal(stopped.stderr, "");
});

test("a direct wait replaces a previously stored follow continuation after cancellation", () => {
  const f = fixture(), launch = json(f.call("task", "--follow", "--json", "--timeout-sec", "1", "fixture"));
  json(f.call("cancel", launch.jobId, "--json"));
  const before = json(f.call("result", launch.jobId, "--json")).storedJob.report;
  assert.match(before.continuationCommand, / --follow --report --json$/);
  const done = direct(f.call("wait", launch.jobId, "--owner", launch.ownerId, "--direct"), 1);
  const details = json(f.call("result", done.jobId, "--details"), 1);
  assert.match(details.continuationCommand, / --direct$/);
  assert.equal(json(f.call("result", launch.jobId, "--json")).storedJob.report.continuationCommand, details.continuationCommand);
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
  const start = f.state().lastThreadStart;
  assert.deepEqual(start.config.mcp_servers.duet_parent, { ...bridge, env: {
    [PARENT_BRIDGE_ENV.cwd]: f.repo, [PARENT_BRIDGE_ENV.jobId]: first.jobId,
    CODEX_COMPANION_HOME: bridge.env.CODEX_COMPANION_HOME,
    ...(f.env.TMPDIR ? { TMPDIR: f.env.TMPDIR } : {})
  } }, "new threads use the bridge with only the job handle and state-location variables");
  assert.equal(Object.hasOwn(start, "dynamicTools"), false);
  const active = fixture();
  const running = json(active.call("task", "--detached", "--json", "third"));
  await waitUntil(() => job(active, running.jobId).turnId);
  assert.notEqual(active.call("task", "--continue", running.jobId, "--json").status, 0);
  json(active.call("cancel", running.jobId, "--json"));

  // An older runtime rejects the bridge override, then the dynamic registration.
  const fallback = fixture("slow-task"), binary = path.join(fallback.dir, "codex");
  fs.writeFileSync(binary, fs.readFileSync(binary, "utf8").replace('case "thread/start": {', `case "thread/start": {
    state.startRegistrations = [...(state.startRegistrations || []), [Boolean(message.params.config), Boolean(message.params.dynamicTools)]];
    saveState(state);
    if (message.params.config || message.params.dynamicTools) {
      send({ id: message.id, error: { code: -32602, message: message.params.config ? "unknown field config" : "dynamicTools unsupported" } });
      break;
    }`));
  const compatible = fallback.call("task", "--follow", "--report", "--json", "compatibility fallback");
  assert.deepEqual({ exit: compatible.status, registrations: fallback.state().startRegistrations },
  { exit: 0, registrations: [[true, false], [false, true], [false, false]] });

  // Unrelated errors, including serde's list of accepted fields, are not registration rejections.
  for (const originalError of ["Invalid model config: unsupported model selected",
    "unknown field `serviceName`, expected one of `cwd`, `model`, `config`, `dynamicTools`"]) {
    const unrelated = fixture("slow-task"), unrelatedBinary = path.join(unrelated.dir, "codex");
    fs.writeFileSync(unrelatedBinary, fs.readFileSync(unrelatedBinary, "utf8").replace('case "thread/start": {', `case "thread/start": {
    state.startAttempts = (state.startAttempts || 0) + 1; saveState(state);
    if (state.startAttempts === 1) {
      send({ id: message.id, error: { code: -32602, message: ${JSON.stringify(originalError)} } }); break;
    }`));
    const failed = json(unrelated.call("task", "--follow", "--report", "--json", "unrelated model error"), 1);
    const failedJob = job(unrelated, failed.jobId);
    assert.deepEqual({ attempts: unrelated.state().startAttempts, status: failedJob.status, error: failedJob.recovery?.originalError },
      { attempts: 1, status: "failed", error: originalError });
  }
});

test("the parent bridge answers ask_parent through the job file and reports cancellation", async t => {
  const { updateState } = await import("../plugins/codex/scripts/lib/state.mjs");
  const previousHome = process.env.CODEX_COMPANION_HOME;
  process.env.CODEX_COMPANION_HOME = path.join(makeTempDir(), "isolated");
  t.after(() => { process.env.CODEX_COMPANION_HOME = previousHome; });
  // An unrelated index-less leftover makes the inventory incomplete; exact turn
  // ownership must still route questions instead of disabling the tool.
  const leftover = path.join(process.env.CODEX_COMPANION_HOME, "duet", "state", "leftover", "jobs");
  fs.mkdirSync(leftover, { recursive: true }); fs.writeFileSync(path.join(leftover, "stray.json"), "{}");
  const openBridge = (cwd, env) => {
    const bridge = spawnOwned(process.execPath, [bridgeScript], { cwd, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    t.after(() => { if (alive(bridge.pid)) bridge.kill(); });
    const replies = []; let buffer = "";
    bridge.stdout.on("data", chunk => { buffer += chunk; let i; while ((i = buffer.indexOf("\n")) >= 0) { replies.push(JSON.parse(buffer.slice(0, i))); buffer = buffer.slice(i + 1); } });
    return { bridge, send: message => bridge.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`), reply: id => waitUntil(() => replies.find(r => r.id === id)) };
  };
  for (const binding of ["threadId", "jobId"]) {
    const cwd = makeTempDir(), id = "bridge-job", threadId = `thread-bridge-${binding}`, turnId = "turn-bridge";
    writeJobFile(cwd, id, { id, status: "running", jobClass: "task", workspaceRoot: cwd, ownerId: "owner", questionTimeoutSec: 5,
      threadId: binding === "threadId" ? threadId : null, turnId });
    upsertJob(cwd, { id, status: "running", jobClass: "task", workspaceRoot: cwd,
      threadId: binding === "threadId" ? threadId : null, turnId, createdAt: "2026-01-01T00:00:00.000Z" });
    const otherCwd = makeTempDir(), queued = "bridge-queued";
    const reservation = { id: queued, status: "queued", jobClass: "task", workspaceRoot: otherCwd,
      threadId, sessionId: "other-session", createdAt: "2026-02-01T00:00:00.000Z" };
    writeJobFile(otherCwd, queued, reservation); upsertJob(otherCwd, reservation);
    const { bridge, send, reply } = openBridge(cwd, { [PARENT_BRIDGE_ENV.cwd]: cwd, [PARENT_BRIDGE_ENV[binding]]: binding === "threadId" ? threadId : id });
    bridge.stdin.write('null\n[]\ntrue\n42\n"text"\n');
    send({ id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
    assert.equal((await reply(1)).result.serverInfo.name, "duet-parent-bridge");
    send({ method: "notifications/initialized" });
    send({ id: 2, method: "tools/list" });
    assert.deepEqual((await reply(2)).result.tools.map(t => t.name), ["ask_parent"]);
    if (binding === "jobId") {
      send({ id: 10, method: "tools/call", params: { name: "ask_parent", arguments: { question: "Thread recorded yet?" }, _meta: { threadId } } });
      assert.equal((await reply(10)).result.isError, true, "metadata cannot supply a missing bound thread");
      updateJob(cwd, id, () => ({ threadId }));
    }
    send({ id: 11, method: "tools/call", params: { name: "ask_parent", arguments: { question: "Wrong thread?" }, _meta: { threadId: "other-thread" } } });
    assert.equal((await reply(11)).result.isError, true);
    send({ id: 3, method: "tools/call", params: { name: "ask_parent", arguments: { question: "Which way?", options: ["A", "B"] },
      _meta: { threadId, callId: "call_bridge_3", "x-codex-turn-metadata": { turn_id: turnId } } } });
    const pending = await waitUntil(() => readJobFile(resolveJobFile(cwd, id)).pendingQuestion);
    assert.equal(pending.text, "Which way?"); assert.deepEqual(pending.options, ["A", "B"]);
    assert.equal(readJobFile(resolveJobFile(otherCwd, queued)).pendingQuestion, undefined, "an unadmitted reservation cannot receive another turn's question");
    answerQuestion(cwd, id, pending.id, "Go with A", "owner");
    const answered = await reply(3);
    assert.equal(answered.result.isError, false); assert.equal(answered.result.content[0].text, "Go with A");
    assert.equal(readJobFile(resolveJobFile(cwd, id)).questionHistory.at(-1).callId, "call_bridge_3");
    for (const [requestId, separator] of [[8, "\u2028"], [9, "\u2029"]]) {
      const question = `Which${separator}way?`;
      const wire = Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method: "tools/call", params: { name: "ask_parent", arguments: { question },
        ...(requestId === 9 ? { _meta: { callId: "invalid/call" } } : {}) } })}\r\n`);
      const cut = wire.indexOf(Buffer.from(separator)) + 1;
      bridge.stdin.write(wire.subarray(0, cut));
      bridge.stdin.write(wire.subarray(cut));
      const unicodePending = await waitUntil(() => {
        const current = readJobFile(resolveJobFile(cwd, id)).pendingQuestion;
        return current?.text === question && current;
      });
      answerQuestion(cwd, id, unicodePending.id, "Go with B", "owner");
      const unicodeReply = await reply(requestId);
      assert.equal(unicodeReply.result.isError, false);
      assert.equal(unicodeReply.result.content[0].text, "Go with B");
      assert.equal(readJobFile(resolveJobFile(cwd, id)).questionHistory.at(-1).callId, null, "missing or invalid metadata never falls back to the RPC id");
    }
    send({ id: 4, method: "tools/call", params: { name: "ask_parent", arguments: { question: "x".repeat(1001) } } });
    assert.equal((await reply(4)).result.isError, true);
    updateJob(cwd, id, () => ({ cancelRequested: { reason: "cancelled_by_user", at: new Date().toISOString() } }));
    send({ id: 5, method: "tools/call", params: { name: "ask_parent", arguments: { question: "Still there?" } } });
    assert.equal((await reply(5)).result.isError, false);
    // The broker keeps a thread loaded across runs, so one bridge process outlives
    // the job that spawned it: once that job is over, calls bind to the thread's
    // turn owner, and with none active the tool reports it instead of hanging.
    updateJob(cwd, id, () => ({ status: "completed", cancelRequested: null }));
    upsertJob(cwd, { id, status: "completed" });
    send({ id: 6, method: "tools/call", params: { name: "ask_parent", arguments: { question: "Anyone?" } } });
    const nobody = await reply(6);
    assert.equal(nobody.result.isError, true);
    const next = "bridge-job-2";
    writeJobFile(cwd, next, { id: next, status: "running", jobClass: "task", workspaceRoot: cwd, ownerId: "owner-2", questionTimeoutSec: 5, threadId, turnId: "turn-next" });
    upsertJob(cwd, { id: next, status: "running", jobClass: "task", workspaceRoot: cwd, threadId, turnId: "turn-next", createdAt: "2026-01-02T00:00:00.000Z" });
    send({ id: 7, method: "tools/call", params: { name: "ask_parent", arguments: { question: "Next job?" } } });
    const nextPending = await waitUntil(() => readJobFile(resolveJobFile(cwd, next)).pendingQuestion);
    assert.equal(nextPending.text, "Next job?"); assert.equal(readJobFile(resolveJobFile(cwd, id)).pendingQuestion, null, "the finished job is left alone");
    answerQuestion(cwd, next, nextPending.id, "Yes", "owner-2");
    assert.equal((await reply(7)).result.content[0].text, "Yes");

    const originFile = resolveJobFile(cwd, id);
    updateState(cwd, state => { state.jobs = state.jobs.filter(job => job.id !== id); });
    assert.equal(fs.existsSync(originFile), false, "the starting record is deleted after the bridge has bound its thread");
    const cross = "bridge-cross-workspace";
    const crossJob = { id: cross, status: "running", jobClass: "task", workspaceRoot: otherCwd,
      ownerId: "owner-cross", questionTimeoutSec: 5, threadId, turnId: null };
    writeJobFile(otherCwd, cross, crossJob); upsertJob(otherCwd, crossJob);
    send({ id: 12, method: "tools/call", params: { name: "ask_parent", arguments: { question: "Other workspace?" },
      _meta: { threadId, "x-codex-turn-metadata": { turn_id: "turn-cross" } } } });
    // The first lookup has run before this ping; publish the accepted turn while
    // its question waits, without asserting a timing threshold.
    send({ id: 13, method: "ping" }); await reply(13);
    updateJob(otherCwd, cross, () => ({ turnId: "turn-cross" }));
    const crossPending = await waitUntil(() => readJobFile(resolveJobFile(otherCwd, cross)).pendingQuestion);
    assert.equal(crossPending.text, "Other workspace?");
    answerQuestion(otherCwd, cross, crossPending.id, "Cross-workspace answer", "owner-cross");
    assert.equal((await reply(12)).result.content[0].text, "Cross-workspace answer");

    for (const [requestId, meta] of [[14, undefined], [15, { "x-codex-turn-metadata": { turn_id: "invalid/turn" } }]]) {
      send({ id: requestId, method: "tools/call", params: { name: "ask_parent", arguments: { question: "Ambiguous owner?" }, _meta: meta } });
      assert.equal((await reply(requestId)).result.isError, true, "missing or invalid turn metadata cannot choose between admitted owners");
    }
    bridge.stdin.end();
    await waitUntil(() => !alive(bridge.pid));
  }

  // A loaded bridge keeps its thread even when no turn asked before the starting
  // record was pruned: it captures the binding once the thread is recorded.
  const coldCwd = makeTempDir(), origin = "cold-origin", coldThread = "thread-cold";
  const originJob = { id: origin, status: "running", jobClass: "task", workspaceRoot: coldCwd, threadId: null, createdAt: "2026-03-01T00:00:00.000Z" };
  writeJobFile(coldCwd, origin, originJob); upsertJob(coldCwd, originJob);
  const cold = openBridge(coldCwd, { [PARENT_BRIDGE_ENV.cwd]: coldCwd, [PARENT_BRIDGE_ENV.jobId]: origin });
  cold.send({ id: 1, method: "tools/list" }); await cold.reply(1);
  updateJob(coldCwd, origin, () => ({ threadId: coldThread, status: "completed" }));
  cold.send({ id: 2, method: "ping" }); await cold.reply(2);
  updateState(coldCwd, state => { state.jobs = state.jobs.filter(job => job.id !== origin); });
  assert.equal(fs.existsSync(resolveJobFile(coldCwd, origin)), false);
  const current = { id: "cold-current", status: "running", jobClass: "task", workspaceRoot: coldCwd, ownerId: "owner-cold", questionTimeoutSec: 5,
    threadId: coldThread, turnId: "turn-cold", createdAt: "2026-03-02T00:00:00.000Z" };
  writeJobFile(coldCwd, current.id, current); upsertJob(coldCwd, current);
  cold.send({ id: 3, method: "tools/call", params: { name: "ask_parent", arguments: { question: "First question?" },
    _meta: { threadId: coldThread, "x-codex-turn-metadata": { turn_id: "turn-cold" } } } });
  const coldPending = await waitUntil(() => readJobFile(resolveJobFile(coldCwd, current.id)).pendingQuestion);
  answerQuestion(coldCwd, current.id, coldPending.id, "Still bound", "owner-cold");
  assert.equal((await cold.reply(3)).result.content[0].text, "Still bound");
  cold.bridge.stdin.end();
  await waitUntil(() => !alive(cold.bridge.pid));
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


test("duet answers a named pending worker once and retains owner and sole-wait protections", async () => {
  const f = fixture("w5-parent"), gate = path.join(f.dir, "answer-finish");
  const duet = new URL("../plugins/codex/bin/duet", import.meta.url).pathname;
  changeQuestionReply(f, `      while (!fs.existsSync(${JSON.stringify(gate)})) await new Promise(resolve => setTimeout(resolve, 25));`);
  const compact = direct(f.call("task", "--direct", "--owner", "parent's owner", "fixture"));
  const pending = json(f.call("result", compact.jobId, "--details"));
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
  const owner = startQuestionCommand(f, `node "${duet}" answer ${pending.agentName.toLowerCase()}`, answer);
  try {
    await waitUntil(() => f.state().serverRequestReplies?.length === 1);
    const attached = read();
    assert.equal(attached.ownerAttached, true);
    assert.equal(attached.ownerWaitPid, owner.child.pid);
    directError(f.call(...splitRawArgumentString(pending.waitCommand).slice(2)));
    directError(run(duet, ["wait", pending.agentName], { cwd: f.repo, env: f.env }));
    directError(run(duet, ["answer", pending.agentName], { cwd: f.repo, env: f.env, input: "retry" }));
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
    assert.equal(done.status, "completed"); assert.equal(saved.turnId, "turn_1");
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
  directError(run(duet, ["answer", pending.jobId], { cwd: f.repo, env: f.env, input: "Already answered." }));
  assert.equal(f.state().serverRequestReplies.length, 1);
  const active = fixture();
  const running = json(active.call("task", "--detached", "--json", "Synthetic cancel target."));
  const cancelled = json(run(duet, ["cancel", running.agentName, "--json"], { cwd: active.repo, env: active.env }));
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.jobId, running.jobId);
});

test("a SIGKILLed owner wait is replaced by wait and answer --direct without interrupting the turn", async () => {
  const f = fixture("w5-parent"), compact = direct(f.call("task", "--direct", "fixture"));
  const pending = json(f.call("result", compact.jobId, "--details"));
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
    assert.equal(done.status, "completed"); assert.equal(saved.turnId, "turn_1");
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
