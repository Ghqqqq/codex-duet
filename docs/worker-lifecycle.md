# Native worker lifecycle and protocol evidence

Duet's native Claude Agent starts one `task --detached --fresh --report --json`,
retains its handles and loops `wait`. This reuses the existing task-worker and
state artifacts. It returns after at most 1.2 seconds of handle waiting, plus
local validation/spawn work; unavailable thread/turn handles remain null until
acknowledged. It does not wait for model output before returning the job ID.

`wait <job> --timeout-sec N --json --report` accepts 1–60 seconds, default 45. It
returns the same compact report as result on completion, `needs_answer` with a
question, or a bounded progress snapshot on timeout. The native agent updates
Bash.description from the last headline, not an inferred activity. Current/recent
items omit command arguments, tool arguments, model text and outputs; command
family/test classification is shown instead of potentially secret shell text.
Paths/tool names are bounded and plan updates show counts, not free-text steps.
After forwarding a question once, use `--after-question <id> --timeout-sec 5` to
wait without immediately returning the same pending question on every poll.

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

The 180-second lease is renewed by matching-owner task/wait/status calls; detached
task-workers do not renew it. Foreground owners renew while alive. Owner ID defaults
to environment owner, Claude session ID, then local, or task --owner explicitly.
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

Live question smoke (parent only; not executed in W5):

```sh
node plugins/codex/scripts/codex-companion.mjs task --fresh --detached --report --json --owner w5-smoke --model gpt-6-astra --effort xhigh --normal <<'W5_SMOKE'
Use ask_parent to ask which fixture approach to report, with options Small and
Broad. Wait for the answer, then report it and complete. Do not edit files, open
a browser, access private content, or run other tools.
W5_SMOKE
node plugins/codex/scripts/codex-companion.mjs wait '<jobId>' --owner w5-smoke --timeout-sec 45 --json --report
node plugins/codex/scripts/codex-companion.mjs answer '<jobId>' --question '<questionId>' --json <<'W5_ANSWER'
Use Small.
W5_ANSWER
node plugins/codex/scripts/codex-companion.mjs wait '<jobId>' --owner w5-smoke --timeout-sec 45 --json --report
```

Substitute returned IDs exactly, repeating wait if startup is still running. The
thread/turn must remain unchanged across the question. For cancellation, repeat
the launch and cancel while the question is pending:

```sh
node plugins/codex/scripts/codex-companion.mjs cancel '<secondJobId>' --json
```

For lease acceptance, launch with `--lease-sec 30 --owner w5-lease`, wait for the
question once, then stop owner polling for over 30 seconds and retrieve result.
For browser acceptance, inspect `setup --list-browser-origins --json`, apply only
explicitly consented origins if necessary, and let W6's separate browser acceptance
use a fresh owned tab and cleanup. Never auto-grant after a denial. Compare the
startup timings under the already selected HTTP provider; do not infer speedup
from the earlier WebSocket trace alone.
