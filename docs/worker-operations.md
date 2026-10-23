# Isolated workers in unattended workflows

Prefer `Agent(subagent_type: "codex:codex-native")` when available; otherwise
use `duet task` in background Bash. Supply objective, owned paths, constraints
and acceptance criteria with the [brief template](../plugins/codex/prompts/ultra-codex-protocol.md#writing-a-brief-every-codex-assignment).
The completion notification carries the report. Only if it is missing, run
`duet result <worker>`; do not parse output files or poll.

## Direct mode

Dispatch one Bash call per job with `run_in_background: true` and
`description: "Codex: <label>"`. When Claude's Bash sandbox is on, set
`dangerouslyDisableSandbox: true`: the runtime needs network and local sockets.
The plugin adds `bin/duet` to PATH; SessionStart supplies the session ID and
invocation guidance. Older sessions may need a reload/new session or the absolute
launcher path.

```bash
duet task --model gpt-6-astra --effort xhigh --normal <<'DUET_TASK'
<brief>
DUET_TASK
```

Use stdin only, single-quoted arguments and `DUET_TASK`/`DUET_ANSWER` heredocs
whose delimiters do not occur as complete lines in the text. The permission hook
recognizes a narrow grammar; double quotes, pipes, compound commands, sandbox
bypass and unsupported flags fall back to normal permissions. Investigators add
`--sandbox read-only`; other checkouts use `--cwd '<dir>'`. Parallel writers need
disjoint OWNED PATHS or separate worktrees.

`duet task`/`wait`/`answer` imply `--direct`. The owner wait prints progress in
`/tasks`, then report v2 when the job ends, asks a question or reaches its wait
budget. The report is attached to the completion notification; `--quiet` suppresses
progress. The wait budget defaults to 3600 s (maximum 3600) and the owner lease
to 1800 s. Direct mode conflicts with `--follow`, `--detached`, `--background`,
`--json`, `--feed-limit` and `--min-interval-sec`.

- Terminal: apply the [acceptance protocol](../plugins/codex/prompts/ultra-codex-protocol.md#accepting-a-result-every-worker-report-no-exceptions)
  even on nonzero exit. Use `duet result <worker> --details` for full evidence,
  handles, runtime settings and artifact paths. Read `rawOutputFile` only if
  report fields are insufficient.
- `running`: background `duet wait <worker>` and wait for its notification.
- `needs_answer`: background ONE `duet answer <worker>` with stdin via a
  single-quoted `DUET_ANSWER` heredoc (`timeout: 600000`). It resolves the owner
  and question, submits once and waits on the same turn. Never start a second
  wait. Answer from your context when the brief should have covered it; otherwise
  collect the user's decision. A Computer Use approval has four fixed options;
  forward with `AskUserQuestion` unless the app was pre-authorised. Use
  `--details` if the compact question/options were shortened.
- `ownership_moved`: report it; do not reuse the retired owner or re-adopt.
- `error`: check `duet status` before resubmitting; a runtime failure may occur
  after dispatch. `owner_stopped` means the wait was stopped and the turn interrupted.

Exit codes are 0 for `completed`, 2 for `blocked`/`needs_input`, 1 for other
terminal states, 0 for `running`/`needs_answer`, 2 for `ownership_moved`, and 130
for a stopped owner wait. Never run two waits for one job.

Follow up with `duet task --to <worker>` and a new brief. It keeps the worker's
cwd/thread and inherits recorded model, effort, sandbox, speed and request grants;
explicit flags override them. `--thread` also inherits recorded settings. Repeat
`--sandbox read-only` for a read-only follow-up and `--normal` to reset fast mode.
Use a job ID for an older turn, never “latest thread” for parallel work.

`duet task --fork` explicitly imports the current Claude transcript into a new
thread before running the stdin brief. It is labelled “imported Claude
conversation (fidelity not verified)”; the default 20 MiB limit is set by
`CODEX_COMPANION_IMPORT_MAX_BYTES`. `--source '<jsonl>'` overrides the source.
It cannot combine with `--to`, `--thread`, `--continue` or resume flags.

Native agents take an optional first line `DUET: <flags>` (`--model`, `--effort`,
`--sandbox`, `--fast`/`--normal`, `--cwd`, `--fork`). Use SendMessage to their
Claude agent name for follow-ups and answers; they handle waits themselves.
Stop active native tasks from `/tasks`. A parked question may not cancel when
its already-ended agent row is stopped; use `duet cancel <worker>` or the default
900 s question timeout applies. Missing hooks yield a blocked report; check
`duet status` before retrying. See [direct mode](direct-mode.md).

The read-only `codex-live` pane shows prompts, messages, commands, file changes,
tool calls, plans and pending questions. Resolved `ask_parent` calls show answers
matched by call ID. Codex 0.146.0 does not pass a call ID to custom MCP servers on
resumed threads, so those answers are not shown. New jobs request a pane;
`/codex-live` opens it at any width. It never starts, answers or cancels jobs and
costs no Claude tokens.

## Haiku fallback and shared rules

Use `Agent(subagent_type: "codex:codex-worker")` only when native dispatch and
background Bash are unavailable, or the user asks for a forwarding-agent
transcript. It stays Haiku with low effort, `omitClaudeMd: true` and
`autoCompactWindow: 100000`; put Codex's model/effort in the brief, not Agent
fields. A NEW fallback agent follows up with `duet task --to <worker>`;
SendMessage to an existing fallback only answers its pending question. It
returns report v2 verbatim plus at most five lines of notes for stderr, retries
or a relayed question.

Codex tasks use the plugin's configured sandbox default (`danger-full-access`
unless lowered with `setup --default-sandbox`). Owned jobs (including `--direct`,
detached, `--background`, `--follow`) run with the granular approval policy
`never+elicitations`: command, sandbox, rule, skill and permission prompts are
rejected as under `never`, and MCP elicitations are forwarded so a Computer Use
app request becomes a question for the parent. A compatibility non-direct companion task keeps `never`. Omit `--sandbox` for the configured default; narrow investigators and
reviewers with `--sandbox read-only`, or use `--sandbox workspace-write` when the
assignment requires it. Never elevate after a denial.

Claude's loaded CLAUDE.md/rules are forwarded automatically through
`developerInstructions`, with an explicitly approximate startup scan when the
loaded inventory is unavailable. Existing threads retain their original
instructions. Opt out on a fresh task with `--no-claude-md` or
`CODEX_COMPANION_CLAUDE_MD=0`. This is separate from Codex discovering `AGENTS.md`
and Duet's `project_doc_fallback_filenames = ["CLAUDE.md"]` default in the
isolated config. `duet setup --project-docs agents-only` removes only that exact
fallback list, leaving custom lists unchanged. See [configuration](configuration.md#claude-instructions-and-conversation-imports).

Parallel workers need disjoint write ownership or separate worktrees. Direct
mode handles questions in the main agent; the fallback relays them with
SendMessage. The fallback does not install software, log in or modify settings.
The structured report prompt contract (`--direct`, or `--report`) tells Codex
to proceed on conservative assumptions and report them. A question-only or
unfinished response becomes `needs_input` with its question, exit code 2, and a
saved result. A turn that hit a known runtime refusal (a Computer Use app the
runtime has not approved, a browser tab left with `Debugger unattached`, a stale
tab claim) or whose final answer declares itself blocked becomes `blocked`, also
exit code 2, with `blockers` (`code`, `message` in v2; app/tab/session/cleanup details under
`--details`). Detection is heuristic; the parent still checks task acceptance.

Prerequisites must be handled before unattended execution: an installed runtime,
isolated authentication (or an independently configured provider), and Claude
permission rules allowing the companion command. Missing prerequisites are
reported as blockers. The interactive `/codex:setup` install offer and
`/codex:rescue` continuation chooser are separate user-facing paths; dynamic
workflows should use the native agent or `duet task`, with `codex:codex-worker` only as fallback,
not those choosers.
Codex server requests for approval/input are logged safely. Supported Computer Use
approvals reach the parent on owned jobs; the explicit origin policy and registered
ask_parent contract also apply. Other requests receive an unsupported-request error;
unsupported MCP elicitations receive nonpersistent cancel.

## Browser assignments and origin approvals

Every browser assignment opens a fresh session-owned tab, retains its handle,
and closes it in cleanup on completion or failure. Never claim an existing user
tab or close an unrelated tab. An error `Tab <id> is already part of browser
session <session-id>` is a distinct `stale_browser_tab_claim` blocker; report the
full session ID and any cleanup failure. The report classifier recognizes the
full UUID form and includes `browserBlocker` with kind, tab ID and session ID.
It conservatively marks an otherwise successful turn as `blocked`; it does
not infer that the old session is dead or release its claim. A tab the worker
could not inspect or close because of `Debugger unattached` is reported as
`browser_tab_debugger_unattached` with `tabId`, `sessionId` and `closed`.

The browser is unrestricted by default (`approval_mode = "never_ask"` mirrored
into the isolated browser runtime before every task) and every sandbox mode keeps
`networkAccess: true`, so browser assignments normally need no origin flag. For
the rare case where the user chose `setup --browser-approval ask`, a browser-tool
origin needs `setup --allow-browser-origin https://example.com`, an explicit persistent
grant. `task --approve-browser-origin` covers only supported network-egress approvals.
The worker forwards supplied flags exactly. The CLI normalizes scheme/host case and default ports,
deduplicates, and rejects paths (even `/`), queries, fragments, userinfo,
wildcards and malformed values before starting the runtime. There is no implicit
subdomain or redirect grant. Fresh tasks use their own approval flags. `--to`/`--thread` inherit recorded
origin and app request grants unless explicitly overridden; `--continue` inherits
the selected job's recorded grants. The flag is never added automatically after denial.

Normalized `approvedBrowserOrigins` are stored with foreground/background jobs,
task/status/result JSON and text reports, and interrupted-result recovery.
The details report shows up to three origins with an omitted count; job metadata
and the result artifact retain every origin. Report v2 omits these settings. The option does not change sandbox policy
or the job's approval policy, and never grants session-wide authority.

## Computer Use app approvals

Computer Use (driving a macOS app) is approved per app by node_repl's persisted
state under `<isolated home>/computer-use/`, or at run time by the parent when an
owned job forwards the request (`approvalPolicy: never+elicitations`; see
below). By default every task mirrors the apps
the user marked "Always" in their own Codex app (`~/.codex/computer-use/config.toml`
`[apps] allowed`, read-only; session-level and denied apps are never copied) into
the isolated file before Codex starts. The user switches with
`setup --computer-use-approval ask|mirror`, adjusts individual apps with
`setup --allow-computer-app|--revoke-computer-app <bundle id>` and inspects with
`setup --list-computer-apps --json`; workers never run setup. The parent may pass
repeated `task --approve-computer-app <bundle id>` flags for one call: the apps are
granted to the job's own thread only while the turn runs, and a forwarded
elicitation is accepted only for an exact bundle-id match on the current turn
without persistence. `--to`/`--thread` inherit recorded request grants unless overridden;
`--continue` inherits the selected job's grants. On an owned job, an app that no list or flag covers pauses the tool
call and reaches the parent as a pending question (`question.kind: "approval"`,
options `Allow this call` / `Allow for this task` / `Allow always (isolated
Codex home)` / `Deny`); in direct mode the main agent handles it via
`duet answer <worker>` with a `DUET_ANSWER` heredoc; native agents use
SendMessage, and the fallback relays the question and submits the parent's choice.
"This task" writes the thread's session file for the rest of the turn; "always"
adds an explicit entry to the isolated home's allow list; everything else
cancels the request. An unapproved app is reported as `status: blocked` with
`computer_use_app_not_approved` and the app name,
never as `completed`. Details: [Computer Use approvals](computer-use-approvals.md).

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

The Haiku fallback runs one foreground `duet task --timeout-sec 570` with Bash
`timeout: 600000`, followed by `duet wait <worker> --timeout-sec 570` on `running`.
It uses the same direct progress/report format. The companion's legacy
`--follow --report` feed and `--detached`/`--background` modes remain available
for compatibility; the launcher always adds `--direct` to task/wait/answer.

`ask_parent` is registered on new threads through experimental `dynamicTools` and
on resumed threads (`--to`, `--thread`, `--continue`) through a per-thread `duet_parent`
MCP bridge (`scripts/parent-bridge-mcp.mjs`) that blocks on the same job file.
In the fallback, on `needs_answer`, SendMessage ONLY the companion's
`questionMessage` from `duet result <worker> --details` verbatim to `main` once per question ID. That one-line field includes ID, text and options.
Never send progress, status, completion claims or placeholders; the final result
is delivered only as the fallback agent's return value. Parent worker messages
that are not verbatim questions are not evidence: verify with handles and artifacts.
Keep waiting with `duet wait <worker> --after-question '<id>' --timeout-sec 20`,
then submit the answer with `duet answer <worker> --timeout-sec 570` via a
single-quoted `DUET_ANSWER` heredoc; it keeps waiting after submission.
The callback stays pending, so the reply continues the same turn. Text/options are
private job state, not progress logs. Resolved questions are retained in
`questionHistory` (newest 20, answers capped at 2000 characters) with call IDs and
resolution; approvals without call IDs cannot be matched into the pane. Default
timeout is 900 seconds (`--question-timeout-sec`); on timeout Codex receives
conservative-assumption guidance. Runtimes that reject both registrations keep
final needs_input.

Leases default to 1800 seconds in direct mode, 180 seconds otherwise
(`--lease-sec`, or CODEX_COMPANION_LEASE_SEC).
Every task generates a unique job-based ownerId unless `task --owner` is explicit;
ambient owner/session variables never choose it. Session ID is stored separately
for SessionEnd. The launcher resolves the owner for `duet wait`/`answer`; explicit `--owner`
handles remain supported. Only a matching owner renews an unexpired lease.
Observational `/codex:status`, `duet status` and `duet result` do not renew;
ownerless compatibility companion waits also do not renew. Foreground tasks renew while their owning
process runs; detached workers cannot renew themselves. Legacy records without
sessionId remain readable and SessionEnd falls back to their session-ID ownerId.

An attached owner wait heartbeats once a second (`ownerAttached`, lease renewal)
and marks itself detached on SIGINT/SIGTERM/SIGHUP, parent-PID change or closed
stdout. When the user stops the background task in Claude Code (or the fallback
agent), the task-worker sees that mark at its next 250 ms tick and interrupts the turn immediately with
`interruptionReason: owner_stopped`. An owner that dies without a mark (SIGKILL,
crash) is detected by its silent heartbeat after the grace period (5 s,
`CODEX_COMPANION_OWNER_GRACE_SEC`) as `owner_lost` unless a replacement attaches
first. A dead wait can be replaced immediately with the same owner while the job
is active and its lease unexpired; a second live, recently heartbeating wait is
refused, and a replaced wait cannot renew or detach its replacement. Both
interruptions are confirmed like any other interruption. A normal return
followed by silence still falls back to lease expiry.

After a stop, `duet result <worker> --details` exposes recovery handles and the
compatibility `continuationCommand`. With explicit user consent, use
`duet task --to <worker>` with a new brief, or `duet task --continue <jobId>
--cwd '<cwd>'` to inherit that exact job's settings. These start one new turn;
never continue automatically. Native SendMessage continuation also uses the same
thread when Claude Code permits it; the Haiku fallback requires a new agent.
For an unfinished adoptable job, the replacement owner's FIRST action is
`duet adopt <jobId> --json`, with user consent, then one
`duet wait <jobId> --owner '<newOwnerId>'`. Adoption rotates ownerId and renews
the unexpired lease without starting a turn, preserving thread/turn, question
and feed cursor. Retired owners return `ownership_moved`; adoption moves
SessionEnd scope to the caller's Claude session when available.

Adoption after expiry or completion returns `lease_expired` or `job_ended`
(exit 2) with the same `continuationCommand`, and never runs it. Cancellation in
progress also refuses adoption. Wait for pending interruption to finish before
continuing. Thread context and on-disk edits persist; missing thread handles
preclude a continuation command. `/codex:status` shows orphaned running jobs,
remaining seconds and an exact adopt instruction after no renewal for half the
lease in direct mode (900 s with the default 1800 s lease), or the smaller of
65 s and half the lease for other jobs. See [stop actions and recovery](direct-mode.md#if-a-worker-is-stopped).

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
duet setup --default-sandbox workspace-write --dry-run --json
duet setup --default-sandbox workspace-write --json
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
duet task --sandbox read-only <<'DUET_TASK'
Investigate and report; change nothing.
DUET_TASK
```

Never choose elevation automatically on an EPERM or browser failure when the
parent narrowed a call; return the denial to the parent.
Fresh tasks without flags use the configured default. `--to`/`--thread` inherit
recorded sandbox settings unless overridden, so explicitly narrow read-only
follow-ups. Background jobs persist the policy before starting. `--details`
includes `sandbox` and `approvalPolicy`; result artifacts include `sandboxPolicy`.

The local generated v2 protocol supports `ThreadStartParams.sandbox`,
`ThreadResumeParams.sandbox`, `TurnStartParams.sandboxPolicy` and
`TurnStartParams.approvalPolicy`. `SandboxPolicy` uses the tagged variants
`readOnly`, `workspaceWrite`, and `dangerFullAccess`. The companion sets the thread
policy, verifies the returned mode, and forwards the acknowledged policy to
`turn/start` for explicit opt-ins, retaining the runtime's roots/network defaults.
Owned jobs use `never+elicitations` to forward supported Computer Use approvals
to the parent; a compatibility non-direct companion task uses `never`.

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
      "/absolute/path/to/codex-plugin-isolated/plugins/codex/bin/duet"
    ]
  },
  "permissions": {
    "allow": [
      "Bash(/absolute/path/to/codex-plugin-isolated/plugins/codex/bin/duet *)"
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
duet setup --sync-tools --dry-run --json
duet setup --sync-tools --json
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
duet setup --sync-tools --profile codex-app --dry-run --json
duet setup --sync-tools --profile codex-app --replace-cua --json
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
and the [troubleshooting guide](troubleshooting.md#troubleshooting).

## Results, progress and recovery

`duet task` uses direct mode and asks Codex for a structured final response
(`schemas/worker-report.schema.json`): `status` (`completed`/`needs_input`/`blocked`),
`summary`, `key_findings`, `assumptions`, `verification`, `blockers`, `question`.
The helper preserves the declarations in the result artifact and merges them
with captured evidence. A runtime refusal forces `blocked`; a `completed` answer
that is only a plan or question becomes `needs_input`.

The default direct/result view is report v2: `status`, `worker`, `jobId`,
`summary` (8000-character cap with `summaryTruncated`), then nonempty `blockers`,
`question`, `changedFiles`, `checks`, `assumptions`, `keyFindings`, followed by
`next` and `details`. The envelope excluding summary fits within 2000 bytes;
text/lists may be shortened. `changedFilesOmitted` and `checks.omitted` count
omitted entries. `checks.ran` holds captured commands; `checks.claimed` holds
Codex's verification claims. `question` has `id`, `kind`, `text`, `options`,
`expiresInSec`. `next` suggests `duet wait`, `duet answer` or a follow-up, or is
null; it never authorizes resuming user-stopped work.

`duet result <worker> --details` returns the full report: thread/turn/owner
handles when available, settings, file-tracking basis, artifact paths,
`verification`, `claimedVerification`, `touchedFiles`, `preExistingChanges`,
`claudeMd` forwarding metadata and compatibility recovery commands.
`reportFormat: "structured"` marks parsed worker declarations; older/interrupted
responses may instead be inferred from prose. Use the job ID for an older turn.
The summary remains in `rawOutputFile`; `duet result <worker> --json` alone
selects the stored payload rather than report v2.

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
(`~/.claude/codex-isolated/duet/state/…` by default; directories `0700`, job/result JSON
files `0600`, logs and `broker.json` follow the process umask), the same place for a terminal, a Claude session and the SessionEnd
hook. `CLAUDE_PLUGIN_DATA` and the temp dir no longer decide the location. The
latest 50 finished jobs per workspace are retained.

Releases before 1.0.6-isolated.15 wrote the same layout under
`CLAUDE_PLUGIN_DATA/state` (`~/.claude/plugins/data/codex-codex-isolated-local`
or `…/codex-duet`, depending on the plugin ID at the time) or, outside Claude,
under `$TMPDIR/codex-companion-isolated`. The first command touching a workspace
merges whatever exists there into the new directory, under the new directory's
lock: the newer `updatedAt` record wins per job ID, the normal history cap applies,
the index is deduplicated, recorded absolute artifact
paths stay as they are (readable in place), the legacy directories are left
alone, and a marker (`.legacy-migration.json`, listing each merged source) makes
the merge idempotent across concurrent first commands. A legacy job whose
worker is still alive is served from its legacy directory (listed, `wait`-able,
cancellable through its record) and merged once that worker exits. A busy
legacy lock is retried later. Lookups by job ID, ID prefix or `--thread` that
miss in the new directory search the legacy directories and import the match.

The background-task completion notification carries report v2. Only if missing,
run `duet result <worker>`; never parse the output file or poll. Direct stdout
still ends with a JSON line after progress (`--quiet` suppresses progress).
Compatibility companion non-direct/feed output retains its existing format.

After interruption, retrieve in the original workspace or by session worker name:

```bash
duet status Ada
duet result Ada
duet result Ada --details
duet result '<job-id>' --details
```

Explicit references work across Claude session IDs. `--thread` selects the most
recently created tracked job on that thread, so prefer the job ID for an older
turn. When a dead wrapper has no saved result, status/result and the direct wait
reconcile its exact recorded turn through read-only `thread/read`, never
`thread/resume` or `turn/start`. Recovered terminal outcomes are saved once with
`recovered`, `recoveredAt`, `completedAt` and `recovery` (including `originalError`
and `turnStatus`); structured `blocked`/`needs_input` outcomes still exit 2 in
direct/report mode. A follow-up on a still-running or unresolved thread becomes
a blocked job with a typed `thread_busy` blocker whose `recoveryCommand` observes
status without attaching another wait. A running direct turn is handled by its
background `duet wait <worker>`, not polling. A missing turn handle, unavailable runtime
or absent server history is reported as unknown/unreachable. No automatic rerun
is safe in that case. `duet task --to`/`--thread` start another turn; reserve it for an
explicit follow-up after recovery.
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
