# Isolated workers in unattended workflows

Use the native `Agent` tool with `subagent_type: "codex:codex-worker"` and the
parent's foreground/background choice. Supply the objective, owned paths and
acceptance criteria. For follow-ups, supply that worker's exact thread ID. No
hand-written environment or sandbox instructions are needed in each assignment.
The worker sets Bash `dangerouslyDisableSandbox: true` on every companion call.
This affects the outer Claude Bash sandbox. Codex defaults to `read-only` or
`workspace-write` with `--write`, and always receives `approvalPolicy: "never"`.

Parallel workers need disjoint write ownership or separate worktrees. A worker
runs one Codex turn and waits for completion. It does not ask questions, install
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
Codex server requests for approval/input receive an unsupported-request error;
the runtime does not open an interactive confirmation flow.

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

For an assignment that needs Git metadata writes (such as `.git/index.lock`) or
launching a browser harness, the parent can explicitly request:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task --fresh --write --sandbox danger-full-access --report --json 'Run the authorized Git/browser assignment within the supplied paths.'
```

`--sandbox` accepts exactly `read-only`, `workspace-write`, or `danger-full-access`.
Write-capable policies require `--write`; `--write --sandbox read-only` is rejected.
This conservative guard also applies to a browser-only assignment requiring full
access. Never choose elevation automatically on an EPERM or browser failure.
Without the flag, existing defaults are unchanged. Every thread resume explicitly
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
`CODEX_COMPANION_NORMAL_HOME`, then `CODEX_HOME`, then `~/.codex`. The destination
is the isolated home. Home overlap, config symlinks and shared config inodes are
rejected before writing. The source is read-only; credentials, provider/auth
configuration, remote marketplace URLs, arbitrary MCP servers and unrelated
plugins are never imported.

Sync adds missing sections only and leaves existing sections byte-for-byte,
including an existing node_repl server and its separate env table. It creates a
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

## Results, progress and recovery

Native workers use `task --report --json`. This retains legacy full-output task
and result behavior when `--report` is omitted. The compact report includes
status, jobId, threadId, turnId, touched files, command verification evidence,
Codex-reported findings, blockers and output paths, targeting at most 60 lines.
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
The full final text is in `<job-id>.output.txt`; the raw result, command events
and reasoning summaries are in `<job-id>.result.json`. Progress/messages are in
`<job-id>.log`. These live beside the job record, under `CLAUDE_PLUGIN_DATA/state`
or the isolated companion's per-workspace temporary job directory. The latest
50 finished jobs are retained; temp-backed records may be removed by OS cleanup.
Use persistent CLAUDE_PLUGIN_DATA for recovery across machine cleanup/reboots.

Job ID and log/output paths are persisted and printed on stderr before execution;
thread and turn IDs are persisted as soon as the server returns them. Progress
events and a 15-second heartbeat go to stderr and the job log even in JSON mode.
Heartbeats show item/tool counts, elapsed time and last notification age. No
notifications during a long tool call means silence, not proof of a hang. Stdout
remains a single final JSON document; a native Bash output file may combine it
with stderr, so use `result --report --json` for clean retrieval if needed.

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
