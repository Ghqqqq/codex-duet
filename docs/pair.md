# /codex:pair — one executor, Claude acceptance

Pair is for a bounded task that one Codex worker can complete end to end.
Claude plans, writes the full brief and accepts every diff. The primary worker
uses **`gpt-6-astra` / `xhigh` / normal speed**, an explicit exception to ultra's
stage-based sol defaults. User model, effort and speed choices take precedence.

Back to the [README](../README.md). Compare [ultra](ultra-codex.md) for breadth
and [duel](duel.md) for persistent adversarial work.

## Commands

```text
Usage: /codex:pair [on [<task>] | off | status | <task>]

/codex:pair fix the failing parser test
/codex:pair on
/codex:pair on fix the failing parser test
/codex:pair status
/codex:pair off

duet pair on
duet pair status --for-command
duet pair off
```

Pair has no mode options: no scale, worker-cap or rounds flags. No arguments
means status. CLI controls never take task text or start workers; they accept
the common workspace/session/JSON/help options. `on <task>` validates and saves
the mode before starting the task. A task without `on` runs once, preserving
the saved session mode. Use `--` for literal task text beginning with `on`,
`off`, `status` or an option-like word. See [the shared grammar](commands.md#orchestration-controls).

Only one session mode is active. Pair `on` replaces ultra or duel; pair `off`
clears only pair. A one-shot pair task while another mode is active uses pair
only for that task and reports that the session mode is unchanged. A new
substantive pair task starts a fresh primary thread; its rework retains that
thread. Session settings do not store participant identities or task counters.

## Execution and acceptance

1. Claude scouts enough to choose a plan and observable task-level criteria,
   starts/uses the run journal, and writes a full implementer brief with owned
   paths, constraints and exact checks. Read-only analysis still gets a full
   task brief with read-only bounds and sandbox.
2. One primary Codex worker investigates, implements and runs its checks on one
   thread. It does not recursively delegate or fan out.
3. Claude reads every line of each submitted diff, audits scope and assumptions,
   reruns required checks, walks the criteria against observed evidence and
   records a verdict. Self-checks and a completed report do not accept the work.
4. Rework uses a complete bounded follow-up to the same primary thread. Claude
   rechecks the complete resulting diff and final inputs before accepting it.

Claude may request **one optional read-only verifier per initial/rework result**,
after the primary returns and while it is idle. The default verifier is
`gpt-6-astra`/`xhigh`/normal; a Claude general-purpose verifier may instead
inherit the session model and use the owner's Claude quota. Give it a specific
doubt, criteria and a stable candidate, then return confirmed defects to the
primary. It never writes or accepts the primary's work. No panels or concurrent
fan-out; at most one corrective verifier follow-up, then an incomplete result
remains unverified.

All deliverable changes receive full Claude acceptance. Wholly read-only answers
and verifier reports use probe acceptance, including independent confirmation
for decision-driving findings; consequential or conflicting claims require full
acceptance. Pair's single-verifier allowance still applies: broader confirmation
requires an explicit mode decision. The shared
[brief and acceptance rules](../plugins/codex/prompts/ultra-codex-protocol.md#pair-mode)
and [run journal](run-journal.md) define the mechanics.

## Rework limits and escalation

The initial result permits at most **two rework rounds total per task**. All
fixes, including verifier findings, share this counter. Answers to pending
questions within a running turn do not consume a round; requests to change a
completed deliverable do. A new phase, thread or mode does not replenish it.
Budget for at most three primary deliveries, plus the optional sequential
verification. If the primary thread becomes unusable, report the required
reassignment rather than silently starting a replacement pair executor.

Finish only when Claude has evidence for every criterion and no blocking
finding remains. At the cap, report unmet criteria, findings, evidence and the
recommended next decision as an incomplete outcome.

- Recommend **ultra** for independent subsystem owners, broad searches,
  competing investigation lenses or an area × lens review matrix. After one
  failed live fix or unexplained live behaviour, request ultra's live-debugging
  fan-out before another fix.
- Recommend **duel** for materially contested designs, high-risk assumptions
  or a change needing a persistent adversary.

Do not silently switch. A persistent switch needs an explicit mode-control
request; settle active ownership and journal open criteria, evidence and consumed
rounds first. Continue only safe work within pair's bounds while that decision
is unresolved.

## Shared state, version and stop rules

Pair uses the same [session record and lifecycle](state-and-retention.md#orchestration-mode-state)
and single [protocol file](../plugins/codex/prompts/ultra-codex-protocol.md) as the
other modes. Read the complete current file for a task, then apply shared
sections and **Pair mode** only. Controls do not load the body into Claude's
context. `duet pair status --for-command` reports its current path and body hash;
an edit anywhere invalidates that common version.

**Reminder template** (placeholders):

```text
Pair mode on (one primary Codex worker, max 2 rework rounds). Apply pair protocol v<hash> to substantive tasks; re-read <absolute-protocol-path> only if v<hash> is not in your context.
```

Round limits are protocol-managed, not runtime counters. Native-first dispatch,
Bash fallback, consent and journal rules are unchanged. Named off/switching
leaves existing jobs running and reports them; conflicting writes must settle
before new assignments. A user stop ends new dispatch immediately. Cancelling
jobs or continuing user-stopped work requires the user's consent; see
[shared controls and stop rules](commands.md#orchestration-controls).
