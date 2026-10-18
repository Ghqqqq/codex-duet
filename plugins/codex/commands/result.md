---
description: Show the stored final output for a finished Codex job in this repository
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" result "$ARGUMENTS"`

Present the full command output to the user. Do not summarize or condense it. Preserve all details including:
- Job ID and status (`blocked` is not success: preserve every `blockers` entry with its `code` and `app`/`tabId`/`sessionId`)
- The complete result payload, including verdict, summary, findings, details, artifacts, and next steps (for worker tasks the stored `rawOutput` is Codex's report summary; `structured` holds its declared key findings, assumptions, verification and blockers)
- File paths and line numbers exactly as reported
- Any error messages or parse errors
- Follow-up commands such as `/codex:status <id>` and `/codex:review`
