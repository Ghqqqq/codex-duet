# /codex:duel — Claude versus Codex, with Claude as relay

Duel pairs one Claude `general-purpose` subagent with one Codex worker for a
bounded contested design, high-risk claim or adversarial change. The Claude
participant **inherits the session model and consumes the owner's Claude
quota**, in addition to Codex usage. Codex defaults to **`gpt-6-astra` / `xhigh`
/ normal speed**. Explicit user settings take precedence; justified `max` needs
the existing integration/runtime support check first.

Claude's main loop plans, relays every substantive exchange, verifies evidence
and arbitrates. The two participants retain their identities across rounds;
they do not message each other directly, recursively delegate or add a judge
panel. A missing Claude participant leaves an incomplete duel.

If a participant fails or is interrupted for a reason other than an owner stop,
Claude may replace that party once per task with a fresh thread. The
replacement uses the next remaining round when the failed party had already
done substantive work, or the unstarted round otherwise; it never raises the
round cap. A user-stopped participant continues only with the user's consent.

Back to the [README](../README.md). Compare [pair](pair.md) for one executor and
[ultra](ultra-codex.md) for broad independent work.

## Commands and round budget

```text
Usage: /codex:duel [on [--rounds <n>] [<task>] | off | status | [--rounds <n>] <task>]

/codex:duel --rounds 2 compare these two designs
/codex:duel on --rounds 2
/codex:duel on --rounds 2 fix the parser race
/codex:duel status
/codex:duel off

duet duel on --rounds 2
duet duel status --for-command
duet duel off
```

`--rounds` is the ceiling on **total rounds, initial round included**: integer
1–3, default 3. Each round includes a build/draft and its opposing critique;
three rounds allow at most two revisions of the initial deliverable. There are
no ultra scale/worker-cap flags or role-selection flag. Declare the flow, roles,
criteria, evidence requirements, ownership and cap before dispatch. Do not add
uncounted repair turns or restart a duel to evade the cap.

No arguments means status. `on <task>` validates and saves settings before
running the task; a failed `on` starts nothing. A task without `on` is one-shot:
explicit prefix options override a matching saved duel setting, otherwise
defaults apply, and the session mode is unchanged. `--` starts literal task text.
CLI commands accept controls only, with `--rounds` valid only for `on`.
See [the shared grammar and CLI flags](commands.md#orchestration-controls).

## Implementation and bug fixes: builder versus breaker

Default Codex to builder and the Claude subagent to breaker. An explicit task
request may reverse those roles before dispatch. Only the builder owns writable
deliverable paths; the breaker is read-only. Freeze the candidate during attacks
and evidence adjudication; no concurrent mutation of the reviewed files.

1. The builder receives a full brief and produces the initial candidate with
   checks. Claude inspects its complete diff and task evidence, then relays the
   stable candidate and criteria to the breaker.
2. The breaker attacks that candidate and returns `BLOCK`, `ALLOW` or
   `CANNOT_VERIFY`, with coverage and numbered findings: criterion, file:line or
   source, reproduction/check, expected/observed result and blocking status.
3. Claude relays each finding and evidence to the builder for a fix or
   evidence-backed rebuttal, verifies disputes and records each disposition.
   Any repair belongs in the next numbered round, followed by a fresh attack
   and rechecks of prior blockers on the repaired candidate.
4. Finish only with the breaker's final `ALLOW`, no unresolved blocking finding,
   and Claude's own full diff/criteria/check acceptance. Silence, interruption,
   `CANNOT_VERIFY` or an unavailable check cannot count as `ALLOW`.

Claude may reject an attack with decisive contrary evidence and record why,
but cannot waive a failed required check or fabricate the breaker's verdict.

## Design and analysis: independent drafts and cross-review

1. Both participants draft independently from the same criteria and source
   baseline. Collect both before exchanging either; keep each stage's work
   blind until the exchange.
2. Claude relays each draft to the other participant for critique, evidence and
   numbered disagreement IDs. This initial drafting and cross-review is round 1.
3. For each later round, both address open IDs with revised positions/drafts,
   then cross-review the other's current revision. Claude relays all substantive
   exchanges and tracks dispositions and remaining uncertainty.
4. Claude synthesizes the final analysis and arbitrates surviving disagreements
   against the criteria, evidence and authorized priorities. Convergence needs
   addressed critiques and a synthesis satisfying the criteria; unanimity of
   preference is unnecessary.

Analytical synthesis is Claude's responsibility. Substantive repository changes
still require a builder, full acceptance and review within the remaining budget;
an agreed design alone is not accepted implementation.

## Evidence, convergence and incomplete outcomes

Pin the candidate/source state each participant reviewed using a real available
identifier or documented diff/artifact with fingerprints and check evidence.
Track round/cap, flow, participant handles, finding IDs, dispositions and open
criteria through task notes and existing journal decision entries. Preserve
material dissent and evidence when relaying; do not turn a participant's
`CANNOT_VERIFY` into agreement.

Every changed deliverable from either participant gets full Claude acceptance:
read the complete diff, rerun required checks and walk every criterion.
Read-only attacks, drafts and rebuttals use probe acceptance, promoted to full
depth for consequential or conflicting claims. Record actual Codex job verdicts
normally. A Claude general-purpose agent has no Duet job ID: record its real
agent identity, findings, checks and acceptance basis in journal **decision**
entries. See the [duel protocol](../plugins/codex/prompts/ultra-codex-protocol.md#duel-mode)
and [run journal](run-journal.md).

At the cap, report completed rounds, open IDs/criteria, evidence, risks and
Claude's recommendation. Evidence-supported factual/design arbitration is
allowed; unresolved user goals, incompatible requirements, consequential risk
acceptance or an unverified required criterion are incomplete outcomes for the
user's decision. Missing participants or blocked verification remain visible.
No automatic new duel, hidden verifier or mode switch.

Recommend ultra when a dispute exposes broad independent work or competing
investigations, including the live-debugging trigger after one failed live fix
or unexplained live behaviour. Recommend pair for a later bounded task once the
dispute is settled. Switching needs an explicit mode-control request, settled
ownership and a journal handoff; it does not reset consumed rework rounds.

## Shared state, version and stopping

Duel `on` replaces the single active session mode; duel `off` clears only duel.
Replacing/off discards its settings, leaving in-flight jobs unchanged. Repeated
duel `on` retains saved rounds unless explicitly overridden. One-shot tasks do
not write the record. See [state and lifecycle](state-and-retention.md#orchestration-mode-state).

All modes share one [protocol file](../plugins/codex/prompts/ultra-codex-protocol.md)
and current body hash. Tasks read it and apply shared sections plus **Duel mode**
only; controls do not load the body into Claude's context. Obtain the current
version/path with `duet duel status --for-command`.

**Reminder template** (placeholders):

```text
Duel mode on (Claude vs Codex, max <rounds> rounds). Apply duel protocol v<hash> to substantive tasks; re-read <absolute-protocol-path> only if v<hash> is not in your context.
```

Round limits are advisory protocol rules, not runtime counters. Native/Bash,
consent and journal mechanics are unchanged. CLI switching/off reports only
Codex jobs: an empty list does **not** prove the Claude participant has stopped.
Claude must also report that tracked agent's state in prose and settle
conflicting writes before new assignments. User stop ends new dispatch
immediately; cancelling jobs or continuing user-stopped work requires consent.
See [shared controls and stop rules](commands.md#orchestration-controls).
