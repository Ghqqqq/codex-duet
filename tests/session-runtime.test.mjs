import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDir, run, readyBroker } from "./helpers.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { saveBrokerSession } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { getSessionRuntimeStatus } from "../plugins/codex/scripts/lib/codex.mjs";
import { resolveStateDir } from "../plugins/codex/scripts/lib/state.mjs";

test("empty runtime endpoint falls back to saved workspace broker without needing sockets", () => {
  const repo = makeTempDir();
  const bin = makeTempDir();
  installFakeCodex(bin);
  saveBrokerSession(repo, { endpoint: "unix:/fixture/saved.sock" });
  for (const endpoint of [undefined, "", "  "]) {
    const env = { CODEX_COMPANION_APP_SERVER_ENDPOINT: endpoint };
    assert.equal(getSessionRuntimeStatus(env, repo).endpoint, "unix:/fixture/saved.sock");
    assert.equal(getSessionRuntimeStatus(env, repo).mode, "shared");
  }
  assert.equal(getSessionRuntimeStatus({ CODEX_COMPANION_APP_SERVER_ENDPOINT: "unix:/fixture/override.sock" }, repo).endpoint, "unix:/fixture/override.sock");
  const result = run(process.execPath, [new URL("../plugins/codex/scripts/codex-companion.mjs", import.meta.url).pathname, "status", "--json"], { cwd: repo, env: buildEnv(bin) });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).sessionRuntime.mode, "shared");
  assert.equal(getSessionRuntimeStatus({ CODEX_COMPANION_APP_SERVER_ENDPOINT: "" }, makeTempDir()).mode, "direct");
});

// Shared fixture; these contracts were moved from worker-lifecycle to balance file runtime.
{
const {
  fs, path, makeTempDir, initGitRepo, run, buildEnv, installFakeCodex, resolveIsolatedCodexHome, resolveSessionMarkersRoot, AGENT_NAMES, script, hook, fixture, json, direct, waitUntil, job
} = await (await import('./fake-codex-fixture.mjs')).lifecycleHarness();
test("SessionEnd cancels only its session's jobs and retains confirmation evidence", () => {
  const f = fixture(), launch = json(f.call("task", "--detached", "--json", "fixture"));
  json(f.call("wait", launch.jobId, "--timeout-sec", "3", "--json", "--report"));
  f.env.CODEX_COMPANION_SESSION_ID = "foreign-session";
  const foreign = json(f.call("task", "--detached", "--json", "foreign fixture"));
  f.env.CODEX_COMPANION_SESSION_ID = "fixture-session";
  const foreignRunning = json(f.call("wait", foreign.jobId, "--timeout-sec", "3", "--json"));
  assert.ok(foreignRunning.turnId, "Wait for the foreign fixture turn before testing cancellation confirmation");
  const parentRepo = makeTempDir(); initGitRepo(parentRepo);
  const end = run(process.execPath, [hook, "SessionEnd"], { cwd: parentRepo, env: f.env, input: JSON.stringify({ session_id: "fixture-session", cwd: parentRepo }) });
  assert.equal(end.status, 0, end.stderr);
  const result = json(f.call("result", launch.jobId, "--details"), 1);
  assert.equal(result.status, "interrupted"); assert.equal(result.interruptionReason, "session_end"); assert.equal(result.interruptionConfirmed, true);
  assert.equal(job(f, foreign.jobId).status, "running");
  json(f.call("cancel", foreign.jobId, "--json"));
});

test("SessionEnd rechecks the session after adoption during its inventory", () => {
  for (const destination of ["fixture-session", "replacement-session"]) {
    const f = fixture(), id = "session-end-adoption", dir = resolveStateDir(f.repo, f.env);
    const file = path.join(dir, "jobs", `${id}.json`), index = path.join(dir, "state.json"), preload = path.join(f.dir, "adopt-during-inventory.mjs");
    const runtimeModule = new URL("../plugins/codex/scripts/lib/job-runtime.mjs", import.meta.url).href;
    const record = { id, jobClass: "task", status: "running", workspaceRoot: f.repo, sessionId: "fixture-session", ownerId: "old-owner",
      ownerAttached: false, leaseSec: 180, leaseExpiresAt: Date.now() + 180000, createdAt: new Date().toISOString() };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(record)); fs.writeFileSync(index, JSON.stringify({ jobs: [record] }));
    fs.writeFileSync(preload, `
      import fs from "node:fs";
      import { adoptJob } from ${JSON.stringify(runtimeModule)};
      const read = fs.readFileSync;
      Error.stackTraceLimit = 100;
      let interleaved = false;
      fs.readFileSync = function(file, ...args) {
        const contents = read.call(this, file, ...args), stack = new Error().stack;
        if (!interleaved && file === ${JSON.stringify(index)} && stack.includes("listSessionJobs") && !stack.includes("migrateUnderLock")) {
          interleaved = true;
          if (!adoptJob(${JSON.stringify(f.repo)}, ${JSON.stringify(id)}, ${JSON.stringify(destination)}).adopted) throw new Error("Adoption failed");
        }
        return contents;
      };
    `);
    const ended = run(process.execPath, ["--import", preload, hook, "SessionEnd"], { cwd: f.repo, env: f.env, input: JSON.stringify({ session_id: "fixture-session", cwd: f.repo }) });
    assert.equal(ended.status, 0, ended.stderr);
    const current = JSON.parse(fs.readFileSync(file));
    assert.equal(current.sessionId, destination); assert.notEqual(current.ownerId, record.ownerId);
    assert.equal(current.status, "running");
    if (destination === record.sessionId) assert.equal(current.cancelRequested?.reason, "session_end");
    else assert.equal(current.cancelRequested, undefined);
  }
});

test("legacy session-ID owners remain readable and session-scoped without implicit renewal", () => {
  const f = fixture(), launch = json(f.call("task", "--detached", "--json", "--owner", "fixture-session", "fixture"));
  json(f.call("wait", launch.jobId, "--timeout-sec", "3", "--json"));
  const stateModule = new URL("../plugins/codex/scripts/lib/state.mjs", import.meta.url).href;
  const edit = run(process.execPath, ["--input-type=module", "-e", `import { updateJob } from ${JSON.stringify(stateModule)}; updateJob(process.cwd(), ${JSON.stringify(launch.jobId)}, () => ({ sessionId: undefined, activity: undefined, activityCursors: undefined, activitySeq: undefined, leaseRenewedAt: undefined }));`], { cwd: f.repo, env: f.env });
  assert.equal(edit.status, 0, edit.stderr);
  const before = job(f, launch.jobId).leaseExpiresAt;
  assert.equal(json(f.call("status", "--json")).running[0].id, launch.jobId);
  const snapshot = json(f.call("wait", launch.jobId, "--timeout-sec", "1", "--json"));
  assert.deepEqual(snapshot.activity, []); assert.equal(snapshot.cursor, 0);
  assert.equal(job(f, launch.jobId).leaseExpiresAt, before);
  json(f.call("wait", launch.jobId, "--owner", "fixture-session", "--timeout-sec", "1", "--json"));
  assert.ok(job(f, launch.jobId).leaseExpiresAt > before);
  const ended = run(process.execPath, [hook, "SessionEnd"], { cwd: f.repo, env: f.env, input: JSON.stringify({ session_id: "fixture-session", cwd: f.repo }) });
  assert.equal(ended.status, 0, ended.stderr);
  assert.equal(json(f.call("result", launch.jobId, "--details"), 1).interruptionReason, "session_end");
});

test("foreground and direct tasks write private atomic session markers", () => {
  const f = fixture("slow-task"), canonicalHome = resolveIsolatedCodexHome(f.env);
  fs.mkdirSync(canonicalHome); const alias = path.join(f.dir, "home-alias"); fs.symlinkSync(canonicalHome, alias); f.env.CODEX_COMPANION_HOME = alias;
  const root = resolveSessionMarkersRoot(f.env); assert.equal(root, path.join(canonicalHome, "duet", "sessions"));
  let previous;
  const cases = [["--report", "--json"], ["--direct"]];
  const ids = [];
  for (const args of cases) {
    const extra = args.includes("--thread") ? [previous.threadId] : args.includes("--continue") ? [previous.jobId] : [];
    const output = f.call("task", ...args, ...extra, "marker fixture");
    const launched = args.includes("--direct") ? direct(output) : json(output);
    const saved = job(f, launched.jobId), markerFile = path.join(root, "fixture-session", `${launched.jobId}.json`);
    const marker = JSON.parse(fs.readFileSync(markerFile, "utf8"));
    assert.deepEqual(marker, { v: 1, jobId: launched.jobId, jobFile: saved.logFile.replace(/\.log$/, ".json"), logFile: saved.logFile, title: saved.title, name: saved.agentName, summary: "marker fixture", workspaceRoot: f.repo, createdAt: saved.createdAt });
    assert.ok(AGENT_NAMES.includes(saved.agentName));
    assert.equal(args.includes("--direct") ? launched.worker : launched.agentName, saved.agentName);
    if (extra.length) assert.equal(saved.agentName, previous.agentName);
    assert.equal(fs.statSync(markerFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(markerFile)).mode & 0o777, 0o700);
    assert.ok(fs.existsSync(marker.jobFile)); assert.ok(fs.existsSync(marker.logFile));
    previous = json(f.call("wait", launched.jobId, "--json")); ids.push(`${launched.jobId}.json`);
  }
  assert.deepEqual(fs.readdirSync(path.join(root, "fixture-session")).sort(), ids.sort(), "no temporary marker files remain");
});

test("missing or unsafe session IDs leave no marker and marker write failures never fail tasks", () => {
  const f = fixture("slow-task");
  for (const session of ["", "../escape"]) {
    f.env.CODEX_COMPANION_SESSION_ID = session;
    assert.equal(direct(f.call("task", "--direct", "fixture")).status, "completed");
    assert.equal(fs.existsSync(resolveSessionMarkersRoot(f.env)), false);
  }
  f.env.CODEX_COMPANION_SESSION_ID = "fixture-session";
  const root = resolveSessionMarkersRoot(f.env); fs.writeFileSync(root, "not a directory");
  const result = f.call("task", "--direct", "fixture");
  assert.equal(direct(result).status, "completed");
  assert.equal(result.stderr.trim().split("\n").length, 1);
  assert.equal(fs.readFileSync(root, "utf8"), "not a directory");
});

test("SessionStart exports the absolute companion path and prunes only stale markers without following symlinks", async t => {
  const f = fixture("slow-task"), root = resolveSessionMarkersRoot(f.env), old = new Date(Date.now() - 31 * 86400000);
  f.env.CLAUDE_CONFIG_DIR = path.join(f.dir, "claude-settings");
  for (const session of ["stale", "fresh", "mixed"]) {
    const directory = path.join(root, session); fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, "job.json"); fs.writeFileSync(file, "{}");
    if (session !== "fresh") fs.utimesSync(file, old, old);
    if (session === "mixed") fs.writeFileSync(path.join(directory, "newer.json"), "{}");
  }
  const withinRetention = path.join(root, "mixed", "eight-days.json");
  fs.writeFileSync(withinRetention, "{}");
  const eightDays = new Date(Date.now() - 8 * 86400000); fs.utimesSync(withinRetention, eightDays, eightDays);
  const staleTemporary = path.join(root, "mixed", ".job.old.tmp"), freshTemporary = path.join(root, "mixed", ".job.new.tmp");
  fs.writeFileSync(staleTemporary, "partial"); fs.utimesSync(staleTemporary, old, old); fs.writeFileSync(freshTemporary, "partial");
  const unrelated = path.join(root, "mixed", "keep.txt"); fs.writeFileSync(unrelated, "keep"); fs.utimesSync(unrelated, old, old);
  const outside = path.join(f.dir, "outside-markers"); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, "old.json"), "{}");
  fs.symlinkSync(outside, path.join(root, "linked-session"));
  f.env.CLAUDE_ENV_FILE = path.join(f.dir, "claude-env");
  const input = JSON.stringify({ session_id: "fixture-session", cwd: f.repo });
  const broker = await readyBroker(f.repo, f.env); t.after(broker.close);
  const started = run(process.execPath, [hook, "SessionStart"], { cwd: f.repo, env: f.env, input });
  assert.equal(started.status, 0, started.stderr);
  await waitUntil(() => {
    const file = path.join(f.env.CODEX_COMPANION_HOME, "duet", "retention.json");
    return fs.existsSync(file) && JSON.parse(fs.readFileSync(file, "utf8")).lastReport;
  });
  const exported = fs.readFileSync(f.env.CLAUDE_ENV_FILE, "utf8");
  assert.ok(exported.split("\n").includes(`export CODEX_COMPANION='${script}'`));
  assert.match(exported, /export CODEX_COMPANION_SESSION_ID='fixture-session'/);
  assert.equal(fs.existsSync(path.join(root, "stale")), false);
  for (const session of ["fresh", "mixed", "linked-session"]) assert.equal(fs.existsSync(path.join(root, session)), true);
  assert.equal(fs.existsSync(path.join(root, "mixed", "job.json")), false);
  assert.equal(fs.readFileSync(path.join(root, "mixed", "newer.json"), "utf8"), "{}");
  assert.equal(fs.existsSync(withinRetention), true, "the former 7-day cutoff no longer applies");
  assert.equal(fs.existsSync(staleTemporary), false); assert.equal(fs.readFileSync(freshTemporary, "utf8"), "partial");
  assert.equal(fs.readFileSync(unrelated, "utf8"), "keep");
  assert.equal(fs.existsSync(path.join(outside, "old.json")), true);
  const markerModule = new URL("../plugins/codex/scripts/lib/session-markers.mjs", import.meta.url).href;
  const racingDirectory = path.join(root, "racing"), stale = path.join(racingDirectory, "old.json"), fresh = path.join(racingDirectory, "new.json");
  fs.mkdirSync(racingDirectory); fs.writeFileSync(stale, "{}"); fs.utimesSync(stale, old, old);
  const raced = run(process.execPath, ["--input-type=module", "-e", `
    import fs from 'node:fs'; import { pruneSessionMarkers } from ${JSON.stringify(markerModule)};
    const stat = fs.lstatSync;
    fs.lstatSync = function(file, ...args) {
      const result = stat.call(this, file, ...args);
      if (file === ${JSON.stringify(stale)}) fs.writeFileSync(${JSON.stringify(fresh)}, 'fresh during prune');
      return result;
    };
    pruneSessionMarkers(30 * 86400000);
  `], { cwd: f.repo, env: f.env });
  assert.equal(raced.status, 0, raced.stderr); assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.readFileSync(fresh, "utf8"), "fresh during prune", "a marker created after the age snapshot survives");
  fs.rmSync(root, { recursive: true }); fs.writeFileSync(root, "unavailable");
  const unavailable = run(process.execPath, [hook, "SessionStart"], { cwd: f.repo, env: f.env, input });
  assert.equal(unavailable.status, 0, unavailable.stderr);
  for (const linked of ["duet", "sessions"]) {
    const symlinked = fixture(), home = symlinked.env.CODEX_COMPANION_HOME, outside = path.join(symlinked.dir, "outside");
    fs.mkdirSync(home); fs.mkdirSync(outside);
    const externalRoot = linked === "duet" ? path.join(outside, "sessions") : outside;
    const externalSession = path.join(externalRoot, "stale"); fs.mkdirSync(externalSession, { recursive: true });
    const externalMarker = path.join(externalSession, "old.json"); fs.writeFileSync(externalMarker, "untouched"); fs.utimesSync(externalMarker, old, old);
    const link = linked === "duet" ? path.join(home, "duet") : path.join(home, "duet", "sessions");
    fs.mkdirSync(path.dirname(link), { recursive: true }); fs.symlinkSync(outside, link);
    const attempted = run(process.execPath, ["--input-type=module", "-e", `
      import { writeSessionMarker, pruneSessionMarkers } from ${JSON.stringify(markerModule)};
      pruneSessionMarkers(30 * 86400000);
      writeSessionMarker({ sessionId: 'new-session', id: 'new-job', workspaceRoot: process.cwd() });
    `], { cwd: symlinked.repo, env: symlinked.env });
    assert.equal(attempted.status, 0); assert.equal(attempted.stdout, "");
    assert.equal(attempted.stderr.trim().split("\n").length, 1);
    assert.equal(fs.readFileSync(externalMarker, "utf8"), "untouched");
    assert.deepEqual(fs.readdirSync(externalRoot), ["stale"], "no marker directory is written outside the isolated home");
  }
});
}
