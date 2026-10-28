---
description: Show the stored final output for a finished Codex job in this repository
argument-hint: '[worker|job-id] [--details]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Pass the raw `$ARGUMENTS` unchanged through the single-quoted heredoc below, without shell expansion. Do not split, reorder, unquote or rewrite the arguments; the companion parses them.
If an argument line is exactly `DUET_ARGS`, choose a delimiter absent from the arguments and change both heredoc delimiters together.

Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" result --args-stdin <<'DUET_ARGS'
$ARGUMENTS
DUET_ARGS
```

Present the command's report v2 unchanged. Preserve status, worker, jobId, summary,
nonempty evidence, `next` and `details`; `blocked` and `needs_input` are not success.
Use `duet result <worker> --details` when the user requests full evidence, handles,
settings, artifact paths, complete review text/findings or full blocker fields.
Compact blockers already retain bounded app/tab/session identifiers, cleanup
status and safe method/kind/server/origin approval identifiers when captured.
For `thread_busy`, preserve `next` as the owning job's pinned answer or recovery
action (or null); `details` still targets the refused attempt. Keep file paths,
line numbers, errors and the distinction between captured `checks.ran` and
Codex's `checks.claimed` exactly as reported. Reading a result never starts a turn.
