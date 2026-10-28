---
description: Orchestrate substantive tasks with parallel Codex workers, once or as a session mode (on/off). Claude's effort goes into precise briefs and strict acceptance; Codex does the investigation, implementation and review.
argument-hint: "[on [--quick|--thorough] [--max-workers <n>] | off | status | <what to accomplish>]"
allowed-tools: Agent, Read, Glob, Grep, Bash(node:*), Bash(git:*), Bash(npm:*), Edit, Write, TodoWrite, AskUserQuestion
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" ultra-codex status --for-command`

Raw slash-command arguments:
`$ARGUMENTS`

Dispatch on the arguments before anything else. For a task (including `on` with task text), use Read on the protocol path printed above before orchestrating. Control-only invocations do not read it. The mode switch is a per-session setting (like `/effort ultracode`): while it is on, every prompt carries a one-line versioned reminder and each substantive task applies that protocol without typing this command again.

Use `Agent(subagent_type: "codex:codex-native", prompt: "<brief>")` by default from the first dispatch; the plugin assigns a scientist name, replacing a passed label unless it is a free pool name. The assigned name appears in the Agent result; use it for SendMessage follow-ups. Use background `duet task` only when the native agent returns `native_adapter_unavailable` or `native_capacity`, a per-call option is rejected by the `DUET:` line (`--run`, `--approve-browser-origin`, `--approve-computer-app`, `--lease-sec`, `--question-timeout-sec`), or following up a worker launched through Bash. For that fallback, use Bash `run_in_background: true` with the brief on stdin through `<<'DUET_TASK'`. The report arrives with the completion notification; only if missing, run `duet result <worker>`. Follow up with SendMessage to the native agent, or `duet task --to <worker>` and a new brief. Native answers use SendMessage, which already pins the displayed question. For Bash answers use the report's `next` verbatim, or `duet answer <worker> --question '<questionId>'` with the displayed ID via `<<'DUET_ANSWER'` in background Bash. A bare `duet answer <worker>` can answer a newer pending question. Use `duet result <worker> --details` for full evidence and handles; never parse output files or run two waits. Follow the protocol you read. The Haiku `codex:codex-worker` is only a fallback when neither native dispatch nor background Bash is available, or the user asks for a forwarding-agent transcript; put Codex's model/effort in its assignment, not the Agent fields.

- Exactly `off`: run `duet ultra-codex off` with Bash and show its output to the user. It lists this session's Codex jobs that are still running; cancel them only if the user asks. The orchestration has ended: from here on handle requests normally and start no new Codex jobs or fallback workers unless asked. Stop.
- `on`, optionally followed by `--quick` or `--thorough` and `--max-workers <n>`: run `duet ultra-codex on` with exactly those flags via Bash and show its output. If task text follows the flags, orchestrate that task now under the protocol you read; otherwise stop.
- `status` or no arguments: report the mode line printed above and this usage. Stop.
- Anything else: the arguments describe one task. Orchestrate it now under the protocol you read; the mode is unchanged.

Never pass the task text through a shell command's arguments; it is for your briefs on stdin through a single-quoted heredoc, not for `ultra-codex on`.
