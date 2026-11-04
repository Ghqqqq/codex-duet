# Roundtable

Roundtable brings persistent Codex members together around one complete goal.
Claude chairs: it states the criteria, protects independent inquiry and accepts
the final candidate on evidence. Members can investigate, implement, reproduce,
review and build on one another's work. Their personas shape what they notice
and try first; current judgments change with evidence.

```text
/codex:roundtable investigate and fix the intermittent reconnect failure
/codex:roundtable --intensity deep compare and prototype these storage designs
/codex:roundtable on --intensity light --roles improver,critic
/codex:roundtable status
/codex:roundtable off
```

A task runs once; `on` keeps the mode for substantive prompts in this session.
Only one orchestration mode is active at a time. Off or replacement preserves
existing jobs and rooms. Save `fugato setup --default-mode roundtable` for fresh
sessions and `/clear`; the installation default remains `off`. Resume and
compaction retain the session's choice.

## Personas and their grounding

All six share truthfulness, fallibility, equal standards for their own and
others' work, candid cooperation, responsibility for the whole goal and the
same authorization boundaries. A persona never fixes a conclusion or assigns
a profession such as tester or architect.

| Persona id | Habit and correction | Research grounding |
| --- | --- | --- |
| `conjecturer` — Conjecturer | Try distinct mechanisms with different observable predictions; change the mechanism when a prediction fails | Bold conjectures (Popper, 1963), methodological plurality (Feyerabend, 1975), exploration (March, 1991) |
| `critic` — Critic | Turn a key premise into a counterexample or discriminating experiment; build an alternative and accept evidence that removes the doubt | Falsifiability (Popper, 1963), criticism of degenerating repairs (Lakatos, 1970), authentic dissent (Nemeth et al., 2001) |
| `steward` — Evidence Steward | Reproduce key facts, distinguish observation from inference, check sources and conditions; prioritize checks that could change the decision | Inquiry (Dewey, 1938), organized skepticism (Merton, 1973), hidden information (Stasser & Titus, 1985) |
| `improver` — Improver | Finish the next workable improvement and integrate useful results; declare failure conditions to avoid sunk-cost persistence | Research programmes (Lakatos, 1970), adaptation (Kirton, 1976), exploitation (March, 1991) |
| `integrator` — Integrator | Build and verify combinations across threads, credit sources and preserve minority evidence; recheck old counterexamples | Critical uptake and tempered equality (Longino, 2002), epistemic injustice (Fricker, 2007), structural holes (Burt, 2004) |
| `calibrator` — Calibrator | Keep a few live hypotheses, choose the check that reduces key uncertainty and update the plan; make a conditional commitment at decision time | Forecasting judgment (Tetlock, 2005), actively open-minded thinking (Haran et al., 2013), transient diversity (Zollman, 2010) |

These are behavioral prompts, not evidence that a persona label makes a model
more capable. The design draws on Zheng et al. (2024), who found that persona
labels do not reliably improve factual accuracy. Criticism must be authentic:
Nemeth et al. (2001) found benefits from real minority dissent that assigned
devil's advocacy did not reproduce. Members may agree and explicitly change
their minds. Shared candor follows psychological safety research (Edmondson,
1999); conscientiousness and cooperation are shared baselines rather than
dimensions deliberately pushed apart (Peeters et al., 2006; Bell, 2007).

The sealed opening keeps members' first judgments independent, drawing on
Delphi/nominal-group methods and transient diversity (Zollman, 2010).
Before closing, the chair asks about unique or misunderstood evidence:
groups often overlook information held by only one member (Stasser & Titus,
1985; Lu et al., 2012). Uptake means criticism receives a substantive answer,
not merely an opportunity to be spoken (Longino, 2002).

## Intensity and roster

The chair recommends intensity and seats for the task and asks for confirmation
of choices the user has not already supplied. Explicit `--intensity` chooses
that preset and its roster; `--roles` replaces the roster. A saved user choice
also counts as supplied. Never repeat a persona in one room.

| Intensity | Default seats | Work and cross-checking |
| --- | --- | --- |
| `light` | 2: improver, critic | New facts and testable ideas; one targeted cross-check |
| `standard` | 3: conjecturer, critic, improver | Directed exchanges; independent check of key candidates |
| `deep` | 5: conjecturer, critic, improver, integrator, steward | Preserve alternatives; check key assumptions and combined candidates |
| `full` | All 6, adding calibrator | Sustained exploration and execution; check omitted evidence and diminishing returns |

Without a supplied selection, `standard` is the initial recommendation.
`--roles steward,critic,improver` is useful when evidence quality matters more
than broad exploration. Any nonempty subset of the six is allowed; custom
persona cards and duplicate seats are not supported.

These group sizes are engineering starting points, not a demonstrated optimum
for LLMs. Laughlin et al. (2006) found advantages for groups of three to five on
particular verifiable problems; that result does not establish the best agent
count for every task. Higher intensity should add exploration, experiments and
verification, not chat volume.

## Models and redefinition

The built-in mapping at standard intensity is:

| Persona | Model | Effort |
| --- | --- | --- |
| conjecturer | `gpt-6.1-terra` | `medium` |
| critic | `gpt-6-astra` | `high` |
| steward | `gpt-6.1-sol` | `xhigh` |
| improver | `gpt-6.1-sol` | `high` |
| integrator | `gpt-6-astra` | `high` |
| calibrator | `gpt-6-astra` | `medium` |

With built-in efforts, light lowers each by one step, deep raises by one,
and full raises by one with critic and integrator at `max`. The shift ladder is
`low → medium → high → xhigh → max`, clamped at its ends. Saved or per-run
explicit efforts are used unchanged. A model-only override keeps the built-in
intensity-adjusted effort. Ordinary `--default-model`/`--default-effort` worker
settings do not redefine persona models.

```bash
fugato setup --persona-model critic=gpt-6-astra:xhigh --persona-model improver=gpt-6.1-sol:high --dry-run --json
fugato setup --persona-model critic=gpt-6-astra:xhigh --persona-model improver=gpt-6.1-sol:high --json
fugato setup --persona-model critic=default --json
fugato setup --json
```

Run persona mapping changes separately from other setup changes. The repeatable
flag validates every id, model and effort before any write; duplicate ids in a
batch are rejected. Model checks reuse the isolated model catalog: unknown
names in a fresh catalog fail; a stale or missing catalog produces warnings.
`fugato models` refreshes/displays available models. Static efforts and additional
efforts listed in the isolated cache are accepted.

Values live in `<isolated-home>/duet/config.toml`:

```toml
[roundtable.personas.critic]
model = "gpt-6-astra"
effort = "xhigh"
```

`id=default` removes both saved fields. A new model without `:effort` removes
any previous saved effort for that persona. The final colon separates effort;
if a model name itself contains colons, include an explicit effort suffix.
`setup --json` reports `personaModels.<id>.model` and `.effort` as
`{ value, source }`, where source is `saved` or `built-in`. These are standard
mapping values; the room's returned members show the resolved intensity.
Per-room `fugato roundtable start --persona-model id=model[:effort]` overrides the
saved mapping for that run.

No research establishes an optimal persona/model/effort pairing. This is a
configurable hypothesis, not a capability guarantee. First ensure every member
can do the task; model diversity does not compensate for an incapable member
(Li et al., 2025). Claude supplies another provider's perspective as chair.

## The forum

Each room has a public, append-only threaded forum. Members first post an
independent record: a promising route, key unknown and discriminating first
check. Until that first post, they see the room header, chair decisions and
their own posts, but no peer posts. The chair can see all posts.

| Kind | Use |
| --- | --- |
| `idea` | Hypothesis or proposed route |
| `finding` | Observed result, including failed experiments |
| `question` | Ask for information or judgment |
| `request` | Ask for verification, reproduction or other action |
| `intent` | Announce current work to avoid accidental duplication |
| `candidate` | Short delivery summary plus commit/diff/artifact references |
| `decision` | Chair-only decision on goals, selection or closure |

Labels are `hypothesis`, `draft`, `observed`. Key facts include versions,
commands, conditions and artifact references. Post information gain, not plain
agreement. Long artifacts stay outside the 4,000-character body. Index reads
show short deltas; expand relevant threads to inspect their evidence. Reading
the index and expanding a thread have separate cursors.

Read objects by id with `forum_read(resource="post/<seq>")`,
`thread/<seq>`, `member/<name>` or `candidate/<seq>`; the chair uses
`fugato forum read <roomId> --resource <resource>`. Post reads return one full
post; thread reads return at most 25 posts and 128 KiB of serialized events per
page. Member resources show persona, status, the 10 most recent jobs and commits
by default, omitted counts, report summaries of at most 600 characters with
commands for job details, workspace path, base, HEAD and dirty-file count.
They contain no full transcripts. Candidate resources include
the candidate post and, for a member worktree, `git diff --stat base..HEAD` and
at most 8,000 characters of patch. Stat output is capped at 40 lines and 4,000
bytes. Truncated stat or patch output includes a marker and the exact command
to read the rest; Git executions time out after 10 seconds.
These diffs compare the recorded base with the
author's current HEAD; uncommitted files appear in the member's dirty count.
Peer objects and workspaces remain sealed before the initial record. All peer
workspace reads are read-only. Object reads leave cursors unchanged, except
thread resources advance the expansion cursor only through returned posts.
Follow the returned continuation pointer with `forum_read(resource=..., after=n,
limit=n)` or `fugato forum read <roomId> --resource <resource> --after n --limit n`.
For threads, `after` is the last returned post sequence. For member resources,
it is an offset into each newest-first history; pages are capped at 25 jobs and
25 commits. Full member history is available through these explicit page reads.

`@`-mentions are public and use structured mention fields. A mentioned question
or request needs a reply in its thread: result, acceptance or reasoned refusal.
After two rounds of disagreement with no new evidence, propose a small
discriminating experiment; untestable trade-offs go to the chair. Candidates
are references to inspect, not pasted full diffs or self-accepting votes.

Members use bound `forum_read`/`forum_post` tools. The chair uses:

```bash
fugato forum read <roomId> --json
fugato forum read <roomId> --thread <seq> --json
fugato forum read <roomId> --resource candidate/<seq>
fugato forum read <roomId> --resource member/critic
fugato forum post <roomId> --kind request --mention steward --title 'Check candidate' --ref <commit> <<'DUET_POST'
Please reproduce the candidate's reconnect result under the original conditions.
DUET_POST
```

Mentions and chair decisions can wake an idle member. Replies to a thread it
joined notify it without waking it; ordinary new posts stay in the index.
Running members receive notices directly through steering. For idle members,
the timer records a ready wake and the plugin sends it after a tool call in the
chair's main loop finishes. Delivery targets the member's bound agent id and
continues its existing Codex thread. The host excludes all of a plugin's hooks
from work started in its timer callback, but excludes only the calling hook
frame from work started in a tool hook. Sending from the tool hook therefore
keeps the native adapter active without a relay agent or an extra model call.

Notifications are short, not full post bodies. Member posts coalesce for
30 seconds; chair mentions and decisions are eligible immediately, so the
post's own tool completion can deliver them. Delivery passes are bounded,
single-flight with the timer, and throttled to about once per five seconds.
Each wake rechecks the room, binding, job, pending questions and workspace.
The member records receipt; without a receipt, a wake is retried once after
about two minutes if the same job is still idle.

If a ready wake waits about two minutes because no main-loop tool call has
happened, the chair receives one notice per delivery:
`Roundtable <room>: <names> have updates waiting; run fugato roundtable status <roomId> to deliver them.`
The chair immediately runs that status command; its completion triggers the
pending delivery. If room status still lists the member's wake updates a minute
after such a run, delivery has stalled (for example, a notice whose retry never
launched). The chair then sends that member one SendMessage, `Read your forum
updates and continue.`; the new job settles the stalled notice. The chair does
not forward notice text or answer for the member. Paused/closed rooms and stopped members do not wake. Posts never grant
permission or change trusted controls, and there are no private messages.

## The chair and lifecycle

Claude publishes goals and acceptance criteria before strong technical
preferences, keeps technical opinions challengeable, protects candor, asks for
unique evidence and tests popular candidates as carefully as minority ones.
The runtime returns the stable chair card with the roster.

The workflow is `fugato roundtable start` with the goal on stdin, one background
native Codex agent per returned member, then work and forum exchanges.
Agent `name` equals the persona id; copy its printed
`DUET: --model <m> --effort <e> --normal --roundtable <roomId> --persona <id> --cwd "<workspace path>"`
header. Dispatch members without Agent `isolation: "worktree"`: Fugato creates
and owns each member's detached Git worktree from the current HEAD at
`<isolated-home>/duet/roundtables/<roomId>/worktrees/<persona>`. These workspaces
survive completed turns and later wakes. Creation rolls back the entire room
if any workspace fails. Outside a Git repository, members share the recorded
workspace and coordinate file ownership. The printed `--cwd` is required;
follow-ups retain the member's workspace, identity and thread.

Members share candidates as commits or diffs with their workspace paths.
The chair is the single integration writer in the main checkout: it inspects
and integrates selected candidates there and verifies the combined result.
It never starts two live jobs for the same member.

```text
fugato roundtable status <roomId> --json
fugato roundtable pause <roomId>
fugato roundtable resume <roomId>
fugato roundtable close <roomId> --title "<summary>" [--selects <seq>] <<'DUET_DECISION'
<closing decision>
DUET_DECISION
```

Closing with its decision in one command records the decision and closes the
room together, so idle members are not woken only to read the closing note.

Bare `fugato roundtable status` (or no action) reports session mode state and the
latest room; a room id selects room status, including member workspace paths
and whether they have changes. Room status leads with an `attention` list of
only items needing the chair, each with a resource pointer: open questions or
requests addressed to the chair (or unaddressed for at least 30 seconds), idle
members whose wake updates are not yet taken up, current blocked/failed
jobs or pending answers, candidates without a non-author finding, and missing
member workspaces. An empty list prints “Nothing needs the chair.” Counts
follow the list. Bare mode status prints the latest room's attention summaries
and resource pointers first, followed by mode information; JSON keeps both.
`fugato roundtable on|off|status` controls the mode and
does not start members. Pause stops room notifications, not running jobs.
The chair checks the final candidate independently, reruns verification, and
records delivery acceptance in the run journal. Before closing, it lists open
questions/requests, unresolved criticism and unique findings not yet addressed.
It records the final choice as the closing decision, `fugato roundtable close
<roomId> --title "<summary>" --selects <candidateSeq>` with the decision body on
stdin (`fugato forum post <roomId> --kind decision --selects <candidateSeq>` records
a selection without closing). The store refuses a
selection unless that post is a candidate and a non-author member has posted a
later `finding` in its thread. Members inspect `forum_read(resource="candidate/<seq>")`
and reply with their finding. Author checks, chair checks and other kinds of
reply do not meet the gate. The chair can explicitly override the review
requirement with `--unreviewed "<reason>"`; the decision preserves that reason.
This does not waive required acceptance criteria. Close reports the latest
selected candidate and whether it was reviewed at selection, plus any override.

The chair stops remaining agents so writes have settled, then closes the room
with its closing decision. A refused decision leaves the room open. Close
removes only worktrees with no new
commits or local changes relative to their recorded base. It keeps changed
worktrees, including branchless commits and untracked or ignored files, and
reports both removed and kept paths with HEADs, commits and dirty-file counts.
Shared workspaces are always kept; without Git, change detection is unavailable.
Closing alone never cancels jobs. Required failing criteria cannot be outvoted.

## Current limits

Members are Codex-only; Claude subagents cannot take member seats. There is no
roundtable token or cost cap. Individual jobs may use existing `--max-minutes`
or `--max-tokens` limits. The chair ends on acceptance or diagnoses stagnation:
two consecutive work boundaries without a new fact, discriminating experiment
or candidate improvement are a soft stopping signal, not proof of success.
Intensity and persona mappings are starting points for evaluation; more members
do not guarantee a better result. Full protocol:
[Roundtable mode](../plugins/codex/prompts/ultra-codex-protocol.md#roundtable-mode).
