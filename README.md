# Duet — Claude Code × Codex

Duet turns Codex into a native Claude Code subagent. Claude plans, splits the
work and verifies the result; Codex workers do the investigation, implementation
or review in parallel, in an isolated Codex home, and come back with short,
recoverable reports instead of raw transcripts.

From Claude's side a Codex worker is just another `Agent` call: it can run in the
background, run alongside other workers, ask Claude a question mid-task, stops
within seconds when you stop the agent, and leaves a one-line continuation command
so a new worker can pick the same Codex thread up again. The worker itself is a
thin relay (Haiku by default) that makes one blocking helper call per ~9.5 minutes
of Codex work, so delegation does not spend your Claude quota on polling.

Duet is a fork of [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc)
(upstream `db52e28` / 1.0.6). The review and rescue commands come from upstream;
the native worker runtime, isolation and lifecycle work are Duet additions.

## Highlights

- **Native parallel workers.** `Agent(subagent_type: "codex:codex-worker")` starts
  one Codex turn per assignment. Independent workers run concurrently; each keeps
  its own Codex thread, so follow-ups continue the right conversation.
- **Quota-light relay.** The worker agent runs on Haiku and makes one blocking
  `task --follow` call that returns only when Codex finishes, asks a question, or
  the 570 s wait budget ends (then one `wait` call per further 9.5 minutes). No
  10–30 s polling loop, no transcription of the feed by an Opus-class model.
- **Live activity for humans.** `wait` in feed mode (no `--json`) streams redacted
  assistant snippets, command lines with exits/durations, file changes, tool
  names/status and plan titles; `/codex:status` shows the current item and
  phase. Tool arguments, command output and page content are excluded. JSON mode
  reports at most the 12 newest events plus counts.
- **Mid-task questions.** Codex can call `ask_parent`, on new threads (dynamic
  tool) and on resumed threads (per-thread `duet_parent` MCP bridge). The worker
  forwards the exact `questionMessage` to Claude (its only permitted SendMessage),
  and the answer is fed back into the *same* Codex turn. An unanswered question
  times out (15 minutes by default) and Codex proceeds on a conservative
  assumption that it reports.
- **Stops that stop.** Every job has a unique owner. While an owner `wait` is
  attached it heartbeats once a second; if the owner dies (user stops the agent,
  Bash kill, closed pipe) and nothing re-attaches within 15 s, the worker
  interrupts the Codex turn (`owner_lost`). The 180 s lease remains the fallback
  for an owner that returned normally and never came back. `cancel` reports
  confirmed versus unconfirmed termination; ending the Claude session interrupts
  that session's jobs. Idle brokers exit after 60 s.
- **Resume after a stop.** Every interrupted/failed report carries
  `task --continue <jobId> --follow --report --json`, which starts one new turn on
  the same Codex thread with the job's recorded sandbox, write, model and
  browser-origin settings. Still-running jobs can also be adopted by a replacement
  worker without a new turn.
- **Isolated home.** Authentication, sessions, SQLite and logs live in
  `~/.claude/codex-isolated`, separate from your everyday `~/.codex`. Credentials
  are never copied.
- **Honest reports.** Compact JSON reports separate captured facts from Codex's
  claims, list touched files against a before/after snapshot (pre-existing dirt
  reported separately), and keep handles for read-only recovery.
- **Browser work.** Optional Chrome/computer-use tooling, fresh session-owned tabs,
  and explicit per-origin consent or an opt-in all-sites setting.

## Requirements

- Claude Code with plugin support.
- Node.js 18.18 or later.
- A Codex CLI (`codex` on PATH, or a pinned binary, see [Runtime selection](#runtime-selection)).
- A ChatGPT plan (including Free) or an OpenAI API key. Usage counts toward your
  Codex limits; the isolated home shares limits with your normal Codex account.

## Install

Add the marketplace and install the plugin:

```bash
/plugin marketplace add Ghqqqq/codex-duet        # or an absolute path to a local checkout
/plugin install codex@duet
/reload-plugins
```

The repository is private, so the GitHub form needs Git credentials that can read
it. The marketplace is `duet`; the plugin keeps the `codex` command namespace, so
the install ID is `codex@duet`, commands are `/codex:*` and the agents are
`codex:codex-worker` and `codex:codex-rescue`.

Upgrading from the earlier `codex@codex-isolated-local` ID: uninstall it and remove
that marketplace, add this one again, and install `codex@duet`. Claude Code keys
plugin data by ID, so copy `~/.claude/plugins/data/codex-codex-isolated-local` to
`~/.claude/plugins/data/codex-duet` first if you want to keep job history.

Then check the runtime and sign in to the isolated home once:

```bash
/codex:setup
!node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-isolated.mjs" login
```

`/codex:setup` reports whether Codex is installed, reachable and logged in. It
distinguishes an unreachable authentication probe (for example inside a sandbox)
from a confirmed logout.

## Using Codex workers

You normally do not call anything yourself: ask Claude to delegate, or let it
decide that a task benefits from an independent worker.

```text
Have Codex investigate why the integration tests are flaky, and in parallel have
another Codex worker review the retry logic in src/net/.
```

What happens under the hood:

1. Claude spawns `codex:codex-worker` (Haiku) with a bounded assignment
   (objective, owned paths, constraints, acceptance criteria).
2. The worker runs ONE `task --fresh --follow --json --report …` call with Bash
   `timeout: 600000`. The helper submits the job, stays attached as its owner and
   returns a single JSON line when Codex finishes, asks a question, or the 570 s
   wait budget ends (`status: running`, then one `wait <job> --owner <ownerId>
   --json --report` per further 9.5 minutes). Feed mode (`wait` without `--json`)
   remains available for humans and scripts; cursors are per owner.
3. If Codex calls `ask_parent`, the call returns `needs_answer`; the worker sends
   `questionMessage` verbatim to Claude once, waits with `--after-question`, and
   passes the reply to `answer <job> --owner <ownerId> --question <id>`.
4. On completion it returns a compact report (status, handles, touched files,
   verification, assumptions, blockers, and paths to the full raw output).

Follow-ups after normal completion can go to the same worker with `SendMessage`;
it continues its own thread with `task --thread <threadId> --follow …`. A worker
stopped by the user cannot be resumed; use the continuation workflow below. Never
use "the latest thread" to pick one worker out of several. Worker messages that
are not verbatim questions are not evidence: verify with the job/thread/turn
handles, `result --report --json`, and the actual diff and checks. Workers may not
send progress, completion claims or placeholders with SendMessage; final results
arrive only as agent return values.

The worker model is set in `plugins/codex/agents/codex-worker.md` (`model: haiku`);
change it to `sonnet` or `inherit` if you prefer a stronger relay.

### If a worker is stopped

Claude Code 2.1.301 can stop background agents through these UI actions:

- Esc or Ctrl+C in the main input; with empty input, this stops ALL background agents.
- `ctrl+x ctrl+k` pressed twice.
- `x` in a subagent's detail view.

A stopped native agent cannot be resumed with SendMessage. Stopping it kills the
worker's blocking helper call; the attached owner `wait` either marks itself
detached (signal, parent shell gone, closed stdout) or simply stops heartbeating.
If no owner re-attaches within the grace period (15 s, `CODEX_COMPANION_OWNER_GRACE_SEC`),
the detached task worker interrupts the Codex turn with `interruptionReason:
owner_lost` and confirms the interruption. Thread context and on-disk edits
persist. The grace period exists so a Bash timeout kill followed by an immediate
`wait` re-run does not interrupt anything.

The interrupted report (and `result --report --json`, `/codex:status <jobId>`)
carries an exact `continuationCommand`:
`task --continue <jobId> --cwd <cwd> --follow --report --json`. It starts ONE new
turn on the same Codex thread with the original job's recorded sandbox, write,
model, effort, speed and browser-origin settings; any extra prompt text is
appended. With the user's explicit consent, Claude runs it through a new
`codex:codex-worker`; nothing starts it automatically. If no thread handle was
recorded, no continuation command is available.

A job that is still running (for example the owner returned normally and the
agent was then stopped between calls) stays alive for the lease window (default
180 s from the last renewal, `task --lease-sec`). With the user's explicit
consent, a **replacement worker** whose FIRST action is `adopt <jobId> --json`
takes over that live turn: adoption atomically assigns a new ownerId and renews
the lease, preserving the thread, turn, pending question and delivered feed
cursor, and it never submits a new task for an adoptable job. The old owner's
later wait/status/answer calls return `ownership_moved`. Without adoption the
job is interrupted at lease expiry (`lease_expired`) with the same continuation
command. Parent `/codex:status`, `status`, `result`, and ownerless `wait` calls
never renew the lease, even from the same Claude session.

`/codex:status` marks stale running jobs **orphaned**, with remaining lease seconds
and an exact adopt instruction, inferred after 65 s without owner renewal (or
half the lease for shorter leases).

### Defaults and runtime choices

| Choice | Default | Override |
| --- | --- | --- |
| Model | `gpt-6-astra` | `--model <name>` (`spark` maps to `gpt-5.3-codex-spark`) |
| Reasoning effort | `xhigh` | `--effort none…xhigh` or `--effort max` where the model supports it |
| Speed | normal | `--fast` requests the fast tier for that call only; `--normal` resets |
| Codex sandbox | Configured default, initially `read-only` | `setup --default-sandbox <mode>` (stored in `~/.claude/codex-isolated/duet/config.toml`); per-call `--write` guarantees at least `workspace-write` without narrowing a broader default; `--write --sandbox danger-full-access` for full access |
| Approval policy | `never` | — |

Workers pass `--write` for assignments that edit files. Each follow-up uses its
own flags and the current configured sandbox default; only `task --continue`
deliberately inherits the original job's settings. Per-call write access, fast
mode and browser grants are otherwise never inherited from an earlier turn, and
workers never elevate after a denial. Companion Bash calls run with
`dangerouslyDisableSandbox: true` because the runtime needs network access and
local sockets; that is separate from Codex's own sandbox.

### Parallel work

Read-only workers may share a checkout. Concurrent writers need disjoint owned
paths or separate worktrees; shared files, lockfiles, indexes and generated
output need serialization. Job state uses interprocess locks and atomic writes;
all active jobs and the latest 50 finished jobs are kept.

## Commands

### `/codex:review`

Runs a read-only Codex review of your uncommitted changes, or of your branch
compared to a base such as `main` with `--base <ref>`. It supports `--wait` and
`--background`, and takes no focus text; use `/codex:adversarial-review` for that.

```bash
/codex:review
/codex:review --base main
/codex:review --background
```

### `/codex:adversarial-review`

A steerable review that challenges the chosen design: assumptions, tradeoffs,
failure modes and safer alternatives.
It uses the same review target selection as `/codex:review`, including `--base <ref>`,
and accepts focus text after the flags. It is read-only.

```bash
/codex:adversarial-review
/codex:adversarial-review --base main challenge whether this was the right caching and retry design
/codex:adversarial-review --background look for race conditions and question the chosen approach
```

### `/codex:rescue`

Hands a one-off task to Codex through the `codex:codex-rescue` subagent: investigate
a bug, try a fix, continue a previous Codex task, or take a cheaper pass with a
smaller model. It supports `--background`, `--wait`, `--resume` and `--fresh`.

```bash
/codex:rescue investigate why the tests started failing
/codex:rescue --resume apply the top fix from the last run
/codex:rescue --model gpt-5.4-mini --effort medium investigate the flaky integration test
/codex:rescue --model spark fix the issue quickly
```

If you do not pass `--model` or `--effort`, delegated tasks use `gpt-6-astra` and `xhigh`.
If you say `spark`, the plugin maps that to `gpt-5.3-codex-spark`. For planned,
parallel work Claude uses `codex:codex-worker` instead (see above).

### `/codex:transfer`

Creates a persistent Codex thread from the current Claude Code session and prints
the isolated `codex-isolated.mjs --home <directory> resume <session-id>` command,
so you can continue the same context directly in Codex. `--source <jsonl>`
overrides the transcript path supplied by the SessionStart hook.

### `/codex:status`

Shows running and recent Codex jobs for the current repository, or one job with
`/codex:status <job-id>`.

### `/codex:result`

Shows the stored output of a finished job, including the Codex session ID for
resuming it in Codex.

### `/codex:cancel`

Interrupts an active job and reports whether termination was confirmed.

### `/codex:setup`

Checks whether Codex is installed, reachable and logged in. If Codex is missing
and npm is available, it can offer to install Codex for you. It also runs the
configuration actions described under [Configuration](#configuration).

The optional review gate runs a targeted Codex review of Claude's last turn from a
`Stop` hook and blocks the stop if it finds issues:

```bash
/codex:setup --enable-review-gate
/codex:setup --disable-review-gate
```

This can create long Claude/Codex loops and consume usage quickly; enable it only
while you are watching the session.

### Companion subcommands

Workers call `node scripts/codex-companion.mjs` directly: `task`, `wait`, `answer`,
`status`, `result`, `cancel` and `setup`. Run it without arguments for full usage.

## Configuration

All configuration changes below are explicit, idempotent, and write a timestamped
backup first. Unrelated configuration is preserved byte-for-byte.

### Match your Codex App

Opt into the Codex App's installed browser/desktop tools, a full-access task
default, and browser access to all sites. From the repository root, preview
each of these three independent changes first:

```bash
node plugins/codex/scripts/codex-companion.mjs setup --sync-tools --profile codex-app --replace-cua --dry-run --json
node plugins/codex/scripts/codex-companion.mjs setup --default-sandbox danger-full-access --dry-run --json
node plugins/codex/scripts/codex-companion.mjs setup --browser-approval never-ask --dry-run --json
```

After reviewing the previews, rerun each command without `--dry-run` to apply.
These options are independent; select only the capabilities you want.
**Security:** together they grant full disk write access, desktop control, and
access to any website with the user's logged-in browser. An isolated Codex home
keeps runtime data separate; it does not confine these capabilities. Workers
still follow the assignment's scope and never elevate after a denial.

The `codex-app` profile selects the newest cached unified-computer-use `.mcp.json`
under the normal Codex home, or an explicit `--cua-template /absolute/.mcp.json`.
It mirrors the resolved `cua_repl` server, rewriting only `CODEX_HOME` and the home
entry in `NODE_REPL_TRUSTED_CODE_PATHS`. It retains Sky, instruction strings,
tool visibility/output limits and the template's timeout settings; it does not
add `tool_timeout_sec`. It reports the resulting surfaces and backends (normally
`browser,computer` and `chrome,iab,mcpapps`). Unknown/credential-bearing template
fields are rejected, and credentials are never copied. A different existing CUA
block requires `--replace-cua`; a dry-run without that flag shows the proposed
diff with old values redacted. The default `chrome` profile stays Chrome-only.
To restore that tool profile, preview and apply
`setup --sync-tools --profile chrome --replace-cua`; sandbox and browser approval
remain separate settings.

Desktop Accessibility and Screen Recording permissions must already be granted
to **Codex Computer Use.app**. Setup does not grant OS permissions or probe tools.
After changing tool/browser configuration, restart the Claude session/shared
Codex runtime when other workers have finished.

The sandbox default is stored in `CLAUDE_PLUGIN_DATA/config.toml`, or in
`<isolated-home>/duet/config.toml` when plugin data is unset. Use the same plugin
data directory when applying setup and launching workers. With neither task
flag, a write-capable default implies `--write`; an explicit `--sandbox` wins
and retains the existing explicit `--write` requirement for write-capable modes.
`--write` alone selects workspace-write. Restore a conservative default with
`setup --default-sandbox read-only`; use `task --sandbox read-only` for one call.
Review commands remain read-only.

`setup --browser-approval ask` removes only top-level `approval_mode` from the
isolated `browser/config.toml`; existing per-origin grants and download/upload/
history settings remain unchanged. `setup --json` reports `defaultSandbox` and
`browserOrigins.approval`; `setup --list-browser-origins --json` includes the
browser mode. See [worker operations](docs/worker-operations.md#codex-app-profile)
and [browser approvals](docs/browser-approvals.md#all-sites-browser-approval).

### Browser and computer-use tooling

```bash
node scripts/codex-companion.mjs setup --sync-tools --dry-run   # preview
node scripts/codex-companion.mjs setup --sync-tools             # apply
```

Copies only allowlisted browser/computer-use tool settings into the isolated home
and builds a missing `mcp_servers.cua_repl` entry from the installed template
(Chrome/browser only, paths rewritten to the isolated home). Credentials and
provider settings are never copied. For relocated installs add
`--cua-template <file>` and `--chatgpt-resources <dir>`.

Browser assignments always open a fresh, session-owned tab and close it at the
end, including on failure; they never claim an existing user tab.

### Browser origin consent

```bash
node scripts/codex-companion.mjs setup --allow-browser-origin https://www.example.com
node scripts/codex-companion.mjs setup --revoke-browser-origin https://www.example.com
node scripts/codex-companion.mjs setup --list-browser-origins
```

These write the browser runtime's own persisted approval file
(`<isolated home>/browser/config.toml`, `[origins] allowed/denied`), so the bundled
browser service auto-approves exactly that origin without a prompt. Allowing an
origin also removes stale per-thread denies for it. Origins must be bare
`scheme://host[:port]` values: no paths, trailing slash, wildcards or userinfo.
Only add origins the user has explicitly approved; Duet never adds one after a
denial.

`task --approve-browser-origin <origin>` is narrower: it approves only the
schema-defined, network-only command approval for the current turn. Unsupported
browser elicitations are answered with `cancel`, which the browser runtime does
not persist as a deny. Details: [browser approvals](docs/browser-approvals.md).

### Model transport

```bash
node scripts/codex-companion.mjs setup --transport status   # read-only
node scripts/codex-companion.mjs setup --transport http
node scripts/codex-companion.mjs setup --transport websocket
```

Switches the isolated home between the WebSocket and HTTP ChatGPT provider. Use
`http` if startup timings show WebSocket retries (workers surface a
`startupWarning` when they do). The default is unchanged.

### Other Codex settings

Model and effort for non-worker operations can be set in
`~/.claude/codex-isolated/config.toml` or a trusted project's `.codex/config.toml`,
for example:

```toml
model = "gpt-5.4-mini"
model_reasoning_effort = "high"
```

See the [Codex configuration reference](https://developers.openai.com/codex/config-reference).

## Troubleshooting

**Slow first tool call.** Each job records startup timings: broker connect/spawn,
app-server initialization, thread start/resume, turn start, first model event and
first tool call. A 2026-10-15 measurement traced a ~120 s pre-tool delay to about
six 15-second WebSocket attempts before HTTP fallback; after switching to the HTTP
provider, a 2026-10-16 live run resumed its thread in about 5 s with no transport
retries, and the remaining time between steps was model reasoning at `xhigh`. Use
`--fast` or a lower effort for latency-sensitive browser steps. Brokers are
prewarmed asynchronously at session start. Evidence:
[delay investigation](docs/cua-delay-investigation.md).

**`auth.status: "unreachable"`, EPERM or socket errors.** The call ran inside a
sandbox. Workers retry once with the sandbox disabled; if you call the companion
yourself, do the same rather than logging in again.

**`stale_browser_tab_claim`.** Another browser session owns that tab. Start the
assignment again with a fresh tab; do not steal the claim.

**Interrupted worker.** Recover with `status <job> --json` and
`result <job> --report --json` in the original workspace. Do not resubmit the task;
that starts a new turn.

More: [worker operations](docs/worker-operations.md) and
[worker lifecycle](docs/worker-lifecycle.md).

## Runtime selection

The isolated home may contain `runtime.json` with an absolute `codexBinary` path;
`CODEX_COMPANION_BIN` overrides it; otherwise `codex` on PATH is used. A broker
records its executable at startup, so changing the binary requires a new Claude
session. A custom absolute `CODEX_COMPANION_HOME` is supported; homes overlapping
the normal Codex home are rejected. Failures never fall back to the normal
session store.

## Known limitations

- `ask_parent`, `--follow`, owner loss, `--continue`, lease expiry and
  cancellation are covered by fixture tests against a fake app-server. The
  per-thread MCP bridge, owner loss (`owner_lost` after the grace period) and
  `--continue` were also exercised live against the real app-server
  (`codex-cli 0.162.0-alpha.17.2`), including back-to-back `ask_parent` round
  trips on one resumed thread; that live smoke is still a manual step, not CI.
- `ask_parent` uses the app-server's experimental dynamic-tool API on new threads
  and a per-thread MCP server override on resumed threads. Runtimes that reject
  either registration fall back to a final `needs_input` report.
- Codex edits bypass Claude Code's own permission prompts and edit tracking; the
  report's `touchedFiles`/`preExistingChanges` and the Codex sandbox are the
  controls. Owner loss is detected by heartbeat with a 15 s grace, so a stop is
  near-immediate rather than instantaneous.
- The owner lease is lifecycle coordination between local processes, not an
  authentication boundary.
- Browser origin persistence follows the format used by the bundled browser
  service; a future runtime may change it.
- File tracking cannot attribute edits when several writers share a checkout, and
  ignored files and submodule contents are not hashed.

## Development

```bash
npm test
```

The suite (195 tests) uses temporary Codex homes and plugin data only, refuses to
run against `~/.claude/codex-isolated` or `~/.codex`, and asserts that no spawned
process survives. Local-socket tests are skipped inside a sandbox; run the suite
outside it for full coverage.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Based on
[openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc).
