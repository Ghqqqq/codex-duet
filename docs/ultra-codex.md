# /codex:ultra-codex — Ultracode-style orchestration with Codex workers

`/codex:ultra-codex <task>` makes the Claude Code main agent run a substantive
task the way Claude Code's own Ultracode mode does, with Codex workers in place
of Claude subagents. Claude scouts, assigns, judges and integrates; Codex
investigates, implements and reviews. Claude prefers the native
`codex:codex-native` agent when available; otherwise it runs `duet task` in
background Bash. The report arrives with the completion notification. Only if
missing, Claude runs `duet result <worker>`; full evidence and handles are in
`duet result <worker> --details`. No output-file parsing is needed.
`/codex:ultra-codex on` makes that the session's default (see "Mode" below);
`off` ends it.

## Mode: on, off, and what "off" means

Ultracode is a session setting (`/effort ultracode`), and so is ultra-codex
mode. `ultra-codex on [--quick|--thorough] [--max-workers <n>]` writes a small
JSON record to `<isolated home>/duet/ultra-codex/<session id>.json`, shared across
workspaces and keyed by the Claude session id that the SessionStart hook exports as
`CODEX_COMPANION_SESSION_ID`. While the record exists, the plugin's
`UserPromptSubmit` hook (`scripts/ultra-codex-hook.mjs`, about 70 ms) appends a
one-line versioned reminder to every prompt (shown with the repository-relative
protocol path):

> Ultra-codex mode on (thorough, max 4 workers). Apply protocol v554ef268 to
> substantive tasks; re-read plugins/codex/prompts/ultra-codex-protocol.md only if
> v554ef268 is not in your context.

Control-only invocations (`on`, `off`, `status` or no arguments) do not load the
protocol; task invocations, including `on` with task text, use Read on its path.
The reminder requests a re-read only when that content version is absent from
context, so the per-prompt cost is the reminder. The hook is silent for other
sessions in the same repository, for prompts that are the command itself, when
no session id is present, and on any error.
On/off/status, reminders and SessionEnd all use this session-wide record, so
changing repositories does not lose the mode or leave another workspace armed.
Scale and `--max-workers` remain instructions for Claude's orchestration;
the runtime does not enforce a worker scheduler limit.

Three things turn the mode off:

- `/codex:ultra-codex off` removes the record, lists this session's Codex jobs
  that are still running (they are not cancelled; `duet cancel <worker>` does that on
  request) and tells Claude that the orchestration has ended.
- The session's end (`SessionEnd` hook) and a fresh start or `/clear` for the
  same session id (`SessionStart` with `source` other than `resume`/`compact`).
  `claude --resume` and compaction keep the current session mode. Workspace-keyed
  legacy mode files are discarded, not adopted; after upgrading with only a
  legacy record, enable the mode again.
- Records older than 30 days are pruned at the next `SessionStart`, so a
  session that died without `SessionEnd` cannot leave the mode armed. This fixed
  policy covers global and legacy workspace mode directories and is separate
  from configurable job retention.

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

`/codex:ultra-codex` reproduces that division of labour with native agents
or background Bash and direct Codex jobs, so it works at any effort level without the Workflow tool:

| Ultracode element | /codex:ultra-codex equivalent |
| --- | --- |
| `agent()` with `schema` | `codex:codex-native` or Bash → `duet task`; the report is schema-enforced (`schemas/worker-report.schema.json`) |
| `parallel()` fan-out | one named native agent or background `duet task` per job; reports arrive with completion notifications |
| `phase()` | the seven phases below, tracked with `TodoWrite`; a phase starts when the previous one's reports are in |
| `isolation: "worktree"` | Claude creates worktrees with `git worktree add`, passes each as `--cwd` and merges the branches; a shared checkout requires disjoint OWNED PATHS |
| journal cache / resume | `journal show` recovers criteria, verdicts, decisions and saved worker artifacts; `duet task --continue <jobId> --cwd '<cwd>'` starts an explicitly requested continuation while its job record is retained |
| adversarial verify, judge, loop-until-dry | the Verify phase: read-only reviewer workers, findings routed to the owning implementer, at most the configured fix rounds |

Use the [dispatch recipe](direct-mode.md): a named native agent with an optional
first prompt line `DUET: <flags>`, or `duet task` with a single-quoted `DUET_TASK`
heredoc in background Bash. Investigators and reviewers use `--sandbox read-only`.
SessionStart supplies invocation guidance. After registration, the native
adapter advertises readiness on the first accepted non-command person prompt
(`prompt.submit`). If `duet` is not on PATH, reload/start a new session
or use the absolute `bin/duet` launcher. Native-hook failure returns a blocked
report; check `duet status` before retrying.

Native follow-ups and answers use SendMessage to the agent's name. Bash
follow-ups use `duet task --to <worker>` and a new stdin brief; `running` uses
one background `duet wait <worker>`, and `needs_answer` uses one background
`duet answer <worker> --question '<questionId>'` with the displayed ID and a
single-quoted `DUET_ANSWER` heredoc; prefer the report's `next` command verbatim.
A bare `duet answer <worker>` can answer a newer pending question; native
SendMessage already pins the displayed question. Never run two
waits. Reports arrive with the completion notification; only if missing, run
`duet result <worker>`. Use `--details` for shortened evidence or questions.
Direct waits default to 3600 s (maximum 3600), the lease to 1800 s; `--quiet`
suppresses progress. Never poll, sleep or parse output files.

`--to`/`--thread` keep recorded settings unless overridden; restate read-only
sandbox and normal speed when narrowing a follow-up. `--fork` explicitly imports
the current Claude transcript into a new Codex thread before running the brief,
labelled “imported Claude conversation (fidelity not verified)”. It cannot
combine with thread-selection flags; follow up afterwards with `--to`.

Stop active native tasks or background Bash waits from `/tasks`, or run
`duet cancel <worker>`. Continue user-stopped work only with consent. A question
parked after a native agent returns may not cancel immediately when that ended
row is stopped; explicit cancellation or its default 900 s timeout applies.
When several reports are already pending, accept each; batch only missing-report
or detail reads and the subsequent separate verdict writes. Stop on a failed
read/submission; never delay questions for a batch or prewrite verdicts.

The read-only `codex-live` pane shows prompts, messages, commands, file changes,
tool calls, plans and questions at no Claude token cost. Resolved `ask_parent`
answers are matched by Codex's `_meta.callId`, preserved by the MCP bridge on
fresh and resumed threads; missing/invalid call IDs remain unmatched. New jobs
request a pane; `/codex-live` opens it at any width. It never starts, answers or cancels jobs.

The Haiku `codex:codex-worker` remains a fallback when native dispatch and
background Bash are unavailable, or for a requested forwarding-agent transcript.
Put Codex's model/effort in its brief, not Agent fields. Rework starts a NEW
fallback agent with `duet task --to <worker>`; SendMessage to an existing
fallback only answers its pending question. The Workflow tool's fallback
`agentType: "codex:codex-worker"` integration has not been exercised with Duet
and is not required by this command.

## Why the briefs and the acceptance are stricter than Ultracode's

Ultracode agents are the same model as the orchestrator, read the same
`CLAUDE.md`, and in a fan-out share a prompt cache with it; a terse assignment
is usually read the way it was meant. A Codex worker receives the brief, repository and forwarded Claude instruction
files, but the conversation only through an explicit `--fork`. An import does
not establish that it shares the orchestrator's reading of the user's intent. Every gap in a brief is filled with
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
  check (`changedFiles`, or `touchedFiles` in `--details`, within `OWNED PATHS`,
  confirmed with `git diff --stat`);
  reading the diff rather than the summary, looking for unrequested behaviour
  changes, weakened or rewritten tests, new dependencies, stubs, swallowed
  errors; a criteria walk recording evidence → verdict per criterion;
  a verification audit comparing `checks.claimed` with captured `checks.ran`
  (`claimedVerification`/`verification` in `--details` when shortened) and rerunning the commands; an assumptions audit
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

After writing task-level criteria, Claude runs `duet journal
start` with stdin JSON containing `goal` and `criteria`. Tasks in that Claude
session link automatically across workspaces and worktrees, preserving the exact
worker brief and final compact report. `task --run <id|none>` overrides linkage
for one dispatch; follow-ups do not inherit it. An explicit run must be open in
the same isolated home, including across workspaces; invalid/closed runs fail
before a worker starts, and `none` skips linkage.
Claude records each acceptance with `journal add verdict`,
consequential decisions and accepted assumptions with `journal add decision`,
then runs `journal validate` before `journal close` (`passed`, `blocked` or
`abandoned`). A passed close refuses unresolved issues with exit 2 and leaves
the journal and active pointer unchanged; blocked/abandoned closes record them.
When a fresh worker resolves REWORK or REASSIGN, its verified `ACCEPT` or
`ACCEPT_WITH_GLUE` verdict includes `resolves: ["<rejectedJobId>", ...]`.
Unknown IDs are rejected. Accepted `followUpOf`/`continuationOf` descendants also
resolve earlier rejections; same-thread follow-ups can discover that predecessor
across worktrees. A later rejection reopens the work.

Keep the current run by default. Only for an unrelated task the user starts
mid-run, `journal start --switch` leaves the old run open, selects the new one
and returns `previousRunId`. When the user drops criteria, `journal add withdraw`
takes `{"criteria":["..."],"reason":"..."}` with known exact criterion text.
Withdrawn criteria show their reason and no longer cause unchecked/unmet
issues; `add criteria` with the same text reactivates them.

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

Each direct or `--report` turn asks Codex for a structured final response with
status, summary, findings, assumptions, verification, blockers and question. The
helper merges those declarations with its own captured evidence. Report v2
arrives with the completion notification:

- `status`, `worker`, `jobId`, `summary` come first. The summary is capped at
  8000 characters with `summaryTruncated` when cut; the rest fits within 2000 bytes.
- Nonempty `blockers`, `question`, `changedFiles`, `checks`, `assumptions` and
  `keyFindings` follow, then optional `usage` (integer `inputTokens`,
  `cachedInputTokens`, `outputTokens`, `reasoningOutputTokens`, `totalTokens` for
  this turn only; omitted when unknown). Lists/text may be shortened;
  `changedFilesOmitted`, `checks.omitted` and `question.optionsOmitted` count
  omissions. `checks.ran` is captured command evidence;
  `checks.claimed` is Codex's account.
- `next` suggests an action or is null; `details` supplies `duet result '<jobId>'
  --details`, always targeting the exact job even after a follow-up, for handles,
  settings, tracking basis, artifact paths and fuller evidence.
- A runtime refusal forces `blocked`; a `completed` response that is only a plan
  or question becomes `needs_input`. Neither counts as accepted work.

In `--details`, `reportFormat: "structured"` marks parsed worker declarations;
otherwise the helper inferred fields from prose. `verification` is captured,
`claimedVerification` is declared, and `touchedFiles`/`fileTrackingStatus` describe
file evidence. Read `rawOutputFile` only when a report field is insufficient.

## Approvals during orchestration

Workers run with approval policy `never+elicitations`: command, sandbox, rule
and permission prompts are rejected as before, and MCP elicitations are
forwarded. A Computer Use app request that no `--approve-computer-app` flag
covers reaches the parent as a pending question with four fixed options (`Allow
this call`, `Allow for this task`, `Allow always (isolated Codex home)`, `Deny`).
The orchestrator forwards it to the user through `AskUserQuestion` unless the
user pre-authorised the app. Submit only an
exact displayed label, its number `1`–`4`, or one of
`call`/`once`/`task`/`always`/`deny`/`no`. Answers are trimmed and case-insensitive;
exact labels allow a trailing period. Anything else, including `yes`, negations
and qualified replies, denies the request. Send the choice without explanation
through the pinned answer command or native SendMessage. See
[approval choices](computer-use-approvals.md#forwarded-approvals-owned-jobs).

## Project instructions

Claude's loaded CLAUDE.md/rules are automatically forwarded as developer
instructions, including user-level files. When the inventory is unavailable,
Duet reports an approximate startup scan. It excludes auto-memory by real path,
including indirect aliases through symlinked directories. Existing threads retain
their original instructions. Disable forwarding for a fresh task with `--no-claude-md` or set
`CODEX_COMPANION_CLAUDE_MD=0`.

Codex also discovers `AGENTS.md` itself. Duet's separate default
`project_doc_fallback_filenames = ["CLAUDE.md"]` lets Codex read project
CLAUDE.md where no AGENTS.md exists; `duet setup --project-docs agents-only`
removes only that exact fallback list, leaving custom lists intact. It does not
disable forwarding. See [configuration](configuration.md#claude-instructions-and-conversation-imports).

## Protocol content version

The first line of [the protocol](../plugins/codex/prompts/ultra-codex-protocol.md)
is `<!-- Ultra-codex protocol v<hash> -->`. The hash is the first eight lowercase
hex digits of SHA-256 over the UTF-8 text after removing only the matching
version line and its newline. Keep the following blank line and all other bytes.
`protocolVersion()` in `scripts/lib/ultra-codex-mode.mjs` computes it at runtime;
`tests/ultra-codex-mode.test.mjs` checks that the committed header matches. After
editing the body, recompute the header and update the example reminder above.
