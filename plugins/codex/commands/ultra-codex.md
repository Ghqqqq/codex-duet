---
description: Orchestrate substantive tasks with parallel Codex workers, once or as a session mode (on/off). Claude's effort goes into precise briefs and strict acceptance; Codex does the investigation, implementation and review.
argument-hint: "[on [--quick|--thorough] [--max-workers <n>] | off | status | <what to accomplish>]"
allowed-tools: Agent, Read, Glob, Grep, Bash(node:*), Bash(git:*), Bash(npm:*), Edit, Write, TodoWrite, AskUserQuestion
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" ultra-codex status --for-command`

Raw slash-command arguments:
`$ARGUMENTS`

Dispatch on the arguments before anything else. For a task (including `on` with task text), use Read on the protocol path printed above before orchestrating. Control-only invocations do not read it. The mode switch is a per-session setting (like `/effort ultracode`): while it is on, every prompt carries a one-line versioned reminder and each substantive task applies that protocol without typing this command again.

Dispatch assignments in direct mode: the main agent runs `task --direct` via Bash with `run_in_background: true`. Progress lines appear in /tasks, then the JSON payload as the last stdout line. On the completion notification, read only the last line starting with `{` in the output file (`grep '^{' <output file> | tail -n 1`). Claude Code may append `[exited with code N]`; never read the whole output file. Add `--quiet` to `task --direct` or `wait --direct` to suppress progress. Follow the protocol you read. Use `Agent(subagent_type: "codex:codex-worker")` only as fallback when background Bash is unavailable or the user requests an agent transcript view. Never pass `model` or `effort` to that Haiku forwarder; put Codex's choices in the assignment text.

- Exactly `off`: run `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" ultra-codex off` with Bash and show its output to the user. It lists this session's Codex jobs that are still running; cancel them only if the user asks. The orchestration has ended: from here on handle requests normally and start no new Codex jobs or fallback workers unless asked. Stop.
- `on`, optionally followed by `--quick` or `--thorough` and `--max-workers <n>`: run `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" ultra-codex on` with exactly those flags via Bash and show its output. If task text follows the flags, orchestrate that task now under the protocol you read; otherwise stop.
- `status` or no arguments: report the mode line printed above and this usage. Stop.
- Anything else: the arguments describe one task. Orchestrate it now under the protocol you read; the mode is unchanged.

Never pass the task text through a shell command's arguments; it is for your briefs on stdin through a single-quoted heredoc, not for `ultra-codex on`.
