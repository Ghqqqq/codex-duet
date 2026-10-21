# Commands

Slash commands and companion subcommands. Back to the [README](../README.md).

## Slash commands

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
to Ultracode's Workflow tool: [ultra-codex](ultra-codex.md).

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
configuration actions described under [Configuration](configuration.md).

The optional review gate runs a targeted Codex review of Claude's last turn from a
`Stop` hook and blocks the stop if it finds issues:

```bash
/codex:setup --enable-review-gate
/codex:setup --disable-review-gate
```

This can create long Claude/Codex loops and consume usage quickly; enable it only
while you are watching the session.

## Companion subcommands

Workers call `node "$CODEX_COMPANION"` in a Claude session (or
`node plugins/codex/scripts/codex-companion.mjs` from the repository root):
`task`, `wait`, `answer`, `status`, `result`, `cancel` and `setup`. Run it without
arguments for full usage.
