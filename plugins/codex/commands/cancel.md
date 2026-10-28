---
description: Cancel an active background Codex job in this repository
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Pass the raw `$ARGUMENTS` unchanged through the single-quoted heredoc below, without shell expansion. Do not split, reorder, unquote or rewrite the arguments; the companion parses them.
If an argument line is exactly `DUET_ARGS`, choose a delimiter absent from the arguments and change both heredoc delimiters together.

Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" cancel --args-stdin <<'DUET_ARGS'
$ARGUMENTS
DUET_ARGS
```
