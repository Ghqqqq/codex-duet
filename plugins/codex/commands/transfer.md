---
description: Transfer the current Claude Code session into a resumable Codex thread
argument-hint: "[--source <claude-jsonl>]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Pass the raw `$ARGUMENTS` unchanged through the single-quoted heredoc below, without shell expansion. Do not split, reorder, unquote or rewrite the arguments; the companion parses them.
If an argument line is exactly `DUET_ARGS`, choose a delimiter absent from the arguments and change both heredoc delimiters together.

Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" transfer --args-stdin <<'DUET_ARGS'
$ARGUMENTS
DUET_ARGS
```

Present the command output to the user exactly as returned. Preserve the Codex session ID and the isolated `codex-isolated.mjs --home <directory> resume <session-id>` command.
