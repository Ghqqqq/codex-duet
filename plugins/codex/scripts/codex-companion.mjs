#!/usr/bin/env node

import { spawnOwned as spawn } from "./lib/process.mjs";
import { isolatedCodexCommand } from "./lib/codex-home.mjs";
import { UNREACHABLE_GUIDANCE } from "./lib/runtime-errors.mjs";
import { getToolAvailability, syncToolConfig } from "./lib/tool-config.mjs";
import { buildWorkerReport, persistTaskArtifacts, taskArtifactPaths } from "./lib/worker-report.mjs";
import { normalizeBrowserOrigins } from "./lib/server-requests.mjs";
import { browserOriginSetup, transportSetup, defaultSandboxSetup, ensureBrowserApproval, SANDBOX_MODES } from "./lib/setup-config.mjs";
import { activityReader, formatActivity, redactActivity, snippet } from "./lib/activity.mjs";
import { JobRuntime, ACTIVE, seconds, ownerId, renewLease, requestCancel, answerQuestion, progressSnapshot, leaseExpiryReport, continuationReport, adoptJob, ownershipNotice, markOwnerAttachment } from "./lib/job-runtime.mjs";
import { updateJob } from "./lib/state.mjs";
import { snapshotWorkspace, compareWorkspaceSnapshots } from "./lib/workspace-changes.mjs";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import {
    buildPersistentTaskThreadName,
    DEFAULT_CONTINUE_PROMPT,
    findLatestTaskThread,
    getCodexAuthStatus,
    getCodexAvailability,
    getSessionRuntimeStatus,
    readAppServerTurn,
    importExternalAgentSession,
    interruptAppServerTurn,
    parseStructuredOutput,
    readOutputSchema,
    runAppServerReview,
    runAppServerTurn
  } from "./lib/codex.mjs";
import { resolveClaudeSessionPath } from "./lib/claude-session-transfer.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import { binaryAvailable, terminateProcessTree } from "./lib/process.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import {
  generateJobId,
  getConfig,
  listJobs,
  setConfig,
  updateState,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob,
  sortJobsNewestFirst
} from "./lib/job-control.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  nowIso,
  runTrackedJob,
  SESSION_ID_ENV
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import {
  renderNativeReviewResult,
  renderReviewResult,
  renderStoredJobResult,
  renderCancelReport,
  renderJobStatusReport,
  renderSetupReport,
  renderStatusReport,
  renderTaskResult
} from "./lib/render.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
const VALID_REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
const MODEL_ALIASES = new Map([["spark", "gpt-5.3-codex-spark"]]);
const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/codex-companion.mjs setup [--sync-tools [--profile chrome|codex-app] [--replace-cua] [--cua-template <file>] [--chatgpt-resources <dir>]] [--default-sandbox read-only|workspace-write|danger-full-access] [--browser-approval never-ask|ask] [--dry-run] [--enable-review-gate|--disable-review-gate] [--json]",
      "  node scripts/codex-companion.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>]",
      "  node scripts/codex-companion.mjs adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [focus text]",
      "  node scripts/codex-companion.mjs task [--report] [--background|--detached|--follow] [--write] [--sandbox <read-only|workspace-write|danger-full-access>] [--approve-browser-origin <origin>]... [--thread <id>|--continue <job-id>|--resume-last|--resume|--fresh] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh|max>] [--fast|--normal] [prompt]",
      "  node scripts/codex-companion.mjs transfer [--source <claude-jsonl>] [--json]",
      "  node scripts/codex-companion.mjs status [job-id|--thread <id>] [--wait] [--all] [--json]",
      "  node scripts/codex-companion.mjs result [job-id|--thread <id>] [--report] [--json]",
      "  node scripts/codex-companion.mjs wait <job-id> [--timeout-sec 570] [--min-interval-sec <s>] [--owner <id>] [--after-question <id>] [--feed-limit 150] [--json] --report",
      "  node scripts/codex-companion.mjs adopt <job-id> [--cwd <path>] [--json]",
      "  node scripts/codex-companion.mjs answer <job-id> --owner <ownerId> --question <id> --json < answer.txt",
      "  node scripts/codex-companion.mjs cancel [job-id] [--json]",
      "  task lifecycle: --detached [--lease-sec 180] [--question-timeout-sec 900] [--owner <id>]; --follow = --detached + wait in one call [--timeout-sec 570]",
      "  setup: --transport http|websocket|status; --allow-browser-origin <origin>; --revoke-browser-origin <origin>; --list-browser-origins"
    ].join("\n")
  );
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

function normalizeRequestedModel(model) {
  if (model == null) {
    return null;
  }
  const normalized = String(model).trim();
  if (!normalized) {
    return null;
  }
  return MODEL_ALIASES.get(normalized.toLowerCase()) ?? normalized;
}

function normalizeReasoningEffort(effort) {
  if (effort == null) {
    return null;
  }
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (!VALID_REASONING_EFFORTS.has(normalized)) {
    throw new Error(
      `Unsupported reasoning effort "${effort}". Use one of: none, minimal, low, medium, high, xhigh, max.`
    );
  }
  return normalized;
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  });
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

async function buildSetupReport(cwd, actionsTaken = []) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const npmStatus = binaryAvailable("npm", ["--version"], { cwd });
  const codexStatus = getCodexAvailability(cwd);
  const authStatus = await getCodexAuthStatus(cwd);
  const config = getConfig(workspaceRoot);

  const nextSteps = [];
  if (!codexStatus.available) {
    nextSteps.push("Install Codex with `npm install -g @openai/codex`.");
  }
  if (authStatus.status === "unreachable") {
    nextSteps.push(UNREACHABLE_GUIDANCE);
  } else if (authStatus.status === "unknown") {
    nextSteps.push("Inspect the reported runtime error and rerun setup --json; authentication is unknown.");
  } else if (codexStatus.available && authStatus.status === "unauthenticated") {
    nextSteps.push(`Run \`!${isolatedCodexCommand(["login"])}\`.`);
    nextSteps.push(`If browser login is blocked, retry with \`!${isolatedCodexCommand(["login", "--device-auth"])}\`.`);
  }
  if (!config.stopReviewGate) {
    nextSteps.push("Optional: run `/codex:setup --enable-review-gate` to require a fresh review before stop.");
  }

  return {
    ready: nodeStatus.available && codexStatus.available && authStatus.loggedIn,
    node: nodeStatus,
    npm: npmStatus,
    codex: codexStatus,
    auth: authStatus,
    tools: getToolAvailability(),
    sessionRuntime: getSessionRuntimeStatus(process.env, workspaceRoot),
    reviewGateEnabled: Boolean(config.stopReviewGate),
    defaultSandbox: defaultSandboxSetup().defaultSandbox,
    browserOrigins: browserOriginSetup(),
    actionsTaken,
    nextSteps
  };
}

async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "cua-template", "chatgpt-resources", "transport", "profile", "default-sandbox", "browser-approval"],
    repeatableOptions: ["allow-browser-origin", "revoke-browser-origin"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate", "sync-tools", "dry-run", "list-browser-origins", "replace-cua"]
  });

  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw new Error("Choose either --enable-review-gate or --disable-review-gate.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const actionsTaken = [];
  for (const key of ["cua-template", "chatgpt-resources", "profile", "replace-cua"]) {
    if (options[key] !== undefined && !options["sync-tools"]) throw new Error(`--${key} requires --sync-tools.`);
  }
  if (options["default-sandbox"] !== undefined) {
    if (options["sync-tools"] || options.transport !== undefined || options["browser-approval"] !== undefined || options["allow-browser-origin"] || options["revoke-browser-origin"] || options["list-browser-origins"] || options["enable-review-gate"] || options["disable-review-gate"]) throw new Error("Run --default-sandbox separately from other setup changes.");
    const report = defaultSandboxSetup({ mode: options["default-sandbox"], dryRun: Boolean(options["dry-run"]) });
    outputResult(options.json ? report : `${JSON.stringify(report, null, 2)}\n`, options.json);
    return;
  }
  if (options.transport !== undefined || options["browser-approval"] !== undefined || options["allow-browser-origin"] || options["revoke-browser-origin"] || options["list-browser-origins"]) {
    if (options["sync-tools"] || options["enable-review-gate"] || options["disable-review-gate"]) throw new Error("Run transport/browser setup separately from tool sync and review-gate changes.");
    // Validate every supplied origin before any file write.
    const allow = normalizeBrowserOrigins(options["allow-browser-origin"] ?? []), revoke = normalizeBrowserOrigins(options["revoke-browser-origin"] ?? []);
    if (options.transport !== undefined && (allow.length || revoke.length || options["list-browser-origins"] || options["browser-approval"] !== undefined)) throw new Error("Run transport and browser-origin setup separately.");
    const report = options.transport !== undefined ? { transport: transportSetup({ mode: options.transport, dryRun: Boolean(options["dry-run"]) }) }
      : { browserOrigins: browserOriginSetup({ allow, revoke, approval: options["browser-approval"], dryRun: Boolean(options["dry-run"]) }) };
    outputResult(options.json ? report : `${JSON.stringify(report, null, 2)}\n`, options.json);
    return;
  }
  if (options["dry-run"] && !options["sync-tools"]) throw new Error("--dry-run requires --sync-tools.");
  for (const key of ["cua-template", "chatgpt-resources"]) {
    if (options[key] !== undefined) {
      if (!options["sync-tools"]) throw new Error(`--${key} requires --sync-tools.`);
      if (!path.isAbsolute(options[key]) || !options[key].trim()) throw new Error(`--${key} requires an absolute path.`);
    }
  }
  if (options["dry-run"] && (options["enable-review-gate"] || options["disable-review-gate"])) throw new Error("Do not combine --dry-run with review-gate changes.");
  const toolSync = options["sync-tools"] ? syncToolConfig({ dryRun: Boolean(options["dry-run"]), cuaTemplate: options["cua-template"], chatgptResources: options["chatgpt-resources"], profile: options.profile, replaceCua: Boolean(options["replace-cua"]) }) : null;
  // An offline dry run must not start Codex, create its home or refresh auth.
  if (options["dry-run"]) {
    outputResult(options.json ? { toolSync } : `${JSON.stringify(toolSync, null, 2)}\n`, options.json);
    return;
  }

  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", true);
    actionsTaken.push(`Enabled the stop-time review gate for ${workspaceRoot}.`);
  } else if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", false);
    actionsTaken.push(`Disabled the stop-time review gate for ${workspaceRoot}.`);
  }

  const finalReport = await buildSetupReport(cwd, actionsTaken);
  if (toolSync) {
    finalReport.toolSync = toolSync;
    finalReport.actionsTaken.push(`Tool sync: ${toolSync.added.length} added, ${toolSync.present.length} already present, ${toolSync.skipped.length} skipped.${toolSync.backup ? ` Backup: ${toolSync.backup}` : ""}`);
    finalReport.actionsTaken.push(`CUA surfaces: ${toolSync.surfaces.join(", ") || "none"}; backends: ${toolSync.backends.join(", ") || "none"}.`);
    if (toolSync.changed) finalReport.nextSteps.push("Restart the Claude session/shared Codex runtime to load synced tools.");
  }
  outputResult(options.json ? finalReport : renderSetupReport(finalReport), options.json);
}

function buildAdversarialReviewPrompt(context, focusText) {
  const template = loadPromptTemplate(ROOT_DIR, "adversarial-review");
  return interpolateTemplate(template, {
    REVIEW_KIND: "Adversarial Review",
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content
  });
}

function ensureCodexAvailable(cwd) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }
}

function buildNativeReviewTarget(target) {
  if (target.mode === "working-tree") {
    return { type: "uncommittedChanges" };
  }

  if (target.mode === "branch") {
    return { type: "baseBranch", branch: target.baseRef };
  }

  return null;
}

function validateNativeReviewRequest(target, focusText) {
  if (focusText.trim()) {
    throw new Error(
      `\`/codex:review\` now maps directly to the built-in reviewer and does not support custom focus text. Retry with \`/codex:adversarial-review ${focusText.trim()}\` for focused review instructions.`
    );
  }

  const nativeTarget = buildNativeReviewTarget(target);
  if (!nativeTarget) {
    throw new Error("This `/codex:review` target is not supported by the built-in reviewer. Retry with `/codex:adversarial-review` for custom targeting.");
  }

  return nativeTarget;
}

function renderStatusPayload(report, asJson) {
  return asJson ? report : renderStatusReport(report);
}

function isActiveJobStatus(status) {
  return status === "queued" || status === "running";
}

function getCurrentClaudeSessionId() {
  return process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentClaudeSession(jobs) {
  const sessionId = getCurrentClaudeSessionId();
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => (job.sessionId === undefined ? job.ownerId : job.sessionId) === sessionId);
}

function findLatestResumableTaskJob(jobs) {
  return (
    jobs.find(
      (job) =>
        job.jobClass === "task" &&
        job.threadId &&
        job.status !== "queued" &&
        job.status !== "running"
    ) ?? null
  );
}

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  let snapshot = await refreshJobSnapshot(cwd, reference);

  while (isActiveJobStatus(snapshot.job.status) && !ownershipNotice(snapshot.job, options.owner) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    snapshot = await refreshJobSnapshot(cwd, reference);
  }

  return {
    ...snapshot,
    waitTimedOut: isActiveJobStatus(snapshot.job.status),
    timeoutMs
  };
}

async function resolveLatestTrackedTaskThread(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot)).filter((job) => job.id !== options.excludeJobId);
  const visibleJobs = filterJobsForCurrentClaudeSession(jobs);
  const activeTask = visibleJobs.find((job) => job.jobClass === "task" && (job.status === "queued" || job.status === "running"));
  if (activeTask) {
    throw new Error(`Task ${activeTask.id} is still running. Use /codex:status before continuing it.`);
  }

  const trackedTask = findLatestResumableTaskJob(visibleJobs);
  if (trackedTask) {
    return { id: trackedTask.threadId };
  }

  if (sessionId) {
    return null;
  }

  return findLatestTaskThread(workspaceRoot);
}

async function executeReviewRun(request) {
  ensureCodexAvailable(request.cwd);
  ensureGitRepository(request.cwd);

  const target = resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope
  });
  const focusText = request.focusText?.trim() ?? "";
  const reviewName = request.reviewName ?? "Review";
  if (reviewName === "Review") {
    const reviewTarget = validateNativeReviewRequest(target, focusText);
    const result = await runAppServerReview(request.cwd, {
      target: reviewTarget,
      model: request.model,
      onProgress: request.onProgress,
      signal: request.signal
    });
    const payload = {
      review: reviewName,
      target,
      threadId: result.threadId,
      sourceThreadId: result.sourceThreadId,
      turnEnded: Boolean(result.turnEnded),
      codex: {
        status: result.status,
        stderr: result.stderr,
        stdout: result.reviewText,
        reasoning: result.reasoningSummary
      }
    };
    const rendered = renderNativeReviewResult(
      {
        status: result.status,
        stdout: result.reviewText,
        stderr: result.stderr
      },
      { reviewLabel: reviewName, targetLabel: target.label, reasoningSummary: result.reasoningSummary }
    );

    return {
      exitStatus: result.status,
      threadId: result.threadId,
      turnId: result.turnId,
      payload,
      rendered,
      summary: firstMeaningfulLine(result.reviewText, `${reviewName} completed.`),
      jobTitle: `Codex ${reviewName}`,
      jobClass: "review",
      targetLabel: target.label
    };
  }

  const context = collectReviewContext(request.cwd, target);
  const prompt = buildAdversarialReviewPrompt(context, focusText);
  const result = await runAppServerTurn(context.repoRoot, {
    prompt,
    model: request.model,
    sandbox: "read-only",
    outputSchema: readOutputSchema(REVIEW_SCHEMA),
    onProgress: request.onProgress,
    signal: request.signal
  });
  const parsed = parseStructuredOutput(result.finalMessage, {
    status: result.status,
    failureMessage: result.error?.message ?? result.stderr
  });
  const payload = {
    review: reviewName,
    target,
    threadId: result.threadId,
    turnEnded: Boolean(result.turnEnded),
    context: {
      repoRoot: context.repoRoot,
      branch: context.branch,
      summary: context.summary
    },
    codex: {
      status: result.status,
      stderr: result.stderr,
      stdout: result.finalMessage,
      reasoning: result.reasoningSummary
    },
    result: parsed.parsed,
    rawOutput: parsed.rawOutput,
    parseError: parsed.parseError,
    reasoningSummary: result.reasoningSummary
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered: renderReviewResult(parsed, {
      reviewLabel: reviewName,
      targetLabel: context.target.label,
      reasoningSummary: result.reasoningSummary
    }),
    summary: parsed.parsed?.summary ?? parsed.parseError ?? firstMeaningfulLine(result.finalMessage, `${reviewName} finished.`),
    jobTitle: `Codex ${reviewName}`,
    jobClass: "review",
    targetLabel: context.target.label
  };
}


async function executeTaskRun(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  ensureCodexAvailable(request.cwd);

  const taskMetadata = buildTaskRunMetadata({
    prompt: request.prompt,
    resumeLast: Boolean(request.resumeLast || request.threadId)
  });

  let resumeThreadId = request.threadId ?? null;
  if (request.resumeLast) {
    const latestThread = await resolveLatestTrackedTaskThread(workspaceRoot, {
      excludeJobId: request.jobId
    });
    if (!latestThread) {
      throw new Error("No previous Codex task thread was found for this repository.");
    }
    resumeThreadId = latestThread.id;
  }

  if (!request.prompt && !resumeThreadId) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --thread/--resume-last.");
  }

  if (resumeThreadId) {
    // Claim the target before starting a turn. updateState serializes competing
    // workers; unrelated threads remain free to run in parallel.
    updateState(workspaceRoot, (state) => {
      const active = state.jobs.find((job) => {
        if (job.id === request.jobId || job.threadId !== resumeThreadId ||
            !(["queued", "running"].includes(job.status) ||
              (job.status === "failed" && job.turnId && !readStoredJob(workspaceRoot, job.id)?.result))) return false;
        return true; // A dead wrapper may still own a live Codex turn. Recover first.
      });
      if (active) throw new Error(`Codex thread ${resumeThreadId} is already running in task ${active.id}. Wait for that task before continuing this worker.`);
      const current = state.jobs.find((job) => job.id === request.jobId);
      if (!current) throw new Error("The current task record is missing; refusing to resume a thread without tracking its active turn.");
      current.threadId = resumeThreadId;
    });
  }

  const before = snapshotWorkspace(workspaceRoot);
  const sandbox = request.sandbox ?? (request.write ? "workspace-write" : "read-only");
  updateJob(workspaceRoot, request.jobId, () => ({ preExistingChanges: before.preExistingChanges, sandbox, approvalPolicy: "never" }));
  request.onProgress?.(`Sandbox: ${sandbox}; approval policy: never. Captured workspace baseline (${before.status}).`);

  const runtime = new JobRuntime(workspaceRoot, request.jobId, { foreground: !request.detached, onProgress: request.onProgress });
  let result;
  try { result = await runAppServerTurn(workspaceRoot, {
    resumeThreadId,
    prompt: request.report ? `${request.prompt || DEFAULT_CONTINUE_PROMPT}\n\n${loadPromptTemplate(ROOT_DIR, "worker-task")}` : request.prompt,
    defaultPrompt: resumeThreadId ? DEFAULT_CONTINUE_PROMPT : "",
    model: request.model,
    effort: request.effort,
    serviceTier: request.serviceTier,
    sandbox,
    explicitSandbox: Boolean(request.sandbox),
    approvedBrowserOrigins: request.approvedBrowserOrigins ?? [],
    onProgress: request.onProgress,
    signal: runtime.abort.signal,
    onParentQuestion: message => runtime.question(message),
    parentBridge: { cwd: workspaceRoot, questionTimeoutSec: readStoredJob(workspaceRoot, request.jobId)?.questionTimeoutSec ?? 900 },
    persistThread: true,
    threadName: resumeThreadId ? null : buildPersistentTaskThreadName(request.prompt || DEFAULT_CONTINUE_PROMPT)
  }); } catch (error) {
    if (!runtime.reason) throw error;
    const saved = readStoredJob(workspaceRoot, request.jobId);
    result = { status: 1, threadId: saved.threadId, turnId: saved.turnId, finalMessage: "Task interrupted.", touchedFiles: [], turnEnded: false };
  } finally { runtime.close(); }
  if (runtime.reason) Object.assign(result, { interruptionReason: runtime.reason, interruptionConfirmed: Boolean(result.turnEnded), status: 1 });

  Object.assign(result, compareWorkspaceSnapshots(before, snapshotWorkspace(workspaceRoot), result.touchedFiles));
  return buildTaskExecution(result, request, taskMetadata);
}

function buildTaskExecution(result, request, taskMetadata = { title: "Codex Task" }) {
  const rawOutput = typeof result.finalMessage === "string" ? result.finalMessage : "";
  const failureMessage = result.error?.message ?? result.stderr ?? "";
  const rendered = renderTaskResult(
    {
      rawOutput,
      failureMessage,
      reasoningSummary: result.reasoningSummary
    },
    {
      title: taskMetadata.title,
      jobId: request.jobId ?? null,
      write: Boolean(request.write),
      approvedBrowserOrigins: result.approvedBrowserOrigins ?? request.approvedBrowserOrigins ?? []
    }
  );
  const payload = {
    status: result.status,
    jobId: request.jobId,
    threadId: result.threadId,
    turnId: result.turnId,
    rawOutput,
    ...(result.status !== 0 && failureMessage ? { error: failureMessage } : {}),
    touchedFiles: result.touchedFiles,
    preExistingChanges: result.preExistingChanges ?? [],
    fileTracking: result.fileTracking,
    sandbox: result.sandbox ?? request.sandbox ?? "unknown",
    sandboxPolicy: result.sandboxPolicy ?? null,
    approvalPolicy: result.approvalPolicy ?? "unknown",
    model: result.model ?? request.model ?? null,
    effort: result.effort ?? request.effort ?? null,
    serviceTier: result.serviceTier ?? request.serviceTier ?? null,
    approvedBrowserOrigins: result.approvedBrowserOrigins ?? request.approvedBrowserOrigins ?? [],
    commandExecutions: result.commandExecutions ?? [],
    reasoningSummary: result.reasoningSummary,
    startupTimings: result.startupTimings ?? {}, startupWarning: result.startupWarning ?? null,
    turnEnded: Boolean(result.turnEnded),
    interruptionReason: result.interruptionReason ?? null, interruptionConfirmed: result.interruptionConfirmed ?? null
  };
  const trackedJob = readStoredJob(resolveWorkspaceRoot(request.cwd), request.jobId);
  Object.assign(payload, { ownerId: trackedJob?.ownerId ?? null, sessionId: trackedJob?.sessionId ?? null });
  const artifacts = persistTaskArtifacts(resolveWorkspaceRoot(request.cwd), request.jobId, payload);
  const report = buildWorkerReport(payload, { jobId: request.jobId, ...artifacts });
  Object.assign(report, { ownerId: payload.ownerId, sessionId: payload.sessionId }, leaseExpiryReport({ ...trackedJob, threadId: payload.threadId, result: payload }));
  if (payload.interruptionReason) {
    report.status = payload.interruptionReason === "cancelled_by_user" ? "cancelled" : "interrupted";
    // Any interruption leaves a resumable thread; publish the continuation so a
    // replacement worker can pick the task up without reconstructing flags.
    Object.assign(report, continuationReport({ ...trackedJob, id: request.jobId, threadId: payload.threadId, workspaceRoot: resolveWorkspaceRoot(request.cwd) }));
  }
  Object.assign(payload, artifacts, { workerStatus: report.status });

  return {
    exitStatus: report.status === "needs_input" ? 2 : result.status,
    jobStatus: report.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    report,
    rendered,
    summary: snippet(firstMeaningfulLine(redactActivity(rawOutput), firstMeaningfulLine(redactActivity(failureMessage), `${taskMetadata.title} finished.`)), 300),
    jobTitle: taskMetadata.title,
    jobClass: "task",
    write: Boolean(request.write)
  };
}

function buildReviewJobMetadata(reviewName, target) {
  return {
    kind: reviewName === "Adversarial Review" ? "adversarial-review" : "review",
    title: reviewName === "Review" ? "Codex Review" : `Codex ${reviewName}`,
    summary: `${reviewName} ${target.label}`
  };
}

function buildTaskRunMetadata({ prompt, resumeLast = false }) {
  if (!resumeLast && String(prompt ?? "").includes(STOP_REVIEW_TASK_MARKER)) {
    return {
      title: "Codex Stop Gate Review",
      summary: "Stop-gate review of previous Claude turn"
    };
  }

  const title = resumeLast ? "Codex Resume" : "Codex Task";
  const fallbackSummary = resumeLast ? DEFAULT_CONTINUE_PROMPT : "Task";
  return {
    title,
    summary: shorten(redactActivity(prompt || fallbackSummary))
  };
}

function renderQueuedTaskLaunch(payload) {
  return `${payload.title} started in the background as ${payload.jobId}. Check /codex:status ${payload.jobId} for progress.\nApproved browser origins (this job): ${(payload.approvedBrowserOrigins ?? []).join(", ") || "none"}\n`;
}

function getJobKindLabel(kind, jobClass) {
  if (kind === "adversarial-review") {
    return "adversarial-review";
  }
  return jobClass === "review" ? "review" : "rescue";
}

function createCompanionJob({ prefix, kind, title, workspaceRoot, jobClass, summary, write = false }) {
  return createJobRecord({
    id: generateJobId(prefix),
    kind,
    kindLabel: getJobKindLabel(kind, jobClass),
    title,
    workspaceRoot,
    jobClass,
    summary,
    write
  });
}

function createTrackedProgress(job, options = {}) {
  const logFile = options.logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title);
  return {
    logFile,
    progress: createProgressReporter({
      stderr: Boolean(options.stderr),
      logFile,
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id)
    })
  };
}

function buildTaskJob(workspaceRoot, taskMetadata, write, sandbox, approvedBrowserOrigins = [], lifecycle = {}) {
  const job = createCompanionJob({
    prefix: "task",
    kind: "task",
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: "task",
    summary: taskMetadata.summary,
    write
  });
  return { ...job, ownerId: lifecycle.owner ?? ownerId(job.id), sessionId: job.sessionId ?? null, leaseRenewedAt: Date.now(), leaseSec: lifecycle.leaseSec ?? 180, questionTimeoutSec: lifecycle.questionTimeoutSec ?? 900,
    leaseExpiresAt: Date.now() + (lifecycle.leaseSec ?? 180) * 1000,
    sandbox: sandbox ?? (write ? "workspace-write" : "read-only"), approvalPolicy: "never", approvedBrowserOrigins, ...taskArtifactPaths(workspaceRoot, job.id) };
}

function buildTaskRequest({ cwd, model, effort, serviceTier, prompt, write, sandbox, approvedBrowserOrigins = [], resumeLast, threadId, jobId, report, detached = false }) {
  return {
    cwd,
    model,
    effort,
    serviceTier,
    prompt,
    write,
    sandbox,
    approvedBrowserOrigins,
    resumeLast,
    threadId,
    jobId,
    report,
    detached
  };
}

function renderTransferResult(payload) {
  const lines = [
    "Transferred the Claude session into a Codex thread with visible turn history.",
    `Codex session ID: ${payload.threadId}`,
    `Resume in Codex: ${payload.resumeCommand}`
  ];
  return `${lines.join("\n")}\n`;
}

async function executeTransfer(cwd, options = {}) {
  const sourcePath = resolveClaudeSessionPath(cwd, {
    source: options.source
  });
  const result = await importExternalAgentSession(cwd, { sourcePath });
  const payload = {
    threadId: result.threadId,
    resumeCommand: isolatedCodexCommand(["resume", result.threadId]),
    sourcePath,
    sessionId: path.basename(sourcePath, ".jsonl")
  };

  return {
    payload,
    rendered: renderTransferResult(payload)
  };
}

function readTaskPrompt(cwd, options, positionals) {
  if (options["prompt-file"]) {
    return fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  }

  const positionalPrompt = positionals.join(" ");
  return positionalPrompt || readStdinIfPiped();
}

function requireTaskRequest(prompt, resumeLast, threadId) {
  if (!prompt && !resumeLast && !threadId) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --thread/--resume-last.");
  }
}

async function runForegroundCommand(job, runner, options = {}) {
  const { logFile, progress } = createTrackedProgress(job, {
    logFile: options.logFile,
    stderr: true
  });
  const execution = await runTrackedJob(job, () => runner(progress), { logFile, onStarted: () => progress(`Job handle: ${job.id}; log: ${logFile}${job.rawOutputFile ? `; raw output: ${job.rawOutputFile}` : ""}`) });
  outputResult(options.report ? (options.json ? execution.report : `${JSON.stringify(execution.report, null, 2)}\n`) : options.json ? execution.payload : execution.rendered, options.json);
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
  return execution;
}

function spawnDetachedTaskWorker(cwd, jobId) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "codex-companion.mjs");
  const child = spawn(process.execPath, [scriptPath, "task-worker", "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}

function enqueueBackgroundTask(cwd, job, request) {
  const { logFile } = createTrackedProgress(job);
  appendLogLine(logFile, "Queued for background execution.");

  const queuedRecord = {
    ...job,
    status: "queued",
    phase: "queued",
    pid: null,
    logFile,
    request
  };
  writeJobFile(job.workspaceRoot, job.id, queuedRecord);
  upsertJob(job.workspaceRoot, queuedRecord);
  const child = spawnDetachedTaskWorker(cwd, job.id);
  // Publish the request before the child can read it. Do not overwrite a
  // running/completed child record when recording its launch PID.
  updateState(job.workspaceRoot, state => {
    const current = state.jobs.find(candidate => candidate.id === job.id);
    if (current?.status === "queued") current.pid = child.pid ?? null;
  });

  return {
    payload: {
      jobId: job.id,
      ownerId: job.ownerId,
      sessionId: job.sessionId ?? null,
      status: "queued",
      sandbox: job.sandbox,
      approvalPolicy: job.approvalPolicy,
      approvedBrowserOrigins: job.approvedBrowserOrigins ?? [],
      title: job.title,
      summary: job.summary,
      logFile
    },
    logFile
  };
}

async function handleReviewCommand(argv, config) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "cwd"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const focusText = positionals.join(" ").trim();
  const target = resolveReviewTarget(cwd, {
    base: options.base,
    scope: options.scope
  });

  config.validateRequest?.(target, focusText);
  const metadata = buildReviewJobMetadata(config.reviewName, target);
  const job = createCompanionJob({
    prefix: "review",
    kind: metadata.kind,
    title: metadata.title,
    workspaceRoot,
    jobClass: "review",
    summary: metadata.summary
  });
  await runForegroundCommand(
    job,
    async (progress) => {
      const runtime = new JobRuntime(workspaceRoot, job.id, { foreground: true, onProgress: progress });
      let execution;
      try { execution = await executeReviewRun({
        cwd,
        base: options.base,
        scope: options.scope,
        model: options.model,
        focusText,
        reviewName: config.reviewName,
        onProgress: progress,
        signal: runtime.abort.signal
      }); } catch (error) {
        if (!runtime.reason) throw error;
        const stored = readStoredJob(workspaceRoot, job.id);
        execution = { threadId: stored.threadId, turnId: stored.turnId, payload: { turnEnded: false } };
      } finally { runtime.close(); }
      if (runtime.reason) {
        Object.assign(execution.payload, { status: 1, interruptionReason: runtime.reason, interruptionConfirmed: execution.payload.turnEnded === true });
        Object.assign(execution, { exitStatus: 1, jobStatus: runtime.reason === "cancelled_by_user" ? "cancelled" : "interrupted", rendered: "Review interrupted.\n" });
      }
      return execution;
    },
    { json: options.json }
  );
}

async function handleReview(argv) {
  return handleReviewCommand(argv, {
    reviewName: "Review",
    validateRequest: validateNativeReviewRequest
  });
}

async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "effort", "cwd", "prompt-file", "thread", "continue", "sandbox", "lease-sec", "question-timeout-sec", "owner", "timeout-sec", "feed-limit"],
    repeatableOptions: ["approve-browser-origin"],
    booleanOptions: ["json", "report", "write", "resume-last", "resume", "fresh", "background", "detached", "follow", "fast", "normal"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  // --continue <job-id>: one more turn on a stopped/finished job's own thread,
  // inheriting that job's recorded authorization and runtime choices so a
  // replacement worker does not have to reconstruct them.
  const continued = options.continue === undefined ? null : readStoredJob(workspaceRoot, String(options.continue).trim());
  if (options.continue !== undefined) {
    if (!continued) throw new Error(`No stored job found for --continue ${options.continue}.`);
    if (continued.jobClass !== "task" || !continued.threadId) throw new Error(`Job ${continued.id} has no resumable Codex thread; nothing to continue.`);
    if (ACTIVE.has(continued.status)) throw new Error(`Job ${continued.id} is still ${continued.status}; wait for it to end (or cancel it) before continuing its thread.`);
    for (const flag of ["thread", "fresh", "resume", "resume-last", "write", "sandbox", "model", "effort", "fast", "normal"]) {
      if (options[flag] !== undefined) throw new Error(`--continue inherits the original job's ${flag} setting; do not pass --${flag}.`);
    }
    if (options["approve-browser-origin"]?.length) throw new Error("--continue inherits the original job's approved browser origins; do not pass --approve-browser-origin.");
  }
  const approvedBrowserOrigins = continued ? continued.approvedBrowserOrigins ?? [] : normalizeBrowserOrigins(options["approve-browser-origin"] ?? []);
  const lifecycle = { owner: options.owner, leaseSec: seconds(options["lease-sec"] ?? process.env.CODEX_COMPANION_LEASE_SEC, 180, "--lease-sec"), questionTimeoutSec: seconds(options["question-timeout-sec"], 900, "--question-timeout-sec") };
  const model = continued ? continued.request?.model ?? "gpt-6-astra" : normalizeRequestedModel(options.model) ?? "gpt-6-astra";
  const effort = continued ? continued.request?.effort ?? "xhigh" : normalizeReasoningEffort(options.effort) ?? "xhigh";
  if (options.fast && options.normal) throw new Error("Choose either --fast or --normal.");
  const serviceTier = continued ? continued.request?.serviceTier ?? null : options.fast ? "priority" : null;
  const prompt = readTaskPrompt(cwd, options, positionals);

  const resumeLast = Boolean(options["resume-last"] || options.resume);
  const fresh = Boolean(options.fresh);
  const threadId = continued ? continued.threadId : options.thread?.trim() ?? null;
  if (options.thread !== undefined && (!threadId || threadId.startsWith("--"))) {
    throw new Error("Provide a non-empty thread ID for --thread.");
  }
  if (threadId && (fresh || resumeLast)) {
    throw new Error("Choose --thread, --fresh, or --resume/--resume-last; these options cannot be combined.");
  }
  if (resumeLast && fresh) {
    throw new Error("Choose either --resume/--resume-last or --fresh.");
  }
  // Permission model: the parent adjusts Codex's sandbox per call with --sandbox
  // (like choosing a permission mode for a native subagent); without it the
  // configured default applies, which is danger-full-access unless the user ran
  // `setup --default-sandbox`. --write survives as a floor (at least
  // workspace-write) and --write=false as an explicit read-only request.
  let write = continued ? Boolean(continued.write) : Boolean(options.write);
  let sandbox = continued ? continued.sandbox ?? (continued.write ? "workspace-write" : "read-only") : options.sandbox;
  if (sandbox !== undefined && !SANDBOX_MODES.includes(sandbox)) {
    throw new Error("--sandbox must be read-only, workspace-write, or danger-full-access.");
  }
  if (sandbox === "read-only" && write) throw new Error("--sandbox read-only cannot be combined with --write.");
  if (!continued && sandbox === undefined) {
    const configured = defaultSandboxSetup().defaultSandbox;
    if (options.write === false) sandbox = "read-only";
    else if (write && configured === "read-only") sandbox = "workspace-write";
    else sandbox = configured;
  }
  write = sandbox !== "read-only";
  // The browser is unrestricted by default: mirror the saved preference into
  // the browser runtime's own file before Codex starts (a no-op once written).
  try { ensureBrowserApproval(); } catch (error) { process.stderr.write(`Browser approval preference not applied: ${error.message}\n`); }
  const taskMetadata = buildTaskRunMetadata({
    prompt,
    resumeLast: Boolean(resumeLast || threadId)
  });

  if (options.background || options.detached || options.follow) {
    ensureCodexAvailable(cwd);
    requireTaskRequest(prompt, resumeLast, threadId);

    const job = buildTaskJob(workspaceRoot, taskMetadata, write, sandbox, approvedBrowserOrigins, lifecycle);
    const request = buildTaskRequest({
      cwd,
      model,
      effort,
      serviceTier,
      prompt,
      write,
      sandbox,
      approvedBrowserOrigins,
      resumeLast,
      threadId,
      jobId: job.id,
      report: Boolean(options.report || options.detached || options.follow), detached: true
    });
    if (continued) request.continuedFrom = continued.id;
    const { payload } = enqueueBackgroundTask(cwd, job, request);
    if (options.follow) {
      // Native-like single call: submit, then stay attached as the owner until the
      // job ends, needs an answer, or the wait budget runs out.
      await waitForJob(workspaceRoot, job, { owner: job.ownerId, timeoutSec: options["timeout-sec"], feedLimit: options["feed-limit"], json: options.json });
      return;
    }
    if (options.detached) {
      // Return quickly even if a model/provider is slow. Missing handles remain
      // null and are published by wait as soon as the runtime acknowledges them.
      for (const deadline = Date.now() + 1200; Date.now() < deadline;) {
        const current = readStoredJob(workspaceRoot, job.id);
        Object.assign(payload, progressSnapshot(current));
        if (current.turnId || !ACTIVE.has(current.status) || current.pendingQuestion) break;
        await sleep(50);
      }
      payload.ownerId = job.ownerId;
    }
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  const job = buildTaskJob(workspaceRoot, taskMetadata, write, sandbox, approvedBrowserOrigins, lifecycle);
  await runForegroundCommand(
    job,
    (progress) =>
      executeTaskRun({
        cwd,
        model,
        effort,
        serviceTier,
        prompt,
        write,
        sandbox,
        approvedBrowserOrigins,
        resumeLast,
        threadId,
        jobId: job.id,
        report: Boolean(options.report),
        onProgress: progress
      }),
    { json: options.json, report: Boolean(options.report) }
  );
}

async function handleTransfer(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "source"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const { payload, rendered } = await executeTransfer(cwd, {
    source: options.source
  });
  outputCommandResult(payload, rendered, options.json);
}

async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id"]
  });

  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for task-worker.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const storedJob = readStoredJob(workspaceRoot, options["job-id"]);
  if (!storedJob) {
    throw new Error(`No stored job found for ${options["job-id"]}.`);
  }

  const request = storedJob.request;
  if (!request || typeof request !== "object") {
    throw new Error(`Stored job ${options["job-id"]} is missing its task request payload.`);
  }

  const { logFile, progress } = createTrackedProgress(
    {
      ...storedJob,
      workspaceRoot
    },
    {
      logFile: storedJob.logFile ?? null
    }
  );
  await runTrackedJob(
    {
      ...storedJob,
      workspaceRoot,
      logFile
    },
    () =>
      executeTaskRun({
        ...request,
        onProgress: progress
      }),
    { logFile }
  );
}

// Reports stored by earlier releases lack the run settings; fill them from the
// recorded request so task/wait/result --report always show them.
function withRunSettings(report, request) {
  for (const key of ["model", "effort", "serviceTier"]) report[key] ??= request?.[key] ?? null;
  return report;
}

function processAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== "ESRCH"; }
}

async function refreshJobSnapshot(cwd, reference) {
  let snapshot = buildSingleJobSnapshot(cwd, reference);
  const { workspaceRoot, job } = snapshot;
  const stored = readStoredJob(workspaceRoot, job.id);
  if (!stored || stored.result || job.jobClass !== "task" || job.status === "cancelled" || processAlive(job.pid)) return snapshot;
  if (!job.threadId || !job.turnId) {
    return { ...snapshot, recovery: { status: "unknown", detail: "No exact thread/turn handle was recorded. Inspect the job log; do not automatically rerun the task." } };
  }
  try {
    const result = await readAppServerTurn(cwd, job);
    if (!result) return { ...snapshot, recovery: { status: "unknown", detail: "The recorded turn is not readable. It may not have been persisted; do not automatically rerun it." } };
    if (result.turnStatus === "inProgress") return { ...snapshot, recovery: { status: "running", detail: "The wrapper stopped; the recorded Codex turn is still in progress." } };
    if (!["completed", "failed", "interrupted"].includes(result.turnStatus)) return { ...snapshot, recovery: { status: "unknown", detail: `Unrecognized turn status: ${result.turnStatus}` } };
    // A later recovery cannot compare against the current tree: subsequent
    // turns may have edited it. Keep exact-turn events and mark coverage partial.
    Object.assign(result, {
      preExistingChanges: stored.preExistingChanges ?? [],
      fileTracking: { status: "partial", basis: "Recovered exact-turn file-change events only; no end-of-turn workspace snapshot survived." },
      sandbox: stored.sandbox ?? "unknown", approvalPolicy: stored.approvalPolicy ?? "unknown",
      approvedBrowserOrigins: stored.approvedBrowserOrigins ?? []
    });
    const execution = buildTaskExecution(result, { cwd, jobId: job.id, write: job.write, model: stored.request?.model, effort: stored.request?.effort, serviceTier: stored.request?.serviceTier });
    const completedAt = nowIso();
    const patch = { status: execution.jobStatus, phase: execution.jobStatus === "completed" ? "done" : execution.jobStatus, pid: null, completedAt, summary: execution.summary, recovered: true, rawOutputFile: execution.payload.rawOutputFile, resultFile: execution.payload.resultFile };
    updateJob(workspaceRoot, job.id, () => ({ ...patch, result: execution.payload, report: execution.report, rendered: execution.rendered }));
    upsertJob(workspaceRoot, { id: job.id, ...patch });
    appendLogLine(job.logFile, `Recovered recorded turn ${job.turnId}; status ${execution.jobStatus}. No new turn submitted.`);
    snapshot = buildSingleJobSnapshot(cwd, job.id);
    return { ...snapshot, recovery: { status: "recovered", detail: "Fetched the exact persisted turn without rerunning it." } };
  } catch (error) {
    return { ...snapshot, recovery: { status: "unreachable", detail: error.message } };
  }
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "thread", "timeout-ms", "poll-interval-ms", "owner"],
    booleanOptions: ["json", "all", "wait"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = options.thread ?? positionals[0] ?? "";
  if (reference) {
    const selected = buildSingleJobSnapshot(cwd, reference);
    const renewed = renewLease(selected.workspaceRoot, selected.job.id, options.owner);
    if (reportMovedOwner(renewed, options.owner, options.json)) return;
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options["timeout-ms"],
          pollIntervalMs: options["poll-interval-ms"], owner: options.owner
        })
      : await refreshJobSnapshot(cwd, reference);
    if (reportMovedOwner(snapshot.job, options.owner, options.json)) return;
    outputCommandResult(snapshot, `${renderJobStatusReport(snapshot.job)}${snapshot.recovery ? `Recovery: ${snapshot.recovery.detail}\n` : ""}`, options.json);
    return;
  }

  if (options.wait) {
    throw new Error("`status --wait` requires a job id.");
  }

  const report = buildStatusSnapshot(cwd, { all: options.all });
  outputResult(renderStatusPayload(report, options.json), options.json);
}

async function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "thread"],
    booleanOptions: ["json", "report"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = options.thread ?? positionals[0] ?? "";
  if (reference) {
    const snapshot = await refreshJobSnapshot(cwd, reference);
    if (snapshot.recovery && snapshot.recovery.status !== "recovered") {
      const pending = { status: snapshot.recovery.status, jobId: snapshot.job.id, threadId: snapshot.job.threadId, turnId: snapshot.job.turnId, logFile: snapshot.job.logFile, rawOutputFile: snapshot.job.rawOutputFile, resultFile: snapshot.job.resultFile, approvedBrowserOrigins: snapshot.job.approvedBrowserOrigins ?? [], error: snapshot.job.errorMessage ?? null, recovery: snapshot.recovery };
      outputCommandResult(pending, `${snapshot.recovery.detail}\n`, options.json);
      process.exitCode = 2;
      return;
    }
  }
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  if (options.report) {
    const report = storedJob?.report ?? buildWorkerReport({ approvedBrowserOrigins: storedJob?.approvedBrowserOrigins ?? [], ...(storedJob?.result ?? { status: 1, error: storedJob?.errorMessage ?? "No stored result." }) }, { jobId: job.id, rawOutputFile: job.rawOutputFile, resultFile: job.resultFile });
    Object.assign(withRunSettings(report, storedJob?.request), leaseExpiryReport(storedJob ?? job));
    outputResult(options.json ? report : `${JSON.stringify(report, null, 2)}\n`, options.json);
    if (report.status !== "completed") process.exitCode = report.status === "needs_input" ? 2 : 1;
    return;
  }
  const payload = {
    job,
    storedJob
  };

  outputCommandResult(payload, renderStoredJobResult(job, storedJob), options.json);
}

function handleTaskResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = filterJobsForCurrentClaudeSession(sortJobsNewestFirst(listJobs(workspaceRoot)));
  const candidate = findLatestResumableTaskJob(jobs);

  const payload = {
    available: Boolean(candidate),
    sessionId,
    candidate:
      candidate == null
        ? null
        : {
            id: candidate.id,
            status: candidate.status,
            title: candidate.title ?? null,
            summary: candidate.summary ?? null,
            threadId: candidate.threadId,
            completedAt: candidate.completedAt ?? null,
            updatedAt: candidate.updatedAt ?? null
          }
  };

  const rendered = candidate
    ? `Resumable task found: ${candidate.id} (${candidate.status}).\n`
    : "No resumable task found for this session.\n";
  outputCommandResult(payload, rendered, options.json);
}

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, { valueOptions: ["cwd"], booleanOptions: ["json"] });
  const cwd = resolveCommandCwd(options);
  const { workspaceRoot, job } = resolveCancelableJob(cwd, positionals[0] ?? "", { env: process.env });
  requestCancel(workspaceRoot, job.id);
  appendLogLine(job.logFile, "Cancelled by user: interrupt requested; awaiting confirmation.");
  let current;
  for (const deadline = Date.now() + 6000; Date.now() < deadline;) {
    current = readStoredJob(workspaceRoot, job.id);
    if (!ACTIVE.has(current.status)) break;
    await sleep(100);
  }
  const confirmed = current?.result?.interruptionConfirmed === true ||
    (!ACTIVE.has(current?.status) && current?.result?.turnEnded === true);
  const payload = { jobId: job.id, status: confirmed ? "cancelled" : "interrupt_unconfirmed", confirmation: confirmed ? "confirmed" : "unconfirmed",
    turnInterruptAttempted: true, turnInterrupted: confirmed, reason: "cancelled_by_user" };
  outputCommandResult(payload, `${JSON.stringify(payload, null, 2)}\n`, options.json);
  if (!confirmed) process.exitCode = 2;
}

function reportMovedOwner(job, owner, json) {
  const notice = ownershipNotice(job, owner);
  if (!notice) return false;
  outputCommandResult(notice, `${JSON.stringify(notice, null, 2)}\n`, json);
  process.exitCode = 2;
  return true;
}

function handleAdopt(argv) {
  const { options, positionals } = parseCommandInput(argv, { valueOptions: ["cwd"], booleanOptions: ["json"] });
  if (!positionals[0]) throw new Error("adopt requires a job id.");
  const cwd = resolveCommandCwd(options), { workspaceRoot, job } = buildSingleJobSnapshot(cwd, positionals[0]);
  const result = adoptJob(workspaceRoot, job.id, getCurrentClaudeSessionId());
  outputCommandResult(result, `${JSON.stringify(result, null, 2)}\n`, options.json);
  if (!result.adopted) process.exitCode = 2;
}

// Claude's Bash tool returns output only when the command ends, so the default
// wait budget is one call just under the 10-minute Bash maximum: a worker makes
// one call per ~9.5 minutes instead of one every 10-30 seconds. Early return on
// activity is opt-in (--min-interval-sec) for human-facing feed consumers.
const WAIT_DEFAULT_SEC = 570, WAIT_MAX_SEC = 3600, REPORTED_ACTIVITY_LIMIT = 12;
// Feed mode (no --json) streams one line per Codex event so the Bash output in a
// Claude agent view shows Codex working live. Every streamed line also lands in
// that agent's context when the call returns, so one call streams at most
// --feed-limit lines (0 = unlimited) and summarizes the rest in the final JSON.
const FEED_LIMIT_DEFAULT = 150;

async function waitForJob(workspaceRoot, job, { owner, timeoutSec, minIntervalSec, afterQuestion, feedLimit, json }) {
  const timeout = seconds(timeoutSec, WAIT_DEFAULT_SEC, "--timeout-sec", WAIT_MAX_SEC);
  const feedMax = feedLimit === undefined ? FEED_LIMIT_DEFAULT : /^\d+$/.test(String(feedLimit)) ? Number(feedLimit) : (() => { throw new Error("--feed-limit must be a non-negative integer."); })();
  let streamed = 0;
  const minimum = minIntervalSec === undefined ? null : seconds(minIntervalSec, 10, "--min-interval-sec", WAIT_MAX_SEC);
  const reader = activityReader(owner), started = Date.now(), activity = [];
  let cursor = readStoredJob(workspaceRoot, job.id).activityCursors?.[reader] ?? 0;
  let nextRenewal = 0, detachReason = null;
  const startPpid = process.ppid;
  // An owner that leaves abnormally cannot tell the worker; mark the detach so the
  // worker interrupts after the grace period unless a replacement wait re-attaches.
  const detach = reason => { if (owner && !detachReason) { detachReason = reason; try { markOwnerAttachment(workspaceRoot, job.id, owner, reason); } catch { /* best effort */ } } };
  const signalHandlers = new Map();
  if (owner) {
    markOwnerAttachment(workspaceRoot, job.id, owner);
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      const handler = () => { detach("signal"); process.exit(130); };
      signalHandlers.set(signal, handler); process.on(signal, handler);
    }
  }
  // Await each write callback: feed lines reach the pipe during the wait, never
  // buffered until the final report. JSON mode uses the same cursor semantics.
  const writeLine = line => new Promise((resolve, reject) => process.stdout.write(`${line}\n`, error => error ? reject(error) : resolve()));
  const finish = async (payload, exitCode = 0) => {
    detach("returned");
    try { await writeLine(JSON.stringify(payload)); } catch (error) { if (error.code !== "EPIPE") throw error; }
    if (exitCode) process.exitCode = exitCode;
  };
  const reported = () => activity.length > REPORTED_ACTIVITY_LIMIT
    ? { activity: activity.slice(-REPORTED_ACTIVITY_LIMIT), activityCount: activity.length, activityOmitted: activity.length - REPORTED_ACTIVITY_LIMIT }
    : { activity, activityCount: activity.length };
  try {
    for (;;) {
      if (owner && process.ppid !== startPpid) { detach("parent_exit"); process.exitCode = 130; return; }
      const renew = owner && Date.now() >= nextRenewal;
      const current = renew ? renewLease(workspaceRoot, job.id, owner) : readStoredJob(workspaceRoot, job.id);
      if (renew) nextRenewal = Date.now() + Math.min(1000, (current.leaseSec ?? 180) * 250);
      const moved = ownershipNotice(current, owner);
      if (moved) { detachReason = "moved"; await finish({ ...moved, ...reported(), cursor }, 2); return; }
      const next = (current.activity ?? []).filter(event => event.seq > cursor);
      for (const event of next) {
        if (!json && (feedMax === 0 || streamed < feedMax)) {
          streamed += 1;
          const line = streamed === feedMax ? `${formatActivity(event)}\n… feed paused after ${feedMax} lines; later events are counted in the final JSON (activityCount) and shown by /codex:status` : formatActivity(event);
          try { await writeLine(line); }
          catch (error) { if (error.code !== "EPIPE") throw error; detach("stdout_closed"); process.exitCode = 130; return; }
        }
        activity.push(event); cursor = event.seq;
      }
      if (next.length && !json) updateJob(workspaceRoot, job.id, stored => ({ activityCursors: { ...stored.activityCursors, [reader]: Math.max(cursor, stored.activityCursors?.[reader] ?? 0) } }));
      const pending = current.pendingQuestion;
      const terminal = !ACTIVE.has(current.status);
      if (terminal || (pending && pending.answer === undefined && pending.id !== afterQuestion) || Date.now() - started >= timeout * 1000 || (minimum !== null && activity.length && Date.now() - started >= minimum * 1000)) {
        const report = terminal ? { ...(current.report ?? buildWorkerReport(current.result ?? { status: 1, error: current.errorMessage ?? "No stored result." }, { jobId: job.id, rawOutputFile: job.rawOutputFile, resultFile: job.resultFile })), ...leaseExpiryReport(current) } : progressSnapshot(current);
        // Compact reports may contain captured commands and assistant snippets too.
        // Preserve handles/paths; redact only display text, never serialized JSON.
        if (terminal) {
          withRunSettings(report, current.request);
          for (const key of ["verification", "keyFindings", "assumptions", "blockers"]) {
            if (report[key]) report[key] = report[key].map(redactActivity);
          }
          if (typeof report.question === "string") report.question = redactActivity(report.question);
          if (report.status !== "completed" && current.threadId && !report.continuationCommand) Object.assign(report, continuationReport(current));
        }
        if (json && activity.length) updateJob(workspaceRoot, job.id, stored => ({ activityCursors: { ...stored.activityCursors, [reader]: Math.max(cursor, stored.activityCursors?.[reader] ?? 0) } }));
        await finish({ ...report, ...reported(), cursor }, terminal && report.status !== "completed" ? (report.status === "needs_input" ? 2 : 1) : 0);
        return;
      }
      await sleep(100);
    }
  } finally {
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
  }
}

async function handleWait(argv) {
  const { options, positionals } = parseCommandInput(argv, { valueOptions: ["cwd", "timeout-sec", "min-interval-sec", "owner", "after-question", "feed-limit"], booleanOptions: ["json", "report"] });
  if (!positionals[0]) throw new Error("wait requires a job id.");
  const cwd = resolveCommandCwd(options);
  const { workspaceRoot, job } = buildSingleJobSnapshot(cwd, positionals[0]);
  await waitForJob(workspaceRoot, job, { owner: options.owner, timeoutSec: options["timeout-sec"], minIntervalSec: options["min-interval-sec"], afterQuestion: options["after-question"], feedLimit: options["feed-limit"], json: options.json });
}

async function handleAnswer(argv) {
  const { options, positionals } = parseCommandInput(argv, { valueOptions: ["cwd", "question", "owner"], booleanOptions: ["json"] });
  if (!positionals[0] || !options.question) throw new Error("answer requires a job id and --question <id>; pass answer text on stdin.");
  const cwd = resolveCommandCwd(options), { workspaceRoot, job } = buildSingleJobSnapshot(cwd, positionals[0]);
  const answered = answerQuestion(workspaceRoot, job.id, options.question, readStdinIfPiped(), options.owner);
  if (reportMovedOwner(answered, options.owner, options.json)) return;
  const renewed = renewLease(workspaceRoot, job.id, options.owner);
  if (reportMovedOwner(renewed, options.owner, options.json)) return;
  const payload = { jobId: job.id, questionId: options.question, status: "answer_submitted" };
  outputResult(options.json ? payload : `${JSON.stringify(payload)}\n`, options.json);
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "setup":
      await handleSetup(argv);
      break;
    case "review":
      await handleReview(argv);
      break;
    case "adversarial-review":
      await handleReviewCommand(argv, {
        reviewName: "Adversarial Review"
      });
      break;
    case "task":
      await handleTask(argv);
      break;
    case "transfer":
      await handleTransfer(argv);
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "wait":
      await handleWait(argv);
      break;
    case "adopt":
      handleAdopt(argv);
      break;
    case "answer":
      await handleAnswer(argv);
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "result":
      await handleResult(argv);
      break;
    case "task-resume-candidate":
      handleTaskResumeCandidate(argv);
      break;
    case "cancel":
      await handleCancel(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
