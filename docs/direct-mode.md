# Direct mode and worker lifecycle

How Claude runs Codex workers: dispatch, results, questions, stops, recovery and the Haiku fallback. Back to the [README](../README.md).

## Using Codex workers

You normally do not call anything yourself: ask Claude to delegate, or let it
decide that a task benefits from an independent worker.

```text
Have Codex investigate why the integration tests are flaky, and in parallel have
another Codex worker review the retry logic in src/net/.
```

### Native subagent (default)

Claude uses `Agent(subagent_type: "codex:codex-native", prompt: "<brief>")`
by default from the first dispatch, without waiting for a readiness notice.
The function hook runs Codex and returns its report through the native agent
completion. An optional first prompt line sets Codex options:

```text
DUET: --model gpt-6-astra --effort xhigh --sandbox read-only --normal
<brief: objective, context, owned paths, constraints, acceptance criteria>
```

The header also accepts `--cwd` and `--fork`. A `--cwd <repo>/sub` starts or resumes
the Codex thread in that subdirectory; broker and job state stay at the repository
root. Set the Codex model in the header:
the Agent tool's `model` only selects the Claude shell. Initial-task effort
precedence is `DUET: --effort` > explicitly supplied Agent
`effort` (including `max`) > companion default. The shell definition's
`effort: low` is not a Codex request; follow-ups retain recorded thread settings
unless overridden. Native calls can be foreground or background.
In plan mode the worker runs with `--sandbox read-only`; a header asking for a
writable sandbox is refused (`native_plan_mode_read_only`) and nothing starts.
A header the companion rejects before starting a job (an invalid value, an
unavailable Codex) returns a blocked report and the agent accepts a corrected
message. Use SendMessage to the native agent's
name to continue the same Codex thread or answer its pending question. The
adapter handles waits; stop an active task from `/tasks`. It gives the owner stop
a bounded chance to confirm `interrupted` / `owner_stopped`, then uses a cancel
fallback if confirmation is missing. A parked question may
outlive stopping an already-ended agent row: use `duet cancel <worker>` for an
explicit cancellation, or the question expires after 900 seconds by default.

When Codex reports token usage, the agent transcript ends with a `Codex usage`
notice and the result carries `usage`; Codex tokens are not added to Claude's
own usage or cost. A late answer is submitted only to the question the agent
last returned; if another answerable question is pending, that current question
is returned. If no unanswered pending slot remains or the job has ended, the
adapter returns the old job with a notice, including after reload. It does not reinterpret the
late answer as a task; a subsequent new brief can start work. The adapter does
not check expiry locally: if the unanswered slot still exists past its deadline,
the pinned answer goes to the companion and is refused there, as in 1.4.2.
Expiry alone does not promise the resolved-question notice.

Every fresh native Agent call reserves a scientist pool name through the companion
before spawn and claims it at dispatch. A passed label is replaced unless it is
a free pool name; resumptions retain their name. When the assigned name differs
from the input, the Agent result's context gains `Codex worker named X` and the
SendMessage target, background launch acknowledgements included; the result itself is
unchanged. A preserved free pool name adds no note, and denials stay as they are. Reservation uses cached host Node
within a two-second budget; on failure the Agent call passes through unchanged.
See [naming rules](commands.md#companion-subcommands).

Live progress appears under the Agent row in the main transcript (three latest
entries, name, model, effort, speed and elapsed time) and under each turn's prompt
row in the agent view (up to 40 entries). Each log is bound to the row's appended
`uuid`, keeping identical briefs separate; same-title starts and completions
merge FIFO. Unobserved rows, including after reload, render without a log.
The spinner shows `<worker> · running · <elapsed>`. The `DUET:` flag line draws as
a compact `Codex · model · effort · speed · sandbox · folder` header, with only
supplied settings and `fork` when requested. Completion lines use colours matching
`codex-live`; the agent view renders the report as readable markdown. These bounded projections
leave the recorded report and Claude's hand-back unchanged. Command-start lines
are live only; other progress remains in durable notices, capped at 200 per turn
with a final usage-notice exemption. See [progress format](worker-lifecycle.md#fallback-and-compatibility-feed-mode).
Keepalives stream after 30 seconds without streamed progress, even when durable
notices are suppressed or handle lookup fails. Only one keepalive publication
can be pending, bounding the queue when a reader is slow.

`agent.spawn` records the type and a small timestamped guard, then returns;
`turn.start` performs admission, eviction and the durable binding. This lets the
first turn run before the host lists the agent. Store pressure reclaims ordinary
finished history oldest-first; active bindings and protected pending work remain.
See [native capacity and retention](state-and-retention.md#native-adapter-store).

After registration, the adapter announces native workers on the first accepted
non-command person prompt of each session (`prompt.submit`, not SessionStart).
That notice is informational. If the hook does not handle the turn, the agent
returns `blocked` with `native_adapter_unavailable`, not a substitute solution.
Run `/reload-plugins`, check `duet status` before retrying because dispatch is
unconfirmed, and use background `duet task` if it persists. See [troubleshooting](troubleshooting.md).

### Direct mode

Use `duet task --help` for task flags; help starts no job. The installed plugin
adds `bin/` to PATH, and SessionStart supplies the session ID and the Bash
recipe, framed as a fallback to native dispatch from the first assignment.
SessionStart names `codex:codex-native` without waiting for registration evidence;
an unavailable adapter reports its fallback condition. After registration the adapter adds a
`codex:native-dispatch` system-prompt section (`prompt.compose`, session scope)
to every request that offers the Agent tool. That section asks for native dispatch first:
browser work and Computer Use run natively, with unapproved apps arriving as
approval questions. Background-Bash `duet task` is only for `native_adapter_unavailable`
or `native_capacity`, per-call overrides the `DUET:` line rejects (`--run`, `--approve-browser-origin`,
`--approve-computer-app`, `--lease-sec`, `--question-timeout-sec`) and follow-ups
to Bash-launched workers. Because the system prompt is rebuilt for every request,
compaction cannot remove that guidance, unlike the one-time readiness notice. If `duet` is missing in an older session, reload/start a new session or
use the absolute `plugins/codex/bin/duet` launcher path.
The SessionStart answer recipe pins the displayed `--question` ID. Its exports
append to `CLAUDE_ENV_FILE` with a newline separator when a previous hook left
its last line unterminated.

Claude makes one Bash call per job with `run_in_background: true` and
`description: "Codex: <label>"`. When Claude's Bash sandbox is on, set
`dangerouslyDisableSandbox: true` because the runtime needs network and local
sockets.

```bash
duet task --model gpt-6-astra --effort xhigh --normal <<'DUET_TASK'
<brief: objective, context, owned paths, constraints, acceptance criteria>
DUET_TASK
```

The brief goes only on stdin. Use single-quoted `DUET_TASK`/`DUET_ANSWER`
heredocs with delimiters absent as complete lines from the text, and single-quote
dynamic arguments. The permission hook auto-approves only its narrow grammar:
double quotes, pipes, compound commands, sandbox bypass and flags outside its
allowlist go through normal permissions. Read-only workers add `--sandbox
read-only`; another checkout adds `--cwd '<dir>'`. Parallel writers need disjoint
OWNED PATHS or separate worktrees.

For accepted commands, the hook pins the absolute launcher, single-quotes every
validated argument and injected session/tool-use binding, and preserves heredoc
bodies byte-for-byte. This prevents argument expansion through zsh aliases or
`=command` lookup. It binds commands in every non-plan permission mode, including
bypass mode; plan mode abstains. PATH collisions still use normal permissions.
It does not scan shell snapshots: harmless aliases, helper text and stale or
missing snapshots must not silently prevent report attachment. A shell function
can shadow even an absolute launcher, but anyone able to plant functions in the
user's shell initialisation can already run arbitrary commands.

`duet task` implies `--direct`: a detached job with this process attached as
its owner wait. Compact progress appears in `/tasks`. When the job ends, asks a
question or reaches the wait budget, report v2 arrives with the completion
notification. Only if the report is missing, run `duet result <worker>`; do not
parse the output file, poll or sleep. `--quiet` suppresses progress. The wait
renews its lease independently of output draining; pending progress is capped
at 200 lines, with an omitted-line notice before the final JSON line.

If a tracked job ends without an emitted report, the next typed prompt can
give Claude a one-time recovery cue after 10 seconds, for up to five jobs in
the session with no live attached owner wait. Lookup failures leave the prompt
unchanged. See [unreported endings and limits](worker-lifecycle.md#unreported-endings).

`--run <id|none>` chooses journal linkage for this dispatch only. Omit it to
use the session's active run, falling back to the sole open workspace run when
none is active; several open runs leave the task unlinked. Use `journal use
<runId>` to select one for the session, `--run none` to skip linking, or
`--run <id>` to select an open run across workspaces in the same isolated home.
Invalid or closed runs fail before
a worker starts. Follow-ups do not inherit this choice. See [run journal](run-journal.md).

Report v2 starts with `status`, `worker`, `jobId`, `summary`. The summary is capped
at 8000 characters (`summaryTruncated` when cut); the rest fits within 2000 bytes.
Nonempty fields include `blockers`, `question`, `changedFiles`, `checks.ran`
(captured commands), `checks.claimed` (Codex's account), `assumptions`,
`keyFindings`, then optional `usage` with integer `inputTokens`,
`cachedInputTokens`, `outputTokens`, `reasoningOutputTokens` and `totalTokens`
for this turn only (omitted when unknown). `next` suggests an action or is null.
`details` gives `duet result '<jobId>' --details`, targeting the exact job even
after a follow-up, for handles, settings, artifact paths and fuller evidence.
Use it whenever compact evidence or question text was shortened.
Compact blockers retain bounded app/tab/session and safe approval identifiers,
plus cleanup status when captured. A refused follow-up with `thread_busy` points
`next` to the owning job's pinned answer if it has a question, otherwise its
recovery/status action, or null. The blocker carries the owner's question and
cancel action when available; `details` continues to select the refused attempt.

- Terminal: apply the [acceptance protocol](../plugins/codex/prompts/ultra-codex-protocol.md#accepting-a-result-every-worker-report-no-exceptions),
  even after a nonzero exit. Verify the diff and checks yourself; read
  `rawOutputFile` only if report fields are insufficient.
- `running`: run `duet wait <worker>` in background Bash and wait for its notification.
  An expired unanswered question does not make `wait` return early; it continues
  waiting under the usual completion, question, stop and wait-budget rules.
- `needs_answer`: run ONE background Bash call (`timeout: 600000`):

  ```bash
  duet answer Ada --question '<questionId>' <<'DUET_ANSWER'
  <answer to Ada's pending question>
  DUET_ANSWER
  ```

  Prefer the report's `next` command verbatim. If constructing the command above,
  replace Ada with its target and `<questionId>` with the displayed `question.id`.
  The command resolves the owner, refuses a stale/expired question or an explicit
  owner mismatch, and refuses a stopping job or expired lease. These checks also
  apply to submit-only answers. It submits once, then waits
  on the same turn. A bare `duet answer <worker>` answers whatever question is
  pending now, which may be newer than the one you saw. Native SendMessage
  pins the displayed question. Do not start another
  wait. `question` supplies `id`, `kind`, `text`, `options` and `expiresInSec`;
  `optionsOmitted` counts choices removed to fit the report budget. A Computer
  Use approval has four fixed options; forward it
  with `AskUserQuestion` unless the user pre-authorised the app. Submit only an
  exact displayed option label, its number `1`–`4`, or one of
  `call`/`once`/`task`/`always`/`deny`/`no`, without explanation. Answers are
  trimmed and case-insensitive; exact labels allow a trailing period. Anything
  else, including `yes` or qualified text, denies the request. The same rules
  apply to native SendMessage; see [approval choices](computer-use-approvals.md#forwarded-approvals-owned-jobs).
- `ownership_moved`: report it; do not reuse the retired owner or re-adopt.
- `error`: check `duet status` before resubmitting; a runtime or wait failure
  may occur after launch. `owner_stopped` means the wait was stopped and the
  job interrupted; use `--details` for recovery information.

Never run two waits for one job. Exit codes are 0 for `completed`, 2 for
`blocked`/`needs_input`, 1 for other terminal states, 0 for `running`/`needs_answer`,
2 for `ownership_moved`, and 130 for a stopped owner wait. Direct mode rejects
`--follow`, `--detached`, `--background`, `--json`, `--feed-limit` and
`--min-interval-sec`.

Without a requested name, each worker gets one of 1,089 historical scientist or computing pioneer names,
drawn from unused names in three tiers: 120 familiar names weighted 10 each,
299 weighted 3 each, and 670 weighted 1 each. Numbered suffixes appear only after
the pool is exhausted, with the base chosen by the same weights. Use
`duet task --name <label>` to request a name on a fresh thread; reserved names
fall back to the pool, and follow-ups keep their name. Names use 1–64 ASCII
letters, digits, `_`, `.` or `-`, starting with a letter or digit. The prefixes
`task-`, `review-` and `job-` are refused case-insensitively by `--name` and ignored
by internal native naming. Adoption and
cross-session `--thread` follow-ups reserve a name in the destination session,
renaming on collision. Follow up with
`duet task --to <worker>` and a new stdin brief; it keeps the original cwd and
thread and inherits recorded model, effort, sandbox and speed. Request grants
are inherited only from the original dispatch in the same Claude session;
runtime-only approvals and foreign dispatches after adoption are excluded.
Explicit flags override inherited settings and eligible request grants; restate
`--sandbox read-only` when narrowing
access and `--normal` when resetting fast mode. `--thread <id>` also inherits
recorded settings. Settings come from this Claude session's newest started
attempt on the thread; only when this session has none does `--thread` fall
back to the thread's newest started attempt from another session. Another
session's later narrowing therefore does not change this session's follow-ups:
restate `--sandbox` explicitly when it must. `--resume`/`--resume-last` also
inherit the selected thread's settings; refused or never-started attempts are
not settings anchors. Use a job ID to address an older turn; never select
parallel work by “the latest thread”.

### Context: instructions and explicit forks

Claude's loaded CLAUDE.md/rules from the session's first `prompt.context` are
automatically forwarded as `developerInstructions`. Later contexts are ignored;
edits apply from the next Claude session. An unavailable or invalid first
inventory leaves no snapshot and Duet reports an approximate startup scan. A
scan excludes auto-memory by real path, including indirect symlink aliases. A
valid inventory that exceeds the capture budget stays authoritative, with
omissions reported; it never falls back to scanning removed files back in.
Threads retain their original instructions, so changed rules also need a fresh task. Opt out
with `--no-claude-md` on a fresh task or `CODEX_COMPANION_CLAUDE_MD=0`.
Codex's own project-file discovery is separate; see
[configuration](configuration.md#claude-instructions-and-conversation-imports).

A normal brief does not include the conversation. Use `duet task --fork` with
stdin to import the current Claude transcript into a new thread, then run the
assignment. `--source '<jsonl>'` selects another allowed transcript. Imports are
labelled “imported Claude conversation (fidelity not verified)”; fidelity has
not been established. The default import limit is 20 MiB, configurable with
`CODEX_COMPANION_IMPORT_MAX_BYTES`; oversized imports fail rather than truncate.
`--fork` cannot combine with `--to`, `--thread`, `--continue` or resume flags.
Use `--to` for follow-ups after the fork.

### Live view with codex-live

Install the separate pane plugin with `/plugin install codex-live@duet`. New jobs
ask Claude Code to open the pane; Claude Code decides whether it is shown at the
current width. `/codex-live` opens and focuses it at any width.
It shows the session's jobs and the selected job's prompt, Codex messages, commands,
file changes, tool calls, plan and pending question. Resolved `ask_parent` calls
show their matched answer on fresh and resumed threads using Codex's
`_meta.callId`, preserved by the MCP bridge. Missing/invalid call IDs remain
unmatched, including older stored answers. Jobs on the same Codex
thread (`--to`, `--thread` and `--continue` follow-ups) form one row whose transcript
shows retained turns in order. The row follows its active owner and question,
even after a newer refused follow-up. Active questions say `Question for Claude`,
`needs_input`/`blocked` say `Needs your attention` in warning/error colours, and
unresolved turns say `Outcome unknown`. Non-question waits say `Waiting for Claude`.
It is read-only: it never
starts, answers or cancels a job, and costs no Claude tokens. The pane reads
companion-written markers under
`<isolated home>/duet/sessions/<claudeSessionId>/`.
Active rows show a pending question or current operation when available, with
quiet time after a minute; unanswered questions, unresolved turns and blocked/needs-input results
take priority. New workers preserve the selected conversation and its
scroll position, showing `• new` until selected; returning to a viewed
conversation restores its saved scroll position. **Clear finished** hides ended
conversations only when they have no active or unresolved turn, without deleting
records or changing your Duet cleanup settings. Pane bookkeeping is bounded
with retained history. In addition to the newest 20 sessions and active/unresolved/
selected exceptions, the newest 40 uncleared terminal-attention sessions are
protected (`ATTENTION_SESSION_LIMIT`), subject to the state budget. The status
line counts questions, attention and unknown outcomes separately; attention
includes omitted terminal-attention sessions, with the omission count shown.
The feed uses retained activity (at most 500 stored events per job, with tighter
pane limits); tool counts prefer cumulative `activityTotals.toolUses`. Narrow panes retain
history navigation (`j`) alongside Clear (`c`). Discovery failures have their
own warning; malformed pane caches are reset and rediscovered without changing
job records. Windows drive and UNC job/workspace paths are accepted, and
`USERPROFILE` supplies the home when `HOME` is absent. A missing job is removed
after two ENOENT observations at least five seconds apart only if both the session
inventory and jobs folder are readable and that folder no longer lists the file.
A marker absent from a readable inventory also removes its entry and pane metadata;
transient failures preserve the last good view. See the [pane reference](../plugins/codex-live/README.md).

### Haiku fallback

Use `Agent(subagent_type: "codex:codex-worker")` when native dispatch and
background Bash are unavailable, or the user asks for a forwarding-agent
transcript. Never pass `model` or `effort` to that Haiku agent; put Codex's choices
in the assignment text. Its [definition](../plugins/codex/agents/codex-worker.md)
keeps `effort: low`, `omitClaudeMd: true` and `autoCompactWindow: 100000`.

The forwarder calls `duet task --timeout-sec 570` in foreground Bash with
`timeout: 600000`, then `duet wait <worker> --timeout-sec 570` on `running`.
It relays the full `questionMessage` from `duet result <worker> --details`, accepts
SendMessage replies and submits them with `duet answer <worker> --question '<questionId>'`,
retaining the ID of the relayed question. It returns
report v2 verbatim plus at most five lines of notes for stderr, retries or a
relayed question. Follow-ups start a NEW fallback agent with `duet task --to
<worker>`; SendMessage to an existing fallback agent only answers its pending
question. The parent performs the same acceptance checks.

### If a worker is stopped

`duet task --continue <jobId> --cwd '<cwd>'` starts one new turn on
the same thread with the recorded settings, only with the user's consent, and a
still-running job can be adopted by a replacement owner without a new turn.

Stop the background task in Claude Code, or run `duet cancel <worker>`.
Stopping its attached owner wait signals the helper, interrupting the Codex turn
as `interruptionReason: owner_stopped`. A dead owner wait can be replaced
immediately with the same owner while the job is still active and its lease
unexpired; a second live, recently heartbeating wait is refused. Without a
replacement, an owner killed outright is detected within about 5 s
(`CODEX_COMPANION_OWNER_GRACE_SEC`) as `owner_lost`. Thread context and on-disk
edits persist. A normal wait return (timeout, question, terminal state) leaves
the job protected by its lease. A stopped fallback agent cannot resume via
SendMessage.

After a stop, `duet result <worker> --details` supplies the recorded handles and
compatibility `continuationCommand`. With explicit user consent, run
`duet task --to <worker>` with a new brief, or `duet task --continue <jobId>
--cwd '<cwd>'` to retain that exact job's settings. Either starts one new turn;
nothing continues automatically. If no thread was recorded, continuation is
unavailable. A native agent can also continue through SendMessage when Claude
Code allows it; the Haiku fallback requires a new agent.

A job still running after its owner returned normally stays alive for the lease
window (default 1800 s in direct mode, 180 s otherwise, from the last renewal;
`task --lease-sec`). With the user's explicit consent, a replacement owner whose
FIRST action is `duet adopt <jobId> --json` takes over that live turn. Adoption rotates
the ownerId and renews the lease, preserving the thread, turn, pending question
and delivered feed cursor; never submit a new task for an adoptable job. Start
one `duet wait <jobId> --owner '<newOwnerId>'` in background Bash. The old
owner's wait/status/answer calls return `ownership_moved`; it must stop, never
re-adopt. Without adoption the job is interrupted at lease expiry
(`lease_expired`) with a continuation command. Observational `/codex:status`, `duet status` and `duet result` do not renew the
lease. `duet wait` resolves and renews the owner; an ownerless compatibility
companion wait is observation only.

`/codex:status` marks stale running jobs **orphaned**, with remaining lease seconds
and an exact adopt instruction, after half the lease without renewal in direct
mode (900 s with the default 1800 s lease), or the smaller of 65 s and half the
lease otherwise.

### Defaults and runtime choices

| Choice | Default | Override |
| --- | --- | --- |
| Model | `gpt-6-astra` | `--model <name>` (`spark` maps to `gpt-5.3-codex-spark`) |
| Reasoning effort | `xhigh` | `--effort none…xhigh` or `--effort max` where the model supports it |
| Speed | normal | `--fast` requests the fast tier; `--normal` resets inherited speed |
| Direct-mode timeout | 3600 s | `--timeout-sec <seconds>` (maximum 3600) |
| Owner lease | 1800 s in direct mode; 180 s otherwise | `--lease-sec <seconds>` |
| Codex sandbox | `danger-full-access` (full access, like the Codex app's own full-access mode) | Lower the default with `setup --default-sandbox read-only\|workspace-write` (stored in `~/.claude/codex-isolated/duet/config.toml`); narrow or widen one call with `task --sandbox <mode>`; `--write` is a floor (at least `workspace-write`), `--write=false` an explicit read-only call |
| Approval policy | `never+elicitations` on owned jobs (every command/sandbox/rule prompt rejected; a Computer Use app request is forwarded to the parent as a question); `never` on a compatibility non-direct companion task | — |
| Browser | unrestricted: any website, no per-origin prompt (`approval_mode = "never_ask"` is mirrored into the isolated browser runtime before every task); network access stays on in every sandbox mode | `setup --browser-approval ask` restores the runtime's ordinary origin checks (saved in `duet/config.toml`); `setup --browser-approval never-ask` returns to the default |
| Computer Use apps | `mirror`: apps the user marked "always allow" in their Codex app (`~/.codex/computer-use/config.toml`, read-only) are copied into the isolated runtime's approval file before every task; any other app is asked of the parent during the task | `setup --computer-use-approval ask` stops the sync; `setup --allow-computer-app`/`--revoke-computer-app <bundle id>` adjust individual apps; `task --approve-computer-app <bundle id>` pre-approves one app for one call |
| Claude instructions | Loaded CLAUDE.md/rules forwarded; approximate scan if unavailable | `--no-claude-md`, `CODEX_COMPANION_CLAUDE_MD=0` |
| Codex project discovery | `CLAUDE.md` where no `AGENTS.md` exists | `duet setup --project-docs agents-only` |

The parent chooses a sandbox per call; fresh tasks without a flag use the
configured default. `--to`/`--thread` inherit recorded settings unless overridden;
`--continue` inherits the selected job's settings and rejects conflicting flags.
When no sandbox was recorded, follow-ups return `thread_settings_unknown` until
`--sandbox` is explicit; `--continue` allows it for missing settings, but rejects
a sandbox override when the selected job has recorded one.
Workers never elevate after a denial. Bash's `dangerouslyDisableSandbox: true`
is separate from Codex's own sandbox and is needed when Claude's Bash sandbox
blocks the runtime's network access or local sockets.

### Parallel work

Read-only workers may share a checkout. Concurrent writers need disjoint owned
paths or separate worktrees; shared files, lockfiles, indexes and generated
output need serialization. Job state uses interprocess locks and atomic writes;
count pruning keeps active/unresolved jobs, the latest 50 ended jobs and the
newest ended job that started a turn on each of the 200 most recent threads. Thread anchors remain
subject to [age retention](state-and-retention.md#retention).
