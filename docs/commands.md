# Commands

Slash commands and companion subcommands. Back to the [README](../README.md).

## Slash commands

### `/codex:review`

Runs a read-only Codex review of your uncommitted changes, or of your branch
compared to a base such as `main` with `--base <ref>`. It supports `--wait` and
`--background`, and takes no focus text; use `/codex:adversarial-review` for that.
Both reviews run at the repository root, even when invoked from a subdirectory.
Auto scope selects the whole working tree when dirty, otherwise a branch diff.
`--scope working-tree|branch` makes that choice explicit. Default-base discovery
prefers the local branch named by `origin/HEAD`, falling back to its remote-tracking
ref; without that symbolic ref it checks `main`, `master`, then `trunk` (local,
then remote). An explicit or detected base that does not resolve to a commit
fails before a review starts.

Both review commands accept `--model <model>` and `--effort <effort>` overrides.
Omitted values use the saved worker defaults, built-in `gpt-6-astra` / `xhigh`,
just like fresh tasks. See [worker models](configuration.md#default-worker-models).

```bash
/codex:review
/codex:review --base main
/codex:review --effort high
/codex:review --background
```

### `/codex:adversarial-review`

A steerable review that challenges the chosen design: assumptions, tradeoffs,
failure modes and safer alternatives.
It uses the same review target selection as `/codex:review`, including `--base <ref>`,
and accepts focus text after the flags. It is read-only. With `--args-stdin` and
no explicit separator, the companion reads recognized options from the start;
the first other token starts focus, preserving its remaining text and order.
Quotes, apostrophes, backslashes, internal spaces and newlines survive; only
surrounding whitespace is trimmed. Exact trailing `--wait`, `--background` and
`--json` tokens are still extracted as options. Recognized option-like words
elsewhere inside focus remain literal.

Typo checks and missing-value errors apply only in the option prefix. An unknown
prefix option within two character edits of a supported one (for example
`--baes`) is rejected with a suggestion; other unknown flags can start focus.
An explicit standalone, unquoted `--` makes everything after it literal,
including trailing execution flags. Use it when focus starts with something
option-like. `--model` without a value, including immediately before `--`, is an
error. These raw-focus rules belong to review `--args-stdin`; direct argv and
other commands retain their existing tokenization.

```bash
/codex:adversarial-review
/codex:adversarial-review --base main challenge whether this was the right caching and retry design
/codex:adversarial-review don't miss the race in parser.js
/codex:adversarial-review check auth --background
/codex:adversarial-review -- --baes main
```

Both review slash commands pass raw `$ARGUMENTS` unchanged through `--args-stdin`
and a single-quoted heredoc in foreground and background mode. Claude does not
split, reorder or unquote them; the companion parses the options and focus.
Use the same pattern when invoking the companion directly; `$()`, backticks and
dollar signs in focus text reach the argument parser without shell expansion:

```bash
fugato review --args-stdin <<'DUET_ARGS'
--base main
DUET_ARGS

fugato adversarial-review --args-stdin <<'DUET_ARGS'
--base main check whether $(refresh) and `retry` are treated as literal input
DUET_ARGS
```

Choose a different delimiter if any argument line is exactly `DUET_ARGS`, changing
both delimiters together. For background execution, run the same command with
Claude's `Bash(..., run_in_background: true)`; `--background` is only a routing hint
to the slash command. Do not embed focus text in shell-expanded strings.

Adversarial review lists untracked symlinks as `(symlink, not inlined)` without
reading their targets. Only regular files whose real paths remain inside the
repository are eligible for inlining; files outside the repository are never
read by this collector. Path collection preserves non-ASCII and quoted names.
Untracked inlining is capped at 24 KiB per file (`MAX_UNTRACKED_BYTES`),
256 KiB including framing (`MAX_INLINE_UNTRACKED_BYTES`) and 32 files
(`MAX_INLINE_UNTRACKED_FILES`). Each file is read through one descriptor opened
without following symlinks; a file replaced or grown during collection is
omitted. An omission manifest gives paths, observed sizes and
reasons, and the reviewer is told to collect omitted content itself. Git metadata
commands have an 8 MiB limit (`MAX_GIT_METADATA_BYTES`); overflow fails explicitly
instead of reviewing silently truncated output.
A failed native review keeps its failure reason in the report and summary.
An otherwise successful turn with empty native output, or empty, malformed or
schema-invalid adversarial output, becomes a failed `review_output_invalid` job
(exit 1). New review jobs save raw output and result artifacts even on invalid
output. `fugato result <jobId> --details` exposes the complete review text/findings
and artifact paths; the compact summary keeps its 8,000-character cap. Older
jobs are not backfilled with artifacts.

### `/codex:rescue`

Hands a one-off task to Codex through the `codex:codex-rescue` subagent: investigate
a bug, try a fix, continue a previous Codex task, or take a cheaper pass with a
smaller model. It supports `--background`, `--wait`, `--resume` and `--fresh`.
The subagent is a Haiku forwarder: it passes the request verbatim after extracting
routing and runtime flags, without rewriting, tightening or summarizing the
prompt. Haiku is the forwarding model; Codex's model and effort come from explicit
flags or the saved worker defaults (recorded settings on follow-ups).

```bash
/codex:rescue investigate why the tests started failing
/codex:rescue --resume apply the top fix from the last run
/codex:rescue --model gpt-5.4-mini --effort medium investigate the flaky integration test
/codex:rescue --model spark fix the issue quickly
```

Fresh delegated tasks use the configured worker model (default `gpt-6-astra`)
and worker effort (default `xhigh`) when no explicit user choice or flag
overrides them; follow-ups retain recorded thread settings. See
[Default worker models](configuration.md#default-worker-models).
If you say `spark`, the plugin maps that to `gpt-5.3-codex-spark`. For planned,
parallel work Claude honors the saved [worker dispatch](configuration.md#worker-dispatch)
route: `bash` selects background `fugato task` immediately, while `auto` prefers it
for 24 hours after the last native-unavailable observation, or until
`fugato setup --dispatch` is run without `--dry-run`. Otherwise Claude
uses `codex:codex-native` from the first dispatch, without waiting for readiness.
Background `fugato task` also handles `native_adapter_unavailable`,
`native_capacity`, per-call options the `DUET:` line rejects, or follow-ups to
Bash-launched workers; `codex:codex-worker` is the Haiku fallback when neither
path is available. See [direct mode](direct-mode.md).

### `/codex:ultra-codex`

Orchestrates substantive work with parallel Codex workers. Claude scouts,
briefs, judges and integrates. Readers, independent designs/judges, area × lens
reviews and varied searches scale to the work-list. Each accepted item advances
when its dependencies are ready; wait for all results only for a shared contract,
comparison, deduplication or integration. Conversation and trivial mechanical
edits stay inline; a single-file question is not an exemption.

```text
Usage: /codex:ultra-codex [on [--quick|--thorough] [--max-workers <n|auto|unlimited>] [<task>] | off | status | [--quick|--thorough] [--max-workers <n|auto|unlimited>] <task>]

/codex:ultra-codex on --thorough --max-workers auto
/codex:ultra-codex --quick add --json to the cancel command and cover it with a test
/codex:ultra-codex status
/codex:ultra-codex off
```

`--quick`/`--thorough` choose depth (default `auto`), with at most one selected.
The default cap follows native Ultracode: min(16, CPU count − 2) workers in
flight, with a minimum of one (16 on an 18-core Mac). `--max-workers` raises or
lowers it: `auto` uses that formula, integers must be 1–64, and `unlimited`
removes it. The cap limits concurrency, never coverage; excess work queues and
existing saved caps are retained. It is advisory, not a runtime scheduler.
Sixteen native read-only workers were measured in flight together; larger or
heavy mutating fan-out is not a measured guarantee.

Ultra uses the configured routine model (default `gpt-6.1-sol`) at `medium` for
scanning/triage and `xhigh` for implementation, investigation and ordinary
review; the configured worker model (default `gpt-6-astra`) at `xhigh` or
supported `max` is for adversarial verification, judging, hard debugging and deep
architecture. Speed is normal unless requested. The mode reminder names the
effective models. Details: [ultra-codex](ultra-codex.md).

### `/codex:pair`

One worker on the configured worker model (default `gpt-6-astra`) and worker
effort (default `xhigh`) at normal speed executes a bounded task end to end.
Claude plans, writes a full brief and accepts every diff with its own checks.
Rework stays on the same thread, at most two rounds after the initial
result. An optional read-only verifier runs sequentially on a stable candidate;
there is no fan-out. Pair has no mode options.

```text
Usage: /codex:pair [on [<task>] | off | status | <task>]

/codex:pair on
/codex:pair fix the failing parser test
/codex:pair off
```

Recommend ultra for breadth or competing investigations, duel for contested
designs or high-risk assumptions; switching requires an explicit mode-control
request. See [pair](pair.md) for acceptance, limits and escalation.

### `/codex:duel`

One Claude general-purpose subagent versus one Codex worker on the configured
worker model (default `gpt-6-astra`) and worker effort (default `xhigh`) at
normal speed. The Claude participant inherits the session model and consumes
the owner's Claude quota. Claude's main loop relays every substantive exchange
and arbitrates: builder/breaker for implementation, independent drafts followed
by reciprocal critique for design/analysis.

```text
Usage: /codex:duel [on [--rounds <n>] [<task>] | off | status | [--rounds <n>] <task>]

/codex:duel on --rounds 2
/codex:duel --rounds 2 compare these two designs
/codex:duel off
```

`--rounds` sets the total cap including the initial build/drafts and critique:
integer 1–3, default 3. Only the builder writes; default Codex builder/Claude
breaker may be reversed by an explicit task request. There is no role flag.
Unresolved blockers or unverified required criteria at the cap are incomplete
outcomes. See [duel](duel.md) for flows, convergence and quota costs.

### `/codex:roundtable`

Persistent Codex personas pursue one goal through experiments, implementation
and a public forum; Claude chairs and accepts the final candidate on evidence.
The chair recommends intensity and roster for confirmation unless supplied.

```text
Usage: /codex:roundtable [on [--intensity light|standard|deep|full] [--roles id,id] [<task>] | off | status | [--intensity light|standard|deep|full] [--roles id,id] <task>]

/codex:roundtable --intensity deep investigate the reconnect failure
/codex:roundtable on --roles steward,critic,improver
/codex:roundtable off
```

Intensities seat 2/3/5/6 members. `--roles` selects a nonempty unique subset of
`conjecturer,critic,steward,improver,integrator,calibrator`; invalid intensity or
persona ids fail before dispatch. There is no token cap; members are Codex-only.
See [Roundtable](roundtable.md) for the research, mapping, forum and chair.

### Orchestration controls

All four commands share `[on [<mode-options>] [<task>] | off | status |
[<mode-options>] <task>]`. No arguments means status. `on` enables the selected
mode; `on <task>` first validates and saves settings, then runs the task with
those returned settings. Failed activation starts no task. Exact `off`/`status`
are controls and reject extra task text. Leading mode options without `on`
require a task. Unknown leading options are errors. `--help`/`-h` before task
text shows usage/options and stops without enabling or loading the protocol.

Only one mode is saved per Claude session across workspaces. `on` replaces the
previous mode and its options. Named `off` clears only that mode; another active
mode is unchanged. A task command selects its own mode once, without altering
the session record, even when another mode is active. Task-prefix options
override matching saved options; without a matching active mode, defaults apply.
Normal prompts use the active mode and accept its leading per-task overrides.
Parse options only before task text: later option-like words remain literal.
`--` starts literal task text, including `on`, `off`, `status` or an option-like
word (for example `/codex:pair -- status the parser`). A task keeps its selected
mode; it never silently switches modes to evade a limit.

While enabled, one hook adds a versioned mode reminder to normal prompts and
suppresses it for all four mode commands. Ultra/pair/duel reminders name their
effective worker defaults; roundtable names its intensity and roster selection
and points to the persona mapping.
Controls do not load protocol text into Claude's context. Tasks use the shared
[protocol](../plugins/codex/prompts/ultra-codex-protocol.md), selecting shared
sections plus their own mode section. Its body hash is computed at runtime;
`status --for-command` reports the current version/path, not a saved literal hash.
See [state and lifecycle](state-and-retention.md#orchestration-mode-state) for
schema migration, retained caps, resume/compaction and cleanup.

Every mode retains precise briefs, native-first dispatch, the existing Bash
fallback rules and the [run journal](run-journal.md). Claude fully accepts every
changed deliverable: scope, complete diff, criteria/evidence, rerun checks,
assumptions and an explicit verdict. Read-only probes use the lighter evidence
pass, with adversarial confirmation of decision-driving findings and full
acceptance for consequential/conflicting claims. Details:
[acceptance](../plugins/codex/prompts/ultra-codex-protocol.md#accepting-a-result-every-worker-report-no-exceptions).

CLI mode controls never take task text or start workers:

```text
fugato ultra-codex [on|off|status] [options]
fugato pair [on|off|status] [options]
fugato duel [on|off|status] [options]
fugato roundtable [on|off|status] [--intensity light|standard|deep|full] [--roles id,id]

fugato ultra-codex on --thorough --max-workers unlimited
fugato pair on
fugato duel on --rounds 2
fugato duel status --for-command
```

For roundtable, bare status/no action reports the mode; `status <roomId>`
selects the room. Its start/pause/resume/close actions are room controls, not
mode switches. Mode off/replacement leaves rooms and jobs intact.

Omitted mode action is status. All accept `--cwd <dir>`/`-C <dir>`, `--session <id>`,
`--json`, `--help`/`-h`, and `status --for-command`. Mode options are valid only
with `on`; `--for-command` only with `status`, even when explicitly set to
`false`. Pair rejects ultra/duel options, duel rejects ultra options, and ultra
rejects `--rounds`. Unknown flags, contradictory scale flags, invalid numbers
and extra positionals fail before state changes. Help takes precedence over
invalid arguments and performs no state/runtime setup. SessionStart supplies
the session ID; `on`/`off` need one, while status without one reports off.

JSON `mode` is `on`/`off` for the requested command; `modeName` names that
command, and `activeMode` reports the actual saved mode/options even if it is
different. Status shows the effective worker model/effort and ultra routine
model; JSON includes `models: { model, effort, routineModel }`. Roundtable also
reports `personaModels` with per-field values/sources; its text status lists
these standard persona mappings instead of ordinary worker defaults.
`protocolFile` and `protocolVersion` are always present. Ultra keeps
effective `maxWorkers` (null for unlimited) plus `maxWorkersSetting`. A cross-mode
`on` adds `replacedMode` and `runningJobs`; `off` reports `wasOn` and running jobs.
An empty Codex job list says nothing about a duel's Claude participant: Claude
reports its tracked state separately. Switching/off does not cancel, transfer
or resume jobs; settle conflicting writes before new assignments. User-stopped
work continues only with consent. Natural-language stop ends new dispatch
immediately and reports in-flight workers.

### `/codex:transfer`

Creates a persistent Codex thread from the current Claude Code session and prints
the isolated `codex-isolated.mjs --home <directory> resume <session-id>` command,
so you can continue the same context directly in Codex. `--source <jsonl>`
overrides the transcript path supplied by the SessionStart hook.

### `/codex:status`

Shows running and recent Codex jobs from this Claude session in the current
repository, or one job with `/codex:status <job-id>`. `/codex:status --all` adds
jobs from other sessions in the same workspace, each labelled with its session.
A pending question shows its text, choices and remaining answer time without
answering or renewing the lease. Scope filtering happens before the 50-ended-job
history cap, so other sessions cannot crowd this session out. The default view
also applies `DEFAULT_MAX_STATUS_JOBS` (8), preserving running/unresolved work;
`--all` removes that smaller display limit. JSON includes `historyOmitted`, the
number of retained jobs hidden by these limits within the selected scope; text
prints nonzero omissions. It does not count records already deleted by retention.
Its activity feed uses only the newest 500 events retained per job. Cumulative
event totals remain available as `activityCount` in result details when no
payload-specific count is present; see [activity retention](worker-lifecycle.md#fallback-and-compatibility-feed-mode).

`fugato status <worker>` shows the worker name, model, effort and sandbox, followed
by recent structured activity: commands with exit status when known, file changes
and message snippets. The job list includes worker names and model/effort.
List status also prints input, cached-input, output and total token usage for
the jobs shown, plus counts of jobs with and without usage. JSON exposes these
as `usageTotals`; missing usage is counted rather than treated as zero.

### `/codex:result`

Returns report v2: status, worker, jobId, summary, nonempty evidence, `next` and
`details`. Add `--details` for full evidence, handles, runtime settings, artifact
paths and complete review findings. Compact blockers already retain bounded
app/tab/session identifiers, cleanup status and safe approval identifiers when
captured; `--details` preserves the full stored fields. It retrieves a result
without starting another turn.

### `/codex:cancel`

Interrupts an active job and reports whether termination was confirmed.
`/codex:cancel --all` (or `fugato cancel --all`) cancels every active job of the
current Claude session in this workspace and prints each job's outcome.
Other sessions are untouched. `--all` cannot be combined with a worker argument;
outside a Claude session, supply `--session <id>`.

Transfer, status, result and cancel pass raw `$ARGUMENTS` unchanged through
`--args-stdin` and a single-quoted heredoc, just as the review recipes do. The
companion tokenizes all arguments for these four commands; it does not use the
reviews' literal-focus rules. Quoted paths with spaces work, and `$()`, backticks
and dollar signs are not expanded by the shell. For example:

```bash
/codex:status --cwd '/work/my repo/sub' --all
/codex:result Ada --cwd '/work/my repo/sub' --details
```

Direct companion calls can use `fugato status --args-stdin <<'DUET_ARGS'` with the
same raw arguments on stdin; choose another delimiter if a line equals `DUET_ARGS`.

### `/codex:setup`

Checks whether Codex is installed, reachable and logged in. If Codex is missing
and npm is available, it can offer to install Codex for you. It also runs the
configuration actions described under [Configuration](configuration.md).
For API-key authentication, use the [isolated login procedure](troubleshooting.md#sign-in-with-an-api-key).

```text
fugato setup --default-model <model|default> [--default-effort <effort|default>] [--ultra-routine-model <model|default>]
/codex:setup --default-model <model|default> [--default-effort <effort|default>] [--ultra-routine-model <model|default>]
```

Each model/effort flag also works alone; they may combine with each other and
`--dry-run`, but not another setup change. `default` removes the saved key.
All values are validated before any write. The JSON change report and setup
status show the effective values and each setting's `saved`/`built-in` source;
mode reminders and status show the effective models too. For built-ins,
precedence, examples and validation limits, see
[Default worker models](configuration.md#default-worker-models).

`fugato setup --default-mode off|ultra|pair|duel|roundtable` saves the orchestration mode for
fresh Claude sessions and `/clear` (default `off`); run it separately from other
setup changes, with `--dry-run` to preview. See
[default orchestration mode](configuration.md#default-orchestration-mode).

`fugato setup --persona-model id=model[:effort]` saves a persona mapping;
repeat the flag for different ids, or use `id=default` to remove both fields.
Run it separately from other setup changes; `--dry-run --json` previews without
writes. Setup JSON includes `personaModels` with effective model/effort values
and per-field `saved`/`built-in` sources. Model-only changes clear the saved
effort. See [persona models](roundtable.md#models-and-redefinition).

`fugato setup --dispatch auto|native|bash|default` selects Claude's dispatch
guidance; run it separately from other setup changes. See
[worker dispatch](configuration.md#worker-dispatch).
The opt-in settings `--permission-mapping claude|off`,
`--default-max-minutes <n|off>`, `--default-max-tokens <n|off>`,
`--agent-memory on|off` and `--max-concurrent <n|off>` all default to `off`.
Each supports `--dry-run`; see [configuration](configuration.md#claude-permission-mapping-opt-in)
for examples, grouping rules, the permission mode table and limits.
For a desktop-managed CLI, setup includes `codex.warning` with code
`desktop_managed_codex_runtime` and a message, also shown in human next steps.
The warning can appear while `ready` is true and never changes the selected pin.
See [runtime selection](configuration.md#runtime-selection) for the managed paths
and how to pin a stable CLI.
Setup uses a 45-second readiness deadline (`SETUP_READINESS_TIMEOUT_MS`).
Node/npm version checks cap at 10 seconds each (`TOOL_VERSION_TIMEOUT_MS`);
Codex version/help probes at 20 seconds each (`EXECUTABLE_PROBE_TIMEOUT_MS`),
initialization at 30 seconds (`INITIALIZE_PROBE_TIMEOUT_MS`) and account/config
requests at 20 seconds each (`AUTH_REQUEST_TIMEOUT_MS`), constrained by the
remaining setup deadline. When a pinned runtime is broken, optional PATH Codex
version/help diagnostics share that same deadline, capped at 20 seconds each
(`DIAGNOSTIC_PROBE_TIMEOUT_MS`) and skipped when no budget remains. They only
enrich repair guidance; setup still reports the broken pin. Outside setup,
availability/auth probes default to a 60-second overall deadline
(`READINESS_TIMEOUT_MS`). These generous ceilings
guard against hangs; they are not expected startup durations. Shutdown can add
brief overhead. A stalled Codex probe returns
`ready: false`, `auth.status: "unreachable"`, `auth.reason: "timeout"`; it is not
evidence of logout and does not produce a login recommendation.

The optional review gate runs a targeted Codex review of Claude's last turn from a
`Stop` hook and blocks the stop if it finds issues. It always passes `--sandbox
read-only`, including in plan mode, regardless of the configured default:

```bash
/codex:setup --enable-review-gate
/codex:setup --disable-review-gate
```

The gate reviews at most once per user turn. When Claude stops again after a gate
block (`stop_hook_active`), the gate allows the stop with a note and does not
re-review the follow-up changes; run `/codex:review --wait` for them. A review that
fails, times out or returns an unexpected answer also allows the stop and shows
its reason as a note; only explicit findings block. The gate also allows the stop
with a note, without running a review, when the Git working tree is clean
(including no untracked files) or a writable Fugato task is queued or running in
the workspace, even from another session. Gate reviews use ephemeral threads
and never become `--resume-last` targets. A `BLOCK` shows up to four lines of
findings and the review job ID with `fugato result <jobId>` for the full result.
An eligible first stop costs one Codex review turn; skipped gates and follow-up
stops cost none.

## Companion subcommands

`fugato` is the canonical CLI. `duet` remains a compatibility alias to the same
implementation and state.

`fugato models [--json] [--all]` lists the current account's Codex models,
descriptions, supported/default efforts and context windows, followed by Fugato's
effective strong/effort/routine tiers and their sources. It prefers app-server
`model/list`, falling back to the isolated model cache, and names the source.
Hidden models require `--all`; unknown context windows are `null` in JSON.
If neither source is available it exits nonzero and points to `/codex:setup`.
The model-invocable `codex:models` skill explains tier selection, setup changes,
one-off overrides and confirmation; see [configuration](configuration.md#default-worker-models).

Use `fugato <subcommand>` in a Claude session, or `plugins/codex/bin/fugato` from the
repository root. Run `fugato task --help` for flags and side-effect-free examples.
SessionStart supplies the session ID; `--session <id>` overrides it.

### Shared runtime

`fugato runtime status` inspects the current workspace without starting a broker
or app-server. It shows the selected Codex binary, selection source and version,
plus the saved broker's PID, alive/reachable state and endpoint, if present.
It checks whether the broker's runtime identity matches the selected binary or
is stale (unknown when it cannot compare); JSON also exposes `homeMatches`.
Busy state is `unknown` in status; status does not establish that restart is safe.

`fugato runtime restart` asks the broker to retire only when idle. A busy broker
refuses and lists the workspace's running workers, including other sessions;
no worker is force-stopped. An unreachable or incompatible broker also refuses
when safe shutdown cannot be confirmed. The command does not start a replacement:
the next task starts a fresh broker. Both commands accept `--cwd <dir>` and
`--json`.

| Command | Use |
| --- | --- |
| `fugato task` | Fresh assignment; brief only on stdin; implies `--direct` |
| `fugato task --name <label>` | Request a name on a fresh thread; collisions fall back to the pool; follow-ups retain their name |
| `fugato task --cwd <repo>/sub` | Start or resume the Codex thread in that subdirectory; broker/job state remains at the repository root |
| `fugato task --run <id\|none>` | Override journal linkage for this dispatch only; select an open run across workspaces or skip linking with `none`; follow-ups do not inherit it |
| `fugato task --to <worker>` | New turn on that worker's thread/cwd, inheriting recorded settings unless overridden |
| `fugato task --fork` | Import the current Claude transcript into a new thread, then run the stdin brief; fidelity not verified |
| `fugato task --max-minutes <n> --max-tokens <n>` | Per-turn running-time/token budgets; either flag can be used alone |
| `fugato answer <worker> --question '<questionId>'` | Answer the displayed question ID from stdin and keep waiting; prefer the report's `next` verbatim |
| `fugato wait <worker>` | Attach the sole owner wait and renew its lease |
| `fugato result <worker>` | Retrieve report v2 if missing from the completion notification |
| `fugato result <worker> --details` | Full evidence, settings, handles and artifact paths |
| `fugato status [worker]` | Observe jobs without renewing their lease |
| `fugato cancel <worker>` | Cancel and report whether interruption was confirmed |
| `fugato cancel --all` | Cancel this Claude session's active jobs in the workspace, with per-job outcomes |
| `fugato runtime status` | Inspect the selected binary and saved workspace broker without starting a runtime |
| `fugato runtime restart` | Retire an idle broker; refuse while busy; start fresh on the next task |
| `fugato setup` | Runtime readiness and configuration |
| `fugato steer <jobId> --delivery-id <id> --owner <ownerId>` | Internal native-hook steering handoff, message on stdin; use SendMessage for native agents |
| `fugato models [--json] [--all]` | Discover current account models and efforts, including hidden models with `--all`, and show effective tiers |
| `fugato ultra-codex [on\|off\|status]` | Ultra session controls; task text belongs in the slash command |
| `fugato pair [on\|off\|status]` | Pair session controls; one primary Codex thread |
| `fugato duel [on\|off\|status]` | Duel session controls; `on --rounds <n>` sets 1–3 total rounds |
| `fugato roundtable [on\|off\|status]` | Roundtable session mode controls; `on --intensity … --roles …` selects defaults |
| `fugato roundtable start [--intensity …] [--roles id,id] [--persona-model id=model[:effort]]… [--run <runId>] [--json]` | Goal on stdin; returns room, member headers and chair card |
| `fugato roundtable status <roomId> [--json]` / `pause\|resume <roomId>` | Inspect or control the room |
| `fugato roundtable close <roomId> [--title t] [--label l] [--selects n] [--unreviewed reason]` | Close the room; with a title, `--selects` or a body on stdin, first records the chair's closing decision under the review gate. Closing does not cancel jobs |
| `fugato forum read <roomId> [--after n] [--thread n] [--limit n] [--json]` | Chair index/thread reads |
| `fugato forum post <roomId> --kind <kind> [--thread n] [--reply-to n] [--title t] [--label l] [--ref r]… [--mention m]…` | Chair posts, body on stdin; see [forum](roundtable.md#the-forum) |
| `fugato cleanup --dry-run --json` / `fugato cleanup --json` | Preview/apply retention with read-only inert workspace reporting; text output includes manual removal hints; `--days N` overrides the period |
| `fugato journal <start\|use\|add\|validate\|close\|show\|list>` | Criteria (including `add withdraw`), verdicts and decisions; `start --switch` selects a new run while leaving the old one open; `use <runId>` selects an existing open run for the session |

Without an active run, journal add/close use the sole open run in the current
workspace. Automatic task linking uses it only if it belongs to the dispatching
Claude session or has no recorded session. Several open runs leave tasks unlinked
and require `journal use <runId>` or `--run <id>` for add/close. See [run journal](run-journal.md)
for verdict criterion matching and cross-session `resolves`.

`fugato journal show` prints token totals for the run's linked jobs, including how
many jobs had no usage, and exposes `usageTotals` in JSON. It uses saved reports
or available job records; unknown usage remains unknown. See
[run journal](run-journal.md#commands).

Worker names are reserved within a Claude session, including on adoption and
cross-session `--thread` follow-ups; collisions receive a different name. Every
fresh native Agent call reserves a name before spawn through the internal
`reserve-name` handshake. A valid, free caller name is kept; otherwise a scientist
pool name is assigned. A changed name adds a `Codex worker named X` note to the
Agent result's context (also on background launches); a preserved caller name adds no note. Reservation
failure leaves the Agent call unchanged, and resumptions keep their name.
Public `--name` accepts 1–64 ASCII
letters, digits, `_`, `.` or `-`, starting with a letter or digit. Names beginning
`task-`, `review-` or `job-` are refused case-insensitively because those prefixes
identify jobs; internal native naming ignores such names and uses the pool. For
1.3-era duplicates, command-state preference applies first, then the caller's
workspace breaks the tie; unresolved ambiguity requires an exact ID. Worker
commands also accept job IDs; use a job ID for an older turn. When a name matches several jobs, `answer`
picks the one with a pending question, and `wait` and `cancel` the active one
(both fall back to an unresolved turn). A follow-up whose thread has no
recorded sandbox is blocked (`thread_settings_unknown`) until `--sandbox` is
passed (including `--resume`/`--resume-last`; `--continue` permits explicit
`--sandbox` only when the selected job lacks recorded sandbox settings).
Refused or never-started attempts do not replace started settings anchors.
Reports' `details` always names the exact job ID, preserving saved commands
after follow-ups. `next` may use a safely resolved worker name, otherwise the
job ID, with `--cwd` when needed; for `needs_answer` it pins `--question`. Use
it verbatim or retain the displayed ID explicitly. A bare `fugato answer <worker>`
answers whatever question is pending now, which may be newer than the one you
saw. Native `codex:codex-native` agents receive follow-ups and answers via
SendMessage; that path pins the displayed question. If no unanswered pending
slot remains or the job has ended, the adapter returns the old job with a notice;
send a subsequent new brief to start work. A slot that still exists after its
deadline is handled differently: the adapter submits the pinned answer without
a local expiry check, and the companion refuses it. Expiry alone does not
promise a notice. A `thread_busy` report's
`next` answers the owning job's pinned question, otherwise observes its recovery,
or is null when no action is known. Its `details` still targets the refused job.
For a Computer Use approval, send only an exact displayed option label, its
number `1`–`4`, or `call`/`once`/`task`/`always`/`deny`/`no`. Answers are trimmed
and case-insensitive; exact labels allow a trailing period. Anything else,
including `yes` or qualified replies, denies the request. See
[approval choices](computer-use-approvals.md#forwarded-approvals-owned-jobs).
Run task/wait/answer in background Bash; reports arrive with completion
notifications. Use single-quoted arguments and `DUET_TASK`/`DUET_ANSWER` heredocs.
Double quotes, pipes, compound commands and flags outside the permission hook's
allowlist use normal permissions. Never start two waits for one job.

Compatibility: `node "$CODEX_COMPANION" <subcommand>` remains supported, including
the legacy non-direct/feed modes. Some slash-command preambles call the absolute
companion path so they can run before PATH refreshes. New dispatches use `fugato`.
