# Duet — Claude Code × Codex

Duet turns Codex into a native Claude Code subagent. Claude plans, splits the
work and verifies the result; Codex workers do the investigation, implementation
or review in parallel, in an isolated Codex home, and come back with short,
recoverable reports instead of raw transcripts.

From Claude's side a Codex worker is just another `Agent` call: it can run in the
background, run alongside other workers, show live progress in the Agent panel,
ask Claude a question mid-task, be resumed with `SendMessage`, and stop when the
Agent is stopped.

Duet is a fork of [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc)
(upstream `db52e28` / 1.0.6). The review and rescue commands come from upstream;
the native worker runtime, isolation and lifecycle work are Duet additions.

## Highlights

- **Native parallel workers.** `Agent(subagent_type: "codex:codex-worker")` starts
  one Codex turn per assignment. Independent workers run concurrently; each keeps
  its own Codex thread, so follow-ups continue the right conversation.
- **Live progress.** Workers start the turn detached and loop `wait`. Each call's
  description is a short headline such as `running tests · 4m12s`, so the Agent
  panel shows what Codex is doing instead of a silent spinner.
- **Mid-task questions.** Codex can call `ask_parent`. The worker forwards the
  question to Claude, and the answer is fed back into the *same* Codex turn. An
  unanswered question times out (15 minutes by default) and Codex proceeds on a
  conservative assumption that it reports.
- **Clean cancellation.** Every job has an owner lease (180 s by default). Stopping
  the Agent lets the lease expire and interrupts the Codex turn; `cancel` reports
  confirmed versus unconfirmed termination; ending the Claude session interrupts
  that session's jobs. Idle brokers exit after 60 s.
- **Isolated home.** Authentication, sessions, SQLite and logs live in
  `~/.claude/codex-isolated`, separate from your everyday `~/.codex`. Credentials
  are never copied.
- **Honest reports.** Compact JSON reports separate captured facts from Codex's
  claims, list touched files against a before/after snapshot (pre-existing dirt
  reported separately), and keep handles for read-only recovery.
- **Browser work.** Optional Chrome/computer-use tooling, fresh session-owned tabs,
  and explicit, per-origin browser consent.

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
/plugin install codex@codex-isolated-local
/reload-plugins
```

The repository is private, so the GitHub form needs Git credentials that can read
it. The plugin keeps the `codex` command namespace: commands are `/codex:*` and the
agents are `codex:codex-worker` and `codex:codex-rescue`.

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

1. Claude spawns `codex:codex-worker` with a bounded assignment (objective,
   owned paths, constraints, acceptance criteria).
2. The worker runs `task --fresh --detached --json --report …`, which returns the
   job, thread and turn handles immediately.
3. It loops `wait <job> --timeout-sec 45`, updating its headline from each
   progress snapshot and renewing the owner lease.
4. If Codex calls `ask_parent`, `wait` returns `needs_answer`; the worker sends
   the question to Claude once, keeps short waits going, and passes the reply to
   `answer <job> --question <id>`.
5. On completion it returns a compact report (status, handles, touched files,
   verification, assumptions, blockers, and paths to the full raw output).

Follow-ups go to the same worker with `SendMessage`; it continues its own thread
with `task --thread <threadId> …`. Never use "the latest thread" to pick one
worker out of several.

### Defaults and runtime choices

| Choice | Default | Override |
| --- | --- | --- |
| Model | `gpt-6-astra` | `--model <name>` (`spark` maps to `gpt-5.3-codex-spark`) |
| Reasoning effort | `xhigh` | `--effort none…xhigh` or `--effort max` where the model supports it |
| Speed | normal | `--fast` requests the fast tier for that call only; `--normal` resets |
| Codex sandbox | `read-only` | `--write` → `workspace-write`; `--write --sandbox danger-full-access` only when deliberately requested |
| Approval policy | `never` | — |

Each follow-up resets to its own flags: write access, fast mode and browser
grants are never inherited from an earlier turn, and workers never elevate after
a denial. Companion Bash calls run with `dangerouslyDisableSandbox: true` because
the runtime needs network access and local sockets; that is separate from Codex's
own sandbox.

### Parallel work

Read-only workers may share a checkout. Concurrent writers need disjoint owned
paths or separate worktrees; shared files, lockfiles, indexes and generated
output need serialization. Job state uses interprocess locks and atomic writes;
all active jobs and the latest 50 finished jobs are kept.

## Commands

| Command | Purpose |
| --- | --- |
| `/codex:review [--base <ref>] [--background]` | Read-only Codex review of the working tree or a branch. |
| `/codex:adversarial-review [focus…]` | Steerable review that challenges design choices and assumptions. |
| `/codex:rescue <task>` | Hand a one-off task to Codex through the `codex-rescue` agent (`--resume`, `--fresh`, `--background`). |
| `/codex:transfer` | Turn the current Claude session into a Codex thread you can resume in Codex. |
| `/codex:status [job]` / `/codex:result [job]` | Inspect running or finished jobs and their stored output. |
| `/codex:cancel [job]` | Interrupt a job and report whether termination was confirmed. |
| `/codex:setup` | Readiness check plus the configuration actions below. |

Companion subcommands used by workers (`node scripts/codex-companion.mjs …`):
`task`, `wait`, `answer`, `status`, `result`, `cancel`, `setup`. Run it without
arguments for full usage.

### Review gate

```bash
/codex:setup --enable-review-gate
/codex:setup --disable-review-gate
```

When enabled, a `Stop` hook runs a targeted Codex review of Claude's last turn and
blocks the stop if it finds issues. This can create long Claude/Codex loops and
consume usage quickly; enable it only while you are watching the session.

## Configuration

All configuration changes below are explicit, idempotent, and write a timestamped
backup first. Unrelated configuration is preserved byte-for-byte.

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

- `ask_parent`, detached `wait`, lease expiry and cancellation are covered by
  fixture tests against a fake app-server; an authenticated end-to-end smoke of
  the new lifecycle is still pending.
- `ask_parent` relies on the app-server's experimental dynamic-tool API and is
  registered only on new threads. Threads started before this version, or
  runtimes that reject the registration, fall back to a final `needs_input` report.
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

The suite (168 tests) uses temporary Codex homes and plugin data only, refuses to
run against `~/.claude/codex-isolated` or `~/.codex`, and asserts that no spawned
process survives. Local-socket tests are skipped inside a sandbox; run the suite
outside it for full coverage.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Based on
[openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc).
