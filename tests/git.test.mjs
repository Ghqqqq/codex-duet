import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { collectReviewContext, getWorkingTreeState, resolveReviewTarget } from "../plugins/codex/scripts/lib/git.mjs";
import { snapshotWorkspace } from "../plugins/codex/scripts/lib/workspace-changes.mjs";
import { resolveWorkspaceRoot } from "../plugins/codex/scripts/lib/workspace.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

function git(cwd, ...args) {
  const result = run("git", args, { cwd });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
function repo() {
  const cwd = makeTempDir(); initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "base\n");
  git(cwd, "add", "."); git(cwd, "commit", "-m", "base");
  return cwd;
}

test("review scope follows clean branches and dirty worktrees with bounded inline context", () => {
  const cwd = repo(), branch = "main&branch-helper&x";
  git(cwd, "branch", "-m", branch);
  git(cwd, "update-ref", `refs/remotes/origin/${branch}`, branch);
  git(cwd, "symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${branch}`);
  git(cwd, "checkout", "-b", "feature/test");
  fs.writeFileSync(path.join(cwd, "app.js"), "feature\n");
  git(cwd, "commit", "-am", "feature");
  const clean = resolveReviewTarget(cwd);
  assert.deepEqual([clean.mode, clean.baseRef], ["branch", branch]);
  assert.equal(resolveReviewTarget(cwd, { base: "HEAD~1" }).baseRef, "HEAD~1");
  fs.writeFileSync(path.join(cwd, "app.js"), "INLINE_MARKER\n");
  const dirty = resolveReviewTarget(cwd), inline = collectReviewContext(cwd, dirty);
  assert.equal(dirty.mode, "working-tree");
  assert.equal(inline.inputMode, "inline-diff");
  assert.match(inline.content, /INLINE_MARKER/);
  fs.writeFileSync(path.join(cwd, "app.js"), "x".repeat(512));
  fs.writeFileSync(path.join(cwd, "new.js"), "UNTRACKED_MARKER\n");
  const large = collectReviewContext(cwd, dirty, { maxInlineDiffBytes: 128 });
  assert.equal(large.inputMode, "self-collect");
  assert.doesNotMatch(large.content, /xxx/);
  assert.match(large.content, /UNTRACKED_MARKER/);
  assert.throws(() => resolveReviewTarget(cwd, { base: "missing-base" }));
  git(cwd, "reset", "--hard"); fs.unlinkSync(path.join(cwd, "new.js"));
  git(cwd, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD");
  git(cwd, "update-ref", "-d", `refs/remotes/origin/${branch}`); git(cwd, "branch", "-D", branch);
  assert.throws(() => resolveReviewTarget(cwd));
});

test("nested ignored submodules remain in review scope without initializing absent modules", () => {
  const cwd = repo(), outer = repo(), inner = repo();
  git(outer, "-c", "protocol.file.allow=always", "submodule", "add", inner, "inner");
  git(outer, "config", "-f", ".gitmodules", "submodule.inner.ignore", "all");
  git(outer, "commit", "-am", "inner");
  const module = "vendor/child module";
  git(cwd, "-c", "protocol.file.allow=always", "submodule", "add", outer, module);
  git(cwd, "commit", "-am", "outer");
  git(cwd, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive");
  git(cwd, "config", `submodule.${module}.ignore`, "all");
  git(cwd, "config", "status.showUntrackedFiles", "no");
  const nested = path.join(cwd, module, "inner"), file = path.join(nested, "new.js");
  assert.equal(getWorkingTreeState(cwd).isDirty, false);
  fs.writeFileSync(file, "NESTED_REVIEW_CHANGE\n");
  assert.equal(git(cwd, "status", "--porcelain=v2", "--ignore-submodules=none"), "");
  assert.equal(getWorkingTreeState(cwd).isDirty, true);
  assert.equal(resolveReviewTarget(cwd).mode, "working-tree");
  const context = collectReviewContext(cwd, { mode: "working-tree" });
  assert.equal(context.inputMode, "self-collect");
  assert.deepEqual(context.changedFiles, [module, `${module}/inner`]);
  assert.deepEqual(context.omittedSubmodules, context.changedFiles);
  fs.unlinkSync(file);
  assert.equal(getWorkingTreeState(cwd).isDirty, false);
  git(cwd, "-C", module, "submodule", "deinit", "--force", "inner");
  assert.deepEqual(collectReviewContext(cwd, { mode: "working-tree" }).omittedSubmodules, []);
  assert.equal(fs.existsSync(path.join(nested, ".git")), false);
});

test("branch review includes committed ignored submodules and bounds their inline diffs", () => {
  const cwd = repo(), child = repo(), module = "child";
  git(cwd, "-c", "protocol.file.allow=always", "submodule", "add", child, module);
  git(cwd, "commit", "-am", "add child");
  git(cwd, "checkout", "-b", "feature/submodule");
  fs.writeFileSync(path.join(child, "app.js"), "COMMITTED_SUBMODULE_REVIEW_MARKER\n");
  git(child, "commit", "-am", "child change");
  git(cwd, "-C", module, "fetch");
  git(cwd, "-C", module, "checkout", "origin/main");
  git(cwd, "commit", "-am", "bump child");
  git(cwd, "config", `submodule.${module}.ignore`, "all");
  const target = resolveReviewTarget(cwd, { base: "main" });
  const context = collectReviewContext(cwd, target);
  assert.deepEqual(context.changedFiles, [module]);
  assert.equal(context.inputMode, "inline-diff");
  assert.match(context.content, /COMMITTED_SUBMODULE_REVIEW_MARKER/);
  const diff = git(cwd, "diff", "--binary", "--no-ext-diff", "--submodule=diff", "--ignore-submodules=none", "main...HEAD");
  assert.equal(context.diffBytes, Buffer.byteLength(diff));
  const bounded = collectReviewContext(cwd, target, { maxInlineDiffBytes: 128 });
  assert.equal(bounded.inputMode, "self-collect");
  assert.match(bounded.content, /child \|/);
  assert.doesNotMatch(bounded.content, /COMMITTED_SUBMODULE_REVIEW_MARKER/);
  assert.equal(collectReviewContext(cwd, target, { maxInlineFiles: 0 }).inputMode, "self-collect");
});

test("untracked review context is byte and count bounded and never follows unsafe paths", t => {
  const cwd = repo(), target = { mode: "working-tree" };
  for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(cwd, `new-${i}.txt`), "x".repeat(24000));
  const bounded = collectReviewContext(cwd, target);
  assert.ok(bounded.untrackedInlineBytes <= 256 * 1024);
  assert.equal(bounded.untrackedInlineFiles + bounded.omittedUntracked.length, 40);
  assert.ok(bounded.omittedUntracked.length > 0);
  for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(cwd, `new-${i}.txt`), "small");
  assert.equal(collectReviewContext(cwd, target).untrackedInlineFiles, 32);
  for (let i = 0; i < 40; i++) fs.unlinkSync(path.join(cwd, `new-${i}.txt`));
  const nested = path.join(cwd, ".claude", "worktrees", "agent");
  fs.mkdirSync(nested, { recursive: true }); initGitRepo(nested);
  fs.writeFileSync(path.join(nested, "private.txt"), "NESTED_PRIVATE_SENTINEL");
  fs.symlinkSync("missing-target", path.join(cwd, "broken-link"));
  const context = collectReviewContext(cwd, target);
  assert.doesNotMatch(context.content, /NESTED_PRIVATE_SENTINEL/);
  assert.ok(context.content.includes("broken-link"));
  fs.unlinkSync(path.join(cwd, "broken-link"));
  fs.rmSync(path.join(cwd, ".claude"), { recursive: true });
  const leaf = path.join(fs.realpathSync(cwd), "new.txt"), outside = path.join(makeTempDir(), "outside.txt");
  fs.writeFileSync(outside, "OUTSIDE_SENTINEL");
  const open = fs.openSync, read = fs.readSync;
  for (const mutation of ["symlink-before-open", "symlink-after-read", "grow-before-open", "grow-before-read", "replace-after-read"]) {
    fs.rmSync(leaf, { force: true }); fs.writeFileSync(leaf, "small");
    let mutated = false, watchedFd, bytesRead = 0;
    const mutate = () => {
      mutated = true;
      if (mutation.startsWith("symlink")) { fs.unlinkSync(leaf); fs.symlinkSync(outside, leaf); }
      else if (mutation.startsWith("grow")) fs.writeFileSync(leaf, Buffer.alloc(8 * 1024 * 1024, 65));
      else { fs.unlinkSync(leaf); fs.writeFileSync(leaf, "replacement"); }
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
      if (fd === watchedFd) { bytesRead += count; if (!mutated && mutation.endsWith("after-read")) mutate(); }
      return count;
    });
    const collected = collectReviewContext(cwd, target); t.mock.restoreAll();
    assert.equal(mutated, true);
    assert.ok(bytesRead <= 24 * 1024 + 1);
    assert.equal(collected.untrackedInlineFiles, 0);
    assert.equal(collected.untrackedInlineBytes, 0);
    assert.equal(collected.omittedUntracked.length, 1);
    assert.equal(collected.omittedUntracked[0].path, "new.txt");
    assert.doesNotMatch(collected.content, /OUTSIDE_SENTINEL/);
  }
});

test("workspace roots preserve trailing spaces and nested callers cannot select sibling repositories", () => {
  const parent = makeTempDir(), cwd = path.join(parent, "trailing-space "), sibling = cwd.slice(0, -1);
  fs.mkdirSync(cwd); initGitRepo(cwd); fs.mkdirSync(sibling); initGitRepo(sibling);
  fs.writeFileSync(path.join(cwd, "own.txt"), "own repository");
  fs.writeFileSync(path.join(sibling, "other.txt"), "other repository");
  const inside = path.join(cwd, "sub"); fs.mkdirSync(inside);
  const context = collectReviewContext(inside, resolveReviewTarget(inside));
  assert.equal(context.repoRoot, fs.realpathSync(cwd));
  assert.equal(resolveWorkspaceRoot(inside), fs.realpathSync(cwd));
  assert.deepEqual(context.changedFiles, ["own.txt"]);
  assert.deepEqual(getWorkingTreeState(inside), getWorkingTreeState(cwd));
  const snapshot = snapshotWorkspace(inside);
  assert.equal(snapshot.status, "complete");
  assert.equal(snapshot.root, fs.realpathSync(cwd));
  assert.deepEqual([...snapshot.files.keys()], ["own.txt"]);
});
