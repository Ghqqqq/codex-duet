#!/usr/bin/env node

import { spawnDetached } from "./lib/process.mjs";
import { isolatedCodexCommand } from "./lib/codex-home.mjs";
import { UNREACHABLE_GUIDANCE } from "./lib/runtime-errors.mjs";
import { getToolAvailability, syncToolConfig } from "./lib/tool-config.mjs";
import { buildWorkerReport, parseStructuredReport, persistTaskArtifacts, taskArtifactPaths } from "./lib/worker-report.mjs";
import { normalizeBrowserOrigins, normalizeBundleIds } from "./lib/server-requests.mjs";
import { browserOriginSetup, computerUseSetup, transportSetup, defaultSandboxSetup, ensureBrowserApproval, ensureComputerUseApproval, ensureProjectDocs, projectDocsSetup, SANDBOX_MODES } from "./lib/setup-config.mjs";
import { activityReader, formatActivity, redactActivity, snippet } from "./lib/activity.mjs";
import { JobRuntime, ACTIVE, seconds, ownerId, renewLease, requestCancel, answerQuestion, progressSnapshot, leaseExpiryReport, continuationReport, directReport, adoptJob, ownershipNotice, markOwnerAttachment } from "./lib/job-runtime.mjs";
import { pickAgentName } from "./lib/agent-names.mjs";
import { writeSessionMarker } from "./lib/session-markers.mjs";
import { startRun, addEntry, closeRun, showRun, listRuns, renderRun, linkJournalJob } from "./lib/run-journal.mjs";
import { recordFinishedJob } from "./lib/job-runtime.mjs";
import { listSessionJobs, updateJob } from "./lib/state.mjs";
import { clearMode, DEFAULT_MAX_WORKERS, PROTOCOL_PATH, readMode, setMode } from "./lib/ultra-codex-mode.mjs";
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
    FORWARDED_APPROVALS_LABEL,
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
// Delegated workers (--report) answer with this schema, so the parent gets a
// declared status and findings instead of inferring them from prose.
const WORKER_REPORT_SCHEMA = path.join(ROOT_DIR, "schemas", "worker-report.schema.json");
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
const VALID_REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
const MODEL_ALIASES = new Map([["spark", "gpt-5.3-codex-spark"]]);
const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";
let directOutputStarted = false;
// Write callbacks handle delivery failures; the stream also emits an error
// event, which must not crash the owner before its detach can be recorded.
process.stdout.on("error", () => {});
function writeDirectLineSync(payload) {
  if (directOutputStarted) return;
  directOutputStarted = true;
  try { fs.writeSync(1, `${JSON.stringify(payload)}\n`); } catch { /* stdout may already be closed */ }
}

const COMMAND_USAGE = {
  journal: `Usage: node "$CODEX_COMPANION" journal <start|add|close|show|list> [options]
Durable run criteria, verdicts and decisions in the isolated home.
  start  Stdin JSON: {"goal":"...","criteria":["..."]}; prints {runId}.
  add <criteria|verdict|decision> [--run <id>]  Stdin JSON:
    criteria: {"criteria":["..."]}
    verdict: {"jobId":"...","verdict":"ACCEPT|ACCEPT_WITH_GLUE|REWORK|REASSIGN",
              "criteria":[{"criterion":"...","evidence":"...","result":"met|not_met|cannot_verify"}],"reason":"..."}
    decision: {"summary":"...","basis":"...","risk":"optional"}
  close [--run <id>]  Stdin: {"judgment":"passed|blocked|abandoned","summary":"...","openRisks":[]}.
  show [--run <id>]  Recover active run, else newest run; paths refer to saved brief/report copies.
  list  Workspace runs, newest first.
  --cwd, -C <dir>  Workspace for start/list/--run; --json  Full JSON view; --help, -h  Side-effect-free help.
Start needs CODEX_COMPANION_SESSION_ID. Add/close/show use the session's active run across workspaces.`,
  task: `Usage: node "$CODEX_COMPANION" task [options] [prompt]
Brief: stdin (preferred), prompt file, or positional text; after -- all tokens are literal.
Options (long value flags also accept =value):
  --help, -h  Show this help without starting anything.
  --fresh  New thread (default); --thread <threadId>  Follow up on that exact thread.
  --continue <jobId>  Continue a finished job, inheriting its settings and approvals.
  --resume-last, --resume  Latest task thread; never use to select parallel jobs.
  --model, -m <model|spark>  Model (default gpt-6-astra; spark = gpt-5.3-codex-spark).
  --effort <none|minimal|low|medium|high|xhigh|max>  Reasoning effort (default xhigh).
  --fast  Priority speed; --normal  Normal speed (default); choose one.
  --cwd, -C <dir>  Workspace directory; --prompt-file <file>  Read the brief from a file.
  --direct  Owned wait: /tasks progress, then compact JSON as the last line; --quiet  JSON line only.
  --follow  Owned wait with feed; --detached  Owned job, return handles immediately.
  --background  Legacy background launch; --report  Structured worker report.
  --json  JSON output outside direct mode (direct already emits JSON).
  --sandbox <read-only|workspace-write|danger-full-access>  Override configured sandbox.
  --write[=false]  At least workspace-write; false requests read-only absent sandbox.
  --approve-browser-origin <origin>  Approve an explicitly consented origin for this call; repeatable.
  --approve-computer-app <bundle-id>  Approve an explicitly consented app for this call; repeatable.
  --owner <id>  Owner identity; --lease-sec <s>  Lease (direct 1800, otherwise 180).
  --question-timeout-sec <s>  Answer deadline (900); --timeout-sec <s>  Wait budget (direct 3600, follow 570; max 3600).
  --feed-limit <n>  Feed lines (60; 0 unlimited); incompatible with direct mode.
Direct conflicts: follow, detached, background, json, feed-limit, min-interval-sec.
Run each example as Bash(command: <shell below>, run_in_background: true, timeout: 600000).
node "$CODEX_COMPANION" task --fresh --direct --model gpt-6-astra --effort xhigh --fast --cwd '<dir>' <<'CODEX_TASK'
<brief: objective, context, owned paths, constraints, acceptance criteria>
CODEX_TASK
Parallel independent jobs: one fresh job per workspace/cwd; never share a thread.
printf '%s\\n' 'Review paper A.' | node "$CODEX_COMPANION" task --fresh --direct --cwd '<workspace-A>'
printf '%s\\n' 'Review paper B.' | node "$CODEX_COMPANION" task --fresh --direct --cwd '<workspace-B>'
Follow-up (same cwd):
printf '%s\\n' 'Apply the requested follow-up.' | node "$CODEX_COMPANION" task --thread '<threadId>' --direct --cwd '<dir>'
Browser origin (only with explicit user consent):
printf '%s\\n' 'Read the approved site.' | node "$CODEX_COMPANION" task --fresh --direct --approve-browser-origin 'https://example.com'
Result: on the Bash completion notification, read only the last line starting with { (grep '^{' <output file> | tail -n 1); Claude Code may append [exited with code N]. Never read the whole file or poll.
  completed: read summary and verify the result; retain threadId and cwd for follow-ups.
  running: run waitCommand in background Bash; wait for its notification.
  needs_answer: FIRST run waitCommand in background, then answerCommand with the answer on stdin.
  error: call failed; check status before resubmitting. owner_stopped: interrupted owner; continuationCommand can resume when authorized.
  Other terminal statuses include blocked/needs_input/failed/interrupted; inspect summary and continuationCommand.`,
  setup: `Usage: node "$CODEX_COMPANION" setup [options]
Check isolated runtime readiness or change setup; --help, -h exits without changes.
  --cwd, -C <dir>  Workspace; --json  JSON output; --dry-run  Preview a setup change.
  --sync-tools  Sync tools; --profile <chrome|codex-app>  Tool profile; --replace-cua  Replace CUA config.
  --cua-template <file>  Absolute template path; --chatgpt-resources <dir>  Absolute resources path.
  --default-sandbox <read-only|workspace-write|danger-full-access>  Default task sandbox.
  --transport <http|websocket|status>  Runtime transport; --project-docs <claude-md|agents-only>  CLAUDE.md fallback.
  --browser-approval <never-ask|ask>  Browser policy; --list-browser-origins  List origins.
  --allow-browser-origin <origin>, --revoke-browser-origin <origin>  Change saved origins (repeatable).
  --computer-use-approval <mirror|ask>  App policy; --list-computer-apps  List apps.
  --allow-computer-app <bundle-id>, --revoke-computer-app <bundle-id>  Change saved apps (repeatable).
  --enable-review-gate, --disable-review-gate  Toggle stop-time review gate.`,
  review: `Usage: node "$CODEX_COMPANION" review [options]
Read-only native review; no focus text. --help, -h exits without starting a review.
  --base <ref>  Base revision; --scope <auto|working-tree|branch>  Review target.
  --model, -m <model>  Model; --cwd, -C <dir>  Workspace; --json  JSON output.
  --wait, --background  Accepted routing hints; this helper stays in the foreground.`,
  "adversarial-review": `Usage: node "$CODEX_COMPANION" adversarial-review [options] [focus text]
Read-only adversarial review; unknown flags remain focus text. --help, -h shows help.
  --base <ref>  Base revision; --scope <auto|working-tree|branch>  Review target.
  --model, -m <model>  Model; --cwd, -C <dir>  Workspace; --json  JSON output.
  --wait, --background  Accepted routing hints; this helper stays in the foreground.
  --  Treat remaining tokens, including help flags, as literal focus text.`,
  transfer: `Usage: node "$CODEX_COMPANION" transfer [--source <claude-jsonl>] [--cwd <dir>] [--json]
Import a Claude transcript; source defaults to the current session transcript.
  --cwd, -C  Workspace; --json  JSON output; --help, -h  Show help.`,
  status: `Usage: node "$CODEX_COMPANION" status [job-id|--thread <id>] [options]
Show session jobs or an exact job/thread; --all includes other sessions.
  --wait  Wait for completion; --timeout-ms <ms>  Wait budget; --poll-interval-ms <ms>  Poll interval.
  --owner <id>  Renew that owner; --cwd, -C <dir>  Workspace; --json  JSON output; --help, -h  Help.`,
  result: `Usage: node "$CODEX_COMPANION" result [job-id|--thread <id>] [--report] [--json] [--cwd <dir>]
Read a saved result; --report selects the worker report; --json selects JSON.
  --cwd, -C  Workspace; --help, -h  Show help.`,
  wait: `Usage: node "$CODEX_COMPANION" wait <job-id> [options]
Wait for a job and renew its owner lease; --help, -h exits without attaching.
  --owner <id>  Owner; --cwd, -C <dir>  Workspace; --after-question <id>  Wait past that question.
  --timeout-sec <s>  Budget (570; direct 3600; max 3600); --min-interval-sec <s>  Return early on activity.
  --feed-limit <n>  Feed cap (60; 0 unlimited); --report  Worker report; --json  JSON report without feed.
  --direct  Progress in /tasks, then compact JSON as the last stdout line; conflicts with json, feed-limit and min-interval-sec.
  --quiet  With --direct only: suppress progress and print exactly one JSON line.
Result: on completion, read only the last line starting with { (grep '^{' <output file> | tail -n 1); Claude Code may append [exited with code N]. Never read the whole file or poll.`,
  adopt: `Usage: node "$CODEX_COMPANION" adopt <job-id> [--cwd <dir>] [--json]
Take ownership of an orphaned job; --json prints its new owner and wait command.
  --cwd, -C  Workspace; --help, -h  Show help without adopting.`,
  answer: `Usage: node "$CODEX_COMPANION" answer <job-id> --owner <ownerId> --question <id> [--cwd <dir>] [--json] < answer.txt
Submit stdin to the pending question on the existing turn.
  --cwd, -C  Workspace; --json  JSON receipt; --help, -h  Show help without answering.`,
  cancel: `Usage: node "$CODEX_COMPANION" cancel [job-id] [--cwd <dir>] [--json]
Cancel the selected active job; omit job-id only when the session has one active job.
  --cwd, -C  Workspace; --json  JSON confirmation; --help, -h  Show help without cancelling.`,
  cleanup: `Usage: node "$CODEX_COMPANION" cleanup [--dry-run] [--days <N>] [--json]
Remove eligible ended jobs, inactive runs, markers and unreferenced threads.
  --dry-run  Preview only; --days  Retention age; --json  JSON details; --help, -h  Show help without cleanup.`,
  "ultra-codex": `Usage: node "$CODEX_COMPANION" ultra-codex [on|off|status] [options]
Set or inspect this session's mode (default action: status).
  --quick, --thorough  Scale; --max-workers <n>  Worker cap; --for-command  Include protocol with status.
  --cwd, -C <dir>  Workspace; --json  JSON output; --help, -h  Show help without changing mode.`,
  "task-worker": `Usage: node "$CODEX_COMPANION" task-worker --job-id <id> [--cwd <dir>]
Internal detached worker entry point; --job-id selects a stored task.
  --cwd, -C  Workspace; --help, -h  Show help without starting a worker.`,
  "task-resume-candidate": `Usage: node "$CODEX_COMPANION" task-resume-candidate [--cwd <dir>] [--json]
Find the latest resumable task in this session; --json prints its handles.
  --cwd, -C  Workspace; --help, -h  Show help.`
};

function usageFor(subcommand) {
  return Object.hasOwn(COMMAND_USAGE, subcommand) ? COMMAND_USAGE[subcommand] : null;
}

function printUsage(subcommand) {
  console.log(usageFor(subcommand) ?? [
    "Usage: node \"$CODEX_COMPANION\" <subcommand> [options]",
    ...Object.values(COMMAND_USAGE).map(usage => `  ${usage.split("\n")[0].slice("Usage: ".length)}`),
    'Run node "$CODEX_COMPANION" <subcommand> --help (or -h) for flags and examples.',
    "task --direct: one owned job per background Bash call, one compact JSON result line.",
    "Help exits before starting anything; tokens after -- are literal text."
  ].join("\n"));
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
    rejectUnknown: true,
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
    computerUse: computerUseSummary(),
    projectDocs: projectDocsSummary(),
    actionsTaken,
    nextSteps
  };
}

// Setup's summary must stay read-only: report the state without running the mirror.
function computerUseSummary() {
  try { return computerUseSetup({ dryRun: true }); }
  catch (error) { return { error: error.message }; }
}
function projectDocsSummary() {
  try { return projectDocsSetup({ dryRun: true }); }
  catch (error) { return { error: error.message }; }
}

async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "cua-template", "chatgpt-resources", "transport", "profile", "default-sandbox", "browser-approval", "computer-use-approval", "project-docs"],
    repeatableOptions: ["allow-browser-origin", "revoke-browser-origin", "allow-computer-app", "revoke-computer-app"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate", "sync-tools", "dry-run", "list-browser-origins", "list-computer-apps", "replace-cua"]
  });
  const computerUseFlags = options["computer-use-approval"] !== undefined || options["allow-computer-app"] || options["revoke-computer-app"] || options["list-computer-apps"];

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
    if (options["sync-tools"] || options.transport !== undefined || options["browser-approval"] !== undefined || options["allow-browser-origin"] || options["revoke-browser-origin"] || options["list-browser-origins"] || computerUseFlags || options["project-docs"] !== undefined || options["enable-review-gate"] || options["disable-review-gate"]) throw new Error("Run --default-sandbox separately from other setup changes.");
    const report = defaultSandboxSetup({ mode: options["default-sandbox"], dryRun: Boolean(options["dry-run"]) });
    outputResult(options.json ? report : `${JSON.stringify(report, null, 2)}\n`, options.json);
    return;
  }
  if (options["project-docs"] !== undefined) {
    if (options["sync-tools"] || options.transport !== undefined || options["browser-approval"] !== undefined || options["allow-browser-origin"] || options["revoke-browser-origin"] || options["list-browser-origins"] || computerUseFlags || options["enable-review-gate"] || options["disable-review-gate"]) throw new Error("Run --project-docs separately from other setup changes.");
    const report = { projectDocs: projectDocsSetup({ mode: options["project-docs"], dryRun: Boolean(options["dry-run"]) }) };
    outputResult(options.json ? report : `${JSON.stringify(report, null, 2)}\n`, options.json);
    return;
  }
  if (computerUseFlags) {
    if (options["sync-tools"] || options["enable-review-gate"] || options["disable-review-gate"] || options.transport !== undefined || options["browser-approval"] !== undefined || options["allow-browser-origin"] || options["revoke-browser-origin"] || options["list-browser-origins"]) throw new Error("Run Computer Use app setup separately from other setup changes.");
    // Validate every bundle id before any file write; --list-computer-apps alone is a dry run.
    const allow = normalizeBundleIds(options["allow-computer-app"] ?? []), revoke = normalizeBundleIds(options["revoke-computer-app"] ?? []);
    const listOnly = options["list-computer-apps"] && !allow.length && !revoke.length && options["computer-use-approval"] === undefined;
    const report = { computerUse: computerUseSetup({ allow, revoke, approval: options["computer-use-approval"], dryRun: Boolean(options["dry-run"]) || listOnly }) };
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


function taskBrief(request) {
  const prompt = request.report ? `${request.prompt || DEFAULT_CONTINUE_PROMPT}\n\n${loadPromptTemplate(ROOT_DIR, "worker-task")}` : request.prompt;
  return prompt?.trim() || (request.threadId || request.resumeLast ? DEFAULT_CONTINUE_PROMPT : "");
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
  // Only an owned (detached/--follow) job has a parent polling for questions, so
  // only there can a Computer Use request be forwarded; a plain foreground run
  // keeps "never" and such a request fails closed at once.
  const approvalPolicy = request.detached ? FORWARDED_APPROVALS_LABEL : "never";
  updateJob(workspaceRoot, request.jobId, () => ({ preExistingChanges: before.preExistingChanges, sandbox, approvalPolicy }));
  request.onProgress?.(`Sandbox: ${sandbox}; approval policy: ${approvalPolicy}${request.detached ? " (Computer Use app requests are forwarded to the parent)" : ""}. Captured workspace baseline (${before.status}).`);

  const runtime = new JobRuntime(workspaceRoot, request.jobId, { foreground: !request.detached, onProgress: request.onProgress });
  let result;
  try { result = await runAppServerTurn(workspaceRoot, {
    resumeThreadId,
    prompt: request.report ? `${request.prompt || DEFAULT_CONTINUE_PROMPT}\n\n${loadPromptTemplate(ROOT_DIR, "worker-task")}` : request.prompt,
    outputSchema: request.report ? readOutputSchema(WORKER_REPORT_SCHEMA) : null,
    defaultPrompt: resumeThreadId ? DEFAULT_CONTINUE_PROMPT : "",
    model: request.model,
    effort: request.effort,
    serviceTier: request.serviceTier,
    sandbox,
    explicitSandbox: Boolean(request.sandbox),
    approvedBrowserOrigins: request.approvedBrowserOrigins ?? [],
    approvedComputerApps: request.approvedComputerApps ?? [],
    onProgress: request.onProgress,
    signal: runtime.abort.signal,
    onParentQuestion: message => runtime.question(message),
    onApprovalRequest: request.detached ? approval => runtime.approval(approval) : undefined,
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
  const finalMessage = typeof result.finalMessage === "string" ? result.finalMessage : "";
  // A worker's final message is the structured report; its summary is the prose
  // the parent reads, so it takes the place of the raw output everywhere.
  const structured = request.report ? parseStructuredReport(finalMessage) : null;
  const rawOutput = structured ? structured.summary : finalMessage;
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
      approvedBrowserOrigins: result.approvedBrowserOrigins ?? request.approvedBrowserOrigins ?? [],
      approvedComputerApps: result.approvedComputerApps ?? request.approvedComputerApps ?? []
    }
  );
  const payload = {
    status: result.status,
    jobId: request.jobId,
    threadId: result.threadId,
    turnId: result.turnId,
    rawOutput,
    ...(structured ? { structured } : {}),
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
    approvedComputerApps: result.approvedComputerApps ?? request.approvedComputerApps ?? [],
    blockers: result.blockers ?? [],
    commandExecutions: result.commandExecutions ?? [],
    reasoningSummary: result.reasoningSummary,
    startupTimings: result.startupTimings ?? {}, startupWarning: result.startupWarning ?? null,
    turnEnded: Boolean(result.turnEnded),
    interruptionReason: result.interruptionReason ?? null, interruptionConfirmed: result.interruptionConfirmed ?? null
  };
  const trackedJob = readStoredJob(resolveWorkspaceRoot(request.cwd), request.jobId);
  Object.assign(payload, { ...(trackedJob?.agentName ? { agentName: trackedJob.agentName } : {}), ownerId: trackedJob?.ownerId ?? null, sessionId: trackedJob?.sessionId ?? null });
  const artifacts = persistTaskArtifacts(resolveWorkspaceRoot(request.cwd), request.jobId, payload);
  const report = buildWorkerReport(payload, { jobId: request.jobId, ...artifacts });
  Object.assign(report, { ...(trackedJob?.agentName ? { agentName: trackedJob.agentName } : {}), ownerId: payload.ownerId, sessionId: payload.sessionId }, leaseExpiryReport({ ...trackedJob, threadId: payload.threadId, result: payload }));
  if (payload.interruptionReason) {
    report.status = payload.interruptionReason === "cancelled_by_user" ? "cancelled" : "interrupted";
    // Any interruption leaves a resumable thread; publish the continuation so a
    // replacement worker can pick the task up without reconstructing flags.
    Object.assign(report, continuationReport({ ...trackedJob, id: request.jobId, threadId: payload.threadId, workspaceRoot: resolveWorkspaceRoot(request.cwd) }));
  }
  Object.assign(payload, artifacts, { workerStatus: report.status });

  return {
    exitStatus: result.status !== 0 ? result.status : exitCodeForReport(report.status),
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

// Worker exit codes: 0 completed; 2 the parent must act (blocked, needs_input,
// moved owner); 1 failed/interrupted/cancelled.
function exitCodeForReport(status) {
  return status === "completed" ? 0 : status === "blocked" || status === "needs_input" ? 2 : 1;
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
  return `${payload.title} started in the background as ${payload.jobId}. Check /codex:status ${payload.jobId} for progress.\nApproved browser origins (this job): ${(payload.approvedBrowserOrigins ?? []).join(", ") || "none"}\nApproved Computer Use apps (this job): ${(payload.approvedComputerApps ?? []).join(", ") || "none"}\n`;
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

function buildTaskJob(workspaceRoot, taskMetadata, write, sandbox, approvedBrowserOrigins = [], lifecycle = {}, approvedComputerApps = [], detached = false, identity = {}) {
  const job = createCompanionJob({
    prefix: "task",
    kind: "task",
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: "task",
    summary: taskMetadata.summary,
    write
  });
  const record = { ...job, ownerId: lifecycle.owner ?? ownerId(job.id), sessionId: job.sessionId ?? null, leaseRenewedAt: Date.now(), leaseSec: lifecycle.leaseSec ?? 180, questionTimeoutSec: lifecycle.questionTimeoutSec ?? 900,
    leaseExpiresAt: Date.now() + (lifecycle.leaseSec ?? 180) * 1000,
    sandbox: sandbox ?? (write ? "workspace-write" : "read-only"), approvalPolicy: detached ? FORWARDED_APPROVALS_LABEL : "never", approvedBrowserOrigins, approvedComputerApps, ...taskArtifactPaths(workspaceRoot, job.id) };
  // Reserve the name under the same workspace lock that publishes job state.
  // Concurrent dispatches see this queued reservation before either launches.
  const stored = listJobs(workspaceRoot);
  updateState(workspaceRoot, state => {
    const currentIds = new Set(state.jobs.map(candidate => candidate.id));
    const candidates = [...state.jobs, ...stored.filter(candidate => !currentIds.has(candidate.id))];
    const previous = identity.continued ?? (identity.threadId ? candidates
      .filter(candidate => candidate.threadId === identity.threadId)
      .sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")) || b.id.localeCompare(a.id))[0] : null);
    const recent = Date.now() - 24 * 60 * 60 * 1000;
    record.agentName = previous?.agentName || pickAgentName(candidates
      .filter(candidate => ACTIVE.has(candidate.status) || Date.parse(candidate.createdAt) >= recent)
      .map(candidate => candidate.agentName).filter(Boolean));
    if (identity.threadId) record.threadId = identity.threadId;
    if (previous) record.followUpOf = previous.id;
    if (identity.continued) record.continuationOf = identity.continued.id;
    state.jobs.unshift({ ...record, status: "queued", ...(identity.threadId ? { threadId: identity.threadId } : {}) });
  });
  try {
    const linkedRun = linkJournalJob({ ...record, cwd: identity.cwd, model: identity.model, effort: identity.effort }, taskBrief(identity));
    if (linkedRun) {
      Object.assign(record, linkedRun);
      updateJob(workspaceRoot, record.id, () => linkedRun);
    }
  } catch { /* journal linkage never fails a task */ }
  return record;
}

function buildTaskRequest({ cwd, model, effort, serviceTier, prompt, write, sandbox, approvedBrowserOrigins = [], approvedComputerApps = [], resumeLast, threadId, jobId, report, detached = false }) {
  return {
    cwd,
    model,
    effort,
    serviceTier,
    prompt,
    write,
    sandbox,
    approvedBrowserOrigins,
    approvedComputerApps,
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
  const execution = await runTrackedJob(job, () => runner(progress), { logFile, onStarted: () => {
    if (job.jobClass === "task") writeSessionMarker({ ...job, logFile });
    progress(`Job handle: ${job.id}; log: ${logFile}${job.rawOutputFile ? `; raw output: ${job.rawOutputFile}` : ""}`);
  } });
  outputResult(options.report ? (options.json ? execution.report : `${JSON.stringify(execution.report, null, 2)}\n`) : options.json ? execution.payload : execution.rendered, options.json);
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
  return execution;
}

function spawnDetachedTaskWorker(cwd, jobId) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "codex-companion.mjs");
  return spawnDetached(process.execPath, [scriptPath, "task-worker", "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
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
  writeSessionMarker(queuedRecord);
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
      ...(job.agentName ? { agentName: job.agentName } : {}),
      ownerId: job.ownerId,
      sessionId: job.sessionId ?? null,
      status: "queued",
      sandbox: job.sandbox,
      approvalPolicy: job.approvalPolicy,
      approvedBrowserOrigins: job.approvedBrowserOrigins ?? [],
      approvedComputerApps: job.approvedComputerApps ?? [],
      title: job.title,
      summary: job.summary,
      logFile
    },
    logFile
  };
}

async function handleReviewCommand(argv, config) {
  const { options, positionals } = parseCommandInput(argv, {
    rejectUnknown: config.reviewName !== "Adversarial Review",
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
  const taskOptions = {
    valueOptions: ["model", "effort", "cwd", "prompt-file", "thread", "continue", "sandbox", "lease-sec", "question-timeout-sec", "owner", "timeout-sec", "feed-limit"],
    repeatableOptions: ["approve-browser-origin", "approve-computer-app"],
    booleanOptions: ["json", "report", "write", "resume-last", "resume", "fresh", "background", "detached", "follow", "direct", "quiet", "fast", "normal"],
    aliasMap: {
      m: "model"
    }
  };
  const { options, positionals } = parseCommandInput(argv, taskOptions);
  validateDirectOptions(argv, ["follow", "detached", "background", "json", "feed-limit", "min-interval-sec"], options);

  if (options.direct) {
    seconds(options["timeout-sec"], WAIT_MAX_SEC, "--timeout-sec", WAIT_MAX_SEC);
  }
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
    if (options["approve-computer-app"]?.length) throw new Error("--continue inherits the original job's approved Computer Use apps; do not pass --approve-computer-app.");
  }
  const approvedBrowserOrigins = continued ? continued.approvedBrowserOrigins ?? [] : normalizeBrowserOrigins(options["approve-browser-origin"] ?? []);
  // Per-call Computer Use approval, like --approve-browser-origin: only the
  // listed bundle ids, only for this job's turn.
  const approvedComputerApps = continued ? continued.approvedComputerApps ?? [] : normalizeBundleIds(options["approve-computer-app"] ?? []);
  const lifecycle = { owner: options.owner, leaseSec: seconds(options["lease-sec"] ?? process.env.CODEX_COMPANION_LEASE_SEC, options.direct ? 1800 : 180, "--lease-sec"), questionTimeoutSec: seconds(options["question-timeout-sec"], 900, "--question-timeout-sec") };
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
  // Computer Use: in mirror mode (the default) the apps the user marked "always
  // allow" in their Codex app are copied into the isolated runtime's own
  // approval file (read-only on ~/.codex; a no-op once in step).
  try { ensureComputerUseApproval(); } catch (error) { process.stderr.write(`Computer Use approval preference not applied: ${error.message}\n`); }
  // Project instructions: let Codex read CLAUDE.md where no AGENTS.md exists
  // (its own project_doc_fallback_filenames; a no-op once written).
  try { ensureProjectDocs(); } catch (error) { process.stderr.write(`Project instructions preference not applied: ${error.message}\n`); }
  const taskMetadata = buildTaskRunMetadata({
    prompt,
    resumeLast: Boolean(resumeLast || threadId)
  });

  if (options.background || options.detached || options.follow || options.direct) {
    ensureCodexAvailable(cwd);
    requireTaskRequest(prompt, resumeLast, threadId);

    const job = buildTaskJob(workspaceRoot, taskMetadata, write, sandbox, approvedBrowserOrigins, lifecycle, approvedComputerApps, true, { cwd, continued, threadId, resumeLast, prompt, model, effort, report: Boolean(options.report || options.detached || options.follow || options.direct) });
    if (options.direct) job.direct = true;
    const request = buildTaskRequest({
      cwd,
      model,
      effort,
      serviceTier,
      prompt,
      write,
      sandbox,
      approvedBrowserOrigins,
      approvedComputerApps,
      resumeLast,
      threadId,
      jobId: job.id,
      report: Boolean(options.report || options.detached || options.follow || options.direct), detached: true
    });
    if (continued) request.continuedFrom = continued.id;
    const { payload } = enqueueBackgroundTask(cwd, job, request);
    if (options.follow || options.direct) {
      // Native-like single call: submit, then stay attached as the owner until the
      // job ends, needs an answer, or the wait budget runs out.
      await waitForJob(workspaceRoot, job, { owner: job.ownerId, timeoutSec: options["timeout-sec"], feedLimit: options["feed-limit"], json: options.json, direct: options.direct, quiet: options.quiet });
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

  const job = buildTaskJob(workspaceRoot, taskMetadata, write, sandbox, approvedBrowserOrigins, lifecycle, approvedComputerApps, false, { cwd, continued, threadId, resumeLast, prompt, model, effort, report: Boolean(options.report) });
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
        approvedComputerApps,
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
  if (stored) recordFinishedJob(stored);
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
      approvedBrowserOrigins: stored.approvedBrowserOrigins ?? [], approvedComputerApps: stored.approvedComputerApps ?? []
    });
    const execution = buildTaskExecution(result, { cwd, jobId: job.id, write: job.write, model: stored.request?.model, effort: stored.request?.effort, serviceTier: stored.request?.serviceTier });
    const completedAt = nowIso();
    const patch = { status: execution.jobStatus, phase: execution.jobStatus === "completed" ? "done" : execution.jobStatus, pid: null, completedAt, summary: execution.summary, recovered: true, rawOutputFile: execution.payload.rawOutputFile, resultFile: execution.payload.resultFile };
    recordFinishedJob(updateJob(workspaceRoot, job.id, () => ({ ...patch, result: execution.payload, report: execution.report, rendered: execution.rendered })));
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
      const pending = { status: snapshot.recovery.status, jobId: snapshot.job.id, ...(snapshot.job.agentName ? { agentName: snapshot.job.agentName } : {}), threadId: snapshot.job.threadId, turnId: snapshot.job.turnId, logFile: snapshot.job.logFile, rawOutputFile: snapshot.job.rawOutputFile, resultFile: snapshot.job.resultFile, approvedBrowserOrigins: snapshot.job.approvedBrowserOrigins ?? [], approvedComputerApps: snapshot.job.approvedComputerApps ?? [], error: snapshot.job.errorMessage ?? null, recovery: snapshot.recovery };
      outputCommandResult(pending, `${snapshot.recovery.detail}\n`, options.json);
      process.exitCode = 2;
      return;
    }
  }
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  if (options.report) {
    const report = storedJob?.report ?? buildWorkerReport({ approvedBrowserOrigins: storedJob?.approvedBrowserOrigins ?? [], approvedComputerApps: storedJob?.approvedComputerApps ?? [], ...(storedJob?.result ?? { status: 1, error: storedJob?.errorMessage ?? "No stored result." }) }, { jobId: job.id, rawOutputFile: job.rawOutputFile, resultFile: job.resultFile });
    Object.assign(withRunSettings(report, storedJob?.request), leaseExpiryReport(storedJob ?? job),
      storedJob?.agentName ? { agentName: storedJob.agentName } : {});
    outputResult(options.json ? report : `${JSON.stringify(report, null, 2)}\n`, options.json);
    process.exitCode = exitCodeForReport(report.status);
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
            ...(candidate.agentName ? { agentName: candidate.agentName } : {}),
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
  const payload = { jobId: job.id, ...(job.agentName ? { agentName: job.agentName } : {}), status: confirmed ? "cancelled" : "interrupt_unconfirmed", confirmation: confirmed ? "confirmed" : "unconfirmed",
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
const FEED_LIMIT_DEFAULT = 60;

function optionTokens(argv) {
  const tokens = normalizeArgv(argv);
  const separator = tokens.indexOf("--");
  return separator < 0 ? tokens : tokens.slice(0, separator);
}

function requestsDirect(argv) {
  return optionTokens(argv).some(token => token === "--direct" || (token.startsWith("--direct=") && token !== "--direct=false"));
}

function validateDirectOptions(argv, conflicts, options) {
  const tokens = optionTokens(argv);
  if (!options.direct && tokens.some(token => token === "--quiet" || token.startsWith("--quiet="))) throw new Error("--quiet requires --direct.");
  if (!requestsDirect(argv)) return;
  for (const flag of conflicts) {
    if (tokens.some(token => token === `--${flag}` || token.startsWith(`--${flag}=`))) throw new Error(`--direct cannot be combined with --${flag}.`);
  }
}

async function waitForJob(workspaceRoot, job, { owner, timeoutSec, minIntervalSec, afterQuestion, feedLimit, json, direct, quiet }) {
  const timeout = seconds(timeoutSec, direct ? WAIT_MAX_SEC : WAIT_DEFAULT_SEC, "--timeout-sec", WAIT_MAX_SEC);
  const feedMax = feedLimit === undefined ? FEED_LIMIT_DEFAULT : /^\d+$/.test(String(feedLimit)) ? Number(feedLimit) : (() => { throw new Error("--feed-limit must be a non-negative integer."); })();
  let streamed = 0;
  const minimum = minIntervalSec === undefined ? null : seconds(minIntervalSec, 10, "--min-interval-sec", WAIT_MAX_SEC);
  if (direct) {
    json = true; // Keep the existing final-only cursor storage and lease semantics.
    job = updateJob(workspaceRoot, job.id, current => ({ direct: true,
      ...(current.report?.continuationCommand ? { report: { ...current.report, ...continuationReport({ ...current, direct: true }) } } : {})
    }));
  }
  const reader = activityReader(owner), started = Date.now(), activity = [];
  let cursor = readStoredJob(workspaceRoot, job.id).activityCursors?.[reader] ?? 0;
  let nextRenewal = 0, detachReason = null;
  const startPpid = process.ppid;
  // An owner that leaves abnormally cannot tell the worker; mark the detach so the
  // worker interrupts after the grace period unless a replacement wait re-attaches.
  const detach = reason => { if (owner && !detachReason) { detachReason = reason; try { markOwnerAttachment(workspaceRoot, job.id, owner, reason); } catch { /* best effort */ } } };
  const reportOwnerStopped = () => {
    if (!direct) return;
    let current = job;
    try { current = readStoredJob(workspaceRoot, job.id) ?? job; } catch { /* retain known handles */ }
    writeDirectLineSync({ status: "owner_stopped", jobId: current.id, ...(current.agentName ? { agentName: current.agentName } : {}), ownerId: current.ownerId ?? null,
      threadId: current.threadId ?? null, turnId: current.turnId ?? null, interruptionReason: "owner_stopped",
      ...(current.threadId ? { continuationCommand: continuationReport({ ...current, direct: true }).continuationCommand } : {}) });
  };
  const signalHandlers = new Map();
  if (owner) {
    markOwnerAttachment(workspaceRoot, job.id, owner);
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      const handler = () => { detach("signal"); reportOwnerStopped(); process.exit(130); };
      signalHandlers.set(signal, handler); process.on(signal, handler);
    }
  }
  // Await each write callback: feed lines reach the pipe during the wait, never
  // buffered until the final report. JSON mode uses the same cursor semantics.
  const writeLine = line => new Promise((resolve, reject) => process.stdout.write(`${line}\n`, error => error ? reject(error) : resolve()));
  const finish = async (payload, exitCode = 0, current = job) => {
    const line = JSON.stringify(direct ? directReport(payload, current) : payload);
    if (direct) directOutputStarted = true;
    try { await writeLine(line); }
    catch (error) {
      if (error.code !== "EPIPE") throw error;
      detach("stdout_closed"); process.exitCode = 130; return;
    }
    detach("returned");
    if (exitCode) process.exitCode = exitCode;
  };
  const reported = () => activity.length > REPORTED_ACTIVITY_LIMIT
    ? { activity: activity.slice(-REPORTED_ACTIVITY_LIMIT), activityCount: activity.length, activityOmitted: activity.length - REPORTED_ACTIVITY_LIMIT }
    : { activity, activityCount: activity.length };
  try {
    for (;;) {
      if (owner && process.ppid !== startPpid) { detach("parent_exit"); reportOwnerStopped(); process.exitCode = 130; return; }
      const renew = owner && Date.now() >= nextRenewal;
      const current = renew ? renewLease(workspaceRoot, job.id, owner) : readStoredJob(workspaceRoot, job.id);
      if (renew) nextRenewal = Date.now() + Math.min(1000, (current.leaseSec ?? 180) * 250);
      const moved = ownershipNotice(current, owner);
      if (moved) { detachReason = "moved"; await finish({ ...moved, ...reported(), cursor }, 2); return; }
      const next = (current.activity ?? []).filter(event => event.seq > cursor);
      for (const event of next) {
        if (direct && !quiet) {
          const text = redactActivity(formatActivity(event)).replace(/\s+/g, " ").trim();
          // Progress never marks directOutputStarted: a later signal must still
          // emit its owner_stopped JSON. The formatter prefixes every event.
          const line = text.length > 200 ? `${text.slice(0, 199)}…` : text;
          try { await writeLine(line); }
          catch (error) { if (error.code !== "EPIPE") throw error; detach("stdout_closed"); process.exitCode = 130; return; }
        } else if (!json && (feedMax === 0 || streamed < feedMax)) {
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
        if (current.agentName) report.agentName = current.agentName;
        // Compact reports may contain captured commands and assistant snippets too.
        // Preserve handles/paths; redact only display text, never serialized JSON.
        if (terminal) {
          withRunSettings(report, current.request);
          for (const key of ["verification", "keyFindings", "assumptions"]) {
            if (report[key]) report[key] = report[key].map(redactActivity);
          }
          if (report.blockers) report.blockers = report.blockers.map(blocker => typeof blocker === "string" ? redactActivity(blocker) : typeof blocker?.message === "string" ? { ...blocker, message: redactActivity(blocker.message) } : blocker);
          if (typeof report.question === "string") report.question = redactActivity(report.question);
          if (report.status !== "completed" && current.threadId && (!report.continuationCommand || current.direct)) Object.assign(report, continuationReport(current));
          // A worker may have read its report settings just before this wait
          // set direct. Keep later result reads on the same continuation mode.
          if (current.direct && current.report?.continuationCommand && current.report.continuationCommand !== report.continuationCommand) {
            updateJob(workspaceRoot, job.id, stored => ({ report: { ...stored.report, ...continuationReport(stored) } }));
          }
        }
        if (json && activity.length) updateJob(workspaceRoot, job.id, stored => ({ activityCursors: { ...stored.activityCursors, [reader]: Math.max(cursor, stored.activityCursors?.[reader] ?? 0) } }));
        await finish({ ...report, ...reported(), cursor }, terminal ? exitCodeForReport(report.status) : 0, current);
        return;
      }
      await sleep(100);
    }
  } finally {
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
  }
}

async function handleWait(argv) {
  const { options, positionals } = parseCommandInput(argv, { valueOptions: ["cwd", "timeout-sec", "min-interval-sec", "owner", "after-question", "feed-limit"], booleanOptions: ["json", "report", "direct", "quiet"] });
  validateDirectOptions(argv, ["json", "feed-limit", "min-interval-sec"], options);
  if (!positionals[0]) throw new Error("wait requires a job id.");
  const cwd = resolveCommandCwd(options);
  const { workspaceRoot, job } = buildSingleJobSnapshot(cwd, positionals[0]);
  await waitForJob(workspaceRoot, job, { owner: options.owner, timeoutSec: options["timeout-sec"], minIntervalSec: options["min-interval-sec"], afterQuestion: options["after-question"], feedLimit: options["feed-limit"], json: options.json, direct: options.direct, quiet: options.quiet });
}

async function handleAnswer(argv) {
  const { options, positionals } = parseCommandInput(argv, { valueOptions: ["cwd", "question", "owner"], booleanOptions: ["json"] });
  if (!positionals[0] || !options.question) throw new Error("answer requires a job id and --question <id>; pass answer text on stdin.");
  const cwd = resolveCommandCwd(options), { workspaceRoot, job } = buildSingleJobSnapshot(cwd, positionals[0]);
  const answered = answerQuestion(workspaceRoot, job.id, options.question, readStdinIfPiped(), options.owner);
  if (reportMovedOwner(answered, options.owner, options.json)) return;
  const renewed = renewLease(workspaceRoot, job.id, options.owner);
  if (reportMovedOwner(renewed, options.owner, options.json)) return;
  const payload = { jobId: job.id, ...(job.agentName ? { agentName: job.agentName } : {}), questionId: options.question, status: "answer_submitted" };
  outputResult(options.json ? payload : `${JSON.stringify(payload)}\n`, options.json);
}

// Ultra-codex mode: a per-session switch (like `/effort ultracode`) read by the
// UserPromptSubmit hook. `status --for-command` is what the slash command's
// preamble runs: the mode line plus the orchestration protocol.
function renderUltraMode(mode) {
  return mode
    ? `Ultra-codex mode: on for this session since ${mode.since ?? "unknown"} (scale: ${mode.scale}; max workers: ${mode.maxWorkers}). Turn it off with /codex:ultra-codex off.`
    : "Ultra-codex mode: off for this session. Turn it on with /codex:ultra-codex on [--quick|--thorough] [--max-workers <n>]; a task given as arguments is orchestrated once without changing the mode.";
}
async function handleUltraCodex(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "max-workers"],
    booleanOptions: ["json", "quick", "thorough", "for-command"]
  });
  const action = positionals[0] ?? "status";
  if (!["on", "off", "status"].includes(action) || positionals.length > 1) throw new Error("ultra-codex takes one of: on [--quick|--thorough] [--max-workers <n>], off, status [--for-command].");
  if (options.quick && options.thorough) throw new Error("Choose either --quick or --thorough.");
  const workspaceRoot = resolveCommandWorkspace(options);
  const sessionId = getCurrentClaudeSessionId();
  if (action === "status") {
    const mode = sessionId ? readMode(workspaceRoot, sessionId) : null;
    const payload = { mode: mode ? "on" : "off", sessionId, ...(mode ? { scale: mode.scale, maxWorkers: mode.maxWorkers, since: mode.since } : {}), protocolFile: PROTOCOL_PATH };
    const text = `${renderUltraMode(mode)}\n${options["for-command"] ? `\n${fs.readFileSync(PROTOCOL_PATH, "utf8")}` : ""}`;
    outputCommandResult(payload, text, options.json);
    return;
  }
  if (!sessionId) throw new Error("Ultra-codex mode needs the Claude session id (CODEX_COMPANION_SESSION_ID, exported by the SessionStart hook); run this inside Claude Code.");
  if (action === "on") {
    if (options["for-command"]) throw new Error("--for-command applies to status only.");
    const maxWorkers = options["max-workers"] === undefined ? (readMode(workspaceRoot, sessionId)?.maxWorkers ?? DEFAULT_MAX_WORKERS) : Number(options["max-workers"]);
    const mode = setMode(workspaceRoot, sessionId, { scale: options.quick ? "quick" : options.thorough ? "thorough" : "auto", maxWorkers });
    const payload = { mode: "on", sessionId, scale: mode.scale, maxWorkers: mode.maxWorkers, since: mode.since, protocolFile: PROTOCOL_PATH };
    outputCommandResult(payload, `${renderUltraMode(mode)}\nFrom now on every substantive prompt in this session is orchestrated with Codex workers (a reminder is attached to each prompt); conversational turns and one-line fixes stay inline.\n`, options.json);
    return;
  }
  const wasOn = clearMode(workspaceRoot, sessionId);
  const running = listSessionJobs(workspaceRoot, sessionId).filter(job => ACTIVE.has(job.status)).map(job => ({ jobId: job.id, ...(job.agentName ? { agentName: job.agentName } : {}), title: job.title ?? null, status: job.status }));
  const payload = { mode: "off", sessionId, wasOn, runningJobs: running };
  const lines = [
    wasOn ? "Ultra-codex mode: off. Orchestration has ended for this session." : "Ultra-codex mode was already off for this session.",
    "Handle requests normally from here on; spawn Codex workers only when asked.",
    running.length ? `Codex jobs from this session still running: ${running.map(job => `${job.jobId} (${job.status})`).join(", ")}. Cancel them only if the user asks: node scripts/codex-companion.mjs cancel <jobId>.` : "No Codex jobs from this session are still running."
  ];
  outputCommandResult(payload, `${lines.join("\n")}\n`, options.json);
}

async function handleJournal(argv) {
  const { options, positionals } = parseCommandInput(argv, { valueOptions: ["cwd", "run"], booleanOptions: ["json"], rejectUnknown: true });
  const [action, type] = positionals;
  if (!["start", "add", "close", "show", "list"].includes(action) || positionals.length !== (action === "add" ? 2 : 1)) throw new Error("journal takes start, add <criteria|verdict|decision>, close, show or list.");
  if (options.run !== undefined && ["start", "list"].includes(action)) throw new Error(`journal ${action} does not accept --run.`);
  const cwd = resolveCommandWorkspace(options), sessionId = getCurrentClaudeSessionId();
  if (action === "list") {
    const runs = listRuns(cwd);
    outputCommandResult(runs, `${runs.map(run => `${run.runId} ${run.state}${run.judgment ? ` (${run.judgment})` : ""}: ${snippet(run.goal, 100)}`).join("\n") || "No Duet runs."}\n`, options.json);
    return;
  }
  if (action === "show") {
    const view = showRun(cwd, sessionId, options.run);
    outputCommandResult(view, renderRun(view), options.json);
    return;
  }
  let input;
  try { input = JSON.parse(readStdinIfPiped()); } catch { throw new Error("Journal stdin must contain valid JSON."); }
  const result = action === "start" ? startRun(cwd, sessionId, input)
    : action === "add" ? addEntry(cwd, sessionId, type, input, options.run) : closeRun(cwd, sessionId, input, options.run);
  outputCommandResult(result, `${JSON.stringify(result)}\n`, options.json);
}

async function handleCleanup(argv) {
  const { options, positionals } = parseCommandInput(argv, { valueOptions: ["days"], booleanOptions: ["dry-run", "json"] });
  if (positionals.length) throw new Error("cleanup accepts only --dry-run, --days N and --json.");
  const { planRetention, applyRetentionWithBroker } = await import("./lib/retention.mjs");
  const plan = planRetention({ days: options.days });
  const dryRun = options["dry-run"], result = dryRun ? plan : await applyRetentionWithBroker(plan);
  const bytes = dryRun ? [...plan.jobs, ...plan.runs, ...plan.runSessions, ...plan.markers, ...plan.threads].reduce((sum, item) => sum + item.bytes, 0) : result.bytesFreed;
  const counts = dryRun ? `${plan.jobs.length} jobs, ${plan.runs.length} runs, ${plan.runSessions.length} run pointers, ${plan.markers.length} markers, ${plan.threads.length} threads eligible` : `${result.jobsDeleted} jobs, ${result.runsDeleted} runs, ${result.runSessionsDeleted} run pointers, ${result.markersDeleted} markers, ${result.threadsDeleted} threads deleted; ${result.threadsSkipped} threads skipped`;
  const summary = `${dryRun ? "Dry run" : "Cleanup"} (${plan.days} days): ${counts}; ${(bytes / 1_000_000).toFixed(2)} MB ${dryRun ? "eligible; nothing deleted" : "freed"}.`;
  const legacyRetained = result.retained.filter(job => job.reason === "legacy-paths").length;
  outputCommandResult(result, `${[summary, ...(legacyRetained ? [`${legacyRetained} retained (legacy paths)`] : []), ...result.warnings, ...(result.errors.length ? [`${result.errors.length} errors/skips; use --json for details.`] : [])].join("\n")}\n`, options.json);
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    printUsage();
    return;
  }

  // Help wins even over malformed/conflicting options, before validation, stdin,
  // workspace resolution, setup writes, job creation or runtime startup.
  if (usageFor(subcommand) && optionTokens(argv).some(token => token === "--help" || token === "-h")) {
    printUsage(subcommand);
    return;
  }

  switch (subcommand) {
    case "journal":
      await handleJournal(argv);
      break;
    case "cleanup":
      await handleCleanup(argv);
      break;
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
    case "ultra-codex":
      await handleUltraCodex(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

main().catch((error) => {
  let message = error instanceof Error ? error.message : String(error);
  if (error.code === "UNKNOWN_OPTION" && usageFor(process.argv[2])) message += `\n\n${usageFor(process.argv[2])}`;
  if (["task", "wait"].includes(process.argv[2]) && requestsDirect(process.argv.slice(3))) writeDirectLineSync({ status: "error", error: message });
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
