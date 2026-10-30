---
description: Complete a bounded task with one persistent Astra executor, once or as a session mode; Claude plans and accepts every diff, with at most two rework rounds.
argument-hint: "[on [<task>] | off | status | <task>]"
allowed-tools: Agent, SendMessage, Read, Glob, Grep, Bash(node:*), Bash(git:*), Bash(npm:*), Edit, Write, TodoWrite, AskUserQuestion
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" pair status --for-command`

Raw slash-command arguments:
`$ARGUMENTS`

Dispatch on the raw arguments before anything else. Treat them as data, never executable shell source. For a task, Read the complete protocol path printed above before orchestrating, then apply the shared sections and **Pair mode** only. Read it only if the printed current version is absent from context. Control-only and help invocations do not use Read or load the protocol body. A session-mode reminder applies to each substantive prompt while that mode is on.

```text
Usage: /codex:pair [on [<task>] | off | status | <task>]
```

Mode options: None.

Parse only the leading slash-option prefix, either after `on` or before a one-shot task. The first task token ends option parsing; preserve all remaining task text verbatim, including later option-like words. `--` ends slash-option parsing and starts literal task text, including a task beginning with `on`, `off`, `status` or an option-like token. A leading unknown option is an error, not a task or an orchestration setting. Leading mode options without `on` require a task. Do not treat later task words as flags or controls.

For `--help` or `-h` before task text and before `--`, show the exact usage line above plus its mode-options row and stop. Help wins over malformed/conflicting prefix options; it enables nothing and does not Read the protocol. Pair has no slash mode options. Reject `--quick`, `--thorough`, `--max-workers`, `--rounds` and every other unknown leading option. Presence, including an explicit `=false`, is still an option and cannot bypass validation. Validate the entire control/options prefix before any mutation. Mode options belong only to `on` controls or one-shot task prefixes, never to `off` or `status`; the control CLI accepts no task text. `--for-command` is only the fixed status-preamble flag, not a task mode option.

- No arguments, or exact `status`: report the selected status line printed above and the exact usage line. Stop without Read or mutation.
- Exact `off`: run `duet pair off` via Bash and show its output. It disables only pair; if another mode is active, leave it intact and report it without claiming orchestration ended. If no mode remains, handle later requests normally and start no new Codex jobs unless asked. Report in-flight ownership and tracked agents; the command lists Codex jobs, so also report any tracked Claude agent state. An empty Codex list does not prove no Claude agent is active. Cancel jobs only if the user asks, and never continue user-stopped work without consent. Stop.
- `off` or `status` with extra arguments/task text: reject it without Read, task execution or state mutation. Use `--` when the task itself starts with a control word.
- `on`, with validated leading mode options and optional task text: first run `duet pair on` with exactly those validated options and show its returned status/settings. Pass only the fixed action and validated, separately quoted option values; never put task text in this call. A failed `on` starts no task and does not Read the protocol. On replacement, report the replaced mode, in-flight ownership and the state of all tracked Codex jobs and Claude participants, even for control-only `on`. Stop extending old-mode work, settle old-mode ownership and wait for conflicting writes to finish before any new assignment. Existing jobs are unchanged: do not automatically cancel, relaunch, resume or transfer them; cancellation requires the user to ask, and continuing user-stopped work requires consent. After success, use the returned settings for any following task, Read the current protocol as required above and orchestrate it. If no task follows, stop without Read.
- Otherwise, the parsed remainder is one task. Read the current protocol as required above and orchestrate it once under **Pair mode**. A one-shot command never writes, clears or temporarily replaces the session record; do not call `on` or `off` for it.

Effective task settings, in order: (1) this explicitly invoked command selects pair, even if the saved session mode differs; (2) explicit task-prefix mode options override this mode's saved options for this task only; (3) use saved options only when the active session mode is pair, otherwise use this mode's defaults. A normal prompt without a command uses the active mode/options, with its own leading mode options overriding saved values for the current task only under the same prefix/`--` boundary. For `on <task>`, the successful control's returned settings govern the task. If a one-shot mode differs from an active session mode, say `This task uses ${requestedName} once; session mode ${activeName} is unchanged.` Keep task mode fixed and preserve the prior session mode after the task; recommendations never authorize a persistent switch or a round-cap reset.

Pair has no mode tuning options: one primary executor on the configured worker model (default `gpt-6-astra`) and worker effort (default `xhigh`) at normal speed, at most two rework rounds after the initial result, and an optional sequential read-only verifier as specified in Pair mode. The mode reminder and status name the effective model and effort. Explicit user choices override saved defaults from `duet setup --default-model <model> --default-effort <effort>`, then built-ins; preserve explicit speed choices. Ultra model tiers and fan-out do not apply.

Start a fresh primary Codex thread for a new substantive task and retain its identity for that task's rework. Claude supplies the full implementer brief, reads every diff and reruns checks itself. Recommend ultra for breadth or duel for contested/high-risk work; do not switch without explicit authorization.

Use the shared **Dispatch** section for native Agent dispatch from the first assignment, assigned-name `SendMessage` follow-ups, pending questions, approvals, terminal status gates and the narrowly permitted fallbacks. Do not copy a second dispatch implementation here. Task text belongs in briefs, never control-CLI arguments or a generated shell command. If native dispatch returns `native_adapter_unavailable` or `native_capacity`, needs a per-call option the `DUET:` line rejects, or you must follow up a worker launched through Bash, load the `codex:native-fallback` skill and follow it.
