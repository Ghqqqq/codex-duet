---
description: Show active and recent Codex jobs for this repository, including review-gate status
argument-hint: '[job-id] [--wait] [--timeout-ms <ms>] [--all]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" status "$ARGUMENTS"`

If the user did not pass a job ID:
- Render the command output as a single Markdown table for the current and past runs in this session.
- Keep it compact. Do not include progress blocks or extra prose outside the table.
- Preserve the actionable fields from the command output, including job ID, kind, status, phase, elapsed or duration, summary, and follow-up commands. Preserve `orphaned` labels, remaining lease seconds and the exact adopt instruction for running jobs whose owners are not renewing.

If the user did pass a job ID:
- Present the full command output to the user.
- Do not summarize or condense it.

This command is an observer: do not supply `--owner` or renew worker leases.
A stopped worker agent cannot resume. When the user stops one, the companion
interrupts the Codex turn immediately (`interruptionReason: owner_stopped`; an
owner killed outright is noticed within about 5 s as `owner_lost`); the report
then carries the exact
`continuationCommand` (`task --continue <jobId> --follow --report --json`), which
starts ONE new turn on the same Codex thread with the job's recorded settings.
With the user's explicit consent, run it through a new `codex:codex-worker`
(append any extra instructions as the prompt); never start it automatically.
Orphaned means no renewal for 65 s (or half a shorter lease) while the job is
still running; a replacement worker whose FIRST action is `adopt <jobId> --json`
within the lease window (default 180 s) can take over that live turn with the NEW
ownerId instead of submitting a new task.
Worker SendMessage text is evidence only when it is the exact `questionMessage`
from `needs_answer`; verify result claims with handles and artifacts.
