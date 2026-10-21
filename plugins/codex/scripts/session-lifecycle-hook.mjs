#!/usr/bin/env node
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnOwned } from "./lib/process.mjs";
import { resolveIsolatedCodexHome, resolveCodexBinary } from "./lib/codex-home.mjs";
import { ensureBrokerSession } from "./lib/broker-lifecycle.mjs";
import { listSessionJobs } from "./lib/state.mjs";
import { ACTIVE, requestCancel } from "./lib/job-runtime.mjs";
import { TRANSCRIPT_PATH_ENV } from "./lib/claude-session-transfer.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import { clearMode, pruneModes } from "./lib/ultra-codex-mode.mjs";
import { runAutomaticRetention } from "./lib/retention.mjs";
import { activeRunContext } from "./lib/run-journal.mjs";
export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";
const SESSION_START_CONTEXT = [
  'Codex jobs: node "$CODEX_COMPANION" task --fresh --direct --model gpt-6-astra --effort xhigh --normal --cwd <dir>',
  "Run with Bash run_in_background: true; brief on stdin through a single-quoted heredoc; progress shows in /tasks; result: grep '^{' <output file> | tail -n 1.",
  "Use a fresh thread per independent job; follow up with task --thread <threadId> --direct in the same cwd.",
  'Run node "$CODEX_COMPANION" task --help for flags, examples and JSON result handling.'
].join("\n");
const shellEscape = value => `'${String(value).replace(/'/g, `'"'"'`)}'`;
function appendEnvVar(name, value) {
  if (process.env.CLAUDE_ENV_FILE && value != null && value !== "") fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export ${name}=${shellEscape(value)}\n`);
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
  const raw = fs.readFileSync(0, "utf8").trim(), input = raw ? JSON.parse(raw) : {};
  const cwd = resolveWorkspaceRoot(input.cwd || process.cwd());
  if ((event || input.hook_event_name) === "SessionStart") {
    try { appendEnvVar("CODEX_COMPANION", fileURLToPath(new URL("./codex-companion.mjs", import.meta.url))); } catch { /* best effort */ }
    appendEnvVar(SESSION_ID_ENV, input.session_id);
    appendEnvVar(TRANSCRIPT_PATH_ENV, input.transcript_path);
    // A mode is per session and never inherited: a stale file from a session
    // that ended without SessionEnd is removed here. A resumed or compacted
    // session keeps the mode it had.
    try { pruneModes(cwd); if (input.session_id && !["resume", "compact"].includes(input.source)) clearMode(cwd, input.session_id); } catch { /* best effort */ }
    for (const key of ["CLAUDE_PLUGIN_DATA", "CODEX_COMPANION_HOME", "CODEX_COMPANION_BIN"]) appendEnvVar(key, process.env[key]);
    try {
      resolveIsolatedCodexHome(); resolveCodexBinary();
      const child = spawnOwned(process.execPath, [fileURLToPath(import.meta.url), "prewarm", cwd], {
        cwd, env: { ...process.env, CODEX_COMPANION_SESSION_ID: input.session_id || "" }, detached: true, stdio: "ignore"
      });
      child.on("error", () => {}); child.unref();
    } catch { /* Missing prerequisites are reported by setup/task, not a login prompt. */ }
    const runContext = activeRunContext(cwd, input.session_id);
    process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: SESSION_START_CONTEXT + (runContext ? `\n${runContext}` : "") } })}\n`);
    return;
  }
  if ((event || input.hook_event_name) !== "SessionEnd") return;
  const session = input.session_id || process.env[SESSION_ID_ENV];
  if (!session) return;
  try { clearMode(cwd, session); } catch { /* best effort */ }
  const deadline = Date.now() + 4000;
  const jobs = listSessionJobs(cwd, session).filter(job => ACTIVE.has(job.status));
  // Wake the owning workers through their control records. Never signal a PID
  // from historical state or shut down a broker serving another Claude session.
  for (const job of jobs) {
    if (Date.now() >= deadline) break;
    try { requestCancel(job.workspaceRoot, job.id, "session_end", { lockTimeoutMs: 0 }); }
    catch { process.stderr.write(`SessionEnd interruption unconfirmed for ${job.id}; owner lease remains the fallback.\n`); }
  }
  while (jobs.length && Date.now() < deadline) {
    if (!listSessionJobs(cwd, session).some(job => jobs.some(owned => owned.id === job.id) && ACTIVE.has(job.status))) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
