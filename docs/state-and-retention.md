# Job state, migration and retention

Back to the [README](../README.md).

## Job state and migration

Job records, logs and result artifacts live in the isolated home, next to the
plugin's settings file:

```text
~/.claude/codex-isolated/duet/config.toml                  # default sandbox, browser and Computer Use approval
~/.claude/codex-isolated/computer-use/config.toml           # isolated Computer Use app approvals (mirrored + explicit)
~/.claude/codex-isolated/duet/state/<workspace>/state.json # per-workspace job index
~/.claude/codex-isolated/duet/state/<workspace>/jobs/      # <id>.json, .log, .output.txt, .result.json
~/.claude/codex-isolated/duet/state/<workspace>/broker.json
~/.claude/codex-isolated/duet/ultra-codex/<session-id>.json       # session mode, shared across workspaces
```

`<workspace>` is a trimmed ASCII basename slug plus the first 16 lowercase
SHA-256 hex digits of the canonical workspace root. The inert-workspace
exemption below also requires a recognized artifact layout; placement beneath
`duet/state` alone does not prove ownership. Directories are created `0700` and
job/result JSON files `0600`; log files and `broker.json` follow the process
umask. The location depends only on the isolated home
(`CODEX_COMPANION_HOME` or `~/.claude/codex-isolated`), so a terminal, a Claude
session and the SessionEnd hook read and write the same records;
`CLAUDE_PLUGIN_DATA` is no longer involved.

Earlier releases stored state under `CLAUDE_PLUGIN_DATA/state`, which Claude Code
derives from the plugin ID (`~/.claude/plugins/data/codex-codex-isolated-local`,
then `~/.claude/plugins/data/codex-duet`), and under
`$TMPDIR/codex-companion-isolated` when the companion ran outside Claude. The
first command that touches a workspace merges those directories into the new one,
once, under the new directory's state lock:

- Migration keeps the newer `updatedAt` record per job ID and applies the normal
  history cap; legacy directories stay in place. Pruning can delete records and
  artifacts within the job's own directory; age cleanup retains legacy-path
  artifacts for manual review.
- Retained records keep absolute artifact paths (`logFile`, `rawOutputFile`,
  `resultFile`) unchanged; those artifacts remain readable in place.
- A legacy job whose worker is still running is served in place until that
  worker ends, then is merged. This migration fallback does not make mixed-version
  writes safe: **upgrade or downgrade with no Duet jobs running**.
- A busy legacy lock is retried later rather than waited on. Concurrent first
  commands migrate once; the marker is `<workspace>/.legacy-migration.json`.
- `status`/`result`/`wait`/`adopt`/`cancel`/`task --continue` with a job or thread
  ID that is unknown to the new directory look in the legacy directories and
  import the match, so a job an older session writes after the merge is found.

Migration preserves existing record fields and owner/lease semantics.
Once no older release runs anymore, remove a legacy directory by hand only when
the artifacts its migrated records reference are no longer needed.

Routine lease, cursor and progress updates avoid rereading retained private
output when the index proves pruning cannot change membership. When private
records are needed for pruning, a bounded in-process cache reuses unchanged
records after checking file identity, timestamps and size. The newest-started
thread anchors and unresolved-turn protections below still apply. Mapping an
already recorded non-Git workspace root to its state directory needs no Git
process, including when the root is a symlink with no Git boundary at its real path.

Each job keeps its newest 500 activity events, independently of job-record age
retention. `activityTotals.events` and `activityTotals.toolUses` count all appended
activity; legacy jobs seed them once from retained events. Up to 100 hashed
pending tool identities support start/completion pairing; eviction can overcount
a later matching completion. The pane and `/codex:status` show retained events
only. See [activity limits](worker-lifecycle.md#fallback-and-compatibility-feed-mode).

If a writer cannot read or parse a workspace's `state.json` after brief retries,
it keeps the file as `state.json.unreadable-<time>`, rebuilds the index from the
job records in `jobs/`, publishes it before its own change, warns on stderr and
continues. A job record that stays unreadable after retries is left out until its
next update. Index-only settings return
to defaults and jobs without a job record leave the listing; both remain in the
kept file. Read-only commands never rebuild; they show an empty listing meanwhile.

## Retention

At session start, Duet's detached prewarm child cleans ended job records, session
markers and old Codex threads that no retained job uses, at most once every 12
hours. It follows `cleanupPeriodDays` in `${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json`
(default 30 days); `CODEX_COMPANION_RETENTION_DAYS` overrides it. Values below one
are clamped to one day and reported. Age cleanup protects running/queued jobs,
attached owners, live worker or launcher PIDs (on either the index entry or the job record) and unresolved turns (a lost or unconfirmed
turn that may still run on the server). Dead orphan records whose outcome is
still unresolved remain protected until reconciliation proves the turn ended.
Expired dead orphan files that are not unresolved can be cleaned even if their
saved status is stale. An index entry whose private record is missing is removed
only when it shows a terminal status, has no protection (including a live
launcher PID) and every recorded timestamp is past the cutoff; a stale `running`
entry without its record stays until recovery or manual cleanup.

Worker-name reservations are kept per session while any retained job can still
be addressed. Age cleanup retires a session's reservations once no surviving job
belongs to that session, no live writer holds a claim and the folder is past the
cutoff. Stale claim temporaries from dead processes are also removed. Partial,
locked or unreadable job inventories retain every reservation.

Every detached session-start prewarm also runs stale-job maintenance, independently
of the 12-hour age-cleanup interval, under the same retention lock. A pass has a
five-second budget and at most five exact-turn recovery attempts. Candidates must
be nonactive unresolved tasks with recorded thread and turn IDs, no attached owner
or live worker/launcher PID, and all recorded activity older than 30 minutes or
the lease plus one minute, whichever is longer. A recorded lease must also have
expired at least a minute earlier. Only terminal server evidence is reconciled;
unavailable or still-running turns remain unchanged. Missing handles, locked or
incomplete state and pending migrations are skipped. Recovery never starts a turn.

The pass scans at most 100 session marker files, using a persisted cursor across
all session folders so retained markers do not starve later folders. It removes
an orphan only when the marker points to its expected owned job path, the state
and jobs directories are readable, the job file is absent and no state lock is
present. Ordinary retention also removes markers for jobs it deletes, even when
those markers are newer than the age cutoff.

Count pruning separately keeps active/unresolved jobs, the 50 newest ended jobs
and, for settings inheritance, the newest ended job that started a turn on each
of the 200 most recent threads (a newer refused or never-started attempt does not
replace it). Those 200 thread anchors are protected from count pruning only:
otherwise eligible ended anchors still expire with the age window. Status
listings apply the 50-ended-job cap after session filtering, then the smaller
default display limit; `--all` removes that smaller limit. `historyOmitted` counts
retained jobs hidden in the selected scope, not deleted records. Threads
use rollout last-activity time and are deleted through Codex's `thread/delete`
API, keeping its indexes consistent; unavailable deletion is reported and skipped.
Jobs with legacy artifact paths are kept and listed under `retained`, separately
from errors. Their threads stay protected while unrelated old threads can expire.

Preview with `duet cleanup --dry-run --json`; apply with
`duet cleanup --json`. Both ignore the 12-hour limit; `--days N`
overrides the period for that command. Nothing is removed immediately on job
completion, so results, continuations and pane history remain available during
the retention period (subject to the count cap). The orphan-marker maintenance
above is separate from this age-based preview/apply cycle.

Retention and thread recovery share a read-only classifier for workspaces
without `state.json`. Readable index-less directories with no private job files
are exempt from blocking either inventory and are not listed as inert, even
if they contain other files. Private job filenames are `jobs/<id>.json`, where
`<id>` contains only letters, digits, `_` or `-`; `.result.json` files do not
count. Unreadable or unsafe directories still prevent a complete inventory.

For an index-less directory with private job files, the name must match Duet's
workspace-key form and every entry must fit its artifact layout. Recognized
entries include job `.json`, `.log`, `.output.txt` and `.result.json` files,
migration metadata, journal streams/briefs/reports and lock owner markers.
Identified jobs must be settled with status `completed`, `failed`, `cancelled`
or `interrupted`; unparsable artifacts and parsed files without a job ID
(including `{}`) are inert only within that proven layout. Live PIDs, a broker
pointer, attached owners, unresolved or nonterminal/unknown jobs, pending
migrations, open/unreadable journals and recent activity prevent the exemption.
Unknown names/content, wrong entry types or symlinks yield `unknown-content`;
recognized temporary writes or outstanding lock candidates yield `pending-write`,
even when old. These job-bearing directories remain in place with a reason and
continue blocking inventory completeness.

All file/directory mtimes must be older than the relevant minimum age: retention
uses its configured cutoff (including `--days`), while recovery inventory uses
24 hours (`INERT_INDEXLESS_MIN_AGE_MS`). A two-day-old workspace can therefore
stop blocking recovery while still blocking cleanup under a 30-day policy.
The classifier rechecks observed file/directory identities and timestamps;
changes during inspection prevent the exemption. Apply rechecks inert candidates,
and thread deletion rechecks the reference inventory. Valid terminal records
remain readable for turn attribution. Proven-inert leftovers no longer keep
the inventory incomplete, so unrelated thread cleanup can proceed in the same
plan when no other directory or error blocks it.

Classification acquires no state lock and moves or deletes nothing. Both
dry-run and apply JSON return `inertWorkspaces: [{ workspace, bytes }]` and
`workspacesRetained` with reasons for non-inert job-bearing trees. Text output
lists inert workspaces with a shell-quoted manual `rm -r` hint, valid only while
the workspace remains inactive. Classification adds nothing to `jobsDeleted`
or `bytesFreed`; the listed bytes do not contribute to deletion totals through
this classification. Automatic cleanup uses the same classification.
Independent [per-run retention](run-journal.md#recovery-retention-and-limits)
is unchanged and can still prune an eligible run in an index-less workspace.

Retention reuses parsed private records for one plan/apply cycle, including
locked revalidation and thread-reference checks. Each reuse checks file identity,
timestamps and size; changed records are reread, and the cache is released after
apply. Deleting jobs from indexed workspaces still rechecks eligibility under
the state lock.

## Native adapter store

Native agent bindings use the hook store separately from companion job history.
Admission fits within 128 binding records and a conservative 2 MiB serialized-size
budget. Finished history occupies spare slots and is evicted oldest-first when
space is needed; it no longer blocks admission merely by reaching 128 records.
Active turns and pending questions remain protected. Unconfirmed cancellations
are protected from pressure eviction until the turn is proven ended (a closed
turn or confirmed cancellation), or the existing seven-day age expiry is reached.
A stopped agent whose recovery is unresolved (an inferred completion with an
unconfirmed turn, or an `unknown`/`unreachable` report) gets no finish time, so
neither pressure eviction nor age expiry removes it until an ending is confirmed.

Timestamped spawn guards protect bindings awaiting their start for ten minutes;
a guard whose start never produced a binding is reclaimed after 24 hours.
Legacy never-started bindings get ten minutes from first observation, then yield
under pressure after finished history. A brief over 65,536 characters is rejected
as `native_message_too_large` before eviction. Every admission refusal clears its
spawn guard. If protected records or the byte budget still prevent admission,
`native_capacity` launches nothing; wait for active workers, stop them if intended,
or use background `duet task`. A follow-up whose binding was evicted returns
`native_binding_gone`; start a new native agent. These limits do not delete the
companion's job results, which follow the retention rules above.
