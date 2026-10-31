#!/usr/bin/env node

import { readHookInput as readHookStdin } from "./lib/fs.mjs";
import process from "node:process";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

import { getCodexAvailability } from "./lib/codex.mjs";
import { getWorkingTreeState } from "./lib/git.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import { getConfig, listJobs, unresolvedTask } from "./lib/state.mjs";
import { readStoredJob, sortJobsNewestFirst } from "./lib/job-control.mjs";
import { SESSION_ID_ENV } from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const STOP_HOOK_TIMEOUT_MS = 15 * 60 * 1000; // hooks.json host timeout
const STOP_REVIEW_EXIT_MARGIN_MS = 30 * 1000;
// Module loading, input reading and readiness probes spend the review's budget.
const STOP_REVIEW_BUDGET_MS = STOP_HOOK_TIMEOUT_MS - STOP_REVIEW_EXIT_MARGIN_MS;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");
const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";

async function readHookInput() {
  const raw = (await readHookStdin()).trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function emitDecision(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function logNote(message) {
  if (!message) {
    return;
  }
  process.stderr.write(`${message}\n`);
}

function filterJobsForCurrentSession(jobs, input = {}) {
  const sessionId = input.session_id || process.env[SESSION_ID_ENV] || null;
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== "ESRCH"; }
}

function isWritableTask(job) {
  const sandbox = job.sandbox ?? job.request?.sandbox;
  return job.jobClass === "task" && (sandbox ? sandbox !== "read-only" : Boolean(job.write));
}

function hasValidOwnerLease(job) {
  const expiresAt = Number.isFinite(job.leaseExpiresAt) ? job.leaseExpiresAt
    : Date.parse(job.updatedAt ?? job.createdAt) + (job.leaseSec ?? 180) * 1000;
  return expiresAt > Date.now();
}

function isRunningWriter(job) {
  if (!isWritableTask(job)) return false;
  const active = job.status === "running" || job.status === "queued";
  if (active && processAlive(job.pid)) return true;
  // A live launcher retains its reservation; otherwise use the normal launch grace.
  if (job.status === "queued" && (processAlive(job.launcherPid) || Date.now() - Date.parse(job.createdAt) < 60000)) return true;
  // A wrapper can die after acceptance but before saving the turn handle.
  // Its owner lease bounds how long that record can defer the gate.
  return (!active || Boolean(job.turnId || job.result) || hasValidOwnerLease(job)) && unresolvedTask(job);
}

function isCleanWorkspace(cwd) {
  const deadline = Math.min(STOP_REVIEW_BUDGET_MS, performance.now() + 10000);
  const remaining = () => Math.floor(deadline - performance.now());
  if (remaining() <= 0) return false;
  try {
    return !getWorkingTreeState(cwd, remaining()).isDirty;
  } catch { return false; }
}

function buildStopReviewPrompt(input = {}) {
  const lastAssistantMessage = String(input.last_assistant_message ?? "").trim();
  const template = loadPromptTemplate(ROOT_DIR, "stop-review-gate");
  const claudeResponseBlock = lastAssistantMessage
    ? ["Previous Claude response:", lastAssistantMessage].join("\n")
    : "";
  return interpolateTemplate(template, {
    CLAUDE_RESPONSE_BLOCK: claudeResponseBlock
  });
}

function buildSetupNote(cwd) {
  // Availability probes accept a wall-clock deadline; derive it from the
  // remaining monotonic budget without using it for the review child.
  const deadline = Date.now() + Math.max(0, Math.floor(STOP_REVIEW_BUDGET_MS - performance.now()));
  const availability = getCodexAvailability(cwd, { deadline });
  if (availability.available) {
    return null;
  }

  const detail = availability.detail ? ` ${availability.detail}.` : "";
  return `Codex is not set up for the review gate.${detail} Run /codex:setup.`;
}

function parseStopReviewOutput(rawOutput, jobId) {
  const text = String(rawOutput ?? "").trim();
  if (!text) {
    return {
      ok: false,
      kind: "failure",
      reason:
        "The stop-time Codex review task returned no final output. Run /codex:review --wait manually or bypass the gate."
    };
  }

  const firstLine = text.split(/\r?\n/, 1)[0].trim();
  if (firstLine.startsWith("ALLOW:")) {
    return { ok: true, reason: null };
  }
  if (firstLine.startsWith("BLOCK:") && firstLine.slice("BLOCK:".length).trim()) {
    const reason = text.slice("BLOCK:".length).split(/\r?\n/).slice(0, 4).join("\n").trim();
    return {
      ok: false,
      kind: "findings",
      reason: `Codex stop-time review found issues that still need fixes before ending the session: ${reason}${jobId ? `\nReview job ${jobId}: duet result ${jobId}` : ""}`
    };
  }

  return {
    ok: false,
    kind: "failure",
    reason:
      "The stop-time Codex review task returned an unexpected answer. Run /codex:review --wait manually or bypass the gate."
  };
}

function runStopReview(cwd, input = {}) {
  const scriptPath = path.join(SCRIPT_DIR, "codex-companion.mjs");
  const prompt = buildStopReviewPrompt(input);
  const childEnv = {
    ...process.env,
    CODEX_COMPANION_STOP_REVIEW_GATE: "1",
    ...(input.session_id ? { [SESSION_ID_ENV]: input.session_id } : {})
  };
  const timeoutResult = {
    ok: false,
    kind: "failure",
    reason:
      "The stop-time Codex review task timed out within the 15-minute hook budget. Run /codex:review --wait manually or bypass the gate."
  };
  const timeout = Math.floor(STOP_REVIEW_BUDGET_MS - performance.now());
  if (timeout <= 0) return timeoutResult;
  const result = spawnSync(process.execPath, [scriptPath, "task", "--sandbox", "read-only", "--json", prompt], {
    cwd,
    env: childEnv,
    encoding: "utf8",
    timeout
  });

  if (result.error?.code === "ETIMEDOUT") {
    return timeoutResult;
  }

  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    return {
      ok: false,
      kind: "failure",
      reason: detail
        ? `The stop-time Codex review task failed: ${detail}`
        : "The stop-time Codex review task failed. Run /codex:review --wait manually or bypass the gate."
    };
  }

  try {
    const payload = JSON.parse(result.stdout);
    return parseStopReviewOutput(payload?.rawOutput, payload?.jobId);
  } catch {
    return {
      ok: false,
      kind: "failure",
      reason:
        "The stop-time Codex review task returned invalid JSON. Run /codex:review --wait manually or bypass the gate."
    };
  }
}

async function main() {
  const input = await readHookInput();
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);

  const workspaceJobs = listJobs(workspaceRoot);
  const jobs = sortJobsNewestFirst(filterJobsForCurrentSession(workspaceJobs, input));
  const runningJob = jobs.find((job) => job.status === "queued" || job.status === "running");
  const runningTaskNote = runningJob
    ? `Codex task ${runningJob.id} is still running. Check /codex:status and use /codex:cancel ${runningJob.id} if you want to stop it before ending the session.`
    : null;

  if (!config.stopReviewGate) {
    logNote(runningTaskNote);
    return;
  }

  if (input.stop_hook_active === true) {
    logNote("A Codex stop-time review already ran for this turn. Changes made afterwards are not re-reviewed automatically. Run /codex:review --wait to review them.");
    logNote(runningTaskNote);
    return;
  }

  // Read private records only for active writable tasks and recent ones within
  // their lease; an active job with a live process is a writer whatever its lease.
  // An unreadable record is not evidence of a writer, so the review still runs.
  const writer = workspaceJobs.find(job => {
    const active = job.status === "queued" || job.status === "running";
    if (!isWritableTask(job) || !(active || hasValidOwnerLease(job)) ||
        !["queued", "running", "completed", "failed", "interrupted", "cancelled"].includes(job.status)) return false;
    let stored;
    try { stored = readStoredJob(workspaceRoot, job.id); } catch { return false; }
    return isRunningWriter({ ...job, ...stored });
  });
  if (writer) {
    logNote(`Skipping Codex stop-time review: writable task ${writer.id} is still running in this workspace.`);
    return;
  }

  if (isCleanWorkspace(workspaceRoot)) {
    logNote("Skipping Codex stop-time review: no workspace changes.");
    logNote(runningTaskNote);
    return;
  }

  const setupNote = buildSetupNote(cwd);
  if (setupNote) {
    logNote(setupNote);
    logNote(runningTaskNote);
    return;
  }

  const review = runStopReview(cwd, input);
  if (review.kind === "findings") {
    emitDecision({
      decision: "block",
      reason: runningTaskNote ? `${runningTaskNote} ${review.reason}` : review.reason
    });
    return;
  }

  if (!review.ok) {
    logNote(review.reason);
  }
  logNote(runningTaskNote);
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
