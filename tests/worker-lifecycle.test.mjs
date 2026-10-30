import test from 'node:test';
import assert from 'node:assert/strict';
import { lifecycleHarness } from './fake-codex-fixture.mjs';
import { TIER_1_NAMES, TIER_2_NAMES, TIER_3_NAMES, NAME_TIER_WEIGHTS } from '../plugins/codex/scripts/lib/agent-name-pool.mjs';
import { ACTIVITY_RETAINED_MAX, ACTIVITY_PENDING_MAX } from '../plugins/codex/scripts/lib/activity.mjs';
import { createJobProgressUpdater, createProgressReporter, runTrackedJob } from '../plugins/codex/scripts/lib/tracked-jobs.mjs';
import { buildWorkerReport, parseStructuredReport } from '../plugins/codex/scripts/lib/worker-report.mjs';
import { fullReport, directReport } from '../plugins/codex/scripts/lib/job-runtime.mjs';
const {
  fs, path, makeTempDir, initGitRepo, buildEnv, installFakeCodex, resolveStateDir, delay, run, browserOriginSetup, transportSetup, resolveIsolatedCodexHome, redactActivity, itemActivity, planActivity, activityReader, formatActivity, writeJobFile, upsertJob, updateJob, readJobFile, resolveJobFile, JobRuntime, pauseAdjustment, renewLease, markOwnerAttachment, leaseSnapshot, questionMessage, adoptJob, ownershipNotice, answerQuestion, askParentQuestion, ownerLost, PARENT_BRIDGE_ENV, resolveSessionMarkersRoot, AGENT_NAMES, pickAgentName, splitRawArgumentString, bridgeScript, spawnOwned, script, alive, fixture, json, directLines, direct, directError, waitUntil, patchJob, job
} = await lifecycleHarness();

const storedJob = (f, id) => readJobFile(path.join(resolveStateDir(f.repo, f.env), "jobs", `${id}.json`));

// Replay only quiescent fixtures captured in this run. Copy all durable state:
// job/index/artifacts, session markers, journal, fake server and broker metadata.
async function snapshotFixture(f) {
  const brokerFile = path.join(resolveStateDir(f.repo, f.env), "broker.json");
  const broker = fs.existsSync(brokerFile) ? readJobFile(brokerFile) : null;
  if (broker?.pid) await waitUntil(() => !alive(broker.pid));
  const roots = [f.dir, ...(broker?.sessionDir ? [broker.sessionDir] : [])];
  const tree = root => {
    if (!fs.existsSync(root)) return null;
    const visit = dir => fs.readdirSync(dir).sort().flatMap(name => {
      const file = path.join(dir, name), relative = path.relative(root, file), stat = fs.lstatSync(file);
      return stat.isDirectory() ? [[relative, "directory"], ...visit(file)]
        : [[relative, stat.isSymbolicLink() ? "symlink" : "file", stat.isSymbolicLink() ? fs.readlinkSync(file) : fs.readFileSync(file)]];
    });
    return visit(root);
  };
  const saved = makeTempDir("lifecycle-snapshot-");
  const baseline = roots.map(tree);
  roots.forEach((root, i) => { if (baseline[i]) fs.cpSync(root, path.join(saved, String(i)), { recursive: true }); });
  return () => {
    roots.forEach((root, i) => {
      fs.rmSync(root, { recursive: true, force: true });
      if (baseline[i]) fs.cpSync(path.join(saved, String(i)), root, { recursive: true });
      assert.deepEqual(tree(root), baseline[i], "replayed fixture matches every captured durable file");
    });
  };
}

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
  // Complete only after the reader has resumed; the real undrained interval
  // remains longer than the owner grace without waiting for a second deadline.
  const heldTimer = "const timer = null; // Held open until an explicit fixture release or turn/interrupt.";
  const completionTimer = `const timer = setInterval(() => {
    if (!fs.existsSync(${JSON.stringify(gate + "-finish")})) return;
    clearInterval(timer);
    emitTurnCompleted(thread.id, turnId, { completed: { type: "agentMessage", id: "fixture-done", text: "Completed fixture work.", phase: "final_answer" } });
  }, 25);`;
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
    for (const deadline = Date.now() + (signal === "SIGTERM" ? 700 : 15000); Date.now() < deadline;) {
      if (!records().some(record => !record.exited && alive(record.pid))) break;
      await delay(25);
    }
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
    if (signalStop) await until(() => read().activityTotals?.events >= 3500);
    else await delay(6500);
    const beforeDrain = read(), undrainedMs = Date.now() - pausedAt;
    const heartbeatAgeMs = Date.now() - beforeDrain.leaseRenewedAt;
    if (signalStop) { owner.kill("SIGTERM"); await delay(300); }
    owner.stdout.resume();
    if (!signalStop) fs.writeFileSync(gate + "-finish", "finish");
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
  assert.ok(AGENT_NAMES.length >= 1000);
  assert.ok(AGENT_NAMES.every(name => /^[A-Z][A-Za-z]{1,11}$/.test(name)));
  assert.equal(new Set(AGENT_NAMES.map(name => name.toLowerCase())).size, AGENT_NAMES.length);
  const reserved = new Set([
    "task", "answer", "wait", "result", "status", "cancel", "adopt", "setup", "review", "journal",
    "list", "help", "main", "next", "done", "stop", "all", "none", "true", "false", "null",
    // Remaining subcommands in codex-companion.mjs, including internal ones.
    "cleanup", "adversarial-review", "transfer", "task-worker", "task-resume-candidate", "ultra-codex", "pair", "duel"
  ]);
  assert.ok(AGENT_NAMES.every(name => !reserved.has(name.toLowerCase())));
  const first = pickAgentName([], () => 0);
  assert.equal(first, TIER_1_NAMES[0]);
  const totalWeight = [TIER_1_NAMES, TIER_2_NAMES, TIER_3_NAMES]
    .reduce((sum, names, tier) => sum + names.length * NAME_TIER_WEIGHTS[tier], 0);
  const tierOneIndex = Math.floor(TIER_1_NAMES.length / 2);
  const tierOneDraw = (tierOneIndex + 0.5) * NAME_TIER_WEIGHTS[0] / totalWeight;
  assert.equal(pickAgentName([], () => tierOneDraw), TIER_1_NAMES[tierOneIndex]);
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

  const named = fixture("w5-parent"), duet = path.join(path.dirname(script), "../bin/duet");
  const namedTask = (...args) => run(process.execPath, [duet, "task", ...args],
    { cwd: named.repo, env: named.env, input: "Named fixture assignment." });
  const namedFirst = direct(namedTask("--name", "demo-1"));
  assert.equal(namedFirst.worker, "demo-1");
  assert.equal(job(named, namedFirst.jobId).agentName, namedFirst.worker);
  const conflict = direct(namedTask("--agent-name", "DEMO-1"));
  assert.notEqual(conflict.worker.toLowerCase(), namedFirst.worker.toLowerCase());
  assert.equal(job(named, conflict.jobId).agentName, conflict.worker);
  assert.equal(json(named.call("status", namedFirst.worker, "--json")).job.id, namedFirst.jobId);
  for (const flag of ["--name", "--agent-name"]) {
    for (const value of ["", "bad name", "_leading", "a/b", "é", "x".repeat(65)]) {
      const invalid = directError(namedTask(flag, value));
      assert.equal(invalid.jobId, null);
    }
  }
  assert.equal(named.state().threads.length, 2);
  const answered = direct(run(process.execPath, [duet, "answer", namedFirst.worker],
    { cwd: named.repo, env: named.env, input: "Small" }));
  assert.equal(answered.status, "completed");
  const followed = direct(namedTask("--to", namedFirst.worker, "--name", "ignored-new-name"));
  assert.equal(followed.worker, namedFirst.worker);
  assert.equal(job(named, followed.jobId).threadId, job(named, namedFirst.jobId).threadId);
  for (const report of [conflict, followed]) json(named.call("cancel", report.jobId, "--json"));
  const boundary = "A_0.-" + "x".repeat(59);
  const maxName = direct(namedTask("--name", boundary));
  assert.equal(maxName.worker, boundary);
  json(named.call("cancel", maxName.jobId, "--json"));

  const reserved = fixture("task-ok");
  const reservedTask = (...args) => run(process.execPath, [duet, "task", ...args],
    { cwd: reserved.repo, env: reserved.env, input: "Reserved name fixture." });
  const reservedNames = ["task-x", "TASK-x", "review-x", "ReViEw-x", "job-x", "JOB-x"];
  for (const name of reservedNames) {
    const refused = directError(reservedTask("--name", name));
    assert.equal(refused.jobId, null);
    assert.equal(refused.worker, null);
  }
  assert.equal(fs.existsSync(path.join(reserved.dir, "fake-codex-state.json")), false);
  const ordinary = direct(reservedTask("--name", "Noether"));
  assert.equal(ordinary.status, "completed");
  assert.equal(ordinary.worker, "Noether");
  assert.equal(directError(reservedTask("--name", ordinary.jobId)).jobId, null);
  const nativeReserved = ["TASK-x", "ReViEw-x", "JOB-x"];
  for (const name of nativeReserved) {
    const fallback = direct(reservedTask("--agent-name", name));
    assert.equal(fallback.status, "completed");
    assert.ok(AGENT_NAMES.includes(fallback.worker));
    assert.equal(job(reserved, fallback.jobId).agentName, fallback.worker);
  }
  assert.equal(reserved.state().threads.length, nativeReserved.length + 1);

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
    await waitUntil(() => storedJob(fresh, initial.jobId).status === "completed");
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
  const f = fixture("task-ok"), now = Date.now();
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
  // Native names reserve before spawn, sharing the atomic pool with Bash.
  const native = fixture("review-ok"), remote = path.join(native.dir, "remote");
  fs.mkdirSync(remote); initGitRepo(remote);
  const reserve = cwd => new Promise((resolve, reject) => {
    const child = spawnOwned(process.execPath, ["--import", preload, script, "reserve-name", "--session-cwd", cwd],
      { cwd: native.repo, env: native.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; });
    child.on("error", reject);
    child.on("close", status => { try { resolve(json({ status, stdout, stderr }).name); } catch (error) { reject(error); } });
  });
  const names = await Promise.all([reserve(native.repo), reserve(remote)]);
  assert.deepEqual([...names].sort(), ["Ada", "Turing"]);
  assert.equal(fs.existsSync(path.join(native.dir, "fake-codex-state.json.requests.jsonl")), false);
  const bash = direct(run(process.execPath, ["--import", preload, script, "task", "--fresh", "--direct", "fixture"],
    { cwd: remote, env: native.env }));
  assert.equal(bash.worker, "Hopper");
  const publicClaim = direct(native.call("task", "--name", names[0], "--fresh", "--direct", "fixture"));
  assert.ok(!names.includes(publicClaim.worker), "public --name cannot consume an unspawned native reservation");
  // Claim/retry/rollback without publishing a job exercises the reservation
  // boundary itself, including competing claimants in another workspace.
  const namesModule = new URL("../plugins/codex/scripts/lib/agent-names.mjs", import.meta.url).href;
  // Exit between exclusive creation and the owner write, before any cleanup.
  // A retry must still consume the name that was reserved before native spawn.
  const interrupted = run(process.execPath, ["--input-type=module", "-e", `
    import fs from "node:fs";
    import { reserveAgentName } from ${JSON.stringify(namesModule)};
    const write = fs.writeFileSync;
    fs.writeFileSync = (file, value, options) => {
      if (value === "native-retry") { fs.openSync(file, options.flag, options.mode); process.exit(86); }
      return write(file, value, options);
    };
    reserveAgentName([], { cwd: process.cwd(), sessionId: "fixture-session", preferredName: ${JSON.stringify(names[0])}, claimOwner: "native-retry" });
  `], { cwd: native.repo, env: native.env });
  assert.equal(interrupted.status, 86, interrupted.stderr);
  const claims = json(run(process.execPath, ["--input-type=module", "-e", `
    import { reserveAgentName } from ${JSON.stringify(namesModule)};
    const options = { cwd: process.cwd(), sessionId: "fixture-session", preferredName: ${JSON.stringify(names[0])}, claimOwner: "native-retry" };
    let release, count = 0;
    const onReserved = (name, rollback) => { count++; release = rollback; };
    const first = reserveAgentName([], { ...options, onReserved });
    const retry = reserveAgentName([], { ...options, onReserved });
    const competitor = reserveAgentName([], { ...options, cwd: ${JSON.stringify(remote)}, claimOwner: "other-dispatch" });
    release();
    const reclaimed = reserveAgentName([], options);
    console.log(JSON.stringify({ first, retry, competitor, reclaimed, count }));
  `], { cwd: native.repo, env: native.env }));
  assert.equal(claims.first, names[0]); assert.equal(claims.retry, names[0]); assert.equal(claims.reclaimed, names[0]);
  assert.notEqual(claims.competitor, names[0]); assert.equal(claims.count, 1);
  const firstNative = direct(native.call("task", "--agent-name", names[0], "--dispatch-nonce", "native-retry", "--fresh", "--direct", "fixture"));
  const secondNative = direct(native.call("task", "--agent-name", names[1], "--cwd", remote, "--fresh", "--direct", "fixture"));
  assert.equal(firstNative.worker, names[0]); assert.equal(secondNative.worker, names[1]);
  assert.equal(job(native, firstNative.jobId).agentName, names[0]);
  const followup = direct(native.call("task", "--to", names[0], "--direct", "fixture"));
  assert.equal(followup.worker, names[0]);
  const collision = direct(native.call("task", "--agent-name", names[0], "--fresh", "--direct", "fixture"));
  assert.ok(!names.includes(collision.worker));
  const noSession = run(process.execPath, [script, "reserve-name", "--session-cwd", native.repo],
    { cwd: native.repo, env: { ...native.env, CODEX_COMPANION_SESSION_ID: "" } });
  assert.equal(noSession.status, 1);

  // Preferred spawn names use the same exclusive reservation and claim path,
  // including case-insensitive collisions and generated suffix forms.
  const preferred = fixture('review-ok');
  const reservePreferred = name => json(preferred.call('reserve-name', '--session-cwd', preferred.repo, '--preferred', name)).name;
  assert.equal(reservePreferred('Noether'), 'Noether');
  const taken = reservePreferred('NOETHER');
  assert.ok(AGENT_NAMES.includes(taken));
  assert.notEqual(taken.toLowerCase(), 'noether');
  assert.equal(reservePreferred('nOeThEr-2'), 'nOeThEr-2');
  assert.equal(fs.existsSync(path.join(preferred.dir, 'fake-codex-state.json.requests.jsonl')), false);
  for (const name of ['Noether', 'nOeThEr-2', taken]) {
    const claimed = direct(preferred.call('task', '--agent-name', name, '--fresh', '--direct', 'fixture'));
    assert.equal(claimed.worker, name);
    assert.equal(job(preferred, claimed.jobId).agentName, name);
    if (name !== 'nOeThEr-2') continue; // Plain/generated names already follow above; retain suffix identity here.
    const followed = direct(preferred.call('task', '--to', name, '--direct', 'fixture'));
    assert.equal(followed.worker, name);
    assert.equal(job(preferred, followed.jobId).threadId, job(preferred, claimed.jobId).threadId);
  }
});

test("detached wait returns bounded safe progress, startup phases and confirmed cancellation", async () => {
  const f = fixture(); const launch = json(f.call("task", "--detached", "--report", "--json", "fixture work"));
  await waitUntil(() => storedJob(f, launch.jobId).startupTimings?.mcpReady);
  const snapshot = json(f.call("wait", launch.jobId, "--timeout-sec", "1", "--json", "--report"));
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

  // Race two real workers on one queued record. Hold the claimant outside the
  // state lock, before runtime startup, so a loser's writes cannot be hidden by
  // the winner's subsequent progress. Exercise dead-PID reclamation as well.
  const stateModule = new URL("../plugins/codex/scripts/lib/state.mjs", import.meta.url).href;
  const expired = spawnOwned(process.execPath, ["-e", ""], { env: f.env, stdio: "ignore" });
  await new Promise(resolve => expired.once("close", resolve));
  assert.equal(alive(expired.pid), false);
  for (const previousClaim of [null, { pid: expired.pid, at: new Date().toISOString() }]) {
    const claim = fixture("review-ok"), id = "claim-fixture";
    const ready = path.join(claim.dir, "ready"), claimed = path.join(claim.dir, "claimed");
    const start = path.join(claim.dir, "start"), release = path.join(claim.dir, "release");
    fs.mkdirSync(ready); fs.mkdirSync(claimed);
    const record = { id, jobClass: "task", kind: "task", workspaceRoot: claim.repo,
      sessionId: claim.env.CODEX_COMPANION_SESSION_ID, ownerId: "claim-owner",
      status: "queued", phase: "queued", createdAt: new Date().toISOString(), pid: process.pid,
      ...(previousClaim ? { executionClaim: previousClaim } : {}),
      logFile: path.join(claim.dir, "job.log"),
      request: { cwd: claim.repo, jobId: id, prompt: "fixture claim", model: "gpt-6-astra", effort: "xhigh",
        sandbox: "read-only", detached: true, resumeLast: false } };
    fs.writeFileSync(record.logFile, "");
    const seeded = run(process.execPath, ["--input-type=module", "-e", `
      import { writeJobFile, upsertJob } from ${JSON.stringify(stateModule)};
      const record = ${JSON.stringify(record)};
      const file = writeJobFile(process.cwd(), record.id, record); upsertJob(process.cwd(), record);
      console.log(JSON.stringify(file));
    `], { cwd: claim.repo, env: claim.env });
    const file = json(seeded), index = path.join(path.dirname(path.dirname(file)), "state.json");
    const preload = path.join(claim.dir, "claim-gate.mjs");
    fs.writeFileSync(preload, `
      import fs from "node:fs";
      import path from "node:path";
      const wait = gate => { while (!fs.existsSync(gate)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20); };
      fs.writeFileSync(path.join(${JSON.stringify(ready)}, String(process.pid)), "");
      wait(${JSON.stringify(start)});
      const rmdir = fs.rmdirSync;
      fs.rmdirSync = function(directory, ...args) {
        const result = rmdir.call(this, directory, ...args);
        if (path.basename(directory) === ".state-lock") {
          const job = fs.readFileSync(${JSON.stringify(file)}, "utf8"), current = JSON.parse(job);
          if (current.status === "queued" && current.executionClaim?.pid === process.pid) {
            fs.writeFileSync(path.join(${JSON.stringify(claimed)}, String(process.pid)),
              JSON.stringify({ job, index: fs.readFileSync(${JSON.stringify(index)}, "utf8") }));
            wait(${JSON.stringify(release)});
          }
        }
        return result;
      };
    `);
    const workers = Array.from({ length: 2 }, () => {
      const child = spawnOwned(process.execPath, ["--import", preload, script, "task-worker", "--cwd", claim.repo, "--job-id", id],
        { cwd: claim.repo, env: claim.env, stdio: ["ignore", "ignore", "pipe"] });
      const worker = { child, done: null, result: null, stderr: "" };
      child.stderr.on("data", data => { worker.stderr += data; });
      worker.done = new Promise(resolve => child.once("close", (code, signal) => { worker.result = { code, signal }; resolve(worker.result); }));
      return worker;
    });
    try {
      await waitUntil(() => fs.readdirSync(ready).length === 2);
      fs.writeFileSync(start, "");
      await waitUntil(() => fs.readdirSync(claimed).length && workers.some(worker => worker.result));
      assert.equal(fs.readdirSync(claimed).length, 1);
      const winnerPid = Number(fs.readdirSync(claimed)[0]);
      const before = JSON.parse(fs.readFileSync(path.join(claimed, String(winnerPid)), "utf8"));
      const loser = workers.find(worker => worker.child.pid !== winnerPid);
      assert.deepEqual(await loser.done, { code: 0, signal: null }, loser.stderr);
      assert.equal(fs.readFileSync(file, "utf8"), before.job);
      assert.equal(fs.readFileSync(index, "utf8"), before.index);
      assert.equal(fs.readFileSync(record.logFile, "utf8").split("\n").filter(Boolean).length, 1);
      assert.equal(fs.existsSync(path.join(claim.dir, "fake-codex-state.json")), false);
      const held = JSON.parse(before.job);
      assert.equal(held.pid, winnerPid);
      assert.equal(held.executionClaim.pid, winnerPid);
      assert.ok(Number.isFinite(Date.parse(held.executionClaim.at)));
      fs.writeFileSync(release, "");
      assert.deepEqual(await workers.find(worker => worker.child.pid === winnerPid).done, { code: 0, signal: null });
      assert.equal(JSON.parse(fs.readFileSync(file)).status, "completed");
      assert.equal(claim.requests().filter(request => request.method === "turn/start").length, 1);
      // Even after the claimant exits, a completed job cannot be replayed.
      const completed = fs.readFileSync(file, "utf8"), completedIndex = fs.readFileSync(index, "utf8");
      assert.equal(claim.call("task-worker", "--job-id", id).status, 0);
      assert.equal(fs.readFileSync(file, "utf8"), completed);
      assert.equal(fs.readFileSync(index, "utf8"), completedIndex);
      assert.equal(claim.requests().filter(request => request.method === "turn/start").length, 1);
    } finally {
      fs.writeFileSync(start, ""); fs.writeFileSync(release, "");
      for (const worker of workers) if (worker.child.exitCode === null) worker.child.kill("SIGTERM");
      await Promise.all(workers.map(worker => worker.done));
    }
  }
});

test("parent question and stdin answer continue the same turn; reports do not log answer text", () => {
  const f = fixture("parent-question-sequence"), launch = json(f.call("task", "--detached", "--json", "--question-timeout-sec", "1", "ask fixture question"));
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

  // An abandoned bridge's question is invisible once expired, then reclaimed
  // by admission. Its delayed finally must leave the replacement approval alone.
  const { progressSnapshot } = await import('../plugins/codex/scripts/lib/job-runtime.mjs');
  updateJob(cwd, id, () => ({ status: "running" }));
  const abandoned = askParentQuestion(cwd, id, { question: "Bridge question?", callId: "abandoned-call" });
  const expired = readJobFile(resolveJobFile(cwd, id)).pendingQuestion;
  now = expired.expiresAt;
  const snapshot = progressSnapshot(readJobFile(resolveJobFile(cwd, id)));
  assert.equal(snapshot.status, "running"); assert.equal(snapshot.phase, "running");
  assert.equal(snapshot.question, undefined);
  assert.throws(() => answerQuestion(cwd, id, expired.id, "Too late", "owner"));
  const replacement = askParentQuestion(cwd, id, { question: "Approve replacement?", kind: "approval" });
  const admitted = readJobFile(resolveJobFile(cwd, id)).pendingQuestion;
  assert.notEqual(admitted.id, expired.id);
  assert.equal((await abandoned).resolution, "timeout");
  const preserved = readJobFile(resolveJobFile(cwd, id));
  assert.deepEqual(preserved.pendingQuestion, admitted); assert.equal(preserved.phase, "needs_answer");
  assert.deepEqual(preserved.questionHistory.filter(entry => entry.id === expired.id).map(entry => entry.resolution), ["expired"]);
  assert.equal((await askParentQuestion(cwd, id, { question: "Competing question?" })).resolution, "busy");
  assert.deepEqual(readJobFile(resolveJobFile(cwd, id)).pendingQuestion, admitted);
  answerQuestion(cwd, id, admitted.id, "deny", "owner");
  assert.equal((await replacement).resolution, "answered");
  const resolved = readJobFile(resolveJobFile(cwd, id));
  assert.equal(resolved.pendingQuestion, null); assert.equal(resolved.phase, "running");
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
  // cli-1: polling more slowly than the lease still keeps the selected owner alive.
  const held = fixture("w5-working");
  const active = json(held.call("task", "--detached", "--json", "--lease-sec", "1", "fixture"));
  try {
    await waitUntil(() => storedJob(held, active.jobId).turnId);
    const status = json(held.call("status", active.jobId, "--owner", active.ownerId, "--wait", "--timeout-ms", "2500", "--poll-interval-ms", "2500", "--json"));
    assert.equal(status.job.status, "running");
    assert.equal(job(held, active.jobId).status, "running");
    assert.equal(job(held, active.jobId).interruptionReason ?? null, null);
  } finally {
    assert.equal(json(held.call("cancel", active.jobId, "--json")).confirmation, "confirmed");
  }
  assert.equal(job(held, active.jobId).status, "cancelled");
  const f = fixture(), launch = json(f.call("task", "--detached", "--json", "--lease-sec", "180", "--owner", "fixture-owner", "fixture"));
  await waitUntil(() => storedJob(f, launch.jobId).turnId);
  patchJob(f, launch.jobId, { leaseExpiresAt: Date.now() - 1 });
  await waitUntil(() => storedJob(f, launch.jobId).status === "interrupted");
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

test("cancel or parent exit interrupts foreground work without killing a saved PID", async () => {
  for (const [command, reason, scenario] of [["review", "cancelled_by_user"], ["review", "parent_exit"], ["task", "parent_exit"],
    ["task", "parent_exit", "startup"], ["task", "parent_exit", "closed-stderr"]]) {
    const f = fixture(command === "review" ? "w5-review" : "w5-working");
    const probing = path.join(f.dir, "probing"), release = path.join(f.dir, "release-probe");
    if (scenario === "startup") {
      const binary = path.join(f.dir, "codex"), anchor = 'const fs = require("node:fs");';
      const source = fs.readFileSync(binary, "utf8");
      assert.ok(source.includes(anchor));
      fs.writeFileSync(binary, source.replace(anchor, `${anchor}
        if (process.argv.includes('--version') && !fs.existsSync(${JSON.stringify(release)})) {
          fs.writeFileSync(${JSON.stringify(probing)}, 'ready');
          while (!fs.existsSync(${JSON.stringify(release)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        }
      `));
    }
    if (command === "task") json(run(process.execPath, [script, "journal", "start", "--json"], {
      cwd: f.repo, env: f.env, input: JSON.stringify({ goal: "Persist foreground interruption", criteria: [] })
    }));
    const args = command === "review" ? ["review", "--scope", "working-tree", "--json"] : ["task", "--fresh", "--json", "fixture"];
    const processModule = new URL("../plugins/codex/scripts/lib/process.mjs", import.meta.url).href;
    const parent = spawnOwned(process.execPath, ["--input-type=module", "-e", `
      import { spawnOwned } from ${JSON.stringify(processModule)};
      const child = spawnOwned(process.execPath, ${JSON.stringify([script, ...args])}, { stdio: ['ignore', 'ignore', 2] });
      child.on('exit', code => { process.exitCode = code; });
    `], { cwd: f.repo, env: f.env, stdio: ["ignore", "ignore", "pipe"] });
    const parentExit = new Promise(resolve => parent.once("exit", resolve));
    let stderr = ""; parent.stderr.on("data", chunk => { stderr += chunk; });
    const id = await waitUntil(() => /Job handle: ([^;]+);/.exec(stderr)?.[1]);
    const read = () => readJobFile(path.join(resolveStateDir(f.repo, f.env), "jobs", `${id}.json`));
    if (scenario === "startup") await until(() => fs.existsSync(probing));
    const initial = scenario === "startup" ? read() : await until(() => { const current = read(); return current.turnId && current; });
    assert.equal(initial.status, "running");
    if (command === "task" && scenario !== "startup") await until(() => read().leaseRenewedAt > initial.leaseRenewedAt);
    if (scenario === "closed-stderr") {
      const closed = new Promise(resolve => parent.stderr.once("close", resolve));
      parent.stderr.destroy();
      await closed;
    }
    if (reason === "parent_exit") {
      parent.kill("SIGKILL");
      await parentExit;
      if (scenario === "startup") fs.writeFileSync(release, "go");
    }
    else {
      const cancelled = json(f.call("cancel", id, "--json"));
      assert.equal(cancelled.confirmation, "confirmed");
    }
    await until(() => !alive(initial.pid) && !alive(parent.pid));
    const stopped = read();
    assert.equal(stopped.status, reason === "parent_exit" ? "interrupted" : "cancelled");
    assert.equal(stopped.result.interruptionReason, reason);
    assert.equal(stopped.result.interruptionConfirmed, scenario !== "startup");
    if (scenario === "startup") {
      assert.ok(!stopped.turnId);
      const requests = fs.existsSync(path.join(f.dir, "fake-codex-state.json.requests.jsonl")) ? f.requests() : [];
      assert.ok(!requests.some(request => ["thread/start", "thread/resume", "turn/start"].includes(request.method)), "parent loss during availability must not dispatch a turn");
    } else assert.equal(f.state().lastInterrupt.turnId, initial.turnId);
    if (command === "task") {
      const runDir = path.join(stopped.runStateDir, "runs", stopped.runId);
      const finishes = fs.readFileSync(path.join(runDir, "journal.jsonl"), "utf8").trim().split("\n").map(JSON.parse).filter(event => event.type === "job_finished");
      assert.equal(finishes.length, 1, "finalize the journal before any result query can recover the job");
      assert.equal(finishes[0].status, "interrupted");
      assert.equal(JSON.parse(fs.readFileSync(path.join(runDir, finishes[0].report), "utf8")).interruptionReason, reason);
    }
    const details = json(f.call("result", id, "--details"), 1);
    assert.equal(details.status, stopped.status);
    assert.equal(details.interruptionReason, reason);
    if (command === "task") {
      // Both real processes have exited; the subsequent details query must not
      // renew the stopped worker's lease either.
      assert.equal(read().leaseRenewedAt, stopped.leaseRenewedAt);
      assert.equal(read().leaseExpiresAt, stopped.leaseExpiresAt);
    }
  }
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
  assert.equal(message.text.length, message.body.replace(/\s+/g, " ").trim().length);
  assert.equal(itemActivity({ type: "agentMessage", text: "x".repeat(1000) }, "completed", starts, "m")[0].text.length, 600);
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

  // Real app-server FileUpdateChange: add has { type: "add" } and its
  // full content in diff. Leading +/- are content, not patch markers.
  const newFiles = ["one\ntwo\n", "one\ntwo", "", "\n", "+++content\n---content\nplain\n"];
  const additions = itemActivity({ type: "fileChange", status: "completed", changes: newFiles.map((diff, index) => ({
    path: `new-${index}.mjs`, kind: { type: "add" }, diff
  })) }, "completed", starts, "real-files");
  assert.deepEqual(additions.map(event => event.added), [2, 2, 0, 1, 3]);
  assert.ok(additions.every(event => event.kind === "add" && !Object.hasOwn(event, "diff")));
  for (const event of additions) {
    const counts = /\+(\d+) [−-](\d+)$/.exec(formatActivity({ ...event, seq: 1 }));
    assert.deepEqual(counts?.slice(1).map(Number), [event.added, 0]);
  }
  const counted = itemActivity({ type: "fileChange", changes: [
    { path: "unknown", kind: { type: "update", move_path: null }, diff: "opaque payload" },
    { path: "empty", kind: { type: "update", move_path: null }, diff: "" },
    { path: "markers", kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@\n---content\n+++content\n" },
    { path: "unknown-add", kind: { type: "add" } }
  ] }, "completed", starts, "other-files");
  assert.deepEqual(counted.map(({ added, removed }) => [added, removed]), [[undefined, undefined], [0, 0], [1, 1], [undefined, undefined]]);

  assert.equal(itemActivity({ type: "commandExecution", command: 'FOO="first\nsecond-line" node script\nPRIVATE_BODY' }, "completed", starts, "c")[0].command, 'FOO="first…', "omitted command lines are marked incomplete");
  for (const command of ['cat input\ntouch output', 'cat input\n> output',
    "/bin/sh -c 'cat " + 'x'.repeat(155) + " && touch output'"]) {
    const event = itemActivity({ type: "commandExecution", command, status: "completed", exitCode: 0 }, "completed", starts, "incomplete")[0];
    assert.ok(event.command.endsWith('…'));
    assert.ok(event.command.length <= 160);
    assert.match(formatActivity({ ...event, seq: 1 }), /…\) · Done$/);
  }
  for (const command of ['X="$(touch output)" cat input', 'X=`touch output` cat input',
    'X=${Y:=value} cat input', 'X=$VALUE cat input']) {
    const event = itemActivity({ type: "commandExecution", command, status: "completed", exitCode: 0 }, "completed", starts, "expansion")[0];
    assert.equal(event.command, command);
    assert.ok(formatActivity({ ...event, seq: 1 }).includes(command));
  }
  assert.equal(itemActivity({ type: "commandExecution", command: 'cat input\n  \n' }, "completed", starts, "blank")[0].command, 'cat input');
  for (const status of ['failed', 'declined', 'cancelled', 'interrupted', 'error', 'unknown', undefined, 'completed']) {
    const event = itemActivity({ type: "fileChange", status, changes: [{ path: 'new-file', kind: { type: 'add' }, diff: 'one\ntwo\n' }] }, "completed", starts, "outcome")[0];
    assert.equal(event.status, status ?? 'unknown');
    const result = formatActivity({ ...event, seq: 1 }).split(' · ').at(-1);
    assert.equal(/\+\d+ [−-]\d+$/.test(result), status === 'completed');
    assert.equal(/^Error:/.test(result), !['completed', 'unknown', undefined].includes(status));
  }

  // Display cleanup runs before the existing cap without changing protocol
  // commands used as verification evidence or dropping the stored wrapper.
  const useful = "node --test x";
  const prefixed = "env -u A -u B X=1 Y='" + "prefix ".repeat(40) + "' " + useful;
  const wrapped = "/bin/zsh -lc '" + prefixed.replace(/'/g, "'\"'\"'") + "'";
  const original = { type: "commandExecution", command: wrapped, status: "completed", exitCode: 0 };
  const captured = itemActivity(original, "completed", starts, "wrapped")[0];
  assert.equal(captured.command, "/bin/zsh -lc '" + useful + "'");
  assert.equal(original.command, wrapped);
  const evidence = directReport(buildWorkerReport({ status: 0, commandExecutions: [original] }), {
    result: { commandExecutions: [original], structured: { verification: ["claimed fixture check"] } }
  });
  assert.ok(evidence.checks.ran[0].startsWith("/bin/zsh -lc 'env -u A -u B X=1 Y="));
  assert.deepEqual(evidence.checks.claimed, ["claimed fixture check"]);
  const escaped = String.raw`/bin/sh -c "LABEL=\"a b\" printf ok"`;
  const commented = ["env -i # inspect empty environment", "FOO=1 #comment"];
  for (const command of [escaped, ...commented]) {
    const event = itemActivity({ type: "commandExecution", command }, "completed", starts, "unchanged")[0];
    assert.equal(event.command, command);
  }
  for (const [command, expected] of [
    [prefixed, useful], [wrapped, useful],
    [escaped, String.raw`LABEL=\"a b\" printf ok`], ...commented.map(command => [command, command]),
    ['/bin/sh -c "X=1 node --test x"', useful],
    ["env -u A -u B X=1 Y='a b' node --test x", useful],
    ['env -i X="a b" Y=plain node --test x', useful],
    ['X="a b" node --test x', useful],
    ["FOO=1", "FOO=1"], ["env -i FOO=1", "env -i FOO=1"], ["npm run env", "npm run env"],
    ["FOO=1; echo keep", "FOO=1; echo keep"],
    ["env --unknown X=1 node x", "env --unknown X=1 node x"],
    ["env X=1 node; echo done", "node; echo done"],
    ["env X=1 node x; env Y=2 node y", "node x; env Y=2 node y"],
    // Folding treats the excerpt as the whole call: keep assignments that can
    // run code before a foldable program or shell, quoted or not.
    ["BASH_ENV=./hook /bin/bash -c 'cat input'", "BASH_ENV=./hook /bin/bash -c 'cat input'"],
    ["GIT_EXTERNAL_DIFF=./tool 'git' diff", "GIT_EXTERNAL_DIFF=./tool 'git' diff"],
    ["env LC_ALL=C npm_config_offline=true rg -n x", "rg -n x"],
    ["env 'X=./cat' /usr/bin/touch out", "env 'X=./cat' /usr/bin/touch out"]
  ]) {
    const line = formatActivity({ seq: 7, type: "commandExecution", command, exitCode: 0 });
    const fields = /^\[(\d+)\] Bash\((.*)\) · (.*)$/.exec(line);
    assert.ok(fields, line);
    assert.deepEqual(fields.slice(1), ["7", expected, "Done"]);
  }
  for (const [status, exitCode, expected] of [
    ["completed", 0, "Done"], ["failed", 9, "Error: exit 9"], ["failed", 0, "Error: exit 0"],
    ["completed", null, "exit unknown"], ["inProgress", null, "running"],
    ...["cancelled", "declined", "interrupted"].map(status => [status, null, status])
  ]) {
    const line = formatActivity({ seq: 8, type: "commandExecution", command: useful, status, exitCode });
    assert.equal(line.split(" · ").at(-1), expected);
  }
  const failed = formatActivity({ seq: 123456, type: "commandExecution", command: "node " + "x".repeat(300),
    status: "failed", exitCode: 123456, durationMs: 857600 });
  assert.ok(failed.length <= 200);
  assert.match(failed, / · Error: exit 123456(?: \([^)]*\))?$/);
  for (const [root, file, expected] of [
    ["/repo", "/repo/src/x.mjs", "src/x.mjs"], ["/repo/", "/repo/src/../x.mjs", "x.mjs"],
    ["/repo", "/repo-other/x.mjs", "/repo-other/x.mjs"],
    ["/repo", "/repo/../outside/x.mjs", "/repo/../outside/x.mjs"],
    ["C:\\Repo", "c:\\repo\\src\\x.mjs", "src/x.mjs"],
    ["C:\\Repo", "D:\\Repo\\x.mjs", "D:\\Repo\\x.mjs"],
    ["\\\\server\\share\\repo", "\\\\SERVER\\SHARE\\repo\\src\\x.mjs", "src/x.mjs"],
    [undefined, "/repo/src/x.mjs", "/repo/src/x.mjs"]
  ]) {
    for (const [kind, action] of [["add", "Write"], ["update", "Update"], ["delete", "Delete"]]) {
      const line = formatActivity({ seq: 9, type: "fileChange", status: "completed", path: file, kind, added: 23, removed: 0 }, { root });
      const fields = /^\[(\d+)\] (\w+)\((.*)\) · \+(\d+) −(\d+)$/.exec(line);
      assert.ok(fields, line);
      assert.deepEqual(fields.slice(1), ["9", action, expected, "23", "0"]);
    }
  }
  for (const [type, name] of [["mcpToolCall", "fixture - inspect (MCP)"], ["dynamicToolCall", "inspect"]]) {
    for (const [status, result] of [["completed", "Done"], ["failed", "Error"], ["inProgress", "running"]]) {
      const line = formatActivity({ seq: 10, type, server: "fixture", tool: "inspect", status });
      assert.deepEqual(line.slice(5).split(" · "), [name, result]);
    }
  }
  assert.deepEqual(formatActivity({ seq: 11, type: "plan", steps: ["Inspect", "Verify"], statuses: ["completed", "inProgress"] })
    .slice(5).split(" · "), ["Update Todos", "1/2", "Verify"]);
});

test("wait persists independent owner and observer activity cursors", () => {
  const cwd = makeTempDir(), id = "cursor-job";
  initGitRepo(cwd); fs.mkdirSync(path.join(cwd, "sub"));
  const activity = [
    { type: "fileChange", path: path.join(cwd, "sub", "inside.mjs"), kind: "update", added: 1, removed: 0 },
    { type: "fileChange", path: path.join(cwd, "outside.mjs"), kind: "add", added: 1, removed: 0 },
    { type: "fileChange", path: "relative.mjs", kind: "delete", added: 0, removed: 1 },
    { type: "commandExecution", command: "node " + "x".repeat(300), status: "failed", exitCode: 17 },
    ...itemActivity({ type: "agentMessage", text: "x".repeat(800) }, "completed", new Map(), "long-message")
  ].map((event, i) => ({ ...event, seq: i + 1 }));
  const record = { id, workspaceRoot: cwd, request: { cwd: path.join(cwd, "sub") }, jobClass: "task", status: "completed", activity, activitySeq: activity.length,
    result: { status: 0, rawOutput: "fixture-output" } };
  writeJobFile(cwd, id, record); upsertJob(cwd, record);
  const read = (...extra) => json(run(process.execPath, [script, "wait", id, "--json", ...extra], { cwd }));
  const first = read("--owner", "reader-a");
  assert.equal(first.activityCount, activity.length);
  assert.equal(read("--owner", "reader-a").activityCount, 0);
  assert.equal(read("--owner", "reader-b").activityCount, activity.length);
  assert.equal(read().activityCount, activity.length);
  const stored = readJobFile(resolveJobFile(cwd, id));
  for (const owner of ["reader-a", "reader-b", undefined]) assert.equal(stored.activityCursors[activityReader(owner)], activity.length);

  for (const requested of [true, false]) {
    if (!requested) updateJob(cwd, id, () => ({ request: {} }));
    for (const mode of ["direct", "follow"]) {
      const response = run(process.execPath, [script, "wait", id, "--owner", `${mode}-${requested}`,
        ...(mode === "direct" ? ["--direct"] : [])], { cwd });
      assert.equal(response.status, 0, response.stderr);
      const output = response.stdout.trimEnd().split("\n");
      // Retain the shared 200-character assertion for every other event.
      if (mode === "direct") directLines(output.filter(line => !/^\[\d+\] Codex: /.test(line)).join("\n") + "\n");
      const lines = output.filter(line => /^\[\d+\] /.test(line));
      assert.equal(lines.length, activity.length);
      assert.deepEqual(lines.slice(0, 3).map(line => /^\[\d+\] \w+\((.*)\) ·/.exec(line)?.[1]),
        requested ? ["inside.mjs", path.join(cwd, "outside.mjs"), "relative.mjs"]
          : ["sub/inside.mjs", "outside.mjs", "relative.mjs"]);
      assert.match(lines[3], / · Error: exit 17$/);
      assert.equal(lines[4].replace(/^\[\d+\] Codex: /, "").length, 600);
      assert.doesNotMatch(lines[4], /[\x00-\x1f\x7f-\x9f]/);
      assert.ok(lines[3].length <= 200);
    }
  }
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
  const refused = direct(f.call("task", "--thread", first.threadId, "--direct", "follow-up"), 2);
  const ownerReport = json(f.call("result", first.jobId));
  const blocker = refused.blockers.find(blocker => blocker.code === "thread_busy");
  assert.equal(refused.next, ownerReport.next);
  for (const key of ["id", "kind", "text", "options"]) assert.deepEqual(blocker.question[key], ownerReport.question[key]);
  assert.ok(Number.isInteger(blocker.question.expiresInSec));
  assert.equal(refused.details.includes(refused.jobId), true);
  for (const directMode of [false, true]) {
    const rejected = run(process.execPath, [script, "answer", first.jobId, "--owner", "unrelated-owner", "--question", pending.question.id,
      ...(directMode ? ["--direct", "--quiet"] : ["--json"])], { cwd: f.repo, env: f.env, input: "Do not deliver" });
    assert.equal(rejected.status, 1);
    assert.equal(job(f, first.jobId).pendingQuestion.answer, undefined);
  }
  const guardedCwd = makeTempDir();
  for (const stopping of [false, true]) {
    const guarded = { id: `guarded-answer-${stopping}`, jobClass: "task", status: "running", workspaceRoot: guardedCwd, pid: process.pid,
      ownerId: "owner", leaseExpiresAt: stopping ? Date.now() + 60000 : Date.now() - 1,
      ...(stopping ? { cancelRequested: { reason: "cancelled_by_user" } } : {}),
      pendingQuestion: { id: "question", text: "Choose?", options: [], expiresAt: Date.now() + 60000 } };
    writeJobFile(guardedCwd, guarded.id, guarded); upsertJob(guardedCwd, guarded);
    for (const directMode of [false, true]) {
      const rejected = run(process.execPath, [script, "answer", guarded.id, "--owner", guarded.ownerId, "--question", "question",
        ...(directMode ? ["--direct", "--quiet"] : ["--json"])], { cwd: guardedCwd, input: "Do not deliver" });
      assert.equal(rejected.status, 1);
      assert.equal(readJobFile(resolveJobFile(guardedCwd, guarded.id)).pendingQuestion.answer, undefined);
    }
  }
  const oldWait = spawnOwned(process.execPath, [script, "wait", first.jobId, "--owner", first.ownerId, "--after-question", pending.question.id, "--timeout-sec", "30", "--json"], { cwd: f.repo, env: f.env, stdio: ["ignore", "pipe", "pipe"] });
  let oldOutput = ""; oldWait.stdout.on("data", chunk => { oldOutput += chunk; });
  const oldDone = new Promise((resolve, reject) => { oldWait.on("close", resolve); oldWait.on("error", reject); });
  await waitUntil(() => storedJob(f, first.jobId).ownerAttached);
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

  // delta-1: exercise the status timer itself in both wake orderings. The
  // expired renewal stays refused until the worker adjusts its lease.
  for (const order of ["status-first", "worker-first"]) {
    const f = fixture(), preload = path.join(f.dir, "status-wake.mjs");
    const stateModule = new URL("../plugins/codex/scripts/lib/state.mjs", import.meta.url).href;
    const runtimeModule = new URL("../plugins/codex/scripts/lib/job-runtime.mjs", import.meta.url).href;
    fs.writeFileSync(preload, `
      import { updateJob, writeJobFile, upsertJob } from ${JSON.stringify(stateModule)};
      import { pauseAdjustment, JobRuntime } from ${JSON.stringify(runtimeModule)};
      const cwd = process.cwd(), id = 'status-wake', realNow = Date.now, timeout = globalThis.setTimeout;
      let offset = 0, renewals = 0, runtime, control;
      Date.now = () => realNow() + offset;
      const record = { id, jobClass: 'task', status: 'running', workspaceRoot: cwd, pid: process.pid,
        ownerId: 'owner', leaseSec: 3, leaseExpiresAt: Date.now() + 3000, leaseRenewedAt: Date.now() };
      writeJobFile(cwd, id, record); upsertJob(cwd, record);
      globalThis.setTimeout = (fn, ms, ...args) => {
        if (!String(fn).includes('scheduleRenewal(renewLease')) return timeout(fn, ms, ...args);
        return timeout(() => {
          if (++renewals !== 1) { fn(); return; }
          offset += 10000;
          const shift = () => updateJob(cwd, id, current => pauseAdjustment(current, 10000, Date.now()));
          if (${JSON.stringify(order)} === 'worker-first') shift();
          fn();
          if (${JSON.stringify(order)} === 'status-first') shift();
          runtime = new JobRuntime(cwd, id);
          runtime.abort.signal.addEventListener('abort', () => {
            updateJob(cwd, id, () => ({ status: 'interrupted' }));
            clearTimeout(control); runtime.close();
          });
          control = timeout(() => {
            updateJob(cwd, id, () => ({ status: 'completed', result: { status: 0, turnEnded: true } })); runtime.close();
          }, 4000);
        }, ms, ...args);
      };
      process.on('exit', () => runtime?.close());
    `);
    const status = json(run(process.execPath, ["--import", preload, script, "status", "status-wake", "--owner", "owner", "--wait",
      "--timeout-ms", "30000", "--poll-interval-ms", "100", "--json"], { cwd: f.repo, env: f.env }));
    assert.equal(status.job.status, "completed"); assert.equal(status.waitTimedOut, false);
    assert.equal(status.job.cancelRequested, undefined);
  }
});

test("runtime-2: heartbeat and notification diagnostics cannot crash a tracked turn", () => {
  const f = fixture("slow-recovery-task");
  const gate = path.join(f.dir, "heartbeat-observed");
  f.env.CODEX_FIXTURE_TURN_GATE = gate;
  const result = run(process.execPath, ["--input-type=module", "-e", `
    import fs from 'node:fs';
    import { runTrackedJob, createProgressReporter, createJobProgressUpdater } from ${JSON.stringify(new URL("../plugins/codex/scripts/lib/tracked-jobs.mjs", import.meta.url).href)};
    import { runAppServerTurn, runAppServerReview } from ${JSON.stringify(new URL("../plugins/codex/scripts/lib/codex.mjs", import.meta.url).href)};
    import { resolveJobFile } from ${JSON.stringify(new URL("../plugins/codex/scripts/lib/state.mjs", import.meta.url).href)};
    setTimeout(() => process.exit(42), 15000).unref();
    const job = { id: 'progress-fault', jobClass: 'task', workspaceRoot: process.cwd(), logFile: ${JSON.stringify(path.join(f.dir, "progress.log"))} };
    const append = fs.appendFileSync, write = fs.writeSync, rename = fs.renameSync;
    let heartbeatFailures = 0, callbackFailures = 0, notificationFailures = 0, logFailures = 0, warnings = 0;
    let failedHandle = null, persistedHandle = null;
    const failure = Object.assign(new Error('injected optional diagnostic failure'), { code: 'EIO' });
    fs.appendFileSync = function(file, value, ...args) {
      if (file === job.logFile && String(value).includes('Progress: thread=')) { heartbeatFailures++; throw failure; }
      return append.call(this, file, value, ...args);
    };
    fs.writeSync = function(fd, ...args) { if (fd === 2) warnings++; return write.call(this, fd, ...args); };
    const jobFile = resolveJobFile(process.cwd(), job.id);
    fs.renameSync = function(source, target) {
      const record = target === jobFile ? JSON.parse(fs.readFileSync(source, 'utf8')) : null;
      if (!failedHandle && record?.threadId) { failedHandle = record.threadId; throw failure; }
      const result = rename.call(this, source, target);
      if (record?.status === 'running' && record.threadId === failedHandle) persistedHandle = record.threadId;
      return result;
    };
    const report = createProgressReporter({ logFile: job.logFile, onEvent: createJobProgressUpdater(process.cwd(), job.id) });
    const execution = await runTrackedJob(job, async () => {
      const payload = await runAppServerTurn(process.cwd(), { prompt: 'fixture', persistThread: true, onProgress: event => {
        report(event);
        if (typeof event === 'string' && event.startsWith('Progress: thread=')) {
          callbackFailures++; fs.writeFileSync(${JSON.stringify(gate)}, 'observed'); throw failure;
        }
        if (event?.activity?.length) { notificationFailures++; throw failure; }
      } });
      return { exitStatus: payload.status, payload, threadId: payload.threadId, turnId: payload.turnId, summary: 'done', rendered: 'done' };
    });
    const review = await runAppServerReview(process.cwd(), { target: { type: 'uncommittedChanges' }, onProgress: event => {
      if (event?.logBody) { logFailures++; throw failure; }
    } });
    console.log(JSON.stringify({ status: execution.exitStatus, turnEnded: execution.payload.turnEnded, reviewStatus: review.status, heartbeatFailures, callbackFailures, notificationFailures, logFailures, warnings, failedHandle, persistedHandle }));
  `], { cwd: f.repo, env: { ...f.env, CODEX_COMPANION_PROGRESS_INTERVAL_MS: "250", CODEX_COMPANION_APP_SERVER_ENDPOINT: `unix:${path.join(f.dir, "missing")}` } });
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(result.stdout);
  assert.equal(observed.status, 0);
  assert.equal(observed.turnEnded, true);
  assert.equal(observed.reviewStatus, 0);
  for (const key of ["heartbeatFailures", "callbackFailures", "notificationFailures", "logFailures"]) assert.ok(observed[key] > 0, key);
  assert.equal(observed.warnings, 1);
  assert.ok(observed.failedHandle && observed.persistedHandle === observed.failedHandle);
  assert.equal(job(f, "progress-fault").status, "completed");
  assert.ok(f.state().launches.every(entry => !alive(entry.pid)));
});

test("runtime-3: final log failures preserve committed outcomes and required result writes still fail", () => {
  const f = fixture();
  const result = run(process.execPath, ["--input-type=module", "-e", `
    import fs from 'node:fs';
    import { runTrackedJob } from ${JSON.stringify(new URL("../plugins/codex/scripts/lib/tracked-jobs.mjs", import.meta.url).href)};
    const append = fs.appendFileSync, write = fs.writeFileSync;
    const failure = Object.assign(new Error('injected write failure'), { code: 'EIO' });
    const outcomes = [];
    for (const mode of ['task', 'review', 'required-result']) {
      const job = { id: 'final-' + mode, jobClass: mode === 'task' ? 'task' : 'review', workspaceRoot: process.cwd(),
        logFile: ${JSON.stringify(path.join(f.dir, "final.log"))},
        rawOutputFile: ${JSON.stringify(path.join(f.dir, "raw-"))} + mode,
        resultFile: ${JSON.stringify(path.join(f.dir, "result-"))} + mode };
      let failures = 0;
      fs.appendFileSync = function(file, ...args) {
        if (file === job.logFile) { failures++; throw failure; }
        return append.call(this, file, ...args);
      };
      fs.writeFileSync = function(file, ...args) {
        if (mode === 'required-result' && file === job.resultFile && failures === 0) { failures++; throw failure; }
        return write.call(this, file, ...args);
      };
      const execution = { exitStatus: 0, jobStatus: 'completed', payload: { status: 0, turnEnded: true, rawOutput: 'done' }, report: { status: 'completed' }, summary: 'done', rendered: 'done' };
      const outcome = await runTrackedJob(job, async () => execution).then(value => ({ returned: value === execution }), error => ({ rejected: error === failure }));
      outcomes.push({ mode, failures, ...outcome });
    }
    console.log(JSON.stringify(outcomes));
  `], { cwd: f.repo, env: f.env });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [
    { mode: "task", failures: 1, returned: true },
    { mode: "review", failures: 1, returned: true },
    { mode: "required-result", failures: 1, rejected: true }
  ]);
  for (const mode of ["task", "review"]) {
    assert.equal(job(f, `final-${mode}`).status, "completed");
    assert.equal(json(f.call("result", `final-${mode}`, "--details")).status, "completed");
  }
  assert.equal(job(f, "final-required-result").status, "failed");
});

test("runtime stop always aborts despite progress or cancellation persistence failures", async t => {
  let tick;
  t.mock.method(globalThis, "setInterval", callback => { tick = callback; return null; });
  for (const fault of ["progress-log", "progress-state", "requestCancel", "both", "latched-reason", "reentrant"]) {
    const cwd = makeTempDir(), id = `stop-${fault}`;
    writeJobFile(cwd, id, { id, status: "running", ownerAttached: true, leaseExpiresAt: Date.now() + 180000 });
    const file = resolveJobFile(cwd, id), logFile = file.replace(/\.json$/, ".log");
    let progressCalls = 0, persistenceCalls = 0, abortEvents = 0, failedWrites = 0;
    const updater = createJobProgressUpdater(cwd, id);
    const runtime = new JobRuntime(cwd, id, { onProgress: createProgressReporter({ logFile, onEvent: event => {
      progressCalls++;
      if (fault === "progress-state") updater(event);
      if (fault === "reentrant") runtime.stop("owner_state_unavailable");
    } }) });
    runtime.abort.signal.addEventListener("abort", () => { abortEvents++; });
    const append = fs.appendFileSync, rename = fs.renameSync;
    const logWriter = t.mock.method(fs, "appendFileSync", function(target, ...args) {
      if (target === logFile && ["progress-log", "both"].includes(fault)) throw Object.assign(new Error("injected progress failure"), { code: "ENOSPC" });
      return append.call(this, target, ...args);
    });
    const jobWriter = t.mock.method(fs, "renameSync", function(source, target) {
      if (target === file) {
        persistenceCalls++;
        if (["requestCancel", "both"].includes(fault) || (fault === "progress-state" && persistenceCalls > 1)) {
          failedWrites++;
          throw Object.assign(new Error("injected persistence failure"), { code: "EIO" });
        }
      }
      return rename.call(this, source, target);
    });
    try {
      if (fault === "latched-reason") runtime.reason = "cancelled_by_user";
      assert.doesNotThrow(() => runtime.stop("cancelled_by_user"));
      runtime.stop("owner_state_unavailable");
      tick();
      assert.equal(runtime.abort.signal.aborted, true);
      assert.equal(runtime.abort.signal.reason, "cancelled_by_user");
      assert.equal(runtime.reason, "cancelled_by_user");
      assert.equal(abortEvents, 1);
      assert.equal(progressCalls, fault === "latched-reason" ? 0 : 1);
      assert.equal(failedWrites, ["progress-state", "requestCancel", "both"].includes(fault) ? 1 : 0);
    } finally { logWriter.mock.restore(); jobWriter.mock.restore(); runtime.close(); }
  }

  // stress-1: question resolution observes durable cancellation before the
  // next watchdog tick, and terminal publication rechecks intent under lock.
  const cwd = makeTempDir(), id = "cancel-question-commit";
  writeJobFile(cwd, id, { id, status: "running", jobClass: "task", workspaceRoot: cwd });
  const runtime = new JobRuntime(cwd, id);
  try {
    const asking = runtime.question({ params: { arguments: { question: "Choose?" }, callId: "cancel-call" } });
    updateJob(cwd, id, () => ({ cancelRequested: { reason: "cancelled_by_user" } }));
    await asking;
    assert.equal(runtime.reason, "cancelled_by_user");
    assert.equal(runtime.abort.signal.aborted, true);
  } finally { runtime.close(); }
  for (const [reason, outcome] of [[null, "completed"], [null, "failed"], ["cancelled_by_user", "completed"], ["cancelled_by_user", "failed"], ["owner_stopped", "completed"]]) {
    const id = `commit-${reason ?? "none"}-${outcome}`, resultFile = resolveJobFile(cwd, id).replace(/\.json$/, ".result.json");
    const tracked = { id, jobClass: "task", workspaceRoot: cwd, resultFile };
    const execution = await runTrackedJob(tracked, async () => {
      if (reason) updateJob(cwd, id, () => ({ cancelRequested: { reason } }));
      const status = outcome === "completed" ? 0 : 1;
      return { exitStatus: status, jobStatus: outcome, payload: { status, turnEnded: true }, report: { status: outcome }, rendered: "done" };
    });
    const expected = reason === "cancelled_by_user" ? "cancelled" : reason ? "interrupted" : outcome;
    const saved = readJobFile(resolveJobFile(cwd, id));
    assert.equal(saved.status, expected); assert.equal(execution.report.status, expected);
    const cancelled = json(run(process.execPath, [script, "cancel", id, "--cwd", cwd, "--json"]));
    assert.equal(cancelled.status, expected);
    assert.equal(cancelled.turnInterruptAttempted, false); assert.equal(cancelled.turnInterrupted, false);
    if (reason) {
      assert.equal(execution.exitStatus, 1); assert.equal(saved.result.interruptionReason, reason);
      assert.deepEqual(JSON.parse(fs.readFileSync(resultFile)), saved.result);
    } else assert.equal(saved.cancelRequested, undefined);
  }
  const late = fixture("review-ok");
  const committed = json(run(process.execPath, ["--input-type=module", "-e", `
    import { runTrackedJob } from ${JSON.stringify(new URL("../plugins/codex/scripts/lib/tracked-jobs.mjs", import.meta.url).href)};
    import { runAppServerTurn } from ${JSON.stringify(new URL("../plugins/codex/scripts/lib/codex.mjs", import.meta.url).href)};
    import { requestCancel } from ${JSON.stringify(new URL("../plugins/codex/scripts/lib/job-runtime.mjs", import.meta.url).href)};
    const cwd = process.cwd(), executions = [];
    // late-own-stop: the run's own final read already labelled the late stop.
    for (const id of ['late-stop', 'late-own-stop']) executions.push(await runTrackedJob({ id, jobClass: 'task', workspaceRoot: cwd }, async () => {
      const result = await runAppServerTurn(cwd, { prompt: 'fixture', persistThread: true });
      requestCancel(cwd, id);
      const own = id === 'late-own-stop' ? { interruptionReason: 'cancelled_by_user', interruptionConfirmed: result.turnEnded } : {};
      return { exitStatus: own.interruptionReason ? 1 : result.status, jobStatus: own.interruptionReason ? 'cancelled' : 'completed',
        threadId: result.threadId, turnId: result.turnId, payload: { status: result.status, turnEnded: result.turnEnded, ...own }, report: { status: 'completed' } };
    }));
    console.log(JSON.stringify(executions));
  `], { cwd: late.repo, env: late.env }));
  assert.deepEqual(committed.map(execution => execution.jobStatus), ["cancelled", "cancelled"]);
  for (const id of ["late-stop", "late-own-stop"]) {
    const lateCancel = json(late.call("cancel", id, "--json"));
    assert.equal(lateCancel.status, "cancelled"); assert.equal(lateCancel.backgroundTerminals.cleaned, true);
    assert.equal(lateCancel.turnInterruptAttempted, false); assert.equal(lateCancel.turnInterrupted, false);
  }
  assert.equal(late.requests().filter(request => request.method === "turn/interrupt").length, 0);
  assert.equal(late.requests().filter(request => request.method === "thread/backgroundTerminals/clean").length, 2);
});

test("watchdog rechecks stale ownership and lease observations before cancelling or aborting", t => {
  const now = 100000;
  let tick;
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "setInterval", callback => { tick = callback; return null; });
  for (const action of ["adopt", "renew", "reattach", "lease-renewed", "owner-changed", "attachment-changed"]) {
    const cwd = makeTempDir(), id = `watchdog-${action}`;
    const record = { id, jobClass: "task", status: "running", workspaceRoot: cwd, sessionId: "old-session", ownerId: "owner",
      ownerAttached: action !== "reattach", ownerAttachedAt: now - 20000,
      ownerDetachedAt: action === "reattach" ? now - 1000 : null, ownerDetachReason: action === "reattach" ? "signal" : null,
      leaseSec: 180, leaseRenewedAt: now - 10000, leaseExpiresAt: action === "lease-renewed" ? now - 1 : now + 180000 };
    writeJobFile(cwd, id, record); upsertJob(cwd, record);
    const file = resolveJobFile(cwd, id), read = fs.readFileSync;
    let interleaved = false, progressCalls = 0;
    const reader = t.mock.method(fs, "readFileSync", function(target, ...args) {
      const contents = read.call(this, target, ...args);
      if (!interleaved && target === file) {
        interleaved = true;
        if (action === "adopt") assert.equal(adoptJob(cwd, id, "new-session").adopted, true);
        else if (action === "renew") renewLease(cwd, id, record.ownerId);
        else if (action === "reattach") markOwnerAttachment(cwd, id, record.ownerId);
        else if (action === "owner-changed") updateJob(cwd, id, () => ({ ownerId: "replacement" }));
        else if (action === "attachment-changed") updateJob(cwd, id, () => ({ ownerAttachedAt: now }));
        else updateJob(cwd, id, () => ({ leaseRenewedAt: now, leaseExpiresAt: now + 180000 }));
      }
      return contents;
    });
    let runtime;
    try {
      runtime = new JobRuntime(cwd, id, { onProgress: () => { progressCalls++; } });
      assert.equal(interleaved, true);
      assert.equal(readJobFile(file).cancelRequested, undefined);
      assert.equal(runtime.reason, null); assert.equal(runtime.abort.signal.aborted, false); assert.equal(progressCalls, 0);
      // The skipped observation must not latch the runtime: a current trigger
      // on its next tick still cancels and aborts normally.
      updateJob(cwd, id, () => ({ leaseExpiresAt: now - 1 }));
      tick();
      assert.equal(readJobFile(file).cancelRequested.reason, "lease_expired");
      assert.equal(runtime.reason, "lease_expired"); assert.equal(runtime.abort.signal.aborted, true); assert.equal(progressCalls, 1);
    } finally { reader.mock.restore(); runtime?.close(); }
  }
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
  await waitUntil(() => storedJob(f, launch.jobId).ownerAttached && job(f, launch.jobId).turnId);
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
  // Successful live-worker cleanup was checked with the signalled owner above.
  for (const behavior of ["unsupported", "unknown", "failed", "timeout"]) {
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
  const lost = fixture("lost-turn:inProgress");
  const failed = lost.call("task", "--report", "--json", "fixture");
  assert.equal(failed.status, 1);
  const id = /Job handle: ([^;]+)/.exec(failed.stderr)?.[1]; assert.ok(id);
  const original = storedJob(lost, id);
  assert.equal(original.result.turnEnded, false);
  await waitUntil(() => !alive(lost.requests()[0].serverId));
  const restoreLost = await snapshotFixture(lost);
  for (const behavior of ["supported", "unsupported", "unconfirmed"]) {
    restoreLost();
    lost.env.CODEX_FIXTURE_TERMINALS_CLEAN = behavior;
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

test("detached fallback spawn failure throws synchronously without an unhandled error", () => {
  const dir = makeTempDir("failed-detached-spawn-");
  const result = run(process.execPath, ["--input-type=module", "-e", `
    import { spawnDetached } from ${JSON.stringify(new URL('../plugins/codex/scripts/lib/process.mjs', import.meta.url).href)};
    let threw = false;
    try {
      spawnDetached(process.execPath, ['-e', ''], { cwd: ${JSON.stringify(path.join(dir, "missing"))}, stdio: 'ignore' });
    } catch (error) { threw = error instanceof Error; }
    // Allow the failed child's asynchronous error event to fire. A synchronous
    // throw alone must not leave an unhandled event that kills this caller.
    await new Promise(resolve => setTimeout(resolve, 50));
    console.log(JSON.stringify({ threw, survived: true }));
  `], { cwd: dir });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /detached launcher failed; using direct detached spawn/);
  assert.deepEqual(JSON.parse(result.stdout), { threw: true, survived: true });
});

test("automatic inferred-turn recheck reconciles without a command and remains bounded", async t => {
  // The broker intentionally waits four seconds before retiring an abandoned
  // stream with no terminal notification. Recheck after that existing grace.
  const launch = (allowInterrupt, initial = "6000", retry = "7000", holdRead = false) => {
    const f = fixture("inferred-final:running");
    Object.assign(f.env, { CODEX_COMPANION_INFERRED_RECHECK_MS: initial, CODEX_COMPANION_INFERRED_RECHECK_RETRY_MS: retry });
    if (holdRead) {
      const binary = path.join(f.dir, "codex"), source = fs.readFileSync(binary, "utf8"), branch = 'case "thread/read": {';
      assert.ok(source.includes(branch));
      fs.writeFileSync(binary, source.replace(branch, `${branch}
        if (fs.existsSync(STATE_PATH + '.hold-read')) {
          fs.writeFileSync(STATE_PATH + '.read-held', '');
          while (!fs.existsSync(STATE_PATH + '.release-read')) await new Promise(resolve => setTimeout(resolve, 20));
        }
      `));
    }
    assert.equal(run(process.execPath, [path.join(f.dir, "codex"), "app-server"], { cwd: f.repo, env: f.env, input: "" }).status, 0);
    fs.writeFileSync(path.join(f.dir, "fake-codex-state.json"), JSON.stringify({ ...f.state(), allowInterrupt }));
    const first = direct(f.call("task", "--fresh", "--direct", "--quiet", "fixture"));
    const original = storedJob(f, first.jobId);
    assert.equal(original.result.inferredCompletion, true);
    assert.equal(original.result.turnEnded, false, "report returns before reconciliation");
    return { f, original };
  };
  const helper = (f, id) => f.call("inferred-turn-recheck", id, "--cwd", f.repo);
  const quiet = result => { assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, ""); assert.equal(result.stderr, ""); };
  const reads = f => f.requests().filter(request => request.method === "thread/read");
  const bytes = (f, id) => {
    const record = storedJob(f, id);
    return [path.join(resolveStateDir(f.repo, f.env), "jobs", `${id}.json`), path.join(resolveStateDir(f.repo, f.env), "state.json"),
      record.rawOutputFile, record.resultFile, record.logFile].map(file => [fs.readFileSync(file, "utf8"), fs.statSync(file).mtimeMs]);
  };

  await t.test("broker interruption after the answer is recovered automatically; duplicates do nothing", async () => {
    const { f, original } = launch(true);
    // Only observe files from here through recovery: no status, wait, result,
    // maintenance or follow-up command can perform the reconciliation for us.
    const resolved = await until(() => {
      const current = storedJob(f, original.id);
      return current.recovery?.status === "recovered" && current;
    }, 12000);
    assert.equal(resolved.status, "completed");
    assert.equal(resolved.result.turnEnded, true);
    assert.equal(resolved.recovery.turnStatus, "interrupted");
    assert.deepEqual([resolved.recovery.threadId, resolved.recovery.turnId], [original.threadId, original.turnId]);
    assert.match(resolved.recovery.detail, /after the final answer.*no stop was requested/);
    assert.equal(resolved.result.rawOutput, original.result.rawOutput);
    assert.equal(JSON.parse(fs.readFileSync(resolved.resultFile)).recovery.status, "recovered");
    assert.equal(f.requests().filter(request => request.method === "turn/start").length, 1);
    const interrupts = f.requests().filter(request => request.method === "turn/interrupt");
    assert.ok(interrupts.length >= 1);
    const serverId = f.requests().find(request => request.method === "turn/start").serverId;
    assert.ok(interrupts.every(request => request.serverId === serverId), "only the original broker interrupts, including its shutdown cleanup");
    assert.ok(interrupts.every(request => request.params.threadId === original.threadId && request.params.turnId === original.turnId));
    assert.equal(reads(f).length, 2, "confirmation plus one automatic recheck");
    assert.ok(reads(f).every(request => request.params.threadId === original.threadId && request.params.includeTurns));
    await until(() => !alive(resolved.inferredRecheck.pid));
    const before = bytes(f, original.id), requestsBefore = f.requests();
    quiet(helper(f, original.id)); quiet(helper(f, original.id));
    assert.deepEqual(bytes(f, original.id), before, "already recovered jobs receive no writes");
    assert.deepEqual(f.requests(), requestsBefore);
    assert.doesNotMatch(f.call("help").stdout, /inferred-turn-recheck/);
  });

  for (const terminal of [true, false]) await t.test(terminal ? "one later retry recovers the exact turn" : "a still-running turn stops after two attempts", async () => {
    const { f, original } = launch(false);
    const claimed = await until(() => storedJob(f, original.id).inferredRecheck?.pid && storedJob(f, original.id));
    const before = bytes(f, original.id), requestsBefore = f.requests();
    quiet(helper(f, original.id));
    assert.deepEqual(bytes(f, original.id), before, "a duplicate helper cannot claim the scheduled job");
    assert.deepEqual(f.requests(), requestsBefore);
    await until(() => storedJob(f, original.id).recovery?.status === "running");
    if (terminal) {
      const state = f.state();
      Object.assign(state.threads.find(thread => thread.id === original.threadId).turns.find(turn => turn.id === original.turnId),
        { status: "interrupted", completedAt: Math.floor(Date.now() / 1000) });
      fs.writeFileSync(path.join(f.dir, "fake-codex-state.json"), JSON.stringify(state));
    }
    await until(() => !alive(claimed.inferredRecheck.pid));
    const resolved = storedJob(f, original.id);
    assert.equal(resolved.recovery.status, terminal ? "recovered" : "running");
    assert.equal(resolved.status, "completed");
    assert.equal(resolved.result.turnEnded, terminal);
    assert.equal(reads(f).length, 3, "confirmation plus exactly two automatic checks");
    const finished = bytes(f, original.id);
    quiet(helper(f, original.id));
    assert.deepEqual(bytes(f, original.id), finished, "an exhausted helper is never restarted");
    assert.equal(reads(f).length, 3);
  });

  await t.test("deleted, changed and stopped jobs are untouched when the helper wakes", async () => {
    const { f, original } = launch(false, "2000");
    const claimed = await until(() => storedJob(f, original.id).inferredRecheck?.pid && storedJob(f, original.id));
    patchJob(f, original.id, { turnId: "replacement-turn" });
    const changed = bytes(f, original.id);
    await until(() => !alive(claimed.inferredRecheck.pid));
    assert.deepEqual(bytes(f, original.id), changed);
    assert.equal(reads(f).length, 1);
    for (const patch of [{ turnId: original.turnId, cancelRequested: { reason: "cancelled_by_user" } },
      { cancelRequested: null, ownerDetachReason: "signal" }, { ownerDetachReason: null, recovered: true }]) {
      patchJob(f, original.id, { ...patch, inferredRecheck: { ...original.inferredRecheck, claimedAt: null, pid: null } });
      const before = bytes(f, original.id);
      quiet(helper(f, original.id));
      assert.deepEqual(bytes(f, original.id), before);
    }
    const file = path.join(resolveStateDir(f.repo, f.env), "jobs", `${original.id}.json`);
    fs.unlinkSync(file);
    const index = fs.readFileSync(path.join(resolveStateDir(f.repo, f.env), "state.json"), "utf8");
    quiet(helper(f, original.id));
    assert.equal(fs.existsSync(file), false);
    assert.equal(fs.readFileSync(path.join(resolveStateDir(f.repo, f.env), "state.json"), "utf8"), index);
    assert.equal(reads(f).length, 1);
    fs.rmSync(resolveStateDir(f.repo, f.env), { recursive: true });
    quiet(helper(f, original.id));
    assert.equal(fs.existsSync(resolveStateDir(f.repo, f.env)), false, "deleted state directories are not recreated");
  });

  await t.test("a stop recorded during the exact-turn read prevents helper writes", async () => {
    const { f, original } = launch(true, "6000", "7000", true);
    const statePath = path.join(f.dir, "fake-codex-state.json");
    fs.writeFileSync(statePath + ".hold-read", "");
    await until(() => fs.existsSync(statePath + ".read-held"));
    patchJob(f, original.id, { cancelRequested: { reason: "cancelled_by_user" } });
    const before = bytes(f, original.id), pid = storedJob(f, original.id).inferredRecheck.pid;
    fs.writeFileSync(statePath + ".release-read", "");
    await until(() => !alive(pid));
    assert.deepEqual(bytes(f, original.id), before, "helper revalidates under the terminal commit lock");
    assert.equal(reads(f).length, 2);
  });

  await t.test("terminal commits exclude confirmed, non-inferred, cancelled, stopped and review jobs; spawn errors stay optional", () => {
    const f = fixture();
    const result = json(run(process.execPath, ["--input-type=module", "-e", `
      import fs from 'node:fs';
      import cp from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      import { runTrackedJob } from ${JSON.stringify(new URL('../plugins/codex/scripts/lib/tracked-jobs.mjs', import.meta.url).href)};
      import { readJobFile, resolveJobFile } from ${JSON.stringify(new URL('../plugins/codex/scripts/lib/state.mjs', import.meta.url).href)};
      const spawns = [], committed = [], records = [], fallbacks = [];
      const spawnSync = cp.spawnSync;
      let unrefs = 0, fault = null;
      cp.spawnSync = (command, args, options) => {
        if (command !== process.execPath || args[0] !== '--input-type=module') return spawnSync(command, args, options);
        const target = JSON.parse(args.at(-1));
        spawns.push({ command: target.command, args: target.args, detached: target.options.detached,
          stdio: target.options.stdio, home: options.env.CODEX_COMPANION_HOME });
        committed.push(readJobFile(resolveJobFile(process.cwd(), target.args[2])).status);
        if (fault) throw new Error('fixture launcher failure');
        return { status: 0, stdout: '123456\\n' };
      };
      cp.spawn = (command, args) => {
        fallbacks.push(args[2]);
        if (fault === 'sync') throw new Error('fixture fallback failure');
        return { pid: process.pid, once() {}, unref: () => { unrefs++; } };
      };
      syncBuiltinESMExports();
      const cases = [
        { id: 'confirmed', payload: { turnEnded: true } }, { id: 'ordinary', payload: { inferredCompletion: false } },
        { id: 'cancelled', status: 'cancelled' }, { id: 'stopped', status: 'interrupted' }, { id: 'failed', status: 'failed' },
        { id: 'cancel-intent', job: { cancelRequested: { reason: 'cancelled_by_user' } } },
        { id: 'owner-stop', job: { ownerDetachReason: 'signal' } },
        { id: 'result-stop', payload: { interruptionReason: 'owner_stopped' } },
        { id: 'report-stop', report: { interruptionReason: 'owner_stopped' } },
        { id: 'review', job: { jobClass: 'review' } },
        { id: 'eligible' }, { id: 'eligible' }, { id: 'sync-failure', fault: 'sync' }, { id: 'launcher-fallback', fault: 'fallback' }
      ];
      for (const item of cases) {
        fault = item.fault;
        const tracked = { id: item.id, jobClass: 'task', workspaceRoot: process.cwd(), backgroundTerminals: {},
          logFile: process.cwd() + '/' + item.id + '.log', rawOutputFile: process.cwd() + '/' + item.id + '.txt',
          resultFile: process.cwd() + '/' + item.id + '.json', ...item.job };
        const execution = { exitStatus: 0, jobStatus: item.status ?? 'completed', threadId: 'thread', turnId: 'turn',
          payload: { status: 0, rawOutput: 'captured answer', inferredCompletion: true, turnEnded: false, ...item.payload },
          report: { status: item.status ?? 'completed', ...item.report } };
        const returned = await runTrackedJob(tracked, async () => execution);
        records.push({ id: item.id, returned: returned === execution, job: readJobFile(resolveJobFile(process.cwd(), item.id)) });
      }
      console.log(JSON.stringify({ spawns, committed, unrefs, records, fallbacks }));
    `], { cwd: f.repo, env: f.env }));
    assert.equal(result.spawns.length, 3, "one eligible launch and two injected launcher failures; no duplicate or excluded launches");
    assert.deepEqual(result.committed, ["completed", "completed", "completed"]);
    assert.deepEqual(result.fallbacks, ["sync-failure", "launcher-fallback"]);
    assert.equal(result.unrefs, 1, "spawnDetached owns unref for its successful fallback");
    for (const spawn of result.spawns) {
      assert.equal(spawn.command, process.execPath);
      assert.deepEqual(spawn.args, [script, "inferred-turn-recheck", spawn.args[2], "--cwd", f.repo]);
      assert.equal(spawn.detached, true); assert.deepEqual(spawn.stdio, ["ignore", "ignore", "ignore"]); assert.equal(spawn.home, f.env.CODEX_COMPANION_HOME);
    }
    for (const record of result.records) {
      assert.equal(record.returned, true);
      assert.equal(Boolean(record.job.inferredRecheck), ["eligible", "sync-failure", "launcher-fallback"].includes(record.id), record.id);
    }
    assert.equal(storedJob(f, "sync-failure").status, "completed");
    assert.match(fs.readFileSync(path.join(f.repo, "sync-failure.log"), "utf8"), /Could not start automatic inferred-turn reconciliation/);
    assert.equal(storedJob(f, "launcher-fallback").status, "completed");
    assert.doesNotMatch(fs.readFileSync(path.join(f.repo, "launcher-fallback.log"), "utf8"), /Could not start automatic inferred-turn reconciliation/);
  });
});

test("inferred final answers confirm the exact turn or remain recoverable by name and job ID", async t => {
  const { unresolvedTask } = await import('../plugins/codex/scripts/lib/state.mjs');
  const stored = (shared, id) => readJobFile(path.join(resolveStateDir(shared.repo, shared.env), "jobs", `${id}.json`));
  const changeServer = (shared, patch) => fs.writeFileSync(path.join(shared.dir, "fake-codex-state.json"), JSON.stringify({ ...shared.state(), ...patch }));
  // One real inferred turn supplies both unresolved history and broker-cleanup
  // variants. Every replay starts from its complete, quiescent durable snapshot.
  const shared = fixture("inferred-final:running");
  // This test owns lazy-recovery timing and replays durable snapshots. Keep
  // automatic helpers asleep until the suite's process-ledger teardown.
  shared.env.CODEX_COMPANION_INFERRED_RECHECK_MS = "3600000";
  const binary = path.join(shared.dir, "codex"), source = fs.readFileSync(binary, "utf8");
  const interruptCase = 'case "turn/interrupt": {';
  assert.ok(source.includes(interruptCase));
  fs.writeFileSync(binary, source.replace(interruptCase, `${interruptCase}
    if (state.rejectInterrupt) throw new Error("Fixture interrupt refused");
  `));
  assert.equal(run(process.execPath, [path.join(shared.dir, "codex"), "app-server"], { cwd: shared.repo, env: shared.env, input: "" }).status, 0);
  changeServer(shared, { allowInterrupt: true });
  const launch = json(shared.call("task", "--fresh", "--detached", "--json", "fixture"));
  const original = await waitUntil(() => {
    const current = stored(shared, launch.jobId);
    return current.status === "completed" && !current.pid && current;
  });
  assert.equal(original.result.inferredCompletion, true);
  assert.equal(original.result.turnEnded, false);
  assert.equal(original.result.turnStatus, "inProgress");
  assert.equal(unresolvedTask(original), true);
  await waitUntil(() => shared.state().threads.find(thread => thread.id === original.threadId).turns.find(turn => turn.id === original.turnId).status === "interrupted");
  const cleanup = shared.requests().filter(request => request.method === "turn/interrupt");
  assert.equal(cleanup.length, 1);
  assert.deepEqual(cleanup[0].params, { threadId: original.threadId, turnId: original.turnId });
  assert.equal(cleanup[0].serverId, shared.requests().find(request => request.method === "turn/start").serverId);
  await waitUntil(() => !alive(cleanup[0].serverId));
  const restore = await snapshotFixture(shared);
  const restoreRunning = () => {
    restore();
    const server = shared.state();
    Object.assign(server.threads.find(thread => thread.id === original.threadId).turns.find(turn => turn.id === original.turnId),
      { status: "inProgress", completedAt: null });
    changeServer(shared, { ...server, allowInterrupt: false });
  };
  for (const scenario of ["delayed-cancel", "owner-signal", "historical-signal", "owner-returned", "owner-attached", "runtime-stop"]) await t.test(scenario, async t => {
    restoreRunning();
    if (scenario === "delayed-cancel") {
      // The replacement-broker silent deadline is retained in checkCleanup's
      // unconfirmed variant. Here a real RPC refusal gives the same durable
      // stop intent before the later exact-turn confirmation.
      changeServer(shared, { rejectInterrupt: true });
      const artifactBefore = fs.readFileSync(original.resultFile, "utf8");
      const cancel = json(shared.call("cancel", launch.jobId, "--json"), 2);
      assert.equal(cancel.status, "interrupt_unconfirmed");
      assert.equal(cancel.confirmation, "unconfirmed");
      assert.equal(cancel.turnInterruptAttempted, true); assert.equal(cancel.turnInterrupted, false);
      assert.equal(cancel.reason, "cancelled_by_user");
      const pending = stored(shared, launch.jobId);
      assert.equal(pending.ownerId, original.ownerId);
      assert.equal(pending.threadId, original.threadId); assert.equal(pending.turnId, original.turnId);
      assert.equal(pending.cancelRequested.reason, "cancelled_by_user");
      assert.deepEqual(pending.result, original.result);
      assert.equal(fs.readFileSync(pending.resultFile, "utf8"), artifactBefore);
      assert.equal(fs.readFileSync(pending.rawOutputFile, "utf8"), original.result.rawOutput);
    } else if (scenario === "owner-attached") {
      // The worker reconciles its own leftover turn while the owner still waits.
      patchJob(shared, launch.jobId, { ownerAttached: true, ownerAttachedAt: Date.now(), ownerDetachedAt: null, ownerDetachReason: null });
    } else if (scenario === "historical-signal") {
      // Older stopped owners may have only detach metadata, with no intent field.
      patchJob(shared, launch.jobId, { ownerAttachedAt: Date.now(), ownerDetachedAt: Date.now(), ownerDetachReason: "signal" });
    } else {
      // Hold publication after the answer was captured, so a real owner/runtime
      // can stop before the worker's final completed-state write wins the race.
      patchJob(shared, launch.jobId, { status: "running", phase: "running" });
      if (scenario === "runtime-stop") {
        const runtimeModule = new URL('../plugins/codex/scripts/lib/job-runtime.mjs', import.meta.url).href;
        const stateModule = new URL('../plugins/codex/scripts/lib/state.mjs', import.meta.url).href;
        const stopped = run(process.execPath, ["--input-type=module", "-e", `
          import { JobRuntime } from ${JSON.stringify(runtimeModule)};
          import { readJobFile, resolveJobFile } from ${JSON.stringify(stateModule)};
          const runtime = new JobRuntime(process.cwd(), ${JSON.stringify(launch.jobId)});
          let reasonAtAbort;
          runtime.abort.signal.addEventListener('abort', () => { reasonAtAbort = readJobFile(resolveJobFile(process.cwd(), ${JSON.stringify(launch.jobId)})).cancelRequested?.reason ?? null; });
          runtime.stop('owner_stopped'); runtime.close();
          console.log(JSON.stringify({ reasonAtAbort }));
        `], { cwd: shared.repo, env: shared.env });
        assert.equal(json(stopped).reasonAtAbort, "owner_stopped");
      } else {
        const owner = spawnOwned(process.execPath, [script, "wait", launch.jobId, "--owner", launch.ownerId, "--timeout-sec", "60", "--json"],
          { cwd: shared.repo, env: shared.env, stdio: ["ignore", "pipe", "pipe"] });
        owner.stdout.resume(); owner.stderr.resume();
        const closed = new Promise(resolve => owner.on("close", resolve));
        await waitUntil(() => stored(shared, launch.jobId).ownerAttached);
        if (scenario === "owner-signal") owner.kill("SIGTERM");
        else patchJob(shared, launch.jobId, { status: "completed", phase: "done" });
        assert.equal(await closed, scenario === "owner-signal" ? 130 : 0);
        assert.equal(stored(shared, launch.jobId).ownerDetachReason, scenario === "owner-signal" ? "signal" : "returned");
      }
      patchJob(shared, launch.jobId, { status: "completed", phase: "done" });
    }
    // The server confirms the previously requested interruption only afterward.
    const server = shared.state();
    Object.assign(server.threads.find(thread => thread.id === original.threadId).turns.find(turn => turn.id === original.turnId),
      { status: "interrupted", completedAt: Math.floor(Date.now() / 1000) });
    changeServer(shared, server);
    const output = shared.call("result", launch.jobId, "--details"), resolved = stored(shared, launch.jobId);
    t.diagnostic(JSON.stringify({ scenario, status: resolved.status, exitCode: output.status, ownerDetachReason: resolved.ownerDetachReason ?? null,
      cancelRequested: resolved.cancelRequested?.reason ?? null, interruptionReason: resolved.result.interruptionReason }));
    const expected = ["owner-returned", "owner-attached"].includes(scenario) ? "completed" : scenario === "delayed-cancel" ? "cancelled" : "interrupted";
    const report = json(output, expected === "completed" ? 0 : 1);
    assert.equal(report.status, expected);
    assert.equal(resolved.result.workerStatus, expected);
    assert.equal(resolved.result.turnStatus, "interrupted");
    assert.equal(resolved.result.rawOutput, original.result.rawOutput);
    assert.deepEqual(resolved.result.structured, original.result.structured);
    assert.equal(unresolvedTask(resolved), false);
    // An owner detach is stop evidence by itself; it must not write cancelRequested,
    // which would interrupt a job whose ownership merely moved.
    if (!["historical-signal", "owner-signal"].includes(scenario)) assert.equal(resolved.cancelRequested?.reason ?? null,
      ["owner-returned", "owner-attached"].includes(scenario) ? null : scenario === "delayed-cancel" ? "cancelled_by_user" : "owner_stopped");
    assert.equal(resolved.result.interruptionReason, expected === "completed" ? null : expected === "cancelled" ? "cancelled_by_user" : "owner_stopped");
    assert.equal(shared.requests().filter(request => request.method === "turn/start").length, 1);
  });
  {
    for (const stop of ["none", "cancel", "recorded-cancel", "owner-stop"]) {
      restore();
      if (stop === "cancel") assert.equal(json(shared.call("cancel", launch.jobId, "--json")).confirmation, "confirmed");
      if (stop === "recorded-cancel" || stop === "owner-stop") patchJob(shared, launch.jobId, {
        cancelRequested: { reason: stop === "recorded-cancel" ? "cancelled_by_user" : "owner_stopped", at: new Date().toISOString() }
      });
      const expected = stop === "none" ? "completed" : stop === "owner-stop" ? "interrupted" : "cancelled";
      const exitCode = expected === "completed" ? 0 : 1;
      const report = json(shared.call("result", launch.jobId, "--details"), exitCode), resolved = stored(shared, launch.jobId);
      assert.equal(report.status, expected);
      assert.equal(resolved.status, expected);
      assert.equal(resolved.result.workerStatus, expected);
      assert.equal(resolved.result.status, exitCode);
      assert.equal(resolved.report.exitCode, exitCode);
      assert.equal(resolved.result.turnStatus, "interrupted");
      assert.equal(resolved.result.turnEnded, true);
      assert.equal(resolved.recovered, true);
      assert.deepEqual([resolved.recovery.source, resolved.recovery.threadId, resolved.recovery.turnId, resolved.recovery.turnStatus],
        ["thread/read", original.threadId, original.turnId, "interrupted"]);
      assert.ok(resolved.recovery.detail);
      assert.equal(Boolean(resolved.recovery.interruptRequested), stop !== "none");
      assert.equal(resolved.result.interruptionReason, expected === "cancelled" ? "cancelled_by_user" : stop === "owner-stop" ? "owner_stopped" : null);
      assert.equal(resolved.result.rawOutput, original.result.rawOutput);
      assert.deepEqual(resolved.result.structured, original.result.structured);
      assert.equal(fs.readFileSync(resolved.rawOutputFile, "utf8"), original.result.rawOutput);
      assert.deepEqual(readJobFile(resolved.resultFile), resolved.result);
      assert.equal(unresolvedTask(resolved), false);
      assert.equal(shared.requests().filter(request => request.method === "turn/start").length, 1);
      t.diagnostic(JSON.stringify({ mode: "broker-disconnect", stop, status: resolved.status, turnStatus: resolved.result.turnStatus, exitCode }));
    }
  }
  for (const [mode, selectors] of [["running", ["name", "jobId", "observed"]], ["unreadable", ["command"]], ["hang", ["command"]], ["completed", [null]], ["failed", [null]]]) {
    const replay = mode === "running";
    if (replay) restoreRunning();
    const current = replay ? shared : fixture(`inferred-final:${mode}`);
    current.env.CODEX_COMPANION_INFERRED_RECHECK_MS = "3600000";
    const first = direct(replay
      ? current.call("wait", launch.jobId, "--direct", "--quiet")
      : current.call("task", "--fresh", "--direct", "--quiet", "fixture"), mode === "failed" ? 1 : 0);
    const f = current, original = stored(f, first.jobId);
    const ended = ["completed", "failed"].includes(mode);
    assert.equal(first.status, mode === "failed" ? "failed" : "completed");
    assert.equal(original.result.inferredCompletion, true);
    assert.equal(original.result.turnEnded, ended);
    assert.equal(original.result.turnStatus, ended ? mode : mode === "running" ? "inProgress" : null);
    assert.equal(unresolvedTask(original), !ended);
    const confirmation = f.requests().find(request => request.method === "thread/read");
    assert.deepEqual(confirmation.params, { threadId: original.threadId, includeTurns: true });
    assert.equal(confirmation.serverId, f.requests().find(request => request.method === "turn/start").serverId);

    // An unconfirmed stream retires its broker on disconnect. The replacement
    // must resolve the durable exact turn, even with no final items in history.
    if (!ended) await waitUntil(() => !alive(f.requests()[0].serverId));
    const reset = selectors.length > 1 ? await snapshotFixture(f) : null;
    for (const selector of selectors) {
      reset?.();
      if (!ended) {
        // A timed-out probe stays recoverable once the server answers again.
        if (mode === "hang") changeServer(f, { confirmationMode: "running" });
        const blocked = direct(f.call("task", "--continue", first.jobId, "--direct", "--quiet", "follow up"), 2);
        const blocker = blocked.blockers[0];
        assert.equal(blocker.code, "thread_busy"); assert.equal(blocker.predecessorJobId, first.jobId);
        assert.ok(blocker.cancelCommand);
        const status = json(f.call("status", first.jobId, "--json"));
        assert.equal(status.job.status, "completed");
        assert.equal(status.job.turnResolution, mode === "unreadable" ? "unknown" : "in_progress");
        assert.ok(status.recovery.cancelCommand);
        assert.equal(stored(f, first.jobId).result.rawOutput, original.result.rawOutput);
        // Missing inference markers and normal ended records retain their old
        // eligibility; this fix does not reinterpret historical completions.
        assert.equal(unresolvedTask({ ...original, result: { ...original.result, inferredCompletion: undefined } }), false);
        assert.equal(unresolvedTask({ ...original, result: { ...original.result, turnEnded: true } }), false);
        const offset = f.requests().length;
        if (selector === "observed") {
          const server = f.state();
          Object.assign(server.threads.find(thread => thread.id === original.threadId).turns.find(turn => turn.id === original.turnId),
            { status: "completed", completedAt: Math.floor(Date.now() / 1000) });
          changeServer(f, server);
          assert.equal(json(f.call("status", first.jobId, "--json")).job.turnResolution, "completed");
        } else {
          changeServer(f, { allowInterrupt: true });
          const cancelled = json(selector === "command"
            ? run("/bin/sh", ["-c", blocker.cancelCommand], { cwd: f.repo, env: f.env })
            : f.call("cancel", selector === "name" ? original.agentName : first.jobId, "--json"));
          assert.equal(cancelled.confirmation, "confirmed"); assert.equal(cancelled.turnInterrupted, true);
        }
        const interrupts = f.requests().slice(offset).filter(request => request.method === "turn/interrupt");
        assert.equal(interrupts.length, selector === "observed" ? 0 : 1);
        if (interrupts.length) assert.deepEqual(interrupts[0].params, { threadId: original.threadId, turnId: original.turnId });
        const resolved = stored(f, first.jobId);
        assert.equal(resolved.status, selector === "observed" ? "completed" : "cancelled"); assert.equal(resolved.result.turnEnded, true);
        assert.equal(resolved.result.rawOutput, original.result.rawOutput);
        assert.deepEqual(resolved.result.structured, original.result.structured);
        assert.equal(fs.readFileSync(resolved.rawOutputFile, "utf8"), original.result.rawOutput);
        assert.deepEqual(readJobFile(resolved.resultFile), resolved.result);
        assert.equal(resolved.report.summary, original.report.summary);
        assert.equal(unresolvedTask(resolved), false);
      }
      t.diagnostic(JSON.stringify({ mode, selector, turnEnded: original.result.turnEnded }));
    }
    const followup = direct(f.call("task", "--continue", first.jobId, "--direct", "--quiet", "follow up"));
    assert.equal(followup.status, "completed");
    assert.equal(f.requests().filter(request => request.method === "turn/start").length, 2);
  }
  for (const behavior of ["review-ok", "with-subagent", "with-subagent-no-main-turn-completed"]) {
    const f = fixture(behavior), first = direct(f.call("task", "--fresh", "--direct", "--quiet", "fixture"));
    const result = stored(f, first.jobId).result, inferred = behavior === "with-subagent-no-main-turn-completed";
    assert.equal(first.status, "completed");
    assert.equal(result.turnEnded, !inferred);
    assert.equal(result.inferredCompletion === true, inferred);
    assert.equal(f.requests().filter(request => request.method === "thread/read").length, inferred ? 1 : 0);
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
  assert.equal(result.measurements.progressLines - result.omissionLines.length + result.measurements.omittedLines, result.saved.activityTotals.events, "display omissions do not lose event accounting");
  assert.equal(result.saved.activity.length, ACTIVITY_RETAINED_MAX);
  const stopped = await backpressureScenario(script, { signalStop: true });
  const final = direct({ status: stopped.code, stdout: stopped.stdout, stderr: stopped.stderr }, 130);
  assert.equal(final.status, "owner_stopped");
  assert.equal(final.jobId, stopped.saved.id);
  assert.equal(stopped.stderr, "");

  // The durable window and totals also survive legacy migration and a new
  // updater, including tool completions whose starts have left the window.
  const cwd = makeTempDir(), id = "retained-activity", createdAt = new Date().toISOString();
  const early = [
    { type: "commandExecution", command: "node --test", lifecycle: "started" },
    { type: "commandExecution", command: "node --test", lifecycle: "completed", exitCode: 0 },
    ...Array(2).fill({ type: "commandExecution", command: "npm run build", lifecycle: "started" }),
    { type: "mcpToolCall", server: "fixture", tool: "check", callId: "start", lifecycle: "started" },
    { type: "dynamicToolCall", server: "fixture", tool: "check", lifecycle: "completed" },
    ...["a.mjs", "b.mjs"].map(path => ({ type: "fileChange", path, lifecycle: "completed" }))
  ].map((event, i) => ({ ...event, seq: i + 1, at: createdAt }));
  const commands = [{ command: "node --test", status: "completed", exitCode: 0 }];
  const workerResult = { status: 0, rawOutput: "Completed.", commandExecutions: commands,
    structured: parseStructuredReport(JSON.stringify({ status: "completed", summary: "Completed.", verification: ["node --test: passed"] })) };
  const report = buildWorkerReport(workerResult, { jobId: id });
  const record = { id, workspaceRoot: cwd, jobClass: "task", status: "completed", createdAt, result: workerResult, report,
    activity: early, activitySeq: early.length, activityCursors: { [activityReader("late")]: 1 } };
  writeJobFile(cwd, id, record); upsertJob(cwd, record);
  assert.equal(fullReport(report, record).activityCount, early.length);
  const legacy = json(run(process.execPath, [script, "wait", id, "--json"], { cwd }));
  assert.equal(legacy.activityCount, early.length);
  assert.deepEqual(legacy.verification, report.verification);
  const late = [
    { type: "commandExecution", command: "npm run build", status: "failed" },
    { type: "commandExecution", command: "npm run build", lifecycle: "completed" },
    { type: "mcpToolCall", server: "fixture", tool: "check", callId: "different", lifecycle: "completed" },
    { type: "dynamicToolCall", server: "fixture", tool: "check", lifecycle: "started" },
    { type: "dynamicToolCall", server: "fixture", tool: "check", status: "declined" },
    { type: "commandExecution", command: "echo observed", lifecycle: "completed" }
  ];
  const filler = Array.from({ length: 600 - early.length - late.length }, () => ({ type: "plan", steps: [], statuses: [] }));
  createJobProgressUpdater(cwd, id)({ activity: filler });
  assert.deepEqual(readJobFile(resolveJobFile(cwd, id)).activityTotals, { events: early.length + filler.length, toolUses: 7 });
  createJobProgressUpdater(cwd, id)({ activity: late });
  const retained = readJobFile(resolveJobFile(cwd, id)), all = [...early, ...filler, ...late];
  assert.equal(retained.activity.length, ACTIVITY_RETAINED_MAX);
  assert.deepEqual(retained.activityTotals, { events: all.length, toolUses: 9 });
  assert.deepEqual(retained.activityPendingTools, {});
  assert.equal(retained.activity[0].seq, all.length - ACTIVITY_RETAINED_MAX + 1);
  assert.equal(retained.activity.at(-1).seq, all.length);
  assert.deepEqual(fullReport(report, retained), fullReport(report, { ...record, activity: all }));
  assert.deepEqual(directReport(report, retained), directReport(report, record));
  const fresh = json(run(process.execPath, [script, "wait", id, "--owner", "fresh", "--json"], { cwd }));
  assert.equal(fresh.activityEvicted, 100);
  assert.equal(fresh.activityCount, all.length);
  assert.equal(fresh.activityOmitted, all.length - fresh.activity.length);
  const behind = json(run(process.execPath, [script, "wait", id, "--owner", "late", "--json"], { cwd }));
  assert.equal(behind.activityEvicted, 99);
  assert.equal(behind.activityCount, all.length - 1);
  assert.equal(behind.activityOmitted, behind.activityCount - behind.activity.length);
  assert.equal(behind.cursor, all.length);
  const observed = json(run(process.execPath, [script, "wait", id, "--json"], { cwd }));
  assert.equal(observed.activityEvicted, 100 - early.length);
  assert.equal(observed.activityCount, all.length - early.length);
  const replay = json(run(process.execPath, [script, "wait", id, "--owner", "late", "--json"], { cwd }));
  assert.equal(replay.activityCount, 0);
  assert.equal(Object.hasOwn(replay, "activityEvicted"), false);
  createJobProgressUpdater(cwd, id)({ activity: Array.from({ length: 150 }, (_, i) => ({
    type: "commandExecution", command: `pending-${i}`, lifecycle: "started"
  })) });
  const cappedPending = readJobFile(resolveJobFile(cwd, id));
  assert.ok(Object.keys(cappedPending.activityPendingTools).length <= ACTIVITY_PENDING_MAX
    && Number.isInteger(cappedPending.activityTotals.events) && Number.isInteger(cappedPending.activityTotals.toolUses));
  const stateFile = path.join(resolveStateDir(cwd), "state.json");
  const indexed = () => JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(Object.hasOwn(indexed().jobs.find(job => job.id === id), "activityPendingTools"), false);
  upsertJob(cwd, cappedPending);
  assert.equal(Object.hasOwn(indexed().jobs.find(job => job.id === id), "activityPendingTools"), false);
  // Old indexes may already contain pairing state: both status and raw results
  // must hide it, while private reads keep it for subsequent completions.
  const staleIndex = indexed();
  staleIndex.jobs.find(job => job.id === id).activityPendingTools = cappedPending.activityPendingTools;
  fs.writeFileSync(stateFile, JSON.stringify(staleIndex));
  for (const args of [["status", id, "--json"], ["status", "--all", "--json"], ["result", id, "--json"], ["result", id, "--details"]]) {
    const output = json(run(process.execPath, [script, ...args], { cwd }));
    assert.equal(JSON.stringify(output).includes('"activityPendingTools"'), false);
  }
  upsertJob(cwd, { id });
  assert.equal(Object.hasOwn(indexed().jobs.find(job => job.id === id), "activityPendingTools"), false);
  assert.deepEqual(readJobFile(resolveJobFile(cwd, id)).activityPendingTools, cappedPending.activityPendingTools);
  createJobProgressUpdater(cwd, id)({ activity: [{ type: "commandExecution", command: "pending-149", lifecycle: "completed" }] });
  assert.equal(readJobFile(resolveJobFile(cwd, id)).activityTotals.toolUses, cappedPending.activityTotals.toolUses);
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
  const f = fixture("task-ok");
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
  await waitUntil(() => storedJob(active, running.jobId).turnId);
  assert.notEqual(active.call("task", "--continue", running.jobId, "--json").status, 0);
  json(active.call("cancel", running.jobId, "--json"));

  // An older runtime rejects the bridge override, then the dynamic registration.
  const fallback = fixture("task-ok"), binary = path.join(fallback.dir, "codex");
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
    const unrelated = fixture("task-ok"), unrelatedBinary = path.join(unrelated.dir, "codex");
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

  // approvals-3: accepted answers survive a bridge crash for an exact retry,
  // and an unclaimed orphan expires without leaking into a different call.
  for (const retry of [true, false]) {
    const cwd = makeTempDir(), id = `bridge-orphan-${retry}`, threadId = `thread-orphan-${retry}`, turnId = "turn-orphan";
    const record = { id, status: "running", jobClass: "task", workspaceRoot: cwd, ownerId: "owner", questionTimeoutSec: 60, threadId, turnId };
    writeJobFile(cwd, id, record); upsertJob(cwd, record);
    const env = { [PARENT_BRIDGE_ENV.cwd]: cwd, [PARENT_BRIDGE_ENV.threadId]: threadId };
    const call = (rpcId, callId) => ({ id: rpcId, method: "tools/call", params: { name: "ask_parent", arguments: { question: "Choose?" },
      _meta: { threadId, callId, "x-codex-turn-metadata": { turn_id: turnId } } } });
    const read = () => readJobFile(resolveJobFile(cwd, id));
    const first = openBridge(cwd, env);
    first.send(call(1, "original-call"));
    const pending = await waitUntil(() => read().pendingQuestion);
    assert.equal(pending.caller.pid, first.bridge.pid); assert.equal(typeof pending.caller.nonce, "string");
    first.bridge.kill("SIGSTOP");
    answerQuestion(cwd, id, pending.id, "Original answer", "owner");
    const exited = new Promise(resolve => first.bridge.once("exit", resolve));
    first.bridge.kill("SIGKILL"); await exited;
    const replacement = openBridge(cwd, env);
    replacement.send(call(2, "different-call"));
    await replacement.reply(2);
    assert.equal(read().pendingQuestion.id, pending.id);
    assert.equal(read().questionHistory.at(-1).resolution, "busy");
    assert.notEqual((await replacement.reply(2)).result.content[0].text, "Original answer");
    if (retry) {
      replacement.send(call(3, "original-call"));
      assert.equal((await replacement.reply(3)).result.content[0].text, "Original answer");
      assert.equal(read().pendingQuestion, null);
      assert.equal(read().questionHistory.filter(entry => entry.id === pending.id && entry.resolution === "answered").length, 1);
    } else {
      updateJob(cwd, id, current => ({ pendingQuestion: { ...current.pendingQuestion, expiresAt: Date.now() - 1 } }));
    }
    replacement.send(call(4, retry ? "original-call" : "next-call"));
    const next = await waitUntil(() => { const question = read().pendingQuestion; return question && question.id !== pending.id && question; });
    assert.equal(next.caller.pid, replacement.bridge.pid); assert.notEqual(next.caller.nonce, pending.caller.nonce);
    assert.equal(next.answer, undefined);
    if (!retry) assert.equal(read().questionHistory.filter(entry => entry.id === pending.id && entry.resolution === "orphaned").length, 1);
    answerQuestion(cwd, id, next.id, "New answer", "owner");
    assert.equal((await replacement.reply(4)).result.content[0].text, "New answer");
    replacement.bridge.stdin.end();
    await waitUntil(() => !alive(replacement.bridge.pid));
  }
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
