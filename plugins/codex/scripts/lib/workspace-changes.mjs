import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { getRepoRoot } from "./git.mjs";
import { readJobFile, resolveJobFile, unresolvedTask } from "./state.mjs";

function git(cwd, args) {
  const result = spawnSync("git", args, {
    cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 30000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }
  });
  if (result.error || result.status !== 0) throw new Error("Git snapshot unavailable");
  return result.stdout.split("\0").filter(Boolean);
}

function fingerprint(root, name) {
  const target = path.resolve(root, name);
  const sameVersion = (a, b) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode &&
    a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
  for (let attempt = 0; attempt < 3; attempt++) {
    let fd;
    let inspected = false;
    try {
      const parent = fs.realpathSync(path.dirname(target));
      if (parent !== root && !parent.startsWith(`${root}${path.sep}`)) throw new Error("External symlink parent");
      const file = path.join(parent, path.basename(target));
      const stat = fs.lstatSync(file);
      inspected = true;
      const stillAtPath = (sample) => fs.realpathSync(path.dirname(target)) === parent &&
        fs.realpathSync(parent) === parent && sameVersion(sample, fs.lstatSync(file));
      if (stat.isSymbolicLink()) {
        const link = fs.readlinkSync(file);
        if (stillAtPath(stat)) return `symlink:${link}`;
        continue;
      }
      if (!stat.isFile()) throw new Error("Not a regular file"); // No traversal of submodules/devices.
      // NONBLOCK also prevents a replacement FIFO from stalling before fstat.
      fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
      const before = fs.fstatSync(fd);
      if (!before.isFile() || !sameVersion(stat, before) || !stillAtPath(before)) continue;
      const hash = createHash("sha256");
      const buffer = Buffer.alloc(64 * 1024);
      let bytes = 0, count;
      // Bound a growing file's sample as well as the number of retries.
      while (bytes <= before.size && (count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, before.size + 1 - bytes), null))) {
        hash.update(buffer.subarray(0, count));
        bytes += count;
      }
      const after = fs.fstatSync(fd);
      if (bytes === before.size && sameVersion(before, after) && stillAtPath(after)) {
        return `${after.mode & 0o111}:${hash.digest("hex")}`;
      }
    } catch (error) {
      // An initially absent file is a deletion. A disappearance after inspection
      // is an unstable sample and must not be certified as complete.
      if (attempt === 0 && !inspected && error.code === "ENOENT") throw error;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
  throw new Error("File unavailable or changed during snapshot");
}

// Hash all tracked and nonignored untracked files, including already-dirty
// files. Comparing just git status (or just HEAD) misses edits in dirty trees
// and edits committed during a turn. Index hashes also detect staging changes.
export function snapshotWorkspace(cwd) {
  const snapshot = { status: "complete", files: new Map(), preExistingChanges: [], unavailablePaths: [] };
  try {
    const root = fs.realpathSync(getRepoRoot(cwd));
    snapshot.root = root;
    const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
    const diffArgs = ["--name-only", "--no-ext-diff", "--no-textconv", "--no-renames", "-z"];
    snapshot.preExistingChanges = [...new Set([
      ...git(root, ["diff", ...diffArgs]), ...git(root, ["diff", "--cached", ...diffArgs]), ...untracked
    ])].sort();
    const index = new Map();
    for (const record of git(root, ["ls-files", "--stage", "-z"])) {
      const tab = record.indexOf("\t");
      const name = record.slice(tab + 1);
      index.set(name, `${index.get(name) ?? ""}${record.slice(0, tab)};`);
    }
    for (const name of new Set([...index.keys(), ...untracked])) {
      let content;
      try { content = fingerprint(root, name); }
      catch (error) {
        if (error.code === "ENOENT") content = "missing";
        else {
          snapshot.status = "partial";
          snapshot.unavailablePaths.push(name);
          content = "unavailable";
        }
      }
      snapshot.files.set(name, `${index.get(name) ?? "untracked"}:${content}`);
    }
  } catch {
    snapshot.status = "unavailable";
  }
  return snapshot;
}

export function compareWorkspaceSnapshots(before, after, eventFiles = []) {
  const observed = [];
  if (before.status !== "unavailable" && after.status !== "unavailable") {
    const unavailable = new Set([...before.unavailablePaths, ...after.unavailablePaths]);
    for (const name of new Set([...before.files.keys(), ...after.files.keys()])) {
      if (!unavailable.has(name) && before.files.get(name) !== after.files.get(name)) observed.push(name);
    }
  }
  const root = before.root ?? after.root;
  const normalizedEvents = eventFiles.map(name => root && path.isAbsolute(name) && name.startsWith(`${root}${path.sep}`) ? path.relative(root, name) : name);
  return {
    touchedFiles: [...new Set([...observed, ...normalizedEvents])].sort(),
    preExistingChanges: before.preExistingChanges,
    fileTracking: {
      status: before.status === "complete" && after.status === "complete" ? "complete" : "partial",
      basis: "Before/after content, mode and index hashes plus turn file-change events. Concurrent workspace edits cannot be attributed to one worker; ignored files and submodule contents are not hashed."
    }
  };
}

export function workspaceChangeAttribution(job, jobs) {
  const started = Date.parse(job.startedAt ?? job.createdAt ?? ""), completed = Date.parse(job.completedAt ?? job.updatedAt ?? "");
  const start = Number.isFinite(started) ? started : -Infinity;
  const end = Number.isFinite(completed) ? Math.max(start, completed) : Infinity;
  const overlapping = jobs.filter(other => {
    if (other.id === job.id || other.workspaceRoot !== job.workspaceRoot || other.status === "queued") return false;
    const sandbox = other.sandbox ?? other.request?.sandbox;
    const writable = sandbox ? ["workspace-write", "danger-full-access"].includes(sandbox) : other.write === true || other.request?.write === true;
    if (!writable) return false;
    const otherStart = Date.parse(other.startedAt ?? other.createdAt ?? "");
    if (Number.isFinite(otherStart) && otherStart >= end) return false;
    if (other.status === "running") return true;
    const otherEnd = Date.parse(other.completedAt ?? other.updatedAt ?? "");
    if (Number.isFinite(otherEnd) && start < Math.max(Number.isFinite(otherStart) ? otherStart : -Infinity, otherEnd)) return true;
    if (other.jobClass !== "task" || other.recovered || !["failed", "interrupted", "cancelled", "completed"].includes(other.status)) return false;
    const activity = [other.updatedAt, other.completedAt].map(value => Date.parse(value ?? "")).filter(Number.isFinite);
    const leaseSec = Number(other.leaseSec ?? 1800);
    const possiblyUnresolved = other.result || (other.turnSubmission && !other.turnId) ||
      (other.turnResolution && !["completed", "failed", "interrupted", "notStarted"].includes(other.turnResolution)) ||
      (other.interruptionReason && other.interruptionConfirmed !== true);
    if (!possiblyUnresolved && activity.length && Math.max(...activity) < start - (Number.isFinite(leaseSec) && leaseSec >= 0 ? leaseSec : 1800) * 1000) return false;
    // The index omits result, including inferred completion. Read recent or
    // explicitly uncertain candidates, keeping ordinary old history bounded.
    try {
      const peer = other.result ? other : readJobFile(resolveJobFile(other.workspaceRoot, other.id));
      return unresolvedTask(peer);
    } catch { return false; }
  });
  return overlapping.length ? {
    changedFilesShared: true,
    changedFilesNote: "changedFiles may include other workers' edits.",
    changedFilesSharedWith: overlapping.map(other => ({ worker: other.agentName ?? null, jobId: other.id }))
  } : {};
}
