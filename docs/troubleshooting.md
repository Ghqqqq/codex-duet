# Troubleshooting and known limitations

Back to the [README](../README.md).

## Troubleshooting

**`duet: command not found` after install.** Reload plugins or start a new Claude
session so the plugin's `bin/` is on PATH. You can also invoke the installed
plugin's absolute launcher, for example `'/absolute/path/plugins/codex/bin/duet'
task --help`. `/codex:setup` reports the resolved launcher path and availability.
SessionStart supplies the session ID and dispatch guidance; do not construct a
second runtime or submit a replacement for a job that may already exist.

**Native agent unavailable.** `Agent(subagent_type: "codex:codex-native")` needs
the supported function-hook module. After registration, the adapter advertises
it on the first accepted non-command person prompt (`prompt.submit`), not
SessionStart. If the model fallback runs, it returns a blocked
`native_adapter_unavailable` report and does not solve the assignment. Check
`duet status` before retrying, then enable the supported hooks/reload or use
background `duet task`. Do not treat the fallback as zero Claude usage.

**Completion notification has no report.** The function hook normally attaches
report v2. If it cannot, run `duet result <worker>`; use `--details` for full
evidence, handles and settings. Do not parse the task output file.

**A worker ended while nothing was waiting.** On a typed prompt, Duet can give
Claude one recovery line for up to five jobs in this session that ended at least
10 seconds ago without an emitted report, previous notice or live attached
owner wait. Follow its `duet result '<id>' --cwd '<root>' --details` command.
Only tasks created with 1.4.4 tracking qualify. Lookup errors, oversized state
or the 2-second timeout leave the prompt unchanged; the scan caps at 256
state-root entries and 8 MiB of indexes (2 MiB each). Each notice is claimed
before it is attached and confirmed after the prompt is accepted; an unconfirmed
claim expires after 10 minutes, so a failure delays or, rarely, repeats a notice
instead of losing it. The helper costs an estimated 60 ms per typed
prompt; see [unreported endings](worker-lifecycle.md#unreported-endings).

**Claude instructions are approximate.** Managed environments skip user-supplied
`prompt.context` hooks. If the session's first loaded instruction inventory is
missing or invalid, Duet falls back to a startup scan and records
`claudeMd.approximate` in `--details`. Later contexts cannot replace that first attempt.
A valid inventory over the capture budget stays authoritative, with omissions
reported instead of a fallback scan. The scan cannot reproduce all
policy/settings, imports or path-triggered rules.
Threads keep their original instructions. CLAUDE.md edits require a new Claude
session and a fresh task to use the new snapshot. Opt out on a fresh task with
`--no-claude-md`. See [configuration](configuration.md#claude-instructions-and-conversation-imports).

**Slow first tool call.** Each job records startup timings: broker connect/spawn,
app-server initialization, thread start/resume, turn start, first model event and
first tool call. A 2026-10-15 measurement traced a ~120 s pre-tool delay to about
six 15-second WebSocket attempts before HTTP fallback; after switching to the HTTP
provider, a 2026-10-16 live run resumed its thread in about 5 s with no transport
retries, and the remaining time between steps was model reasoning at `xhigh`. Use
`--fast` or a lower effort for latency-sensitive browser steps. Brokers are
prewarmed asynchronously at session start. Evidence:
[delay investigation](cua-delay-investigation.md).

**`auth.status: "unreachable"`, EPERM or socket errors.** The auth check could not
complete because of a timeout, network, socket or permission failure. If Claude's
Bash sandbox caused it, retry outside the sandbox rather than logging in again.
Setup's 45-second total deadline and the standalone availability probes'
60-second overall deadline guard against hangs. Codex executable probes cap at
20 seconds, initialization at 30 seconds and account/config requests at 20
seconds each within the remaining deadline (see [setup](commands.md#codexsetup)
for all stage limits). These are generous safeguards, not normal startup timings.
If a pinned runtime is broken, optional PATH Codex version/help diagnostics
also share setup's deadline, capped at 20 seconds each and skipped when no time
remains. A working PATH candidate only informs repair guidance; setup still
reports the broken pin.
A stalled Codex probe returns `ready: false`,
`auth.status: "unreachable"` and `auth.reason: "timeout"`; shutdown may add brief
overhead. This does not imply logout, and setup does not suggest logging in.

**CUA sync reports missing/non-executable node or an unreadable launcher.** The
`codex-app` profile validates both files before writes, including dry-runs and
identical definitions. Repair the app or select a current `--cua-template`.
`setup --json` also reports `tools.cuaReplReason` for a stale configured command;
this is an offline executable check, not a live browser/desktop test. Optional
CUA availability is separate from core `ready`.

**`stale_browser_tab_claim`.** Another browser session owns that tab. Start the
assignment again with a fresh tab; do not steal the claim.

**`status: blocked` with `computer_use_app_not_approved`.** The worker tried to
drive an app (`blockers[].app` in the compact report and `--details`) that the isolated runtime has not approved. Check
`setup --list-computer-apps --json`: in `mirror` mode the app must be "Always"
allowed in the user's Codex app (or added with `setup --allow-computer-app`); in
`ask` mode mirrored grants are dropped but explicit ones remain. Approve with
`task --approve-computer-app <bundle id>` for one call, an explicit isolated grant
(`setup --allow-computer-app`), or the forwarded approval question on an owned job.
For that question, submit only an exact displayed option label, its number
`1`–`4`, or `call`/`once`/`task`/`always`/`deny`/`no`. Answers are trimmed and
case-insensitive; exact labels allow a trailing period. Anything else, including
`yes` or a choice followed by an explanation, denies the request; see
[approval choices](computer-use-approvals.md#forwarded-approvals-owned-jobs).
`computer_use_app_blocked_by_policy`/`computer_use_app_forbidden` come from
Codex's own policy and cannot be overridden here. `browser_tab_debugger_unattached`
names a tab (`tabId`, `sessionId`, `closed` in compact blockers and `--details`) the worker could not inspect or
close; close it manually if `closed` is `false`. `reported_blocked` means Codex's
own final answer declared itself blocked. Blocked tasks exit 2, like `needs_input`.
`approval_denied`/`approval_unsupported` mean a non-Computer-Use server request
was denied or unsupported. They force a blocked report even if Codex claims
completion; safe method/kind/server/origin fields identify the request without
exposing its payload. Resolve the prerequisite instead of retrying around it.

**`provider_refused`, `usage_limit`, `context_window_exceeded` or `auth_required`.**
These are typed failed-turn blockers, with `status: blocked` and exit 2:
`cyberPolicy` maps to `provider_refused`; `usageLimitExceeded` and
`sessionBudgetExceeded` to `usage_limit`; `contextWindowExceeded` to
`context_window_exceeded`; and `unauthorized` to `auth_required`. Respect the
provider refusal and clarify legitimate defensive scope before a fresh dispatch;
for usage limits wait for reset or change model/plan; for full context start a
fresh worker with a shorter brief; for missing auth run `duet setup` and log in
to the isolated home. Details preserve the original `error` text with display
cleanup. The sole text fallback is “flagged for possible cybersecurity risk”,
case-insensitive, when typed information is absent. Other failures remain
`failed`, exit 1. An error notification on a turn that later succeeds does not
alone make it blocked. See [runtime blocker details](worker-operations.md#direct-mode).

**Interrupted worker or lost connection.** Inspect `duet status <worker>` and
`duet result <worker> --details` in the original workspace: an eligible lost turn
is reconciled against its exact server record without resubmission, preserving
its real outcome and recovery provenance. A missing turn handle can also be
recovered from a unique unclaimed turn with a suitable start timestamp;
ambiguous or unreadable history stays unresolved. A dead worker with no thread
handle is resolved as failed.

A follow-up on a busy or unresolved thread is blocked with `thread_busy`. The
server pre-check also catches external turns and turns in other workspaces.
Use `next` verbatim: it answers the tracked owner's pinned question when one
blocks progress, otherwise observes recovery/status, or is null. The blocker's
nested question and `cancelCommand` belong to that owner; `details` targets the
refused attempt. Use recovery or cancel only when supplied for a tracked owning job;
external turns have no Duet recovery/cancel command and must be resolved by
their owner. Commands shortened out of a compact report remain in `--details`.
Do not resubmit blindly; that starts a new turn.

More: [worker operations](worker-operations.md) and
[worker lifecycle](worker-lifecycle.md).

## Known limitations

- Stopping an active native agent from `/tasks` interrupts its turn and ends
  the commands its thread started. The adapter gives the owner stop a bounded
  chance to record `interrupted` / `owner_stopped`, with a cancel fallback when
  confirmation is missing. Explicit `duet cancel` retains its cancellation
  semantics. Claude Code refuses process calls in the
  stopped dispatch, so the agent's result reports `interrupted` from the
  recorded handles, and the confirmation is recorded on the job afterwards
  (`duet status <worker>`); SendMessage can then continue the agent. If no job
  was recorded yet, the result is blocked (`native_stop_unconfirmed`); after
  `duet cancel <worker>` confirms it, the next SendMessage is accepted. A question parked
  after the native agent returns may not receive a stop event; use `duet cancel
  <worker>`, or the default 900 s question timeout applies.
- Cancelling ends every background terminal the worker's thread started,
  including dev servers from earlier turns. A Codex runtime without
  `thread/backgroundTerminals/clean` reports `backgroundTerminals.cleaned:
  false` and leaves them running.
- `--fork` imports are labelled “imported Claude conversation (fidelity not
  verified)”; use an explicit brief for facts and acceptance criteria.
- `codex-live` shows prompts and matched `ask_parent` answers on fresh and resumed
  threads. The bridge preserves Codex's `_meta.callId`; if the runtime omits it
  or a stored answer has no valid call ID, that answer cannot be matched and is
  not shown.

- `ask_parent`, `--follow`, owner loss, `--continue`, lease expiry and
  cancellation are covered by fixture tests against a fake app-server. The
  per-thread MCP bridge, owner loss (`owner_stopped`/`owner_lost`) and
  `--continue` were also exercised live against the real app-server
  (`codex-cli 0.162.0-alpha.17.2`), including back-to-back `ask_parent` round
  trips on one resumed thread; that real app-server smoke remains manual.
  `npm run verify` checks versions, builds, and runs runtime and live-pane fixture
  tests; CI runs those checks on pull requests and pushes to main.
- `ask_parent` uses a per-thread MCP server override on fresh and resumed threads,
  keeping parent questions outside code mode. If a runtime reports unsupported
  bridge registration, fresh threads retry with the experimental dynamic-tool API, which can incur
  repeated `exec`/`wait` sampling while awaiting an answer. If registration is
  unavailable, workers retain the final `needs_input` fallback.
- Codex edits bypass Claude Code's own permission prompts and edit tracking; the
  report's `changedFiles` (`touchedFiles`/`preExistingChanges` in `--details`), the Codex sandbox and your git
  history are the controls. `git diff`/`git status` show current uncommitted changes;
  also check new commits and the report's touched-file evidence, with the limits
  below for ignored files, submodules and concurrent writers. Claude's own rewind
  does not cover worker edits. An owner that is killed outright
  (SIGKILL) can be replaced immediately by a wait with the same owner while the
  job is active and its lease unexpired; otherwise heartbeat detection interrupts
  it after the 5 s grace. A signalled stop is immediate.
- The owner lease is lifecycle coordination between local processes, not an
  authentication boundary.
- Browser origin persistence and Computer Use app approvals follow the file
  formats used by the bundled browser service and `node_repl`
  (`computer-use/config.toml`, `computer-use/sessions/<thread>.toml`); a future
  runtime may change them. Session-level ("This session") approvals in the
  user's Codex app are deliberately not mirrored.
- Blocker detection includes the typed failed-turn errors above, typed
  server-request refusals and fixed runtime signatures (`Computer Use was not
  approved to use …`, `Debugger unattached`, `Tab … is already part of browser
  session …`) and a final answer that starts with "Blocked" or states
  `status: blocked`; an otherwise uncaptured refusal phrased differently is reported through
  `keyFindings` and the raw output only.
- File tracking cannot attribute edits when several writers share a checkout, and
  ignored files and submodule contents are not hashed.
- Legacy state directories are merged, never removed. A job whose worker from an
  older release is still running stays in its legacy directory until that
  worker exits; `cancel` for such a job records the request but cannot confirm
  the interruption (exit 2), as for any record without a control-aware worker.
