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
export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";
const shellEscape = value => `'${String(value).replace(/'/g, `'"'"'`)}'`;
function appendEnvVar(name, value) {
  if (process.env.CLAUDE_ENV_FILE && value != null && value !== "") fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export ${name}=${shellEscape(value)}\n`);
}
async function main() {
  const event = process.argv[2];
  if (event === "prewarm") { await ensureBrokerSession(process.argv[3] || process.cwd()); return; }
  const raw = fs.readFileSync(0, "utf8").trim(), input = raw ? JSON.parse(raw) : {};
  const cwd = resolveWorkspaceRoot(input.cwd || process.cwd());
  if ((event || input.hook_event_name) === "SessionStart") {
    appendEnvVar(SESSION_ID_ENV, input.session_id);
    appendEnvVar(TRANSCRIPT_PATH_ENV, input.transcript_path);
    for (const key of ["CLAUDE_PLUGIN_DATA", "CODEX_COMPANION_HOME", "CODEX_COMPANION_BIN"]) appendEnvVar(key, process.env[key]);
    try {
      resolveIsolatedCodexHome(); resolveCodexBinary();
      const child = spawnOwned(process.execPath, [fileURLToPath(import.meta.url), "prewarm", cwd], {
        cwd, env: { ...process.env, CODEX_COMPANION_SESSION_ID: input.session_id || "" }, detached: true, stdio: "ignore"
      });
      child.on("error", () => {}); child.unref();
    } catch { /* Missing prerequisites are reported by setup/task, not a login prompt. */ }
    return;
  }
  if ((event || input.hook_event_name) !== "SessionEnd") return;
  const session = input.session_id || process.env[SESSION_ID_ENV];
  if (!session) return;
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
