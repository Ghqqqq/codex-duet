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
```

`<workspace>` is a slug plus hash of the workspace root. Directories are created
`0700` and job/result JSON files `0600`; log files and `broker.json` follow the
process umask. The location depends only on the isolated home
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

Record format, owner/lease semantics and command output fields are unchanged.
Once no older release runs anymore, remove a legacy directory by hand only when
the artifacts its migrated records reference are no longer needed.

## Retention

At session start, Duet's detached prewarm child cleans ended job records, session
markers and old Codex threads that no retained job uses, at most once every 12
hours. It follows `cleanupPeriodDays` in `${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json`
(default 30 days); `CODEX_COMPANION_RETENTION_DAYS` overrides it. Values below one
are clamped to one day and reported. Age cleanup protects running/queued jobs,
attached owners, live worker PIDs and unresolved turns (a lost or unconfirmed
turn that may still run on the server). Dead orphan records whose outcome is
still unresolved remain protected. Expired dead orphan files that are not
unresolved can be cleaned even if their saved status is stale; stale running
index entries without private records are removed when not unresolved.

Count pruning separately keeps active/unresolved jobs, the 50 newest ended jobs
and, for settings inheritance, the newest ended job that started a turn on each
of the 200 most recent threads (a newer refused or never-started attempt does not
replace it). Those 200 thread anchors are protected from count pruning only:
otherwise eligible ended anchors still expire with the age window. Status
listings show the 50 newest ended jobs plus active/unresolved jobs. Threads
use rollout last-activity time and are deleted through Codex's `thread/delete`
API, keeping its indexes consistent; unavailable deletion is reported and skipped.
Jobs with legacy artifact paths are kept and listed under `retained`, separately
from errors. Their threads stay protected while unrelated old threads can expire.

Preview with `duet cleanup --dry-run --json`; apply with
`duet cleanup --json`. Both ignore the 12-hour limit; `--days N`
overrides the period for that command. Nothing is removed immediately on job
completion, so results, continuations and pane history remain available during
the retention period (subject to the count cap).
