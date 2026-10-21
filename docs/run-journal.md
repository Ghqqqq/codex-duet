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
node "$CODEX_COMPANION" journal start <<'JSON'
{"goal":"Add durable recovery","criteria":["Criteria and verdicts survive compaction"]}
JSON
node "$CODEX_COMPANION" journal add criteria <<'JSON'
{"criteria":["Keep all journal files in the isolated home"]}
JSON
node "$CODEX_COMPANION" journal add verdict <<'JSON'
{"jobId":"task-...","verdict":"ACCEPT","criteria":[{"criterion":"Criteria and verdicts survive compaction","evidence":"Ran journal show in a new process and observed the stored criteria","result":"met"}],"reason":"Observed evidence meets the criterion"}
JSON
node "$CODEX_COMPANION" journal add decision <<'JSON'
{"summary":"Use a workspace journal","basis":"Keep acceptance evidence after job pruning","risk":"History still expires under retention"}
JSON
node "$CODEX_COMPANION" journal show
node "$CODEX_COMPANION" journal close <<'JSON'
{"judgment":"passed","summary":"Acceptance criteria verified","openRisks":[]}
JSON
node "$CODEX_COMPANION" journal list --json
```

All commands accept `--cwd <dir>`, `--json`, `--help` and `-h`. Help exits
before reading stdin, creating files or starting a runtime. Start prints
`{"runId":"run-..."}`. A second start with an open run is an error naming that
run, even when the second start uses another workspace. Add, close and show
default to the session's active run regardless of the current cwd. `--run <id>`
selects an existing run in the current workspace explicitly. Without an active
run, show falls back to the newest run in the current workspace. List returns
that workspace's runs newest first. Invalid JSON, missing fields, invalid enum
values and unknown entry types fail before journal writes.

| Input | Fields |
| --- | --- |
| `start` | Non-empty `goal` string, `criteria` array of non-empty strings |
| `add criteria` | `criteria` array of non-empty strings, appended to existing criteria |
| `add verdict` | `jobId`, `verdict` (`ACCEPT`, `ACCEPT_WITH_GLUE`, `REWORK`, `REASSIGN`), `criteria` array of `{criterion, evidence, result}`, non-empty `reason` |
| Criterion result | `met`, `not_met` or `cannot_verify`; criterion and evidence are non-empty strings |
| `add decision` | Non-empty `summary` and `basis`; optional non-empty `risk` string |
| `close` | `judgment` (`passed`, `blocked`, `abandoned`), non-empty `summary`; optional `openRisks` array of strings |

Empty criteria arrays are allowed when no criterion applies. Verdicts can name
jobs whose ordinary records have expired. The latest verdict supersedes earlier
verdicts in the recovery view; all entries remain in the journal. Jobs without a
verdict and jobs whose latest verdict is `REWORK` or `REASSIGN` are open items.
Close records the judgment and clears pointers to that run; closing twice or
adding manual entries after close is an error. It does not cancel workers. A
worker already linked to a run may still record its terminal report after close.
SessionEnd does not close a run.

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
for each job supplies its status and report path. Jobs without a saved report
are supplemented with live status and thread handles when available. Text fields
are shortened for context recovery; `--json` preserves the full criteria, verdict
evidence and decisions. Read a saved brief or report only when needed.
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
