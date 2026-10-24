# Changelog

## 1.4.2

### Parent questions

- Fresh threads now use the per-thread MCP `ask_parent` bridge, keeping the question outside code mode so waiting for an answer does not trigger repeated `exec`/`wait` sampling. The bridge captures its starting job's thread as soon as it is recorded and keeps it for its lifetime once captured, so pruning the starting job cannot disable later questions on the loaded thread; resumed bridges keep their supplied thread handle.
- Bridge questions follow the recorded turn owner across workspaces, excluding queued reservations without a turn. Missing turn metadata (older runtimes) requires exactly one readable eligible owner; an unrelated unreadable workspace directory does not disable questions. Mismatched thread metadata is refused, and valid Codex `_meta.callId` values let `codex-live` match answers on fresh and resumed threads; missing or invalid call IDs remain unmatched.
- Registration fallbacks require a supported RPC error code and an unsupported signal attached to the registration field itself; a field named only in serde's list of accepted fields does not count. Fresh threads retry unsupported bridge registration with the dynamic tool, then without registration if necessary; unrelated model/config errors retain their original diagnostic without retrying.

### Approvals and configuration

- Computer Use approval answers must be an exact option label (case-insensitive, trimmed, with an optional trailing period), its number `1`–`4`, or one of `call`, `once`, `task`, `always`, `deny`, `no`. Anything else denies the request, including `yes`, negations and qualified or mixed replies.
- Setup and tool sync use one PID-aware lock per config file and recheck for concurrent edits. TOML updates preserve comments and extend existing dotted keys without adding conflicting tables.

### Reviews and instruction forwarding

- The stop review gate always runs read-only, including in plan mode, regardless of the configured default sandbox.
- Adversarial review lists untracked symlinks without inlining their targets and never reads files outside the repository when collecting untracked contents. Non-ASCII and quoted filenames are handled correctly.
- Review commands accept `--args-stdin`; both foreground and background slash-command recipes use a single-quoted heredoc so focus text is never shell-expanded. Failed native reviews preserve their failure reason in the report and summary.
- Instruction forwarding excludes auto-memory by real path, including indirect aliases through symlinked configuration or memory directories.

### Live pane and hooks

- `codex-live` keeps the live owner's status and pending question visible after a refused follow-up. Unresolved turns are flagged and cannot be cleared; lifetime bookkeeping shrinks with retained history so the pane can keep publishing updates.
- The permission hook single-quotes every validated argument and injected binding while preserving heredoc bodies. SessionStart teaches question-pinned answers, and environment exports no longer join a previous hook's unterminated line.
- Stopping an active native agent from `/tasks` lets the owner stop finish as `interrupted` / `owner_stopped`, with a bounded confirmation wait and a cancel fallback if needed. Explicit `duet cancel` keeps its existing behavior.

### Journal and performance

- Acceptance verdicts can name earlier jobs in `resolves` to close REWORK/REASSIGN handled by a fresh worker; unknown IDs are rejected. Same-thread follow-ups across worktrees record `followUpOf` when the predecessor is discoverable.
- Routine state updates avoid rereading retained output when pruning cannot change membership. Necessary pruning reads reuse unchanged records, non-Git symlink roots need no Git lookup, and retention reuses parsed records across planning and locked revalidation.

### Worker names

- The worker name pool grows from 60 to 240 historical scientists, mathematicians and computing pioneers, so long sessions reach numbered names such as `Tesla-3` far later. Names stay unique within a Claude session and are never reused; the `-2`, `-3` suffix still appears only after every name has been used.

## 1.4.1

Correctness fixes from the 1.4.0 review and release-candidate QA, plus native-agent plan mode, effort and usage support.

**Upgrade or downgrade with no Duet jobs running.** Finish or cancel active jobs before changing versions; mixed-version workers can overwrite shared job state.

### Follow-ups, answers and recovery

- Follow-ups, including `--resume`/`--resume-last`, inherit model, effort, sandbox and speed from started attempts. Refused or never-started attempts cannot replace those settings, and blocked attempts never block the thread or displace its live owner. Symlinked workspaces accept `--cwd .` on continuation.
- Count pruning keeps the newest ended job that actually started a turn for each of the 200 most recent threads (a newer refused attempt no longer displaces it), alongside active/unresolved jobs and the 50 newest ended jobs. Ended thread anchors still expire by age. Missing sandbox settings produce `thread_settings_unknown` until `--sandbox` is explicit; `--continue` allows that exception but does not override a recorded sandbox.
- Browser-origin and Computer Use app request grants are inherited only from their original dispatch in the same Claude session. Runtime-only approvals and foreign dispatches after adoption are excluded; an explicit `--thread` may still inherit runtime settings across sessions.
- Worker names are reserved in the destination session on adoption and cross-session `--thread` follow-ups, with a new name on collision. For 1.3-era duplicate names, command-state preference applies first, then the caller's workspace breaks ties.
- `duet wait|cancel <worker>` select the active or unresolved job after a refused follow-up, and an answer with a question ID still resolves to the original pending job. Every `needs_answer` report's `next` pins `--question`; use it verbatim or pass the displayed ID explicitly. A bare `duet answer <worker>` selects whatever question is pending now, possibly a newer one. Native SendMessage already protects the displayed question and is unchanged by this CLI recipe fix.
- Follow-up admission checks the server for any in-progress turn, including external turns and turns in another workspace, without starting a second turn. A per-thread admission reservation in the isolated home covers the interval from that check until the new turn's handle is saved, so concurrent follow-ups from other connections, brokers, the broker-busy direct fallback or other workspaces are refused with `thread_busy` instead of starting overlapping turns, including while a fresh thread's first turn awaits acceptance or just after its wrapper crashed; a reservation left by a dead process is reclaimed after a 30-second settle window. Known limit: a start request left pending in a broker by a killed worker and accepted more than 30 seconds later can still overlap a concurrent cross-workspace follow-up until the broker ends the orphaned turn. `thread_busy` supplies recovery/cancel commands only when a tracked job owns the turn; refused attempts never replace that owner.
- A dead worker with no thread handle is resolved as failed. Missing turn handles are recovered only from a turn that no other recorded job owns (alive or dead) and that no other handle-less job could have started in the same window; unreadable ownership records or ambiguous history stay unresolved. A missing-handle cancel interrupts only such a uniquely attributed live turn, otherwise it reports `interrupt_unconfirmed` (exit 2).
- A launch interrupted before its job record was written (for example a stop during dispatch) no longer blocks its thread: once its launcher is gone, the reservation resolves as failed with no turn submitted. Started jobs whose record is missing stay unresolved for recovery but are no longer shown as running.
- Unresolved turns survive count and age pruning. Expired dead orphan files that are not unresolved can be cleaned, and stale running index entries without private records are removed when not unresolved. Cleanup deletes only artifacts in the job's own directory; legacy/out-of-directory artifacts are retained for review.
- Stale task-scoped Computer Use grants left by worker death are released at the next start or recovery, and a configuration writer lock left by a killed worker is reclaimed instead of failing later grants. An approval answered after its turn ended cannot leave a lasting task grant.
- Confirmed cancellation before a turn starts also cleans the thread's background terminals, including earlier-turn servers. Cleanup remains bounded and separate from interruption confirmation. Lost start replies are reported as uncertain turn outcomes rather than proof that startup failed.

### Reports and delivery

- `details` always targets the exact job ID, so saved commands still retrieve the same turn after follow-ups. Running recovery/result reports exit 0; compact recovery reports retain available observational commands.
- Compact reports stay within the 2,000-byte envelope excluding summary even with long recovery/cancel commands or many choices. Commands use exact IDs or defer to `--details`; `question.optionsOmitted` counts trimmed choices. Summary truncation preserves Unicode characters, and error blockers cannot coexist with `completed`.
- Report generation and worker-name resolution avoid spawning Git once per recorded job or workspace, for Git and non-Git workspaces alike, and only examine the owning session's jobs. Large homes no longer incur that per-job lookup delay, which could stall the owner wait beyond its five-second grace and interrupt a question with `owner_lost`.
- Simultaneous completion notifications look up reports concurrently. A dropped notification does not consume its delivery marker; when duplicate notifications overlap and the first is dropped, the other can still carry the report. `duet wait --details` output over 100,000 characters still gets its compact report attached.
- Delivery-marker cleanup exempts the current session from the seven-day age pass and caps that session at 2,000 markers; old foreign markers are pruned. SessionEnd attempts every marker deletion even if one fails, with bounded retries.
- Final JSON output survives SIGTERM even with a full pipe or a large details report, without leaving a partial line.

### Native agents

- Plan mode runs workers with `--sandbox read-only`; writable `DUET:` headers are refused (`native_plan_mode_read_only`) without launch. A lost permission binding fails closed (`native_binding_unavailable`) instead of risking writable dispatch.
- Initial-task effort precedence is `DUET: --effort` > explicitly supplied Agent `effort` (including `max`) > companion default; the shell's `effort: low` is ignored. Follow-ups retain thread settings. Agents support foreground and background calls.
- Reports optionally carry integer `usage` counts for the turn (`inputTokens`, `cachedInputTokens`, `outputTokens`, `reasoningOutputTokens`, `totalTokens`) between `keyFindings` and `next`. Decreasing counters invalidate usage rather than emitting misleading counts. Native transcripts show a `Codex usage` notice; these tokens never enter Claude's usage or cost.
- Overlapping native dispatches cannot launch two jobs for one agent. An agent with its binding already available no longer waits for unrelated slow spawns before accepting its brief.
- Definitive pre-launch failures, including invalid headers, unavailable executables, spawn failures and intent-save failures, leave the agent usable for a corrected message. Reconciliation recognizes definitively failed turns and finds retained jobs beyond the 50-entry visible history.
- A displayed question remains answerable if the final state write fails. Late SendMessage replies are pinned to the displayed question; if it changed, the current question is returned. Hook/store failures produce bounded blocked reports or preserve the host event instead of escaping the hook.
- Readiness is announced on the first accepted non-command person prompt after registration (`prompt.submit`), not by SessionStart. codex-live removes a job from the old session after adoption.

### Instruction forwarding and transport

- A valid loaded CLAUDE.md inventory stays authoritative even above the capture budget: omissions are reported without scanning filtered-out files back in. Auto-memory exclusion also holds through symlinked configuration and memory directories.
- The broker preserves the requesting client's callback ownership until its request settles, including after turn completion or disconnect. A completion received before the start reply no longer leaves stale ownership. Requests remain ordered, and a failed side request does not cut off turn notifications.
- Client, broker and parent bridge ignore non-object JSON messages such as `null`; resumed-thread questions containing U+2028/U+2029 remain intact. Abandoned cleanup requests no longer keep an idle broker/runtime alive, and concurrent stale-state cleanup tolerates already-removed files.
- Documentation and help now match pinned answers, grant provenance, retention, recovery and native readiness. Read-only rescue recipes pass `--sandbox read-only` explicitly.

## 1.4.0

- Call Codex like a native subagent: `Agent(subagent_type: "codex:codex-native", prompt: …)` runs the brief on Codex. A plugin hook answers that agent's turns itself, so the agent makes no Claude model requests; the Codex report is the agent's result, SendMessage to the agent continues the same Codex thread or answers a worker question, and stopping the agent from `/tasks` interrupts the job and ends its commands (reported as interrupted; the confirmation is recorded on the job), after which SendMessage continues the agent. Codex's progress streams live inside the agent and is kept in its transcript, which also keeps jobs longer than ten minutes alive under Claude Code's stall watchdog; the first prompt of each session tells Claude the native workers are ready. An optional first prompt line `DUET: <flags>` sets model, effort, sandbox, speed, working directory or `--fork`. This uses Claude Code's early-access function-hook API; if the hooks are unavailable the agent returns a blocked report instead of doing anything.
- `duet` command: the plugin puts `bin/duet` on the Bash PATH, so calls no longer depend on `$CODEX_COMPANION` (when that variable was missing, Node ran the brief as JavaScript). `duet task` is direct mode; `duet task --to <worker>` follows up by worker name; `duet answer|wait|result|cancel <worker>`. Follow-ups inherit the worker's model, effort, sandbox and speed (they used to fall back to defaults, so a read-only reviewer became writable); inheritance by name stays within the current Claude session, and worker names are unique within a session. `node "$CODEX_COMPANION" …` still works.
- Reports arrive with the completion notification: a plugin hook attaches the job's stored report to the background-task notification of the Bash call that dispatched, answered or waited for it, so Claude no longer reads output files.
- No permission prompts for Duet calls: a PreToolUse hook approves a single validated `duet` command, pins it to the plugin's own launcher and adds the session and call identifiers; it steps aside (normal permissions apply) for anything else and in plan mode.
- Compact reports: status, worker, summary, blockers, question, changed files and checks come first (about 350 bytes for a small job instead of about 1.5 KB); `next` is the one command to run and `--details` returns everything. A report that lists blockers can no longer say completed.
- CLAUDE.md for workers: the CLAUDE.md files and rules Claude Code loaded at the start of the session are passed to Codex as developer instructions, framed for a delegated worker, as native subagents receive them; edits made during a session apply from the next one, and a directory scan is used when the loaded list is unavailable. Opt out with `--no-claude-md` or `CODEX_COMPANION_CLAUDE_MD=0`.
- `duet task --fork` runs a brief on a Codex thread imported from the current Claude conversation (labelled "imported Claude conversation"; fidelity not verified; size limit `CODEX_COMPANION_IMPORT_MAX_BYTES`, default 20 MB).
- codex-live shows each turn's prompt (three lines, click to expand) and the answers Claude gave under each worker question. Answers on resumed threads are not shown yet: Codex 0.146.0 passes no call id to Duet's question bridge.
- A connection lost in the middle of a turn no longer blocks its thread: the stored failure is reconciled with the server, `thread_busy` offers `duet cancel <worker>` to resolve a turn that cannot be confirmed, and the error says whether the connection closed during startup or while the turn was running. Likewise, a follow-up after an interrupt whose turn end was never confirmed now gets `thread_busy` with `duet cancel` instead of starting a second turn on a thread that may still be busy.
- Stopping a worker now stops its commands: `duet cancel`, stopping a native agent and owner loss used to interrupt only the Codex turn, while the test run, build or script it had started kept running (Codex's interrupt leaves them). Duet now also ends that thread's background terminals, including servers from earlier turns, and reports `backgroundTerminals` in `duet cancel --json` and `duet result <worker> --details`.
- Codex output containing the Unicode line separators U+2028/U+2029 no longer breaks the connection to the Codex runtime (they were treated as line breaks, cutting a message in half); this caused some "connection closed" failures.
- `/codex:setup` reports whether Claude can invoke Duet and names the exact setting to fix when a pinned Codex runtime is missing.
- Housekeeping: a stray `node_modules` symlink committed in 1.2.1 was removed and is now ignored.

## 1.3.0

- A lost connection no longer turns finished work into a failure: when the connection to Codex drops after a turn started, `status`, `result`, `wait` and follow-up admission read that exact turn once from the server and report its real outcome (completed, or blocked / needs_input with exit 2) with `recovered`, `recoveredAt`, `completedAt` and the original error. A follow-up on a thread whose previous turn is still live becomes a blocked job with a `thread_busy` blocker naming that turn and a status command, instead of a generic "already running" failure; it never starts a second turn.
- One call to answer a question: every direct `needs_answer` payload carries `answerAndWaitCommand` (`answer … --direct`, answer on stdin), which attaches as the owner wait, submits the answer once and keeps waiting like `wait --direct`. The two-call `waitCommand` + `answerCommand` flow still works. Only one live owner wait can attach to a job; a wait that was killed, even with SIGKILL, can be replaced at once with the same owner without interrupting the turn, and `answer --direct` refuses a different owner, a stale question or an attached live wait without submitting.
- `/codex:status` shows a pending question with its choices and remaining time; `/codex:result` starts with the outcome and lists findings, captured verification, unverified claims, assumptions and blockers (blockers keep their codes and identifiers). JSON output and exit codes are unchanged.
- `/tasks` progress lines lead with the outcome: command result with exit code and seconds, plan progress (`plan 2/5 · <current step>`) and edited files with line counts; shell wrappers such as `/bin/zsh -lc` are removed.
- codex-live: a worker that is waiting for an answer or blocked is pinned to the top with its question instead of hiding behind `+N more`; active rows show the current command and how long the worker has been quiet. A newly started worker no longer pulls you away from the conversation you are reading: your selection and scroll position stay, and the new row is marked `• new` until you select it.
- ultra-codex: the 17.5k-character protocol is no longer pasted into every `/codex:ultra-codex` invocation. Control invocations (`on`, `off`, `status`) skip it and task invocations read it once; the per-prompt reminder carries the protocol's version and asks for a re-read only when that version is not in context. The protocol adds guidance for reading several finished workers and recording several verdicts in one call.
- `journal validate` lists workers without a verdict, unresolved rework, negative criterion results and task criteria that no verdict checked; `journal close` with judgment `passed` is refused (exit 2, journal unchanged) until they are resolved. `blocked` and `abandoned` still close and record the open issues.
- Development: `npm run verify` runs the version check, build, runtime tests and codex-live tests in one command, and CI runs the same checks on pull requests and pushes to main with the Codex CLI and Claude Code versions pinned (`.codex-version`, `.claude-code-version`). The runtime suite went from 313 tests (about 4 minutes) to 256 (under 2), and codex-live from 129 to 48, keeping one or two contract tests per feature.

## 1.2.1

- Direct mode no longer interrupts a healthy job when its output is not being read: the owner lease renews on its own timer instead of waiting for progress lines to be written, pending progress is capped at 200 lines with one "… N progress lines omitted" line, and the JSON payload stays the last line. 1.1.0–1.2.0 could interrupt such a job as `owner_lost` after the 5-second owner grace.
- `status --all` now lists jobs from every Claude session in the workspace, labelled by session; plain `status` and `result` say when they are limited to this session and point to `--all`.
- `ultra-codex off` lists `/codex:cancel <jobId>` for each still-running job instead of a companion path that did not exist in user projects.
- `adversarial-review` rejects likely option typos (within two character edits of a supported option, e.g. `--baes`) before starting a review; other dash-prefixed focus words and anything after `--` remain focus text.
- `setup` shows the browser policy new tasks will use, including the default before the first task applies it.

## 1.2.0

- codex-live groups follow-ups: jobs on the same Codex thread (`task --thread`, `task --continue`) now appear as one row, labelled with the turn count, and selecting it shows every turn in order, each under its own header. Status, footer and pending question follow the latest turn; Clear finished, retention and auto-open work per conversation. State stays bounded: at most 20 turns per conversation are kept and the latest 5 show full activity; unchanged polls compose the view once, and a concurrent click or scroll is merged instead of skipped.

- `npm run build` (the TypeScript check that pull-request CI runs) passes again. The fixes are JSDoc annotations only; runtime behaviour is unchanged.

## 1.1.0

- Versioning: Duet now uses its own semantic versions, starting with 1.1.0. Earlier releases were labelled `1.0.6-isolated.N`; those headings below keep their original names.

- Run journal: an orchestrated task can keep a durable journal in the isolated home (`journal start|add|close|show|list`). It records the goal and acceptance criteria, Claude's per-worker verdicts (criterion → evidence → result) and decisions, and the final judgment. Tasks dispatched by the same Claude session link automatically, including tasks in other worktrees: the exact brief and the final compact report are copied into the run, so they survive job-record pruning. After compaction or on resume, `journal show` recovers criteria, verdicts and open items, and SessionStart adds a one-line reminder while a run is open. `cleanup` and automatic retention prune inactive runs. The ultra-codex protocol now records every verdict and decision in the journal.

- `/tasks` progress for direct mode: `task --direct` and `wait --direct` print compact, terminal-sanitized (not credential-redacted), single-line progress (at most 200 characters, never starting with `{`) while they wait, so a running job is visible in Claude Code's `/tasks` view. The JSON payload is unchanged and is still the last line of the helper's output; Claude reads it with `grep '^{' <output file> | tail -n 1` because Claude Code appends its own `[exited with code N]` trailer. A re-wait prints only new events. `--quiet` restores the single-line output.

- README rewritten as a short overview with a hero image, a how-it-works diagram and a codex-live demo rendered by the pane's own layout code from jobs on a small demo repository. Detailed reference moved to `docs/direct-mode.md`, `docs/commands.md`, `docs/configuration.md`, `docs/state-and-retention.md` and `docs/troubleshooting.md`.

## 1.0.6-isolated.20

- Every companion subcommand now has side-effect-free `--help`/`-h`; task help includes direct/parallel/follow-up examples and result handling, unknown options fail with usage (adversarial-review retains free-form focus flags), and SessionStart adds a short dispatch template while preserving environment exports.

- Tasks get random names from 60 historical scientists and computing pioneers, preserved on thread follow-ups and exposed in JSON and session markers; codex-live shows the name and cleaned task summary, and its session-persisted **Clear finished** control hides ended jobs without deleting records or changing retention.

- codex-live: Clear finished records the time it was pressed, so every job that had ended by then stays hidden, including ones outside the 20 kept in view and ones rediscovered later; hidden or unchanged job files are no longer re-read every 10 seconds; each render budgets only the rows it is given. Known limitation: while Claude Code's slash-command suggestions are open they cover the bottom of a docked pane, which the pane cannot detect.

- Mac sleep no longer consumes a running job's owner heartbeat grace or lease: delayed worker ticks shift both timestamps under the state lock, record pause diagnostics, and let the owner resume renewing without reviving cancelled or ended jobs.

- Retention now follows Claude Code’s `cleanupPeriodDays` (default 30, environment override available): detached SessionStart prewarm cleans eligible ended jobs, markers (replacing the former 7-day period), and unreferenced old Codex threads through `thread/delete`, at most every 12 hours. `cleanup [--dry-run] [--days N] [--json]` previews or applies it on demand; active jobs, attached owners and live PIDs are protected.

- Task-workers and shared brokers now leave the calling shell's descendant tree through a short-lived launcher, so stopping a background `task --direct` or `--follow` confirms `owner_stopped` without killing the broker or other jobs. Real worker/broker PIDs and broker logs are preserved; fixture coverage kills the holder's whole descendant tree and checks a parallel job survives.
- Direct mode: Claude runs a Codex job itself, with no Haiku forwarder. `task --direct` starts the same detached job as `--follow`, with the calling process attached as its owner wait, run by Claude as a background Bash call (`run_in_background: true`). It prints no feed and exactly one compact JSON line when the job ends, needs an answer or reaches the wait budget; Claude Code's completion notification wakes Claude, which reads that line. Defaults are `--timeout-sec 3600` and `--lease-sec 1800`. Conflicting flags (`--follow`, `--detached`, `--background`, `--json`, `--feed-limit`, `--min-interval-sec`) are rejected before a job is created.
  - `wait <job> --owner <owner> --direct [--after-question <id>]` gives the same single line.
  - The payload drops the activity list and progress internals (keeping `activityCount`), carries Codex's final `summary` on terminal reports (cut at 8000 characters), and adds ready-to-run handles. `running` carries a `waitCommand`. `needs_answer` carries a `waitCommand` that includes `--after-question`, so a background re-wait keeps the lease alive, plus an `answerCommand`. A non-completed terminal report has a `continuationCommand` ending in `--direct`.
  - A finished report is about 4 KB, roughly what the Haiku worker used to return. The Haiku layer's own context, including feed lines and repeated waits, is gone.
- SessionStart exports `CODEX_COMPANION`, the absolute companion path, to every Bash call of the session.
- Session markers: every task job started in a Claude session writes `<isolated home>/duet/sessions/<session id>/<job id>.json` (0600, atomic), with the job and log paths, title, shortened summary, workspace and creation time. SessionStart prunes marker folders older than 7 days. A marker write failure never fails the task.
- New plugin `codex-live` (`/plugin install codex-live@duet`): a read-only Claude Code pane that shows this session's Codex jobs and the selected job's live activity (Codex messages, commands, file changes, tool calls, plan, a pending question).
  - It opens by itself when a job starts on a terminal at least 144 columns wide; the `codex-live` command opens it at any width.
  - It reads the markers and job files only. It never starts, answers or cancels a job, makes no model calls and costs no Claude tokens.
  - It needs Claude Code 2.1.302's function-hooks pane API.
- Ultra-codex protocol, `/codex:ultra-codex`, `/codex:rescue`, `/codex:status`, README and docs dispatch through direct mode. The brief template, acceptance protocol, phases and mode semantics are unchanged.
- The Haiku `codex-worker` is now a fallback, for a surface without background Bash or when an agent transcript view is wanted. Changes:
  - `effort: low`, `omitClaudeMd: true` and `autoCompactWindow: 100000`.
  - The feed default drops from 150 to 60 lines per call.
  - It returns the helper's JSON line verbatim, plus at most 5 lines of notes.
  - Rework goes to a new worker with `--thread` instead of SendMessage to an old one.
  - The parent never passes it a model or effort.
- Hardening from an adversarial review:
  - An answer accepted just before a question's deadline is delivered, not dropped. This also affected the Haiku path.
  - Direct calls always print one JSON line: `{status:"error", error}` when rejected, and `{status:"owner_stopped", …, continuationCommand}` when the wait is stopped.
  - A clean return is recorded only after the line was delivered; a closed stdout stops the turn as `owner_stopped` instead of crashing.
  - Attaching after lease expiry no longer revives the lease.
  - Direct flag conflicts are read from the raw arguments.
  - Adopting a direct job returns a `--direct` wait command.
  - A direct job counts as orphaned after half its lease, not after 65 s.
  - Direct terminal reports carry Codex's full findings, assumptions and claimed verification (up to 20 entries of 2000 characters).
  - Marker pruning never follows a symlinked `duet`/`sessions` folder, and removes stale files one by one, so a fresh marker survives.
- Activity events for the pane: Codex messages keep their full text (`body`, newlines kept, up to 4000 characters; a final report's summary); plan updates carry step `statuses`; file changes carry `added`/`removed` line counts (never the diff).
- codex-live draws Codex's work the way Claude Code draws its transcript:
  - `⏺` rows, `Bash(…)`/`Update(…)`/`Write(…)`/`server - tool (MCP)` headers and `⎿` result lines;
  - a `Codex(…)` header with state, tool-use count, elapsed time and model;
  - colours from the person's theme;
  - Markdown messages;
  - shell wrappers removed from commands.
- codex-live keeps a fixed layout:
  - Pinned agent list at the top. Active jobs come first. An ended job (done, failed, stopped) stays for 2 minutes, then folds into an expandable `+N more` history. The job being read never folds.
  - A feed the pane scrolls itself, by wheel, arrows, page keys and Home/End.
  - A pinned footer with the live status and Claude Code's spinner.
  - `↓ N new · Jump to bottom` (hotkey `b`) appears once you scroll up.
  - Messages are laid out by the pane (bold, code, lists, fences, tables, links), so every row's height is exact.
- codex-live hardening, from an adversarial review of the pane:
  - State stays bounded: full rows are kept only for the selected job, and a rejected state write is shown in the footer.
  - Active and selected jobs are never evicted.
  - Failed reads are retried with backoff.
  - Ended jobs are re-checked every 10 s.
  - A stale-data warning is pinned in the footer.
  - Statuses: `needs_input` counts as ended; a terminal status wins over a leftover question; queued is shown as Queued.
  - Overlapping identical commands pair first-in, first-out. Cancelled tools read Cancelled; abandoned ones read Interrupted.
  - The view (selection, scroll anchor, expansion) survives `/reload-plugins` without re-opening the pane.
  - Engine-offset padding keeps the pinned rows in place.
  - Emoji widths and grapheme clusters are handled.
  - Resize and content shrink clamp the scroll position, and clock-only updates never count as new lines.
- Fixture coverage: direct payload shapes, conflicts and lease defaults, markers and pruning, the `CODEX_COMPANION` export, the codex-live view model, collapsing, layout and polling, and pane mounts on four surfaces.

## 1.0.6-isolated.19

- Ultra-codex is now a session mode as well as a one-shot command. `/codex:ultra-codex on [--quick|--thorough] [--max-workers <n>]` writes a per-session record (`<isolated home>/duet/state/<workspace>/ultra-codex/<session id>.json`, keyed by the Claude session id from the SessionStart hook); while it exists, a new `UserPromptSubmit` hook (`scripts/ultra-codex-hook.mjs`, ~70 ms) appends a one-line reminder to every prompt telling Claude to read `prompts/ultra-codex-protocol.md` and orchestrate substantive tasks with Codex workers, leaving chat and one-line fixes inline. `off` removes the record, lists the session's still-running Codex jobs and tells Claude the orchestration has ended; `status` reports the mode. SessionEnd, a fresh start and `/clear` clear the mode, `--resume`/compaction keep it, and records older than 30 days are pruned at SessionStart. The hook is silent for other sessions in the same repository, for the command's own prompt, without a session id, and on any error.
- The orchestration protocol moved from the command body to `prompts/ultra-codex-protocol.md` (with a scope clause: the protocol covers one task; "stop"/"work normally"/`off` end it at once). The slash command's preamble runs `ultra-codex status --for-command`, which prints the mode line and the protocol; the task text never passes through a shell, and Claude runs `ultra-codex on|off` via Bash with fixed flags only. New companion subcommand `ultra-codex [on|off|status [--for-command]] [--json]`.
- README, docs and a new `tests/ultra-codex-mode.test.mjs` (on/off/status, validation before writes, reminder content and silence rules, resume/compact/clear/SessionEnd semantics, stale pruning, command preamble shape).

## 1.0.6-isolated.18

- `/codex:ultra-codex` rewritten for cross-model delegation. Ultracode's agents are the orchestrator's own model with its context; Codex workers see only the prompt and the repository, so the command now puts Claude's effort into the two ends of each assignment. Briefs follow a mandatory template (`OBJECTIVE`, `WHY`, `CONTEXT I ALREADY KNOW`, `INTERFACE CONTRACT`, `OWNED PATHS`, `NON-GOALS / DO NOT`, `ACCEPTANCE CRITERIA`, `VERIFY WITH`, `WHEN TO ASK`, `REPORT`) with rules to name the pattern to copy by file:line, state what wrong looks like, and split assignments above about seven criteria. Every report passes one acceptance protocol: status gate, scope check against owned paths with `git diff --stat`, reading the diff for unrequested behaviour changes / weakened tests / new dependencies / stubs / swallowed errors, a criteria walk recording evidence → verdict, a verification audit (`claimedVerification` vs captured `verification`, commands rerun by Claude), an assumptions audit, and an explicit `ACCEPT` / `ACCEPT WITH GLUE` / `REWORK` / `REASSIGN` decision. Drift is treated first as a brief defect; reviewers never see the implementer's summary; task-level acceptance criteria are written before dispatch and organise the final report. A dedicated **Accept** phase sits between Implement and Verify. README and [docs/ultra-codex.md](../../docs/ultra-codex.md) updated; `tests/commands.test.mjs` checks the template sections, protocol steps and verdicts.

## 1.0.6-isolated.17

- Structured worker reports: every `--report` turn now runs with the worker-report output schema (`schemas/worker-report.schema.json`), so Codex's final message is a JSON object with `status` (`completed`/`needs_input`/`blocked`), `summary`, `key_findings`, `assumptions`, `verification`, `blockers` and `question`. The helper stores the summary as the raw output (so `result`, the stop-gate hook and the live feed keep prose; the feed shows the final message as `[status] summary`), keeps the parsed object as `structured` in the result artifact, and builds the report from the declared fields: the declared status (a captured runtime refusal still forces `blocked`; a `completed` whose summary is a plan or a question is reported as `needs_input`), `keyFindings`, `assumptions`, new `claimedVerification` (distinct from the captured `verification` command events), `blockers` (captured first, then declared) and `question`. `reportFormat: "structured"` marks such a report; prose final messages are still inferred as before. Verified live: progress commentary is unaffected by the schema and the final message parses. Plain `task` without `--report` is unchanged.
- Approvals forwarded to the parent: owned jobs (`--detached`, `--background`, `--follow`) start threads and turns with the granular policy `{ granular: { mcp_elicitations: true, rules: false, sandbox_approval: false, request_permissions: false, skill_approval: false } }`, reported as `approvalPolicy: "never+elicitations"`. Command, sandbox, rule, skill and permission prompts are rejected as before; a Computer Use app request that no `--approve-computer-app` flag covers now reaches the helper and becomes a pending question (`question.kind: "approval"`, id `approval-…`) with the fixed options `Allow this call`, `Allow for this task`, `Allow always (isolated Codex home)`, `Deny`. The parent's answer is applied and the elicitation is accepted with a non-persisting `{ action: "accept" }` or cancelled: "this task" writes the thread's `computer-use/sessions/<thread>.toml` for the rest of the turn (withdrawn afterwards), "always" adds an explicit entry to the isolated home's allow list, deny/timeout/unrecognised answers cancel and the turn is `blocked` with `computer_use_app_not_approved`. `~/.codex` is never written. A plain foreground `task` keeps `never` and fails closed at once. Verified live on codex-cli 0.162 with TextEdit: request forwarded, answered, tool call completed, session file removed.
- Project instructions for Codex: before every task the helper sets Codex's own `project_doc_fallback_filenames = ["CLAUDE.md"]` in the isolated home's `config.toml` (once, with a private backup), so workers read the project's `CLAUDE.md` wherever an `AGENTS.md` is missing, under Codex's discovery rules and `project_doc_max_bytes`. `setup --project-docs claude-md|agents-only` (saved as `project_docs` in `duet/config.toml`) switches it; a hand-written list is reported as `custom` and left alone; `setup --json` reports `projectDocs`. Verified live: a worker answered the codename from a `CLAUDE.md`-only project.
- `/codex:ultra-codex [--quick|--thorough] [--max-workers <n>] <task>`: Claude orchestrates a substantive task Ultracode-style with Codex workers (scout → understand → design → implement → verify → integrate; disjoint ownership or `isolation: "worktree"`; adversarial review looped until dry; Claude runs the checks and reports observed verification separately from Codex claims). [docs/ultra-codex.md](../../docs/ultra-codex.md) records how Ultracode's Workflow tool works and how the command maps onto it; using the Workflow tool with `agentType: "codex:codex-worker"` is noted as unverified.
- Worker contract, `/codex:setup`, `/codex:status`, `/codex:result`, README, worker operations and Computer Use documents updated. Fixture coverage: the schema on `turn/start` and its absence without `--report`, structured completed/blocked/needs_input reports and the plan-only cross-check, fenced-JSON parsing, the granular policy on `thread/start` and `turn/start`, all four approval answers with session-file lifecycle and isolated-only always-grants, unchanged `~/.codex` hashes, the foreground fail-closed path, and the project-docs key lifecycle (default, agents-only, custom, idempotency, backup, pre-task application).

## 1.0.6-isolated.16

- Computer Use app approvals follow the user's own Codex app. Findings: node_repl persists "Always" approvals in `$CODEX_HOME/computer-use/config.toml` and "This session" approvals in `computer-use/sessions/<thread>.toml` (`[apps] allowed/denied`, parsed with `toml_edit`); the isolated runtime reads `~/.claude/codex-isolated/computer-use/`, and under `approvalPolicy: never` the elicitation is resolved inside Codex, so a worker cannot answer it at run time. Before every task Duet now mirrors the apps from the user's global `[apps] allowed` list (read-only on `~/.codex`; never session-level, denied or policy-blocked apps) into the isolated file, with validation, a private backup, atomic write and no write when nothing changed (`computer_use_approval = "mirror"`, the default).
- Setup switches, beside `browser_approval` in `<isolated home>/duet/config.toml`: `setup --computer-use-approval mirror|ask` (`ask` stops the sync and removes mirrored entries), `--allow-computer-app <bundle id>` (also in ask mode), `--revoke-computer-app <bundle id>` (removed and kept out of later mirrors), `--list-computer-apps` (read-only), with `--dry-run` and `--json` (`computerUse: { preference, allowed[{app, source}], revoked, codexApp, changedFiles, backups }`). `setup --json` includes the summary without writing. Bundle identifiers are validated before any write and never echoed. Workers never run setup.
- Per-call approval: `task --approve-computer-app <bundle id>` (repeatable) grants only the listed apps to the job's own thread while the turn runs (`computer-use/sessions/<thread>.toml`, restored afterwards) and, on runtimes that forward the Computer Use elicitation, accepts it only for an exact bundle-id match on the current turn with a non-persisting `{ action: "accept" }`. `--thread` follow-ups do not inherit; `--continue` inherits and rejects the flag. The job, `status`, `result` and reports show `approvedComputerApps`.
- Honest blocking: a new report status `blocked` (exit 2) with structured `blockers` (`{ code, app | tabId, sessionId, closed, message }`): `computer_use_app_not_approved`, `computer_use_app_blocked_by_policy`, `computer_use_app_forbidden`, `browser_tab_debugger_unattached`, `stale_browser_tab_claim`, `reported_blocked` (a final answer starting with "Blocked" or stating `status: blocked`), `needs_input`, `error`. Blockers are captured from declined elicitations and completed `mcpToolCall` results during the turn (identifiers only, no payloads) and from the final answer; `blockersOmitted` counts entries dropped by the 60-line budget. A stale tab claim is now `blocked` instead of `needs_input`.
- Worker contract: `Debugger unattached` means discard the binding, re-obtain the tab by id and close it, otherwise report tab id, session and that it could not be closed; Computer Use refusals are blockers, never retried into success. README, `/codex:setup`, `/codex:status`, `/codex:result`, worker operations and a new [Computer Use approvals](../../docs/computer-use-approvals.md) document describe the behaviour; fixture tests cover mirror/ask/allow/revoke/list/dry-run, unchanged `~/.codex` hashes, the per-call session file seen by the fake runtime, accepted and cancelled elicitations, and tool-result refusals.

## 1.0.6-isolated.15

- One state location: job records, logs and artifacts now live in the isolated home at `<isolated-home>/duet/state/<workspace>/` (`~/.claude/codex-isolated/duet/state/…` by default), beside `duet/config.toml`; directories are `0700`. The location follows only `CODEX_COMPANION_HOME`, so a terminal, a Claude session and the SessionEnd hook see the same jobs; `CLAUDE_PLUGIN_DATA` (whose value changed with the plugin ID) and `$TMPDIR` no longer decide it. The parent bridge passes `CODEX_COMPANION_HOME` instead of `CLAUDE_PLUGIN_DATA`.
- Automatic, idempotent migration: the first command touching a workspace merges `~/.claude/plugins/data/codex-codex-isolated-local/state`, `~/.claude/plugins/data/codex-duet/state`, `CLAUDE_PLUGIN_DATA/state` and `$TMPDIR/codex-companion-isolated` (whichever exist) into the new directory under its lock, once, with a `.legacy-migration.json` marker. Existing jobs are never overwritten (newer `updatedAt` wins), the index is deduplicated by id, recorded absolute artifact paths stay readable in place, legacy directories are not deleted or rewritten, a busy legacy lock is retried later, and concurrent first commands migrate once. A legacy job whose worker is still alive is served in place (listed, `wait`-able, `cancel`/SessionEnd reach its record) and merged when that worker exits.
- Fallback by reference: `status`, `result`, `wait`, `adopt`, `cancel` and `task --continue` with a job id, id prefix or thread id unknown to the new directory search the legacy directories and import the match. Record format, owner/lease semantics and output fields are unchanged.
- Reports show what ran: `task --json`, `wait --report` and `result --report` include `model`, `effort` and `serviceTier` as the runtime reported them (thread start/resume response, per-call flags first; the request's values when the runtime reported none). Touched-file, pre-existing-change and verification lists are trimmed slightly to keep the 60-line budget.
- Fixture coverage: legacy plugin-data jobs found by `status`/`result`/`task --continue`/`adopt`, the same jobs with and without `CLAUDE_PLUGIN_DATA`, merge of every legacy root with newer-wins and idempotency, concurrent first starts, a live legacy worker served in place through `wait`/`cancel`/SessionEnd and merged afterwards, late-written legacy jobs found by id and thread. README and docs describe the new location and the migration.

## 1.0.6-isolated.14

- Browser unrestricted by default, like the user's own Codex app: before every task the plugin mirrors top-level `approval_mode = "never_ask"` into the isolated `browser/config.toml` when the key is absent (`ensureBrowserApproval`), so workers open any website without per-origin prompts and no `--approve-browser-origin` flag is needed. `setup --browser-approval never-ask|ask` now also records the choice as `browser_approval` in `<isolated home>/duet/config.toml`; after `ask`, later tasks leave the key absent. A hand-edited custom value is never overwritten. Setup JSON adds `browserOrigins.preference`.
- The sandbox limits writes, never the network: a narrowed `--sandbox read-only` or `workspace-write` turn is sent with `networkAccess: true`, so web research, package installs and browser work never wait on an egress approval (verified live: `curl` succeeds under `--sandbox read-only`).
- Worker contract, `/codex:setup`, README and docs updated; fixture coverage for the default mirroring, the saved `ask` preference, custom values and network access on narrowed turns.

## 1.0.6-isolated.13

- Permissions like a native subagent's: the built-in sandbox default is now `danger-full-access` (the same level as the user's own Codex app in full-access mode, approval policy `never`). `setup --default-sandbox read-only|workspace-write` lowers it; the parent narrows or widens one call with `task --sandbox <mode>` alone. `--write` remains a floor (at least workspace-write) and `--write=false` an explicit read-only request; the "write-capable `--sandbox` requires `--write`" rule is gone. The sandbox now always reaches the turn policy too.
- Live view inside the agent: the worker's single call is `task --fresh --follow --report` (feed mode). It streams one line per Codex event (commands, file changes, tool calls, assistant snippets) while running, so opening the `codex-worker` agent in Claude Code shows Codex working live, and ends with the JSON line. New `--feed-limit <n>` (default 150, `0` = unlimited) bounds how many lines one call streams, because each line also enters the worker's context; later events are counted in the final JSON.
- Stops are immediate: an owner wait that can mark its exit (signal, parent shell gone, closed stdout) now makes the task-worker interrupt the turn at its next tick (`interruptionReason: owner_stopped`). Only a silently dead owner (SIGKILL, crash) waits for the heartbeat grace, lowered from 15 s to 5 s (`owner_lost`).
- Worker contract, `/codex:status`, `/codex:setup`, README and docs updated for the new defaults.

## 1.0.6-isolated.12

- Removed credential redaction heuristics from activity snippets, question messages and worker reports: they blanked ordinary `NAME=value` text such as `ANSWER=Yes`. Only ANSI escapes and control/bidi characters are still stripped so lines stay single-line and terminal-safe.

## 1.0.6-isolated.11

- Stop spending Claude quota on polling: the `codex-worker` agent runs on Haiku and makes ONE blocking `task --follow --json --report` call (Bash `timeout: 600000`) that returns only on completion, a parent question, or the 570 s wait budget; further waits are one call per 9.5 minutes. `wait` defaults to `--timeout-sec 570` (max 3600), returns early on activity only with an explicit `--min-interval-sec`, and reports at most the 12 newest activity events plus `activityCount`/`activityOmitted`.
- Make stops take effect: an attached owner wait heartbeats once a second and marks signal/parent-exit/closed-pipe detaches; the task-worker interrupts the turn with `owner_lost` after a 15 s grace (`CODEX_COMPANION_OWNER_GRACE_SEC`) instead of waiting for the 180 s lease. A clean return still falls back to the lease.
- Resume stopped workers: every interrupted/failed report carries `task --continue <jobId> --cwd <cwd> --follow --report --json`, which starts one new turn on the same thread with the job's recorded sandbox/write, model, effort, speed and approved origins (rejects inherited flags and active jobs; records `request.continuedFrom`). `/codex:status` and the worker contract route continuation through a new worker with user consent.
- `ask_parent` on resumed threads: `thread/resume` carries a per-thread `config.mcp_servers.duet_parent` override pointing at the new stdio `parent-bridge-mcp.mjs`, which blocks on the same job-file question flow as the in-process dynamic tool (shared `askParentQuestion`). The bridge is bound to the thread (the broker keeps it alive across jobs) and resolves the active job per call. Live round-trips against the real app-server showed two required details: `omit_tools_from = ["code_mode", "deferred"]` (otherwise the model never sees the tool) and an approval-free call (`readOnlyHint` plus `approval_mode = "approve"`, otherwise `approvalPolicy: never` fails it). One registration-free fallback on rejection.
- `--write` is a floor: it guarantees workspace-write and keeps a configured danger-full-access default; the worker contract passes `--write` for edits again. `setup --default-sandbox` always lives in `<isolated-home>/duet/config.toml`, so terminal and Claude sessions read the same default.
- Fixture coverage for default blocking wait and activity cap, owner loss by SIGKILL, signal detach plus re-attach, `--follow`, `--continue` (inherited authorization, bridge env, rejections) and the bridge MCP round-trip; docs updated for the single-call worker, owner loss and continuation.

## 1.0.6-isolated.10

- Add opt-in `setup --sync-tools --profile codex-app`: mirror the newest resolved unified-computer-use cache template (or `--cua-template`), rewriting only home/trust-home fields. Preserve desktop/Sky, Chrome/IAB/MCP Apps, instructions, tool visibility/output limits and template timeouts without injecting a short tool timeout. Keep Chrome-only sync as the default profile; reject unknown/credential-bearing template fields.
- Preview changed CUA fields safely and refuse replacement without `--replace-cua`. Replace the whole server and subtables with the existing backup/atomic-write protections; report resulting surfaces/backends.
- Persist plugin-wide `setup --default-sandbox read-only|workspace-write|danger-full-access`. Tasks without per-call flags use the setting; write-capable defaults imply write. Explicit flags win, reviews stay read-only, and workers rely on the configured default without self-elevating after a denial.
- Add `setup --browser-approval never-ask|ask` to merge/remove only top-level browser approval_mode, with offline dry-run and private backups. Preserve download/upload/history settings, origin lists and session files. Expose browser approval and sandbox defaults in setup JSON.
- Document the independent opt-ins, full disk/desktop/logged-in-browser security implications, rollback and restart requirements. Add fake-template and fake-runtime coverage for mirroring, discovery, replacement/refusal, default persistence/precedence and browser merge/removal; no live home or desktop/browser changes are required by tests.

## 1.0.6-isolated.9

- Narrow env-style redaction to uppercase assignments (case-sensitive) so ordinary flags such as `--effort=xhigh` stay readable in the feed; keyword-named keys/tokens/passwords/secrets/credentials remain redacted case-insensitively.
- Stream redacted activity into native worker Bash output: assistant snippets, command lines/exits/durations, file changes, tool names/status/durations and plan titles. Wait returns on activity after a default 10-second minimum, with a 30-second maximum, per-owner persistent cursors, and one final JSON line; `--json` stays pure JSON. Tool arguments, command outputs and page payloads are excluded.
- Generate unique per-job owners and retain Claude session identity separately. Only explicit matching owners renew unexpired leases; parent status/result and ownerless waits never renew. Keep legacy session-ID-owned jobs readable and SessionEnd-scoped.
- Restrict worker SendMessage to the exact companion-provided questionMessage for needs_answer. Final results use the agent return value; progress/completion claims and placeholder evidence are forbidden.
- Adopt a stopped worker's running job from a replacement worker: atomically rotate ownership and renew the lease without starting another turn; retired owners report ownership_moved. Claude Code stopped agents cannot resume, so launching a replacement requires explicit user consent. Expired/ended jobs report an unexecuted task --thread continuation command. Status shows stale owners as orphaned with remaining lease seconds and the exact adopt instruction.
- Add fake app-server coverage for streaming/early return, independent cursors, redaction and excluded payloads, per-job renewal, adoption/expiry and retired-owner rejection, legacy records and question formatting. Document parent live acceptance and the inferred orphan threshold.

## 1.0.6-isolated.8

- Rename the marketplace to `duet`; the install ID becomes `codex@duet`. The plugin name, `/codex:*` commands and `codex:codex-worker` agent are unchanged. README documents the upgrade path and plugin-data migration.

## 1.0.6-isolated.7

- Run native workers as one detached task with owner-renewed leases and bounded `wait` progress snapshots. Show startup phases, safe item summaries and WebSocket retry warnings in logs and reports.
- Register experimental `ask_parent` for same-turn questions, add stdin `answer`, and route native Agent questions to `main` with SendMessage. Bound unanswered questions to 15 minutes; retain final `needs_input` when registration is unavailable.
- Interrupt on cancellation, lease expiry, session end and worker signals; distinguish confirmed turn completion from unconfirmed cancellation. Prewarm the shared broker without blocking SessionStart, exit idle brokers and reap owned app-server process groups.
- Harden fixture isolation with temporary homes/data, real-home/executable guards, a spawned-process ledger and teardown survivor assertions. Explain the inherited-environment path behind the archived baseline leak.
- Add explicit, backed-up, idempotent `setup --transport http|websocket|status` without changing defaults. Add official browser allow/revoke/list setup, preserving unrelated TOML and removing exact stale per-thread denies when granting consent.
- Return nonpersistent MCP elicitation cancel instead of unsupported errors; document installed browser-service decline/cancel persistence and schema evidence. Keep per-task network-origin grants separate from durable browser consent.
- Add fixture coverage for progress, questions, timeouts, interruption, session cleanup, broker idle exit, home guards and setup merges. Live model/browser acceptance remains a separate parent check.

## 1.0.6-isolated.6

- Require fresh session-owned browser tabs and cleanup; classify full-UUID stale tab claims as distinct blockers with the owning session ID.
- Add repeatable, strictly validated `task --approve-browser-origin` grants with per-invocation persistence/reporting and no follow-up inheritance. Approve only schema-defined, current-turn, network-only requests with an exact normalized origin; retain unsupported replies for broader requests.
- Log safe server-request summaries and denial reasons through direct and broker transports; route broker replies only from the owning client. Add fixture coverage for policy, parsing, persistence, reset, redaction and report limits.
- Document generated protocol evidence and the blocked live probe. Opaque CUA MCP origin elicitations remain unsupported pending an observed request shape; do not treat the new flag as a verified fix for that path. Keep this unpromoted staging iteration at isolated.6.

- Build missing Chrome-only `cua_repl` and env tables from installed bundled templates and validated ChatGPT resources, with strict setting/value allowlists and isolated home/trust paths. Preserve existing CUA and node_repl sections.
- Add `setup --sync-tools --cua-template <file> --chatgpt-resources <dir>` selectors, exact append-only dry-run output, fail-before-write resource checks, and CUA configuration availability. Retain timestamped private backups, locking and concurrent-edit checks.
- Add fixture-only coverage for CUA discovery, path reconstruction, secret rejection, missing assets, idempotence, CLI validation and inline-table conflicts.
- Trace the recorded pre-tool delay to WebSocket prewarm/connection retries before HTTP fallback; document an isolated provider transport workaround and its trade-offs without changing user settings or task model/effort defaults.

## 1.0.6-isolated.5

- Fix status mislabeling a saved shared runtime as direct startup when the inherited endpoint variable is empty.
- Make broker tests skip explicitly only when a socket bind probe is denied; require an actual broker when sockets are available, and add a socket-free runtime-label regression test.
- Track task edits with before/after content, mode and index hashes in dirty workspaces, merge turn file-change events, and report pre-existing changes and coverage separately. Interrupted recovery conservatively uses exact-turn events.
- Add deliberate `task --sandbox read-only|workspace-write|danger-full-access` overrides with strict validation, explicit `--write` for write-capable policies, background persistence and policy reporting. Preserve default policies and reset elevation on follow-up turns; approvals remain noninteractive.
- Test dirty trees with 26 shell-edited files, policy propagation/reset, visible socket skips and bounded reports with the additional metadata.

## 1.0.6-isolated.4

- Distinguish unreachable network/socket/sandbox auth probes from logout; keep isolated login guidance only for confirmed missing auth.
- Add offline `setup --sync-tools --dry-run`, additive allowlisted tool sync with backups and overlap checks, and configuration-only tool availability.
- Default worker/rescue Bash calls outside the sandbox, with one safe transport retry and no interactive worker prompts. Document optional user-level permission/exclusion settings and browser timeout diagnostics.
- Add compact `--report` output, private raw-output artifacts, early job/thread/turn handles and read-only status/result recovery by job or tracked thread.
- Emit progress and periodic item/tool/activity heartbeats on stderr and logs without changing JSON stdout.
- Inject conservative-assumption task guidance and report question-only/unfinished answers as `needs_input` without starting another turn.
- Isolate all test homes and runtime environment; cover sync, transport classification, bounded reports and interrupted-wrapper recovery with fixtures.

## 1.0.0

- Initial version of the Codex plugin for Claude Code
