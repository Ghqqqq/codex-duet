# /codex:ultra-codex — Ultracode-style orchestration with Codex workers

`/codex:ultra-codex <task>` makes the Claude Code main agent run a substantive
task the way Claude Code's own Ultracode mode does, with Codex workers in place
of Claude subagents. Claude scouts, assigns, judges and integrates; Codex
investigates, implements and reviews. Claude uses the native
`codex:codex-native` agent from the first dispatch, without waiting for readiness.
Background `duet task` is for `native_adapter_unavailable`, `native_capacity`,
per-call options the `DUET:` line rejects, or follow-ups to Bash-launched workers.
The report arrives with the completion notification. Only if
missing, Claude runs `duet result <worker>`; full evidence and handles are in
`duet result <worker> --details`. No output-file parsing is needed.
`/codex:ultra-codex on` makes that the session's default (see "Mode" below).
It is one of three modes: [pair](pair.md) keeps one executor thread, while
[duel](duel.md) puts a Claude subagent and a Codex worker in adversarial roles.
Only the selected mode's rules apply; all share briefs, acceptance and the journal.

## Mode: on, off, and what "off" means

Ultra, pair and duel use one session record at
`<isolated home>/duet/ultra-codex/<session-id>.json`, shared across workspaces.
SessionStart exports its key as `CODEX_COMPANION_SESSION_ID`. `on` replaces any
other active mode; `/codex:ultra-codex off` clears only ultra. If pair or duel is
active, that named off leaves it unchanged. Switching/off reports this session's
running Codex jobs without cancelling them. Claude waits for conflicting writes
to settle before assigning new work; old jobs still count toward ultra's cap.

```text
/codex:ultra-codex on --thorough --max-workers auto
/codex:ultra-codex --quick add --json to the cancel command
/codex:ultra-codex off
duet ultra-codex status
```

No arguments means status. `on <task>` first enables the validated settings,
then runs the task; a failed activation starts nothing. `<task>` without `on`
is one-shot, even while another mode is active: the command selects ultra for
that task and leaves the saved mode unchanged. Leading task options override
matching saved settings for that task only; otherwise ultra defaults apply.
A normal prompt uses the active mode, with the same task-prefix override rule.
`--` starts literal task text; later option-like words stay in the task. Exact
`off` and `status` take no task text. See [the grammar](commands.md#codexultra-codex).
The CLI accepts controls only and never starts workers.

The `UserPromptSubmit` hook appends one versioned reminder to normal prompts.
**Reminder template** (placeholders, not a current version or path):

```text
Ultra-codex mode on (<scale>, max <n> workers (auto), routine <routineModel>, strong <model>). Apply protocol v<hash> to substantive tasks; re-read <absolute-protocol-path> only if v<hash> is not in your context.
```

An explicit integer renders `max <n> workers`; `unlimited` renders `no worker cap`.
Pair and duel name their own section in their reminders. Run
`duet ultra-codex status --for-command` for the actual path and current version,
or add `--json` for `protocolFile`/`protocolVersion`. All three commands use the
same [protocol file](../plugins/codex/prompts/ultra-codex-protocol.md) and body
hash. An edit to any mode or shared section invalidates the version for all modes.

Control-only invocations do not use Claude's Read tool or load the protocol
body into context; the CLI reads it internally to compute the hash. Task
invocations read the file before orchestration, then use only shared sections
and **Ultra mode**. A reminder asks for a re-read only if that version is absent
from context. The hook suppresses reminders for any of the three mode commands
and stays silent without valid active state/session ID or on errors. The slash
preamble runs the fixed `ultra-codex status --for-command`; raw task text never
enters executable shell arguments.

Existing unversioned global ultra records normalize to schema 2 on read without
being rewritten; the next successful `on` writes the new shape. Positive saved
caps, including older 6 and grandfathered values above 64, survive status,
reminders, repeated ultra `on`, resume and compaction. Repeated ultra `on` resets
scale to `auto` unless supplied and keeps the cap unless explicitly changed.
After off or replacement, activation gets fresh defaults; inactive-mode options
are not retained. Workspace-keyed legacy records are discarded, never adopted.

SessionEnd, a fresh SessionStart and `/clear` clear the active mode; resume and
compaction preserve it. After clearing, fresh sessions and `/clear` apply the
opt-in default saved with `duet setup --default-mode off|ultra|pair|duel`, using
standard mode options (new installs default to off). Per-session changes never
change that [saved default](configuration.md#default-orchestration-mode).
SessionStart also prunes mode records older than 30 days,
separately from job retention. See [mode state](state-and-retention.md#orchestration-mode-state).
Natural-language stop ends new dispatch immediately: Claude reports in-flight
workers and clears the active mode when requested. Jobs are cancelled or
user-stopped work continued only with the user's consent.

Use the plugin names `/codex:ultra-codex`, `/codex:pair` and `/codex:duel`.
Bare aliases require user-level configuration outside this plugin.

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
| `pipeline()` / `phase()` | per-item dependencies tracked with `TodoWrite`; accept a result and start its ready downstream work as a slot opens |
| `isolation: "worktree"` | Claude creates worktrees with `git worktree add`, passes each as `--cwd` and merges the branches; a shared checkout requires disjoint OWNED PATHS |
| journal cache / resume | `journal show` recovers criteria, verdicts, decisions and saved worker artifacts; `duet task --continue <jobId> --cwd '<cwd>'` starts an explicitly requested continuation while its job record is retained |
| adversarial verify, judge, loop-until-dry | independent read-only probes, evidence-backed findings routed to the owner, bounded rework |

Use the [dispatch recipe](direct-mode.md): a named native agent with an optional
first prompt line `DUET: <flags>`, or `duet task` with a single-quoted `DUET_TASK`
heredoc in background Bash. Investigators and reviewers use `--sandbox read-only`.
SessionStart supplies native-first guidance. The registered adapter's readiness
notice is informational; dispatch does not wait for it. Each fresh native call
reserves a scientist pool name before spawn, replacing a passed label unless it
is a free pool name. The Agent result's context carries a `Codex worker named X`
note for an assigned or replaced name; use that name for SendMessage. Reservation
failure leaves the call unchanged; resumptions keep their name. Bash dispatch
can request a fresh name with `--name <label>`; collisions
fall back to the pool and job-ID prefixes are reserved. If `duet` is not on PATH,
reload/start a new session or use the absolute `bin/duet` launcher. Native-hook
failure returns a blocked report; run `/reload-plugins`, check `duet status` before
retrying and use background `duet task` if it persists.

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
  must come back through `ask_parent`. Read-only finders, judges, reviewers and
  investigators use a shorter probe brief with one question, evidence format
  and explicit read-only bounds. See the [brief templates](../plugins/codex/prompts/ultra-codex-protocol.md#writing-a-brief-every-codex-assignment).
- **Full acceptance** applies to every changed deliverable, including docs,
  tests and substantive rework: status gate; scope
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
- **Probe acceptance** checks status, answer completeness and cited evidence.
  Decision-driving findings receive independent adversarial confirmation, then
  Claude spot-checks the decisive citation and records a verdict. Consequential
  or conflicting probe claims receive full acceptance. A worker's vote never
  accepts code or replaces a required check. See the [acceptance protocol](../plugins/codex/prompts/ultra-codex-protocol.md#accepting-a-result-every-worker-report-no-exceptions).

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
Without an active run, add, close and task linking use the sole open workspace
run. With several open runs, tasks stay unlinked and add/close require
`journal use <runId>` or `--run <id>`.
Claude records each acceptance with `journal add verdict`,
consequential decisions and accepted assumptions with `journal add decision`,
then runs `journal validate` before `journal close` (`passed`, `blocked` or
`abandoned`). A passed close refuses unresolved issues with exit 2 and leaves
the journal and active pointer unchanged; blocked/abandoned closes record them.
When a fresh worker resolves REWORK or REASSIGN, its verified `ACCEPT` or
`ACCEPT_WITH_GLUE` verdict includes `resolves: ["<rejectedJobId>", ...]`.
Jobs linked to that run can be resolved regardless of session; unknown IDs are
rejected. Verdict criteria match declared exact text, a unique shown prefix
ending in `…`, or a unique ID (`K7`, or `F3` before a colon) already present in a declared criterion.
Unknown or ambiguous criteria are rejected; introduce new ones with
`journal add criteria`. Accepted `followUpOf`/`continuationOf` descendants also
resolve earlier rejections; same-thread follow-ups can discover that predecessor
across worktrees. A later rejection reopens the work.

Keep the current run by default. Only for an unrelated task the user starts
mid-run, `journal start --switch` leaves the old run open, selects the new one
and returns `previousRunId`. When the user drops criteria, `journal add withdraw`
takes `{"criteria":["..."],"reason":"..."}` with known exact criterion text.
Withdrawn criteria show their reason and no longer cause unchecked/unmet
issues; `add criteria` with the same text reactivates them.

In a new session, `journal use <runId>` selects the existing open run, including
across workspaces, so later dispatches link to it. After compaction or a resumed
session, `journal show` recovers the goal,
criteria, latest worker verdicts, decisions and open items. SessionStart adds a
one-line reminder when a run is active. Journals live only in Duet's isolated
home, survive job-record pruning, and follow the retention window; they neither
verify claims nor restart work. See [Run journal](run-journal.md) for schemas,
commands and limits.

## Recipes and per-item coordination

Orchestrate every substantive task. Solo work is limited to conversational
turns and trivial mechanical edits; a single-file question still qualifies.
Claude scouts enough to discover the work-list and writes observable criteria
before dispatch. Workers write substantive code; Claude owns judgment,
integration, checks and trivial glue. Compose the recipes the task needs:

| Recipe | Coverage |
| --- | --- |
| Understand | Parallel readers for distinct subsystem questions; reconcile interfaces and unknowns |
| Design | Independent approaches and judges scoring the same criteria; synthesize and freeze shared contracts |
| Review | Area × lens coverage for correctness, security, performance and regressions; verify findings and re-review affected cells |
| Research | Independent searches by container, content, entity and time; reconcile sources and use a completeness critic |
| Migrate | Inventory all sites, agree the transform, assign disjoint owners and verify completeness |
| Implement and integrate | Full briefs per deliverable, accept each diff, inspect the integrated result and run the full suite |
| Live debugging | After one failed live fix or any unexplained live behaviour, at least two competing-hypothesis investigators plus a separate live diagnostic before another fix |

Track each item's dependencies, worker/job, reviewed state and next stage with
`TodoWrite`. Accept and journal each result as it arrives, then start that item's
ready downstream work. One area's verified findings or accepted implementation
can advance while another area is still working. Serialize overlapping writes
and recheck results when their inputs change. Wait for the whole set only for
real shared dependencies: deduplication, design comparison/synthesis, a shared
contract, a global zero-results decision or final integration. Failed or
unverified prerequisites remain open. This is coordination through native
dispatch and notifications; no Workflow tool or script runner is supplied.

Use adversarial and perspective-diverse verification, independent judge panels,
varied search modalities and completeness critics where they improve confidence.
For unknown-size discovery, loop until dry (normally two consecutive rounds
without new findings for thorough work), deduplicating against all seen findings,
including rejected ones. Incomplete searches are not dry. This never replenishes
the maximum of two rework rounds per assignment. Disclose sampled or omitted
coverage and unresolved findings. The full policies live in the
[Ultra mode section](../plugins/codex/prompts/ultra-codex-protocol.md#ultra-mode).

## Scale, model tiers and concurrency

`auto` chooses task depth. `--quick` skips unnecessary design and uses focused
finders, relevant review cells and one independent verifier per finding; its
default is one rework round. `--thorough` widens subsystem/search coverage,
uses independent designs/judges where useful, 3–5 adversarial verifiers for
consequential findings and a completeness critic, with up to two rework rounds.
Scale to the discovered work-list rather than a fixed reviewer roster.

| Stage | Explicit default model / effort |
| --- | --- |
| Mechanical scanning, inventory, triage, first-pass finders | Configured routine model (default `gpt-6.1-sol`) / `medium` |
| Implementation, investigation, design drafts, ordinary review | Configured routine model (default `gpt-6.1-sol`) / `xhigh` |
| Adversarial verification, judging, hard debugging, deep architecture | Configured worker model (default `gpt-6-astra`) / `xhigh`, or justified `max` after checking support |

Speed is `--normal` unless the user asks for `--fast`. Explicit user choices
take precedence. If integration/runtime support for `max` is absent, report it
and use `xhigh`. These are ultra's stage defaults; pair and duel use the
configured worker model and effort. Change ultra's saved models with
`duet setup --default-model <model> --ultra-routine-model <model>`; see
[Default worker models](configuration.md#default-worker-models). The mode
reminder and status name the effective values; `--default-effort` does not
change ultra's effort by stage.

`--max-workers <n|auto|unlimited>` sets an advisory cap across phases,
workspaces/worktrees, native jobs and Bash fallback jobs. The default follows
native Ultracode: min(16, CPU count − 2) workers in flight, with a minimum of one
(16 on an 18-core Mac). `auto` uses the runtime's available CPU count;
`--max-workers` raises or lowers the cap, explicit integers must be 1–64, and
`unlimited` removes it. JSON reports the effective number as `maxWorkers`
(`null` for unlimited) and the saved choice as `maxWorkersSetting`.

The cap limits concurrency, never coverage. Claude counts running and
question-waiting jobs, queues excess work and refills slots on notifications;
capacity errors or degraded throughput warrant fewer active slots with the
remaining coverage queued. It is not an enforced runtime scheduler. Sixteen
native read-only workers were measured in flight together on the shared
runtime: all completed, with admission serialized at about 2 s per agent and no
start delay or slowdown. Larger or heavy mutating fan-out is not a measured
guarantee. Existing saved caps are retained
as described above.

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
`tests/ultra-codex-mode.test.mjs` checks that the committed header matches. All
three modes share this hash and the absolute file path; the legacy filename and
header are retained. After editing any body section, recompute the header.
`duet ultra-codex status --for-command` (or the pair/duel equivalent) reports
the current computed version, even if the stored header is stale. The reminder
above is a labeled template and does not need a copied literal hash.
