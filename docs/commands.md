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

```bash
/codex:review
/codex:review --base main
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
duet review --args-stdin <<'DUET_ARGS'
--base main
DUET_ARGS

duet adversarial-review --args-stdin <<'DUET_ARGS'
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
(`MAX_INLINE_UNTRACKED_FILES`). An omission manifest gives paths, sizes and
reasons, and the reviewer is told to collect omitted content itself. Git metadata
commands have an 8 MiB limit (`MAX_GIT_METADATA_BYTES`); overflow fails explicitly
instead of reviewing silently truncated output.
A failed native review keeps its failure reason in the report and summary.
An otherwise successful turn with empty native output, or empty, malformed or
schema-invalid adversarial output, becomes a failed `review_output_invalid` job
(exit 1). New review jobs save raw output and result artifacts even on invalid
output. `duet result <jobId> --details` exposes the complete review text/findings
and artifact paths; the compact summary keeps its 8,000-character cap. Older
jobs are not backfilled with artifacts.

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
parallel work Claude prefers `codex:codex-native`, then background `duet task`,
with `codex:codex-worker` as the Haiku fallback. See [direct mode](direct-mode.md).

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
session id across workspaces, so other sessions in the same repository are
unaffected). While it is on, a `UserPromptSubmit` hook adds a one-line reminder to every prompt and
Claude applies the orchestration protocol to each substantive task; chat,
one-line fixes and single-file questions stay inline. `off`, `/clear`, a new
session or the session's end turn it off; `--resume` keeps it. The saved scale
(`--quick`/`--thorough`, default auto) and `--max-workers` apply to every task
in the mode.

Because workers use a different model and receive the conversation only through
an explicit `--fork`, the command puts Claude's
effort at both ends of each assignment: every brief follows a fixed template
(objective, why, known context with file:line, interface contract, owned paths,
non-goals, acceptance criteria, verification commands, when to ask), and every
report goes through the same acceptance protocol (scope check, reading the diff,
criterion → evidence → verdict, verification and assumptions audits, then
`ACCEPT` / `ACCEPT WITH GLUE` / `REWORK` / `REASSIGN`). Phases: scout → understand
(parallel read-only workers) → design (thorough only, independent drafts judged
by Claude) → implement (disjoint ownership or worktrees) → accept → verify
(adversarial reviewers plus the test suite, loop until dry) → integrate.
`--max-workers <n>` sets Claude's advisory concurrency ceiling (default 6), not
a runtime scheduler limit. Details and the mapping
to Ultracode's Workflow tool: [ultra-codex](ultra-codex.md).

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

### `/codex:result`

Returns report v2: status, worker, jobId, summary, nonempty evidence, `next` and
`details`. Add `--details` for full evidence, handles, runtime settings, artifact
paths and complete review findings. Compact blockers already retain bounded
app/tab/session identifiers, cleanup status and safe approval identifiers when
captured; `--details` preserves the full stored fields. It retrieves a result
without starting another turn.

### `/codex:cancel`

Interrupts an active job and reports whether termination was confirmed.

### `/codex:setup`

Checks whether Codex is installed, reachable and logged in. If Codex is missing
and npm is available, it can offer to install Codex for you. It also runs the
configuration actions described under [Configuration](configuration.md).
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
its reason as a note; only explicit findings block. With the gate enabled, the
first stop of each user turn costs one Codex review turn; follow-up stops and an
unavailable runtime cost none.

## Companion subcommands

Use `duet <subcommand>` in a Claude session, or `plugins/codex/bin/duet` from the
repository root. Run `duet task --help` for flags and side-effect-free examples.
SessionStart supplies the session ID; `--session <id>` overrides it.

| Command | Use |
| --- | --- |
| `duet task` | Fresh assignment; brief only on stdin; implies `--direct` |
| `duet task --run <id\|none>` | Override journal linkage for this dispatch only; select an open run across workspaces or skip linking with `none`; follow-ups do not inherit it |
| `duet task --to <worker>` | New turn on that worker's thread/cwd, inheriting recorded settings unless overridden |
| `duet task --fork` | Import the current Claude transcript into a new thread, then run the stdin brief; fidelity not verified |
| `duet answer <worker> --question '<questionId>'` | Answer the displayed question ID from stdin and keep waiting; prefer the report's `next` verbatim |
| `duet wait <worker>` | Attach the sole owner wait and renew its lease |
| `duet result <worker>` | Retrieve report v2 if missing from the completion notification |
| `duet result <worker> --details` | Full evidence, settings, handles and artifact paths |
| `duet status [worker]` | Observe jobs without renewing their lease |
| `duet cancel <worker>` | Cancel and report whether interruption was confirmed |
| `duet setup` | Runtime readiness and configuration |
| `duet cleanup --dry-run --json` / `duet cleanup --json` | Preview/apply retention with read-only inert workspace reporting; text output includes manual removal hints; `--days N` overrides the period |
| `duet journal <start\|add\|validate\|close\|show\|list>` | Criteria (including `add withdraw`), verdicts and decisions; `start --switch` selects a new run while leaving the old one open |

Worker names are reserved within a Claude session, including on adoption and
cross-session `--thread` follow-ups; collisions receive a different name. For
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
it verbatim or retain the displayed ID explicitly. A bare `duet answer <worker>`
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
companion path so they can run before PATH refreshes. New dispatches use `duet`.
