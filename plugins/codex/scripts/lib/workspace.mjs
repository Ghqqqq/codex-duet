import fs from "node:fs";
import path from "node:path";
import { ensureGitRepository } from "./git.mjs";

const workspaceRoots = new Map();
const MAX_WORKSPACE_ROOTS = 256;

// The nearest directory at or above `dir` holding a `.git` entry (repository,
// worktree or submodule marker), or null. Pure filesystem; never spawns Git.
export function nearestGitBoundary(dir) {
  for (let current = dir; ; current = path.dirname(current)) {
    if (fs.existsSync(path.join(current, ".git"))) return current;
    if (path.dirname(current) === current) return null;
  }
}

// Git defines the root; the cache only avoids repeated spawns. A hit is
// revalidated against the path's real target and nearest `.git` boundary, so a
// retargeted symlink or a created/removed repository is discovered again.
export function resolveWorkspaceRoot(cwd) {
  let real = null;
  try { real = fs.realpathSync.native(cwd); } catch { /* Missing paths keep their own key. */ }
  const boundary = real && nearestGitBoundary(real);
  const cached = workspaceRoots.get(cwd);
  if (cached && cached.real === real && cached.boundary === boundary) return cached.root;
  let root;
  try {
    root = ensureGitRepository(cwd);
  } catch {
    root = cwd;
  }
  workspaceRoots.delete(cwd);
  if (workspaceRoots.size >= MAX_WORKSPACE_ROOTS) workspaceRoots.delete(workspaceRoots.keys().next().value);
  workspaceRoots.set(cwd, { root, real, boundary });
  return root;
}
