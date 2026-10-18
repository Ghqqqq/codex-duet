---
description: Orchestrate substantive tasks with parallel Codex workers, once or as a session mode (on/off). Claude's effort goes into precise briefs and strict acceptance; Codex does the investigation, implementation and review.
argument-hint: "[on [--quick|--thorough] [--max-workers <n>] | off | status | <what to accomplish>]"
allowed-tools: Agent, Read, Glob, Grep, Bash(node:*), Bash(git:*), Bash(npm:*), Edit, Write, TodoWrite, AskUserQuestion
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" ultra-codex status --for-command`

Raw slash-command arguments:
`$ARGUMENTS`

Dispatch on the arguments before anything else. The mode switch is a per-session setting (like `/effort ultracode`): while it is on, every prompt carries a one-line reminder and each substantive task is orchestrated under the protocol above without typing this command again.

- Exactly `off`: run `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" ultra-codex off` with Bash and show its output to the user. It lists this session's Codex jobs that are still running; cancel them only if the user asks. The orchestration has ended: from here on handle requests normally and spawn no Codex workers unless asked. Stop.
- `on`, optionally followed by `--quick` or `--thorough` and `--max-workers <n>`: run `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" ultra-codex on` with exactly those flags via Bash and show its output. If task text follows the flags, orchestrate that task now under the protocol above; otherwise stop.
- `status` or no arguments: report the mode line printed above and this usage. Stop.
- Anything else: the arguments describe one task. Orchestrate it now under the protocol above; the mode is unchanged.

Never pass the task text through a shell command; it is for your briefs, not for `ultra-codex on`.
