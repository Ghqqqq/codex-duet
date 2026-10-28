# Run journal

A run preserves the orchestrator's goal, acceptance criteria, worker verdicts
and decisions across context compaction and session resume. It also keeps each
linked task's exact submitted brief and final compact report independently of
the latest-50 job history. Journals live in Duet's isolated home; no journal
files are written in the user's checkout.

## Commands

SessionStart exports `CODEX_COMPANION` and `CODEX_COMPANION_SESSION_ID`. Start
one active run per Claude session, then send JSON on stdin:

```sh
duet journal start <<'JSON'
{"goal":"Add durable recovery","criteria":["Criteria and verdicts survive compaction"]}
JSON
duet journal add criteria <<'JSON'
{"criteria":["Keep all journal files in the isolated home"]}
JSON
duet journal add verdict <<'JSON'
{"jobId":"task-...","verdict":"ACCEPT","criteria":[{"criterion":"Criteria and verdicts survive compaction","evidence":"Ran journal show in a new process and observed the stored criteria","result":"met"},{"criterion":"Keep all journal files in the isolated home","evidence":"Checked run and artifact paths in the isolated home","result":"met"}],"reason":"Observed evidence meets the criterion"}
JSON
duet journal add decision <<'JSON'
{"summary":"Use a workspace journal","basis":"Keep acceptance evidence after job pruning","risk":"History still expires under retention"}
JSON
duet journal show
duet journal validate
duet journal close <<'JSON'
{"judgment":"passed","summary":"Acceptance criteria verified","openRisks":[]}
JSON
duet journal list --json
```

All commands accept `--cwd <dir>`, `--json`, `--help` and `-h`. Help exits
before reading stdin, creating files or starting a runtime. Start prints
`{"runId":"run-..."}`. A second start with an open run is an error naming that
run, even when the second start uses another workspace. For an unrelated task
the user starts mid-run, `journal start --switch` leaves the previous run open,
points the session at the new run and also returns `previousRunId`. It does not
cancel or relink existing workers. `duet journal use <runId>` selects an existing
open run for the current session, searching across workspaces in the same isolated
home, and prints `{"runId":"run-..."}`. Start and use require
`CODEX_COMPANION_SESSION_ID`; use reads no stdin and does not accept `--run`.
Add, close, show and validate
default to the session's active run regardless of the current cwd. `--run <id>`
selects an existing run, searching across workspaces in the same isolated home.
Without an active run, add and close use the sole open run in the current
workspace. With several open runs they require `journal use <runId>` or
`--run <id>`; the fallback never changes the session's active pointer.
Show and validate still fall back to the newest workspace run when none is
active. List returns that workspace's runs newest first. Invalid
JSON, missing fields, invalid enum
values and unknown entry types fail before journal writes.

| Input | Fields |
| --- | --- |
| `start [--switch]` | Non-empty `goal` string, `criteria` array of non-empty strings |
| `use <runId>` | Existing open run ID as a positional argument; no stdin JSON |
| `add criteria` | `criteria` array of non-empty strings, appended to existing criteria; reactivates withdrawn criteria with the same exact text |
| `add withdraw` | `criteria` array of known criterion strings, non-empty `reason` |
| `add verdict` | `jobId`, `verdict` (`ACCEPT`, `ACCEPT_WITH_GLUE`, `REWORK`, `REASSIGN`), `criteria` array of `{criterion, evidence, result}`, non-empty `reason`; optional `resolves` array of job IDs linked to this run |
| Criterion result | `met`, `not_met` or `cannot_verify`; criterion and evidence are non-empty strings |
| `add decision` | Non-empty `summary` and `basis`; optional non-empty `risk` string |
| `close` | `judgment` (`passed`, `blocked`, `abandoned`), non-empty `summary`; optional `openRisks` array of strings |

Verdict criteria must already be declared by `start` or `add criteria`. Each
`criterion` accepts exact text (including case and whitespace), a unique shown
prefix ending in `…`, or a unique `K<n>` ID such as `K7` or `K7:` when a declared
criterion starts with that ID followed by a colon, whitespace or end of text.
IDs are not assigned automatically. A shown prefix can match whitespace folded
for display; accepted shortcuts are saved as the full declared text. Unknown or
ambiguous matches are rejected before writing. Use exact text to disambiguate,
and `journal add criteria` to introduce new criteria.

Empty criteria arrays are allowed when no criterion applies. Verdicts can name
jobs whose ordinary records have expired. The latest verdict supersedes earlier
verdicts in the recovery view; all entries remain in the journal. Jobs without a
verdict and jobs whose latest verdict is unresolved `REWORK` or `REASSIGN` are
open items. A later `ACCEPT` or `ACCEPT_WITH_GLUE` resolves earlier rework or
reassignment when it lists the rejected job in `resolves`, or is a descendant
through explicit `followUpOf`/`continuationOf` links. Sharing a thread alone does
not resolve it. The accepting job's latest verdict must still be acceptance and
must follow the rejected job's latest verdict in journal order; a later rejection
reopens it. `resolves` accepts job IDs linked to this run regardless of their
Claude session; unknown job IDs are rejected before writing.

When the user drops a criterion, record its exact text and the reason:

```sh
duet journal add withdraw <<'JSON'
{"criteria":["Keep all journal files in the isolated home"],"reason":"The user dropped this requirement"}
JSON
```

Withdrawal requires exact text introduced by the run, `add criteria` or a
historical verdict. Withdrawn criteria show as `withdrawn` with their reason and no longer
produce `unchecked_criterion` or `unmet_criterion` issues. Other job issues still
apply. A later `add criteria` with the same exact text reactivates the criterion;
its previous verdict evidence remains available. Withdrawal rows need 1.4.4 or
later: if you roll back to 1.4.2, a withdrawn criterion shows as unchecked again
and `journal validate` reports it.

When a fresh worker fixes REWORK or replaces a REASSIGN job, preserve the original
rejection and add `"resolves":["<rejectedJobId>"]` to the replacement's verified
acceptance verdict. For example, with both jobs already linked to the run:

```sh
duet journal add verdict <<'JSON'
{"jobId":"task-replacement","verdict":"ACCEPT","criteria":[{"criterion":"Keep all journal files in the isolated home","evidence":"Checked the replacement's artifact paths","result":"met"}],"reason":"Verified the replacement fixes the rejected work","resolves":["task-rejected"]}
JSON
```

Close records the judgment and clears pointers to that run; closing twice or
adding manual entries after close is an error. It does not cancel workers. A
worker already linked to a run may still record its terminal report after close.
SessionEnd does not close a run.

### Select a run for one task

`duet task --run <runId|none>` overrides automatic journal linkage for that
dispatch only. `--run none` skips linking; an explicit run ID is resolved across
workspaces in the same isolated home and must be open. An invalid or closed run
fails before any worker starts, including if it closes before the locked link;
the error names the recoveries (`duet journal start`, another open `--run <id>`, or
`--run none`). The rejected dispatch's reservation and any worker name it newly reserved are
removed, so the thread stays free. If the link had already succeeded when a
later write failed, the run records that job as failed, so validation asks for
a verdict instead of showing it as queued.
The override does not change the session's active run and follow-ups do not
inherit it: repeat `--run` when needed. Without it, a dispatch links to the
session's current active run, even when its predecessor used another run. When
none is active, the sole open run in the dispatch workspace is used; several
open runs leave the task unlinked. Use `journal use <runId>` to select one for
the session, or repeat an explicit `--run <id>` per task. Automatic fallback
does not set the session pointer.

## Validate before closing

`journal validate [--run <id>] [--json]` checks **record completeness**, not
whether the work is correct. It reads the journal, retained reports and available
live job records without writing, locking, refreshing retention or starting a
worker. Exit status is 0 with no issues, 2 with issues, or 1 for an invalid request
or unreadable journal. Text lists every issue and its next safe action. JSON is:

```json
{"runId":"run-...","ok":false,"issues":[{"kind":"unchecked_criterion","criterion":"Keep all journal files in the isolated home","detail":"Task criterion appears in no verdict.","nextAction":"Check this exact criterion and record its evidence and result in a journal verdict."}]}
```

| Issue kind | What remains open | Next step |
| --- | --- | --- |
| `unfinished_job` | Linked job has no `job_finished` and its readable record is queued/running | Check status and the existing owner wait; wait for completion |
| `unrecorded_finish` | Linked job has a readable terminal record but no `job_finished` | Read `duet result <jobId> --details` to retry finish recording, then verify evidence and record a verdict |
| `no_verdict` | Finished job has no verdict | Inspect its report, verify criteria and record a verdict |
| `open_rework` | Latest rejection has no later acceptance on that job, linked descendant or job naming it in `resolves` | Verify a correction before accepting; record `resolves` for a fresh replacement; continuing a stopped job requires consent |
| `unmet_criterion` | Latest result for a non-withdrawn criterion is `not_met` or `cannot_verify` | Resolve and recheck it, then record observed evidence with `met` |
| `unchecked_criterion` | Non-withdrawn task-level criterion appears in no verdict | Check and record that exact criterion text |
| `missing_artifact` | Latest finish's report path or file is missing/empty, unreadable or unsafe | Recover available report evidence, or explain its absence in a blocked/abandoned close |

Validation matches the full stored criterion text; new verdict shortcuts are
canonicalized when written. The latest result for that text across all jobs wins;
a newer verdict that omits the text does not erase its previous result.
Historical verdict-only criteria are not migrated and still produce
`unmet_criterion` when their latest result is negative, unless withdrawn.
New verdicts cannot introduce undeclared criteria. Duplicate task criteria
produce one unchecked issue. A verdict labeled `ACCEPT` with a
negative result for a non-withdrawn criterion still blocks a passed close.

`journal close` rechecks completeness under the run lock. With `passed`, any
issue refuses closure with exit 2 and leaves the journal and active pointer
unchanged. With `--json`, refusal returns the validation JSON above. `blocked`
and `abandoned` can close despite issues; all successful closes store the
computed `openIssues` array in `run_closed` (empty for `passed`). A caller cannot
override that snapshot. Existing `openRisks` remain the orchestrator's explanation.
The snapshot is fixed at the close row; `validate` and `show` reflect current
observations, including any later worker finish or missing artifact.

If a linked job has no recorded finish but its readable record says `completed`,
`failed`, `cancelled`, `interrupted`, `blocked`, `needs_input` or `error`, validation
emits `unrecorded_finish` and, without a verdict, `no_verdict`. A verdict alone
does not resolve the missing finish. Reading result details lets the terminal
observer retry finish recording; validation itself remains read-only. If the
job's record has expired or is unreadable, validation cannot establish its state
and emits neither `unfinished_job` nor `unrecorded_finish` on that basis.
Unknown job references are not a separate issue kind. Empty
criteria and no linked jobs can pass. These checks do not establish that all
intended workers were linked, judge the substance of evidence, resume workers,
or replace the orchestrator's acceptance checks.

## Storage and format

Under `<CODEX_COMPANION_HOME>/duet/state/` (the directory returned by
`resolveStateRoot()`):

```text
run-sessions/<sessionId>.json         # atomic {runId, stateDir} pointer
<workspace-key>/runs/
  <runId>/journal.jsonl               # append-only event records
  <runId>/jobs/<jobId>.brief.md        # exact text sent to the worker
  <runId>/jobs/<jobId>.report.json     # final compact report
```

The run stays in the workspace state directory where it was started
(`resolveStateDir(cwd)`), even when its jobs use other workspaces. The session
pointer records that absolute `stateDir`; it must be a real workspace directory
directly under the isolated state root. Linked job records store `runId` and
`runStateDir`, so terminal reporting still finds the run after its pointer has
been cleared or the session has started a new run.

Each JSONL record has `type` and ISO `recordedAt`. Types are `run_started`
(`runId`, `goal`, `criteria`, `cwd`, `sessionId`), `criteria`, `criteria_withdrawn`
(`criteria`, `reason`), `verdict`,
`decision`, `run_closed`, `job_started` and `job_finished`. Manual entry fields
match the table above. Job-start records include the job and agent identifiers,
job `workspaceRoot` and invocation `cwd`, known thread handle, title, model,
effort, sandbox, available `followUpOf` and `continuationOf` identifiers, and a
relative `brief` path. Job-finish records
contain `jobId`, `status`, final `threadId` and a relative `report` path. Follow-up
identifiers depend on the previous job still being discoverable at launch.
`task --thread <id> --cwd <other-worktree>` records `followUpOf` from the
cross-workspace predecessor found through thread inheritance when no local
predecessor is available.

Directories are private (0700), files are 0600, and journal paths reject
symlinked directories and files. Pointer and artifact publication use atomic
renames. Appends are flushed and serialized by the existing interprocess state
lock on the run's original state directory. Session pointer changes take a
shared lock on `run-sessions` first, then the run lock, so simultaneous starts
from different workspaces serialize selection of the session's active run.
Ordinary starts reject an already open active run; `--switch` can leave older
runs open. The terminal observer checks for an existing `job_finished` with the same job ID
and status under the run lock before publishing the report and appending, so
concurrent worker, recovery and wait observers cannot duplicate that finish.
The first finish keeps `jobs/<jobId>.report.json`; a later different status uses
`jobs/<jobId>.<status>.report.json`, preserving existing reports. Once a finish
is recorded, repeated observations of that status skip journal locking and reads.

## Recovery, retention and limits

`journal show` is a compact view with relative artifact paths beneath the
printed run directory; it does not inline briefs or reports. The latest finish
for each job supplies its status and report path. Jobs without a recorded finish
are supplemented with live status and thread handles when available. The text
`Criteria` section shows each task criterion's latest result and evidence, or
`unchecked`, or `withdrawn` with its reason; `Open` lists each validation issue
and its next action. JSON also includes `withdrawnCriteria`. Text fields
are shortened with an ellipsis for context recovery; `--json` preserves the full
criteria, verdict evidence and decisions. Existing JSON fields remain, including
the legacy job-only `openItems` list; `criterionResults` and `issues` add the
criterion and validation views. Use `issues` for completeness (unlike
`openItems`, `no_verdict` applies only to finished jobs). Job views also retain
explicit follow-up/continuation links. Read a saved brief or report only when needed.
SessionStart appends exactly one recovery reminder for an active open run,
including when the session starts from another workspace or worktree.

`cleanup --dry-run --json` lists expired runs in `runs` and affected session
pointers in `runSessions`. Cleanup and automatic retention remove expired runs
and session pointers targeting pruned or missing runs. Pointer removal is
rechecked under the session lock, so a new active run is preserved. Both closed
runs and inactive open runs expire when their last journal activity is older than
the retention window. An open run is retained if a linked job has no later finish
and its readable job record is queued or running; missing or unreadable job
records do not protect a run. The window follows `--days`,
`CODEX_COMPANION_RETENTION_DAYS`, Claude's `cleanupPeriodDays`, then the 30-day
default (minimum one day). Reads do not count as activity. Cleanup rechecks
activity and active linked jobs under the journal lock before deletion. Job
retention and the latest-50 job cap never delete run copies.

Automatic linking first uses the Claude session's active run, including tasks
using other workspaces or worktrees as `--cwd`. Another session can select that
open run with `journal use <runId>`, or use `task --run <id>` for one dispatch.
Without an active run, automatic linking uses the sole open run in the dispatch
workspace even if another session started it; several open runs leave tasks
unlinked. A new continuation uses the same selection rules, not its predecessor's
run or per-dispatch override. Without an active run, explicit selection or a
sole open workspace run, tasks make no journal writes. `--run none` also skips them.
Automatic journal failures are swallowed and never change a worker's report or
exit code; explicit selection/linkage errors stop dispatch. Missing artifacts/events
can therefore indicate a storage failure. Later terminal observers retry a missing finish.
Unreadable or malformed journals are retained rather than repaired. Journal
entries are an audit trail, not independent verification, automatic task replay
or a permanent archive. Ordinary continuation commands still need retained job
records and an available Codex thread.
