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
function requireCanonicalRoot(root) {
  if (fs.realpathSync(root) !== path.join(fs.realpathSync(resolveIsolatedCodexHome()), "duet", "sessions")) {
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

export function pruneSessionMarkers(maxAgeMs) {
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) return;
  try {
    const root = resolveSessionMarkersRoot(), cutoff = Date.now() - maxAgeMs;
    requireCanonicalRoot(root);
    if (!fs.lstatSync(root).isDirectory()) return;
    for (const session of fs.readdirSync(root, { withFileTypes: true })) {
      if (!session.isDirectory()) continue;
      try {
        const directory = path.join(root, session.name);
        const files = fs.readdirSync(directory, { withFileTypes: true });
        for (const file of files) {
          // Only markers and abandoned atomic-write temporaries are ours.
          if (!file.isFile() || !(file.name.endsWith(".json") || /^\..*\.tmp$/.test(file.name))) continue;
          const target = path.join(directory, file.name), stat = fs.lstatSync(target);
          if (stat.isFile() && stat.mtimeMs < cutoff) fs.unlinkSync(target);
        }
        // A concurrent writer's fresh marker makes this fail safely.
        fs.rmdirSync(directory);
      } catch { /* A concurrent writer or unavailable directory can wait until next session. */ }
    }
  } catch { /* Missing or unreadable markers never fail SessionStart. */ }
}
