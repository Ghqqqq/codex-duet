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
run, even when the second start uses another workspace. Add, close, show and validate
default to the session's active run regardless of the current cwd. `--run <id>`
selects an existing run in the current workspace explicitly. Without an active
run, show and validate fall back to the newest run in the current workspace. List returns
that workspace's runs newest first. Invalid JSON, missing fields, invalid enum
values and unknown entry types fail before journal writes.

| Input | Fields |
| --- | --- |
| `start` | Non-empty `goal` string, `criteria` array of non-empty strings |
| `add criteria` | `criteria` array of non-empty strings, appended to existing criteria |
| `add verdict` | `jobId`, `verdict` (`ACCEPT`, `ACCEPT_WITH_GLUE`, `REWORK`, `REASSIGN`), `criteria` array of `{criterion, evidence, result}`, non-empty `reason`; optional `resolves` array of job IDs linked to this run |
| Criterion result | `met`, `not_met` or `cannot_verify`; criterion and evidence are non-empty strings |
| `add decision` | Non-empty `summary` and `basis`; optional non-empty `risk` string |
| `close` | `judgment` (`passed`, `blocked`, `abandoned`), non-empty `summary`; optional `openRisks` array of strings |

Empty criteria arrays are allowed when no criterion applies. Verdicts can name
jobs whose ordinary records have expired. The latest verdict supersedes earlier
verdicts in the recovery view; all entries remain in the journal. Jobs without a
verdict and jobs whose latest verdict is unresolved `REWORK` or `REASSIGN` are
open items. A later `ACCEPT` or `ACCEPT_WITH_GLUE` resolves earlier rework or
reassignment when it lists the rejected job in `resolves`, or is a descendant
through explicit `followUpOf`/`continuationOf` links. Sharing a thread alone does
not resolve it. The accepting job's latest verdict must still be acceptance and
must follow the rejected job's latest verdict in journal order; a later rejection
reopens it. Unknown job IDs in `resolves` are rejected before writing.

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
| `no_verdict` | Finished job has no verdict | Inspect its report, verify criteria and record a verdict |
| `open_rework` | Latest rejection has no later acceptance on that job, linked descendant or job naming it in `resolves` | Verify a correction before accepting; record `resolves` for a fresh replacement; continuing a stopped job requires consent |
| `unmet_criterion` | Latest result for exact criterion text is `not_met` or `cannot_verify` | Resolve and recheck it, then record observed evidence with `met` |
| `unchecked_criterion` | Task-level criterion appears in no verdict | Check and record that exact criterion text |
| `missing_artifact` | Latest finish's report path or file is missing/empty, unreadable or unsafe | Recover available report evidence, or explain its absence in a blocked/abandoned close |

Criteria match by **exact text**, including case and whitespace. The latest
result for that text across all jobs wins; a newer verdict that omits the text
does not erase its previous result. Additional criteria introduced in verdicts
also produce `unmet_criterion` when their latest result is negative. Duplicate
task criteria produce one unchecked issue. A verdict labeled `ACCEPT` with a
negative criterion result still blocks a passed close.

`journal close` rechecks completeness under the run lock. With `passed`, any
issue refuses closure with exit 2 and leaves the journal and active pointer
unchanged. With `--json`, refusal returns the validation JSON above. `blocked`
and `abandoned` can close despite issues; all successful closes store the
computed `openIssues` array in `run_closed` (empty for `passed`). A caller cannot
override that snapshot. Existing `openRisks` remain the orchestrator's explanation.
The snapshot is fixed at the close row; `validate` and `show` reflect current
observations, including any later worker finish or missing artifact.

If an unfinished job's record has expired, is unreadable or no longer says
queued/running, validation cannot establish that it is live and does not emit
`unfinished_job`. Unknown job references are not a separate issue kind. Empty
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
(`runId`, `goal`, `criteria`, `cwd`, `sessionId`), `criteria`, `verdict`,
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
from different workspaces cannot open multiple runs for one session. The
terminal observer checks for an existing `job_finished` with the same job ID
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
`unchecked`; `Open` lists each validation issue and its next action. Text fields
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

Linking applies to tasks dispatched by the same Claude session, including tasks
using other workspaces or worktrees as `--cwd`. Other sessions do not inherit
that run. All processes must use the same isolated home. A new continuation
links to the currently active run, not automatically to its predecessor's run. No active run
means no journal writes. Automatic journal failures are swallowed and never
change a worker's report or exit code; missing artifacts/events can therefore
indicate a storage failure. Later terminal observers retry a missing finish.
Unreadable or malformed journals are retained rather than repaired. Journal
entries are an audit trail, not independent verification, automatic task replay
or a permanent archive. Ordinary continuation commands still need retained job
records and an available Codex thread.
