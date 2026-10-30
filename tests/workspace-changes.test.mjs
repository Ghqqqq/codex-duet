import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDir, initGitRepo, run } from "./helpers.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { snapshotWorkspace, compareWorkspaceSnapshots } from "../plugins/codex/scripts/lib/workspace-changes.mjs";

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
