---
description: Orchestrate a substantive task Ultracode-style with parallel Codex workers. Claude scouts, plans, judges and integrates; Codex investigates, implements and reviews.
argument-hint: "[--quick|--thorough] [--max-workers <n>] <what to accomplish>"
allowed-tools: Agent, Read, Glob, Grep, Bash(node:*), Bash(git:*), Bash(npm:*), Edit, Write, TodoWrite, AskUserQuestion
---

Run the assignment below as an orchestrated, multi-worker effort. You (Claude) are the orchestrator: you scout, write precise assignments, judge results, and integrate. Codex workers (`Agent` with `subagent_type: "codex:codex-worker"`) do the substantive investigation, implementation and review. The point is the same as Claude Code's Ultracode workflows: exhaustive, verified work through parallel agents, except that the agents are Codex and spend no Claude quota.

Raw slash-command arguments:
`$ARGUMENTS`

## Scale

- `--quick` (default for small, well-scoped changes): skip the design phase; 1 implementer per disjoint area, 1 adversarial reviewer, 1 fix round.
- `--thorough` (default when the task touches several modules, has unclear requirements, or the user asks for "ultra"/exhaustive work): 2–3 read-only investigators, 2 independent design drafts, N implementers with disjoint ownership, 2 adversarial reviewers, up to 2 fix rounds.
- `--max-workers <n>`: cap on Codex workers in flight at once (default 6). Workers share one Codex runtime per workspace; more than that mostly adds contention.
- If the task is conversational, a one-line fix, or a question answerable from one file, say so and handle it inline. Orchestration is for substantive work only.

## Worker contract (every `Agent` call)

- `subagent_type: "codex:codex-worker"`. Fan-outs use `run_in_background: true` and then wait for the completion notifications; never poll with sleeps and never re-spawn a worker that is still running. One assignment per worker; follow-ups go to the same worker (SendMessage, or a new worker with `--thread <threadId>` from its report).
- The prompt carries: objective; the context you scouted (file paths, line references, constraints); **owned paths** for writes; restrictions; acceptance criteria; the exact verification commands to run. Investigators and reviewers get `--sandbox read-only`. Implementers get the default sandbox.
- Parallel implementers may share the checkout only with non-overlapping write ownership. When two assignments must touch the same files, either serialize them or give each `Agent` call `isolation: "worktree"` and merge the branches yourself afterwards.
- Read the worker's JSON report, not its prose: `status` (`completed` / `needs_input` / `blocked` / `failed` / `interrupted`), `keyFindings`, `claimedVerification` (Codex's claim) versus `verification` (captured command events), `touchedFiles`, `blockers`, `question`. `needs_input`: answer from your context if you can, otherwise collect the question for the user. `blocked`: do not retry around the blocker; carry it into the final report. A Computer Use approval request arrives as a pending question with four fixed options; forward it to the user with `AskUserQuestion` unless they pre-authorised it.
- Treat every Codex claim as unverified until you ran the check yourself in the integrate phase.

## Phases

Track them with `TodoWrite`. Each phase starts only when the previous one's results are in.

1. **Scout (you, inline, cheap).** Read just enough to write precise assignments: entry points, the files likely to change, the test command. Decide the scale. Do not read the whole codebase yourself; that is what investigators are for.
2. **Understand (parallel, read-only workers).** One distinct question per worker: current behaviour, constraints and hidden coupling, test coverage and how to run it, prior art in the repo. Merge their `keyFindings`; resolve contradictions with one targeted follow-up, not a new fan-out.
3. **Design (thorough only).** Two workers draft independent approaches under different emphases (e.g. minimal diff vs. clean structure). You judge: pick one or merge, write the decision and its rationale into your plan. Optionally a third worker critiques the chosen design before implementation.
4. **Implement (parallel workers, disjoint ownership).** One worker per area with explicit owned paths, acceptance criteria and the verification commands. Workers report an ownership expansion instead of editing outside their paths; grant it or reassign.
5. **Verify (parallel).** Adversarial reviewers with `--sandbox read-only`: "find real bugs, regressions and missing tests in these changes; cite file:line; verdict BLOCK or ALLOW with evidence". Run the project's tests yourself. Findings go back to the implementer that owns the file as a follow-up; re-review until dry, at most the configured number of rounds. Never silently drop a finding; what remains open goes into the final report.
6. **Integrate (you).** Run the full verification once more, inspect the complete diff, resolve conflicts, and make only trivial glue edits yourself. Final answer: what changed (by area), verification you observed, Codex claims you did not verify, open findings and blockers, and the questions collected for the user.

## Hard rules

- Substantive code is written by workers, not by you. You read, assign, judge, integrate and run checks.
- Ask the user at most once per phase, with all collected questions together, and only for decisions you cannot make from the code or the request.
- Never report a worker's `completed` as verified; never report `blocked` or `needs_input` as done.
- Stop and report if the Codex runtime is unavailable (`/codex:setup`), if two fix rounds did not converge, or if the task turns out to need a decision only the user can make.
