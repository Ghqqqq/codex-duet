import fs from "node:fs";
import process from "node:process";

import { readJobFile, resolveJobFile, resolveJobLogFile, upsertJob, writeJobFile, updateJob } from "./state.mjs";
import { recordFinishedJob, continuationReport, leaseExpiryReport } from "./job-runtime.mjs";
import { appendActivity } from "./activity.mjs";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";

let diagnosticFailureReported = false;

// Only optional diagnostics belong here; required job/result writes must fail.
export function bestEffortDiagnostic(publish) {
  try { publish(); }
  catch {
    if (diagnosticFailureReported) return;
    diagnosticFailureReported = true;
    // A fixed, synchronous note cannot leak payloads or emit an unhandled
    // stream error if stderr is also unavailable.
    try { fs.writeSync(2, "[codex] Optional progress/log output failed; execution continues.\n"); }
    catch { /* Diagnostics must remain optional even when stderr fails. */ }
  }
}

export function nowIso() {
  return new Date().toISOString();
}

function normalizeProgressEvent(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      message: String(value.message ?? "").trim(),
      phase: typeof value.phase === "string" && value.phase.trim() ? value.phase.trim() : null,
      threadId: typeof value.threadId === "string" && value.threadId.trim() ? value.threadId.trim() : null,
      turnId: typeof value.turnId === "string" && value.turnId.trim() ? value.turnId.trim() : null,
      stderrMessage: value.stderrMessage == null ? null : String(value.stderrMessage).trim(),
      logTitle: typeof value.logTitle === "string" && value.logTitle.trim() ? value.logTitle.trim() : null,
      logBody: value.logBody == null ? null : String(value.logBody).trimEnd(),
      timing: value.timing, startupTimings: value.startupTimings, startupWarning: value.startupWarning, item: value.item, activity: value.activity
    };
  }

  return {
    message: String(value ?? "").trim(),
    phase: null,
    threadId: null,
    turnId: null,
    stderrMessage: String(value ?? "").trim(),
    logTitle: null,
    logBody: null
  };
}

export function appendLogLine(logFile, message) {
  const normalized = String(message ?? "").trim();
  if (!logFile || !normalized) {
    return;
  }
  fs.appendFileSync(logFile, `[${nowIso()}] ${normalized}\n`, "utf8");
}

export function appendLogBlock(logFile, title, body) {
  if (!logFile || !body) {
    return;
  }
  fs.appendFileSync(logFile, `\n[${nowIso()}] ${title}\n${String(body).trimEnd()}\n`, "utf8");
}

export function createJobLogFile(workspaceRoot, jobId, title) {
  const logFile = resolveJobLogFile(workspaceRoot, jobId);
  fs.writeFileSync(logFile, "", "utf8");
  if (title) {
    appendLogLine(logFile, `Starting ${title}.`);
  }
  return logFile;
}

export function createJobRecord(base, options = {}) {
  const env = options.env ?? process.env;
  const sessionId = env[options.sessionIdEnv ?? SESSION_ID_ENV];
  return {
    ...base,
    createdAt: nowIso(),
    ...(sessionId ? { sessionId } : {})
  };
}

export function createJobProgressUpdater(workspaceRoot, jobId) {
  let lastPhase = null;
  let lastThreadId = null;
  let lastTurnId = null;
  let pendingHandles = {};

  return (event) => {
    const normalized = normalizeProgressEvent(event);
    const patch = { id: jobId };
    let changed = false;

    if (normalized.phase && normalized.phase !== lastPhase) {
      lastPhase = normalized.phase;
      patch.phase = normalized.phase;
      changed = true;
    }

    if (normalized.threadId && normalized.threadId !== lastThreadId) {
      lastThreadId = normalized.threadId;
      pendingHandles.threadId = normalized.threadId;
    }

    if (normalized.turnId && normalized.turnId !== lastTurnId) {
      lastTurnId = normalized.turnId;
      pendingHandles.turnId = normalized.turnId;
    }

    // Keep recovery handles across failed diagnostic writes, including when
    // later progress events do not repeat the thread/turn IDs.
    if (Object.keys(pendingHandles).length) {
      Object.assign(patch, pendingHandles);
      changed = true;
    }

    if (normalized.timing || normalized.startupTimings || normalized.startupWarning || normalized.item || normalized.activity?.length) changed = true;
    if (!changed) {
      return;
    }

    updateJob(workspaceRoot, jobId, stored => ({ ...patch,
      ...(normalized.activity?.length ? appendActivity(stored, normalized.activity) : {}),
      startupTimings: { ...stored.startupTimings, ...normalized.startupTimings, ...(normalized.timing ? { [normalized.timing.phase]: normalized.timing } : {}) },
      ...(normalized.startupWarning ? { startupWarning: normalized.startupWarning } : {}),
      ...(normalized.item ? normalized.item.lifecycle === "completed" ? { currentItem: null, completedItems: [...(stored.completedItems ?? []), normalized.item].slice(-4) } : { currentItem: normalized.item } : {})
    }));
    pendingHandles = {};
  };
}

export function createProgressReporter({ stderr = false, logFile = null, onEvent = null } = {}) {
  if (!stderr && !logFile && !onEvent) {
    return null;
  }

  return (eventOrMessage) => bestEffortDiagnostic(() => {
    const event = normalizeProgressEvent(eventOrMessage);
    onEvent?.(event);
    const stderrMessage = event.stderrMessage ?? event.message;
    if (stderr && stderrMessage) {
      // Asynchronous stream errors (EPIPE) must not crash the worker either;
      // a blocking writeSync could stall it behind a reader that stopped.
      if (!process.stderr.listenerCount("error")) process.stderr.on("error", () => {});
      process.stderr.write(`[codex] ${stderrMessage}\n`);
    }
    appendLogLine(logFile, event.message);
    appendLogBlock(logFile, event.logTitle, event.logBody);
  });
}

function readStoredJobOrNull(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

export async function runTrackedJob(job, runner, options = {}) {
  const runningRecord = {
    ...job,
    status: "running",
    startedAt: nowIso(),
    phase: "starting",
    pid: process.pid,
    logFile: options.logFile ?? job.logFile ?? null
  };
  if (readStoredJobOrNull(job.workspaceRoot, job.id)) {
    updateJob(job.workspaceRoot, job.id, () => ({ status: "running", startedAt: runningRecord.startedAt, phase: "starting", pid: process.pid, logFile: runningRecord.logFile }));
  } else {
    writeJobFile(job.workspaceRoot, job.id, runningRecord);
    upsertJob(job.workspaceRoot, runningRecord);
  }
  options.onStarted?.(runningRecord);

  try {
    const execution = await runner();
    let completionStatus = execution.jobStatus ?? (execution.exitStatus === 0 ? "completed" : "failed");
    const reviewArtifacts = job.jobClass === "review"
      ? { rawOutputFile: job.rawOutputFile, resultFile: job.resultFile }
      : {};
    if (job.jobClass === "review") {
      Object.assign(execution.payload, reviewArtifacts);
      fs.writeFileSync(job.rawOutputFile, execution.payload.codex?.stdout ?? execution.payload.rawOutput ?? "", { mode: 0o600 });
      fs.writeFileSync(job.resultFile, `${JSON.stringify(execution.payload, null, 2)}\n`, { mode: 0o600 });
    }
    const completedAt = nowIso();
    let committed;
    while (true) {
      let cleanupThread;
      committed = updateJob(job.workspaceRoot, job.id, current => {
        // Stop acceptance and terminal publication share the job lock. The
        // watchdog may already be closed when cancellation wins this race.
        // A run that already stopped for its own reason (owner stop, lease,
        // signal) keeps it; only a stop accepted after the run ended is applied here.
        const ownReason = execution.payload?.interruptionReason;
        const reason = ownReason ? null : current.cancelRequested?.reason;
        // Either stop still needs the cleanup a finished capture could not send.
        if ((reason || ownReason) && job.jobClass === "task" && execution.threadId && !current.backgroundTerminals) {
          cleanupThread = execution.threadId;
          return null;
        }
        if (reason && job.jobClass === "task") {
          completionStatus = reason === "cancelled_by_user" ? "cancelled" : "interrupted";
          execution.jobStatus = completionStatus;
          execution.exitStatus = 1;
          Object.assign(execution.payload, { status: 1, workerStatus: completionStatus,
            interruptionReason: reason, interruptionConfirmed: Boolean(execution.payload.turnEnded) });
          if (execution.report) Object.assign(execution.report, { status: completionStatus, interruptionReason: reason,
            interruptionConfirmed: execution.payload.interruptionConfirmed }, continuationReport({ ...current, threadId: execution.threadId }),
            leaseExpiryReport({ ...current, result: execution.payload }));
          if (job.resultFile) fs.writeFileSync(job.resultFile, `${JSON.stringify(execution.payload, null, 2)}\n`, { mode: 0o600 });
        }
        return {
          status: completionStatus,
          summary: execution.summary,
          threadId: execution.threadId ?? null,
          turnId: execution.turnId ?? null,
          pid: null,
          phase: completionStatus === "completed" ? "done" : completionStatus,
          completedAt,
          result: execution.payload,
          ...reviewArtifacts,
          report: execution.report ?? null,
          rendered: execution.rendered
        };
      });
      if (!cleanupThread) break;
      // Keep the job active during late-stop cleanup so a successor cannot
      // start on this thread until cleanup and terminal publication finish.
      const { cleanAppServerBackgroundTerminals } = await import("./codex.mjs");
      const backgroundTerminals = await cleanAppServerBackgroundTerminals(job.workspaceRoot, cleanupThread);
      updateJob(job.workspaceRoot, job.id, () => ({ backgroundTerminals, turnInterruptAttempted: false, turnInterrupted: false }));
    }
    recordFinishedJob(committed);
    bestEffortDiagnostic(() => {
      if (job.jobClass === "task") appendLogLine(options.logFile ?? job.logFile ?? null, `Task ${completionStatus}. Final output stored separately.`);
      else appendLogBlock(options.logFile ?? job.logFile ?? null, "Final output", execution.rendered);
    });
    return execution;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const existing = readStoredJobOrNull(job.workspaceRoot, job.id) ?? runningRecord;
    const failure = { status: 1, error: errorMessage, threadId: existing.threadId ?? null, turnId: existing.turnId ?? null,
      ...(error.failureSource === "transport" ? { failureSource: "transport", errorCode: error.code ?? null, turnEnded: false } : {}),
      approvedBrowserOrigins: existing.approvedBrowserOrigins ?? [], approvedComputerApps: existing.approvedComputerApps ?? [] };
    if (job.rawOutputFile && !fs.existsSync(job.rawOutputFile)) fs.writeFileSync(job.rawOutputFile, `${errorMessage}\n`, { mode: 0o600 });
    if (job.resultFile && !fs.existsSync(job.resultFile)) fs.writeFileSync(job.resultFile, `${JSON.stringify(failure)}\n`, { mode: 0o600 });
    const completedAt = nowIso();
    recordFinishedJob(updateJob(job.workspaceRoot, job.id, current => {
      const reason = job.jobClass === "task" ? current.cancelRequested?.reason : null;
      const status = reason ? reason === "cancelled_by_user" ? "cancelled" : "interrupted" : "failed";
      if (reason) {
        Object.assign(failure, { interruptionReason: reason, interruptionConfirmed: false, turnEnded: false, workerStatus: status });
        if (job.resultFile) fs.writeFileSync(job.resultFile, `${JSON.stringify(failure, null, 2)}\n`, { mode: 0o600 });
      }
      return {
        status,
        phase: status,
        errorMessage,
        ...(reason || error.failureSource === "transport" ? { result: failure, turnResolution: "unknown" } : {}),
        pid: null,
        completedAt,
        logFile: options.logFile ?? job.logFile ?? existing.logFile ?? null
      };
    }));
    // updateJob already publishes the record and index under one lock. A
    // second, stale index write could undo a concurrent exact-turn recovery.
    throw error;
  }
}
