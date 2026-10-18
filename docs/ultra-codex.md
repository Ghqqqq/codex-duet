# /codex:ultra-codex — Ultracode-style orchestration with Codex workers

`/codex:ultra-codex <task>` makes the Claude Code main agent run a substantive
task the way Claude Code's own Ultracode mode does, with Codex workers in place
of Claude subagents. Claude scouts, assigns, judges and integrates; Codex
investigates, implements and reviews. Claude's own context stays small (it reads
reports, not repositories), and the heavy lifting spends Codex quota only.

The command lives in the plugin's namespace: type `/codex:ultra-codex`. Claude
Code namespaces every plugin component, so the bare `/ultra-codex` is not
registered by the plugin itself; a user-level skill
(`~/.claude/skills/ultra-codex/SKILL.md`) that invokes `codex:ultra-codex`
through the `Skill` tool with `$ARGUMENTS` provides the short form.

## How Ultracode works, and what this command copies

Claude Code 2.1.x Ultracode (`/effort ultracode`, or `--effort ultracode`) is a
session setting that does two things: it injects a standing instruction to
"optimise for the most exhaustive, correct answer" and to use the Workflow tool
on every substantive task, and it unlocks that tool. A Workflow is a small
JavaScript orchestration script: `agent(prompt, { label, phase, schema, model,
effort, isolation: "worktree", agentType })`, `parallel()`, `pipeline()`,
`phase()`, `log()`; results are schema-validated structured outputs, cached in a
journal so a resumed run skips finished agents, with a concurrency ceiling and a
hard agent cap.

The main agent in Ultracode is not a pure planner. From the prompt text in the
binary: it scouts inline first ("scout inline first, then call Workflow"), writes
the script, reads results between phases, judges and synthesises, and makes
trivial edits itself; "solo only on conversational turns or trivial mechanical
edits". Substantive work is delegated to agents, and multi-phase tasks are
several workflows in sequence. The quality comes from the patterns the prompt
insists on: adversarial verification, judge panels, loop-until-dry review,
completeness critics, and never silently capping the work.

`/codex:ultra-codex` reproduces that division of labour with the plain `Agent`
tool and the `codex:codex-worker` subagent, so it works at any effort level and
without the Workflow tool:

| Ultracode element | /codex:ultra-codex equivalent |
| --- | --- |
| `agent()` with `schema` | `Agent` → `codex:codex-worker`; the worker report is schema-enforced (`schemas/worker-report.schema.json`) |
| `parallel()` fan-out | several `Agent` calls with `run_in_background: true`, then wait for the completion notifications |
| `phase()` | the six phases below, tracked with `TodoWrite`; a phase starts when the previous one's reports are in |
| `isolation: "worktree"` | `Agent` with `isolation: "worktree"` when assignments overlap; Claude merges the branches |
| journal cache / resume | job records: `/codex:status`, `/codex:result <jobId>`, `task --continue <jobId>` |
| adversarial verify, judge, loop-until-dry | the Verify phase: read-only reviewer workers, findings routed to the owning implementer, at most the configured fix rounds |

The Workflow tool itself can address plugin agents (`agentType:
"codex:codex-worker"`); this has not been exercised with Duet and is not
required by the command. If a session runs in Ultracode, the same phases can be
written as a Workflow script; the worker contract is unchanged.

## Phases

1. **Scout** (Claude, inline): entry points, likely files, the test command; pick
   `--quick` or `--thorough`.
2. **Understand** (parallel read-only workers): one question each; merge
   `keyFindings`.
3. **Design** (thorough only): two independent drafts; Claude judges and records
   the decision.
4. **Implement** (parallel workers, disjoint write ownership or worktrees).
5. **Verify** (parallel): adversarial reviewers plus Claude running the tests;
   findings go back to the owning worker; loop until dry, bounded.
6. **Integrate** (Claude): full verification, diff inspection, final report that
   separates observed verification from Codex claims.

## What the worker report gives the orchestrator

Every `--report` worker turn runs with the worker-report output schema, so the
final message is a JSON object Codex must fill: `status` (`completed`,
`needs_input`, `blocked`), `summary`, `key_findings`, `assumptions`,
`verification`, `blockers`, `question`. The helper merges it with what it
observed itself and returns:

- `status` — the declared status, except that a captured runtime refusal (for
  example a Computer Use denial) makes the turn `blocked`, and a `completed`
  whose summary is only a plan or a question is reported as `needs_input`.
- `reportFormat: "structured"` when the schema was honoured; absent when the
  helper had to infer the report from prose (interrupted turn, older thread).
- `keyFindings`, `assumptions`, `claimedVerification` — Codex's declarations.
- `verification` — command events the helper captured; `touchedFiles` and
  `fileTrackingStatus` — from workspace snapshots and file-change events.
- `blockers` — captured refusals first, then Codex's own entries.
- `question` — the exact missing input when `status` is `needs_input`.

The summary is stored as the raw output (`rawOutputFile`), so `/codex:result`
and the stop-gate hook keep reading prose.

## Approvals during orchestration

Workers run with approval policy `never+elicitations`: command, sandbox, rule
and permission prompts are rejected as before, and MCP elicitations are
forwarded. A Computer Use app request that no `--approve-computer-app` flag
covers reaches the parent as a pending question with four fixed options (`Allow
this call`, `Allow for this task`, `Allow always (isolated Codex home)`, `Deny`);
see `docs/computer-use-approvals.md`. The orchestrator forwards it to the user
unless the user pre-authorised the app.

## Project instructions

Codex reads `AGENTS.md` on its own. Before each task the helper also sets
Codex's `project_doc_fallback_filenames = ["CLAUDE.md"]` in the isolated home's
`config.toml`, so a worker reads the project's `CLAUDE.md` wherever an
`AGENTS.md` is missing (same discovery rules and size limit as Codex applies to
`AGENTS.md`). `setup --project-docs agents-only` turns this off; the user-level
`~/.claude/CLAUDE.md` is never involved.
