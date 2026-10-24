# Native worker lifecycle and protocol evidence

Prefer `Agent(subagent_type: "codex:codex-native")` when available; otherwise
run `duet task` in background Bash. Reports arrive with completion notifications;
only if missing, use `duet result <worker>`. The Haiku `codex:codex-worker` is a
fallback when neither native dispatch nor background Bash is available, or for
a user-requested forwarding-agent transcript. Native agents receive follow-ups
and pending answers through SendMessage; see [direct mode](direct-mode.md).

## Direct mode

`duet task` implies `--direct`: it enqueues a detached task-worker, then attaches
this process as its owner wait. Use Bash `run_in_background: true`,
`description: "Codex: <label>"` and, when Claude's Bash sandbox is on,
`dangerouslyDisableSandbox: true` for network and local sockets. Put the brief
only on stdin through a single-quoted `DUET_TASK` heredoc. The plugin adds its
`bin/duet` launcher to PATH; older sessions may need a reload/new session or the
absolute launcher path. See the [dispatch recipe](worker-operations.md#direct-mode).

Direct mode prints progress in `/tasks`, then report v2 when the job ends, a
question is pending or the timeout passes. `--quiet` suppresses progress. A
re-wait prints only activity after the reader's stored cursor. The default
`--timeout-sec` is 3600 (maximum 3600); the default `--lease-sec` is 1800, versus
180 outside direct mode. The process heartbeats and renews the lease while
attached. A normal return leaves the lease protecting the job; observation-only
status/result calls do not renew it.

When a worker tick is delayed by more than two seconds (for example, Mac sleep),
it shifts an active, uncancelled job's heartbeat and lease by the full gap under
the state lock, caps them at wake time and one lease beyond wake respectively,
and skips expiry/owner checks for that tick. `lastPauseMs` and `lastPauseAt` record
the pause for diagnostics. An owner renewal refused before the worker wakes is
retried within one second; a silent owner still gets only the five-second grace
in awake time. Cancellation and terminal jobs are never revived.

The completion notification carries report v2. Only if missing, run
`duet result <worker>`; do not parse the output file, poll, sleep or use `tail -f`.
Act on `status`:

- Terminal: run the acceptance protocol even after a nonzero exit. Report v2
  gives status, worker, jobId, summary (8000-character cap), nonempty evidence,
  `next` and `details`. `checks.ran` is captured evidence; `checks.claimed` is
  Codex's account. `duet result <worker> --details` supplies full handles,
  settings, touchedFiles/preExistingChanges, file-tracking basis, verification,
  findings, assumptions, blockers and artifact paths. Read `rawOutputFile` only
  if a report field is insufficient.
- `running`: background `duet wait <worker>` and wait for its notification.
- `needs_answer`: use the report's `next` command verbatim, or background ONE
  `duet answer <worker> --question '<questionId>'` with the displayed question ID
  (`timeout: 600000`) and stdin via a single-quoted `DUET_ANSWER` heredoc. It
  refuses a stale ID, submits once and keeps waiting on the same turn. A bare
  `duet answer <worker>` answers whatever question is pending now, possibly a
  newer one. Native SendMessage already pins the displayed question. `question` gives
  id, kind, text, options and `expiresInSec`; use `--details` if text/options
  were shortened. A Computer Use approval has four fixed options; forward with
  `AskUserQuestion` unless the user pre-authorised the app. Answer only with an
  exact displayed option label, its number `1`–`4`, or a single keyword
  `call`/`once`/`task`/`always`/`deny`/`no`. Answers are trimmed and case-insensitive;
  exact labels allow a trailing period. Anything else, including `yes`, negations
  or qualified text, denies the request. Native SendMessage uses the same rules;
  see [approval choices](computer-use-approvals.md#forwarded-approvals-owned-jobs).
- `ownership_moved`: report it and stop using that owner; never re-adopt.

Never run two waits for one job. Exit codes are completed 0, blocked/needs_input
2, other terminal states 1, running/needs_answer 0, ownership_moved 2,
and stopped owner wait 130. Direct mode rejects `--follow`, `--detached`,
`--background`, `--json`, `--feed-limit` and `--min-interval-sec`.
Follow up with `duet task --to <worker>` and restated criteria on stdin; it keeps
the thread and cwd. Native agents use SendMessage instead.

Stop an active native task or background Bash wait from `/tasks`, or run
`duet cancel <worker>`. Thread context and edits persist; `duet result <worker>
--details` provides recovery handles and the compatibility `continuationCommand`.
Continue user-stopped work only with consent, using `duet task --to <worker>`
with a new brief or `duet task --continue <jobId> --cwd '<cwd>'`. After adoption,
use the new owner in one background `duet wait <jobId> --owner '<newOwnerId>'`.

The companion writes per-session markers under
`<isolated home>/duet/sessions/<claudeSessionId>/`. The separate `codex-live`
plugin (`/plugin install codex-live@duet`) reads those markers and shows session
jobs and the selected job's live messages, commands, file changes, tool calls,
plan and pending question. New jobs ask Claude Code to open the pane; Claude
Code decides whether to show it at the current width. Its `codex-live` slash
command opens it at any width. It is read-only: it never starts, answers or
cancels a job and costs no Claude tokens.

## Fallback and compatibility feed mode

Never pass `model` or `effort` to `Agent(subagent_type: "codex:codex-worker")`;
Codex's choices belong in the brief. The Haiku forwarder keeps `effort: low`,
`omitClaudeMd: true` and `autoCompactWindow: 100000`. It calls
`duet task --timeout-sec 570` in foreground Bash (`timeout: 600000`), then
`duet wait <worker> --timeout-sec 570` on `running`. Rework uses a NEW fallback
agent with `duet task --to <worker>`; SendMessage to an existing fallback only
answers its pending question. It returns report v2 verbatim plus at most five
lines of notes for stderr, retries or a relayed question.

The companion's non-direct `--follow --report` feed and `--detached` launch
remain available for compatibility; the launcher always adds `--direct` to
task/wait/answer. A compatibility `wait <job> --owner <ownerId> --report` streams
one line per event, then a JSON report with `activity` (at most 12 newest events),
`activityCount`/`activityOmitted` and `cursor`. Its feed limit is 60 lines;
`--json` suppresses the feed. Its wait budget defaults to 570 s (range 1–3600);
`--min-interval-sec` opts into early returns on activity. Terminal results and
new questions return immediately.

Activity is captured at item start/completion (completed assistant messages),
not token-by-token: assistant snippets ≤300 characters, command first lines
≤160 with exit/duration, file path/kind, MCP/dynamic server/tool/status/duration,
and plan step titles ≤80. Durations use protocol milliseconds or observed
start/completion time; missing duration/exit is explicit, never invented.
Tool arguments, command outputs, diffs, reasoning and page-content payloads are
never selected. Text is shown as Codex wrote it; only ANSI escapes and
control/bidi characters are stripped so snippets stay single-line and
terminal-safe. Credential redaction heuristics were removed in 1.0.6-isolated.12
because they blanked ordinary `NAME=value` text (for example `ANSWER=Yes`); the
prompt still forbids copying payloads into progress. Raw result artifacts keep
their existing private behavior.

Events and monotonically increasing sequence numbers live in job state;
`activityCursors` uses a hashed reader/owner key. Each explicit owner has an
independent cursor, and ownerless observers share a separate cursor. Reading as
an observer cannot consume the worker's feed or renew its lease. Feed cursors
advance after flushed lines; pure JSON advances after its final write. An abrupt
stop between delivery and cursor persistence may replay lines; run one wait per
owner at a time. The journal is retained with the job (no silent event dropping).
Legacy jobs without a journal return empty activity and cursor 0.

The fallback never re-prints progress. After forwarding a question once, it uses
`duet wait <worker> --after-question '<id>' --timeout-sec 20` to wait without
immediately returning that question on every call; the
short budget exists only so the parent's SendMessage reply can be picked up
between tool calls.

## Parent questions

Duet exposes `ask_parent` through a per-thread MCP bridge on fresh and resumed
threads. Keeping it outside Codex's code-mode tool set lets the model call it
directly, without repeated `exec`/`wait` sampling while the parent answers.
The experimental dynamic-tool API remains a compatibility fallback for fresh
threads. Duet enables `initialize.capabilities.experimentalApi: true`. Owned jobs use
`never+elicitations`: command/sandbox/rule approvals are rejected, and Computer
Use app elicitations go to the parent. There is no plan-mode switch.
Request-user-input availability in ordinary mode was not assumed. A valid tool
call keeps its RPC response pending while a private job record carries
text/options/expiry. Answer stdin resolves that call and continues the **same turn**.

Dynamic-tool fallback schema evidence (scratch files excluded from promotion):

| File / JSON pointer | Evidence |
| --- | --- |
| `.test-tmp/w5-schema/ClientRequest.json#/definitions/InitializeCapabilities/properties/experimentalApi` | Opt-in for experimental methods/fields. |
| `.test-tmp/w5-schema-experimental/v2/ThreadStartParams.json#/properties/dynamicTools` | Registration array; absent from the nonexperimental schema. |
| Same, `#/definitions/DynamicToolSpec/oneOf/0` | Function variant requires `type: function`, name, description, inputSchema. |
| `.test-tmp/w5-schema/ServerRequest.json#/definitions/DynamicToolCallParams` | `item/tool/call`: arguments, callId, threadId, tool, turnId; optional namespace. |
| `.test-tmp/w5-schema/DynamicToolCallResponse.json#/properties/contentItems` and `/success` | Reply requires success and contentItems; inputText variant carries text. |
| `.test-tmp/w5-schema/ServerRequest.json#/definitions/ToolRequestUserInputParams` | Alternative input request is described as experimental; not used to assume default-mode availability. |

Exact successful dynamic-tool fallback result (original request ID retained):

```json
{"id":7,"result":{"success":true,"contentItems":[{"type":"inputText","text":"The parent's answer."}]}}
```

`duet result <worker> --details` for `needs_answer` includes a one-line `questionMessage`:
`Question <id>: <text> | Options: "First"; "Second"` (or `(none)`). Whitespace is
normalized to one line; the fallback worker must send this
field verbatim to `main` once per question. SendMessage is allowed ONLY for this
purpose: no progress, completion claims or placeholders. The final result is
only the agent's return value. Worker messages that are not verbatim questions
are not evidence; verify job/thread/turn handles, artifacts and actual changes.

Question text is bounded to 1000 characters and six options of 160 characters;
answers to 8000 characters. Neither is copied into progress logs. The worker's
contract forbids secrets/page content in questions. The default timeout is 900
seconds (`task --question-timeout-sec`), after which the same response channel
instructs conservative assumptions and final needs_input for essential missing
input. Interrupt resolves the question with stop guidance. An answer pinned with
`--question '<id>'` (as every report's `next` is) fails once that question is no
longer pending, rather than continuing a different question. A bare
`duet answer <worker>` answers whichever question is pending now.

Both `thread/start.config.mcp_servers.duet_parent` and the corresponding
`thread/resume` override point Codex at `scripts/parent-bridge-mcp.mjs` (stdio MCP).
Its environment contains `CODEX_COMPANION_BRIDGE_CWD`, `CODEX_COMPANION_HOME`,
optional `TMPDIR`, and exactly one handle: `CODEX_COMPANION_BRIDGE_JOB` for a fresh
thread, or `CODEX_COMPANION_BRIDGE_THREAD` for a resumed thread (`duet task --to`,
`--thread`, `--continue`). Fresh starts carry no `dynamicTools`. Codex can spawn
the bridge before `thread/start` returns, so a job-bound bridge reads that job's
recorded `threadId` as soon as the companion publishes it: on every incoming MCP
message and on a `BINDING_CAPTURE_POLL_MS` (250 ms) poll for up to
`BINDING_CAPTURE_MS` (5 min), not only at the first question. Once captured, the
binding lasts for the process lifetime, so later jobs on the loaded thread keep
asking even after the starting job is pruned. Missing or malformed environment
handles fail startup.

The shared broker keeps threads and MCP servers loaded across runs, so each
`tools/call` looks up the bound thread across the isolated state store using
`recordedThreadJobs`. Eligible jobs have an ACTIVE status, a valid workspace root,
and a recorded turn ID; queued reservations without an admitted turn cannot
receive questions. A valid `_meta["x-codex-turn-metadata"].turn_id` selects only
its recorded owner. If that turn has not been published yet, lookup retries for
up to `TURN_RECORD_WAIT_MS` (3 s) at 100 ms intervals. Without valid turn
metadata (older runtimes), exactly one readable eligible job must exist; zero or
several are refused. Selection uses the readable records even when another
workspace directory is unreadable or lacks its index: turn IDs are unique and
unadmitted reservations carry none, so an unrelated leftover directory cannot
disable parent questions. Without turn metadata this is a "one readable eligible
job" rule, not a guarantee against arbitrarily damaged state.

An unknown bound thread or a differing string `_meta.threadId` returns the
existing no-listener error; metadata never supplies the bound thread. Questions
use the selected job's own workspace, including when a loaded bridge is reused
through a shared broker endpoint from another workspace. Calls block on the
same job-file flow (`askParentQuestion`) as the in-process dynamic fallback, so
`wait`/`answer` behave identically. The bridge's `tool_timeout_sec` is the question
timeout plus 120 s (capped at 86400 s).

The bridge records a valid `_meta.callId` in `questionHistory[].callId`, allowing
`codex-live` to match the answer to the MCP tool item on fresh and resumed threads.
Missing or malformed call IDs stay null; the JSON-RPC request ID is never used
for matching. Previously recorded answers without call IDs remain unmatched.

Two details were only found against the real app-server
(`codex-cli 0.162.0-alpha.17.2`) and are both required: the override sets
`omit_tools_from = ["code_mode", "deferred"]`, because otherwise the server starts
and `mcpServerStatus/list` shows the tool but the model's tool list never contains
`mcp__duet_parent.ask_parent`; and the call must be approval-free under the
worker's approval policy (`never`, or the granular `never+elicitations` of owned jobs, which rejects tool approvals the same way), which the tool's `readOnlyHint` annotation plus
`tools.ask_parent.approval_mode = "approve"` guarantee (without them Codex fails
the call with "requires approval"). If a runtime reports unsupported fresh-thread
bridge registration, Duet retries once with `dynamicTools`; an unsupported
dynamic registration retains the registration-free `thread/start` retry. The
dynamic fallback can incur repeated code-mode sampling while waiting. `thread/resume`, which has no
`dynamicTools` field, keeps its single registration-free retry. These fallbacks
share one compatibility predicate (`parentRegistrationUnsupported`): RPC code
`-32600`, `-32601`, or `-32602`, and an unsupported signal attached to the
registration field itself (`config`/`mcp_servers` or `dynamicTools`/`dynamic_tools`,
optionally dotted such as `thread/start.dynamicTools`): ``unknown field `config` ``,
`unsupported parameter ...` (optionally with a colon), `... is not supported`, or `... requires
experimentalApi`. Fields that only appear elsewhere, such as serde's list of
accepted fields (``unknown field `serviceName`, expected one of `config`, ...``) or
`Invalid model config: unsupported model selected`, propagate after one request
with the original diagnostic. Unavailable mechanisms retain the existing final
needs_input classification.

## Ownership and cleanup

Each task generates a unique ownerId by default (job ID plus random UUID),
returned for detached/background and foreground tasks. `task --owner` remains an
explicit override; ambient session/owner variables never select the owner.
The Claude session ID is recorded separately as `sessionId`. A matching owner
renews an unexpired lease; `duet wait`/`answer` resolve it automatically. Explicit
`--owner` handles remain supported. Observational `/codex:status`, `duet status`
and result reads do not renew; neither do ownerless compatibility companion waits.
Foreground owners renew while alive; detached task-workers never renew themselves.
The default lease is 1800 seconds in direct mode, 180 seconds otherwise.
SessionEnd matches sessionId, falling back to the old session-ID ownerId only
for legacy jobs without sessionId. Such jobs stay
readable and can renew only with an explicit matching owner.

An attached owner `wait` (`--owner`, including `task --direct` and `task --follow`) records
`ownerAttached: true` and renews the lease about once per second, which doubles as
its heartbeat. On SIGINT/SIGTERM/SIGHUP, a changed parent PID or a closed stdout
pipe it marks `ownerDetachReason: signal|parent_exit|stdout_closed` and exits 130;
a normal return (timeout, terminal, question) marks `returned`. The detached
task-worker's 250 ms tick stops the turn with `owner_stopped` as soon as it sees
an abnormal detach mark (a user stop is treated like killing a native subagent),
and with `owner_lost` when an attached owner's heartbeat is older than the grace
period (5 s, `CODEX_COMPANION_OWNER_GRACE_SEC`, 1–600), which only happens to an
owner that could not mark its exit (SIGKILL, crash). A dead wait can be replaced
immediately with the same owner before that interruption, while the job is
active and its lease unexpired; a second live, recently heartbeating wait is
refused. Claude Code moves a Bash call that hits its timeout to the background
instead of killing it, so no grace is needed for that case. A `returned` owner
that never comes back still falls back to lease expiry.

Task-workers and shared brokers start through a short-lived launcher that exits
before returning their real PIDs. They are therefore outside the calling shell's
descendant tree, so Claude Code stopping a background `task --direct` or
`--follow` shell lets its worker confirm `owner_stopped` while the broker and
other jobs keep running. Broker output still goes to its log. If the launcher
fails, a one-line stderr warning accompanies a direct detached-spawn fallback.

For an interrupted or failed job, `duet result <worker> --details` exposes the
compatibility `continuationCommand`. Use `duet task --continue <jobId> --cwd
'<cwd>'` for one new turn with that job's recorded settings, only with consent.
Native-agent stop and continuation behavior is described in [direct mode](direct-mode.md#if-a-worker-is-stopped).
`--continue` refuses active jobs and conflicting flags (`--thread`, `--fresh`,
`--resume*`, `--write`, `--model`, `--effort`, `--fast`, `--normal`,
`--approve-browser-origin`, `--approve-computer-app`). It reuses the job's
threadId, sandbox/write, model, effort and speed; only original request grants
from the same Claude session are eligible, excluding runtime-only approvals
and foreign dispatches after adoption. A recorded sandbox cannot be overridden.
If settings are missing, `thread_settings_unknown` requires an explicit sandbox:
`duet task --continue <jobId> --sandbox read-only --cwd '<cwd>'` is allowed in
that case. Refused or never-started attempts do not become settings anchors;
Duet consults a started predecessor. It records `request.continuedFrom` and
appends any prompt text to the default continue prompt. With the user's consent, run it
in background Bash, or through a new fallback worker; never automatically.

For a job that is still running, with the user's explicit consent, the parent
launches a replacement with the existing jobId. Its FIRST action is `duet adopt
<jobId> --json`, not task submission. Under one
job-state lock, adoption checks that the task is queued/running with an unexpired
lease and no cancellation, rotates to a new ownerId and renews the lease. It does
not call thread/resume or turn/start. It preserves the thread/turn, pending
question and last delivered owner's cursor. The replacement loops
`duet wait <jobId> --owner '<newOwnerId>'` in background Bash (the fallback
uses foreground Bash with `--timeout-sec 570`). Retired owners get
`ownership_moved` from wait/status/answer, including an already-running wait,
and cannot renew or answer. They must stop polling and must not adopt again.
The replacement's Claude session takes over SessionEnd scoping; absent a caller
session, the original scope is preserved (including legacy session-ID owners).

`adopt` returns `adopted` and `waitCommand` on success (exit 0). It returns
`lease_expired`, `job_ended`, `interrupting` or `not_adoptable` on refusal (exit 2),
without rotating ownership or starting a turn. Expiry is checked under the lock,
even before the task-worker's next expiry tick; an expired lease cannot revive.
Refusals include the same exact `continuationCommand` (`task --continue <jobId>`)
in the original working directory; it is never run automatically. Wait for
pending interruption to finish before continuing. No thread handle means no
continuation command. Thread context and on-disk edits survive interruption.

Status marks running jobs orphaned after no renewal for half the lease in direct
mode (900 seconds with the default 1800-second lease), or min(65 seconds, half the
lease) otherwise, with `leaseRemainingSec` and an exact `adoptCommand`. This is a
stale renewal heuristic, not proof that the native agent stopped; adoption need not
wait for this threshold. A retired or replaced wait stops renewing and cannot
detach its replacement. See [stop actions and recovery](direct-mode.md#if-a-worker-is-stopped).

This is lifecycle coordination, not an authentication boundary for local users.
Lease expiry, cancel, signals and SessionEnd trigger the worker's AbortSignal,
resolve questions and request turn/interrupt. A four-second turn deadline closes
the owned client/server; startup interruption also has a bounded client cleanup.
Confirmed cancellation requires terminal turn evidence, not the interrupt RPC ack.
Cancel returns unconfirmed (exit 2) if evidence is unavailable, including legacy
records without a control-aware worker. It does not kill a historical PID.
A dead worker with no thread handle is resolved as failed on refresh. If a
thread exists but the turn handle is missing, read-only `thread/read` can recover
a turn only when exactly one candidate started at or after the job's start, no
other recorded job owns it (whether that job's wrapper is alive or dead), and no
other handle-less job on the thread could have started it in the same window.
Missing timestamps, multiple candidates, unreadable or inconsistent ownership
records (a malformed index, or job files without an index) leave the outcome
unresolved. Only a readable history with no matching candidate establishes that
the turn never started. A missing-handle cancel interrupts only such a uniquely
attributed live turn; otherwise it reports `interrupt_unconfirmed` (exit 2).

Before starting a follow-up, Duet also checks the server for in-progress turns,
including external turns and jobs in other workspaces. Any such turn yields
`thread_busy` without a new turn. A per-thread admission reservation under the
isolated home (`duet/thread-admission/`) is held from that check until the new
turn's handle is saved, so a concurrent follow-up from another connection,
broker or workspace is refused with `thread_busy` rather than racing the check.
Another live job on the thread, including a fresh thread whose first turn is not
yet accepted, also counts as busy. A reservation whose holder died is reclaimed
after a 30-second settle window (`THREAD_ADMISSION_SETTLE_MS`), so a start
request the holder already sent can be accepted and seen by the next check; a
wrapper that crashed within that window before recording a turn also keeps the
thread busy. Known limit: if a worker is killed while its start request is still
pending in a broker and Codex accepts that request more than 30 seconds later, a
concurrent follow-up from another workspace can run alongside the late turn. The
broker shuts down about 4 seconds after accepting a turn whose client is gone,
which ends that orphaned turn. Recovery/cancel commands are supplied only
when a tracked job owns the turn; an external turn must be resolved by its owner.
Refused or blocked attempts never become thread blockers.

Codex's turn/interrupt leaves the commands a turn started running (unified-exec
sessions under `codex app-server`). After every Duet-initiated interrupt, on the
worker's own connection or, for `duet cancel` of a lost turn, on the broker that
owns the thread, Duet sends the experimental `thread/backgroundTerminals/clean`
with the threadId (capped at 3 s), including confirmed cancellation before a
new turn started. This ends every background terminal of that
thread, including servers it started in earlier turns. The outcome is recorded
as `backgroundTerminals: {cleaned, detail}` on the job (`duet result --details`)
and in `duet cancel --json`. It never changes the cancellation's confirmation or
exit code. A natural turn end sends no terminal cleanup. Task-scoped Computer Use grants
left behind by a dead worker are released at the next start or recovery.

SessionEnd writes cancellation controls for this Claude session and waits up to
four seconds inside the hook's five-second budget, across worktrees sharing the
state root `<isolated-home>/duet/state`. Busy state locks are reported
unconfirmed without blocking; lease expiry remains the fallback. History remains
recoverable.

Job state lives in the isolated home (`~/.claude/codex-isolated/duet/state/`,
beside `duet/config.toml`), never under `CLAUDE_PLUGIN_DATA` or the temp dir, so
every entry point of one machine shares one set of records. Directories from
releases before 1.0.6-isolated.15 (`~/.claude/plugins/data/codex-*/state`,
`$TMPDIR/codex-companion-isolated`) are merged lazily per workspace, once, under
the new directory's lock, with a marker (`.legacy-migration.json`) and an
in-process memo so the steady-state cost is a map lookup. The merge keeps the
newer `updatedAt` record per job ID and leaves legacy directories in place, but
the history cap can prune records and their recorded artifacts. It respects a
legacy directory's own `.state-lock` (a busy one is retried later). A legacy job
whose recorded `pid` is alive is *pending*: it stays in its legacy directory, is
listed and waited on from there, receives `cancel`/SessionEnd controls there,
and is merged when that worker exits. Owner, lease and adoption rules are
unchanged by the move; `adopt` and `task --continue` on a migrated job behave as
on a native one. A job or thread reference unknown to the new directory falls
back to the legacy directories and imports the match, covering records an older
session writes after the merge. SessionEnd runs the same check for its own
workspace with a bounded lock wait before cancelling. Upgrade or downgrade
with no Duet jobs running; legacy migration does not make mixed-version writes safe.
It never shuts down a shared broker used by another session. The broker interrupts
turns when their owner socket disconnects and closes its server group after a
bounded failure deadline. With no clients or active turns it exits after 60 seconds
(CODEX_COMPANION_BROKER_IDLE_SEC). SessionStart prewarms detached and does not wait
for readiness. Cleanup signals only child/process groups spawned by this runtime.
SIGKILL and host crashes cannot run signal handlers; the detached owner's lease
and broker disconnect handling are the supported recovery paths. No blanket
pkill/killall or live-process sweep is performed.
Broker signal cleanup is installed before app-server initialization; a fixture
verifies that interrupting this startup phase also reaps its separate server group.

## Test isolation and the baseline leak

The archived `.test-tmp/baseline/tests/fake-codex-fixture.mjs` buildEnv spread the
real process environment and changed only PATH. Its helpers had no test-home
bootstrap. An inherited home/broker/runtime pointer therefore survived; the
isolated runtime.json pointer wins before PATH lookup, so fake PATH alone could
still select the real executable/home. This explains a path for the parent's
observed baseline leak; the exact historical environment was not captured here.

All current test entry points initialize temporary HOME, CODEX_HOME, SQLite home,
plugin data and a short temporary root. Inherited Codex/broker pointers are removed.
The runtime's test-home guard rejects any home/data outside that root and refuses
non-fixture executables; symlinks are canonicalized. No real config, credentials,
app resources or network are required by tests. The process ledger records only
fresh suite-owned spawns. Teardown signals only that ledger and asserts no recorded
process survives; macOS group-signal EPERM falls back to its known owned PID.
The archive is evidence, not a test entry point; never run old baseline tests with
an ambient developer environment.

## Startup measurement and transport

Logs/snapshots/final reports record brokerConnectSpawn, appServerInitialize,
threadStart or threadResume, turnStart, firstModelEvent and firstToolCall. Reused
brokers include their original initialize duration plus brokerHandshake. MCP ready
is the first observed ready notification; null is explicitly unobserved, not zero.
Durations and offsets are milliseconds. WebSocket retry/timeout/fallback stderr
signals produce a fixed startupWarning with `setup --transport http` remediation.
No payload/stderr dump is needed for that warning.

`setup --transport status` reads only; explicit http/websocket writes a named
ChatGPT provider and selector, preserves other content and backs up changes.
Matching hand-written openai-http is a byte-exact no-op. Other custom providers
are refused rather than guessing their endpoint/auth. No default is changed;
WebSocket-off can avoid observed retry delays but loses healthy connection reuse.
No live speed measurement was made in W5.

Schemas were generated with the installed bundled binary and scratch home:

```sh
mkdir -p .test-tmp/w5-schema-home
 env -i HOME="$PWD/.test-tmp/w5-schema-home" CODEX_HOME="$PWD/.test-tmp/w5-schema-home" PATH=/usr/bin:/bin /Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex app-server generate-json-schema --out "$PWD/.test-tmp/w5-schema"
 env -i HOME="$PWD/.test-tmp/w5-schema-home" CODEX_HOME="$PWD/.test-tmp/w5-schema-home" PATH=/usr/bin:/bin /Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex app-server generate-json-schema --experimental --out "$PWD/.test-tmp/w5-schema-experimental"
```

Official documentation retrieval was attempted but unavailable in this sandbox:
`curl: (7) Failed to connect to 127.0.0.1 port 7897 ... Couldn't connect to server`.
The installed generator's help, output and bundled source above are the primary
evidence; no web snippet or unverified protocol field was substituted.

## Parent acceptance after W6 finishes

Run from staging, with the native Bash outer sandbox disabled and sockets enabled:

```sh
env TMPDIR=/private/tmp npm run verify
```

The suite uses its own fixture homes even outside the sandbox. Do not run archived
baseline copies. No existing/live broker needs to be killed for the tests.

## isolated.9 live acceptance (Claude only; not run by fixture verification)

Use staging's native worker definition in Claude Code, with outer Bash sandbox
disabled on its calls. Do not stop unrelated workers; use `x` on the smoke agent's
detail view, since Esc/Ctrl+C with empty main input stops ALL background agents.
Before launching any replacement, obtain the user's explicit consent.

Give one `codex:codex-worker` this read-only assignment:

```text
Run three harmless node commands that print step numbers, separated by 3-second
pauses. Send ordinary assistant progress messages and update your plan. Then use
ask_parent to ask "Finish this smoke?" with options Yes and No, and wait. Do not
edit files, use a browser, access secrets, or commit. After Yes, report completion.
```

Open the worker in the Agent view. Its Bash description must match the previous
headline; actual command lines, status/duration and assistant snippets
must appear while each wait is still running, before the final JSON. Command
output/tool arguments must be absent. The worker sends exactly the companion's
questionMessage once, with no progress/completion SendMessage. Compare the text
against an ownerless `wait <jobId> --json` response if needed.

The direct command equivalent follows. Run from the staging repository; use a
terminal/live Bash output, not a buffering command substitution. Replace each
angle-bracket handle with the actual returned value. These are manual smoke
instructions, not a script to run without inspecting each result.

```sh
node plugins/codex/scripts/codex-companion.mjs task --fresh --detached --report --json --lease-sec 180 --model gpt-6-astra --effort xhigh --normal <<'DUET_FEED_SMOKE'
Run three harmless node commands that print step numbers, separated by 3-second
pauses. Send ordinary assistant progress messages and update your plan. Then use
ask_parent to ask "Finish this smoke?" with options Yes and No, and wait. Do not
edit files, use a browser, access secrets, or commit. After Yes, report completion.
DUET_FEED_SMOKE
node plugins/codex/scripts/codex-companion.mjs wait '<jobId>' --owner '<ownerId>' --report
```

(Or replace `--detached` with `--follow` to do both in one call, as the native
worker does.) The owner wait returns at needs_answer. It must have one final JSON line with
activity/cursor and `questionMessage` in the form
`Question <questionId>: Finish this smoke? | Options: "Yes"; "No"`. Retain the
threadId/turnId. While the question is pending and no owner wait is running,
inspect ownership and lease timestamps:

```sh
node plugins/codex/scripts/codex-companion.mjs status '<jobId>' --json
node plugins/codex/scripts/codex-companion.mjs status '<jobId>' --owner wrong-owner --json
node plugins/codex/scripts/codex-companion.mjs wait '<jobId>' --timeout-sec 1 --json
node plugins/codex/scripts/codex-companion.mjs result '<jobId>' --report --json
node plugins/codex/scripts/codex-companion.mjs status '<jobId>' --json
node plugins/codex/scripts/codex-companion.mjs wait '<jobId>' --owner '<ownerId>' --report
node plugins/codex/scripts/codex-companion.mjs status '<jobId>' --json
```

Observer calls must leave leaseExpiresAt/leaseRenewedAt unchanged. Result on an
active job reports `running` (exit 0). The owner wait must advance both
timestamps. Launch a second fresh smoke job in the same Claude session: ownerIds
must differ; passing the first owner to the second job's status must not renew it.
Cancel only that extra smoke job after recording the evidence.

For adoption acceptance, let the owner wait return normally while the smoke job
is still active, then use `/codex:status`. Stopping the attached owner interrupts
the turn and requires `task --continue` instead. Before lease expiry, and with
explicit user consent, launch a replacement `codex:codex-worker` with this
assignment (substitute handles and workspace):

```text
Adopt existing job <jobId> in <workspace>. The user explicitly consented to this
replacement worker. Run adopt first; do not submit a new task. Retain its NEW
ownerId and wait on the existing turn. Forward only the exact questionMessage.
```

The replacement's FIRST call must be adopt. The direct equivalent, which also
works before the orphan threshold, is:

```sh
node plugins/codex/scripts/codex-companion.mjs adopt '<jobId>' --json
node plugins/codex/scripts/codex-companion.mjs status '<jobId>' --owner '<oldOwnerId>' --json
node plugins/codex/scripts/codex-companion.mjs wait '<jobId>' --owner '<oldOwnerId>' --json
node plugins/codex/scripts/codex-companion.mjs wait '<jobId>' --owner '<newOwnerId>' --report
node plugins/codex/scripts/codex-companion.mjs status '<jobId>' --json
```

Expect `adopted`, a different ownerId, identical threadId/turnId and renewed lease.
Old-owner calls return `ownership_moved` (exit 2) without renewing. The new owner
continues the pending question and inherits the delivered feed cursor. For the
native workflow, send Yes to the replacement. For the direct workflow:

```sh
node plugins/codex/scripts/codex-companion.mjs answer '<jobId>' --owner '<newOwnerId>' --question '<questionId>' --json <<'DUET_SMOKE_ANSWER'
Yes
DUET_SMOKE_ANSWER
node plugins/codex/scripts/codex-companion.mjs wait '<jobId>' --owner '<newOwnerId>' --report
node plugins/codex/scripts/codex-companion.mjs adopt '<jobId>' --json
```

Repeat wait until terminal. Adoption after completion must report `job_ended`,
exit 2, with an exact continuationCommand and no new turn.

For expiry, launch a separate smoke job with a short lease (increase it if local
startup exceeds 30 seconds), wait for its question, then cease owner polling:

```sh
node plugins/codex/scripts/codex-companion.mjs task --fresh --detached --report --json --lease-sec 30 --model gpt-6-astra --effort xhigh --normal <<'DUET_EXPIRY_SMOKE'
Use ask_parent to ask "Wait for expiry?" with options Yes and No. Wait for the
answer. Do not edit files, use a browser, access secrets, or run other tools.
DUET_EXPIRY_SMOKE
node plugins/codex/scripts/codex-companion.mjs wait '<expiryJobId>' --owner '<expiryOwnerId>' --report
```

After its last renewal, use only ownerless status to observe the orphaned lease
countdown. Once more than 30 seconds has passed, run:

```sh
node plugins/codex/scripts/codex-companion.mjs status '<expiryJobId>' --json
node plugins/codex/scripts/codex-companion.mjs adopt '<expiryJobId>' --json
node plugins/codex/scripts/codex-companion.mjs result '<expiryJobId>' --report --json
```

Expect `lease_expired`, no owner rotation or new turn, interruption confirmation
when available, and the exact unexecuted `task --continue` continuation command.

For owner-loss acceptance, start a `--follow` smoke in a terminal and kill that
process with SIGTERM while Codex is still working: within about a second an
ownerless `status '<jobId>' --json` must show the job interrupted with
`interruptionReason: owner_stopped`. Repeat with SIGKILL: within about 5 s the
job must show `interruptionReason: owner_lost`. Both carry
`interruptionConfirmed: true` and the same continuation command. Running that continuation (one new turn on the same thread)
must show `duet_parent` in the thread's MCP servers and let `ask_parent` reach a
new owner `wait`.
If interruption is still in progress, poll ownerless status/result until terminal.
Do not execute the continuation as part of this smoke. Thread history and on-disk
edits should remain available. Cleanup only a smoke job you launched that is still
active and no longer needed:

```sh
node plugins/codex/scripts/codex-companion.mjs cancel '<jobId>' --json
```

No check requires stopping a live broker or unrelated worker. Socket-backed
fixture acceptance must be rerun outside the managed sandbox when binds are denied.
