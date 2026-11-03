import fs from "node:fs";
import path from "node:path";

const levels = ["read-only", "workspace-write", "danger-full-access"];
export const PERMISSION_LIMITS = "Maps sandbox and approval requests only; Claude allow/deny rules, the auto-mode classifier and PreToolUse do not apply to Codex actions.";

// This table is independent of the host API and filesystem. An absent mode is
// unknown, never an implicit bypass. Only bypass can use an explicit full grant.
/** @param {{ mode?: string, configuredSandbox?: string, explicitSandbox?: string, isolated?: boolean }} [options] */
export function mapPermissionPolicy({ mode, configuredSandbox, explicitSandbox, isolated = false } = {}) {
  for (const sandbox of [configuredSandbox, explicitSandbox]) {
    if (sandbox !== undefined && !levels.includes(sandbox)) throw new Error("Invalid permission sandbox.");
  }
  let sandbox = "read-only", approvalPolicy = "never";
  if (["default", "acceptEdits", "dontAsk", "auto", "bypassPermissions"].includes(mode)) sandbox = "workspace-write";
  if (mode === "default") approvalPolicy = "untrusted";
  if (mode === "acceptEdits" || mode === "bypassPermissions") approvalPolicy = "on-request";
  if (mode === "bypassPermissions") sandbox = explicitSandbox ?? configuredSandbox ?? "workspace-write";
  if (isolated && sandbox === "danger-full-access") sandbox = "workspace-write";
  if (explicitSandbox !== undefined) sandbox = levels[Math.min(levels.indexOf(sandbox), levels.indexOf(explicitSandbox))];
  if (sandbox === "read-only") approvalPolicy = "never";
  return { mapping: "claude", mode: mode ?? "unknown", sandbox, explicitSandbox: explicitSandbox ?? null, approvalPolicy, forwardActions: approvalPolicy !== "never" };
}

export function pathWithin(root, file) {
  const relative = path.relative(root, file);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** @param {string} cwd @param {{ hostCwd?: string, isolation?: string, worktree?: string }} [options] */
export function permissionWorktree(cwd, { hostCwd = cwd, isolation, worktree } = {}) {
  const host = fs.realpathSync(hostCwd);
  const roots = [];
  for (const candidate of [path.resolve(hostCwd), host]) {
    const parts = candidate.split(path.sep), marker = parts.reduce((found, part, i) => part === ".claude" && parts[i + 1] === "worktrees" && parts[i + 2] ? i : found, -1);
    if (marker >= 0) roots.push(fs.realpathSync(parts.slice(0, marker + 3).join(path.sep)));
  }
  // A lexical alias and the canonical path can name different nested worktrees:
  // keep the narrowest one containing the canonical host cwd. An alias that
  // escapes every detected worktree keeps the first one, so its cwd is refused.
  const containing = roots.filter(root => pathWithin(root, host)).sort((a, b) => b.length - a.length);
  const detected = containing[0] ?? roots[0] ?? null;
  const root = worktree ? fs.realpathSync(worktree) : detected || (isolation === "worktree" ? host : null);
  const realCwd = fs.realpathSync(cwd);
  if (!root) return { cwd: realCwd, worktree: null, writableRoots: [realCwd] };
  if (!pathWithin(root, realCwd)) throw new Error("Native --cwd must remain inside the isolation worktree.");
  const writableRoots = [root], dotGit = path.join(root, ".git");
  if (fs.lstatSync(dotGit, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("Cannot validate a symlinked isolation worktree gitdir.");
  if (fs.statSync(dotGit, { throwIfNoEntry: false })?.isFile()) {
    const match = /^gitdir: (.+)\s*$/.exec(fs.readFileSync(dotGit, "utf8").trim());
    if (!match) throw new Error("Cannot validate the isolation worktree gitdir.");
    const gitdir = fs.realpathSync(path.resolve(root, match[1]));
    const back = fs.realpathSync(path.resolve(gitdir, fs.readFileSync(path.join(gitdir, "gitdir"), "utf8").trim()));
    const common = fs.realpathSync(path.resolve(gitdir, fs.readFileSync(path.join(gitdir, "commondir"), "utf8").trim()));
    if (back !== fs.realpathSync(dotGit) || path.dirname(path.dirname(gitdir)) !== common || path.basename(path.dirname(gitdir)) !== "worktrees") {
      throw new Error("Cannot validate the isolation worktree gitdir back-pointer.");
    }
    // Permit only this worktree's index/state. Shared refs/objects require an
    // explicit per-action approval; granting the common gitdir is too broad.
    if (!pathWithin(root, gitdir)) writableRoots.push(gitdir);
  }
  return { cwd: realCwd, worktree: root, writableRoots };
}

/** @returns {import("../../.generated/app-server-types/v2/SandboxPolicy").SandboxPolicy} */
export function mappedSandboxPolicy(policy) {
  if (policy.sandbox === "danger-full-access") return { type: "dangerFullAccess" };
  if (policy.sandbox === "read-only") return { type: "readOnly", networkAccess: false };
  return { type: "workspaceWrite", writableRoots: policy.writableRoots, networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true };
}

export function mappedSandboxConfig(policy) {
  if (!policy) return {};
  return { sandbox_workspace_write: { writable_roots: policy.writableRoots, network_access: false, exclude_tmpdir_env_var: true, exclude_slash_tmp: true } };
}

// Running turns cannot change sandbox/approval policy. Refuse every changed
// mode (including unknown) instead of trying to infer live host authorization.
export function livePermissionMismatch(previous, current) {
  return current && (!previous || previous.mapping !== current.mapping || previous.mode !== current.mode ||
    levels.indexOf(previous.sandbox) > levels.indexOf(current.sandbox) ||
    JSON.stringify(previous.writableRoots) !== JSON.stringify(current.writableRoots));
}
