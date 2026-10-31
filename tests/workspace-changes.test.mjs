import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDir, initGitRepo, run } from "./helpers.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { snapshotWorkspace, compareWorkspaceSnapshots, workspaceChangeAttribution } from "../plugins/codex/scripts/lib/workspace-changes.mjs";
import { resolveStateDir } from "../plugins/codex/scripts/lib/state.mjs";

function fixture() {
  const repo = makeTempDir();
  initGitRepo(repo);
  const git = (...args) => {
    const result = run("git", args, { cwd: repo });
    assert.equal(result.status, 0, result.stderr);
  };
  return { repo, git, write: (name, value) => fs.writeFileSync(path.join(repo, name), value) };
}

test("snapshots separate pre-existing dirt from same-size edits, staging, renames, deletions and committed edits", () => {
  const f = fixture();
  for (const name of ["dirty", "untouched", "deleted", "renamed", "staged", "committed"]) f.write(name, "base\n");
  f.git("add", "."); f.git("commit", "-m", "baseline");
  f.write("dirty", "aaaa\n"); f.write("untouched", "preexisting\n"); f.write("staged", "staged before\n");
  f.write("untracked\nfile", "before\n"); f.git("add", "staged");
  const before = snapshotWorkspace(f.repo);
  assert.equal(before.status, "complete");
  f.write("dirty", "bbbb\n");
  f.write("staged", "staged after\n"); f.git("add", "staged");
  fs.unlinkSync(path.join(f.repo, "deleted"));
  fs.renameSync(path.join(f.repo, "renamed"), path.join(f.repo, "new name"));
  f.write("untracked\nfile", "after\n");
  f.write("committed", "committed during turn\n"); f.git("add", "committed"); f.git("commit", "-m", "turn edit");
  const delta = compareWorkspaceSnapshots(before, snapshotWorkspace(f.repo), ["event-only", path.join(fs.realpathSync(f.repo), "dirty")]);
  assert.deepEqual(delta.preExistingChanges, ["dirty", "staged", "untouched", "untracked\nfile"]);
  assert.deepEqual(delta.touchedFiles, ["committed", "deleted", "dirty", "event-only", "new name", "renamed", "staged", "untracked\nfile"]);
  assert.equal(delta.fileTracking.status, "complete");
});

test("snapshots ignore ignored files, do not read symlink targets, and degrade explicitly outside git", (t) => {
  const f = fixture();
  f.write(".gitignore", "ignored\n");
  const external = makeTempDir();
  const target = path.join(external, "target"); fs.writeFileSync(target, "outside\n");
  fs.symlinkSync(target, path.join(f.repo, "link"));
  f.git("add", "."); f.git("commit", "-m", "baseline");
  const before = snapshotWorkspace(f.repo);
  f.write("ignored", "ignore me\n"); fs.writeFileSync(target, "outside changed\n");
  assert.deepEqual(compareWorkspaceSnapshots(before, snapshotWorkspace(f.repo)).touchedFiles, []);
  fs.unlinkSync(path.join(f.repo, "link")); fs.symlinkSync("another-target", path.join(f.repo, "link"));
  assert.deepEqual(compareWorkspaceSnapshots(before, snapshotWorkspace(f.repo)).touchedFiles, ["link"]);
  const unavailable = snapshotWorkspace(makeTempDir());
  assert.equal(unavailable.status, "unavailable");
  const delta = compareWorkspaceSnapshots(unavailable, unavailable, ["event-file"]);
  assert.deepEqual(delta.touchedFiles, ["event-file"]);
  assert.equal(delta.fileTracking.status, "partial");

  const file = path.join(fs.realpathSync(f.repo), "changing");
  const halves = (a, b) => Buffer.concat([Buffer.alloc(65536, a), Buffer.alloc(65536, b)]);
  fs.writeFileSync(file, halves("A", "B"));
  const baseline = snapshotWorkspace(f.repo);
  fs.writeFileSync(file, halves("A", "C"));
  const open = fs.openSync, read = fs.readSync;
  let watchedFd, writes = 0, opens = 0;
  t.mock.method(fs, "openSync", function (name, ...args) {
    const fd = open.call(this, name, ...args);
    if (name === file && (args[0] === "r" || typeof args[0] === "number")) { watchedFd = fd; opens++; }
    return fd;
  });
  t.mock.method(fs, "readSync", function (fd, ...args) {
    const count = read.call(this, fd, ...args);
    if (fd === watchedFd && count && !writes++) fs.writeFileSync(file, halves("D", "B"));
    return count;
  });
  const changed = compareWorkspaceSnapshots(baseline, snapshotWorkspace(f.repo));
  assert.deepEqual(changed.touchedFiles, ["changing"]);
  assert.equal(changed.fileTracking.status, "complete");
  assert.equal(opens, 2);

  // Every sample changes, so the bounded retry must become partial.
  t.mock.method(fs, "readSync", function (fd, ...args) {
    const count = read.call(this, fd, ...args);
    if (fd === watchedFd && count) fs.appendFileSync(file, ".");
    return count;
  });
  opens = 0;
  const unstable = snapshotWorkspace(f.repo);
  assert.equal(opens, 3);
  assert.equal(unstable.status, "partial");
  assert.deepEqual(unstable.unavailablePaths, ["changing"]);
  assert.equal(compareWorkspaceSnapshots(baseline, unstable).fileTracking.status, "partial");
  t.mock.restoreAll();

  let swapped = false;
  t.mock.method(fs, "openSync", function (name, ...args) {
    if (name === file && !swapped) {
      swapped = true;
      fs.unlinkSync(file); fs.symlinkSync(target, file);
    }
    return open.call(this, name, ...args);
  });
  const replacement = snapshotWorkspace(f.repo);
  assert.equal(swapped, true);
  assert.equal(replacement.status, "complete");
  assert.equal(replacement.files.get("changing"), `untracked:symlink:${target}`);
});

test("task reports 26 shell-edited files in an already dirty repository without file-change events", () => {
  const f = fixture();
  for (let i = 0; i < 26; i++) f.write(`file-${i}.txt`, "base\n");
  f.write("untouched.txt", "base\n");
  f.git("add", "."); f.git("commit", "-m", "baseline");
  for (let i = 0; i < 26; i++) f.write(`file-${i}.txt`, "pre-existing edit\n");
  f.write("untouched.txt", "pre-existing untouched\n");
  const bin = makeTempDir(); installFakeCodex(bin, "dirty-workspace-task");
  const script = new URL("../plugins/codex/scripts/codex-companion.mjs", import.meta.url).pathname;
  const result = run(process.execPath, [script, "task", "--write", "--report", "--json", "edit files"], { cwd: f.repo, env: buildEnv(bin) });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  const full = JSON.parse(fs.readFileSync(report.resultFile));
  assert.equal(full.touchedFiles.length, 26);
  assert.equal(full.preExistingChanges.length, 27);
  assert.ok(!full.touchedFiles.includes("untouched.txt"));
  assert.ok(full.preExistingChanges.includes("untouched.txt"));
  assert.equal(report.touchedFilesOmitted, 17);
  assert.equal(report.preExistingChangesOmitted, 24);
  assert.equal(report.fileTrackingStatus, "complete");

  assert.ok(result.stdout.split("\n").length <= 60);
});

test("task reports warn about overlapping writable workers without attributing their edits", (t) => {
  const f = fixture(), workspaceRoot = fs.realpathSync(f.repo);
  const first = { id: "job-first", agentName: "First", workspaceRoot, sandbox: "workspace-write",
    startedAt: "2026-10-01T00:00:00Z", completedAt: "2026-10-01T00:02:00Z", status: "completed" };
  const second = { ...first, id: "job-second", agentName: "Second", sandbox: "danger-full-access",
    startedAt: "2026-10-01T00:01:00Z", completedAt: "2026-10-01T00:03:00Z" };
  const others = [
    { ...second, id: "read-only", sandbox: "read-only", write: true },
    { ...second, id: "earlier", completedAt: first.startedAt, startedAt: "2026-09-30T00:00:00Z" },
    { ...second, id: "queued", status: "queued", startedAt: null },
    { ...second, id: "elsewhere", workspaceRoot: makeTempDir() }
  ];
  assert.deepEqual(workspaceChangeAttribution(first, [first, ...others]), {});
  const fallbackWindow = { ...first, startedAt: null, createdAt: first.startedAt,
    completedAt: null, updatedAt: first.completedAt };
  const fallbackPeer = { ...second, startedAt: null, createdAt: second.startedAt,
    completedAt: null, updatedAt: second.completedAt };
  assert.deepEqual({ disjoint: workspaceChangeAttribution(fallbackWindow, [others[1],
    { ...fallbackPeer, createdAt: "2026-10-01T00:03:00Z" }]),
    overlapping: workspaceChangeAttribution(fallbackWindow, [fallbackPeer]).changedFilesShared },
  { disjoint: {}, overlapping: true });
  for (const [job, peer] of [[first, second], [second, first]]) {
    const shared = workspaceChangeAttribution(job, [first, second, ...others]);
    assert.equal(shared.changedFilesShared, true);
    assert.deepEqual(shared.changedFilesSharedWith, [{ worker: peer.agentName, jobId: peer.id }]);
  }

  const bin = makeTempDir(); installFakeCodex(bin, "dirty-workspace-task");
  const binary = path.join(bin, "codex");
  fs.writeFileSync(binary, fs.readFileSync(binary, "utf8").replace('if (BEHAVIOR === "dirty-workspace-task") {',
    'if (BEHAVIOR === "dirty-workspace-task" && prompt.startsWith("Shared:")) {'));
  const env = buildEnv(bin), script = new URL("../plugins/codex/scripts/codex-companion.mjs", import.meta.url).pathname;
  const call = (...args) => run(process.execPath, [script, ...args], { cwd: f.repo, env });
  const task = name => {
    const response = call("task", "--direct", "--quiet", "--name", name, "--sandbox", "workspace-write", `${name}: Complete the fixture work.`);
    assert.equal(response.status, 0, response.stderr);
    return JSON.parse(response.stdout.trim().split("\n").filter(line => line.startsWith("{")).at(-1));
  };
  const lone = task("Lone");
  assert.equal(Object.hasOwn(lone, "changedFilesShared"), false);
  const stateDir = resolveStateDir(f.repo, env), stateFile = path.join(stateDir, "state.json");
  const state = JSON.parse(fs.readFileSync(stateFile));
  const peer = { ...second, id: "job-overlap", agentName: "Concurrent", jobClass: "task",
    startedAt: "2020-01-01T00:00:00Z", completedAt: "2020-01-01T00:01:00Z", status: "failed",
    updatedAt: new Date().toISOString(),
    recovery: { status: "running", turnStatus: "inProgress" }, result: { failureSource: "transport", turnEnded: false } };
  assert.deepEqual(workspaceChangeAttribution({ ...second, completedAt: first.startedAt }, [first,
    { ...peer, id: "running-unknown", startedAt: null, status: "running" },
    { ...peer, startedAt: null }]).changedFilesSharedWith,
    [{ worker: first.agentName, jobId: first.id }, { worker: peer.agentName, jobId: "running-unknown" },
      { worker: peer.agentName, jobId: peer.id }]);
  const { result: peerResult, ...peerIndex } = peer;
  state.jobs.push(peerIndex);
  fs.writeFileSync(stateFile, JSON.stringify(state));
  fs.writeFileSync(path.join(stateDir, "jobs", `${peer.id}.json`), JSON.stringify(peer));
  assert.equal(workspaceChangeAttribution({ ...first, startedAt: "2026-10-01T00:01:00Z" }, [peerIndex]).changedFilesShared, true);
  const inferred = { ...peerIndex, id: "recent-inferred", status: "completed", completedAt: "2026-09-30T23:59:00Z" };
  const historical = Array.from({ length: 300 }, (_, i) => ({ ...peerIndex, id: `history-${i}`,
    status: "completed", updatedAt: peer.completedAt }));
  const expiredLease = { ...peerIndex, id: "expired-lease", leaseSec: 60,
    updatedAt: "2026-09-30T23:58:00Z" };
  const unresolved = { ...expiredLease, id: "old-unresolved", turnResolution: "unknown",
    recovery: { status: "running", turnStatus: "inProgress" } };
  const inProgress = { ...unresolved, id: "old-in-progress", turnResolution: "in_progress" };
  const trackedModule = new URL("../plugins/codex/scripts/lib/tracked-jobs.mjs", import.meta.url).href;
  const persisted = run(process.execPath, ["--input-type=module", "-e", `
    import { runTrackedJob } from ${JSON.stringify(trackedModule)};
    const RealDate = Date, old = Date.parse(${JSON.stringify(expiredLease.updatedAt)});
    globalThis.Date = class extends RealDate {
      constructor(...args) { super(...(args.length ? args : [old])); }
      static now() { return old; }
    };
    await runTrackedJob(${JSON.stringify({ ...expiredLease, id: "old-inferred", threadId: "peer-thread", turnId: "peer-turn", inferredRecheck: {} })},
      async () => ({ jobStatus: "completed", exitStatus: 0, threadId: "peer-thread", turnId: "peer-turn",
        payload: { inferredCompletion: true, turnEnded: false, rawOutput: "captured answer" } }));
  `], { cwd: f.repo, env });
  const oldInferred = JSON.parse(fs.readFileSync(stateFile)).jobs.find(entry => entry.id === "old-inferred");
  fs.writeFileSync(stateFile, JSON.stringify(state));
  fs.rmSync(path.join(stateDir, "jobs", "old-inferred.json"));
  const unconfirmed = { ...expiredLease, id: "old-unconfirmed", status: "interrupted",
    interruptionReason: "lease_expired", interruptionConfirmed: false };
  const confirmed = { ...unconfirmed, id: "old-confirmed", interruptionConfirmed: true };
  const pending = { ...expiredLease, id: "old-pending", status: "cancelled", recovery: undefined,
    turnSubmission: { at: expiredLease.startedAt } };
  const failedPending = { ...pending, id: "old-failed-pending", status: "failed" };
  const terminal = { ...peerIndex, id: "worker-outcome", status: "needs_input" };
  const candidates = [peerIndex, inferred, ...historical, expiredLease, unresolved, inProgress, oldInferred, unconfirmed, confirmed, pending, failedPending, terminal];
  const privateRecords = new Map(candidates.map(entry => [path.join(stateDir, "jobs", `${entry.id}.json`),
    JSON.stringify({ ...entry, turnId: "peer-turn", result: [peer.id, unresolved.id, inProgress.id].includes(entry.id) ? peerResult :
      { inferredCompletion: true, turnEnded: false, interruptionConfirmed: entry.interruptionConfirmed } })]));
  privateRecords.set(path.join(stateDir, "jobs", `${pending.id}.json`), JSON.stringify(pending));
  privateRecords.set(path.join(stateDir, "jobs", `${failedPending.id}.json`), JSON.stringify(failedPending));
  const read = fs.readFileSync;
  let privateReads = 0;
  t.mock.method(fs, "readFileSync", function (file, ...args) {
    if (privateRecords.has(file)) { privateReads++; return privateRecords.get(file); }
    return read.call(this, file, ...args);
  });
  const bounded = workspaceChangeAttribution(first, candidates);
  t.mock.restoreAll();
  assert.deepEqual({ persisted: persisted.status, inferredResolution: oldInferred.turnResolution,
    privateReads, shared: bounded.changedFilesSharedWith?.map(entry => entry.jobId) },
  { persisted: 0, inferredResolution: "unknown", privateReads: 8,
    shared: [peer.id, inferred.id, unresolved.id, inProgress.id, oldInferred.id, unconfirmed.id, pending.id, failedPending.id] });
  const unchanged = task("Unchanged");
  const unchangedDetails = JSON.parse(call("result", unchanged.jobId, "--details").stdout);
  assert.deepEqual([unchangedDetails.touchedFiles,
    ...["changedFilesShared", "changedFilesNote", "changedFilesSharedWith"].map(key => unchangedDetails[key])],
    [[], undefined, undefined, undefined]);
  const shared = task("Shared");
  assert.equal(shared.changedFilesShared, true);
  assert.ok(shared.changedFilesNote);
  const response = call("result", shared.jobId, "--details");
  assert.equal(response.status, 0, response.stderr);
  const details = JSON.parse(response.stdout);
  assert.equal(details.changedFilesShared, true);
  assert.deepEqual(details.changedFilesSharedWith, [{ worker: peer.agentName, jobId: peer.id }]);
  assert.equal(JSON.parse(fs.readFileSync(details.resultFile)).changedFilesShared, true);
});
