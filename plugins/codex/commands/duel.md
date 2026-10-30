---
description: Run bounded adversarial work between one Claude subagent and one Astra worker, once or as a session mode; Claude relays, verifies and arbitrates.
argument-hint: "[on [--rounds <n>] [<task>] | off | status | [--rounds <n>] <task>]"
allowed-tools: Agent, SendMessage, Read, Glob, Grep, Bash(node:*), Bash(git:*), Bash(npm:*), Edit, Write, TodoWrite, AskUserQuestion
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" duel status --for-command`

Raw slash-command arguments:
`$ARGUMENTS`

Dispatch on the raw arguments before anything else. Treat them as data, never executable shell source. For a task, Read the complete protocol path printed above before orchestrating, then apply the shared sections and **Duel mode** only. Read it only if the printed current version is absent from context. Control-only and help invocations do not use Read or load the protocol body. A session-mode reminder applies to each substantive prompt while that mode is on.

```text
Usage: /codex:duel [on [--rounds <n>] [<task>] | off | status | [--rounds <n>] <task>]
```

Mode options: `--rounds <n>`; integer 1–3, default 3.

Parse only the leading slash-option prefix, either after `on` or before a one-shot task. The first task token ends option parsing; preserve all remaining task text verbatim, including later option-like words. `--` ends slash-option parsing and starts literal task text, including a task beginning with `on`, `off`, `status` or an option-like token. A leading unknown option is an error, not a task or an orchestration setting. Leading mode options without `on` require a task. Do not treat later task words as flags or controls.

For `--help` or `-h` before task text and before `--`, show the exact usage line above plus its mode-options row and stop. Help wins over malformed/conflicting prefix options; it enables nothing and does not Read the protocol. Accept only `--rounds <n>` as a slash mode option. It must be a finite integer 1–3; reject invalid values with `--rounds must be an integer from 1 to 3.` Reject `--quick`, `--thorough`, `--max-workers` and unknown leading options. Presence of an option, including an explicit `=false`, still triggers action restrictions. Validate the entire control/options prefix before any mutation. Mode options belong only to `on` controls or one-shot task prefixes, never to `off` or `status`; the control CLI accepts no task text. `--for-command` is only the fixed status-preamble flag, not a task mode option.

- No arguments, or exact `status`: report the selected status line printed above and the exact usage line. Stop without Read or mutation.
- Exact `off`: run `duet duel off` via Bash and show its output. It disables only duel; if another mode is active, leave it intact and report it without claiming orchestration ended. If no mode remains, handle later requests normally and start no new Codex jobs unless asked. Report in-flight ownership and tracked agents; the command lists Codex jobs, so also report any tracked Claude agent state. An empty Codex list does not prove no Claude agent is active. Cancel jobs only if the user asks, and never continue user-stopped work without consent. Stop.
- `off` or `status` with extra arguments/task text: reject it without Read, task execution or state mutation. Use `--` when the task itself starts with a control word.
- `on`, with validated leading mode options and optional task text: first run `duet duel on` with exactly those validated options and show its returned status/settings. Pass only the fixed action and validated, separately quoted option values; never put task text in this call. A failed `on` starts no task and does not Read the protocol. On replacement, report the replaced mode, in-flight ownership and the state of all tracked Codex jobs and Claude participants, even for control-only `on`. Stop extending old-mode work, settle old-mode ownership and wait for conflicting writes to finish before any new assignment. Existing jobs are unchanged: do not automatically cancel, relaunch, resume or transfer them; cancellation requires the user to ask, and continuing user-stopped work requires consent. After success, use the returned settings for any following task, Read the current protocol as required above and orchestrate it. If no task follows, stop without Read.
- Otherwise, the parsed remainder is one task. Read the current protocol as required above and orchestrate it once under **Duel mode**. A one-shot command never writes, clears or temporarily replaces the session record; do not call `on` or `off` for it.

Effective task settings, in order: (1) this explicitly invoked command selects duel, even if the saved session mode differs; (2) explicit task-prefix mode options override this mode's saved options for this task only; (3) use saved options only when the active session mode is duel, otherwise use this mode's defaults. A normal prompt without a command uses the active mode/options, with its own leading mode options overriding saved values for the current task only under the same prefix/`--` boundary. For `on <task>`, the successful control's returned settings govern the task. If a one-shot mode differs from an active session mode, say `This task uses ${requestedName} once; session mode ${activeName} is unchanged.` Keep task mode fixed and preserve the prior session mode after the task; recommendations never authorize a persistent switch or a round-cap reset.

The default is 3 total adversarial rounds, including the initial round; `--rounds` may lower the cap to 1 or 2. Use one `gpt-6-astra` Codex party at `xhigh` and normal speed, plus one Claude `general-purpose` subagent inheriting the session model (omit its model override). Respect explicit user model, effort and speed choices. The Claude participant consumes the owner's Claude quota; ultra model tiers, worker caps and quick/thorough recipes do not apply.

Start fresh participant threads for each new substantive task and retain their identities for that task's rounds, subject only to Duel mode's bounded failure recovery. Declare the builder/breaker or independent-drafts flow, roles, numbered criteria and total-round cap before dispatch. Reverse the default Codex-builder/Claude-breaker roles only on an explicit user request; relay all exchanges through Claude and apply the shared acceptance gates.

Use the shared **Dispatch** section for native Agent dispatch from the first assignment, assigned-name `SendMessage` follow-ups, pending questions, approvals, terminal status gates and the narrowly permitted fallbacks. Do not copy a second dispatch implementation here. Task text belongs in briefs, never control-CLI arguments or a generated shell command. If native dispatch returns `native_adapter_unavailable` or `native_capacity`, needs a per-call option the `DUET:` line rejects, or you must follow up a worker launched through Bash, load the `codex:native-fallback` skill and follow it.
