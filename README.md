<p align="center">
  <img src="docs/assets/duet-hero.png" alt="Duet: Claude plans, briefs and accepts; Codex workers build and review in parallel" width="100%">
</p>

<p align="center">
  <b>Claude Code × Codex, working as one team.</b><br>
  Claude plans, writes the briefs and accepts the work. Codex workers investigate, implement and review in parallel, in their own isolated home.
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#features">Features</a> ·
  <a href="#documentation">Docs</a>
</p>

---

## Why Duet

- **Claude spends its effort where it matters.** Each worker is one background
  Bash call. Claude sleeps until the job ends, then reads one compact JSON report:
  Codex's final summary (capped at 8,000 characters), plus structured evidence and
  handles. It does not babysit a growing transcript, so long Codex jobs cost
  Claude almost nothing.
- **Workers can talk back.** Codex can ask a question mid-task (`ask_parent`)
  and Claude's answer continues the *same* turn. Stopping a job really stops it,
  and stopped work can be continued or adopted later.
- **Evidence over claims.** Every turn ends in a schema-enforced report that
  separates what was observed from what Codex claims, with a before/after
  snapshot of touched files. Claude's verdicts go into a durable run journal
  that survives context compaction.
- **Nothing leaks into your everyday Codex.** Auth, threads and job state live
  in `~/.claude/codex-isolated`; Duet never writes `~/.codex`.
- **You can watch it.** The `codex-live` pane and `/tasks` show each worker's
  progress live, at zero Claude token cost.

## How it works

<p align="center">
  <img src="docs/assets/duet-how-it-works.png" alt="Claude Code dispatches briefs through the Duet companion to parallel Codex workers and receives one-line structured reports" width="100%">
</p>

1. **Claude** scouts the code, writes acceptance criteria and a precise brief for
   each worker.
2. The **Duet companion** starts each job on its own Codex thread and keeps the
   Bash call attached as the job's owner (lease, heartbeat, questions, stops).
3. **Codex workers** run in parallel and finish with a structured report.
4. Claude wakes on the completion notification, checks the diff and its own
   evidence against each criterion, records the verdict and integrates.

## Install

```bash
/plugin marketplace add Ghqqqq/codex-duet     # or an absolute path to a local checkout
/plugin install codex@duet
/plugin install codex-live@duet                # optional live pane
/reload-plugins
```

Then check the runtime and sign in to the isolated home once:

```bash
/codex:setup
```

Run the isolated `codex-isolated.mjs` login command it prints; prefixing it with `!`
runs it in the session.

**Requirements:** Claude Code with plugin support, Node.js 18.18+, a Codex CLI
(`codex` on PATH or a [pinned binary](docs/configuration.md#runtime-selection)),
and a ChatGPT plan (including Free) or an OpenAI API key. Usage counts toward
your normal Codex limits.

> Installing needs no GitHub credentials.
> Upgrading from `codex@codex-isolated-local`? Uninstall it, remove that
> marketplace and install `codex@duet`. Job history is
> [migrated automatically](docs/state-and-retention.md#job-state-and-migration).

## Quick start

You rarely call anything yourself. Ask Claude to delegate, or let it decide that
a task benefits from independent workers:

```text
Have Codex investigate why the integration tests are flaky, and in parallel have
another Codex worker review the retry logic in src/net/.
```

For a substantial task, hand the whole orchestration over:

```text
/codex:ultra-codex add a --json flag to the cancel command and cover it with a test
```

| Command | What it does |
| --- | --- |
| `/codex:ultra-codex <task>` · `on` · `off` | Claude orchestrates parallel Codex workers end to end, once or as a session mode |
| `/codex:review` · `/codex:adversarial-review` | Read-only Codex review of your changes; the adversarial one challenges the design |
| `/codex:rescue <task>` | Hand one task to Codex: investigate, fix, or continue earlier work |
| `/codex:status` · `/codex:result` · `/codex:cancel` | Inspect, read or stop jobs |
| `/codex:transfer` | Continue the current Claude conversation directly in Codex |
| `/codex:setup` | Check the runtime; opt into browser/desktop tools and other settings |

Every command and flag: [docs/commands.md](docs/commands.md).

## Features

### Direct mode: parallel workers, minimal Claude cost

Claude dispatches each job as one background Bash call:

```bash
node "$CODEX_COMPANION" task --fresh --direct --model gpt-6-astra --effort xhigh <<'CODEX_TASK'
<brief: objective, context, owned paths, constraints, acceptance criteria>
CODEX_TASK
```

While the job runs, the call prints compact progress lines for `/tasks`. When the
job ends, asks a question or reaches its time budget, the last JSON line is the
report, with ready-to-run `waitCommand`, `answerCommand` and
`continuationCommand` handles. Each worker gets a name (Ada, Noether,
Turing, …) that its follow-ups keep. →
[Direct mode and worker lifecycle](docs/direct-mode.md)

### Live view: `codex-live` and `/tasks`

`codex-live` is a read-only pane that draws every worker the way Claude Code
draws its own transcript: `⏺` rows, tool headers, file changes, plans and
pending questions. New jobs ask Claude Code to open the pane; Claude Code decides
whether it is shown at the current width. `/codex-live` opens and focuses it at any width.
`/tasks` shows the same jobs as compact progress lines anywhere. Neither costs
Claude tokens.

<p align="center">
  <img src="docs/assets/codex-live-demo.png" alt="codex-live pane showing three Codex workers on a demo repository: one reviewing, one finished implementing compound durations with file updates and test runs, one finished investigating" width="88%">
</p>
<p align="center"><sub>The codex-live pane, drawn by its own layout code from three real jobs on a small demo repository.</sub></p>

### Ultra-codex orchestration

`/codex:ultra-codex` applies Ultracode-style orchestration with Codex as the
workforce. Briefs follow a fixed template, and every report passes one
acceptance protocol (scope check, diff review, criterion → evidence → verdict,
then `ACCEPT` / `ACCEPT WITH GLUE` / `REWORK` / `REASSIGN`). →
[docs/ultra-codex.md](docs/ultra-codex.md)

### Run journal

Each orchestrated task keeps a journal in the isolated home. It records the goal
and acceptance criteria, every worker's brief and report, Claude's verdicts and
decisions, and the final judgment. After compaction or on resume, Claude runs
`journal show` and picks up exactly where it was. → [docs/run-journal.md](docs/run-journal.md)

### Browser and desktop work

Optional Chrome and Computer Use tooling, mirrored from your own Codex app.
Each assignment opens a fresh, session-owned tab. App approvals you already
granted carry over, and anything new is asked of Claude (allow once / this task /
always / deny). → [docs/configuration.md](docs/configuration.md)

## Defaults

| Setting | Default | Change it with |
| --- | --- | --- |
| Model · effort · speed | `gpt-6-astra` · `xhigh` · normal | `--model`, `--effort`, `--fast` per call |
| Codex sandbox | full access, like the Codex app's own full-access mode | `setup --default-sandbox …`, or `--sandbox` per call |
| Browser | any site, no per-origin prompt | `setup --browser-approval ask` |
| Computer Use apps | mirror your Codex app's "always allow" list | `setup --computer-use-approval ask` |
| Project instructions | `CLAUDE.md` is read where no `AGENTS.md` exists | `setup --project-docs agents-only` |
| Wait budget · owner lease | 3600 s · 1800 s | `--timeout-sec`, `--lease-sec` |
| Retention | Claude Code's `cleanupPeriodDays` (30 days) | `cleanup --days N`, `CODEX_COMPANION_RETENTION_DAYS` |

Full table and the security implications of each setting:
[docs/configuration.md](docs/configuration.md).

## Documentation

| Topic | Page |
| --- | --- |
| Dispatch, reports, questions, stops, continue/adopt, Haiku fallback | [Direct mode](docs/direct-mode.md) · [Worker lifecycle](docs/worker-lifecycle.md) |
| Orchestration protocol and phases | [Ultra-codex](docs/ultra-codex.md) |
| Run journal format and commands | [Run journal](docs/run-journal.md) |
| All slash commands and companion subcommands | [Commands](docs/commands.md) |
| Sandbox, browser, Computer Use, transport, runtime binary | [Configuration](docs/configuration.md) · [Browser approvals](docs/browser-approvals.md) · [Computer Use approvals](docs/computer-use-approvals.md) |
| Where state lives, migration, cleanup | [State and retention](docs/state-and-retention.md) |
| Operating notes, slow starts, blocked workers, known limitations | [Worker operations](docs/worker-operations.md) · [Troubleshooting](docs/troubleshooting.md) |

## Known limitations

- `ask_parent` relies on the Codex app-server's experimental dynamic-tool API
  (and a per-thread MCP bridge on resumed threads). Runtimes that reject it fall
  back to a final `needs_input` report.
- Codex edits bypass Claude Code's permission prompts and rewind. The report's
  touched-file snapshot, the Codex sandbox and `git diff` are the controls.
- File attribution is unreliable when several writers share one checkout. Give
  parallel writers disjoint paths or separate worktrees.
- `codex-live` needs Claude Code 2.1.302's function-hooks pane API.

More: [docs/troubleshooting.md](docs/troubleshooting.md#known-limitations).

## Development

```bash
npm test
```

The suite runs against temporary Codex homes only. It refuses to touch
`~/.claude/codex-isolated` or `~/.codex` and checks that no spawned process
survives. Local-socket tests are skipped inside a sandbox, so run the suite
outside one for full coverage. Release notes: [CHANGELOG](plugins/codex/CHANGELOG.md).

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Duet is a fork of
[openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) (upstream
`db52e28` / 1.0.6). The review and rescue commands come from upstream; the
worker runtime, isolation, lifecycle, orchestration and live view are Duet
additions.
