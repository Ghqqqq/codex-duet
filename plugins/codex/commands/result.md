---
description: Show the stored final output for a finished Codex job in this repository
argument-hint: '[worker|job-id] [--details]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" result "$ARGUMENTS"`

Present the command's report v2 unchanged. Preserve status, worker, jobId, summary,
nonempty evidence, `next` and `details`; `blocked` and `needs_input` are not success.
Use `duet result <worker> --details` when the user requests full evidence, handles,
settings, artifact paths or app/tab/session blocker identifiers. Keep file paths,
line numbers, errors and the distinction between captured `checks.ran` and
Codex's `checks.claimed` exactly as reported. Reading a result never starts a turn.
