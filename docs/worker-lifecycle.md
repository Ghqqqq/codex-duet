# Native worker lifecycle and protocol evidence

Duet's native Claude Agent starts one `task --detached --fresh --report --json`,
retains its handles and loops `wait`. This reuses the existing task-worker and
state artifacts. It returns after at most 1.2 seconds of handle waiting, plus
local validation/spawn work; unavailable thread/turn handles remain null until
acknowledged. It does not wait for model output before returning the job ID.

`wait <job> --owner <ownerId> --report` streams a human-readable activity feed
into stdout, one flushed line per event, then ends with ONE compact JSON line.
The final line preserves the progress/report fields and adds `activity` (the
structured events in this call) and `cursor` (last consumed sequence number).
`--json` suppresses feed lines and returns only that JSON line. The default
maximum `--timeout-sec` is 30; `--min-interval-sec` defaults to 10. Both accept
1–60 seconds. New significant activity returns the call after its minimum;
timeout is always the upper bound, including when minimum exceeds timeout.
Terminal results and new parent questions return immediately. Lines stream even
before the minimum, so clients that expose live Bash output show the work now.

Activity is captured at item start/completion (completed assistant messages),
not token-by-token: assistant snippets ≤300 characters, command first lines
≤160 with exit/duration, file path/kind, MCP/dynamic server/tool/status/duration,
and plan step titles ≤80. Durations use protocol milliseconds or observed
start/completion time; missing duration/exit is explicit, never invented.
Tool arguments, command outputs, diffs, reasoning and page-content payloads are
never selected. Text is redacted **before** truncation: assignments, authorization
headers, bearer tokens, URL userinfo/query credentials, long hex/base64 blobs and
known key/JWT prefixes. Redaction is conservative and heuristic, not semantic DLP;
a model can still put sensitive prose in a message, so the prompt forbids copying
payloads into progress. Raw result artifacts keep their existing private behavior.

Redacted events and monotonically increasing sequence numbers live in job state;
`activityCursors` uses a hashed reader/owner key. Each explicit owner has an
independent cursor, and ownerless observers share a separate cursor. Reading as
an observer cannot consume the worker's feed or renew its lease. Feed cursors
advance after flushed lines; pure JSON advances after its final write. An abrupt
stop between delivery and cursor persistence may replay lines; run one wait per
owner at a time. The journal is retained with the job (no silent event dropping).
Legacy jobs without a journal return empty activity and cursor 0.

The native agent keeps Bash.description equal to the last headline and uses feed
mode. It does not paraphrase or re-print the feed. After forwarding a question
once, use `--after-question <id> --timeout-sec 5` with the same `--owner` to wait
without immediately returning that question on every poll.

## Parent questions

The installed CLI's generated experimental schema exposes dynamic tool
registration. Duet enables `initialize.capabilities.experimentalApi: true` and
registers one `ask_parent` function on new threads. Approval policy stays `never`;
there is no plan-mode switch or approval prompt. Request-user-input availability
in ordinary mode was not assumed. A valid registered tool call keeps its RPC
response pending while a private job record carries text/options/expiry. Answer
stdin supplies one inputText content item and continues the **same turn**.

Schema evidence (scratch files excluded from promotion):

| File / JSON pointer | Evidence |
| --- | --- |
| `.test-tmp/w5-schema/ClientRequest.json#/definitions/InitializeCapabilities/properties/experimentalApi` | Opt-in for experimental methods/fields. |
| `.test-tmp/w5-schema-experimental/v2/ThreadStartParams.json#/properties/dynamicTools` | Registration array; absent from the nonexperimental schema. |
| Same, `#/definitions/DynamicToolSpec/oneOf/0` | Function variant requires `type: function`, name, description, inputSchema. |
| `.test-tmp/w5-schema/ServerRequest.json#/definitions/DynamicToolCallParams` | `item/tool/call`: arguments, callId, threadId, tool, turnId; optional namespace. |
| `.test-tmp/w5-schema/DynamicToolCallResponse.json#/properties/contentItems` and `/success` | Reply requires success and contentItems; inputText variant carries text. |
| `.test-tmp/w5-schema/ServerRequest.json#/definitions/ToolRequestUserInputParams` | Alternative input request is described as experimental; not used to assume default-mode availability. |

Exact successful dynamic-tool result (original request ID retained):

```json
{"id":7,"result":{"success":true,"contentItems":[{"type":"inputText","text":"The parent's answer."}]}}
```

`needs_answer` includes a one-line `questionMessage`:
`Question <id>: <text> | Options: "First"; "Second"` (or `(none)`). Whitespace is
normalized and display secrets are redacted; the native worker must send this
field verbatim to `main` once per question. SendMessage is allowed ONLY for this
purpose: no progress, completion claims or placeholders. The final result is
only the agent's return value. Worker messages that are not verbatim questions
are not evidence; verify job/thread/turn handles, artifacts and actual changes.

Question text is bounded to 1000 characters and six options of 160 characters;
answers to 8000 characters. Neither is copied into progress logs. The worker's
contract forbids secrets/page content in questions. The default timeout is 900
seconds (`task --question-timeout-sec`), after which the same response channel
instructs conservative assumptions and final needs_input for essential missing
input. Interrupt resolves the question with stop guidance. Late/duplicate answers
fail rather than continuing a different question.

Old threads may not have the registered tool: thread/resume has no dynamicTools
field. A new-thread runtime explicitly rejecting the experimental registration
gets one registration-free thread/start fallback before any model turn; auth,
model and transport errors are preserved. Unavailable mechanisms retain the
existing final needs_input classification. Schema/fake-server behavior is verified;
real default-mode tool selection is reserved for the parent's smoke below.

## Ownership and cleanup

Each task generates a unique ownerId by default (job ID plus random UUID),
returned for detached/background and foreground tasks. `task --owner` remains an
explicit override; ambient session/owner variables never select the owner.
The Claude session ID is recorded separately as `sessionId`. Only calls with the
explicit matching `--owner` renew an unexpired lease, including wait/status/answer;
parent `/codex:status`, ownerless status/wait and all result reads never renew.
Foreground owners renew while alive; detached task-workers never renew themselves.
The default lease is 180 seconds. SessionEnd matches sessionId, falling back to
the old session-ID ownerId only for legacy jobs without sessionId. Such jobs stay
readable and can renew only with an explicit matching owner.

Claude Code 2.1.301 cannot resume a native agent stopped by the user. With the
user's explicit consent, the parent launches a replacement with the existing
jobId. Its FIRST action is `adopt <jobId> --json`, not task submission. Under one
job-state lock, adoption checks that the task is queued/running with an unexpired
lease and no cancellation, rotates to a new ownerId and renews the lease. It does
not call thread/resume or turn/start. It preserves the thread/turn, pending
question and last delivered owner's cursor. The replacement loops
`wait <jobId> --owner <newOwnerId> --report`. Retired owners get
`ownership_moved` from wait/status/answer, including an already-running wait,
and cannot renew or answer. They must stop polling and must not adopt again.
The replacement's Claude session takes over SessionEnd scoping; absent a caller
session, the original scope is preserved (including legacy session-ID owners).

`adopt` returns `adopted` and `waitCommand` on success (exit 0). It returns
`lease_expired`, `job_ended`, `interrupting` or `not_adoptable` on refusal (exit 2),
without rotating ownership or starting a turn. Expiry is checked under the lock,
even before the task-worker's next expiry tick; an expired lease cannot revive.
Refusals include an exact `continuationCommand` using `task --thread <threadId>`
in the original working directory. It intentionally starts read-only, without
inheriting runtime/write/origin grants, and is never run automatically. Wait for
pending interruption to finish before continuing. No thread handle means no
continuation command. Thread context and on-disk edits survive interruption.

Status marks running jobs orphaned after no renewal for min(65 seconds, half the
lease), with `leaseRemainingSec` and an exact `adoptCommand`. This is a stale
renewal heuristic, not proof that the native agent stopped; adoption need not
wait for this threshold. An in-flight wait can renew until it exits (at most its
configured timeout). See [stop actions and recovery](../README.md#if-a-worker-is-stopped).

This is lifecycle coordination, not an authentication boundary for local users.
Lease expiry, cancel, signals and SessionEnd trigger the worker's AbortSignal,
resolve questions and request turn/interrupt. A four-second turn deadline closes
the owned client/server; startup interruption also has a bounded client cleanup.
Confirmed cancellation requires terminal turn evidence, not the interrupt RPC ack.
Cancel returns unconfirmed (exit 2) if evidence is unavailable, including legacy
records without a control-aware worker. It does not kill a historical PID.

SessionEnd writes cancellation controls for this Claude session and waits up to
four seconds inside the hook's five-second budget, across worktrees sharing its
plugin-data root. Busy state locks are reported unconfirmed without blocking;
lease expiry remains the fallback. History remains recoverable.
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
env TMPDIR=/private/tmp npm test
npm run check-version
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
headline; actual redacted command lines, status/duration and assistant snippets
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
node plugins/codex/scripts/codex-companion.mjs wait '<jobId>' --owner '<ownerId>' --timeout-sec 30 --min-interval-sec 10 --report
```

Repeat the owner wait until needs_answer. It must have one final JSON line with
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
active job reports still running (nonzero exit). The owner wait must advance both
timestamps. Launch a second fresh smoke job in the same Claude session: ownerIds
must differ; passing the first owner to the second job's status must not renew it.
Cancel only that extra smoke job after recording the evidence.

For native stop acceptance, stop the smoke agent with `x` in its detail view,
wait for any in-flight wait to exit, then use `/codex:status`. After 65 seconds
without renewal it should show orphaned, decreasing lease seconds and an exact
adopt command. Before expiry, and with explicit user consent, launch a replacement
`codex:codex-worker` with this assignment (substitute handles and workspace):

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
when available, and the exact unexecuted `task --thread` continuation command.
If interruption is still in progress, poll ownerless status/result until terminal.
Do not execute the continuation as part of this smoke. Thread history and on-disk
edits should remain available. Cleanup only a smoke job you launched that is still
active and no longer needed:

```sh
node plugins/codex/scripts/codex-companion.mjs cancel '<jobId>' --json
```

No check requires stopping a live broker or unrelated worker. Socket-backed
fixture acceptance must be rerun outside the managed sandbox when binds are denied.
