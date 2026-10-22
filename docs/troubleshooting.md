# Troubleshooting and known limitations

Back to the [README](../README.md).

## Troubleshooting

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

**`stale_browser_tab_claim`.** Another browser session owns that tab. Start the
assignment again with a fresh tab; do not steal the claim.

**`status: blocked` with `computer_use_app_not_approved`.** The worker tried to
drive an app (`blockers[].app`) that the isolated runtime has not approved. Check
`setup --list-computer-apps --json`: in `mirror` mode the app must be "Always"
allowed in the user's Codex app (or added with `setup --allow-computer-app`); in
`ask` mode mirrored grants are dropped but explicit ones remain. Approve with
`task --approve-computer-app <bundle id>` for one call, an explicit isolated grant
(`setup --allow-computer-app`), or the forwarded approval question on an owned job.
`computer_use_app_blocked_by_policy`/`computer_use_app_forbidden` come from
Codex's own policy and cannot be overridden here. `browser_tab_debugger_unattached`
names a tab (`tabId`, `sessionId`, `closed`) the worker could not inspect or
close; close it manually if `closed` is `false`. `reported_blocked` means Codex's
own final answer declared itself blocked. Blocked tasks exit 2, like `needs_input`.

**Interrupted worker or lost connection.** Inspect `status <job> --json` and
`result <job> --report --json` in the original workspace: an eligible lost turn
is reconciled against its exact server record without resubmission, preserving
its real outcome and recovery provenance. A follow-up on a busy or unresolved
thread is blocked with `thread_busy`; use its observational status
`recoveryCommand`. Do not resubmit blindly; that starts a new turn.

More: [worker operations](worker-operations.md) and
[worker lifecycle](worker-lifecycle.md).

## Known limitations

- `ask_parent`, `--follow`, owner loss, `--continue`, lease expiry and
  cancellation are covered by fixture tests against a fake app-server. The
  per-thread MCP bridge, owner loss (`owner_stopped`/`owner_lost`) and
  `--continue` were also exercised live against the real app-server
  (`codex-cli 0.162.0-alpha.17.2`), including back-to-back `ask_parent` round
  trips on one resumed thread; that real app-server smoke remains manual.
  `npm run verify` checks versions, builds, and runs runtime and live-pane fixture
  tests; CI runs those checks on pull requests and pushes to main.
- `ask_parent` uses the app-server's experimental dynamic-tool API on new threads
  and a per-thread MCP server override on resumed threads. Runtimes that reject
  either registration fall back to a final `needs_input` report.
- Codex edits bypass Claude Code's own permission prompts and edit tracking; the
  report's `touchedFiles`/`preExistingChanges`, the Codex sandbox and your git
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
- Blocker detection matches fixed runtime signatures (`Computer Use was not
  approved to use …`, `Debugger unattached`, `Tab … is already part of browser
  session …`) and a final answer that starts with "Blocked" or states
  `status: blocked`; a refusal phrased differently is reported through
  `keyFindings` and the raw output only.
- File tracking cannot attribute edits when several writers share a checkout, and
  ignored files and submodule contents are not hashed.
- Legacy state directories are merged, never removed. A job whose worker from an
  older release is still running stays in its legacy directory until that
  worker exits; `cancel` for such a job records the request but cannot confirm
  the interruption (exit 2), as for any record without a control-aware worker.
