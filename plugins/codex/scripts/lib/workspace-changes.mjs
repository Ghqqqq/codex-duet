import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

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
  const parent = fs.realpathSync(path.dirname(target));
  if (parent !== root && !parent.startsWith(`${root}${path.sep}`)) throw new Error("External symlink parent");
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) return `symlink:${fs.readlinkSync(target)}`;
  if (!stat.isFile()) throw new Error("Not a regular file"); // No traversal of submodules/devices.
  const hash = createHash("sha256");
  const fd = fs.openSync(target, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    let count;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, count));
  } finally { fs.closeSync(fd); }
  return `${stat.mode & 0o111}:${hash.digest("hex")}`;
}

// Hash all tracked and nonignored untracked files, including already-dirty
// files. Comparing just git status (or just HEAD) misses edits in dirty trees
// and edits committed during a turn. Index hashes also detect staging changes.
export function snapshotWorkspace(cwd) {
  const snapshot = { status: "complete", files: new Map(), preExistingChanges: [], unavailablePaths: [] };
  try {
    const root = fs.realpathSync(git(cwd, ["rev-parse", "--show-toplevel"])[0].trimEnd());
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
