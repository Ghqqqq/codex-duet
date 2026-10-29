#!/usr/bin/env node

import { spawnDetached } from "./lib/process.mjs";
import { codexRuntimeDiagnostic, executableOnPath, isolatedCodexCommand } from "./lib/codex-home.mjs";
import { UNREACHABLE_GUIDANCE } from "./lib/runtime-errors.mjs";
import { getToolAvailability, syncToolConfig } from "./lib/tool-config.mjs";
import { buildWorkerReport, parseStructuredReport, persistTaskArtifacts, taskArtifactPaths } from "./lib/worker-report.mjs";
import { normalizeBrowserOrigins, normalizeBundleIds } from "./lib/server-requests.mjs";
import { browserOriginSetup, computerUseSetup, transportSetup, defaultSandboxSetup, ensureBrowserApproval, ensureComputerUseApproval, ensureProjectDocs, projectDocsSetup, SANDBOX_MODES } from "./lib/setup-config.mjs";
import { activityReader, formatActivity, redactActivity, snippet } from "./lib/activity.mjs";
import { JobRuntime, ACTIVE, OWNER_GRACE_MS, seconds, ownerId, renewLease, requestCancel, answerQuestion, progressSnapshot, leaseExpiryReport, continuationReport, fullReport, directReport, envelopeBytes, adoptJob, ownershipNotice } from "./lib/job-runtime.mjs";
import { reserveAgentName, releaseAgentName } from "./lib/agent-names.mjs";
import { latestThreadJob, startedThreadSettings, recordedThreadSettings, requestGrantsInSession, resolveThreadInheritance, resolveWorkerTarget } from "./lib/worker-resolve.mjs";
import { writeSessionMarker } from "./lib/session-markers.mjs";
import { startRun, useRun, addEntry, closeRun, showRun, listRuns, renderRun, validateRun, renderValidation, linkJournalJob, finishJournalJob, validateTaskRun } from "./lib/run-journal.mjs";
import { recordFinishedJob, recordedThreadJobs, uniqueTurnAttribution } from "./lib/job-runtime.mjs";
import { listSessionJobs, updateJob, unresolvedTask, withoutPrivateActivity } from "./lib/state.mjs";
import { markReportEmitted } from "./lib/report-delivery.mjs";
import { clearMode, DEFAULT_MAX_WORKERS, PROTOCOL_PATH, protocolVersion, readMode, setMode } from "./lib/ultra-codex-mode.mjs";
import { snapshotWorkspace, compareWorkspaceSnapshots } from "./lib/workspace-changes.mjs";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { parseSessionArgs, splitRawArgumentString, splitReviewArgumentString } from "./lib/args.mjs";
import { COMMAND_ALIASES, COMMAND_OPTIONS, DIRECT_OPTION_CONFLICTS } from "./lib/command-options.mjs";
import {
    buildPersistentTaskThreadName,
    DEFAULT_CONTINUE_PROMPT,
    findLatestTaskThread,
    FORWARDED_APPROVALS_LABEL,
    getCodexAuthStatus,
    getCodexAvailability,
    getSessionRuntimeStatus,
    readAppServerTurn,
    releaseStaleTaskComputerGrants,
    cleanAppServerBackgroundTerminals,
    importExternalAgentSession,
    interruptAppServerTurn,
    parseStructuredOutput,
    readOutputSchema,
    runAppServerReview,
    runAppServerTurn
  } from "./lib/codex.mjs";
import { resolveClaudeSessionPath } from "./lib/claude-session-transfer.mjs";
import { prepareClaudeInstructions } from "./lib/claude-memory.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import { binaryAvailable, terminateProcessTree } from "./lib/process.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import {
  generateJobId,
  getConfig,
  listJobs,
  resolveJobFile,
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
  renderReviewDetails,
  validateReviewResultShape,
  renderStoredJobResult,
  renderCancelReport,
  renderJobStatusReport,
  renderSetupReport,
  renderStatusReport,
  renderTaskResult
} from "./lib/render.mjs";

// Preserve the launcher identity across blocking availability/startup work.
const LAUNCH_PARENT_PID = process.ppid;
const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const DUET_INVOCATION = process.argv[1] === path.join(ROOT_DIR, "bin", "duet");
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
// A closed diagnostic pipe must not prevent terminal state/journal persistence.
process.stderr.on("error", error => { if (error.code !== "EPIPE") throw error; });
function writeDirectLineSync(payload) {
  if (directOutputStarted) return false;
  directOutputStarted = true;
  const line = Buffer.from(`${JSON.stringify(payload)}\n`), deadline = Date.now() + 2000;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  let offset = 0;
  for (; offset < line.length && Date.now() < deadline;) {
    try { offset += fs.writeSync(1, line, offset, line.length - offset); }
    catch (error) {
      if (!["EAGAIN", "EWOULDBLOCK", "EINTR"].includes(error.code)) break;
    }
    // Keep the stop report last: do not run queued progress callbacks while
    // waiting for the reader, and never spin on a full nonblocking pipe.
    if (offset < line.length) Atomics.wait(pause, 0, 0, Math.min(10, Math.max(0, deadline - Date.now())));
  }
  return offset === line.length;
}

const COMMAND_USAGE = {
  journal: `Usage: duet journal <start|use|add|close|show|validate|list> [options]
Durable run criteria, verdicts and decisions in the isolated home.
  start [--switch]  Stdin JSON: {"goal":"...","criteria":["..."]}; prints {runId}.
    --switch leaves the previous run open, selects the new run and also prints previousRunId.
  use <runId>  Select an existing open run for this session, including across workspaces; prints {runId}.
  add <criteria|withdraw|verdict|decision> [--run <id>]  Stdin JSON:
    criteria: {"criteria":["..."]}
      Re-adding the same text reactivates a withdrawn criterion.
    withdraw: {"criteria":["..."],"reason":"..."}
      Known criteria only; show as withdrawn with their reason and no unchecked/unmet issue.
    verdict: {"jobId":"...","verdict":"ACCEPT|ACCEPT_WITH_GLUE|REWORK|REASSIGN",
              "criteria":[{"criterion":"...","evidence":"...","result":"met|not_met|cannot_verify"}],"reason":"..."}
      Criterion: declared exact text, a unique trailing-… prefix from show, or a unique id: K7/K7:, or F3/F3: for "F3: …".
      Unknown/ambiguous criteria are rejected; introduce new ones with add criteria.
      Historical verdict-only criteria keep their existing validation behavior; no migration is performed.
      Optional resolves: ["<jobId>", ...] names linked jobs in this run whose REWORK/REASSIGN
      a later ACCEPT/ACCEPT_WITH_GLUE resolves, regardless of session. Unknown resolves IDs are rejected.
    decision: {"summary":"...","basis":"...","risk":"optional"}
  close [--run <id>]  Stdin: {"judgment":"passed|blocked|abandoned","summary":"...","openRisks":[]}.
    passed refuses open issues (exit 2); blocked/abandoned record them as openIssues.
  show [--run <id>]  Recover criteria evidence and next actions; paths refer to saved brief/report copies.
  validate [--run <id>]  Read-only completeness check with next actions; exit 0 if clean, 2 if issues.
  list  Workspace runs, newest first.
  --cwd, -C <dir>  Workspace for start/list/fallback; use/--run resolve across workspaces in the isolated home.
  --json  Full JSON view; --help, -h  Side-effect-free help.
Start/use need CODEX_COMPANION_SESSION_ID. Add/close/show/validate use the session's active run across workspaces.
Without an active run, add/close and task linking use the sole open workspace run; with several open
runs add/close require journal use <runId> or --run, and tasks stay unlinked. Only use/start change the active pointer.
Show/validate fall back to the newest workspace run when none is active.`,
  task: `Usage: duet task [options] <<'DUET_TASK'
Read the brief only from stdin; implies --direct. Fresh unless --to/--thread/--continue/--resume/--resume-last.
  --help, -h  Show help without starting anything; unknown task flags are errors.
  --name <label>  Prefer this worker name on a fresh thread; follow-ups keep their name.
    Use 1-64 ASCII letters, digits, _, . or -, starting with a letter or digit.
    A reserved name falls back to the name pool; the report carries the actual name.
  --to <worker|jobId>  Follow up in that worker's cwd on the same thread.
  --thread <threadId>  Follow up on an exact thread; --fresh  Start a new thread (default).
  --to/--thread inherit model, effort, sandbox and speed from started attempts; explicit flags override.
    Request grants require original dispatch in this Claude session; runtime-only approvals and
    foreign dispatches after adoption are excluded. Explicit --thread may inherit settings across sessions.
  --continue <jobId>  Continue a finished job with recorded settings and eligible request grants.
    Rejects inherited-setting overrides, except --sandbox when the selected job lacks recorded sandbox.
    Missing sandbox settings require explicit --sandbox (thread_settings_unknown).
  --resume-last, --resume  Latest task thread, inheriting recorded settings; never select parallel workers.
  --fork  Import the current Claude transcript into a new thread, then run the stdin brief.
  --source <jsonl>  Override the transcript for --fork; import fidelity is not verified.
    --fork conflicts with to, thread, continue, resume and resume-last.
    CODEX_COMPANION_IMPORT_MAX_BYTES caps imports (default 20 MiB); oversized imports fail.
  --no-claude-md  Disable automatic Claude instruction forwarding for a fresh thread.
    CODEX_COMPANION_CLAUDE_MD=0 also disables it. Existing threads retain their instructions.
  --model, -m <model|spark>  Default gpt-6-astra; spark = gpt-5.3-codex-spark.
  --effort <none|minimal|low|medium|high|xhigh|max>  Default xhigh.
  --fast  Priority speed; --normal  Normal speed (fresh default); choose one.
  --cwd, -C <dir>  Workspace directory; --session <id>  Override the Claude session id.
  --run <id|none>  Override journal linkage for this dispatch only; follow-ups do not inherit it.
    none skips linking; an explicit run must be open in this isolated home, across workspaces.
    Invalid or closed runs fail before a worker starts; omission uses the session's active run.
  --direct  Implied: owned wait with /tasks progress, then report v2; --quiet  JSON line only.
  --sandbox <read-only|workspace-write|danger-full-access>  Override configured/inherited sandbox.
  --write[=false]  At least workspace-write; false requests read-only absent sandbox.
  --approve-browser-origin <origin>  Explicitly consented origin; repeatable.
  --approve-computer-app <bundle-id>  Explicitly consented app; repeatable.
  --owner <id>  Owner identity; --lease-sec <s>  Lease (direct default 1800).
  --question-timeout-sec <s>  Answer deadline (900); --timeout-sec <s>  Wait budget (3600; max 3600).
Direct conflicts: follow, detached, background, json, feed-limit, min-interval-sec.
Run each task/answer/wait as Bash(command: <shell below>, run_in_background: true, timeout: 600000).
duet task --model gpt-6-astra --effort xhigh --normal <<'DUET_TASK'
<brief: objective, context, owned paths, constraints, acceptance criteria>
DUET_TASK
Parallel jobs: dispatch separate task calls; use disjoint owned paths or separate --cwd values.
Follow-up (replace Ada with the report's worker):
duet task --to Ada <<'DUET_TASK'
Apply the requested follow-up within the original owned paths.
DUET_TASK
Use single-quoted arguments and DUET_TASK/DUET_ANSWER heredocs. Double quotes, pipes,
compound commands and flags outside the permission hook's allowlist use normal permissions.
Result: the report arrives with the completion notification. Only if missing: duet result <worker>.
Report v2: status, worker, jobId, summary; nonempty blockers/question/changedFiles/checks/assumptions/keyFindings;
optional usage (inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens, totalTokens)
contains integer counts for this turn only, is omitted when unknown, and precedes next and details.
question.optionsOmitted counts choices removed to fit the 2000-byte envelope excluding summary.
next is the suggested command or null; details is duet result '<jobId>' --details, always the exact job.
  completed: verify the summary, diff and checks; checks.ran is captured, checks.claimed is Codex's account.
  running: duet wait <worker> in background Bash; wait for its notification.
  needs_answer: use next verbatim, or duet answer <worker> --question '<questionId>' with stdin.
    A bare answer selects whatever question is pending now, possibly a newer one. See answer --help.
  error: check duet status before resubmitting. For stopped/blocked/failed work, inspect --details.
Never parse output files, poll or run two waits for one job. Continue user-stopped work only with consent.
Compatibility: node "$CODEX_COMPANION" <subcommand> still works. Its task accepts positional text,
--prompt-file <file>, --report/--json, --follow (feed wait), --detached (return handles),
--background (legacy launch), and --feed-limit <n> (60; 0 unlimited), outside direct mode.`,
  setup: `duet setup reports invocation availability, selected runtime source and readiness.
Usage: duet setup [options]
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
  --enable-review-gate, --disable-review-gate  Toggle stop-time review gate (always read-only, also in plan mode).`,
  review: `Usage: duet review [options]
Read-only native review; no focus text. --help, -h exits without starting a review.
  --base <ref>  Base revision; --scope <auto|working-tree|branch>  Review target.
  --model, -m <model>  Model; --cwd, -C <dir>  Workspace; --json  JSON output.
  --args-stdin  Read raw review arguments via a single-quoted heredoc (e.g. DUET_ARGS), without shell expansion.
  --wait, --background  Accepted routing hints; this helper stays in the foreground.`,
  "adversarial-review": `Usage: duet adversarial-review [options] [focus text]
Read-only adversarial review. --help, -h shows help.
Unknown flags within 2 edits of a known option are rejected as likely typos;
other unknown flags remain focus text. Use -- for literal typo-like focus text.
  --base <ref>  Base revision; --scope <auto|working-tree|branch>  Review target.
  --model, -m <model>  Model; --cwd, -C <dir>  Workspace; --json  JSON output.
  --args-stdin  Read raw review arguments via a single-quoted heredoc (e.g. DUET_ARGS), without shell expansion.
  --wait, --background  Accepted routing hints; this helper stays in the foreground.
  --  Treat remaining tokens, including help flags, as literal focus text.`,
  transfer: `Usage: duet transfer [--source <claude-jsonl>] [--cwd <dir>] [--json]
Import a Claude transcript; source defaults to the current session transcript.
  --args-stdin  Read raw arguments from stdin without shell expansion (use a single-quoted heredoc).
  --cwd, -C  Workspace; --json  JSON output; --help, -h  Show help.`,
  status: `Usage: duet status [worker|jobId|--thread <id>] [options]
Show session jobs or a selected worker/job/thread; --all includes other sessions.
Example: duet status
  --wait  Wait for completion; --timeout-ms <ms>  Budget; --poll-interval-ms <ms>  Poll interval.
  --owner <id>  Renew that owner; omit for observation.
  --args-stdin  Read raw arguments from stdin without shell expansion (use a single-quoted heredoc).
  --cwd, -C <dir>  Workspace; --json  JSON output; --help, -h  Help.`,
  result: `Usage: duet result <worker|jobId> [--details] [--cwd <dir>]
Read report v2 without starting a turn. Use when a completion notification lacks its report.
  --details  Full report: handles, settings, evidence, paths and recovery commands.
  --report  Report v2 (also the default); --json alone  Stored payload.
  --thread <id>  Latest tracked turn on that thread; jobId selects an older turn.
  --args-stdin  Read raw arguments from stdin without shell expansion (use a single-quoted heredoc).
  --cwd, -C <dir>  Workspace; --help, -h  Help.
Example: duet result Ada --details`,
  wait: `Usage: duet wait <worker|jobId> [options]
Resolve the owner and wait with direct output, renewing its lease. Never run two waits for one job.
Run in background Bash; the report arrives with the completion notification.
Only if the report is missing: duet result <worker>.
Example: duet wait Ada
  --owner <id>  Explicit owner; --after-question <id>  Wait past that question.
  --timeout-sec <s>  Budget (3600; max 3600); --quiet  Suppress progress.
  --details  Full report instead of report v2; --direct  Implied by duet.
  --cwd, -C <dir>  Workspace; --help, -h  Help without attaching.
Direct conflicts: json, feed-limit, min-interval-sec. The compatibility companion's non-direct
wait also accepts --report, --json, --feed-limit <n> (60; 0 unlimited) and --min-interval-sec <s>.`,
  adopt: `Usage: duet adopt <job-id> [--cwd <dir>] [--json]
Take ownership of an orphaned job; --json prints its new owner and wait command.
  --cwd, -C  Workspace; --help, -h  Show help without adopting.`,
  answer: `Usage: duet answer <worker|jobId> --question '<questionId>' [options] <<'DUET_ANSWER'
Use the report's next command verbatim, or retain its displayed question ID explicitly.
Resolve the owner, submit stdin once, and wait on the same turn.
Run ONE background Bash call (run_in_background: true, timeout: 600000):
duet answer Ada --question '<questionId>' <<'DUET_ANSWER'
<answer text>
DUET_ANSWER
Never pass answer text on the command line or start a second wait.
Replace <questionId> with the ID you saw. --question rejects a stale/answered ID.
A bare duet answer <worker> answers whatever question is pending now, which may be newer
than the one you saw. Native SendMessage already pins the displayed question and is unaffected.
Computer Use approvals accept only an exact displayed option label, its number 1-4,
or call/once/task/always/deny/no. Answers are trimmed and case-insensitive; exact labels
allow a trailing period. Anything else denies, including yes, negations or qualified text.
Send only the choice, without explanation; native SendMessage uses the same rules.
A different owner or attached wait is refused without submitting.
  --owner <id>  Explicit owner; otherwise resolved.
  --question <id>  Pin the displayed question; omission selects the currently pending question.
  --timeout-sec <s>  Wait budget (3600; max 3600); --quiet  JSON line only; --direct  Implied.
  --cwd, -C <dir>  Workspace; --help, -h  Help without answering.
The report arrives with the completion notification; only if missing: duet result <worker>.
The compatibility companion supports --json receipts without --direct.`,
  cancel: `Usage: duet cancel <worker|jobId> [--cwd <dir>] [--json]
Cancel the selected active job and report whether interruption was confirmed.
Example: duet cancel Ada
Omit the target only when the session has one active job.
  --args-stdin  Read raw arguments from stdin without shell expansion (use a single-quoted heredoc).
  --cwd, -C <dir>  Workspace; --json  JSON confirmation; --help, -h  Help without cancelling.`,
  cleanup: `Usage: duet cleanup [--dry-run] [--days <N>] [--json]
Remove eligible ended jobs, inactive runs, markers and unreferenced threads.
  --dry-run  Preview only; --days  Retention age; --json  JSON details; --help, -h  Show help without cleanup.`,
  "ultra-codex": `Usage: duet ultra-codex [on|off|status] [options]
Set or inspect this session's mode (default action: status).
  --quick, --thorough  Scale; --max-workers <n>  Worker cap; --for-command  Include protocol with status.
  --cwd, -C <dir>  Workspace; --json  JSON output; --help, -h  Show help without changing mode.`,
  "task-worker": `Usage: duet task-worker --job-id <id> [--cwd <dir>]
Internal detached worker entry point; --job-id selects a stored task.
  --cwd, -C  Workspace; --help, -h  Show help without starting a worker.`,
  "task-resume-candidate": `Usage: duet task-resume-candidate [--cwd <dir>] [--json]
Find the latest resumable task in this session; --json prints its handles.
  --cwd, -C  Workspace; --help, -h  Show help.`
};

function usageFor(subcommand) {
  return Object.hasOwn(COMMAND_USAGE, subcommand) ? COMMAND_USAGE[subcommand] : null;
}

function printUsage(subcommand) {
  console.log(usageFor(subcommand) ?? [
    "Usage: duet <subcommand> [options]",
    ...Object.values(COMMAND_USAGE).map(usage => `  ${usage.split("\n").find(line => line.startsWith("Usage: ")).slice("Usage: ".length)}`),
    'Run duet <subcommand> --help (or -h) for flags and examples.',
    "duet task: one owned job per background Bash call; report v2 arrives with the completion notification.",
    "All companion commands accept --session <id>, overriding CODEX_COMPANION_SESSION_ID.",
    "Help exits before starting anything. duet task and answer read text only from stdin."
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

function normalizeArgv(argv, argsStdin = false, config = {}) {
  if (argv.length === 1) {
    const [raw] = argv;
    argv = raw?.trim() ? splitRawArgumentString(raw) : [];
  }
  const index = argsStdin ? argv.indexOf("--args-stdin") : -1;
  const separator = argv.indexOf("--");
  if (index >= 0 && (separator < 0 || index < separator)) {
    // Review preserves literal focus text; job commands parse every token.
    const split = argsStdin === "raw" ? splitRawArgumentString : splitReviewArgumentString;
    return [...argv.slice(0, index), ...split(readStdinIfPiped(), config), ...argv.slice(index + 1)];
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  const rawArgsStdin = ["transfer", "status", "result", "cancel"].includes(process.argv[2]);
  const tokens = normalizeArgv(argv, rawArgsStdin ? "raw" : false);
  const separator = tokens.indexOf("--");
  if (rawArgsStdin && (separator < 0 ? tokens : tokens.slice(0, separator)).some(token => token === "--help" || token === "-h")) {
    printUsage(process.argv[2]);
    process.exit(0);
  }
  return parseSessionArgs(tokens, {
    rejectUnknown: true,
    ...config,
    valueOptions: [...(config.valueOptions ?? []), ...(config.internalValueOptions ?? [])],
    aliasMap: {
      ...COMMAND_ALIASES,
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
  const SETUP_READINESS_TIMEOUT_MS = 45000, TOOL_VERSION_TIMEOUT_MS = 10000;
  const deadline = Date.now() + SETUP_READINESS_TIMEOUT_MS;
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd, timeoutMs: TOOL_VERSION_TIMEOUT_MS });
  const npmStatus = binaryAvailable("npm", ["--version"], { cwd, timeoutMs: TOOL_VERSION_TIMEOUT_MS });
  const codexStatus = getCodexAvailability(cwd, { deadline });
  Object.assign(codexStatus, codexRuntimeDiagnostic(cwd, codexStatus, process.env, { deadline }));
  const authStatus = await getCodexAuthStatus(cwd, { deadline, availability: codexStatus });
  const config = getConfig(workspaceRoot);
  const canAccess = (file, mode) => {
    try { fs.accessSync(file, mode); return fs.statSync(file).isFile(); } catch { return false; }
  };
  const bundledDuet = path.join(ROOT_DIR, "bin", "duet");
  const pathDuet = executableOnPath("duet");
  const duetPath = pathDuet && canAccess(bundledDuet, fs.constants.X_OK) && fs.realpathSync(pathDuet) === fs.realpathSync(bundledDuet) ? pathDuet : bundledDuet;
  const companionPath = process.env.CODEX_COMPANION || null;
  const invocation = {
    duet: { available: nodeStatus.available && canAccess(duetPath, fs.constants.X_OK), path: duetPath },
    companionEnv: { set: Boolean(companionPath), path: companionPath }
  };
  const companionAvailable = nodeStatus.available && companionPath && canAccess(companionPath, fs.constants.R_OK);

  const nextSteps = [];
  if (!codexStatus.available) {
    nextSteps.push(codexStatus.guidance);
  }
  if (codexStatus.warning) nextSteps.push(codexStatus.warning.message);
  const quote = value => `'${String(value).replace(/'/g, `'"'"'`)}'`;
  nextSteps.push(`Invocation: duet ${invocation.duet.available ? `works at ${duetPath}` : "is unavailable"}; CODEX_COMPANION ${companionAvailable ? "works" : companionPath ? "points to an unreadable file" : "is unset"}.`);
  if (invocation.duet.available) nextSteps.push(`Use: ${duetPath === pathDuet ? "duet" : quote(duetPath)} task --cwd ${quote(workspaceRoot)} <<'BRIEF'\n<brief>\nBRIEF`);
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
    ready: Boolean(nodeStatus.available && codexStatus.available && authStatus.loggedIn && (invocation.duet.available || companionAvailable)),
    invocation,
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
  outputResult(options.json ? finalReport : `${renderSetupReport(finalReport)}Selected Codex: ${finalReport.codex.executable} (source: ${finalReport.codex.source}).\n`, options.json);
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
    throw new Error(codexRuntimeDiagnostic(cwd, availability).guidance);
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

function renderStatusPayload(report, asJson, options = {}) {
  return asJson ? report : renderStatusReport(report, options);
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
  request = { ...request, cwd: ensureGitRepository(request.cwd) };
  ensureCodexAvailable(request.cwd);

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
    const validationError = result.status === 0 && !result.reviewText?.trim() ? "Native review returned empty output." : null;
    const exitStatus = result.status || (validationError ? 1 : 0);
    const failureMessage = validationError ?? (result.status !== 0
      ? result.error?.message || result.turn?.error?.message || result.stderr?.trim() || "No failure details were returned."
      : null);
    const summary = failureMessage
      ? `${reviewName} failed: ${firstMeaningfulLine(failureMessage)}`
      : firstMeaningfulLine(result.reviewText, `${reviewName} completed.`);
    const stderr = [result.stderr, failureMessage].filter(Boolean).filter((value, index, values) => values.indexOf(value) === index).join("\n");
    const payload = {
      review: reviewName,
      target,
      threadId: result.threadId,
      sourceThreadId: result.sourceThreadId,
      turnEnded: Boolean(result.turnEnded),
      status: exitStatus,
      ...(validationError ? { errorCode: "review_output_invalid", validationError } : {}),
      ...(failureMessage ? { error: failureMessage, rawOutput: [`${reviewName} failed: ${failureMessage}`, result.reviewText].filter(Boolean).join("\n\n") } : {}),
      codex: {
        status: result.status,
        stderr,
        stdout: result.reviewText,
        reasoning: result.reasoningSummary
      }
    };
    const rendered = renderNativeReviewResult(
      {
        status: exitStatus,
        stdout: result.reviewText,
        stderr
      },
      { reviewLabel: reviewName, targetLabel: target.label, reasoningSummary: result.reasoningSummary }
    );

    return {
      exitStatus,
      threadId: result.threadId,
      turnId: result.turnId,
      payload,
      rendered,
      summary,
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
  const validationError = parsed.parseError || validateReviewResultShape(parsed.parsed);
  const outputInvalid = result.status === 0 && Boolean(validationError);
  const exitStatus = result.status || (outputInvalid ? 1 : 0);
  const payload = {
    review: reviewName,
    target,
    threadId: result.threadId,
    turnEnded: Boolean(result.turnEnded),
    status: exitStatus,
    ...(outputInvalid ? { errorCode: "review_output_invalid", error: validationError } : {}),
    validationError,
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
    exitStatus,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered: renderReviewResult(parsed, {
      reviewLabel: reviewName,
      targetLabel: context.target.label,
      reasoningSummary: result.reasoningSummary
    }),
    summary: outputInvalid ? `${reviewName} failed: ${validationError}` : parsed.parsed?.summary ?? parsed.parseError ?? firstMeaningfulLine(result.finalMessage, `${reviewName} finished.`),
    jobTitle: `Codex ${reviewName}`,
    jobClass: "review",
    targetLabel: context.target.label
  };
}


function taskBrief(request) {
  const prompt = request.report ? `${request.prompt || DEFAULT_CONTINUE_PROMPT}\n\n${loadPromptTemplate(ROOT_DIR, "worker-task")}` : request.prompt;
  return prompt?.trim() || (request.threadId || request.resumeLast ? DEFAULT_CONTINUE_PROMPT : "");
}

function threadBlocker(workspaceRoot, jobs, threadId, jobId) {
  const order = (a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")) || a.id.localeCompare(b.id);
  const current = jobs.find(job => job.id === jobId);
  const candidates = jobs.filter(job => job.id !== jobId && job.threadId === threadId)
    .map(job => readStoredJob(workspaceRoot, job.id) ?? job)
    .filter(job => job.status !== "blocked" && (ACTIVE.has(job.status) || ((job.turnId || job.status === "failed") && unresolvedTask(job))));
  // Prefer the actual turn over queued follow-ups that will themselves be
  // refused. With no turn yet, the oldest reservation wins admission.
  return candidates.filter(job => job.turnId || job.status === "failed").sort(order)[0]
    ?? candidates.filter(job => !current || order(job, current) < 0).sort(order)[0];
}

function threadBusyExecution(workspaceRoot, predecessor, request, taskMetadata) {
  const stored = readStoredJob(workspaceRoot, predecessor.id) ?? predecessor;
  const blocker = threadBusyBlocker(workspaceRoot, stored);
  // Preserve the foreground CLI's stderr diagnostic alongside its typed result.
  if (!request.detached) process.stderr.write(`${blocker.message}\n`);
  return buildTaskExecution({ status: 0, threadId: predecessor.threadId, turnId: null, finalMessage: blocker.message, blockers: [blocker] }, request, taskMetadata);
}

function threadBusyBlocker(workspaceRoot, stored) {
  const quote = value => `'${String(value).replace(/'/g, `'"'"'`)}'`;
  // Observation must not attach another wait to an existing owner's lease.
  const recoveryCommand = `node ${quote(fileURLToPath(import.meta.url))} status ${quote(stored.id)} --cwd ${quote(workspaceRoot)} --json`;
  const condition = ACTIVE.has(stored.status) ? "is already running" : "has an unresolved turn";
  const cancelCommand = ACTIVE.has(stored.status) || unresolvedTask(stored)
    ? `node ${quote(path.join(ROOT_DIR, "bin", "duet"))} cancel ${quote(stored.id)} --cwd ${quote(workspaceRoot)} --json` : null;
  const ownerReport = directReport(progressSnapshot(stored), stored);
  const blocker = { code: "thread_busy", predecessorJobId: stored.id, predecessorStatus: stored.status,
    message: `Codex thread ${stored.threadId} ${condition} in task ${stored.id}. ${cancelCommand ? "Use recoveryCommand to check it, or cancelCommand to interrupt that exact turn and confirm it stopped." : "Resolve that predecessor with the recovery command before continuing."}`,
    recoveryCommand, ...(cancelCommand ? { cancelCommand } : {}),
    ...(ownerReport.status === "needs_answer" && ownerReport.question?.id
      ? { question: ownerReport.question, answerCommand: ownerReport.next } : {}) };
  return blocker;
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
    for (const candidate of listJobs(workspaceRoot).filter(job => job.threadId === resumeThreadId && job.id !== request.jobId)) {
      restoreMissingTaskRecord(workspaceRoot, candidate);
    }
    const predecessor = threadBlocker(workspaceRoot, listJobs(workspaceRoot), resumeThreadId, request.jobId);
    // A lost turn/start response leaves no turn ID. Read that predecessor's
    // thread before admission, just as we reconcile an exact recorded turn.
    if (predecessor) await reconcileLostTurn(workspaceRoot, predecessor, { admittingJobId: request.jobId });
    // Claim the target before starting a turn. updateState serializes competing
    // workers; unrelated threads remain free to run in parallel. Recovery does
    // network I/O outside this lock; always recheck all blockers after it.
    let blocker;
    updateState(workspaceRoot, (state) => {
      blocker = threadBlocker(workspaceRoot, state.jobs, resumeThreadId, request.jobId);
      if (blocker) return;
      const current = state.jobs.find((job) => job.id === request.jobId);
      if (!current) throw new Error("The current task record is missing; refusing to resume a thread without tracking its active turn.");
      current.threadId = resumeThreadId;
    });
    if (blocker) return threadBusyExecution(workspaceRoot, blocker, request, taskMetadata);
  }

  const before = snapshotWorkspace(workspaceRoot);
  const sandbox = request.sandbox ?? (request.write ? "workspace-write" : "read-only");
  // Only an owned (detached/--follow) job has a parent polling for questions, so
  // only there can a Computer Use request be forwarded; a plain foreground run
  // keeps "never" and such a request fails closed at once.
  const approvalPolicy = request.detached ? FORWARDED_APPROVALS_LABEL : "never";
  updateJob(workspaceRoot, request.jobId, () => ({ preExistingChanges: before.preExistingChanges, sandbox, approvalPolicy }));
  request.onProgress?.(`Sandbox: ${sandbox}; approval policy: ${approvalPolicy}${request.detached ? " (Computer Use app requests are forwarded to the parent)" : ""}. Captured workspace baseline (${before.status}).`);

  const runtime = new JobRuntime(workspaceRoot, request.jobId, { foreground: !request.detached, parentPid: LAUNCH_PARENT_PID, onProgress: request.onProgress });
  let result;
  try {
    if (!request.detached) runtime.abort.signal.throwIfAborted();
    result = await runAppServerTurn(workspaceRoot, {
    executionCwd: fs.realpathSync(request.cwd),
    jobId: request.jobId,
    onThreadBusy: (threadId, turnIds) => {
      const owner = recordedThreadJobs(threadId).jobs.find(job => job.id !== request.jobId && (turnIds.includes(job.turnId) || (!turnIds.length && ACTIVE.has(job.status))));
      const blocker = owner ? threadBusyBlocker(owner.workspaceRoot, owner) : { code: "thread_busy" };
      return { ...blocker, turnId: turnIds[0], message: `Codex thread ${threadId} ${turnIds.length ? `has in-progress or unresolved turn ${turnIds.join(", ")}` : "has a turn awaiting acceptance"}. ${blocker.message ?? "Resolve that turn before continuing."}` };
    },
    developerInstructions: request.developerInstructions,
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
    ...(result.codexErrorInfo != null ? { codexErrorInfo: result.codexErrorInfo } : {}),
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
    ...(result.usage ? { usage: result.usage } : {}),
    reasoningSummary: result.reasoningSummary,
    startupTimings: result.startupTimings ?? {}, startupWarning: result.startupWarning ?? null,
    turnEnded: Boolean(result.turnEnded),
    ...(result.inferredCompletion === true ? { inferredCompletion: true, turnStatus: result.turnStatus ?? null } : {}),
    interruptionReason: result.interruptionReason ?? null, interruptionConfirmed: result.interruptionConfirmed ?? null
  };
  const trackedJob = readStoredJob(resolveWorkspaceRoot(request.cwd), request.jobId);
  const provenance = result.recovered ? { recovered: true, recoveredAt: result.recoveredAt, completedAt: result.completedAt, recovery: result.recovery } : {};
  Object.assign(payload, provenance);
  Object.assign(payload, { ...(trackedJob?.agentName ? { agentName: trackedJob.agentName } : {}), ownerId: trackedJob?.ownerId ?? null, sessionId: trackedJob?.sessionId ?? null });
  const artifacts = persistTaskArtifacts(resolveWorkspaceRoot(request.cwd), request.jobId, payload);
  const report = buildWorkerReport(payload, { jobId: request.jobId, ...artifacts });
  Object.assign(report, { ...(trackedJob?.agentName ? { agentName: trackedJob.agentName } : {}), ownerId: payload.ownerId, sessionId: payload.sessionId }, leaseExpiryReport({ ...trackedJob, threadId: payload.threadId, result: payload }));
  if (payload.interruptionReason) {
    if (payload.interruptionReason !== "codex_runtime_restarted") {
      report.status = payload.interruptionReason === "cancelled_by_user" ? "cancelled" : "interrupted";
    }
    // Any interruption leaves a resumable thread; publish the continuation so a
    // replacement worker can pick the task up without reconstructing flags.
    Object.assign(report, continuationReport({ ...trackedJob, id: request.jobId, threadId: payload.threadId, workspaceRoot: resolveWorkspaceRoot(request.cwd) }));
  }
  if (result.recovered) {
    Object.assign(report, provenance);
    // A completed server turn still uses the normal worker-report outcome.
    if (!payload.interruptionReason && ["failed", "interrupted"].includes(result.turnStatus)) report.status = result.turnStatus;
  }
  Object.assign(payload, artifacts, { workerStatus: report.status });

  return {
    exitStatus: report.status === "blocked" ? 2 : result.status !== 0 ? result.status : exitCodeForReport(report.status),
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
  // Set once on creation; adoption may change sessionId, never this origin.
  const record = { ...job, reportTracking: 1, launcherPid: process.pid, dispatchSessionId: job.sessionId ?? null, ownerId: lifecycle.owner ?? ownerId(job.id), sessionId: job.sessionId ?? null, leaseRenewedAt: Date.now(), leaseSec: lifecycle.leaseSec ?? 180, questionTimeoutSec: lifecycle.questionTimeoutSec ?? 900,
    ...(identity.dispatchNonce ? { dispatchNonce: identity.dispatchNonce } : {}),
    ...(identity.dispatchToolUseId ? { dispatchToolUseId: identity.dispatchToolUseId,
      deliveryBindings: [{ toolUseId: identity.dispatchToolUseId, sessionId: job.sessionId ?? null }] } : {}),
    leaseExpiresAt: Date.now() + (lifecycle.leaseSec ?? 180) * 1000,
    sandbox: sandbox ?? (write ? "workspace-write" : "read-only"), approvalPolicy: detached ? FORWARDED_APPROVALS_LABEL : "never", approvedBrowserOrigins, approvedComputerApps, ...taskArtifactPaths(workspaceRoot, job.id) };
  // Reserve the name under the same workspace lock that publishes job state.
  // Concurrent dispatches see this queued reservation before either launches.
  const stored = listJobs(workspaceRoot);
  const inheritedPrevious = !identity.continued && identity.threadId ? resolveThreadInheritance(workspaceRoot, identity.threadId).job : null;
  let duplicateDispatch, releaseReservation;
  updateState(workspaceRoot, state => {
    const currentIds = new Set(state.jobs.map(candidate => candidate.id));
    const candidates = [...state.jobs, ...stored.filter(candidate => !currentIds.has(candidate.id))];
    if (identity.dispatchNonce) {
      duplicateDispatch = candidates.find(candidate => candidate.dispatchNonce === identity.dispatchNonce && candidate.sessionId === record.sessionId);
      if (duplicateDispatch) return;
    }
    const previous = identity.continued ?? (identity.threadId ? [...candidates, inheritedPrevious]
      .filter(candidate => candidate?.threadId === identity.threadId)
      .sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")) || b.id.localeCompare(a.id))[0] : null);
    const recent = Date.now() - 24 * 60 * 60 * 1000;
    const previousSession = (previous?.sessionId === undefined ? previous?.ownerId : previous.sessionId) || null;
    // 1.3 named workers per workspace, so one session can hold the same name on
    // two threads. Keep the name only while no other thread's job is live with it.
    const liveElsewhere = name => Boolean(record.sessionId) && listSessionJobs(workspaceRoot, record.sessionId)
      .some(job => job.agentName?.toLowerCase() === name.toLowerCase() && job.threadId !== identity.threadId && ACTIVE.has(job.status));
    record.agentName = previous?.agentName && (!record.sessionId || previousSession === record.sessionId) && !liveElsewhere(previous.agentName) ? previous.agentName : reserveAgentName(candidates
      .filter(candidate => !record.sessionId || ((candidate.sessionId === undefined ? candidate.ownerId : candidate.sessionId) || null) === record.sessionId)
      .filter(candidate => ACTIVE.has(candidate.status) || Date.parse(candidate.createdAt) >= recent)
      .map(candidate => candidate.agentName).filter(Boolean), { cwd: workspaceRoot, sessionId: record.sessionId, preferredName: previous?.agentName ?? identity.agentName, threadId: identity.threadId,
        claimOwner: identity.nativeAgentName ? identity.dispatchNonce || record.id : null,
        onReserved: (name, release) => { releaseReservation = release ?? (() => releaseAgentName(record.sessionId, name)); } });
    if (identity.threadId) record.threadId = identity.threadId;
    if (previous) record.followUpOf = previous.id;
    if (identity.continued) record.continuationOf = identity.continued.id;
    state.jobs.unshift({ ...record, status: "queued", ...(identity.threadId ? { threadId: identity.threadId } : {}) });
  });
  // The nonce is reserved under the same lock as the queued job. Never enqueue
  // another worker, even if a competing launcher has not published handles yet.
  if (duplicateDispatch) return { ...duplicateDispatch, dispatchReused: true };
  try {
    const linkedRun = linkJournalJob({ ...record, cwd: identity.cwd, model: identity.model, effort: identity.effort, request: { run: identity.run } }, taskBrief(identity));
    if (linkedRun) {
      Object.assign(record, linkedRun);
      updateJob(workspaceRoot, record.id, () => linkedRun);
    }
  } catch (error) {
    if (identity.run !== undefined && identity.run !== "none") {
      // Linking may have succeeded before the private job write failed. Keep
      // that durable start paired with a terminal report, even without a job.
      if (record.runId) {
        const recorded = finishJournalJob({ ...record, status: "failed" }, {
          status: "failed", summary: `Dispatch rejected before worker launch: ${shorten(redactActivity(error.message), 240)}`
        });
        error.message += recorded
          ? `\nJournal ${record.runId} recorded the rejected dispatch as failed.`
          : `\nJournal ${record.runId} could not record the rejected dispatch; inspect the run.`;
      }
      // Nothing has launched. Roll back the reservation under the same state
      // lock that published it; commitState also removes any private job file.
      // A failed record without a result could block thread admission and
      // advertise an undelivered ending for a worker that never started.
      updateState(workspaceRoot, state => {
        state.jobs = state.jobs.filter(candidate => candidate.id !== record.id);
      });
      if (releaseReservation) {
        try { releaseReservation(); }
        catch (releaseError) { error.message += `\nAgent name reservation could not be released: ${releaseError.message}`; }
      }
      throw error;
    }
    // Automatic journal storage failures remain best effort; ambiguity does not.
  }
  return record;
}

function buildTaskRequest({ cwd, model, effort, serviceTier, prompt, write, sandbox, approvedBrowserOrigins = [], approvedComputerApps = [], resumeLast, threadId, jobId, report, detached = false, developerInstructions, claudeMd }) {
  return {
    cwd,
    model,
    effort,
    serviceTier,
    prompt,
    developerInstructions,
    claudeMd,
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
    "Imported Claude conversation into a Codex thread (fidelity not verified).",
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
    sourceSha256: result.sourceSha256,
    importId: result.importId,
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

async function outputTrackedResult(value, asJson, job, status = job.status) {
  const text = asJson ? `${JSON.stringify(value, null, 2)}\n` : value;
  await new Promise(resolve => process.stdout.write(text, error => {
    if (!error) markReportEmitted(job, status);
    resolve();
  }));
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
  const output = options.report ? (options.json ? execution.report : `${JSON.stringify(execution.report, null, 2)}\n`) : options.json ? execution.payload : execution.rendered;
  if (job.jobClass === "task") await outputTrackedResult(output, options.json, job, execution.jobStatus);
  else outputResult(output, options.json);
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
  // claimed/running/completed child record when recording its launch PID.
  updateState(job.workspaceRoot, state => {
    const current = state.jobs.find(candidate => candidate.id === job.id);
    if (current?.status === "queued" && !current.executionClaim) current.pid = child.pid ?? null;
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
  const argumentConfig = {
    rejectUnknown: config.reviewName !== "Adversarial Review",
    rejectOptionTypos: config.reviewName === "Adversarial Review",
    rejectSeparatorValues: true,
    valueOptions: ["base", "scope", "model", "cwd", "session"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: {
      ...COMMAND_ALIASES,
      m: "model"
    }
  };
  const tokens = normalizeArgv(argv, true, argumentConfig);
  const separator = tokens.indexOf("--");
  if ((separator < 0 ? tokens : tokens.slice(0, separator)).some(token => token === "--help" || token === "-h")) {
    printUsage(config.reviewName === "Adversarial Review" ? "adversarial-review" : "review");
    return;
  }
  const { options, positionals } = parseSessionArgs(tokens, argumentConfig);

  const cwd = ensureGitRepository(resolveCommandCwd(options));
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
  Object.assign(job, taskArtifactPaths(workspaceRoot, job.id));
  await runForegroundCommand(
    job,
    async (progress) => {
      const runtime = new JobRuntime(workspaceRoot, job.id, { foreground: true, parentPid: LAUNCH_PARENT_PID, onProgress: progress });
      let execution;
      try {
        runtime.abort.signal.throwIfAborted();
        execution = await executeReviewRun({
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

function deliveryToolUseId(options) {
  const value = options["tool-use-id"];
  if (value !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new Error("--tool-use-id requires a valid tool use id (1-128 identifier characters).");
  }
  return value;
}

function deliveryBinding(job, toolUseId) {
  const sessionId = getCurrentClaudeSessionId();
  if (!toolUseId || !sessionId) return {};
  // Old bindings predate cross-session delivery and belong to the dispatch
  // session. Never relabel them with the current owner after adoption.
  const previous = job.deliveryBindings ?? (job.deliveryToolUseIds ?? [job.dispatchToolUseId])
    .filter(id => typeof id === "string").map(toolUseId => ({ toolUseId, sessionId: job.dispatchSessionId ?? null }));
  return { deliveryBindings: [...previous.filter(binding => binding.toolUseId !== toolUseId || binding.sessionId !== sessionId),
    { toolUseId, sessionId }].slice(-20) };
}

// Internal pre-spawn handshake: no runtime setup or model work, just the same
// session-wide atomic reservation used by task dispatch (including Bash).
function handleReserveName(argv) {
  const { options, positionals } = parseCommandInput(argv, COMMAND_OPTIONS["reserve-name"]);
  const sessionId = getCurrentClaudeSessionId();
  if (!sessionId || !options["session-cwd"] || positionals.length) {
    throw new Error("reserve-name requires a session id and --session-cwd, with no positional arguments.");
  }
  const cwd = resolveCommandWorkspace({ cwd: options["session-cwd"] });
  const name = reserveAgentName([], { cwd, sessionId, preferredName: options.preferred, reserveForSpawn: true });
  process.stdout.write(`${JSON.stringify({ name })}\n`);
}

async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, COMMAND_OPTIONS.task);
  for (const flag of ["name", "agent-name"]) {
    if (/^(task|review|job)-/i.test(options[flag] ?? "")) {
      if (flag === "name") throw new Error("--name cannot start with task-, review- or job-; these prefixes are reserved for job IDs.");
      delete options[flag];
    }
    if (options[flag] !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(options[flag])) {
      throw new Error(`--${flag} requires 1-64 ASCII letters, digits, _, . or -, starting with a letter or digit.`);
    }
  }
  if (options.name !== undefined && options["agent-name"] !== undefined) throw new Error("Choose --name or --agent-name, not both.");
  const agentName = options["agent-name"] ?? options.name;
  const nativeAgentName = options["agent-name"] !== undefined;
  const dispatchToolUseId = deliveryToolUseId(options);
  const dispatchNonce = options["dispatch-nonce"];
  if (dispatchNonce !== undefined && (!options.direct || !getCurrentClaudeSessionId() || !/^[\w.:%-]{1,1024}$/.test(dispatchNonce))) {
    throw new Error("--dispatch-nonce requires --direct, a session id, and a valid nonce (1-1024 identifier characters).");
  }
  validateDirectOptions(argv, DIRECT_OPTION_CONFLICTS.task, options);
  if (DUET_INVOCATION && (positionals.length || options["prompt-file"] !== undefined)) throw new Error("Pass the duet task brief only on stdin.");
  if (options.fork) {
    for (const flag of ["to", "thread", "continue", "resume", "resume-last"]) {
      if (options[flag] !== undefined) throw new Error(`--fork cannot be combined with --${flag}. Use --to for a follow-up after the fork completes.`);
    }
  } else if (options.source !== undefined) {
    throw new Error("task --source requires --fork.");
  }

  if (options.direct) {
    seconds(options["timeout-sec"], WAIT_MAX_SEC, "--timeout-sec", WAIT_MAX_SEC);
  }
  let cwd = resolveCommandCwd(options);
  let explicitJob = false;
  if (options.to !== undefined) {
    for (const flag of ["thread", "continue", "fresh", "resume", "resume-last"]) {
      if (options[flag] !== undefined) throw new Error(`--to cannot be combined with --${flag}.`);
    }
    const selected = resolveWorkerTarget(cwd, options.to.trim());
    explicitJob = selected.job.id === options.to.trim();
    if (selected.job.jobClass !== "task" || !selected.job.threadId) throw new Error(`Worker ${options.to} has no resumable Codex thread.`);
    options.thread = selected.job.threadId;
    cwd = selected.cwd;
  }
  const explicitThread = options.thread !== undefined && options.to === undefined;
  // Resolve legacy resume aliases before selecting settings or permissions.
  // Bind the handle once so a later lookup cannot select a different thread.
  if (options.resume || options["resume-last"]) {
    if (options.thread !== undefined || options.continue !== undefined || options.fresh) throw new Error("Choose --thread, --continue, --fresh, or --resume/--resume-last; these options cannot be combined.");
    const latest = await resolveLatestTrackedTaskThread(resolveWorkspaceRoot(cwd));
    if (!latest) throw new Error("No previous Codex task thread was found for this repository.");
    options.thread = latest.id;
  }
  let inheritance = options.thread ? resolveThreadInheritance(cwd, options.thread.trim(), { allowCrossSessionFallback: explicitThread || explicitJob }) : null;
  const inherited = inheritance?.job;
  if (inherited && options.to === undefined && options.cwd === undefined) cwd = inherited.request?.cwd ?? inherited.workspaceRoot ?? cwd;
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  // Run choice belongs to this dispatch, independently of inherited runtime
  // settings and grants. Reject invalid selections before any worker starts.
  validateTaskRun(cwd, options.run);
  // --continue <job-id>: one more turn on a stopped/finished job's own thread,
  // inheriting that job's recorded authorization and runtime choices so a
  // replacement worker does not have to reconstruct them.
  const continued = options.continue === undefined ? null : readStoredJob(workspaceRoot, String(options.continue).trim());
  if (options.continue !== undefined) {
    if (!continued) throw new Error(`No stored job found for --continue ${options.continue}.`);
    if (continued.jobClass !== "task" || !continued.threadId) throw new Error(`Job ${continued.id} has no resumable Codex thread; nothing to continue.`);
    if (ACTIVE.has(continued.status)) throw new Error(`Job ${continued.id} is still ${continued.status}; wait for it to end (or cancel it) before continuing its thread.`);
    for (const flag of ["thread", "fresh", "resume", "resume-last", "write", "model", "effort", "fast", "normal"]) {
      if (options[flag] !== undefined) throw new Error(`--continue inherits the original job's ${flag} setting; do not pass --${flag}.`);
    }
    if (options["approve-browser-origin"]?.length) throw new Error("--continue inherits the original job's approved browser origins; do not pass --approve-browser-origin.");
    if (options["approve-computer-app"]?.length) throw new Error("--continue inherits the original job's approved Computer Use apps; do not pass --approve-computer-app.");
  }
  const sourceJob = continued ? startedThreadSettings(continued) ? continued
    : resolveThreadInheritance(cwd, continued.threadId, { allowCrossSessionFallback: true }).job : inherited;
  const previousRequest = sourceJob?.request;
  if (continued && options.sandbox !== undefined && startedThreadSettings(continued) && recordedThreadSettings(continued).sandbox) {
    throw new Error("--continue inherits the original job's sandbox setting; do not pass --sandbox.");
  }
  const sourceSession = (sourceJob?.sessionId === undefined ? sourceJob?.ownerId : sourceJob.sessionId) || null;
  const sameSession = sourceSession === (getCurrentClaudeSessionId()?.trim() || null);
  // Handles select thread settings, not another Claude session's permission.
  // Never copy grants added only to the job by runtime answers.
  const grants = requestGrantsInSession(sourceJob);
  const grantRequest = grants ? previousRequest : null;
  if (continued) inheritance = { details: {
    jobId: sourceJob?.id ?? null, scope: sameSession ? "session" : "workspace",
    settingsInherited: Boolean(sourceJob), requestGrantsInherited: grants,
    note: grants ? "Inherited settings and recorded request grants from this session's job; runtime-only grants were excluded."
      : "Inherited settings from the continued job; no request grants recorded in this session were inherited."
  } };
  const recordedSettings = recordedThreadSettings(sourceJob);
  const recordedSandbox = recordedSettings.sandbox;
  if ((continued || options.thread?.trim()) && !SANDBOX_MODES.includes(recordedSandbox) && options.sandbox === undefined) {
    const message = "No recorded sandbox settings are available for this thread; pass --sandbox explicitly before continuing.";
    const report = directReport({ status: "blocked", summary: message, blockers: [{ code: "thread_settings_unknown", message }] });
    if (options.direct) writeDirectLineSync(report);
    else outputResult(report, true);
    process.exitCode = 2;
    return;
  }
  const approvedBrowserOrigins = normalizeBrowserOrigins(options["approve-browser-origin"] ?? grantRequest?.approvedBrowserOrigins ?? []);
  // Per-call Computer Use approval, like --approve-browser-origin: only the
  // listed bundle ids, only for this job's turn.
  const approvedComputerApps = normalizeBundleIds(options["approve-computer-app"] ?? grantRequest?.approvedComputerApps ?? []);
  const lifecycle = { owner: options.owner, leaseSec: seconds(options["lease-sec"] ?? process.env.CODEX_COMPANION_LEASE_SEC, options.direct ? 1800 : 180, "--lease-sec"), questionTimeoutSec: seconds(options["question-timeout-sec"], 900, "--question-timeout-sec") };
  const model = normalizeRequestedModel(options.model) ?? recordedSettings.model ?? "gpt-6-astra";
  const effort = normalizeReasoningEffort(options.effort) ?? recordedSettings.effort ?? "xhigh";
  if (options.fast && options.normal) throw new Error("Choose either --fast or --normal.");
  const serviceTier = options.fast ? "priority" : options.normal || options.fast === false ? null : recordedSettings.serviceTier ?? null;
  const prompt = readTaskPrompt(cwd, options, positionals);

  const resumeLast = false;
  const fresh = Boolean(options.fresh);
  let threadId = continued ? continued.threadId : options.thread?.trim() ?? null;
  if (options.thread !== undefined && (!threadId || threadId.startsWith("--"))) {
    throw new Error("Provide a non-empty thread ID for --thread.");
  }
  if (threadId && fresh) {
    throw new Error("Choose --thread, --fresh, or --resume/--resume-last; these options cannot be combined.");
  }
  const claudeInstructions = prepareClaudeInstructions({
    sessionId: process.env[SESSION_ID_ENV], cwd, sessionCwd: options["session-cwd"],
    previousRequest: previousRequest ?? (threadId ? latestThreadJob(cwd, threadId)?.request : null),
    resuming: Boolean(threadId), disabled: Boolean(options["no-claude-md"])
  });
  // Permission model: the parent adjusts Codex's sandbox per call with --sandbox
  // (like choosing a permission mode for a native subagent); without it the
  // configured default applies, which is danger-full-access unless the user ran
  // `setup --default-sandbox`. --write survives as a floor (at least
  // workspace-write) and --write=false as an explicit read-only request.
  let write = continued ? Boolean(recordedSandbox && recordedSandbox !== "read-only") : Boolean(options.write);
  let sandbox = continued ? options.sandbox ?? recordedSandbox : options.sandbox;
  if (!continued && sandbox === undefined && options.write === undefined) sandbox = recordedSandbox ?? undefined;
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
  let forkRequest = {};
  if (options.fork) {
    if (!prompt.trim()) throw new Error("Provide the task --fork brief on stdin.");
    const { payload, sourceSha256, importId } = await executeTransfer(cwd, { source: options.source });
    threadId = payload.threadId;
    forkRequest = {
      forked: true,
      forkSourceSha256: sourceSha256,
      forkImportId: importId,
      forkLabel: "imported Claude conversation (fidelity not verified)"
    };
  }
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

    const job = buildTaskJob(workspaceRoot, taskMetadata, write, sandbox, approvedBrowserOrigins, lifecycle, approvedComputerApps, true, { cwd, continued, threadId, resumeLast, prompt, model, effort, agentName, nativeAgentName, run: options.run, dispatchNonce, dispatchToolUseId, report: Boolean(options.report || options.detached || options.follow || options.direct) });
    if (job.dispatchReused) {
      await waitForJob(workspaceRoot, job, { owner: job.ownerId, timeoutSec: options["timeout-sec"], direct: true, quiet: options.quiet, toolUseId: dispatchToolUseId });
      return;
    }
    if (options.direct) job.direct = true;
    const request = buildTaskRequest({
      ...claudeInstructions,
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
    if (options.run !== undefined) request.run = options.run;
    if (inheritance?.details) request.settingsInheritance = inheritance.details;
    Object.assign(request, forkRequest);
    const { payload } = enqueueBackgroundTask(cwd, job, request);
    if (options.follow || options.direct) {
      // Native-like single call: submit, then stay attached as the owner until the
      // job ends, needs an answer, or the wait budget runs out.
      await waitForJob(workspaceRoot, job, { owner: job.ownerId, timeoutSec: options["timeout-sec"], feedLimit: options["feed-limit"], json: options.json, direct: options.direct, quiet: options.quiet, toolUseId: dispatchToolUseId });
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

  const job = buildTaskJob(workspaceRoot, taskMetadata, write, sandbox, approvedBrowserOrigins, lifecycle, approvedComputerApps, false, { cwd, continued, threadId, resumeLast, prompt, model, effort, agentName, nativeAgentName, run: options.run, dispatchToolUseId, report: Boolean(options.report) });
  job.request = buildTaskRequest({ ...claudeInstructions, cwd, model, effort, serviceTier, prompt, write, sandbox, approvedBrowserOrigins, approvedComputerApps, resumeLast, threadId, jobId: job.id, report: Boolean(options.report) });
  if (options.run !== undefined) job.request.run = options.run;
  if (inheritance?.details) job.request.settingsInheritance = inheritance.details;
  Object.assign(job.request, forkRequest);
  await runForegroundCommand(
    job,
    (progress) =>
      executeTaskRun({
        ...claudeInstructions,
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
  let storedJob = readStoredJob(workspaceRoot, options["job-id"]);
  if (!storedJob) {
    throw new Error(`No stored job found for ${options["job-id"]}.`);
  }

  // A launcher can lose its PID receipt after spawning us, then start a
  // fallback worker. Only the claimant may enter the runtime. Reclaim only a
  // queued job: a dead worker that already started may still have a live turn.
  let claimed = false;
  storedJob = updateJob(workspaceRoot, storedJob.id, current => {
    if (current.status !== "queued" || (current.executionClaim && processAlive(current.executionClaim.pid))) return null;
    claimed = true;
    return { executionClaim: { pid: process.pid, at: nowIso() }, pid: process.pid };
  });
  if (!claimed) {
    appendLogLine(storedJob.logFile, "Execution already claimed or job no longer queued; duplicate worker exiting.");
    return;
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
  if (request?.forked) {
    for (const key of ["forked", "forkSourceSha256", "forkImportId", "forkLabel", "threadId"]) report[key] = request[key];
  }
  return report;
}

function processAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== "ESRCH"; }
}

function restoreMissingTaskRecord(workspaceRoot, job) {
  const stored = readStoredJob(workspaceRoot, job.id);
  if (stored || job.jobClass !== "task" || !ACTIVE.has(job.status)) return stored ?? job;
  return updateJob(workspaceRoot, job.id, latest => {
    // Recheck under the same lock as the launcher's private-record write.
    if (fs.existsSync(resolveJobFile(workspaceRoot, job.id))) return null;
    if (latest.status === "queued" && !latest.pid && !latest.turnId && !latest.startedAt) {
      // A live launcher keeps its reservation even across a long machine sleep;
      // legacy reservations without launcherPid fall back to the launch grace.
      const age = Date.now() - Date.parse(latest.createdAt);
      const launcherKnown = Number.isInteger(latest.launcherPid) && latest.launcherPid > 0;
      if (launcherKnown ? processAlive(latest.launcherPid) : !(age >= 60000)) return null;
      const errorMessage = "Launch was abandoned before its record was written; no turn was submitted.";
      const completedAt = nowIso();
      return { status: "failed", phase: "failed", pid: null, completedAt, errorMessage, summary: errorMessage,
        recovered: true, recoveredAt: completedAt, turnResolution: "notStarted",
        recovery: { status: "recovered", source: "launcher-liveness", threadId: latest.threadId ?? null, turnId: null,
          turnStatus: "notStarted", detail: errorMessage },
        result: { status: 1, threadId: latest.threadId ?? null, turnId: null, turnStatus: "notStarted", turnEnded: true, error: errorMessage } };
    }
    // A started task may still have a server turn. Restore enough state for
    // exact-turn recovery/cancellation, without declaring that turn finished.
    if (ACTIVE.has(latest.status) && latest.pid && !processAlive(latest.pid)) {
      return { status: "failed", phase: "failed", pid: null, completedAt: nowIso(), privateRecordRestored: true,
        errorMessage: "Worker exited before its turn outcome was recorded." };
    }
    return null;
  });
}

function recordTurnResolution(workspaceRoot, stored, outcome, recovery) {
  updateJob(workspaceRoot, stored.id, latest => unresolvedTask(latest) && latest.threadId === stored.threadId && latest.turnId === stored.turnId
    ? { turnResolution: outcome, recovery } : null);
  return { outcome, recovery };
}

export async function reconcileLostTurn(workspaceRoot, job, { turnResult = null, interruptRequested = false, admittingJobId = null } = {}) {
  let stored = restoreMissingTaskRecord(workspaceRoot, job);
  if (!unresolvedTask(stored)) {
    return { outcome: stored?.recovered ? stored.recovery?.turnStatus ?? stored.status : "unknown", result: stored?.result };
  }
  // A queued launch without a PID is not evidence of a dead worker. Legacy
  // terminal records without turn handles must also retain their outcome.
  const deadBeforeTurn = !stored.turnId && (stored.status === "failed" || (ACTIVE.has(stored.status) && stored.pid));
  if (!stored.turnId && !deadBeforeTurn) {
    return { outcome: "unknown", recovery: { status: "unknown", detail: "No exact thread/turn handle was recorded. Inspect the job log; do not automatically rerun the task." } };
  }
  try {
    releaseStaleTaskComputerGrants(stored.threadId);
    // The wrapper is dead even when its server turn cannot yet be read. Keep
    // the turn unresolved, but never advertise the dead PID as a running job.
    if (ACTIVE.has(stored.status) && stored.pid && !processAlive(stored.pid)) {
      stored = updateJob(workspaceRoot, stored.id, latest => unresolvedTask(latest) && ACTIVE.has(latest.status) && !processAlive(latest.pid)
        ? { status: "failed", phase: "failed", pid: null, completedAt: nowIso(), errorMessage: "Worker exited before its turn outcome was recorded." } : null);
    }
    let result = turnResult ?? (stored.threadId ? await readAppServerTurn(workspaceRoot, stored, { admittingJobId, privateWhenBusy: Boolean(admittingJobId) }) : { turnStatus: "notStarted" });
    if (!result) return recordTurnResolution(workspaceRoot, stored, "unknown", { status: "unknown", detail: "The recorded turn is not readable. It may not have been persisted; do not automatically rerun it." });
    const ambiguous = { turnResolution: "unknown", recovery: { status: "unknown", detail: "The thread's recorded ownership is incomplete or ambiguous; no turn was attributed to this job." } };
    const attributionConfirmed = latest => {
      if (!latest.threadId || latest.turnId) return true;
      const inventory = recordedThreadJobs(latest.threadId);
      return result.turnId ? uniqueTurnAttribution(latest, { id: result.turnId, startedAt: result.turnStartedAt }, inventory, admittingJobId) : inventory.complete;
    };
    if (!stored.turnId) {
      if (result.turnStatus === "inProgress") {
        const recovery = { status: "running", source: "thread/read", threadId: stored.threadId, turnId: result.turnId, turnStatus: "inProgress",
          detail: "The worker exited before recording its turn handle; found an unclaimed in-progress turn." };
        const current = updateJob(workspaceRoot, stored.id, latest => {
          if (!unresolvedTask(latest) || latest.threadId !== stored.threadId || latest.turnId) return null;
          // Revalidate all owners and competing start windows before attaching
          // a handle. A dead wrapper still owns its recorded server turn.
          return attributionConfirmed(latest) ? { turnId: result.turnId, turnResolution: "in_progress", recovery } : ambiguous;
        });
        return { outcome: current.turnResolution ?? "unknown", recovery: current.recovery };
      }
      if (result.turnStatus === "notStarted") {
        result = { status: 1, threadId: stored.threadId, turnId: null, turnStatus: "notStarted", turnEnded: true,
          finalMessage: "", touchedFiles: [], error: { message: "worker exited before starting its turn" } };
      }
    }
    if (result.turnStatus === "inProgress") return recordTurnResolution(workspaceRoot, stored, "in_progress", { status: "running", detail: "The wrapper stopped; the recorded Codex turn is still in progress." });
    if (!["completed", "failed", "interrupted", "notStarted"].includes(result.turnStatus)) return recordTurnResolution(workspaceRoot, stored, "unknown", { status: "unknown", detail: `Unrecognized turn status: ${result.turnStatus}` });
    // A later recovery cannot compare against the current tree: subsequent
    // turns may have edited it. Keep exact-turn events and mark coverage partial.
    Object.assign(result, {
      preExistingChanges: stored.preExistingChanges ?? [],
      fileTracking: { status: "partial", basis: result.turnStatus === "notStarted" ? "The worker exited without starting a turn; no end-of-turn workspace snapshot survived." : "Recovered exact-turn file-change events only; no end-of-turn workspace snapshot survived." },
      sandbox: stored.sandbox ?? "unknown", approvalPolicy: stored.approvalPolicy ?? "unknown",
      approvedBrowserOrigins: stored.approvedBrowserOrigins ?? [], approvedComputerApps: stored.approvedComputerApps ?? []
    });
    let recovered = false;
    const current = updateJob(workspaceRoot, stored.id, latest => {
      // A concurrent status/result/wait may already have resolved this record.
      // Do not overwrite its outcome, timestamps, artifacts or a changed handle.
      if (!unresolvedTask(latest) || latest.threadId !== stored.threadId || latest.turnId !== stored.turnId) return null;
      if (!attributionConfirmed(latest)) return ambiguous;
      const provenance = { recovered: true, recoveredAt: nowIso(), completedAt: result.turnStatus === "notStarted" ? nowIso() : result.turnEndedAt ?? latest.completedAt ?? null,
        recovery: { status: "recovered", source: stored.threadId ? "thread/read" : "worker-liveness", threadId: stored.threadId ?? null, turnId: result.turnId ?? stored.turnId, turnStatus: result.turnStatus,
          originalError: latest.errorMessage ?? latest.result?.error ?? null, wrapperEndedAt: latest.completedAt ?? null, turnEndedAt: result.turnEndedAt ?? null,
          ...(interruptRequested ? { interruptRequested: true } : {}),
          detail: result.turnStatus === "notStarted"
            ? !stored.threadId ? "The worker exited before recording a thread handle; no turn was submitted."
              : "Read the thread with turns; no unclaimed turn started during this job."
            : "Fetched the exact persisted turn without rerunning it." } };
      const stopReason = interruptRequested ? "cancelled_by_user"
          : latest.cancelRequested ? latest.cancelRequested.reason || "cancelled_by_user"
          : latest.result?.interruptionReason || latest.report?.interruptionReason || latest.interruptionReason
            || (latest.ownerDetachReason != null && latest.ownerDetachReason !== "returned" ? "owner_stopped" : null);
      if (latest.status === "completed" && latest.result?.inferredCompletion === true) {
        // Resolving the leftover turn must not replace the already captured
        // answer with missing or partial items from persisted server history.
        // Stops persist their intent before interrupting (cancel, runtime stop),
        // and an owner stop leaves a non-returned detach. Without either, the
        // worker reconciling its own leftover turn (owner still attached) or a
        // returned owner means the broker ended the turn after the answer.
        const ownerStopped = latest.ownerDetachReason != null && latest.ownerDetachReason !== "returned";
        const completedAfterAnswer = result.turnStatus === "interrupted"
          && typeof latest.result.rawOutput === "string" && latest.result.rawOutput.trim()
          && !stopReason && !ownerStopped;
        const status = result.turnStatus === "failed" ? "failed"
          : stopReason ? stopReason === "cancelled_by_user" ? "cancelled" : "interrupted"
          : result.turnStatus === "completed" || completedAfterAnswer ? latest.status : result.turnStatus;
        const exitStatus = status === "completed" ? 0 : result.status || 1;
        if (completedAfterAnswer) provenance.recovery.detail = "The leftover turn was interrupted after the final answer was captured; no stop was requested.";
        if (stopReason) provenance.recovery.interruptRequested = true;
        const interruption = stopReason
          ? { interruptionReason: stopReason, interruptionConfirmed: true } : {};
        const payload = { ...latest.result, ...provenance, ...interruption, status: exitStatus,
          workerStatus: status, turnStatus: result.turnStatus, turnEnded: true,
          ...(result.error?.message ? { error: result.error.message } : {}) };
        const report = { ...(latest.report ?? buildWorkerReport(latest.result, { jobId: stored.id,
          rawOutputFile: latest.rawOutputFile, resultFile: latest.resultFile })), ...provenance, ...interruption,
          status, exitCode: exitStatus };
        persistTaskArtifacts(workspaceRoot, stored.id, payload);
        recovered = true;
        return { ...provenance, ...interruption, status, phase: status === "completed" ? "done" : status,
          turnResolution: result.turnStatus, pid: null, errorMessage: result.error?.message ?? null, result: payload, report };
      }
      if (["interrupted", "cancelled"].includes(latest.status) && latest.result) {
        // The owner's stopped outcome remains authoritative. A later server
        // result only establishes that this exact turn no longer blocks reuse.
        provenance.completedAt = latest.completedAt ?? null;
        const payload = { ...latest.result, ...provenance, turnEnded: true, interruptionConfirmed: true };
        const report = { ...(latest.report ?? buildWorkerReport(latest.result, { jobId: stored.id,
          rawOutputFile: latest.rawOutputFile, resultFile: latest.resultFile })), ...provenance,
          status: latest.status, interruptionConfirmed: true };
        persistTaskArtifacts(workspaceRoot, stored.id, payload);
        recovered = true;
        return { ...provenance, turnResolution: result.turnStatus, interruptionConfirmed: true, pid: null, result: payload, report };
      }
      Object.assign(result, provenance);
      if (result.turnStatus === "interrupted") {
        // For a failed job with a result, unresolvedTask above established a
        // transport loss (including legacy diagnostics). A dead wrapper alone
        // is insufficient evidence. Recorded Duet stops always take precedence.
        const reason = stopReason ?? (latest.status === "failed" && latest.result ? "codex_runtime_restarted" : null);
        if (reason) Object.assign(result, { interruptionReason: reason, interruptionConfirmed: true });
        if (stopReason) provenance.recovery.interruptRequested = true;
      }
      const execution = buildTaskExecution(result, { ...latest.request, cwd: workspaceRoot, jobId: stored.id, write: latest.write,
        report: latest.request?.report ?? Boolean(parseStructuredReport(result.finalMessage)) });
      recovered = true;
      return { ...provenance, turnId: result.turnId ?? stored.turnId, turnResolution: result.turnStatus, status: execution.jobStatus, phase: execution.jobStatus === "completed" ? "done" : execution.jobStatus,
        pid: null, errorMessage: result.error?.message ?? null, summary: execution.summary,
        rawOutputFile: execution.payload.rawOutputFile, resultFile: execution.payload.resultFile,
        result: execution.payload, report: execution.report, rendered: execution.rendered };
    });
    recordFinishedJob(current);
    if (recovered) appendLogLine(current.logFile, stored.turnId ? `Recovered recorded turn ${stored.turnId}; status ${current.status}. No new turn submitted.` : "Resolved dead worker before turn start from thread/read. No new turn submitted.");
    return { outcome: current.recovered ? current.recovery?.turnStatus ?? current.status : "unknown", result: current.result, recovery: current.recovery };
  } catch (error) {
    return recordTurnResolution(workspaceRoot, stored, "unknown", { status: "unreachable", detail: error.message });
  }
}

async function refreshJobSnapshot(cwd, reference) {
  const snapshot = buildSingleJobSnapshot(cwd, reference);
  const { workspaceRoot, job } = snapshot;
  const stored = restoreMissingTaskRecord(workspaceRoot, job);
  if (stored) recordFinishedJob(stored);
  if (!unresolvedTask(stored)) return buildSingleJobSnapshot(cwd, job.id);
  const { recovery } = await reconcileLostTurn(workspaceRoot, job);
  // A concurrent reader may have recovered while this read was unavailable.
  // Prefer its committed terminal result over our transient recovery notice.
  const latest = readStoredJob(workspaceRoot, job.id);
  let notice = latest?.recovered ? latest.recovery : recovery;
  if (notice && unresolvedTask(latest ?? stored)) {
    const { recoveryCommand, cancelCommand } = threadBusyBlocker(workspaceRoot, latest ?? stored);
    notice = { ...notice, recoveryCommand, cancelCommand };
  }
  return { ...buildSingleJobSnapshot(cwd, job.id), ...(notice ? { recovery: notice } : {}) };
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, COMMAND_OPTIONS.status);

  let cwd = resolveCommandCwd(options);
  let reference = options.thread ?? positionals[0] ?? "";
  if (!reference) {
    const workspace = resolveWorkspaceRoot(cwd);
    for (const job of listJobs(workspace)) restoreMissingTaskRecord(workspace, job);
  }
  if (options["dispatch-nonce"] !== undefined) {
    const nonce = options["dispatch-nonce"].trim();
    if (!nonce || !options.all || !options.json || reference || options.wait || options.owner) throw new Error("--dispatch-nonce requires status --all --json with a non-empty nonce and no job selector.");
    const workspace = resolveWorkspaceRoot(cwd), session = getCurrentClaudeSessionId()?.trim() || null;
    const label = session || "unknown";
    const jobs = sortJobsNewestFirst(listJobs(workspace).filter(job => job.dispatchNonce === nonce &&
      ((job.sessionId === undefined ? job.ownerId : job.sessionId) || null) === session))
      .map(job => ({ ...buildSingleJobSnapshot(workspace, job.id).job, sessionLabel: label.length > 13 ? `${label.slice(0, 8)}…${label.slice(-4)}` : label }));
    const report = buildStatusSnapshot(cwd, { all: true });
    report.running = jobs.filter(job => ACTIVE.has(job.status));
    const ended = jobs.filter(job => !ACTIVE.has(job.status));
    report.latestFinished = ended[0] ?? null;
    report.recent = ended.slice(1);
    report.historyOmitted = 0;
    outputResult(report, true);
    return;
  }
  if (reference) ({ cwd, reference } = resolveWorkerTarget(cwd, reference, { legacyReferences: true }));
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
  const rendered = renderStatusPayload(report, options.json, { all: options.all });
  outputResult(options.json || !report.historyOmitted ? rendered
    : `${rendered}\nOlder finished jobs omitted in this scope: ${report.historyOmitted}\n`, options.json);
}

async function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, COMMAND_OPTIONS.result);

  let cwd = resolveCommandCwd(options);
  let reference = options.thread ?? positionals[0] ?? "";
  if (reference) ({ cwd, reference } = resolveWorkerTarget(cwd, reference, { legacyReferences: true }));
  if (reference) {
    const snapshot = await refreshJobSnapshot(cwd, reference);
    if (snapshot.recovery && snapshot.recovery.status !== "recovered") {
      const pending = { status: snapshot.job.privateRecordRestored && snapshot.recovery.status === "running" ? "unknown" : snapshot.recovery.status, jobId: snapshot.job.id, ...(snapshot.job.agentName ? { agentName: snapshot.job.agentName } : {}), threadId: snapshot.job.threadId, turnId: snapshot.job.turnId, logFile: snapshot.job.logFile, rawOutputFile: snapshot.job.rawOutputFile, resultFile: snapshot.job.resultFile, approvedBrowserOrigins: snapshot.job.approvedBrowserOrigins ?? [], approvedComputerApps: snapshot.job.approvedComputerApps ?? [], error: snapshot.job.errorMessage ?? null, recovery: snapshot.recovery,
        blockers: [threadBusyBlocker(snapshot.workspaceRoot, readStoredJob(snapshot.workspaceRoot, snapshot.job.id) ?? snapshot.job)] };
      if (options.json && !options.report && !options.details) outputCommandResult(pending, `${snapshot.recovery.detail}\n`, true);
      else outputResult(options.details ? fullReport(pending, snapshot.job) : directReport({ ...pending, summary: snapshot.recovery.detail }, snapshot.job), true);
      process.exitCode = pending.status === "running" ? 0 : 2;
      return;
    }
    if (ACTIVE.has(snapshot.job.status) && (options.details || options.report || !options.json)) {
      const current = readStoredJob(snapshot.workspaceRoot, snapshot.job.id) ?? snapshot.job;
      const report = progressSnapshot(current);
      outputResult(options.details ? fullReport(report, current) : directReport(report, current), true);
      return;
    }
  }
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  if (options.report || options.details || !options.json) {
    const current = storedJob ?? job;
    const report = { ...(storedJob?.report ?? buildWorkerReport({ threadId: current.threadId ?? null, approvedBrowserOrigins: storedJob?.approvedBrowserOrigins ?? [], approvedComputerApps: storedJob?.approvedComputerApps ?? [],
      ...(storedJob?.result?.codex ? { status: current.status === "completed" ? 0 : 1, rawOutput: storedJob.result.codex.stdout } : {}),
      ...(storedJob?.result ?? { status: 1, error: storedJob?.errorMessage ?? "No stored result." }) }, { jobId: job.id, rawOutputFile: job.rawOutputFile, resultFile: job.resultFile })) };
    if (current.jobClass === "review") {
      report.status = current.status;
      // Review prose is not a worker status declaration or an input request.
      if (current.status === "completed") {
        report.blockers = [];
        delete report.question;
      }
      if (current.result?.errorCode === "review_output_invalid") {
        report.blockers = [{ code: "review_output_invalid", message: current.result.validationError }];
      }
    }
    Object.assign(withRunSettings(report, storedJob?.request), leaseExpiryReport(storedJob ?? job),
      storedJob?.agentName ? { agentName: storedJob.agentName } : {});
    const output = options.details
      ? current.jobClass === "review" ? renderReviewDetails(fullReport(report, current), current) : fullReport(report, current)
      : directReport(report, current);
    await outputTrackedResult(output, true, current, output.status);
    process.exitCode = exitCodeForReport(output.status);
    return;
  }
  const payload = {
    job: withoutPrivateActivity(job),
    storedJob: withoutPrivateActivity(storedJob)
  };

  await outputTrackedResult(options.json ? payload : renderStoredJobResult(job, storedJob), options.json, storedJob ?? job);
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
  const { options, positionals } = parseCommandInput(argv, COMMAND_OPTIONS.cancel);
  let cwd = resolveCommandCwd(options), reference = positionals[0] ?? "";
  let namedWorker = false;
  if (reference) {
    const target = resolveWorkerTarget(cwd, reference, { command: "cancel", nameState: "cancel", legacyReferences: true });
    namedWorker = target.job.agentName?.toLowerCase() === reference.toLowerCase();
    ({ cwd, reference } = target);
  }
  if (reference) {
    const snapshot = buildSingleJobSnapshot(cwd, reference);
    const restored = restoreMissingTaskRecord(snapshot.workspaceRoot, snapshot.job);
    // A protected reservation must stay index-only until its launcher writes
    // the request. Other live legacy jobs keep the usual cancelRequested path.
    let stored = readStoredJob(snapshot.workspaceRoot, snapshot.job.id)
      ?? (restored.status === "queued" && !restored.pid && !restored.turnId ? restored : null);
    // A rejected follow-up is now the newest job with this worker name, but
    // has no turn of its own. Explicit job IDs still target only that job.
    if (namedWorker && stored?.status === "blocked" && stored.threadId) {
      const predecessorId = stored.result?.blockers?.find(blocker => blocker.code === "thread_busy")?.predecessorJobId;
      const predecessor = predecessorId && readStoredJob(snapshot.workspaceRoot, predecessorId);
      if (predecessor?.threadId === stored.threadId && unresolvedTask(predecessor)) stored = predecessor;
    }
    // Save intent before handle discovery or an interrupt can race recovery.
    // Keep a protected launch reservation index-only until its launcher writes.
    if (unresolvedTask(stored)) {
      if (readStoredJob(snapshot.workspaceRoot, stored.id)) stored = requestCancel(snapshot.workspaceRoot, stored.id);
      else {
        const cancelRequested = { reason: "cancelled_by_user", at: nowIso() };
        updateState(snapshot.workspaceRoot, state => {
          const current = state.jobs.find(job => job.id === stored.id);
          if (current) current.cancelRequested = cancelRequested;
        });
        stored = { ...stored, cancelRequested };
      }
    }
    if (stored && !stored.turnId) {
      if (unresolvedTask(stored)) {
        await reconcileLostTurn(snapshot.workspaceRoot, stored);
        stored = readStoredJob(snapshot.workspaceRoot, stored.id) ?? stored;
      }
      if (stored.recovered && stored.recovery?.turnStatus === "notStarted") {
        const inventory = stored.threadId ? recordedThreadJobs(stored.threadId) : { jobs: [], complete: true };
        const otherOwner = inventory.jobs.find(candidate => candidate.id !== stored.id &&
          (processAlive(candidate.pid) || (candidate.turnId && (ACTIVE.has(candidate.status) || unresolvedTask(candidate)))));
        const backgroundTerminals = stored.threadId && inventory.complete && !otherOwner
          ? await cleanAppServerBackgroundTerminals(snapshot.workspaceRoot, stored.threadId)
          : { cleaned: !stored.threadId, detail: stored.threadId ? "Cleanup deferred: another job may own this thread's terminals." : null };
        updateJob(snapshot.workspaceRoot, stored.id, () => ({ backgroundTerminals }));
        const payload = { jobId: stored.id, ...(stored.agentName ? { agentName: stored.agentName } : {}), status: "cancelled", confirmation: "confirmed",
          turnInterruptAttempted: false, turnInterrupted: false, reason: "cancelled_by_user", backgroundTerminals, detail: "The worker exited before starting its turn; no interrupt was needed." };
        outputCommandResult(payload, `${JSON.stringify(payload, null, 2)}\n`, options.json);
        return;
      }
    }
    if (unresolvedTask(stored) && !stored.turnId) {
      const payload = { jobId: stored.id, ...(stored.agentName ? { agentName: stored.agentName } : {}), status: "interrupt_unconfirmed", confirmation: "unconfirmed",
        turnInterruptAttempted: false, turnInterrupted: false, reason: "cancelled_by_user",
        detail: stored.recovery?.detail ?? "No unique turn handle could be discovered; cancellation is unconfirmed." };
      outputCommandResult(payload, `${JSON.stringify(payload, null, 2)}\n`, options.json);
      process.exitCode = 2;
      return;
    }
    if (unresolvedTask(stored) && stored.threadId && stored.turnId) {
      const interruption = await interruptAppServerTurn(snapshot.workspaceRoot, stored);
      updateJob(snapshot.workspaceRoot, stored.id, () => ({ backgroundTerminals: interruption.backgroundTerminals }));
      if (interruption.result?.turnEnded) {
        await reconcileLostTurn(snapshot.workspaceRoot, stored, { turnResult: interruption.result, interruptRequested: true });
      } else {
        recordTurnResolution(snapshot.workspaceRoot, stored, interruption.result?.turnStatus === "inProgress" ? "in_progress" : "unknown",
          { status: interruption.result ? "running" : "unreachable", detail: interruption.detail });
      }
      const latest = readStoredJob(snapshot.workspaceRoot, stored.id);
      const confirmed = latest.recovered === true && latest.result?.turnEnded === true;
      const payload = { jobId: stored.id, ...(stored.agentName ? { agentName: stored.agentName } : {}),
        status: confirmed ? "cancelled" : "interrupt_unconfirmed", confirmation: confirmed ? "confirmed" : "unconfirmed",
        turnInterruptAttempted: interruption.attempted, turnInterrupted: confirmed, reason: "cancelled_by_user",
        backgroundTerminals: interruption.backgroundTerminals,
        detail: confirmed ? `Recorded turn resolved as ${latest.recovery.turnStatus}.` : `Could not confirm cancellation; the turn remains unresolved. ${interruption.detail}` };
      appendLogLine(stored.logFile, payload.detail);
      outputCommandResult(payload, `${JSON.stringify(payload, null, 2)}\n`, options.json);
      if (!confirmed) process.exitCode = 2;
      return;
    }
  }
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference, { env: process.env });
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
  current = updateJob(workspaceRoot, job.id, latest => latest.backgroundTerminals ? null
    : { backgroundTerminals: { cleaned: false, detail: "Background terminal cleanup has not been confirmed." } });
  const payload = { jobId: job.id, ...(job.agentName ? { agentName: job.agentName } : {}), status: confirmed ? "cancelled" : "interrupt_unconfirmed", confirmation: confirmed ? "confirmed" : "unconfirmed",
    turnInterruptAttempted: true, turnInterrupted: confirmed, reason: "cancelled_by_user", backgroundTerminals: current.backgroundTerminals };
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
  if (result.adopted) writeSessionMarker(readStoredJob(workspaceRoot, job.id));
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

// At most 200 progress lines, including the write in flight. Only one stdout
// callback is outstanding, so Node's writable buffer cannot grow with the job.
// Once an overflow starts, count new lines until the backlog drains, then emit
// one notice before accepting the next episode. Stored activity is unaffected.
function directProgressQueue(writeLine, onError) {
  const lines = [];
  let draining = null, inFlight = false, omitted = 0, stopped = false, failure = null;
  const drain = async () => {
    try {
      while (!stopped && (lines.length || omitted)) {
        let line = lines.shift();
        if (line === undefined) { line = `… ${omitted} progress lines omitted`; omitted = 0; }
        inFlight = true;
        await writeLine(line);
        inFlight = false;
      }
    } catch (error) {
      failure = error;
      stopped = true; lines.length = 0; omitted = 0;
      onError(error);
    } finally { inFlight = false; draining = null; }
  };
  return {
    push(line) {
      if (stopped) return;
      if (omitted || lines.length + Number(inFlight) >= 200) omitted += 1;
      else lines.push(line);
      draining ??= drain();
    },
    async flush() { await draining; if (failure) throw failure; },
    stop() { stopped = true; lines.length = 0; omitted = 0; }
  };
}

// Claim and (optionally) answer under the same state lock. A separate check then
// markOwnerAttachment would let two CLI processes both become the owner wait.
function attachOwnerWait(workspaceRoot, id, owner, token, answer, toolUseId) {
  if (answer && (typeof answer.text !== "string" || !answer.text.trim() || answer.text.length > 8000)) throw new Error("Answer stdin must contain 1–8000 characters.");
  const result = updateJob(workspaceRoot, id, current => {
    const now = Date.now();
    if (answer) {
      if (!owner || current.ownerId !== owner) throw new Error("Answer requires the current --owner; no answer was sent.");
      const pending = current.pendingQuestion;
      if (!ACTIVE.has(current.status) || !pending || pending.id !== answer.questionId || pending.expiresAt <= now || pending.answer !== undefined) throw new Error("Question is no longer pending; no answer was sent.");
      if (current.cancelRequested || (current.leaseExpiresAt && current.leaseExpiresAt <= now)) throw new Error("Owner lease expired or job is stopping; no answer was sent.");
    }
    if (!owner || current.ownerId !== owner) return null;
    // An owner wait can reach an already-finished job. Bind its report without
    // changing the finished job's attachment/lease state.
    if (!ACTIVE.has(current.status)) return toolUseId ? deliveryBinding(current, toolUseId) : null;
    if (current.leaseExpiresAt && current.leaseExpiresAt <= now) return null;
    // SIGKILL leaves ownerAttached set. Reclaim a dead wait immediately, inside
    // the worker's existing grace window; reject only a live, recent attachment.
    // Older records have no PID: conservatively protect them while fresh.
    const hasPid = Number.isSafeInteger(current.ownerWaitPid) && current.ownerWaitPid > 0;
    const live = current.ownerAttached && now - (current.leaseRenewedAt ?? 0) < OWNER_GRACE_MS &&
      (!hasPid || processAlive(current.ownerWaitPid));
    if (live) throw new Error("An owner wait is already attached; no new wait was attached or answer sent.");
    return { ...deliveryBinding(current, toolUseId), ownerAttached: true, ownerAttachedAt: now, ownerDetachedAt: null, ownerDetachReason: null,
      ownerWaitPid: process.pid, ownerWaitToken: token,
      leaseRenewedAt: now, leaseExpiresAt: now + (current.leaseSec ?? 180) * 1000,
      ...(answer ? { pendingQuestion: { ...current.pendingQuestion, answer: answer.text.trim() } } : {}) };
  });
  recordFinishedJob(result);
  return result;
}

// Fence renewals and detaches with the attachment identity, not just the owner:
// a stale but still-alive wait must not renew or detach its replacement.
function updateOwnerWait(workspaceRoot, id, owner, token, reason = null) {
  const result = updateJob(workspaceRoot, id, current => {
    if (!owner || current.ownerId !== owner || current.ownerWaitToken !== token || current.ownerWaitPid !== process.pid) return null;
    const now = Date.now();
    if (reason !== null) return current.ownerAttached || ACTIVE.has(current.status)
      ? { ownerAttached: false, ownerDetachedAt: now, ownerDetachReason: reason } : null;
    return current.ownerAttached && ACTIVE.has(current.status) && !current.cancelRequested && (!current.leaseExpiresAt || current.leaseExpiresAt > now)
      ? { leaseRenewedAt: now, leaseExpiresAt: now + (current.leaseSec ?? 180) * 1000 } : null;
  });
  if (reason !== null) recordFinishedJob(result);
  return result;
}

async function waitForJob(workspaceRoot, job, { owner, timeoutSec, minIntervalSec, afterQuestion, feedLimit, json, direct, quiet, answer, details, toolUseId }) {
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
  if (details) json = true;
  const reader = activityReader(owner), started = Date.now(), activity = [];
  let cursor = readStoredJob(workspaceRoot, job.id).activityCursors?.[reader] ?? 0;
  let renewalTimer = null, renewalError = null, outputError = null, detachReason = null;
  let finalWrite = null, stopping = false;
  const stopRenewal = () => { clearTimeout(renewalTimer); renewalTimer = null; };
  const waitToken = owner ? randomUUID() : null;
  let attached = false;
  const startPpid = process.ppid;
  // An owner that leaves abnormally cannot tell the worker; mark the detach so the
  // worker interrupts after the grace period unless a replacement wait re-attaches.
  const detach = reason => { stopRenewal(); if (attached && !detachReason) { detachReason = reason; try { updateOwnerWait(workspaceRoot, job.id, owner, waitToken, reason); } catch { /* best effort */ } } };
  const reportOwnerStopped = () => {
    if (!direct) return;
    let current = job;
    try { current = readStoredJob(workspaceRoot, job.id) ?? job; } catch { /* retain known handles */ }
    const stopped = { status: "owner_stopped", jobId: current.id, ...(current.agentName ? { agentName: current.agentName } : {}), ownerId: current.ownerId ?? null,
      threadId: current.threadId ?? null, turnId: current.turnId ?? null, interruptionReason: "owner_stopped",
      ...(current.threadId ? { continuationCommand: continuationReport({ ...current, direct: true }).continuationCommand } : {}) };
    // Native dispatches persist their nonce before startup. The host discards
    // an aborted process stream; the adapter marks the stop it actually returns.
    if (writeDirectLineSync(details ? fullReport(stopped, current) : directReport(stopped, current)) && !current.dispatchNonce) {
      markReportEmitted(current, stopped.status);
    }
  };
  const stopOwner = async reason => {
    if (stopping) return;
    stopping = true;
    detach(reason); progress?.stop();
    if (finalWrite) {
      // JSON already in the pipe cannot be replaced by owner_stopped. Give
      // its pending stream write the same bounded opportunity to finish.
      let timeout;
      await Promise.race([finalWrite.catch(() => {}), new Promise(resolve => { timeout = setTimeout(resolve, 2000); })]);
      clearTimeout(timeout);
    } else reportOwnerStopped();
    process.exit(130);
  };
  const signalHandlers = new Map();
  if (owner) {
    // Install the handlers before publishing the attachment: a stop that
    // follows the visible attach must always record its signal detach.
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      const handler = () => { void stopOwner("signal"); };
      signalHandlers.set(signal, handler); process.on(signal, handler);
    }
    attached = attachOwnerWait(workspaceRoot, job.id, owner, waitToken, answer, toolUseId).ownerWaitToken === waitToken;
  }
  // Feed and final writes retain their delivery callbacks. Direct progress is
  // drained separately so neither polling nor owner renewal waits for stdout.
  const writeLine = line => new Promise((resolve, reject) => process.stdout.write(`${line}\n`, error => error ? reject(error) : resolve()));
  const progress = direct && !quiet ? directProgressQueue(writeLine, error => {
    outputError = error;
    if (error.code === "EPIPE") { detach("stdout_closed"); process.exitCode = 130; }
  }) : null;
  const finish = async (payload, exitCode = 0, current = job) => {
    const output = details ? fullReport(payload, current) : direct ? directReport(payload, current) : payload;
    if (output.status !== payload.status) exitCode = exitCodeForReport(output.status);
    const line = JSON.stringify(output);
    try {
      await progress?.flush();
      if (direct) directOutputStarted = true;
      finalWrite = writeLine(line).then(() => markReportEmitted(current, output.status));
      await finalWrite;
    }
    catch (error) {
      if (error.code !== "EPIPE") throw error;
      detach("stdout_closed"); process.exitCode = 130; return;
    }
    detach("returned");
    if (exitCode) process.exitCode = exitCode;
  };
  let activityEvicted = 0;
  const reported = () => {
    const activityOmitted = Math.max(0, activity.length - REPORTED_ACTIVITY_LIMIT) + activityEvicted;
    return { activity: activity.slice(-REPORTED_ACTIVITY_LIMIT), activityCount: activity.length + activityEvicted,
      ...(activityOmitted ? { activityOmitted } : {}), ...(activityEvicted ? { activityEvicted } : {}) };
  };
  try {
    // Keep the same immediate renewal and <= 1 s cadence, independent of output.
    // Check the parent here too: a blocked final/feed write must never keep an
    // orphaned owner's lease alive. Signals and every detach clear this timer.
    const renew = () => {
      if (detachReason) return;
      if (process.ppid !== startPpid) { void stopOwner("parent_exit"); return; }
      try {
        const current = updateOwnerWait(workspaceRoot, job.id, owner, waitToken);
        if (current.ownerId !== owner || current.ownerWaitToken !== waitToken || current.ownerWaitPid !== process.pid) { stopRenewal(); return; }
        renewalTimer = setTimeout(renew, Math.min(1000, (current.leaseSec ?? 180) * 250));
      } catch (error) { renewalError = error; stopRenewal(); }
    };
    if (owner) renew();
    for (;;) {
      if (renewalError) throw renewalError;
      if (outputError) { if (outputError.code !== "EPIPE") throw outputError; return; }
      if (owner && process.ppid !== startPpid) { await stopOwner("parent_exit"); return; }
      let current = readStoredJob(workspaceRoot, job.id);
      const moved = ownershipNotice(current, owner);
      if (moved) { detachReason = "moved"; stopRenewal(); await finish({ ...moved, ...reported(), cursor }, 2); return; }
      if (attached && current.ownerWaitToken !== waitToken) { stopRenewal(); throw new Error("This owner wait was replaced; the replacement is responsible for waiting."); }
      if (unresolvedTask(current)) {
        await reconcileLostTurn(workspaceRoot, current);
        current = readStoredJob(workspaceRoot, job.id);
      }
      const next = (current.activity ?? []).filter(event => event.seq > cursor);
      if (next[0]?.seq > cursor + 1) activityEvicted += next[0].seq - cursor - 1;
      for (const event of next) {
        if (direct && !quiet) {
          const text = redactActivity(formatActivity(event, { root: current.request?.cwd ?? workspaceRoot })).replace(/\s+/g, " ").trim();
          // Progress never marks directOutputStarted: a later signal must still
          // emit its owner_stopped JSON. The formatter prefixes every event.
          const line = text.length > 200 ? `${text.slice(0, 199)}…` : text;
          progress.push(line);
        } else if (!json && (feedMax === 0 || streamed < feedMax)) {
          streamed += 1;
          const line = streamed === feedMax ? `${formatActivity(event, { root: current.request?.cwd ?? workspaceRoot })}\n… feed paused after ${feedMax} lines; later events are counted in the final JSON (activityCount) and shown by /codex:status` : formatActivity(event, { root: current.request?.cwd ?? workspaceRoot });
          try { await writeLine(line); }
          catch (error) { if (error.code !== "EPIPE") throw error; detach("stdout_closed"); process.exitCode = 130; return; }
        }
        activity.push(event); cursor = event.seq;
      }
      if (next.length && !json) updateJob(workspaceRoot, job.id, stored => ({ activityCursors: { ...stored.activityCursors, [reader]: Math.max(cursor, stored.activityCursors?.[reader] ?? 0) } }));
      const pending = current.pendingQuestion;
      const terminal = !ACTIVE.has(current.status);
      // An expired slot is abandoned (its bridge is gone): wait past it, as the
      // snapshot already reports running, instead of returning immediately.
      if (terminal || (pending && pending.answer === undefined && !(Date.now() >= pending.expiresAt) && pending.id !== afterQuestion) || Date.now() - started >= timeout * 1000 || (minimum !== null && activity.length && Date.now() - started >= minimum * 1000)) {
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
    stopRenewal(); progress?.stop();
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
  }
}

async function handleWait(argv) {
  const { options, positionals } = parseCommandInput(argv, COMMAND_OPTIONS.wait);
  const toolUseId = deliveryToolUseId(options);
  validateDirectOptions(argv, DIRECT_OPTION_CONFLICTS.wait, options);
  if (!positionals[0]) throw new Error("wait requires a job id.");
  const selected = resolveWorkerTarget(resolveCommandCwd(options), positionals[0], { command: "wait", nameState: "wait", legacyReferences: !DUET_INVOCATION || options.owner !== undefined });
  const { workspaceRoot, job } = buildSingleJobSnapshot(selected.cwd, selected.reference);
  if (options.owner === undefined && (DUET_INVOCATION || positionals[0].toLowerCase() === job.agentName?.toLowerCase())) options.owner = selected.job.ownerId;
  await waitForJob(workspaceRoot, job, { owner: options.owner, timeoutSec: options["timeout-sec"], minIntervalSec: options["min-interval-sec"], afterQuestion: options["after-question"], feedLimit: options["feed-limit"], json: options.json, direct: options.direct, quiet: options.quiet, details: options.details, toolUseId });
}

async function handleAnswer(argv) {
  const { options, positionals } = parseCommandInput(argv, COMMAND_OPTIONS.answer);
  const toolUseId = deliveryToolUseId(options);
  validateDirectOptions(argv, DIRECT_OPTION_CONFLICTS.answer, options);
  if (!positionals[0]) throw new Error("answer requires a worker name or job id; pass answer text on stdin.");
  if (positionals.length !== 1) throw new Error("Pass answer text only on stdin, never on the command line.");
  const shortcut = options.question === undefined;
  const selected = resolveWorkerTarget(resolveCommandCwd(options), positionals[0], { command: "answer", nameState: "pending", pending: shortcut, legacyReferences: !shortcut });
  try {
    if (shortcut) {
      options.question = selected.job.pendingQuestion.id;
    }
    options.owner ??= selected.job.ownerId;
    if (options.direct && !options.owner) throw new Error("answer --direct requires --owner <id>.");
    if (!options.direct && options["timeout-sec"] !== undefined) throw new Error("--timeout-sec requires --direct.");
    const { workspaceRoot, job } = buildSingleJobSnapshot(selected.cwd, selected.reference);
    const text = readStdinIfPiped();
    if (options.direct) {
      await waitForJob(workspaceRoot, job, { owner: options.owner, afterQuestion: options.question,
        timeoutSec: options["timeout-sec"], direct: true, quiet: options.quiet, answer: { questionId: options.question, text }, toolUseId });
      return;
    }
    const answered = answerQuestion(workspaceRoot, job.id, options.question, text, options.owner);
    if (reportMovedOwner(answered, options.owner, options.json)) return;
    const renewed = renewLease(workspaceRoot, job.id, options.owner);
    if (reportMovedOwner(renewed, options.owner, options.json)) return;
    const payload = { jobId: job.id, ...(job.agentName ? { agentName: job.agentName } : {}), questionId: options.question, status: "answer_submitted" };
    outputResult(options.json ? payload : `${JSON.stringify(payload)}\n`, options.json);
  } catch (error) {
    throw Object.assign(error, { resolvedJob: selected.job });
  }
}

// Ultra-codex mode: a per-session switch (like `/effort ultracode`) read by the
// UserPromptSubmit hook. `status --for-command` is what the slash command's
// preamble runs, without interpolating task text into shell source. Claude
// dispatches the raw arguments in prose and Reads the protocol only for tasks.
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
    const preamble = options["for-command"]
      ? `Usage: /codex:ultra-codex [on [--quick|--thorough] [--max-workers <n>] [<task>] | off | status | <task>]\nIf the arguments describe a task, Read ${PROTOCOL_PATH} (protocol v${protocolVersion()}) before orchestrating; otherwise do not read it.\n`
      : "";
    const text = `${renderUltraMode(mode)}\n${preamble}`;
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
    running.length ? `Codex jobs from this session still running: ${running.map(job => `${job.jobId} (${job.status})`).join(", ")}. Cancel them only if the user asks:` : "No Codex jobs from this session are still running.",
    ...running.map(job => `/codex:cancel ${job.jobId}`)
  ];
  outputCommandResult(payload, `${lines.join("\n")}\n`, options.json);
}

async function handleJournal(argv) {
  const { options, positionals } = parseCommandInput(argv, { valueOptions: ["cwd", "run"], booleanOptions: ["json", "switch"], rejectUnknown: true });
  const [action, type] = positionals;
  if (!["start", "use", "add", "close", "show", "validate", "list"].includes(action) || positionals.length !== (["add", "use"].includes(action) ? 2 : 1)) throw new Error("journal takes start, use <runId>, add <criteria|withdraw|verdict|decision>, close, show, validate or list.");
  if (options.run !== undefined && ["start", "use", "list"].includes(action)) throw new Error(`journal ${action} does not accept --run.`);
  if (options.switch !== undefined && action !== "start") throw new Error(`journal ${action} does not accept --switch.`);
  const cwd = resolveCommandWorkspace(options), sessionId = getCurrentClaudeSessionId();
  if (action === "use") {
    const result = useRun(cwd, sessionId, type);
    outputCommandResult(result, `${JSON.stringify(result)}\n`, options.json);
    return;
  }
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
  if (action === "validate") {
    const result = validateRun(cwd, sessionId, options.run);
    outputCommandResult(result, renderValidation(result), options.json);
    process.exitCode = result.ok ? 0 : 2;
    return;
  }
  let input;
  try { input = JSON.parse(readStdinIfPiped()); } catch { throw new Error("Journal stdin must contain valid JSON."); }
  try {
    const result = action === "start" ? startRun(cwd, sessionId, input, process.env, { switchRun: Boolean(options.switch) })
      : action === "add" ? addEntry(cwd, sessionId, type, input, options.run) : closeRun(cwd, sessionId, input, options.run);
    outputCommandResult(result, `${JSON.stringify(result)}\n`, options.json);
  } catch (error) {
    if (error.code !== "RUN_HAS_OPEN_ISSUES") throw error;
    outputCommandResult(error.validation, `Passed close refused. ${renderValidation(error.validation)}`, options.json);
    process.exitCode = 2;
  }
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
  const quotePath = value => `'${value.replaceAll("'", "'\\''")}'`;
  const directories = [
    ...result.inertWorkspaces.map(item => `Inert workspace: ${item.workspace} — does not block inventory or retention; safe to delete manually while inactive: rm -r ${quotePath(item.workspace)}`),
    ...result.workspacesRetained.map(item => `Kept workspace (may be live): ${item.workspace} (${item.reason})`)
  ];
  outputCommandResult(result, `${[summary, ...directories, ...(legacyRetained ? [`${legacyRetained} retained (legacy paths)`] : []), ...result.warnings, ...(result.errors.length ? [`${result.errors.length} errors/skips; use --json for details.`] : [])].join("\n")}\n`, options.json);
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
    case "reserve-name":
      handleReserveName(argv);
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

if (DUET_INVOCATION || (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))) main().catch((error) => {
  let message = error instanceof Error ? error.message : String(error);
  if (error.code === "UNKNOWN_OPTION" && usageFor(process.argv[2])) message += `\n\n${usageFor(process.argv[2])}`;
  if (["task", "wait", "answer"].includes(process.argv[2]) && requestsDirect(process.argv.slice(3))) {
    const job = error.resolvedJob;
    // Keep the identity without projecting the completed turn's result over
    // this command's error summary or attaching its checks and usage.
    const report = directReport({ status: "error", error: message }, job ? {
      id: job.id, agentName: job.agentName, workspaceRoot: job.workspaceRoot ?? job.request?.cwd
    } : undefined);
    // Reuse the quoted exact handle and cwd from details; observing a rejected
    // answer must never submit a newer question or start a follow-up task.
    if (job) {
      report.next = report.details.replace(/ --details$/, "");
      if (envelopeBytes(report) > 2000) report.next = null;
    }
    writeDirectLineSync(report);
  }
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
