# Direct mode and worker lifecycle

How Claude runs Codex workers: dispatch, results, questions, stops, recovery and the Haiku fallback. Back to the [README](../README.md).

## Using Codex workers

You normally do not call anything yourself: ask Claude to delegate, or let it
decide that a task benefits from an independent worker.

```text
Have Codex investigate why the integration tests are flaky, and in parallel have
another Codex worker review the retry logic in src/net/.
```

### Direct mode (default)

Run `node "$CODEX_COMPANION" task --help` (or `-h`) for all task flags, copy-paste dispatch examples and JSON result handling; help starts no job, and unknown task flags are rejected before dispatch. SessionStart adds a short command template and help pointer alongside the existing environment exports.

Claude makes one Bash call per job, with `run_in_background: true` and
`description: "Codex: <label>"`. When Claude's Bash sandbox is on, it sets
`dangerouslyDisableSandbox: true` because the runtime needs network and local
sockets. SessionStart exports `CODEX_COMPANION`, the absolute path to the
companion, to every Bash call. Older sessions lack it: resolve
`../scripts/codex-companion.mjs` relative to the [protocol's prompts
folder](../plugins/codex/prompts/ultra-codex-protocol.md) and use that absolute path.

```bash
node "$CODEX_COMPANION" task --fresh --direct --model gpt-6-astra --effort xhigh --normal <<'CODEX_TASK'
<brief: objective, context, owned paths, constraints, acceptance criteria>
CODEX_TASK
```

The prompt goes on stdin through a single-quoted heredoc, never on the command
line. Choose a delimiter absent as a complete line from the brief, and quote
dynamic runtime arguments separately. Read-only investigators and reviewers add
`--sandbox read-only`; another checkout adds `--cwd <dir>`. Parallel jobs need
disjoint OWNED PATHS, or separate worktrees Claude creates with `git worktree add`
and passes as `--cwd`.

The helper starts a detached job with this process attached as its owner wait.
While it waits it prints compact progress lines, which show up in `/tasks`. When
the job ends, a question is pending, or the timeout passes, it prints the compact
JSON payload as its last line of output (`--quiet` prints only that line).
Claude Code's completion notification carries no output: Claude reads the last
line starting with `{` from the output file it names
(`grep '^{' <output file> | tail -n 1`). Progress lines never start with `{`,
and Claude Code may append a trailer such as `[exited with code 0]`. Never read
the whole file, poll or sleep.

- Terminal: run the [acceptance protocol](../plugins/codex/prompts/ultra-codex-protocol.md#accepting-a-result-every-worker-report-no-exceptions),
  even after a nonzero exit. The structured report includes handles, runtime
  model/effort/serviceTier, touchedFiles/preExistingChanges/fileTrackingStatus,
  captured `verification` and `claimedVerification`, findings, assumptions,
  blockers and artifact paths, plus Codex's final `summary` (cut at 8000
  characters with `summaryTruncated: true`). It has `activityCount`, no
  `activity` list. Never read `rawOutputFile` unless a report field is
  insufficient.
- `running`: run its `waitCommand` (`wait <job-id> --owner <owner-id> --direct`)
  in the background again, then wait for the next notification.
- `needs_answer`: FIRST run its `waitCommand` in the background; its
  `--after-question <id>` keeps the lease alive without returning that question
  again. Then use `answerCommand` (`answer '<job>' --cwd ... --owner ...
  --question '<id>' --json`), with the answer text on stdin through a
  single-quoted heredoc. `question` supplies `id`, `kind`, `text`, `options` and
  `expiresAt`. Forward a Computer Use `question.kind` of `approval` with
  `AskUserQuestion` unless the user pre-authorised the app. The answer continues
  the same turn; never start a second wait after answering.
- `ownership_moved`: report it; do not reuse the retired owner or re-adopt.
- `error`: validation errors occur before dispatch, but runtime or wait errors
  can occur after launch; check `status` for an existing job before resubmitting.
  `owner_stopped`: the wait itself was stopped; the job is
  interrupted and the line carries its handles and `continuationCommand`.

Never run two waits for one job. Exit codes are 0 for `completed`, 2 for
`blocked`/`needs_input`, 1 for other terminal states, 0 for `running`/`needs_answer`,
2 for `ownership_moved`, and 130 for a stopped owner wait.
Direct mode rejects `--follow`, `--detached`, `--background`, `--json`,
`--feed-limit` and `--min-interval-sec`. It supports `--fresh`, `--thread`,
`--continue`, model/effort/speed, sandbox and approval flags, `--cwd` and stdin.

Each dispatched task gets a random historical scientist or computing pioneer name (`agentName` in JSON), reused by `--thread` and `--continue` follow-ups.

Follow-ups and rework start a new job on the same thread with
`task --thread <threadId> --direct`, the same `--cwd`, and the relevant criteria
restated. Never select a worker by "the latest thread". Verify claims with the
job/thread/turn handles, `result --report --json`, the actual diff and checks.

### Live view with codex-live

Install the separate pane plugin with `/plugin install codex-live@duet`. New jobs
ask Claude Code to open the pane; Claude Code decides whether it is shown at the
current width. `/codex-live` opens and focuses it at any width.
It shows the session's jobs and the selected job's Codex messages, commands,
file changes, tool calls, plan and pending question. Jobs on the same Codex
thread (`--thread` and `--continue` follow-ups) form one row whose transcript
shows every turn in order. It is read-only: it never
starts, answers or cancels a job, and costs no Claude tokens. The pane reads
companion-written markers under
`<isolated home>/duet/sessions/<claudeSessionId>/`.
The pane shows each agent name beside its short task summary; **Clear finished** hides ended jobs for this session without deleting their records or changing the default 30-day retention.

### Haiku fallback

Use `Agent(subagent_type: "codex:codex-worker")` only when direct mode cannot be
used, such as a surface without background Bash, or when the user asks for an
agent transcript view. Never pass `model` or `effort` to that agent; Codex's
model and effort go in the assignment text. The forwarder stays `model: haiku`,
`effort: low`, `omitClaudeMd: true`, `autoCompactWindow: 100000` in
[its definition](../plugins/codex/agents/codex-worker.md).

The fallback runs `task --fresh --follow --report` with Bash `timeout: 600000`,
then `wait <job> --owner <ownerId> --report` on a `running` return (570 s wait
budget). Feed mode is only for this fallback; `--feed-limit` defaults to 60.
The worker sends `questionMessage` verbatim to Claude once per pending question
and accepts the reply via SendMessage; progress, status and completion messages
are forbidden. It returns the helper's final JSON line verbatim plus at most
5 lines of notes for stderr, retries or a relayed question, with no prose report.

Fallback follow-ups and rework start a NEW worker with `--thread <threadId>` and
the same `--cwd`; SendMessage to an existing worker is only for answering its
pending question. Final results arrive only as agent return values. The parent
still performs the same acceptance checks.

### If a worker is stopped

In short: `task --continue <jobId> --cwd <cwd> --direct` starts one new turn on
the same thread with the recorded settings, only with the user's consent, and a
still-running job can be adopted by a replacement owner without a new turn.

Stop the background task in Claude Code, or run `cancel <jobId> --json`.
Stopping its attached owner wait signals the helper, interrupting the Codex turn
as `interruptionReason: owner_stopped`. An owner killed outright is detected
within about 5 s (`CODEX_COMPANION_OWNER_GRACE_SEC`) as `owner_lost`. Thread context and on-disk edits
persist. A normal wait return (timeout, question, terminal state) leaves the job
protected by its lease. A stopped fallback agent cannot resume via SendMessage.

The direct report carries the exact `continuationCommand`:
`node '<companion>' task --continue '<job>' --cwd '<cwd>' --direct`. It starts
ONE new turn on the same thread with the original sandbox, model, effort, speed
and approval settings; any extra prompt text is appended. With the user's explicit consent,
Claude runs it in background Bash; nothing starts it automatically. If no thread handle was recorded, no continuation is available.
Use a new fallback worker only when direct mode cannot be used or the user
requests an agent transcript view; its continuation uses `--follow --report`.

A job still running after its owner returned normally stays alive for the lease
window (default 1800 s in direct mode, 180 s otherwise, from the last renewal;
`task --lease-sec`). With the user's explicit consent, a replacement owner whose
FIRST action is `adopt <jobId> --json` takes over that live turn. Adoption rotates
the ownerId and renews the lease, preserving the thread, turn, pending question
and delivered feed cursor; never submit a new task for an adoptable job. Start
one `wait <jobId> --owner <newOwnerId> --direct` in background Bash. The old
owner's wait/status/answer calls return `ownership_moved`; it must stop, never
re-adopt. Without adoption the job is interrupted at lease expiry
(`lease_expired`) with a continuation command. Parent `/codex:status`, `status`,
`result` and ownerless `wait` never renew the lease.

`/codex:status` marks stale running jobs **orphaned**, with remaining lease seconds
and an exact adopt instruction, after half the lease without renewal in direct
mode (900 s with the default 1800 s lease), or the smaller of 65 s and half the
lease otherwise.

### Defaults and runtime choices

| Choice | Default | Override |
| --- | --- | --- |
| Model | `gpt-6-astra` | `--model <name>` (`spark` maps to `gpt-5.3-codex-spark`) |
| Reasoning effort | `xhigh` | `--effort none…xhigh` or `--effort max` where the model supports it |
| Speed | normal | `--fast` requests the fast tier for that call only; `--normal` resets |
| Direct-mode timeout | 3600 s | `--timeout-sec <seconds>` (maximum 3600) |
| Owner lease | 1800 s in direct mode; 180 s otherwise | `--lease-sec <seconds>` |
| Fallback feed limit | 60 lines per call | `--feed-limit <lines>` (`0` = unlimited; unavailable with `--direct`) |
| Codex sandbox | `danger-full-access` (full access, like the Codex app's own full-access mode) | Lower the default with `setup --default-sandbox read-only\|workspace-write` (stored in `~/.claude/codex-isolated/duet/config.toml`); narrow or widen one call with `task --sandbox <mode>`; `--write` is a floor (at least `workspace-write`), `--write=false` an explicit read-only call |
| Approval policy | `never+elicitations` on owned jobs (every command/sandbox/rule prompt rejected; a Computer Use app request is forwarded to the parent as a question); `never` on a plain foreground `task` | — |
| Browser | unrestricted: any website, no per-origin prompt (`approval_mode = "never_ask"` is mirrored into the isolated browser runtime before every task); network access stays on in every sandbox mode | `setup --browser-approval ask` restores the runtime's ordinary origin checks (saved in `duet/config.toml`); `setup --browser-approval never-ask` returns to the default |
| Computer Use apps | `mirror`: apps the user marked "always allow" in their Codex app (`~/.codex/computer-use/config.toml`, read-only) are copied into the isolated runtime's approval file before every task; any other app is asked of the parent during the task | `setup --computer-use-approval ask` stops the sync; `setup --allow-computer-app`/`--revoke-computer-app <bundle id>` adjust individual apps; `task --approve-computer-app <bundle id>` pre-approves one app for one call |
| Project instructions | `claude-md`: Codex reads `CLAUDE.md` where no `AGENTS.md` exists (`project_doc_fallback_filenames` in the isolated `config.toml`) | `setup --project-docs agents-only` |

The parent chooses a sandbox per call the way it would choose a permission mode
for a native subagent; without a flag the configured default applies. Each
follow-up uses its own flags and the current configured default; only
`task --continue` deliberately inherits the original job's settings. Per-call write access, fast
mode and browser grants are otherwise never inherited from an earlier turn, and
workers never elevate after a denial. Companion Bash calls run with
`dangerouslyDisableSandbox: true` because the runtime needs network access and
local sockets; that is separate from Codex's own sandbox.

### Parallel work

Read-only workers may share a checkout. Concurrent writers need disjoint owned
paths or separate worktrees; shared files, lockfiles, indexes and generated
output need serialization. Job state uses interprocess locks and atomic writes;
all active jobs and the latest 50 finished jobs are kept.
