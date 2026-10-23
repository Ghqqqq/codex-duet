// Manual gate, NOT automated evidence. Run `node <this-file> --prepare <behavior>`
// from this checkout to create an isolated fake-runtime environment. No live
// Claude session or Codex model is started by this helper.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const checklist = `Native live acceptance — Claude Code 2.1.302 with function hooks enabled

Preparation (repeat with a new fixture for each behavior below):
1. At the checkout root run:
   node plugins/codex/tests/native-live-checklist.mjs --prepare slow-task
   Source the printed env.sh, then run the printed claude command. Use an
   authorized authentication method for the temporary CLAUDE_CONFIG_DIR;
   do not copy real settings or Codex homes. Both plugins are session-local.
2. In a fresh session send a first user prompt and confirm its attached context
   contains "Native Codex workers ready: Agent(subagent_type:" and codex-live
   opens. A second prompt, a task notification, and /reload-plugins followed by
   another prompt must not attach it again; a fresh session must. SessionStart
   no longer supplies readiness. Missing function-hook entitlement is a failed
   live gate. Do not treat the fallback model as a successful native worker.

A. Completion, continuation, and accounting (slow-task):
3. Record the main session usage view before dispatch. Ask main to call:
   Agent({subagent_type:"codex:codex-native",name:"native-live",
          description:"Native Duet live gate",prompt:"Perform the first fake assignment."})
   This build's Agent schema does not expose run_in_background; background:true
   in codex-native.md supplies it. On a build exposing that field, pass
   run_in_background:true. Use the actual schema, never invent a tool argument.
4. Record the returned native agent id. Observe one native row in /tasks and
   its transcript, and a linked job in codex-live for this Claude session.
   The completion notification must contain the worker's C2 JSON (status,
   worker, jobId, summary first), not merely a path. Main must not need Read or
   Bash to retrieve it. next must say "SendMessage to native-live to continue";
   details remains "duet result <worker> --details". No running report is final.
5. Call SendMessage({to:"native-live",message:"Continue the same fake assignment."}).
   Expect a second completion on the same native id, a new jobId, and one
   Codex thread with two turns in $DUET_LIVE_ROOT/bin/fake-codex-state.json.
   The thread cwd must still be $DUET_LIVE_ROOT/repo. codex-live groups the
   jobs on that thread. Also dispatch one Explore or general-purpose agent;
   it must retain its normal behavior and model usage.
6. In the main session's usage view inspect the native agent's attribution:
   zero added Claude tokens/cost for its two turns. Main's own orchestration
   is expected to use Claude tokens. Cross-check the native id in its
   transcript/debug log: no worker model request, no tool call, and null/zero
   completion usage. If the view cannot attribute per-agent usage, it is not
   proof: use the temporary audit hook described below and retain the trace.

B. Reload and worktree (slow-task):
7. After the worker completes, run /reload-plugins, then the same SendMessage.
   Expect the same native id and Codex thread, another job and completion,
   with no duplicated assignment. Inspect the job's dispatchNonce and sessionId.
   The store retains handles, never the launched brief. Test Agent isolation:
   "worktree" where supported: without a DUET --cwd override, the recorded
   Codex cwd must be that agent's worktree, and continuations keep it.
8. Repeat /reload-plugins during an active interruptible-slow-task fixture.
   Module unload kills its owned wait; continuity of a running process across
   unload is NOT promised. Expect cancellation/owner-loss or recovery of the
   same nonce/job, never a duplicate dispatch. Retain the native and job ids.

C. Question and answer (new fixture: w5-parent):
9. Dispatch native-live with prompt "Ask the fake parent a question.".
   Expect needs_answer with "Which fixture approach?", Small/Broad options,
   and next "SendMessage to native-live with the answer". Its transcript must
   also contain a system notice "? Waiting for Claude: Which fixture approach?".
   SendMessage with
   message:"Small" must complete the SAME job and Codex turn. Check
   serverRequestReplies in fake-codex-state.json contains Small and that
   questionHistory in the job records the answered question.
10. Test a late SendMessage after question expiry separately. It must return
    blocked and must not reinterpret the answer as a fresh assignment.

D. Stop (new fixture: interruptible-slow-task):
11. Dispatch native-live and wait for it to appear in codex-live. Stop the
    native /tasks row. Expect fake lastInterrupt and no surviving running worker.
    Its final C2 text must say interrupted or cancelled, include the real worker
    and jobId, next "SendMessage to native-live to continue", and details
    "duet result <worker or jobId> --details". It must not be blocked with null
    handles. Repeat using TaskStop with the actual task id.
    Repeat immediately after dispatch to exercise the pre-handle gap; a
    recorded nonce must reconcile to cancellation, never launch another job.
12. Park a question using w5-parent, then stop its already-ended native row.
    The API has no agent-stopped event for this state. turn.complete isAborted
    cancels when delivered; otherwise the question expires after the companion
    default (900 seconds). Do not claim immediate parked-question cancellation.
    Before stopping, leave interruptible-slow-task running for 12 minutes. Open
    its /tasks transcript: expect a thinking heartbeat at least every 60 s,
    "Codex worker <name> running · <elapsed>", with no 600 s stall. Then stop it
    and check the C2 fields above. Repeat in a fresh session with a real native
    job whose prompt requests a 720-second wait plus occasional short command
    progress. The live thinking and system notices must show the companion
    lines without [n] prefixes, a started line with job/model/effort/sandbox,
    and no user-role progress rows. Only C2 JSON belongs in the final text.
    For the hour-long wait gate, leave interruptible-slow-task for >3600 seconds,
    verify a further wait attaches without a running final/model fallback,
    then stop it. This soak is manual and has not been run by the test runner.

E. Fail-safe (only in a temporary copy beneath DUET_LIVE_ROOT):
13. Copy plugins/codex to the fixture, remove nativeAgent(on) from hooks/register.mjs,
    and load only that copy in a new temporary Claude configuration. No native
    readiness line should appear. Agent must return the short blocked fallback
    report, call no tools, and create no job. This fallback MAY consume Claude
    tokens. Zero usage is guaranteed only while the registered hook answers.
14. Separately inject a throw in drive in that temporary copy. Expect a blocked
    synthetic report with zero model requests, and no accidental new dispatch.
    For a previously launched job, inspect duet status before retrying. Make
    Node unavailable in an isolated session: expect a blocked prerequisite
    report, never permission to solve the task with Claude.

Optional per-agent usage audit (temporary plugin, loaded after codex):
export function register(on) {
  on('turn.complete', ($, e, next) => {
    if (e.agentId) $.ui.log('NATIVE_USAGE ' + JSON.stringify({
      agentId:e.agentId, turnId:e.turnId, usage:e.usage ?? null,
      reason:e.reason, answer:e.answer
    }), {to:'debug'});
    return next(e);
  });
}
Match these observations to the actual native agent id and completion JSON.
The audit must observe usage, never rewrite it or invoke a model.

Cleanup: exit each live session. Inspect only that fixture's processes ledger;
terminate remaining ledger-owned fixture PIDs, never by process name or a real
job id. Retain the fixture's logs/state until the live observations are reviewed.

API/design limits: the sandbox exposes no host process.execPath. The adapter
resolves PATH Node once per session using node -p process.execPath, then passes
that absolute executable and the plugin's own bin/duet as argv. This is the
parent-approved interpretation of host Node, consistent with classic hooks.
Readiness is attached by the fully registered module at the first user-origin
prompt, keyed by session id in the plugin store. There is no cross-process flag.
The adapter passes the session project root as --session-cwd on every dispatch;
the worker cwd (including DUET --cwd or an agent worktree) remains independent.
For the CLAUDE.md check, start in a project with a distinctive root instruction,
use DUET --cwd for a separate directory, and inspect the recorded request: its
claudeMd.sessionCwd must be the session root, while request.cwd is the worker cwd.
The helper changes no real runtime or Claude configuration. Automated evidence
models hook boundaries; it cannot prove actual inbox/UI/notification delivery.
`;

if (process.argv[2] === '--prepare') {
  const inheritedNames = Object.keys(process.env);
  const { installFakeCodex } = await import('../../../tests/fake-codex-fixture.mjs');
  const behavior = process.argv[3] || 'slow-task';
  if (!['slow-task', 'w5-parent', 'interruptible-slow-task'].includes(behavior)) throw new Error('Choose slow-task, w5-parent, or interruptible-slow-task.');
  const root = fs.mkdtempSync('/private/tmp/duet14-g-live-');
  const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  for (const part of ['bin', 'repo', 'home', 'normal', 'claude']) fs.mkdirSync(`${root}/${part}`);
  installFakeCodex(`${root}/bin`, behavior);
  if (spawnSync('git', ['init', '-q', `${root}/repo`]).status !== 0) throw new Error('git init failed');
  const env = {
    DUET_LIVE_ROOT: root, DUET_LIVE_CHECKOUT: checkout,
    HOME: `${root}/home`, USERPROFILE: `${root}/home`, CODEX_HOME: `${root}/normal`, CODEX_SQLITE_HOME: `${root}/normal`,
    CODEX_COMPANION_NORMAL_HOME: `${root}/normal`, CODEX_COMPANION_NORMAL_SQLITE_HOME: `${root}/normal`,
    CODEX_COMPANION_HOME: `${root}/isolated`, CODEX_COMPANION_BIN: `${root}/bin/codex`,
    CLAUDE_CONFIG_DIR: `${root}/claude`, CLAUDE_PLUGIN_DATA: `${root}/data`,
    CODEX_COMPANION_TEST_MODE: '1', CODEX_COMPANION_TEST_ROOT: root,
    CODEX_COMPANION_TEST_PROCESSES: `${root}/processes`, CODEX_COMPANION_BROKER_IDLE_SEC: '2',
  };
  const quote = text => "'" + text.replaceAll("'", "'\"'\"'") + "'";
  const reset = inheritedNames.filter(key => /^(CODEX_|CLAUDE_)/.test(key) && /^[A-Z0-9_]+$/.test(key));
  const script = [...reset.map(key => `unset ${key}`), ...Object.entries(env).map(([key, value]) => `export ${key}=${quote(value)}`),
    'cd "$DUET_LIVE_ROOT/repo"',
    '# Authenticate this temporary Claude configuration by an authorized method, then run:',
    '# claude --plugin-dir "$DUET_LIVE_CHECKOUT/plugins/codex" --plugin-dir "$DUET_LIVE_CHECKOUT/plugins/codex-live" --debug-file "$DUET_LIVE_ROOT/claude-debug.log"', ''].join('\n');
  fs.writeFileSync(`${root}/env.sh`, script);
  process.stdout.write(`source ${quote(root + '/env.sh')}\n${script.split('\n').at(-2).slice(2)}\n`);
} else if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(checklist);
}
