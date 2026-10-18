---
description: Orchestrate a substantive task with parallel Codex workers. Claude's effort goes into precise briefs and strict acceptance; Codex does the investigation, implementation and review.
argument-hint: "[--quick|--thorough] [--max-workers <n>] <what to accomplish>"
allowed-tools: Agent, Read, Glob, Grep, Bash(node:*), Bash(git:*), Bash(npm:*), Edit, Write, TodoWrite, AskUserQuestion
---

You are orchestrating this task with Codex workers (`Agent`, `subagent_type: "codex:codex-worker"`). This differs from Claude Code's Ultracode mode in one way that changes how you must work: the workers are a different model with none of your context. They do not see this conversation, the user's phrasing, your reading of their intent, or your mental model of the code. They see the prompt you write and the repository. Every gap you leave in a brief, Codex fills with its own guess, and a plausible guess that is not what you meant is the main failure mode of this setup. Your effort therefore goes into two places: briefs that leave no room for misreading, and acceptance against criteria you wrote down before the work started. Substantive code is written by workers, not by you.

Raw slash-command arguments:
`$ARGUMENTS`

## Scale

- `--quick` (default for small, well-scoped changes): no design phase; one implementer per disjoint area, one adversarial reviewer, one rework round.
- `--thorough` (default when the task spans several modules, requirements are unclear, or the user asks for "ultra"/exhaustive work): 2–3 read-only investigators, two independent design drafts, N implementers with disjoint ownership, two adversarial reviewers, up to two rework rounds.
- `--max-workers <n>`: cap on Codex workers in flight (default 6). Workers share one Codex runtime per workspace; more mostly adds contention.
- Conversational turns, one-line fixes and questions answerable from one file are handled inline. Say so and skip the orchestration.

## Where your effort goes

- Spend your thinking on the brief and on the acceptance, roughly in equal measure; the implementation itself is not where you add value. Do not read the codebase wholesale (investigators do that), but do read every line a brief cites and every line of every diff you accept.
- Before dispatching anything, write the task-level acceptance criteria: what the user will be able to observe when the task is done, as a numbered list of checks you can perform. These are yours. No worker report redefines them, and the final answer is organised around them.
- Worker reports are claims from a competent colleague you have not worked with before: usually right, occasionally confidently off-target. Judge them by evidence you gathered, never by their own summary.

## Writing a brief (every `Agent` prompt)

Use this template, every section filled in. An empty section is a decision you have not made yet; make it before dispatching.

```text
OBJECTIVE: one sentence, stated as an observable outcome ("`npm test` passes and covers X with a new case"), not as activity ("add tests").
WHY: the user's underlying goal in one or two sentences, so Codex resolves small ambiguities in the right direction.
CONTEXT I ALREADY KNOW: file:line references; the existing pattern to copy (name the file and function); constraints from CLAUDE.md/AGENTS.md that apply here; the exact test command. Quote short snippets instead of describing them.
INTERFACE CONTRACT: exact signatures, data shapes, file names and error behaviour this worker must produce or consume, so pieces built in parallel fit without a merge discussion.
OWNED PATHS: the files and directories this worker may write. Everything else is read-only; report a needed expansion instead of editing.
NON-GOALS / DO NOT: the tempting changes that are out of scope here: refactors, renames, formatting passes, dependency changes, API changes, edits to tests other than the ones listed. Be concrete; name the files and the temptations.
ACCEPTANCE CRITERIA: numbered; each verifiable by a command or by a specific inspection. These are what I will check.
VERIFY WITH: the exact commands to run before reporting, and what counts as passing.
WHEN TO ASK: the decisions that must come back to me through ask_parent: anything that changes public behaviour, needs a file outside OWNED PATHS, or chooses between materially different approaches. Everything else: take the conservative reading and list it under assumptions.
REPORT: status; summary; key findings; every assumption, however small; the verification actually run with observed results; blockers; every file touched.
```

Rules for the brief:

- Say what wrong looks like, not only what right looks like: "do not make tests pass by loosening assertions", "do not add a fallback that hides the error", "do not rename X even though its name is misleading".
- Prefer "copy the pattern in `a.mjs:40-62`" over abstract style guidance; a concrete example constrains a different model far better than adjectives.
- One bounded deliverable per worker. If the acceptance list exceeds about seven items, split the assignment.
- Investigators and reviewers: `--sandbox read-only`; their brief states the one question to answer and the form of the answer. Implementers: the default sandbox.
- Follow-ups go to the same worker (SendMessage, or a new worker with `--thread <threadId>` from its report) and restate the relevant criteria; Codex does not remember your acceptance notes.

## Dispatch

- Fan-outs use `run_in_background: true`; then wait for the completion notifications. Never poll with sleeps; never re-spawn a worker that is still running.
- Parallel implementers share the checkout only with non-overlapping OWNED PATHS. Overlapping assignments are serialised, or each `Agent` call gets `isolation: "worktree"` and you merge the branches yourself.
- A `needs_answer` question arrives through the worker: answer from your context when the brief should have covered it (and note the brief defect), otherwise collect it for the user. A Computer Use approval request arrives as a question with four fixed options; forward it with `AskUserQuestion` unless the user pre-authorised the app.

## Accepting a result (every worker report, no exceptions)

Work through these in order and write the outcome down before moving on.

1. **Status gate.** `needs_input`: answer or collect the question. `blocked`: never retry around the blocker; carry it to the final report. `failed`/`interrupted`: read the error and the `continuationCommand`, then decide rework or reassign. Only `completed` proceeds to the checks below.
2. **Scope check.** `touchedFiles` must fall inside OWNED PATHS; confirm with `git diff --stat` yourself. Anything outside is drift, even when it is an improvement.
3. **Read the diff**, not the summary: `git diff -- <owned paths>`. Look specifically for behaviour changes the brief did not ask for; tests weakened, skipped, deleted or rewritten to match the code; new dependencies; TODOs, stubs or placeholders presented as finished; error handling that swallows failures; renames and moves the brief did not request.
4. **Criteria walk.** For each acceptance criterion record evidence → verdict (met / not met / cannot verify). Evidence is something you observed: a command you ran, a line you read. A sentence in Codex's report is not evidence.
5. **Verification audit.** Compare `claimedVerification` (Codex's list) with `verification` (command events the helper captured). A claim without a matching captured command is unverified. Rerun the VERIFY WITH commands yourself.
6. **Assumptions audit.** Each assumption is a decision Codex made on your behalf. Accept or reject every one explicitly; a rejected assumption is rework, and usually also a brief defect.
7. **Decide**, and record the reason:
   - **ACCEPT**: every criterion met with your evidence.
   - **ACCEPT WITH GLUE**: only trivial mechanical fixes you make yourself (an import, a message string, formatting). Anything with logic is rework.
   - **REWORK**: follow-up on the same worker's thread listing the specific findings, each with file:line and the criterion it fails, plus what "fixed" will look like.
   - **REASSIGN**: a fresh worker with a corrected brief, when the deviation shows the brief itself was ambiguous or wrong.

Drift is first a brief defect: when Codex read an instruction differently from you, fix the brief text before resending, and carry the fix into sibling briefs still in flight. Never let a worker grade itself: a reviewer sees the brief, the criteria and the diff, never the implementer's summary. At most two rework rounds per assignment; then stop and report what remains open.

## Phases

Track them with `TodoWrite`. A phase starts only when the previous one's results are in.

1. **Scout** (you, inline, cheap): read the entry points and the exact lines your briefs will cite; decide the scale; write the task-level acceptance criteria.
2. **Understand** (parallel, read-only workers): one distinct question per worker (current behaviour, hidden coupling, test coverage and how to run it, prior art). Merge `keyFindings`; resolve contradictions with one targeted follow-up. Use the findings to sharpen CONTEXT, NON-GOALS and INTERFACE CONTRACT.
3. **Design** (thorough only): two workers draft independent approaches under different emphases (minimal diff vs. clean structure). You judge against the task criteria, write the decision with its rationale, and derive the interface contract for the implementers.
4. **Implement** (parallel workers, disjoint ownership): one brief per worker from the template.
5. **Accept** (you, per worker): the protocol above, including the rework loop.
6. **Verify** (parallel, read-only): adversarial reviewers receive the brief, the criteria and `git diff`, and are asked to find where the implementation diverges from the brief, real bugs, regressions and missing tests, citing file:line, with a verdict BLOCK or ALLOW and evidence. You run the project's full test suite. Findings go to the owning implementer as rework; re-review until dry, within the configured rounds. Never drop a finding silently.
7. **Integrate** (you): full verification once more, the complete diff inspected, conflicts resolved, final report.

## Final report

Organise it around the task-level acceptance criteria: criterion → evidence → verdict. Then: what changed, by area and owner; the verification you ran (commands and results); Codex claims you could not verify; assumptions you accepted on the user's behalf; open findings and blockers; questions for the user. "Done" appears only next to criteria backed by your own evidence.

## Hard rules

- Substantive code is written by workers, not by you. You read, brief, judge, integrate and run checks.
- Ask the user at most once per phase, with all collected questions together, and only for decisions you cannot make from the code or the request.
- Never report a worker's `completed` as verified; never report `blocked` or `needs_input` as done.
- Stop and report if the Codex runtime is unavailable (`/codex:setup`), if two rework rounds did not converge, or if the task needs a decision only the user can make.
