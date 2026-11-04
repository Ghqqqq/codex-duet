#!/usr/bin/env node
import fs from "node:fs";
import { readHookInput } from "./lib/fs.mjs";
import { fileURLToPath } from "node:url";
import { spawnOwned } from "./lib/process.mjs";
import { resolveIsolatedCodexHome, resolveCodexBinary } from "./lib/codex-home.mjs";
import { ensureBrokerSession } from "./lib/broker-lifecycle.mjs";
import { listSessionJobs } from "./lib/state.mjs";
import { ACTIVE, requestCancel } from "./lib/job-runtime.mjs";
import { TRANSCRIPT_PATH_ENV } from "./lib/claude-session-transfer.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import { clearMode, pruneModes, readMode, reminderText } from "./lib/ultra-codex-mode.mjs";
import { runAutomaticRetention } from "./lib/retention.mjs";
import { activeRunContext } from "./lib/run-journal.mjs";
import { deleteClaudeSnapshot, recordClaudeTranscript } from "./lib/claude-memory.mjs";
export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";
// Name the selected dispatch route up front so the first task needs no readiness notice.
// An unavailable adapter observation enables the Bash fallback on later sessions.
async function sessionStartContext() {
  let model = "gpt-6-astra", effort = "xhigh", dispatch = "auto", unavailable = null;
  try {
    const { readWorkerDefaults, dispatchPreference, readNativeUnavailable } = await import("./lib/setup-config.mjs");
    ({ model, effort } = readWorkerDefaults());
    dispatch = dispatchPreference();
    if (dispatch === "auto") unavailable = readNativeUnavailable();
  } catch { /* built-in guidance must remain available on any preference error */ }
  const bash = dispatch === "bash" || Boolean(unavailable);
  const routeContext = bash ? [
    dispatch === "bash"
      ? 'The saved dispatch preference is bash: dispatch through background Bash `duet task`; load the `codex:native-fallback` skill and follow it. Do not use codex:codex-native.'
      : `Native dispatch was unavailable on this host at ${unavailable.at} (missing turn start); prefer background Bash \`duet task\` through the \`codex:native-fallback\` skill. This observation is honored for 24 hours after the last observation, or until \`duet setup --dispatch\` is run without \`--dry-run\`.`
  ] : [
    'Dispatch Codex natively by default from the first dispatch: Agent(subagent_type: "codex:codex-native", prompt: "<brief>") (a valid caller name is kept when free; otherwise the plugin assigns a scientist name; the name appears in the Agent result); an optional first prompt line DUET: <flags> sets task flags. The agent result is the Duet report; use SendMessage to the named agent for follow-ups and answers.',
    "If native dispatch returns `native_adapter_unavailable` or `native_capacity`, needs a per-call option the `DUET:` line rejects, or you must follow up a worker launched through Bash, load the `codex:native-fallback` skill and follow it."
  ];
  return [
    ...routeContext,
    `When delegating outside an orchestration mode, explicitly set model, effort and speed: \`${bash ? "duet task" : "DUET:"} --model ${model} --effort ${effort} --normal\` unless the user chose otherwise; add \`--sandbox read-only\` for investigation/review. Active ultra, pair, duel or roundtable reminders and protocols take precedence.`,
    `Use a fresh ${bash ? "worker" : "native agent"} per independent job; never run two jobs on one thread at once. Concurrent edits need disjoint owned paths or separate worktrees.`,
    "Briefs state the objective, owned paths, numbered acceptance criteria and verification commands.",
    "Accept only on evidence: read the actual diff and rerun checks. A success message, launch receipt or `running` payload is not completion; never simulate a worker report or notification."
  ].join("\n");
}
const shellEscape = value => `'${String(value).replace(/'/g, `'"'"'`)}'`;
function appendEnvVar(name, value) {
  if (!process.env.CLAUDE_ENV_FILE || value == null || value === "") return;
  try {
    let previous = "";
    try { previous = fs.readFileSync(process.env.CLAUDE_ENV_FILE, "utf8"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const separator = previous && !previous.endsWith("\n") ? "\n" : "";
    fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `${separator}export ${name}=${shellEscape(value)}\n`);
  } catch { /* Every export is best effort; startup context must still be emitted. */ }
}
async function main() {
  const event = process.argv[2];
  if (event === "prewarm") {
    const cwd = process.argv[3] || process.cwd();
    let broker = null;
    try { broker = await ensureBrokerSession(cwd); } catch { /* Retain threads if prewarm is unavailable. */ }
    await runAutomaticRetention({ cwd, broker });
    return;
  }
  const inputStarted = Date.now();
  const raw = (await readHookInput()).trim(), input = raw ? JSON.parse(raw) : {};
  // Input has a two-second cap; cleanup shares four seconds with that read,
  // reserving a second of the host's five-second timeout for startup and exit.
  const deadline = Date.now() + Math.max(0, 4000 - (Date.now() - inputStarted));
  const cwd = resolveWorkspaceRoot(input.cwd || process.cwd());
  if ((event || input.hook_event_name) === "SessionStart") {
    appendEnvVar("CODEX_COMPANION", fileURLToPath(new URL("./codex-companion.mjs", import.meta.url)));
    appendEnvVar(SESSION_ID_ENV, input.session_id);
    appendEnvVar("CODEX_COMPANION_SESSION_CWD", input.cwd || process.cwd());
    appendEnvVar(TRANSCRIPT_PATH_ENV, input.transcript_path);
    // Native companions inherit the host environment, not CLAUDE_ENV_FILE.
    try { recordClaudeTranscript({ sessionId: input.session_id, transcriptPath: input.transcript_path }); }
    catch { /* best effort; fork can look up the session in Claude's projects tree */ }
    // Clear stale state on a fresh start, then apply only the saved opt-in
    // default. Resumed or compacted sessions keep their own mode, including off.
    let modeReminder = "";
    try {
      pruneModes(cwd);
      if (input.session_id) {
        if (["resume", "compact"].includes(input.source)) {
          const mode = readMode(cwd, input.session_id); // discard legacy workspace records
          if (mode) {
            const { readWorkerDefaults } = await import("./lib/setup-config.mjs");
            modeReminder = reminderText(mode, undefined, readWorkerDefaults());
          }
        }
        else {
          clearMode(cwd, input.session_id);
          if (["startup", "clear"].includes(input.source)) {
            const { defaultModeSetup } = await import("./lib/setup-config.mjs");
            const { defaultMode } = defaultModeSetup();
            if (defaultMode !== "off") {
              const { setMode } = await import("./lib/ultra-codex-mode.mjs");
              setMode(cwd, input.session_id, { name: defaultMode });
            }
          }
        }
      }
    } catch { /* best effort */ }
    for (const key of ["CLAUDE_PLUGIN_DATA", "CODEX_COMPANION_HOME", "CODEX_COMPANION_BIN"]) appendEnvVar(key, process.env[key]);
    try {
      resolveIsolatedCodexHome(); resolveCodexBinary();
      const child = spawnOwned(process.execPath, [fileURLToPath(import.meta.url), "prewarm", cwd], {
        cwd, env: { ...process.env, CODEX_COMPANION_SESSION_ID: input.session_id || "" }, detached: true, stdio: "ignore"
      });
      child.on("error", () => {}); child.unref();
    } catch { /* Missing prerequisites are reported by setup/task, not a login prompt. */ }
    const runContext = activeRunContext(cwd, input.session_id);
    process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: await sessionStartContext() + (runContext ? `\n${runContext}` : "") + (modeReminder ? `\n${modeReminder}` : "") } })}\n`);
    return;
  }
  if ((event || input.hook_event_name) !== "SessionEnd") return;
  const session = input.session_id || process.env[SESSION_ID_ENV];
  if (!session) return;
  if (Date.now() >= deadline) return;
  try { deleteClaudeSnapshot(session, process.env, { deadline }); } catch { /* best effort; retention retries stale snapshots */ }
  if (Date.now() >= deadline) return;
  // Keep the mode for a later resume; SessionStart prunes old records and
  // resets the mode on startup/clear before applying the saved default.
  const inventory = () => listSessionJobs(cwd, session, { deadline, lockTimeoutMs: 0 });
  const jobs = inventory().filter(job => ACTIVE.has(job.status));
  // Wake the owning workers through their control records. Never signal a PID
  // from historical state or shut down a broker serving another Claude session.
  for (const job of jobs) {
    if (Date.now() >= deadline) break;
    try { requestCancel(job.workspaceRoot, job.id, "session_end", {
      lockTimeoutMs: 0,
      expect: current => (current.sessionId === undefined ? current.ownerId : current.sessionId) === session
    }); }
    catch { process.stderr.write(`SessionEnd interruption unconfirmed for ${job.id}; owner lease remains the fallback.\n`); }
  }
  while (jobs.length && Date.now() < deadline) {
    if (!inventory().some(job => jobs.some(owned => owned.id === job.id) && ACTIVE.has(job.status))) break;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(100, remaining)));
  }
}
main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
