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

- **Claude briefs and checks the work.** Each worker is a native agent call or
  background `duet task`. Its completion notification carries a compact report:
  Codex's summary (up to 8,000 characters), evidence, and commands for next steps
  or full details. Claude checks the diff and verification before accepting it.
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
   wait attached as the job's owner (lease, heartbeat, questions, stops).
3. **Codex workers** run in parallel and finish with a structured report.
4. Claude receives the report with the completion notification, checks the diff and its own
   evidence against each criterion, records the verdict and integrates.

## Install

**Upgrade or downgrade with no Duet jobs running.** Finish or cancel active jobs
before changing versions; workers from different versions can overwrite shared
job state.

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

Claude prefers `codex:codex-native` when the first accepted non-command person
prompt after registration reports native workers ready; otherwise it uses
background `duet task`. Continue by sending the native agent a message,
or use `duet task --to <worker>` with a new brief. A pending question uses
SendMessage for native agents. For Bash workers, use the report's `next` command
verbatim, or `duet answer <worker> --question '<questionId>'` with the ID you saw
and the answer on stdin. A bare `duet answer <worker>` answers whatever question
is pending now, which may be newer. Native SendMessage already pins the displayed
question; its answer path is unchanged. Both paths continue the same turn.

Every command and flag: [docs/commands.md](docs/commands.md).

## Features

### Call Codex like a native subagent

Claude calls `Agent(subagent_type: "codex:codex-native", name: "reviewer", prompt: "<brief>")`.
An optional first line such as `DUET: --sandbox read-only --effort xhigh` sets
Codex flags. SendMessage to that agent continues its thread or answers a pending
question; stop an active task from `/tasks`. This requires the supported function
hooks. If unavailable, the agent returns a blocked report; check `duet status`
before retrying through Bash. → [Native dispatch](docs/direct-mode.md#native-subagent-preferred-when-available)

### Direct mode: background workers

Claude can also dispatch one background Bash call per job:

```bash
duet task --model gpt-6-astra --effort xhigh --normal <<'DUET_TASK'
<brief: objective, context, owned paths, constraints, acceptance criteria>
DUET_TASK
```

`duet task` implies direct mode. Progress appears in `/tasks`; report v2 arrives
with the completion notification. Only if missing, run `duet result <worker>`.
The report separates captured `checks.ran` from `checks.claimed`, and supplies
`next` and `details` commands. `duet result <worker> --details` shows full evidence,
settings, handles and artifact paths. Each worker gets a name (Ada, Noether,
Turing, …) reused by `--to` follow-ups. → [Direct mode and worker lifecycle](docs/direct-mode.md)

Claude's loaded CLAUDE.md/rules are forwarded automatically; opt out on a fresh
task with `--no-claude-md` or `CODEX_COMPANION_CLAUDE_MD=0`. Without the loaded
inventory, forwarding uses an approximate scan. `duet task --fork` explicitly
imports the current conversation into a new thread before running the brief,
labelled “imported Claude conversation (fidelity not verified)”. → [Context configuration](docs/configuration.md#claude-instructions-and-conversation-imports)

### Live view: `codex-live` and `/tasks`

`codex-live` is a read-only pane that draws every worker the way Claude Code
draws its own transcript: prompts, `⏺` rows, tool headers, file changes, plans and
pending questions. Resolved `ask_parent` calls show matched answers. On resumed
threads, Codex 0.146.0 supplies no call ID to custom MCP servers, so answers are
not shown. New jobs ask Claude Code to open the pane; Claude Code decides
whether it is shown at the current width. `/codex-live` opens and focuses it at any width.
Follow-ups on the same Codex thread stay in one row, with every turn in one
continuous transcript; new jobs preserve your selection and scroll position.
`/tasks` shows compact progress with outcomes first. Neither costs Claude tokens.

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
`journal show` to recover it; `journal validate` must pass before a passed close.
→ [docs/run-journal.md](docs/run-journal.md)

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
| Claude instructions | Loaded CLAUDE.md/rules forwarded; approximate scan if unavailable | `--no-claude-md`, `CODEX_COMPANION_CLAUDE_MD=0` on fresh tasks |
| Codex project discovery | `CLAUDE.md` where no `AGENTS.md` exists | `duet setup --project-docs agents-only` |
| Wait budget · owner lease | 3600 s · 1800 s | `--timeout-sec`, `--lease-sec` |
| Retention | Claude Code's `cleanupPeriodDays` (30 days) | `cleanup --days N`, `CODEX_COMPANION_RETENTION_DAYS` |

Full table and the security implications of each setting:
[docs/configuration.md](docs/configuration.md).

## Documentation

| Topic | Page |
| --- | --- |
| Native/Bash dispatch, reports, questions, stops and recovery | [Direct mode](docs/direct-mode.md) · [Worker lifecycle](docs/worker-lifecycle.md) |
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
- The native adapter and `codex-live` require the supported Claude Code 2.1.302
  function-hook APIs. Stopping an already-ended native row may leave a parked
  question until its default 900 s timeout; `duet cancel <worker>` cancels explicitly.

More: [docs/troubleshooting.md](docs/troubleshooting.md#known-limitations).

## Development

After `npm ci`, install the CLI versions in `.codex-version` and
`.claude-code-version` with
`npm install -g "@openai/codex@$(cat .codex-version)" "@anthropic-ai/claude-code@$(cat .claude-code-version)"`.
Before pushing a release to main, run:

```bash
npm run verify
```

This checks version metadata, builds and checks TypeScript, runs the runtime
tests, then runs the live-pane tests, stopping at the first failure. `npm test`
still runs only the runtime suite (`npm run test:runtime`). CI runs the same
checks in `runtime` and `live` jobs for pull requests and pushes to main, using
the pinned CLI versions. The live test harness runs without an account or API
credentials; CI gives it an isolated `CLAUDE_CONFIG_DIR` under the runner's
temporary directory and disables automatic updates.

The runtime suite runs against temporary Codex homes only. It refuses to touch
`~/.claude/codex-isolated` or `~/.codex` and checks that no spawned process
survives. Local-socket tests are skipped inside a sandbox, so run the suite
outside one for full coverage. Release notes: [CHANGELOG](plugins/codex/CHANGELOG.md).

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Duet is a fork of
[openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) (upstream
`db52e28` / 1.0.6). The review and rescue commands come from upstream; the
worker runtime, isolation, lifecycle, orchestration and live view are Duet
additions.
