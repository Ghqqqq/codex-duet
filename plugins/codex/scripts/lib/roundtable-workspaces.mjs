import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveIsolatedCodexHome } from "./codex-home.mjs";
import { nearestGitBoundary } from "./workspace.mjs";

const GIT_TIMEOUT_MS = 10000;
function git(cwd, args, env) {
  const result = spawnSync("git", args, { cwd, env: { ...env, GIT_OPTIONAL_LOCKS: "0" }, encoding: "utf8",
    shell: false, windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: GIT_TIMEOUT_MS, killSignal: "SIGKILL" });
  if (result.error) throw result.error;
  return result;
}
function checked(cwd, args, env) {
  const result = git(cwd, args, env);
  if (result.status !== 0) throw new Error(`Roundtable git ${args[0]} failed: ${result.stderr.trim()}`);
  return result.stdout;
}
function ownedPath(room, member, env) {
  const home = resolveIsolatedCodexHome(env);
  const target = path.join(home, "duet", "roundtables", room.roomId, "worktrees", member.persona);
  if (member.workspace.path !== target) throw new Error("Roundtable worktree path does not match its room/member.");
  let current = home;
  for (const part of ["", ...path.relative(home, target).split(path.sep)]) {
    if (part) current = path.join(current, part);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) return false;
    if (!stat.isDirectory()) throw new Error(`Roundtable worktree directory must not be a symlink: ${current}`);
  }
  return true;
}

// The caller owns a newly created, private room directory. No room lock is
// held while Git runs, and the room record is published only after all seats exist.
export function createMemberWorkspaces(room, dir, env = process.env) {
  const source = fs.realpathSync(room.workspaceRoot);
  const repository = git(source, ["rev-parse", "--show-toplevel"], env);
  if (repository.status !== 0) {
    if (nearestGitBoundary(source) || git(source, ["rev-parse", "--is-bare-repository"], env).status === 0) {
      throw new Error("Cannot create roundtable worktrees from this Git repository.");
    }
    for (const member of room.members) member.workspace = { path: source, base: null, shared: true };
    return;
  }
  // A repository without a first commit has nothing to check out; members
  // share the workspace as they do outside Git.
  const head = git(source, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], env);
  if (head.status !== 0) {
    for (const member of room.members) member.workspace = { path: source, base: null, shared: true };
    return;
  }
  const base = head.stdout.trim();
  const parent = path.join(dir, "worktrees");
  fs.mkdirSync(parent, { mode: 0o700 }); // Exclusive: never adopt an existing target.
  for (const member of room.members) {
    const target = path.join(parent, member.persona);
    fs.mkdirSync(target, { mode: 0o700 });
    member.workspace = { path: target, base, shared: false };
    checked(source, ["worktree", "add", "--detach", "--", target, base], env);
    fs.chmodSync(target, 0o700);
  }
}

// Only used before publication, when no member could have been dispatched.
export function rollbackMemberWorkspaces(room, env = process.env) {
  const errors = [];
  for (const member of [...room.members].reverse()) {
    if (!member.workspace || member.workspace.shared) continue;
    try {
      if (!ownedPath(room, member, env)) continue;
      const target = member.workspace.path;
      if (fs.lstatSync(path.join(target, ".git"), { throwIfNoEntry: false })) {
        checked(room.workspaceRoot, ["worktree", "remove", "--force", "--", target], env);
      } else fs.rmSync(target, { recursive: true });
    } catch (error) { errors.push(error.message); }
  }
  if (errors.length) throw new Error(`Roundtable workspace rollback failed: ${errors.join("; ")}`);
}

export function memberWorkspaceStatus(room, member, env = process.env, { commitAfter = 0, commitLimit } = {}) {
  // Older rooms predate owned workspaces; preserve their shared checkout.
  const workspace = member.workspace ?? { path: room.workspaceRoot, base: null, shared: true };
  const result = { ...workspace, head: null, branch: null, commits: [], dirtyFiles: null, hasChanges: null };
  if (workspace.shared) {
    const stat = fs.lstatSync(workspace.path, { throwIfNoEntry: false });
    return { ...result, ...(!stat ? { missing: true } : {}), reason: !stat ? "Shared workspace is missing." : "Shared workspace; never removed by roundtable close." };
  }
  try {
    if (!ownedPath(room, member, env)) return { ...result, missing: true, reason: "Worktree is missing." };
    const marker = fs.lstatSync(path.join(workspace.path, ".git"));
    if (!marker.isFile()) throw new Error("Roundtable worktree .git must be a regular file.");
    const top = checked(workspace.path, ["rev-parse", "--show-toplevel"], env).trim();
    if (fs.realpathSync(top) !== fs.realpathSync(workspace.path)) throw new Error("Roundtable workspace is no longer its own Git worktree.");
    result.head = checked(workspace.path, ["rev-parse", "--verify", "HEAD^{commit}"], env).trim();
    const branch = git(workspace.path, ["symbolic-ref", "--quiet", "--short", "HEAD"], env);
    if (branch.status !== 0 && branch.status !== 1) throw new Error("Cannot inspect roundtable worktree branch.");
    result.branch = branch.status === 0 ? branch.stdout.trim() : null;
    const range = `${workspace.base}..HEAD`;
    result.commits = checked(workspace.path, ["rev-list", ...(commitLimit === undefined ? [] : [`--skip=${commitAfter}`, `--max-count=${commitLimit}`]), range], env).trim().split("\n").filter(Boolean);
    if (commitLimit !== undefined) {
      result.commitCount = Number(checked(workspace.path, ["rev-list", "--count", range], env).trim());
      result.commitsOmitted = Math.max(0, result.commitCount - result.commits.length);
    }
    // Include ignored artifacts too: close must never discard local files.
    const entries = checked(workspace.path, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=traditional", "--ignore-submodules=none"], env).split("\0");
    result.dirtyFiles = 0;
    for (let i = 0; i < entries.length; i++) {
      if (!entries[i]) continue;
      result.dirtyFiles++;
      if (/[RC]/.test(entries[i].slice(0, 2))) i++;
    }
    result.hasChanges = result.head !== workspace.base || result.dirtyFiles > 0 ||
      checked(workspace.path, ["diff", "--name-only", "-z", workspace.base, "--"], env).length > 0;
    return result;
  } catch (error) { return { ...result, hasChanges: null, reason: error.message }; }
}

export function roomWorkspaceStatus(room, env = process.env) {
  return { ...room, members: room.members.map(member => ({ ...member, workspace: memberWorkspaceStatus(room, member, env) })) };
}

export function candidateWorkspaceDiff(room, member, env = process.env) {
  const workspace = memberWorkspaceStatus(room, member, env, { commitLimit: 1 });
  if (workspace.shared || workspace.head === null || workspace.hasChanges === null) return { stat: "", patch: "", truncated: false, reason: workspace.reason };
  const args = ["diff", "--no-ext-diff", "--no-textconv", "--no-color", `${workspace.base}..HEAD`];
  const capture = options => {
    // Both stat and patch are bounded at capture, not only when rendered.
    const result = spawnSync("git", [...args, ...options, "--"], { cwd: workspace.path,
      env: { ...env, GIT_OPTIONAL_LOCKS: "0" }, encoding: "utf8", shell: false, windowsHide: true,
      maxBuffer: 64 * 1024, timeout: GIT_TIMEOUT_MS, killSignal: "SIGKILL" });
    if (result.error && result.error.code !== "ENOBUFS") throw result.error;
    if (!result.error && result.status !== 0) throw new Error(`Roundtable git diff failed: ${result.stderr.trim()}`);
    return result;
  };
  const stats = capture(["--stat"]), lines = stats.stdout.trimEnd().split("\n");
  const statTruncated = stats.error?.code === "ENOBUFS" || lines.length > 40 || Buffer.byteLength(stats.stdout) > 4000;
  const statMarker = "\n[Stat truncated; read full stat with the command below]";
  const prefix = statTruncated ? Buffer.from(lines.slice(0, 39).join("\n")).subarray(0, 4000 - Buffer.byteLength(statMarker)).toString("utf8").replace(/\ufffd$/, "") : stats.stdout;
  const stat = prefix + (statTruncated ? statMarker : "");
  const result = capture([]);
  const truncated = result.error?.code === "ENOBUFS" || result.stdout.length > 8000;
  const marker = "\n[Patch truncated at 8000 characters]";
  const patch = truncated ? result.stdout.slice(0, 8000 - marker.length) + marker : result.stdout;
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  return { stat, statTruncated, patch, truncated,
    statCommand: `git --no-pager -C ${quote(workspace.path)} ${[...args, "--stat", "--"].join(" ")}`,
    command: `git --no-pager -C ${quote(workspace.path)} ${[...args, "--"].join(" ")}` };
}

export function closeMemberWorkspaces(room, env = process.env) {
  const removed = [], kept = [];
  for (const member of room.members) {
    const workspace = { persona: member.persona, ...memberWorkspaceStatus(room, member, env) };
    if (workspace.shared || workspace.hasChanges !== false) { kept.push(workspace); continue; }
    try {
      // No --force: Git checks again and refuses dirty or locked worktrees.
      checked(room.workspaceRoot, ["worktree", "remove", "--", workspace.path], env);
      removed.push(workspace);
    } catch (error) { kept.push({ ...workspace, reason: error.message }); }
  }
  return { removed, kept };
}
