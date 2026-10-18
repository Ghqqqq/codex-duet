# Duet — Claude Code × Codex

Duet lets Claude Code delegate work to Codex. Claude plans, splits the work and
verifies the result; Codex workers investigate, implement or review in parallel
in an isolated Codex home, returning compact, recoverable reports.

Direct mode is the default: Claude starts `task --direct` in background Bash,
waits for Claude Code's completion notification, and reads one JSON line from the
output file. There is no Claude relay repeatedly reading a growing transcript,
which saves Claude quota on long jobs. The separate read-only `codex-live` pane
shows live activity without using Claude tokens. A thin Haiku agent remains a
fallback for surfaces without background Bash or for an agent transcript view.

Duet is a fork of [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc)
(upstream `db52e28` / 1.0.6). The review and rescue commands come from upstream;
the native worker runtime, isolation and lifecycle work are Duet additions.

## Highlights

- **Direct parallel jobs and a live pane.** Claude runs `task --direct` with
  background Bash; independent jobs keep their own Codex threads. Install
  `/plugin install codex-live@duet` for a read-only live view without Claude cost.
- **Lower Claude usage.** Direct mode prints no feed and returns one compact
  JSON line at completion, a pending question or the 3600 s timeout. Claude
  resumes on a notification, reads the report and acts; Haiku is only a fallback.
- **Mid-task questions.** Codex can call `ask_parent`, on new threads (dynamic
  tool) and resumed threads (per-thread `duet_parent` MCP bridge). Claude starts
  the returned `waitCommand` to keep the lease alive before answering through
  `answerCommand`; the reply continues the *same* Codex turn. An unanswered
  question times out (15 minutes by default), and Codex reports its conservative
  assumption or essential missing input.
- **Stops that stop.** Every job has a unique owner. While an owner wait is
  attached it heartbeats once a second. Stop the background task in Claude Code
  to interrupt the turn as `owner_stopped`; an owner killed outright is noticed
  within 5 s (`owner_lost`). The lease is 1800 s by default for direct mode,
  180 s otherwise. `cancel` reports confirmed versus unconfirmed termination;
  ending the Claude session interrupts that session's jobs. Idle brokers exit
  after 60 s.
- **Resume after a stop.** Direct reports carry
  `task --continue <jobId> --cwd <cwd> --direct`, starting one new turn on the
  same thread with the recorded settings and the user's consent. Still-running
  jobs can be adopted by a replacement owner without a new turn.
- **Isolated home.** Authentication, sessions, SQLite and logs live in
  `~/.claude/codex-isolated`, separate from your everyday `~/.codex`. Credentials
  are never copied. Job state (`duet/state/`) and plugin settings
  (`duet/config.toml`) live in the same home, so a terminal and a Claude
  session always see the same jobs.
- **Structured, honest reports.** Every worker turn ends with a schema-enforced
  JSON report from Codex (status, summary, key findings, assumptions,
  verification, blockers, question). Compact reports separate captured facts
  from Codex's claims, list touched files against a before/after snapshot
  (pre-existing dirt reported separately), and keep handles for read-only
  recovery.
- **Project instructions.** Workers read the project's `CLAUDE.md` wherever no
  `AGENTS.md` exists, through Codex's own `project_doc_fallback_filenames`
  (`setup --project-docs agents-only` turns it off).
- **Orchestration.** `/codex:ultra-codex <task>` runs a substantive task
  Ultracode-style: Claude scouts, assigns, judges and integrates; parallel Codex
  workers investigate, implement and adversarially review. See
  [docs/ultra-codex.md](docs/ultra-codex.md).
- **Browser and desktop work.** Optional Chrome/computer-use tooling, fresh
  session-owned tabs, an unrestricted browser by default, and Computer Use app
  approvals mirrored from the user's own Codex app (read-only on `~/.codex`),
  with per-app and per-call overrides. An app no list covers is asked of the
  parent at run time (allow this call / this task / always / deny). Denied
  approvals are reported as structured blockers, never as success.

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
that marketplace, add this one again, and install `codex@duet`. Job history is
kept automatically: see [Job state and migration](#job-state-and-migration).

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

### Direct mode (default)

Claude makes one Bash call per job, with `run_in_background: true` and
`description: "Codex: <label>"`. When Claude's Bash sandbox is on, it sets
`dangerouslyDisableSandbox: true` because the runtime needs network and local
sockets. SessionStart exports `CODEX_COMPANION`, the absolute path to the
companion, to every Bash call. Older sessions lack it: resolve
`../scripts/codex-companion.mjs` relative to the [protocol's prompts
folder](plugins/codex/prompts/ultra-codex-protocol.md) and use that absolute path.

```bash
node "$CODEX_COMPANION" task --fresh --direct --model gpt-6-astra --effort xhigh --normal <<'CODEX_TASK'
<brief: objective, context, owned paths, constraints, acceptance criteria>
CODEX_TASK
```

The prompt goes on stdin through a single-quoted heredoc, never on the command
line. Choose a delimiter absent as a complete line from the brief, and quote
dynamic runtime arguments separately. Read-only investigators and reviewers add
`--sandbox read-only`; another checkout adds `--cwd <dir>`. Parallel jobs need
disjoint OWNED PATHS, or separate worktrees Claude creates with `git worktree add`
and passes as `--cwd`.

The helper starts a detached job with this process attached as its owner wait.
It prints no feed and exactly one compact JSON line when the job ends, a question
is pending, or the timeout passes. Claude Code's completion notification carries
no output: Claude reads the output file it names. Never poll, sleep or tail.

- Terminal: run the [acceptance protocol](plugins/codex/prompts/ultra-codex-protocol.md#accepting-a-result-every-worker-report-no-exceptions),
  even after a nonzero exit. The structured report includes handles, runtime
  model/effort/serviceTier, touchedFiles/preExistingChanges/fileTrackingStatus,
  captured `verification` and `claimedVerification`, findings, assumptions,
  blockers and artifact paths, plus Codex's final `summary` (cut at 8000
  characters with `summaryTruncated: true`). It has `activityCount`, no
  `activity` list. Never read `rawOutputFile` unless a report field is
  insufficient.
- `running`: run its `waitCommand` (`wait <job-id> --owner <owner-id> --direct`)
  in the background again, then wait for the next notification.
- `needs_answer`: FIRST run its `waitCommand` in the background; its
  `--after-question <id>` keeps the lease alive without returning that question
  again. Then use `answerCommand` (`answer '<job>' --cwd ... --owner ...
  --question '<id>' --json`), with the answer text on stdin through a
  single-quoted heredoc. `question` supplies `id`, `kind`, `text`, `options` and
  `expiresAt`. Forward a Computer Use `question.kind` of `approval` with
  `AskUserQuestion` unless the user pre-authorised the app. The answer continues
  the same turn; never start a second wait after answering.
- `ownership_moved`: report it; do not reuse the retired owner or re-adopt.
- `error`: the call was rejected (conflicting flag, bad value, unknown job) and
  no job started. `owner_stopped`: the wait itself was stopped; the job is
  interrupted and the line carries its handles and `continuationCommand`.

Never run two waits for one job. Exit codes are 0 for `completed`, 2 for
`blocked`/`needs_input`, 1 for other terminal states, and 0 for non-terminal
returns. Direct mode rejects `--follow`, `--detached`, `--background`, `--json`,
`--feed-limit` and `--min-interval-sec`. It supports `--fresh`, `--thread`,
`--continue`, model/effort/speed, sandbox and approval flags, `--cwd` and stdin.

Follow-ups and rework start a new job on the same thread with
`task --thread <threadId> --direct`, the same `--cwd`, and the relevant criteria
restated. Never select a worker by "the latest thread". Verify claims with the
job/thread/turn handles, `result --report --json`, the actual diff and checks.

### Live view with codex-live

Install the separate pane plugin with `/plugin install codex-live@duet`. It
opens a pane automatically when a Codex job starts in the session on terminals
at least 144 columns wide; otherwise open it with its `codex-live` slash command.
It shows the session's jobs and the selected job's Codex messages, commands,
file changes, tool calls, plan and pending question. It is read-only: it never
starts, answers or cancels a job, and costs no Claude tokens. The pane reads
companion-written markers under
`<isolated home>/duet/sessions/<claudeSessionId>/`.

### Haiku fallback

Use `Agent(subagent_type: "codex:codex-worker")` only when direct mode cannot be
used, such as a surface without background Bash, or when the user asks for an
agent transcript view. Never pass `model` or `effort` to that agent; Codex's
model and effort go in the assignment text. The forwarder stays `model: haiku`,
`effort: low`, `omitClaudeMd: true`, `autoCompactWindow: 100000` in
[its definition](plugins/codex/agents/codex-worker.md).

The fallback runs `task --fresh --follow --report` with Bash `timeout: 600000`,
then `wait <job> --owner <ownerId> --report` on a `running` return (570 s wait
budget). Feed mode is only for this fallback; `--feed-limit` defaults to 60.
The worker sends `questionMessage` verbatim to Claude once per pending question
and accepts the reply via SendMessage; progress, status and completion messages
are forbidden. It returns the helper's final JSON line verbatim plus at most
5 lines of notes for stderr, retries or a relayed question, with no prose report.

Fallback follow-ups and rework start a NEW worker with `--thread <threadId>` and
the same `--cwd`; SendMessage to an existing worker is only for answering its
pending question. Final results arrive only as agent return values. The parent
still performs the same acceptance checks.

### If a worker is stopped

Stop the background task in Claude Code, or run `cancel <jobId> --json`.
Stopping its attached owner wait signals the helper, interrupting the Codex turn
as `interruptionReason: owner_stopped`. An owner killed outright is detected
within about 5 s (`CODEX_COMPANION_OWNER_GRACE_SEC`) as `owner_lost`. Thread context and on-disk edits
persist. A normal wait return (timeout, question, terminal state) leaves the job
protected by its lease. A stopped fallback agent cannot resume via SendMessage.

The direct report carries the exact `continuationCommand`:
`node '<companion>' task --continue '<job>' --cwd '<cwd>' --direct`. It starts
ONE new turn on the same thread with the original sandbox, model, effort, speed
and approval settings; any extra prompt text is appended. With the user's explicit consent,
Claude runs it in background Bash; nothing starts it automatically. If no thread handle was recorded, no continuation is available.
Use a new fallback worker only when direct mode cannot be used or the user
requests an agent transcript view; its continuation uses `--follow --report`.

A job still running after its owner returned normally stays alive for the lease
window (default 1800 s in direct mode, 180 s otherwise, from the last renewal;
`task --lease-sec`). With the user's explicit consent, a replacement owner whose
FIRST action is `adopt <jobId> --json` takes over that live turn. Adoption rotates
the ownerId and renews the lease, preserving the thread, turn, pending question
and delivered feed cursor; never submit a new task for an adoptable job. Start
one `wait <jobId> --owner <newOwnerId> --direct` in background Bash. The old
owner's wait/status/answer calls return `ownership_moved`; it must stop, never
re-adopt. Without adoption the job is interrupted at lease expiry
(`lease_expired`) with a continuation command. Parent `/codex:status`, `status`,
`result` and ownerless `wait` never renew the lease.

`/codex:status` marks stale running jobs **orphaned**, with remaining lease seconds
and an exact adopt instruction, after 65 s without renewal (or half a shorter
lease).

### Defaults and runtime choices

| Choice | Default | Override |
| --- | --- | --- |
| Model | `gpt-6-astra` | `--model <name>` (`spark` maps to `gpt-5.3-codex-spark`) |
| Reasoning effort | `xhigh` | `--effort none…xhigh` or `--effort max` where the model supports it |
| Speed | normal | `--fast` requests the fast tier for that call only; `--normal` resets |
| Direct-mode timeout | 3600 s | `--timeout-sec <seconds>` (maximum 3600) |
| Owner lease | 1800 s in direct mode; 180 s otherwise | `--lease-sec <seconds>` |
| Fallback feed limit | 60 lines per call | `--feed-limit <lines>` (`0` = unlimited; unavailable with `--direct`) |
| Codex sandbox | `danger-full-access` (full access, like the Codex app's own full-access mode) | Lower the default with `setup --default-sandbox read-only\|workspace-write` (stored in `~/.claude/codex-isolated/duet/config.toml`); narrow or widen one call with `task --sandbox <mode>`; `--write` is a floor (at least `workspace-write`), `--write=false` an explicit read-only call |
| Approval policy | `never+elicitations` on owned jobs (every command/sandbox/rule prompt rejected; a Computer Use app request is forwarded to the parent as a question); `never` on a plain foreground `task` | — |
| Browser | unrestricted: any website, no per-origin prompt (`approval_mode = "never_ask"` is mirrored into the isolated browser runtime before every task); network access stays on in every sandbox mode | `setup --browser-approval ask` restores the runtime's ordinary origin checks (saved in `duet/config.toml`); `setup --browser-approval never-ask` returns to the default |
| Computer Use apps | `mirror`: apps the user marked "always allow" in their Codex app (`~/.codex/computer-use/config.toml`, read-only) are copied into the isolated runtime's approval file before every task; any other app is asked of the parent during the task | `setup --computer-use-approval ask` stops the sync; `setup --allow-computer-app`/`--revoke-computer-app <bundle id>` adjust individual apps; `task --approve-computer-app <bundle id>` pre-approves one app for one call |
| Project instructions | `claude-md`: Codex reads `CLAUDE.md` where no `AGENTS.md` exists (`project_doc_fallback_filenames` in the isolated `config.toml`) | `setup --project-docs agents-only` |

The parent chooses a sandbox per call the way it would choose a permission mode
for a native subagent; without a flag the configured default applies. Each
follow-up uses its own flags and the current configured default; only
`task --continue` deliberately inherits the original job's settings. Per-call write access, fast
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
parallel work Claude uses direct mode, with `codex:codex-worker` as fallback (see above).

### `/codex:ultra-codex`

Orchestrates a substantive task with parallel Codex workers the way Claude
Code's Ultracode mode orchestrates Claude subagents. Claude scouts the code,
writes precise assignments, judges results and integrates; Codex workers do the
investigation, implementation and adversarial review, so the heavy lifting spends
Codex quota only.

```bash
/codex:ultra-codex on --thorough          # session mode: every substantive prompt is orchestrated
/codex:ultra-codex off                    # back to normal; lists Codex jobs still running
/codex:ultra-codex status
/codex:ultra-codex --quick add --json to the cancel command and cover it with a test   # one task, mode unchanged
```

`on` works like `/effort ultracode`: a per-session switch (keyed by the Claude
session id, so other sessions in the same repository are unaffected). While it
is on, a `UserPromptSubmit` hook adds a one-line reminder to every prompt and
Claude applies the orchestration protocol to each substantive task; chat,
one-line fixes and single-file questions stay inline. `off`, `/clear`, a new
session or the session's end turn it off; `--resume` keeps it. The saved scale
(`--quick`/`--thorough`, default auto) and `--max-workers` apply to every task
in the mode.

Because the workers share none of Claude's context, the command puts Claude's
effort at both ends of each assignment: every brief follows a fixed template
(objective, why, known context with file:line, interface contract, owned paths,
non-goals, acceptance criteria, verification commands, when to ask), and every
report goes through the same acceptance protocol (scope check, reading the diff,
criterion → evidence → verdict, verification and assumptions audits, then
`ACCEPT` / `ACCEPT WITH GLUE` / `REWORK` / `REASSIGN`). Phases: scout → understand
(parallel read-only workers) → design (thorough only, independent drafts judged
by Claude) → implement (disjoint ownership or worktrees) → accept → verify
(adversarial reviewers plus the test suite, loop until dry) → integrate.
`--max-workers <n>` caps concurrent workers (default 6). Details and the mapping
to Ultracode's Workflow tool: [docs/ultra-codex.md](docs/ultra-codex.md).

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

Workers already default to full access and an unrestricted browser, like the
Codex app's own full-access mode. What remains to opt into is the Codex App's
installed browser/desktop tools; preview the change first from the repository
root:

```bash
node plugins/codex/scripts/codex-companion.mjs setup --sync-tools --profile codex-app --replace-cua --dry-run --json
```

After reviewing the preview, rerun without `--dry-run` to apply. The defaults
can be lowered independently: `setup --default-sandbox read-only|workspace-write`
and `setup --browser-approval ask` (undo with `--default-sandbox
danger-full-access` and `--browser-approval never-ask`).
**Security:** together these grant full disk write access, desktop control, and
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

The sandbox default is stored in `<isolated-home>/duet/config.toml` and is
`danger-full-access` until you lower it. An explicit `task --sandbox <mode>` wins
for that call in either direction and needs no other flag; `--write` alone
guarantees at least workspace-write and `--write=false` requests read-only.
Lower the default with `setup --default-sandbox read-only` or `workspace-write`;
use `task --sandbox read-only` for one call. Review commands remain read-only.

The browser is unrestricted by default. Before every task the plugin mirrors
top-level `approval_mode = "never_ask"` into the isolated `browser/config.toml`
when the key is absent, so any website opens without a per-origin prompt, and
every sandbox mode (even `--sandbox read-only`) keeps network access on.
`setup --browser-approval ask` removes that key and records the choice in
`duet/config.toml` so later tasks leave it absent; existing per-origin grants
and download/upload/history settings remain unchanged, and a hand-edited custom
value is never overwritten. `setup --json` reports `defaultSandbox`,
`browserOrigins.approval` (the file) and `browserOrigins.preference` (the saved
choice); `setup --list-browser-origins --json` includes the same. See
[worker operations](docs/worker-operations.md#codex-app-profile) and
[browser approvals](docs/browser-approvals.md#all-sites-browser-approval-the-default).

### Computer Use app approvals

Codex's Computer Use tooling asks before it drives a macOS app. The user's own
Codex app records a "This session" choice in
`~/.codex/computer-use/sessions/<thread>.toml` and an "Always" choice in
`~/.codex/computer-use/config.toml` (`[apps] allowed`). The isolated runtime reads
its own copy, `~/.claude/codex-isolated/computer-use/`. An owned worker job
runs with approval policy `never+elicitations`: an app that is not listed there
pauses the tool call and reaches the parent as a question with four fixed
options (`Allow this call`, `Allow for this task`, `Allow always (isolated Codex
home)`, `Deny`); denied, it fails with `Computer Use was not approved to use
<App>` and the report is `blocked`.

By default (`computer_use_approval = "mirror"`) every task first copies the apps
from the user's global `[apps] allowed` list into the isolated file. Only
"always allowed" apps cross over: session-level choices, the `denied` list and
anything an organization policy blocks are never copied, and `~/.codex` is
only read. The isolated file is validated, backed up privately and written
atomically; a second pass changes nothing.

```bash
node scripts/codex-companion.mjs setup --list-computer-apps --json          # read-only preview
node scripts/codex-companion.mjs setup --computer-use-approval ask          # stop syncing
node scripts/codex-companion.mjs setup --computer-use-approval mirror       # default
node scripts/codex-companion.mjs setup --allow-computer-app com.google.Chrome
node scripts/codex-companion.mjs setup --revoke-computer-app com.apple.finder
node scripts/codex-companion.mjs task --approve-computer-app com.google.Chrome "…"
```

`--allow-computer-app` adds an app to the isolated runtime even in `ask` mode;
`--revoke-computer-app` removes it and keeps it out of later mirrors until it is
allowed again. Both take bundle identifiers (`com.google.Chrome`), support
`--dry-run` and `--json`, and never run from a worker. `task
--approve-computer-app` approves only the listed apps, only for that call: the
grant is written as a session-scoped approval for the job's own thread while the
turn runs and withdrawn afterwards; a follow-up on the same thread does not
inherit it, `task --continue` does. If the user has only ever chosen "This
session" in the Codex app, mirror finds nothing to copy; choose "Always" there,
use `--allow-computer-app`, or answer the forwarded question when a worker asks.
"Allow for this task" grants the app to that worker's thread until the turn
ends; "Allow always" adds an explicit entry to the isolated home's list, never to
`~/.codex`. Details: [Computer Use approvals](docs/computer-use-approvals.md).

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
schema-defined, network-only command approval for the current turn. With the
unrestricted default and network access on in every sandbox mode it is normally
unnecessary. Unsupported browser elicitations are answered with `cancel`, which
the browser runtime does not persist as a deny. Details:
[browser approvals](docs/browser-approvals.md).

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

### Job state and migration

Job records, logs and result artifacts live in the isolated home, next to the
plugin's settings file:

```text
~/.claude/codex-isolated/duet/config.toml                  # default sandbox, browser and Computer Use approval
~/.claude/codex-isolated/computer-use/config.toml           # isolated Computer Use app approvals (mirrored + explicit)
~/.claude/codex-isolated/duet/state/<workspace>/state.json # per-workspace job index
~/.claude/codex-isolated/duet/state/<workspace>/jobs/      # <id>.json, .log, .output.txt, .result.json
~/.claude/codex-isolated/duet/state/<workspace>/broker.json
```

`<workspace>` is a slug plus hash of the workspace root. Directories are created
`0700`, files `0600`. The location depends only on the isolated home
(`CODEX_COMPANION_HOME` or `~/.claude/codex-isolated`), so a terminal, a Claude
session and the SessionEnd hook read and write the same records;
`CLAUDE_PLUGIN_DATA` is no longer involved.

Earlier releases stored state under `CLAUDE_PLUGIN_DATA/state`, which Claude Code
derives from the plugin ID (`~/.claude/plugins/data/codex-codex-isolated-local`,
then `~/.claude/plugins/data/codex-duet`), and under
`$TMPDIR/codex-companion-isolated` when the companion ran outside Claude. The
first command that touches a workspace merges those directories into the new one,
once, under the new directory's state lock:

- Nothing is overwritten and nothing is deleted. A job present in several places
  keeps the record with the newer `updatedAt`; the index is deduplicated by ID;
  the old directories stay where they are.
- Absolute artifact paths (`logFile`, `rawOutputFile`, `resultFile`) are kept as
  recorded and remain readable in place; nothing is rewritten.
- A legacy job whose worker is still running is served in place until that
  worker ends, so `wait`, `status`, `cancel` and SessionEnd keep working through
  the upgrade; it is merged afterwards.
- A busy legacy lock is retried later rather than waited on. Concurrent first
  commands migrate once; the marker is `<workspace>/.legacy-migration.json`.
- `status`/`result`/`wait`/`adopt`/`cancel`/`task --continue` with a job or thread
  ID that is unknown to the new directory look in the legacy directories and
  import the match, so a job an older session writes after the merge is found.

Record format, owner/lease semantics and command output fields are unchanged.
Once no older release runs anymore, the legacy directories can be removed by
hand.

### Retention

At session start, Duet's detached prewarm child cleans ended job records, session
markers and old Codex threads that no retained job uses, at most once every 12
hours. It follows `cleanupPeriodDays` in `${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json`
(default 30 days); `CODEX_COMPANION_RETENTION_DAYS` overrides it. Values below one
are clamped to one day and reported. The 50-ended-job cap remains a second bound.
Running/queued jobs, attached owners and live worker PIDs are protected. Threads
use rollout last-activity time and are deleted through Codex's `thread/delete`
API, keeping its indexes consistent; unavailable deletion is reported and skipped.
Jobs with legacy artifact paths are kept and listed under `retained`, separately
from errors. Their threads stay protected while unrelated old threads can expire.

Preview with `node "$CODEX_COMPANION" cleanup --dry-run --json`; apply with
`node "$CODEX_COMPANION" cleanup --json`. Both ignore the 12-hour limit; `--days N`
overrides the period for that command. Nothing is removed immediately on job
completion, so results, continuations and pane history remain available during
the retention period (subject to the count cap).

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

**`status: blocked` with `computer_use_app_not_approved`.** The worker tried to
drive an app (`blockers[].app`) that the isolated runtime has not approved. Check
`setup --list-computer-apps --json`: in `mirror` mode the app must be "Always"
allowed in the user's Codex app (or added with `setup --allow-computer-app`); in
`ask` mode the parent must pass `task --approve-computer-app <bundle id>` for that
call. `computer_use_app_blocked_by_policy`/`computer_use_app_forbidden` come from
Codex's own policy and cannot be overridden here. `browser_tab_debugger_unattached`
names a tab (`tabId`, `sessionId`, `closed`) the worker could not inspect or
close; close it manually if `closed` is `false`. `reported_blocked` means Codex's
own final answer declared itself blocked. Blocked tasks exit 2, like `needs_input`.

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
  per-thread MCP bridge, owner loss (`owner_stopped`/`owner_lost`) and
  `--continue` were also exercised live against the real app-server
  (`codex-cli 0.162.0-alpha.17.2`), including back-to-back `ask_parent` round
  trips on one resumed thread; that live smoke is still a manual step, not CI.
- `ask_parent` uses the app-server's experimental dynamic-tool API on new threads
  and a per-thread MCP server override on resumed threads. Runtimes that reject
  either registration fall back to a final `needs_input` report.
- Codex edits bypass Claude Code's own permission prompts and edit tracking; the
  report's `touchedFiles`/`preExistingChanges`, the Codex sandbox and your git
  history are the controls (`git diff`/`git status` show everything a worker
  changed; Claude's own rewind does not). An owner that is killed outright
  (SIGKILL) is detected by heartbeat with a 5 s grace; a signalled stop is
  immediate.
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

## Development

```bash
npm test
```

The suite (202 tests) uses temporary Codex homes and plugin data only, refuses to
run against `~/.claude/codex-isolated` or `~/.codex`, and asserts that no spawned
process survives. Local-socket tests are skipped inside a sandbox; run the suite
outside it for full coverage.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Based on
[openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc).
