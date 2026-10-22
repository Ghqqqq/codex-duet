# /codex:ultra-codex — Ultracode-style orchestration with Codex workers

`/codex:ultra-codex <task>` makes the Claude Code main agent run a substantive
task the way Claude Code's own Ultracode mode does, with Codex workers in place
of Claude subagents. Claude scouts, assigns, judges and integrates; Codex
investigates, implements and reviews. Direct mode is the default: Claude runs
`task --direct` in background Bash. Progress lines appear in /tasks, then the
JSON payload as the last stdout line. On the completion notification, Claude
reads only the last line starting with `{` in the output file
(`grep '^{' <output file> | tail -n 1`), never the whole output file.
Claude Code may append `[exited with code N]` after the JSON.
This saves the Claude cost of a Haiku relay repeatedly
reading its growing transcript; the heavy lifting spends Codex quota.
`/codex:ultra-codex on` makes that the session's default (see "Mode" below);
`off` ends it.

## Mode: on, off, and what "off" means

Ultracode is a session setting (`/effort ultracode`), and so is ultra-codex
mode. `ultra-codex on [--quick|--thorough] [--max-workers <n>]` writes a small
JSON record to `<isolated home>/duet/state/<workspace>/ultra-codex/<session
id>.json`, keyed by the Claude session id that the SessionStart hook exports as
`CODEX_COMPANION_SESSION_ID`. While the record exists, the plugin's
`UserPromptSubmit` hook (`scripts/ultra-codex-hook.mjs`, about 70 ms) appends a
one-line versioned reminder to every prompt (shown with the repository-relative
protocol path):

> Ultra-codex mode on (thorough, max 4 workers). Apply protocol vb24e94e3 to
> substantive tasks; re-read plugins/codex/prompts/ultra-codex-protocol.md only if
> vb24e94e3 is not in your context.

Control-only invocations (`on`, `off`, `status` or no arguments) do not load the
protocol; task invocations, including `on` with task text, use Read on its path.
The reminder requests a re-read only when that content version is absent from
context, so the per-prompt cost is the reminder. The hook is silent for other
sessions in the same repository, for prompts that are the command itself, when
no session id is present, and on any error.

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
passes through shell arguments); Claude dispatches on the arguments itself and runs
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

`/codex:ultra-codex` reproduces that division of labour with background Bash
and direct Codex jobs, so it works at any effort level without the Workflow tool:

| Ultracode element | /codex:ultra-codex equivalent |
| --- | --- |
| `agent()` with `schema` | Bash → `task --direct`; the report is schema-enforced (`schemas/worker-report.schema.json`) |
| `parallel()` fan-out | one Bash call per job with `run_in_background: true`, then read only the last line starting with `{` in each output file on its completion notification (grep recipe below) |
| `phase()` | the seven phases below, tracked with `TodoWrite`; a phase starts when the previous one's reports are in |
| `isolation: "worktree"` | Claude creates worktrees with `git worktree add`, passes each as `--cwd` and merges the branches; a shared checkout requires disjoint OWNED PATHS |
| journal cache / resume | `journal show` recovers criteria, verdicts, decisions and saved worker artifacts; `task --continue <jobId> --cwd <cwd> --direct` starts an explicitly requested continuation while its job record is retained |
| adversarial verify, judge, loop-until-dry | the Verify phase: read-only reviewer workers, findings routed to the owning implementer, at most the configured fix rounds |

Use the [direct-mode recipe](worker-operations.md#direct-mode): a quoted stdin
heredoc, `description: "Codex: <label>"`, `dangerouslyDisableSandbox: true` when
Claude's Bash sandbox is on, and `--sandbox read-only` for investigators and
reviewers. SessionStart exports `CODEX_COMPANION`; older sessions resolve
`../scripts/codex-companion.mjs` relative to the protocol's `prompts/` folder.
The default timeout is 3600 s (maximum 3600), the direct owner lease 1800 s.
Add `--quiet` to `task --direct` or `wait --direct` for exactly one JSON line
without progress; `--quiet` requires `--direct`. Never poll, sleep or use `tail -f`.
The completion notification carries no output; read only the last line starting
with `{` in its output file (`grep '^{' <output file> | tail -n 1`), never the whole output file.
For `running`, background the returned `waitCommand`; for `needs_answer`, run
its `answerAndWaitCommand` in ONE background Bash call (`run_in_background: true`,
`timeout: 600000`), putting the answer on stdin through a single-quoted heredoc.
Compatibility fallback for `needs_answer`: FIRST run its `waitCommand` in
background Bash; it includes `--after-question <id>` and keeps the lease alive.
Then answer with the returned `answerCommand`, putting the answer on stdin
through a single-quoted heredoc; do not start another wait after answering.
Never run two waits for one job; the answer continues the same turn.
Report `ownership_moved` and stop using that owner. Terminal reports go through
the acceptance protocol; read `rawOutputFile` only if a report field is
insufficient. Follow-ups and rework use `task --thread <threadId> --direct` with
the same `--cwd` and restated criteria. Stop the background task in Claude Code
(`owner_stopped`) or use `cancel <jobId> --json`; thread context and edits persist.
Run the reported `continuationCommand` after a user stop only with consent.
When several completion notifications are already pending, batch their labelled
final-JSON reads and, after accepting each job, their separate verdict writes in
one Bash call each; stop on a failed read or submission (`set -euo pipefail`).
Never delay pending questions to build a batch or prewrite verdicts.

The separate read-only `codex-live` plugin (`/plugin install codex-live@duet`)
shows session jobs and the selected job's messages, commands, file changes,
tool calls, plan and pending question, at no Claude token cost. New jobs ask Claude
Code to open the pane; Claude Code decides whether to show it at the current width.
Its `codex-live` slash command opens it at any width. It reads companion-written
markers under `<isolated home>/duet/sessions/<claudeSessionId>/` and never starts,
answers or cancels a job.

Fallback only: `Agent(subagent_type: "codex:codex-worker")` when background Bash
is unavailable or the user asks for an agent transcript view. Never pass `model`
or `effort` to the Haiku forwarder; Codex's choices go in the assignment text.
Its `effort: low`, `omitClaudeMd: true`, `autoCompactWindow: 100000`, feed limit
60 and verbatim JSON return (plus at most 5 lines of notes, no prose report)
limit Claude cost. Fallback rework uses a NEW worker with `--thread <threadId>` and
the same `--cwd`; SendMessage to an existing worker is only for answering its
pending question.
The Workflow tool can address plugin agents (`agentType: "codex:codex-worker"`),
but that fallback integration has not been exercised with Duet and is not
required by this command.

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

## Run journal

After writing task-level criteria, Claude runs `node "$CODEX_COMPANION" journal
start` with stdin JSON containing `goal` and `criteria`. Tasks in that Claude
session link automatically across workspaces and worktrees, preserving the exact
worker brief and final compact report. Claude records each acceptance with `journal add verdict`,
consequential decisions and accepted assumptions with `journal add decision`,
then runs `journal validate` before `journal close` (`passed`, `blocked` or
`abandoned`). A passed close refuses unresolved issues with exit 2 and leaves
the journal and active pointer unchanged; blocked/abandoned closes record them.

After compaction or a resumed session, `journal show` recovers the goal,
criteria, latest worker verdicts, decisions and open items. SessionStart adds a
one-line reminder when a run is active. Journals live only in Duet's isolated
home, survive job-record pruning, and follow the retention window; they neither
verify claims nor restart work. See [Run journal](run-journal.md) for schemas,
commands and limits.

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

Every direct or `--report` worker turn runs with the worker-report output schema,
so the final message is a JSON object Codex must fill: `status` (`completed`,
`needs_input`, `blocked`), `summary`, `key_findings`, `assumptions`,
`verification`, `blockers`, `question`. The helper merges it with what it
observed itself. In direct mode it returns compact JSON as the last stdout line
after progress in /tasks. Read only the last line starting with `{`
(`grep '^{' <output file> | tail -n 1`), never the whole output file. The payload
has no `activity` list, only `activityCount`; terminal reports also carry the
final `summary`, cut at 8000 characters. Fields include:

- `status` — the declared status, except that a captured runtime refusal (for
  example a Computer Use denial) makes the turn `blocked`, and a `completed`
  whose summary is only a plan or a question is reported as `needs_input`.
- `reportFormat: "structured"` when the schema was honoured; absent when the
  helper had to infer the report from prose (interrupted turn, older thread).
- `keyFindings`, `assumptions`, `claimedVerification` — Codex's declarations.
- `verification` — command events the helper captured; `touchedFiles` and
  `fileTrackingStatus` — from workspace snapshots and file-change events.
- `blockers` — captured/detected blockers when present, otherwise Codex's own entries.
- `question` — the exact missing input when `status` is `needs_input`.

The summary remains in `rawOutputFile` for the stop-gate hook; human
`/codex:result` adds the outcome, evidence and blockers around that prose.

## Approvals during orchestration

Workers run with approval policy `never+elicitations`: command, sandbox, rule
and permission prompts are rejected as before, and MCP elicitations are
forwarded. A Computer Use app request that no `--approve-computer-app` flag
covers reaches the parent as a pending question with four fixed options (`Allow
this call`, `Allow for this task`, `Allow always (isolated Codex home)`, `Deny`);
see `docs/computer-use-approvals.md`. The orchestrator forwards it to the user
through `AskUserQuestion` unless the user pre-authorised the app.

## Project instructions

Codex reads `AGENTS.md` on its own. Before each task the helper also adds
Codex's `project_doc_fallback_filenames = ["CLAUDE.md"]` in the isolated home's
`config.toml` unless a custom fallback list exists. This default lets a worker read
the project's `CLAUDE.md` wherever an `AGENTS.md` is missing (same discovery rules
and size limit as Codex applies to `AGENTS.md`). `setup --project-docs agents-only`
removes only Duet's exact default list; custom lists are unchanged. The user-level
`~/.claude/CLAUDE.md` is never involved.
