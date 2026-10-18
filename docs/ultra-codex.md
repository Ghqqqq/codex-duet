# /codex:ultra-codex — Ultracode-style orchestration with Codex workers

`/codex:ultra-codex <task>` makes the Claude Code main agent run a substantive
task the way Claude Code's own Ultracode mode does, with Codex workers in place
of Claude subagents. Claude scouts, assigns, judges and integrates; Codex
investigates, implements and reviews. Claude's own context stays small (it reads
reports, not repositories), and the heavy lifting spends Codex quota only.
`/codex:ultra-codex on` makes that the session's default (see "Mode" below);
`off` ends it.

## Mode: on, off, and what "off" means

Ultracode is a session setting (`/effort ultracode`), and so is ultra-codex
mode. `ultra-codex on [--quick|--thorough] [--max-workers <n>]` writes a small
JSON record to `<isolated home>/duet/state/<workspace>/ultra-codex/<session
id>.json`, keyed by the Claude session id that the SessionStart hook exports as
`CODEX_COMPANION_SESSION_ID`. While the record exists, the plugin's
`UserPromptSubmit` hook (`scripts/ultra-codex-hook.mjs`, about 70 ms) appends a
one-line reminder to every prompt:

> [Duet] Ultra-codex mode is on for this session (scale: thorough; max
> workers: 4; turn it off with /codex:ultra-codex off). If this prompt is a
> substantive task — anything beyond a conversational reply, a one-line fix or
> a question answerable from one file — Read <protocol path> first and
> orchestrate the task with Codex workers exactly as that protocol says; your
> own effort goes into the briefs and the acceptance. Otherwise answer normally.

The protocol itself (`prompts/ultra-codex-protocol.md`, about 2k tokens) is
read only when a task calls for it, so the per-prompt cost is the reminder. The
hook is silent for other sessions in the same repository, for prompts that are
the command itself, when no session id is present, and on any error.

Three things turn the mode off:

- `/codex:ultra-codex off` removes the record, lists this session's Codex jobs
  that are still running (they are not cancelled; `cancel <jobId>` does that on
  request) and tells Claude that the orchestration has ended.
- The session's end (`SessionEnd` hook) and a fresh start or `/clear` for the
  same session id (`SessionStart` with `source` other than `resume`/`compact`).
  `claude --resume` keeps the mode.
- Records older than 30 days are pruned at the next `SessionStart`, so a
  session that died without `SessionEnd` cannot leave the mode armed.

Without the mode, the command is one-shot: `/codex:ultra-codex <task>`
orchestrates that task and the protocol's own scope clause ends the
orchestration when the final report is delivered. The slash command's preamble
runs `ultra-codex status --for-command` with no arguments (the task text never
passes through a shell); Claude dispatches on the arguments itself and runs
`ultra-codex on|off` through Bash only with the fixed flags.

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

## Why the briefs and the acceptance are stricter than Ultracode's

Ultracode agents are the same model as the orchestrator, read the same
`CLAUDE.md`, and in a fan-out share a prompt cache with it; a terse assignment
is usually read the way it was meant. A Codex worker shares none of that: it
sees the prompt text and the repository, nothing of the conversation or of the
orchestrator's reading of the user's intent. Every gap in a brief is filled with
Codex's own guess, and a plausible guess that differs from what Claude meant is
the main failure mode of cross-model delegation. The command therefore shifts
Claude's effort to the two ends of each assignment:

- **Briefs** follow a fixed template (`OBJECTIVE`, `WHY`, `CONTEXT I ALREADY
  KNOW`, `INTERFACE CONTRACT`, `OWNED PATHS`, `NON-GOALS / DO NOT`, `ACCEPTANCE
  CRITERIA`, `VERIFY WITH`, `WHEN TO ASK`, `REPORT`). An empty section is a
  decision not yet made. Briefs name the pattern to copy by file and line, say
  what wrong looks like ("do not loosen assertions to make tests pass"), define
  the interface contract so parallel pieces fit, and list the decisions that
  must come back through `ask_parent`.
- **Acceptance** runs the same protocol on every report: status gate; scope
  check (`touchedFiles` within `OWNED PATHS`, confirmed with `git diff --stat`);
  reading the diff rather than the summary, looking for unrequested behaviour
  changes, weakened or rewritten tests, new dependencies, stubs, swallowed
  errors; a criteria walk recording evidence → verdict per criterion;
  a verification audit comparing `claimedVerification` with the captured
  `verification` events and rerunning the commands; an assumptions audit
  accepting or rejecting every assumption; and an explicit decision: `ACCEPT`,
  `ACCEPT WITH GLUE` (trivial mechanical fixes only), `REWORK` (same thread,
  findings with file:line and the failed criterion) or `REASSIGN` (corrected
  brief, when the deviation shows the brief was ambiguous).

Two rules follow from this: drift is treated first as a brief defect, so the
brief text is fixed before resending and the fix carried into sibling briefs;
and no worker grades itself, so reviewers see the brief, the criteria and the
diff but never the implementer's summary. The task-level acceptance criteria
are written by Claude before any dispatch and organise the final report
(criterion → evidence → verdict); "done" appears only beside criteria backed by
Claude's own evidence.

## Phases

1. **Scout** (Claude, inline): entry points and the exact lines the briefs will
   cite; pick `--quick` or `--thorough`; write the task-level acceptance
   criteria.
2. **Understand** (parallel read-only workers): one question each; merge
   `keyFindings`; use them to sharpen `CONTEXT`, `NON-GOALS` and the interface
   contract.
3. **Design** (thorough only): two independent drafts; Claude judges against
   the task criteria, records the decision and derives the interface contract.
4. **Implement** (parallel workers, disjoint write ownership or worktrees), one
   templated brief each.
5. **Accept** (Claude, per worker): the acceptance protocol, with at most two
   rework rounds per assignment.
6. **Verify** (parallel): adversarial reviewers with the brief, the criteria and
   the diff, plus Claude running the tests; findings go back to the owning
   worker; loop until dry, bounded.
7. **Integrate** (Claude): full verification, diff inspection, final report
   organised by criterion.

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
