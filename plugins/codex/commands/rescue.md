---
description: Delegate investigation, an explicit fix request, or follow-up rescue work to the Codex rescue subagent
argument-hint: "[--background|--wait] [--resume|--fresh] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh|max>] [--fast|--normal] [what Codex should investigate, solve, or continue]"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `codex:codex-rescue` subagent via the `Agent` tool (`subagent_type: "codex:codex-rescue"`), forwarding the raw user request as the prompt.
`codex:codex-rescue` is a subagent, not a skill — do not call `Skill(codex:codex-rescue)` (no such skill) or `Skill(codex:rescue)` (that re-enters this command and hangs the session). The command runs inline so the `Agent` tool stays in scope; forked general-purpose subagents do not expose it.
The rescue subagent returns Codex's output to the parent unchanged. The parent may summarize that result for the user while preserving findings, evidence boundaries, and failures. During `codex-claude collaboration`, the parent also inspects changes and verification evidence before accepting the work.

For parallel delegation, use direct mode first: the main agent runs `task --direct` via Bash with `run_in_background: true`, then reads one JSON line from the output file on the completion notification: only the last line starting with `{` (`grep '^{' <output file> | tail -n 1`). Progress lines appear in /tasks before that final JSON payload. Claude Code may append `[exited with code N]`; never read the whole output file. Add `--quiet` to `task --direct` or `wait --direct` to suppress progress. Follow-ups use `task --thread <threadId> --direct` with the same `--cwd`. Use `Agent` with `subagent_type: "codex:codex-worker"` only as fallback when background Bash is unavailable or the user requests an agent transcript view; never pass `model` or `effort` to that Haiku forwarder (put Codex's choices in the assignment text). Follow the [direct-mode protocol](../prompts/ultra-codex-protocol.md#dispatch). This command remains the explicit rescue entrypoint.

Raw user request:
$ARGUMENTS

Execution mode:

- If the request includes `--background`, run the `codex:codex-rescue` subagent in the background.
- If the request includes `--wait`, run the `codex:codex-rescue` subagent in the foreground.
- If neither flag is present, default to foreground.
- `--background` and `--wait` are execution flags for Claude Code. Do not forward them to `task`, and do not treat them as part of the natural-language task text.
- `--model` and `--effort` are runtime-selection flags. Preserve them for the forwarded `task` call, but do not treat them as part of the natural-language task text.
- If the request includes `--resume`, do not ask whether to continue. The user already chose.
- If the request includes `--fresh`, do not ask whether to continue. The user already chose.
- Otherwise, before starting Codex, check for a resumable rescue thread from this Claude session by running:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task-resume-candidate --json
```

- If that helper reports `available: true`, use `AskUserQuestion` exactly once to ask whether to continue the current Codex thread or start a new one.
- The two choices must be:
  - `Continue current Codex thread`
  - `Start a new Codex thread`
- If the user is clearly giving a follow-up instruction such as "continue", "keep going", "resume", "apply the top fix", or "dig deeper", put `Continue current Codex thread (Recommended)` first.
- Otherwise put `Start a new Codex thread (Recommended)` first.
- If the user chooses continue, add `--resume` before routing to the subagent.
- If the user chooses a new thread, add `--fresh` before routing to the subagent.
- If the helper reports `available: false`, do not ask. Route normally.

Operating rules:

- The subagent is a thin forwarder only. It should use one `Bash` call to invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task ...` and return that command's stdout as-is.
- Preserve the Codex companion output as evidence. The parent may give a concise user-facing explanation and continue authorized integration or verification.
- The wrapper's forwarding restriction does not restrict the parent Claude agent's planning, verification, or final response.
- Do not ask the subagent to inspect files, monitor progress, poll `/codex:status`, fetch `/codex:result`, call `/codex:cancel`, summarize output, or do follow-up work of its own.
- Default to `--effort xhigh`; respect explicit user effort, and allow `max` for difficult work when supported.
- Default to `--model gpt-6-astra`; respect explicit user model choices. If they ask for `spark`, map it to `gpt-5.3-codex-spark`.
- Leave `--resume` and `--fresh` in the forwarded request. The subagent handles that routing when it builds the `task` command.
- If the helper reports that Codex is missing or unauthenticated, stop and tell the user to run `/codex:setup`.
- If the user did not supply a request, ask what Codex should investigate or fix.

Isolated runtime and collaboration:
- Pass `--fast` when the caller explicitly selects fast mode, including a parent Claude selection for latency-sensitive work; otherwise use normal mode (omit `--fast` or pass `--normal`). Never inherit fast from an earlier task. These flags are runtime controls, not prompt text. Reasoning effort and speed mode are independent.
- Use only this plugin runtime and its printed `codex-isolated.mjs` login/resume commands. Never fall back to the ordinary Codex home.
- During `codex-claude collaboration`, the outer Claude agent owns planning, parallel worker assignments, integration and acceptance. The thin forwarding rules apply only to this rescue subagent; the outer agent must inspect changes and verification evidence.
