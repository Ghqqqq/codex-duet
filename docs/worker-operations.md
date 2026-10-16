# Isolated workers in unattended workflows

Use the native `Agent` tool with `subagent_type: "codex:codex-worker"` and the
parent's foreground/background choice. Supply the objective, owned paths and
acceptance criteria. For follow-ups, supply that worker's exact thread ID. No
hand-written environment or sandbox instructions are needed in each assignment.
The worker sets Bash `dangerouslyDisableSandbox: true` on every companion call.
This affects the outer Claude Bash sandbox. Codex tasks use the plugin's configured
sandbox default (`danger-full-access` unless lowered with `setup --default-sandbox`)
and always receive `approvalPolicy: "never"`. Workers omit `--sandbox` so that this
default applies and pass `--sandbox read-only|workspace-write` only when the
parent narrows one assignment.

Parallel workers need disjoint write ownership or separate worktrees. A worker
starts one detached Codex turn and loops `wait` for progress, questions and completion.
It forwards mid-task questions to the parent with SendMessage, and does not install
software, log in, or modify settings. The `--report` prompt contract tells Codex
to proceed on conservative assumptions and report them. A question-only or
unfinished response becomes `needs_input` with its question, exit code 2, and a
saved result. Detection is heuristic; the parent still checks task acceptance.

Prerequisites must be handled before unattended execution: an installed runtime,
isolated authentication (or an independently configured provider), and Claude
permission rules allowing the companion command. Missing prerequisites are
reported as blockers. The interactive `/codex:setup` install offer and
`/codex:rescue` continuation chooser are separate user-facing paths; dynamic
workflows should invoke `codex:codex-worker` directly, not those choosers.
Codex server requests for approval/input are logged safely and receive an
unsupported-request error unless they meet the explicit origin policy or registered
ask_parent contract. Unsupported MCP elicitations instead receive nonpersistent cancel.
The runtime does not open an interactive confirmation flow.

## Browser assignments and origin approvals

Every browser assignment opens a fresh session-owned tab, retains its handle,
and closes it in cleanup on completion or failure. Never claim an existing user
tab or close an unrelated tab. An error `Tab <id> is already part of browser
session <session-id>` is a distinct `stale_browser_tab_claim` blocker; report the
full session ID and any cleanup failure. The report classifier recognizes the
full UUID form and includes `browserBlocker` with kind, tab ID and session ID.
It conservatively marks an otherwise successful turn as `needs_input`; it does
not infer that the old session is dead or release its claim.

The browser is unrestricted by default (`approval_mode = "never_ask"` mirrored
into the isolated browser runtime before every task) and every sandbox mode keeps
`networkAccess: true`, so browser assignments normally need no origin flag. For
the rare case where the user chose `setup --browser-approval ask`, the parent may
supply repeated `task --approve-browser-origin https://example.com` flags. The
worker forwards them exactly as supplied. The CLI normalizes scheme/host case and default ports,
deduplicates, and rejects paths (even `/`), queries, fragments, userinfo,
wildcards and malformed values before starting the runtime. There is no implicit
subdomain or redirect grant. Each invocation, including `--thread`, starts with
only its own flags; the flag is never added automatically after denial.

Normalized `approvedBrowserOrigins` are stored with foreground/background jobs,
task/status/result JSON and text reports, and interrupted-result recovery.
Compact reports show up to three origins with an omitted count; job metadata and
the full result retain every origin. The option does not change sandbox policy
or `approvalPolicy: never`, and never grants session-wide authority.

Only schema-defined **network-only** `item/commandExecution/requestApproval`
requests for the current thread/turn can receive `{ "decision": "accept" }`.
Commands, policy amendments, general permissions and input requests keep the
existing `-32601` reply. Unsupported MCP elicitations now receive
`{ "action": "cancel" }`, avoiding persisted denial. For explicit durable browser
consent use `setup --allow-browser-origin <origin>`; revoke with
`setup --revoke-browser-origin <origin>`, list with `setup --list-browser-origins`.
Allow merges the official global `[origins] allowed` array, removes the exact
origin from global/per-thread `denied`, and reports changed files/backups. Revoke
removes the global allow and adds a global deny. Unrelated content is preserved;
symlinks, hard-linked files, unsupported selected TOML and concurrent changes are
rejected. These commands are offline and support `--dry-run`. Workers never run
them after denial; the parent needs explicit user consent per origin. See
[browser persistence evidence](browser-approvals.md).

Each callback reaching a task is logged before its reply, with a safe method,
request ID (string IDs hashed), kind, normalized origin when available, decision
and reason (`origin-match`, `no-flag`, `origin-mismatch`, `unsupported-method`,
`malformed-request`, `not-network-only`, `turn-mismatch`, or
`unsupported-elicitation-nonpersistent`). Opaque elicitations
also record fixed allowlisted field names/types, never their payload values.
Unknown method strings are hashed. Broker callbacks go to the owning task;
another client cannot answer them. Requests with no active job or a disconnected
owner fail closed and log to broker stderr, since no job log remains available.

## Detached execution, questions and cleanup

The native worker runs ONE `task --fresh --follow --report` (Bash
`timeout: 600000`): it enqueues the detached task-worker and stays attached as
owner until the job ends, a question is pending, or the 570 s wait budget ends
(`status: running`; then `wait <job> --owner <ownerId> --report` once per
further 9.5 minutes). Scripts may still use `task --detached` plus `wait`. Feed
mode (no `--json`, what the worker uses) flushes one activity line per Codex event
as it arrives, so the agent's Bash output in Claude Code shows Codex working live,
and ends with ONE final JSON line containing the snapshot/report plus `activity`
(12 newest), `activityCount`/`activityOmitted` and `cursor`. One call streams at
most `--feed-limit` lines (default 150, `0` = unlimited) because every streamed
line also enters the agent's context; after the cap a single notice line is
printed and later events are only counted. `--json` prints the final line only. `--timeout-sec` accepts 1–3600;
early return on activity requires an explicit `--min-interval-sec`. Questions and
completion return immediately. The worker never paraphrases or re-prints the feed.

The feed selects assistant snippets (300 chars), command first lines (160 chars)
with exits/durations, file path/kind, MCP/dynamic tool names/status/durations and
plan titles (80 chars each). It never copies tool arguments, command outputs,
diffs or page payloads. Text is shown as written (ANSI escapes and control
characters stripped); there is no credential redaction, so do not put secrets/page prose in progress
messages. Events are retained in job state, with a separate cursor for each
explicit owner and one shared ownerless observer cursor. Use one wait per owner
at a time. A crash between line delivery and cursor persistence can replay a line.

`ask_parent` is registered on new threads through experimental `dynamicTools` and
on resumed threads (`--thread`, `--continue`) through a per-thread `duet_parent`
MCP bridge (`scripts/parent-bridge-mcp.mjs`) that blocks on the same job file.
On `needs_answer`, SendMessage ONLY the companion's `questionMessage` verbatim to
`main` once per question ID. That one-line field includes ID, text and options.
Never send progress, status, completion claims or placeholders; the final result
is delivered only as the native agent's return value. Parent worker messages
that are not verbatim questions are not evidence: verify with handles and artifacts.
Keep waiting with `--owner <ownerId> --after-question <id> --timeout-sec 20`, then
pass the answer on stdin to `answer <job> --owner <ownerId> --question <id> --json`.
The callback stays pending, so the reply continues the same turn. Text/options are
private job state, not progress logs; answers are removed after delivery. Default
timeout is 900 seconds (`--question-timeout-sec`); on timeout Codex receives
conservative-assumption guidance. Runtimes that reject both registrations keep
final needs_input.

Leases default to 180 seconds (`--lease-sec`, or CODEX_COMPANION_LEASE_SEC).
Every task generates a unique job-based ownerId unless `task --owner` is explicit;
ambient owner/session variables never choose it. Session ID is stored separately
for SessionEnd. The worker must pass `--owner <ownerId>` on every wait/status/answer.
Only an explicit match renews an unexpired lease. Parent `/codex:status`, status,
result and ownerless wait do not renew. Foreground tasks renew while their owning
process runs; detached workers cannot renew themselves. Legacy records without
sessionId remain readable and SessionEnd falls back to their session-ID ownerId.

An attached owner wait heartbeats once a second (`ownerAttached`, lease renewal)
and marks itself detached on SIGINT/SIGTERM/SIGHUP, parent-PID change or closed
stdout. When the user stops the native agent, the task-worker sees that mark at
its next 250 ms tick and interrupts the turn immediately with
`interruptionReason: owner_stopped`. An owner that dies without a mark (SIGKILL,
crash) is detected by its silent heartbeat after the grace period (5 s,
`CODEX_COMPANION_OWNER_GRACE_SEC`) as `owner_lost`. Both are confirmed like any
other interruption. A normal return followed by silence still falls back to
lease expiry.

A stopped native agent cannot resume in Claude Code 2.1.301. Every interrupted or
failed report carries `continuationCommand`:
`task --continue <jobId> --cwd <cwd> --follow --report --json`, which starts ONE
new turn on the same thread with the job's recorded sandbox/write, model, effort,
speed and approved origins (it rejects flags it inherits and refuses active jobs).
With the user's explicit consent the parent runs it through a new worker; it is
never run automatically. For a job that is still running, a replacement worker's
FIRST action is `adopt <jobId> --json`, which atomically rotates ownerId and
renews the unexpired lease without starting a turn; it then runs
`wait <jobId> --owner <newOwnerId> --report`. The replacement inherits
thread/turn, pending question and delivered activity cursor. Old wait/status/answer
calls return `ownership_moved` (exit 2) without renewing or answering. Adoption
moves SessionEnd scope to the caller's Claude session when available.

Adoption after expiry or completion returns `lease_expired` or `job_ended`
(exit 2) with the same `continuationCommand`, and never runs it. Cancellation in
progress also refuses adoption. Wait for pending interruption to finish before
continuing. Thread context and on-disk edits persist; missing thread handles
preclude a continuation command. `/codex:status` shows orphaned running jobs,
remaining seconds and an exact adopt instruction after no renewal for min(65
seconds, half the lease). See [stop actions and recovery](../README.md#if-a-worker-is-stopped).

The lease is lifecycle coordination, not authentication against local processes.
Expiry, cancel, SessionEnd and SIGTERM/SIGHUP/SIGINT resolve pending questions,
send interruption and bound the wait for completion. `cancel` waits up to six
seconds and reports `confirmed` only after terminal turn/result evidence,
otherwise `unconfirmed` (exit 2). A legacy record without a live control-aware
worker is not killed by stored PID. SessionEnd requests only its session's jobs
across worktrees under the same state root (`<isolated-home>/duet/state`). Busy state locks are reported
as unconfirmed without exceeding the hook budget; lease expiry is the fallback.
It avoids shutting down a broker shared by other sessions. Broker disconnects
interrupt the lost owner's turn; a four-second failure deadline closes that owned
server group.

SessionStart launches prewarm detached. A broker with no clients/active turns
exits after 60 seconds (CODEX_COMPANION_BROKER_IDLE_SEC). Shutdown reaps its owned
app-server process group. No process-name scan or historical PID kill is used.
See [schema details, test isolation, limitations and acceptance commands](worker-lifecycle.md).

Startup timing fields are milliseconds: duration for connection/initialization/
thread/turn operations, elapsed from task runtime entry for first model/tool/MCP
observations. A reused broker reports its original initialization duration plus
this client's handshake. MCP ready means the first observed ready notification,
not proof that every server is ready; null means unobserved. Progress and final
reports include a WebSocket retry/fallback warning when observed on stderr.
`setup --transport http|websocket|status` is an explicit offline action; it preserves
the selected named ChatGPT provider block, takes a timestamped backup before writes,
and does not change defaults or claim a measured speedup. Restart after an actual
configuration change, once other live work has finished.

## Sandbox and permissions

The runtime requires network access and local sockets. `auth.status: unreachable`
with reason `timeout`, `network`, `socket` or `sandbox-or-permission` means the
probe failed; `loggedIn: false` alone does not establish that login is missing.
Only `unauthenticated` leads to the exact isolated login command. For unreachable:

> Codex authentication could not be checked. Rerun the companion with Bash dangerouslyDisableSandbox: true, or allow network access and local sockets, then rerun setup --json. Do not log in again for this transport failure.

Workers retry once outside the Bash sandbox. If a task already printed a handle,
the retry uses status/result recovery, never blind resubmission. A script cannot
disable the caller's sandbox itself; the Bash tool parameter is set by the agent.
If policy forbids that parameter, the worker returns the permission blocker.

### Deliberate Codex sandbox opt-in

Persist a default for all workspaces sharing this isolated home:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" setup --default-sandbox workspace-write --dry-run --json
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" setup --default-sandbox workspace-write --json
```

The accepted values are `read-only`, `workspace-write`, and `danger-full-access`.
The setting is `default_sandbox` in `<isolated-home>/duet/config.toml`
(`~/.claude/codex-isolated/duet/config.toml` by default), so a terminal and a
Claude session always read the same value. Writes merge with a private backup;
dry-run is offline. `setup --json` reports `defaultSandbox`. The built-in default
is `danger-full-access`: workers get the same permission level as the user's own
Codex app in full-access mode, and the sandbox reaches both thread and turn
policies, including detached tasks/resumes. The parent adjusts one call with
`task --sandbox <mode>` in either direction; no other flag is needed. `--write`
alone is a floor (at least workspace-write, never narrowing a broader default) and
`--write=false` selects read-only; `--write --sandbox read-only` is rejected.
Review commands keep their separate read-only behavior.

For an assignment that must not touch anything, the parent narrows one call:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task --fresh --sandbox read-only --report --json 'Investigate and report; change nothing.'
```

Never choose elevation automatically on an EPERM or browser failure when the
parent narrowed a call; return the denial to the parent.
Without per-call flags, the configured default applies. Every thread resume explicitly
sets this invocation's sandbox, preventing inheritance from a prior elevated task.
Background jobs persist the requested policy before starting. Completed JSON/report
output includes `sandbox` and `approvalPolicy`; full results include `sandboxPolicy`.

The local generated v2 protocol supports `ThreadStartParams.sandbox`,
`ThreadResumeParams.sandbox`, `TurnStartParams.sandboxPolicy` and
`TurnStartParams.approvalPolicy`. `SandboxPolicy` uses the tagged variants
`readOnly`, `workspaceWrite`, and `dangerFullAccess`. The companion sets the thread
policy, verifies the returned mode, and forwards the acknowledged policy to
`turn/start` for explicit opt-ins, retaining the runtime's roots/network defaults.
Approval policy is fixed to `never`; no new approval prompt is introduced.

Full access removes Codex's own filesystem sandbox for that task. Isolated home
routing and overlap checks remain active, but this option does not restrict the
task to owned paths or override an enclosing OS/managed sandbox. The parent must
still supply scope and restrictions. If outer policy forbids Git/browser access,
the parent runs those steps in its authorized environment. Actual Git commits
and Chromium launch with this flag have not been exercised by fixture tests.

Optional settings example (documentation only). Replace the absolute plugin path
with the installed plugin's actual `plugins/codex` directory. Merge these entries
into existing arrays; do not replace unrelated settings:

```json
{
  "sandbox": {
    "excludedCommands": [
      "node /absolute/path/to/codex-plugin-isolated/plugins/codex/scripts/codex-companion.mjs"
    ]
  },
  "permissions": {
    "allow": [
      "Bash(node /absolute/path/to/codex-plugin-isolated/plugins/codex/scripts/codex-companion.mjs *)"
    ]
  }
}
```

Place `sandbox.excludedCommands` in **`~/.claude/settings.json`**. Project-level
entries can be ignored. Exclusions have also reportedly failed to take effect
in some installations; this behavior was reported, not reproduced by these
fixture tests. `dangerouslyDisableSandbox: true` remains the worker default.
The allow rule must match the actual command spelling/path. Existing deny rules
or managed policy can still prevent unattended execution. Do not add broad
`Bash(node:*)` permissions just for this integration.

## Optional tool configuration sync

Run these commands outside the Bash sandbox (or through `/codex:setup`):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" setup --sync-tools --dry-run --json
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" setup --sync-tools --json
```

The preview is offline and makes no writes or Codex calls. It returns toolSync,
not an authentication report. The source is the normal `config.toml` selected by
`CODEX_COMPANION_NORMAL_HOME`, then `CODEX_HOME`, then `~/.codex`. Missing CUA also
uses the installed unified-computer-use template and ChatGPT app resources (below).
The destination
is the isolated home. Home overlap, config symlinks and shared config inodes are
rejected before writing. The source is read-only; credentials, provider/auth
configuration, remote marketplace URLs, arbitrary MCP servers and unrelated
plugins are never imported.

The default `chrome` profile adds missing sections only and leaves existing sections byte-for-byte,
including existing node_repl/CUA servers and their separate env tables. Presence
preserves even disabled/incomplete CUA definitions; sync does not repair them.
`toolSync.append` contains the exact added text, including separating newlines,
without echoing the destination's existing contents. It creates a
timestamped private backup of an existing destination config before the first
change and writes atomically under an exclusive sync lock. Repeated runs are
no-ops. A new config has no prior file to back up. If a process is killed during
sync, inspect and remove its stale `config.toml.sync-lock` before retrying.

Portable sections:

- Local marketplaces (source/source_type or local source table and path).
- Only the `enabled` flag for `browser@openai-bundled`, `chrome@openai-bundled`,
  `computer-use@openai-bundled`, and `unified-computer-use@openai-bundled`.
- `mcp_servers.node_repl`: safe executable/path args, enabled/startup/tool timeout
  fields and exactly the following env names. Other env keys appear in `skipped`
  without their values:

```text
NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS
NODE_REPL_NODE_MODULE_DIRS
NODE_REPL_NODE_PATH
NODE_REPL_TRUSTED_CODE_PATHS
CODEX_HOME
BROWSER_USE_AVAILABLE_BACKENDS
BROWSER_USE_TINYSKY_ENABLED
NODE_REPL_INSTRUCTIONS_USE_CASE_BROWSER
NODE_REPL_INSTRUCTIONS_USE_CASE_CHROME
NODE_REPL_INSTRUCTIONS_USE_CASE_COMPUTER_USE
BROWSER_USE_CODEX_APP_BUILD_FLAVOR
BROWSER_USE_CODEX_APP_VERSION
NODE_REPL_TRUSTED_SERVICES
SKY_CUA_SERVICE_PATH
CODEX_CLI_PATH
```

CODEX_HOME is rewritten to the isolated home. The colon-separated trusted code
paths include that home and preserve the app modules and normal plugin cache.
NODE_REPL_TRUSTED_SERVICES JSON and executable paths remain unchanged. These are
shared code sources; sync neither copies nor modifies their files. The config
reader supports ordinary quoted/bare dotted keys, basic/literal strings,
booleans, integers, arrays and inline tables for selected settings; unsupported
selected syntax fails closed. Unrelated configuration text is preserved.

`setup --json` reports tools.browser, tools.computerUse and tools.nodeRepl as
available/missing/unknown **based on configuration only**. It does not verify
installed assets, extension connectivity or tool execution. Restart the Claude
session/shared Codex runtime after a sync to load the configuration.

### Codex App profile

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" setup --sync-tools --profile codex-app --dry-run --json
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" setup --sync-tools --profile codex-app --replace-cua --json
```

This explicit profile reads the newest numeric version with a `.mcp.json` under
the normal Codex home's `plugins/cache/openai-bundled/unified-computer-use`.
`--cua-template /absolute/.mcp.json` overrides discovery. There is no fallback to
the app's disabled placeholder template, and `--chatgpt-resources` is rejected:
the cache entry must already contain resolved executable/launcher paths.

The server is mirrored semantically, preserving launch paths, enabled state,
tool order/visibility, nested `tools.js.output_token_limit`, empty `env_vars`,
startup/tool timeouts if present, every supported env entry and instruction
string. Only `CODEX_HOME` and home entries in `NODE_REPL_TRUSTED_CODE_PATHS` change
to the isolated home. Installed module/cache paths and `SKY_CUA_SERVICE_PATH`
remain shared code/service paths; no assets or credentials are copied. The
current template has no `tool_timeout_sec`, so replacement removes a stale 30 s
timeout. Unknown fields, nonempty env forwarding and credential fields fail
closed instead of being silently imported. Future template schema additions may
require a Duet update. Sync never executes the template.

An identical existing server is a no-op. A different server is refused before
any write unless `--replace-cua` is present. Dry-run works without replacement
authorization: `toolSync.diff` shows changed top-level fields and exact proposed
values, with existing values redacted; `requiresReplace` signals the refusal on
apply. `append` is the proposed appended text; during replacement the old CUA
block is removed first, including its env/tool subtables. Unrelated text stays
byte-exact. Closed inline parents require conversion to ordinary TOML tables.
Replacements share the existing exclusive lock, atomic write and private backup.
`surfaces` and `backends` report the proposed/resulting configuration.

The usual result is browser + computer, with chrome/iab/mcpapps and the Sky
service. Desktop permissions belong to Codex Computer Use.app. Availability is
configuration evidence only: setup does not grant Accessibility/Screen Recording
or open a desktop/browser session. Combined with the full-access sandbox default
and the unrestricted browser default, this permits full disk write, desktop
control, and any website through the user's logged-in browser. Lower either
default with `setup --default-sandbox` / `setup --browser-approval ask`; see
[browser approval settings](browser-approvals.md#all-sites-browser-approval-the-default).

### Modern CUA registration (default Chrome profile)

Missing `mcp_servers.cua_repl` is rebuilt from the bundled
`unified-computer-use/.mcp.json`. The app's disabled `command = "node"` placeholder
is resolved into its actual node, CUA launcher, node_repl, browser service and CLI
paths; all five files must exist and the three executables must be executable.
The launcher loads the official dynamic tool instructions. No session state or
instruction strings are imported. Chrome/browser is the only newly enabled
surface; IAB, MCP Apps and native computer control need separate verification.

Discovery first checks resources inferred from the source node_repl executable,
then `/Applications/ChatGPT.app/Contents/Resources` and the user's `Applications`
directory. It prefers their bundled template, then installed
`plugins/cache/openai-bundled/unified-computer-use/<version>/.mcp.json` (newest
numeric version first), then `.tmp/bundled-marketplaces/openai-bundled` under the
normal home. An injected template's command can locate relocated app resources.
The resolver validates the known installed layout; it does not execute templates
or install missing assets. Unsupported layouts fail with instructions.

Optional selectors, both requiring `--sync-tools`:

```text
--cua-template /absolute/path/to/.mcp.json
--chatgpt-resources /absolute/ChatGPT.app/Contents/Resources
```

An explicit template is authoritative. An explicit resource directory disables
fallback to other apps/caches, including when its template or assets are missing.
Without `--replace-cua`, existing CUA is detected before any template/resource lookup, so re-running sync
needs no app discovery for that server. Resource failure aborts the whole sync
before even planned node_repl additions are written.

CUA's setting allowlist is `command`, `args`, `enabled`, `enabled_tools`,
`omit_tools_from`, `startup_timeout_sec`, `tool_timeout_sec`. Launch paths are
rebuilt, enabled is true, tools must be exactly `js`, `js_reset`, `turn_ended`, and
the template must specify `code_mode`, `deferred` visibility exclusions. Positive
integer timeouts up to 600 seconds are accepted (defaults 120/30 when absent).
Nested `tools` overrides, env forwarding, headers and arbitrary arguments are
excluded. CUA's env allowlist is:

```text
CODEX_HOME
CUA_REPL_NODE_REPL_PATH
CUA_REPL_ENABLED_SURFACES
NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS
NODE_REPL_NODE_MODULE_DIRS
NODE_REPL_NODE_PATH
NODE_REPL_TRUSTED_CODE_PATHS
NODE_REPL_TRUSTED_SERVICES
BROWSER_USE_AVAILABLE_BACKENDS
BROWSER_USE_TINYSKY_ENABLED
BROWSER_USE_CODEX_APP_BUILD_FLAVOR
BROWSER_USE_CODEX_APP_VERSION
CODEX_CLI_PATH
```

Homes, executable/module paths, services and surfaces are reconstructed, never
copied verbatim. Trusted paths contain only the isolated home and app modules.
The native-pipe timeout accepts decimal 1–10000, Tinysky accepts `0`/`1`, flavor
accepts `prod`/`beta`/`alpha`/`dev`, and version accepts a bounded dotted numeric
string. Invalid optional env values are discarded. XML Info.plist version and
the production bundle identifier supply app metadata when available. Other home,
auth, token, identity, IPC, backend, instruction and session keys are excluded.
`CUA_SETTING_KEYS`/`CUA_ENV_KEYS` in `cua-config.mjs` enumerate this boundary;
legacy node_repl handling above is unchanged.

`tools.cuaRepl` and browser/computer availability recognize direct CUA entries,
still as configuration-only evidence. A closed TOML inline parent that would
need extending is rejected, since appending a child table would be invalid TOML.

The recorded 120-second pre-tool delay was primarily inference WebSocket retries,
not MCP startup. See [the measurements and transport workaround](cua-delay-investigation.md)
and the [README](../README.md#delay-before-the-first-tool-call).

## Results, progress and recovery

Native workers use `task --report --json`. This retains legacy full-output task
and result behavior when `--report` is omitted. The compact report includes
status, jobId, threadId, turnId, the sandbox and approval policy, the `model`,
`effort` and `serviceTier` the runtime actually used (from the thread-start or
thread-resume response, overridden by per-call flags; the request's values when
the runtime reported none), touched files, command verification evidence,
Codex-reported findings, blockers and output paths, targeting at most 60 lines.
`task --json`, `wait --report` and `result --report` carry the same three fields.
`touchedFiles` combines turn file-change events with before/after SHA-256 content,
executable-mode and Git-index comparisons. All tracked and nonignored untracked
files are sampled, including files dirty before the turn, so shell writes and
edits committed during the turn are visible. `preExistingChanges` is recorded
separately. Reports truncate path arrays with omitted counts; full arrays are
saved in the result artifact. Snapshots read file/symlink metadata without following
external symlink targets and do not traverse submodule contents or ignored files.
Non-Git/unreadable snapshots are marked partial and fall back to available events.
Concurrent edits can appear in the comparison; a snapshot cannot prove which
worker caused them. An edit reverted before the final snapshot is visible only
if the server emitted a file-change event.
The progress log excludes model message/reasoning bodies, command arguments and tool outputs.
The full final text is in `<job-id>.output.txt`; the raw result, command events
and reasoning summaries are in `<job-id>.result.json`. Progress/messages are in
`<job-id>.log`. These live beside the job record in the isolated home,
`<isolated-home>/duet/state/<workspace-slug>-<hash>/jobs/`
(`~/.claude/codex-isolated/duet/state/…` by default; directories `0700`, files
`0600`), the same place for a terminal, a Claude session and the SessionEnd
hook. `CLAUDE_PLUGIN_DATA` and the temp dir no longer decide the location. The
latest 50 finished jobs per workspace are retained.

Releases before 1.0.6-isolated.15 wrote the same layout under
`CLAUDE_PLUGIN_DATA/state` (`~/.claude/plugins/data/codex-codex-isolated-local`
or `…/codex-duet`, depending on the plugin ID at the time) or, outside Claude,
under `$TMPDIR/codex-companion-isolated`. The first command touching a workspace
merges whatever exists there into the new directory, under the new directory's
lock: existing jobs are not overwritten, the newer `updatedAt` wins for an ID
present on both sides, the index is deduplicated, recorded absolute artifact
paths stay as they are (readable in place), the legacy directories are left
alone, and a marker (`.legacy-migration.json`, listing each merged source) makes
the merge idempotent across concurrent first commands. A legacy job whose
worker is still alive is served from its legacy directory (listed, `wait`-able,
cancellable through its record) and merged once that worker exits. A busy
legacy lock is retried later. Lookups by job ID, ID prefix or `--thread` that
miss in the new directory search the legacy directories and import the match.

Job ID and log/output paths are persisted and printed on stderr before execution;
thread and turn IDs are persisted as soon as the server returns them. Progress
events and a 15-second heartbeat go to stderr and the job log even in JSON mode.
Heartbeats show item/tool counts, elapsed time and last notification age. No
notifications during a long tool call means silence, not proof of a hang. Stdout
for task/result remains a single final JSON document; wait in feed mode streams
lines before its final JSON line (`--json` suppresses them). A native Bash output
file may combine stdout with stderr, so use `result --report --json` for clean retrieval if needed.

After interruption, retrieve in the original workspace:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" status '<job-id>' --json
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" status '<job-id>' --wait --timeout-ms 30000 --json
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" result '<job-id>' --report --json
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" result --thread '<thread-id>' --report --json
```

Explicit references work across Claude session IDs. `--thread` selects the most
recently created tracked job on that thread, so prefer the job ID for an older
turn. A dead wrapper with a complete thread/turn handle is recovered through
read-only `thread/read`, never `thread/resume` or `turn/start`. Finished results
are saved locally; a running turn is reported for further polling. A missing
turn handle, unavailable runtime or absent server history is reported as
unknown/unreachable. No automatic rerun is safe in that case. `task --thread`
starts another turn; reserve it for an explicit follow-up after recovery.
If interruption lost the end-of-turn snapshot, recovery uses only the exact
turn's persisted file-change events and marks file coverage partial. It preserves
the saved pre-existing path list and policy, and never compares an old baseline
against a later workspace that other tasks might have changed.

## Browser timeout diagnostics (manual)

No `--check-browser` probe is provided: a companion-level connection cannot
safely infer extension approval/session ownership or drive an already running
node REPL. Sync and setup never open tabs or control a browser.

When `agent.browsers.list()` sees Chrome but `browser.user.openTabs()` times out,
the following are possibilities, not confirmed causes:

1. Check Chrome and the extension UI for a pending connection/approval prompt.
   Browser enumeration alone does not establish that user-browser calls were approved.
2. Check whether another Codex/REPL session owns the extension connection. Finish
   or disconnect that session through its normal UI, then connect from the intended
   isolated session; do not kill unrelated workers.
3. Check whether the failure is the REPL's reported 30-second evaluation limit
   or a browser transport timeout. After resolving approval/session ownership,
   use the tool's documented timeout option if available; do not assume extending
   a REPL timeout fixes a missing connection.
4. Confirm setup's config-only tool status, the saved node_repl startup errors,
   and network/socket access outside Claude's Bash sandbox. Reload/restart the
   relevant runtime after configuration changes.
