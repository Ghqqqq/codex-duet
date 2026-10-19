import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolveIsolatedCodexHome } from "./codex-home.mjs";
import { resolveJobsDir } from "./state.mjs";

export function resolveSessionMarkersRoot(env = process.env) {
  return path.join(resolveIsolatedCodexHome(env), "duet", "sessions");
}

const safeSegment = value => typeof value === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(value) && value !== "." && value !== "..";
function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(directory).isDirectory()) throw new Error("Marker directory must not be a symlink.");
  fs.chmodSync(directory, 0o700);
}
function requireCanonicalRoot(root, env = process.env) {
  if (fs.realpathSync(root) !== path.join(fs.realpathSync(resolveIsolatedCodexHome(env)), "duet", "sessions")) {
    throw new Error("Session marker root must stay inside the isolated home without symlinks.");
  }
}

// Pane discovery only: no prompt beyond the existing shortened summary, no
// locks or retries, and no dependency on the pane being installed or running.
export function writeSessionMarker(job) {
  if (!safeSegment(job.sessionId) || !safeSegment(job.id)) return;
  let temporary;
  try {
    const root = resolveSessionMarkersRoot(), directory = path.join(root, job.sessionId);
    privateDirectory(path.dirname(root));
    privateDirectory(root);
    requireCanonicalRoot(root);
    privateDirectory(directory);
    const marker = {
      v: 1,
      jobId: job.id,
      // These are newly created tasks, so their files live in the current
      // state root. Resolving the directory avoids migration/state locks.
      jobFile: path.join(resolveJobsDir(job.workspaceRoot), `${job.id}.json`),
      logFile: job.logFile ? path.resolve(job.logFile) : null,
      title: job.title,
      summary: job.summary,
      ...(job.agentName ? { name: job.agentName } : {}),
      workspaceRoot: path.resolve(job.workspaceRoot),
      createdAt: job.createdAt
    };
    temporary = path.join(directory, `.${job.id}.${randomUUID()}.tmp`);
    fs.writeFileSync(temporary, `${JSON.stringify(marker)}\n`, { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, path.join(directory, `${job.id}.json`));
  } catch (error) {
    try { process.stderr.write(`Session marker not written: ${String(error.message).replace(/[\r\n]+/g, " ")}\n`); } catch { /* best effort */ }
  } finally {
    if (temporary) { try { fs.unlinkSync(temporary); } catch { /* renamed or unavailable */ } }
  }
}

// Both the dry run and pruning inspect only regular files beneath real marker
// directories. Never recursively remove a session: a concurrent writer wins.
export function planSessionMarkers(cutoff, { env = process.env } = {}) {
  const markers = [], errors = [];
  try {
    const root = resolveSessionMarkersRoot(env);
    requireCanonicalRoot(root, env);
    if (!fs.lstatSync(root).isDirectory()) throw new Error("Invalid session marker root.");
    for (const session of fs.readdirSync(root, { withFileTypes: true })) {
      if (!session.isDirectory()) continue;
      const directory = path.join(root, session.name);
      try {
        for (const file of fs.readdirSync(directory, { withFileTypes: true })) {
          if (!file.isFile() || !(file.name.endsWith(".json") || /^\..*\.tmp$/.test(file.name))) continue;
          const target = path.join(directory, file.name), stat = fs.lstatSync(target);
          if (stat.isFile() && stat.mtimeMs < cutoff) markers.push({ path: target, bytes: stat.size });
        }
      } catch (error) { errors.push({ path: directory, message: error.message }); }
    }
  } catch (error) { if (error.code !== "ENOENT") errors.push({ message: error.message }); }
  return { markers, errors };
}

export function pruneSessionMarkers(maxAgeMs, { now = Date.now(), env = process.env, files = null } = {}) {
  const result = { markersDeleted: 0, bytesFreed: 0, errors: [] };
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) return result;
  const cutoff = Number(now) - maxAgeMs;
  const planned = planSessionMarkers(cutoff, { env });
  result.errors.push(...planned.errors);
  const selected = files && new Set(files.map(file => file.path));
  for (const marker of planned.markers) {
    if (selected && !selected.has(marker.path)) continue;
    try {
      const directory = path.dirname(marker.path);
      requireCanonicalRoot(resolveSessionMarkersRoot(env), env);
      if (!fs.lstatSync(directory).isDirectory()) continue;
      const stat = fs.lstatSync(marker.path);
      if (!stat.isFile() || stat.mtimeMs >= cutoff) continue;
      fs.unlinkSync(marker.path);
      result.markersDeleted += 1;
      result.bytesFreed += stat.size;
      try { fs.rmdirSync(directory); }
      catch (error) { if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error; }
    } catch (error) { if (error.code !== "ENOENT") result.errors.push({ path: marker.path, message: error.message }); }
  }
  return result;
}
