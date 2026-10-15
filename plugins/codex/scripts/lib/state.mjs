import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "codex-companion-isolated");
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;
const STATE_BASELINE = Symbol("stateBaseline");
const LOCK_TIMEOUT_MS = 10000;
const LOCK_WAIT = new Int32Array(new SharedArrayBuffer(4));

function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {
      stopReviewGate: false
    },
    jobs: []
  };
}

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  return path.join(stateRoot, `${slug}-${hash}`);
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}

function readState(stateFile) {
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return {
      ...defaultState(),
      ...parsed,
      config: {
        ...defaultState().config,
        ...(parsed.config ?? {})
      },
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
    };
  } catch {
    return defaultState();
  }
}

// Enumerable symbols survive {...state} in SessionEnd, but never enter JSON.
function snapshot(state) {
  return Object.assign(state, { [STATE_BASELINE]: structuredClone(state) });
}

export function loadState(cwd) {
  return snapshot(readState(resolveStateFile(cwd)));
}

function removeFileIfExists(filePath) {
  if (!filePath) return;
  try { fs.unlinkSync(filePath); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}

function removeEmptyDirectory(dir) {
  try { fs.rmdirSync(dir); }
  catch (error) {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error;
  }
}

function reclaimDeadLock(lockDir) {
  let owners;
  try { owners = fs.readdirSync(lockDir); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  for (const owner of owners) {
    const match = /^owner-(\d+)-[a-f0-9-]+$/.exec(owner);
    if (!match) return;
    try { process.kill(Number(match[1]), 0); }
    catch (error) {
      if (error.code === "ESRCH") removeFileIfExists(path.join(lockDir, owner));
    }
  }
  // A new owner's unique marker prevents a concurrent reaper from deleting it.
  removeEmptyDirectory(lockDir);
}

function withStateLock(cwd, action) {
  const stateDir = resolveStateDir(cwd);
  fs.mkdirSync(path.join(stateDir, JOBS_DIR_NAME), { recursive: true });
  const lockDir = path.join(stateDir, ".state-lock");
  const owner = `owner-${process.pid}-${randomUUID()}`;
  const candidate = path.join(stateDir, `.${owner}`);
  fs.mkdirSync(candidate, { mode: 0o700 });
  let acquired = false;
  try {
    fs.writeFileSync(path.join(candidate, owner), "", { flag: "wx", mode: 0o600 });
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    while (!acquired) {
      try {
        // Rename publishes the directory with its owner already present. An
        // existing nonempty lock cannot be replaced, even after a crash.
        fs.renameSync(candidate, lockDir);
        acquired = true;
      } catch (error) {
        if (!["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(error.code)) throw error;
        reclaimDeadLock(lockDir);
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for the Codex job-state lock: ${lockDir}`);
        Atomics.wait(LOCK_WAIT, 0, 0, 10);
      }
    }
    return action(stateDir);
  } finally {
    if (acquired) {
      removeFileIfExists(path.join(lockDir, owner));
      removeEmptyDirectory(lockDir);
    } else {
      removeFileIfExists(path.join(candidate, owner));
      removeEmptyDirectory(candidate);
    }
  }
}

function writeJsonAtomically(filePath, value) {
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, filePath);
  } finally {
    removeFileIfExists(temporary);
  }
}

function pruneJobs(jobs) {
  let historyCount = 0;
  return [...jobs]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    .filter(job => job.status === "queued" || job.status === "running" || historyCount++ < MAX_JOBS);
}

function mergeChangedFields(baseline, requested, current) {
  const merged = { ...current };
  for (const key of new Set([...Object.keys(baseline), ...Object.keys(requested)])) {
    if (Object.hasOwn(baseline, key) === Object.hasOwn(requested, key) && isDeepStrictEqual(baseline[key], requested[key])) continue;
    if (Object.hasOwn(requested, key)) merged[key] = requested[key];
    else delete merged[key];
  }
  return merged;
}

function mergeSnapshot(state, current) {
  const baseline = state[STATE_BASELINE];
  if (!baseline) return state;
  const previousJobs = new Map(baseline.jobs.map(job => [job.id, job]));
  const requestedJobs = new Map((state.jobs ?? []).map(job => [job.id, job]));
  const currentJobs = new Map(current.jobs.map(job => [job.id, job]));
  for (const id of previousJobs.keys()) {
    if (!requestedJobs.has(id)) currentJobs.delete(id);
  }
  for (const [id, job] of requestedJobs) {
    const previous = previousJobs.get(id);
    if (!previous) currentJobs.set(id, { ...currentJobs.get(id), ...job });
    else if (currentJobs.has(id)) currentJobs.set(id, mergeChangedFields(previous, job, currentJobs.get(id)));
  }
  return {
    config: mergeChangedFields(baseline.config, state.config ?? {}, current.config),
    jobs: [...currentJobs.values()]
  };
}

function commitState(stateDir, previousState, state) {
  const nextJobs = pruneJobs(state.jobs ?? []);
  const nextState = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(state.config ?? {})
    },
    jobs: nextJobs
  };

  writeJsonAtomically(path.join(stateDir, STATE_FILE_NAME), nextState);
  const retainedIds = new Set(nextJobs.map((job) => job.id));
  for (const job of previousState.jobs) {
    if (retainedIds.has(job.id)) {
      continue;
    }
    removeFileIfExists(path.join(stateDir, JOBS_DIR_NAME, `${job.id}.json`));
    removeFileIfExists(job.logFile);
    removeFileIfExists(job.rawOutputFile);
    removeFileIfExists(job.resultFile);
  }

  return snapshot(nextState);
}

export function saveState(cwd, state) {
  return withStateLock(cwd, stateDir => {
    const current = readState(path.join(stateDir, STATE_FILE_NAME));
    return commitState(stateDir, current, mergeSnapshot(state, current));
  });
}

export function updateState(cwd, mutate) {
  return withStateLock(cwd, stateDir => {
    const stateFile = path.join(stateDir, STATE_FILE_NAME);
    const previousState = readState(stateFile);
    const state = structuredClone(previousState);
    mutate(state);
    return commitState(stateDir, previousState, state);
  });
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function upsertJob(cwd, jobPatch) {
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
    if (existingIndex === -1) {
      state.jobs.unshift({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...jobPatch
      });
      return;
    }
    state.jobs[existingIndex] = {
      ...state.jobs[existingIndex],
      ...jobPatch,
      updatedAt: timestamp
    };
  });
}

export function listJobs(cwd) {
  return loadState(cwd).jobs;
}

export function setConfig(cwd, key, value) {
  return updateState(cwd, (state) => {
    state.config = {
      ...state.config,
      [key]: value
    };
  });
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

export function writeJobFile(cwd, jobId, payload) {
  return withStateLock(cwd, stateDir => {
    const jobFile = path.join(stateDir, JOBS_DIR_NAME, `${jobId}.json`);
    writeJsonAtomically(jobFile, payload);
    return jobFile;
  });
}

export function readJobFile(jobFile) {
  return JSON.parse(fs.readFileSync(jobFile, "utf8"));
}

export function resolveJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveJobFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}
