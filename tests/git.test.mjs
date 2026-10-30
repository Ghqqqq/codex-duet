import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { collectReviewContext, getWorkingTreeState, resolveReviewTarget } from "../plugins/codex/scripts/lib/git.mjs";
import { snapshotWorkspace } from "../plugins/codex/scripts/lib/workspace-changes.mjs";
import { resolveWorkspaceRoot } from "../plugins/codex/scripts/lib/workspace.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

test("resolveReviewTarget prefers working tree when repo is dirty", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v2');\n");

  const target = resolveReviewTarget(cwd, {});

  assert.equal(target.mode, "working-tree");

  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  const subdir = path.join(cwd, "src");
  fs.mkdirSync(subdir);
  for (let index = 0; index < 40; index += 1) {
    fs.writeFileSync(path.join(cwd, `new-${index}.txt`), "x".repeat(24000));
  }
  assert.deepEqual(resolveReviewTarget(subdir), resolveReviewTarget(cwd));
  assert.deepEqual(getWorkingTreeState(subdir), getWorkingTreeState(cwd));
  assert.equal(resolveReviewTarget(subdir).mode, "working-tree");
  const bounded = collectReviewContext(subdir, resolveReviewTarget(subdir));
  assert.deepEqual(bounded, collectReviewContext(cwd, resolveReviewTarget(cwd)));
  assert.ok(bounded.untrackedInlineBytes <= 256 * 1024);
  assert.equal(bounded.untrackedInlineFiles + bounded.omittedUntracked.length, 40);
  assert.ok(bounded.omittedUntracked.length > 0);
  assert.ok(bounded.omittedUntracked.every(file => file.size === 24000));
  for (let index = 0; index < 40; index += 1) {
    fs.writeFileSync(path.join(cwd, `new-${index}.txt`), "small");
  }
  const countBounded = collectReviewContext(cwd, resolveReviewTarget(cwd));
  assert.equal(countBounded.untrackedInlineFiles, 32);
  assert.equal(countBounded.omittedUntracked.length, 8);
  for (let index = 0; index < 40; index += 1) fs.unlinkSync(path.join(cwd, `new-${index}.txt`));

  run("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd });
  run("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], { cwd });
  assert.equal(resolveReviewTarget(subdir).baseRef, "main");
  run("git", ["branch", "-m", "feature-only"], { cwd });
  assert.equal(resolveReviewTarget(subdir).baseRef, "origin/main");
  assert.equal(collectReviewContext(subdir, resolveReviewTarget(subdir)).fileCount, 0);
  assert.throws(() => resolveReviewTarget(subdir, { base: "missing-base" }));
  run("git", ["update-ref", "-d", "refs/remotes/origin/main"], { cwd });
  assert.throws(() => resolveReviewTarget(subdir));

  const parent = makeTempDir();
  const spaced = path.join(parent, "trailing-space "), sibling = spaced.slice(0, -1);
  fs.mkdirSync(spaced); initGitRepo(spaced);
  fs.mkdirSync(path.join(spaced, "sub"));
  fs.writeFileSync(path.join(spaced, "own.txt"), "own repository");
  for (const withSibling of [false, true]) {
    if (withSibling) {
      fs.mkdirSync(sibling); initGitRepo(sibling);
      fs.writeFileSync(path.join(sibling, "other.txt"), "other repository");
    }
    const inside = path.join(spaced, "sub");
    const context = collectReviewContext(inside, resolveReviewTarget(inside));
    assert.equal(context.repoRoot, fs.realpathSync(spaced));
    assert.equal(resolveWorkspaceRoot(inside), fs.realpathSync(spaced));
    assert.deepEqual(context.changedFiles, ["own.txt"]);
    const snapshot = snapshotWorkspace(inside);
    assert.equal(snapshot.status, "complete");
    assert.equal(snapshot.root, fs.realpathSync(spaced));
    assert.deepEqual([...snapshot.files.keys()], ["own.txt"]);
  }
});

test("resolveReviewTarget falls back to branch diff when repo is clean", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  run("git", ["checkout", "-b", "feature/test"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v2');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "change"], { cwd });

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(target.mode, "branch");
  assert.match(target.label, /main/);

});

test("default branch names with special characters are passed to git literally", () => {
  const cwd = makeTempDir();
  const branchName = "main&branch-helper&x";
  const helperOutputPath = path.join(cwd, "branch-helper-output");
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "branch-helper.cmd"), "@echo branch-helper>branch-helper-output\r\n");
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('base');\n");
  run("git", ["add", "app.js", "branch-helper.cmd"], { cwd });
  run("git", ["commit", "-m", "base"], { cwd });
  run("git", ["branch", "-m", branchName], { cwd, shell: false });
  run("git", ["update-ref", `refs/remotes/origin/${branchName}`, branchName], { cwd, shell: false });
  run("git", ["symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${branchName}`], {
    cwd,
    shell: false
  });
  run("git", ["checkout", "-b", "feature/test"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('feature');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "feature"], { cwd });

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(target.mode, "branch");
  assert.equal(target.baseRef, branchName);

  assert.equal(fs.existsSync(helperOutputPath), false);
});

test("resolveReviewTarget honors explicit base overrides", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  run("git", ["checkout", "-b", "feature/test"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v2');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "change"], { cwd });

  const target = resolveReviewTarget(cwd, { base: "main" });

  assert.equal(target.mode, "branch");
  assert.equal(target.baseRef, "main");
});

test("resolveReviewTarget requires an explicit base when no default branch can be inferred", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  run("git", ["branch", "-m", "feature-only"], { cwd });

  assert.throws(
    () => resolveReviewTarget(cwd, {}),
    /Unable to detect the repository default branch\. Pass --base <ref> or use --scope working-tree\./
  );
});

test("collectReviewContext keeps inline diffs for tiny adversarial reviews", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('INLINE_MARKER');\n");

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(context.inputMode, "inline-diff");
  assert.equal(context.fileCount, 1);

  assert.match(context.content, /INLINE_MARKER/);
});

test("collectReviewContext skips untracked directories in working tree review", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });

  const nestedRepoDir = path.join(cwd, ".claude", "worktrees", "agent-test");
  fs.mkdirSync(nestedRepoDir, { recursive: true });
  initGitRepo(nestedRepoDir);
  fs.writeFileSync(path.join(nestedRepoDir, "private.txt"), "NESTED_PRIVATE_SENTINEL");

  const target = resolveReviewTarget(cwd, { scope: "working-tree" });
  const context = collectReviewContext(cwd, target);

  assert.doesNotMatch(context.content, /NESTED_PRIVATE_SENTINEL/);
});

test("collectReviewContext skips broken untracked symlinks instead of crashing", (t) => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.symlinkSync("missing-target", path.join(cwd, "broken-link"));

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(target.mode, "working-tree");
  assert.ok(context.content.includes("broken-link"));

  fs.unlinkSync(path.join(cwd, "broken-link"));
  const leaf = path.join(fs.realpathSync(cwd), "new.txt");
  const outside = path.join(makeTempDir(), "outside.txt");
  fs.writeFileSync(outside, "outside content");
  const open = fs.openSync, read = fs.readSync;
  for (const mutation of ["symlink-before-open", "symlink-after-read", "grow-before-open", "grow-before-read", "replace-after-read"]) {
    fs.rmSync(leaf, { force: true }); fs.writeFileSync(leaf, "small");
    let mutated = false, watchedFd, bytesRead = 0;
    const mutate = () => {
      mutated = true;
      if (mutation.startsWith("symlink")) {
        fs.unlinkSync(leaf); fs.symlinkSync(outside, leaf);
      } else if (mutation.startsWith("grow")) {
        fs.writeFileSync(leaf, Buffer.alloc(8 * 1024 * 1024, 65));
      } else {
        fs.unlinkSync(leaf); fs.writeFileSync(leaf, "replacement");
      }
    };
    t.mock.method(fs, "openSync", function (name, ...args) {
      if (name === leaf && !mutated && mutation.endsWith("before-open")) mutate();
      const fd = open.call(this, name, ...args);
      if (name === leaf && args[0] !== "w") watchedFd = fd;
      return fd;
    });
    t.mock.method(fs, "readSync", function (fd, ...args) {
      if (fd === watchedFd && !mutated && mutation === "grow-before-read") mutate();
      const count = read.call(this, fd, ...args);
      if (fd === watchedFd) {
        bytesRead += count;
        if (!mutated && mutation.endsWith("after-read")) mutate();
      }
      return count;
    });
    const collected = collectReviewContext(cwd, target);
    t.mock.restoreAll();
    assert.equal(mutated, true);
    assert.ok(bytesRead <= 24 * 1024 + 1);
    assert.equal(collected.untrackedInlineFiles, 0);
    assert.equal(collected.untrackedInlineBytes, 0);
    assert.equal(collected.omittedUntracked.length, 1);
    const omitted = collected.omittedUntracked[0];
    assert.equal(omitted.path, "new.txt");
    if (mutation.startsWith("symlink")) {
      assert.equal(omitted.reason, "symlink, not inlined");
      assert.equal(omitted.size, fs.lstatSync(leaf).size);
    } else if (mutation.startsWith("grow")) {
      assert.equal(omitted.size, 8 * 1024 * 1024);
      assert.ok(omitted.reason.includes("byte limit"));
    }
  }
});

test("collectReviewContext falls back to lightweight context for larger adversarial reviews", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  for (const name of ["a.js", "b.js", "c.js"]) {
    fs.writeFileSync(path.join(cwd, name), `export const value = "${name}-v1";\n`);
  }
  run("git", ["add", "a.js", "b.js", "c.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "a.js"), 'export const value = "SELF_COLLECT_MARKER_A";\n');
  fs.writeFileSync(path.join(cwd, "b.js"), 'export const value = "SELF_COLLECT_MARKER_B";\n');
  fs.writeFileSync(path.join(cwd, "c.js"), 'export const value = "SELF_COLLECT_MARKER_C";\n');

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(context.inputMode, "self-collect");
  assert.equal(context.fileCount, 3);

  assert.doesNotMatch(context.content, /SELF_COLLECT_MARKER_[ABC]/);

});

test("collectReviewContext falls back to lightweight context for oversized single-file diffs", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "export const value = 'v1';\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), `export const value = '${"x".repeat(512)}';\n`);

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target, { maxInlineDiffBytes: 128 });

  assert.equal(context.fileCount, 1);
  assert.equal(context.inputMode, "self-collect");
  assert.ok(context.diffBytes > 128);
  assert.doesNotMatch(context.content, /xxx/);

});

test("collectReviewContext keeps untracked file content in lightweight working tree context", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  for (const name of ["a.js", "b.js"]) {
    fs.writeFileSync(path.join(cwd, name), `export const value = "${name}-v1";\n`);
  }
  run("git", ["add", "a.js", "b.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "a.js"), 'export const value = "TRACKED_MARKER_A";\n');
  fs.writeFileSync(path.join(cwd, "b.js"), 'export const value = "TRACKED_MARKER_B";\n');
  fs.writeFileSync(path.join(cwd, "new-risk.js"), 'export const value = "UNTRACKED_RISK_MARKER";\n');

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(context.inputMode, "self-collect");
  assert.equal(context.fileCount, 3);
  assert.doesNotMatch(context.content, /TRACKED_MARKER_[AB]/);

  assert.match(context.content, /UNTRACKED_RISK_MARKER/);
});
