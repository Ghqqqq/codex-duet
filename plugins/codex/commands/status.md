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
- Preserve the actionable fields from the command output, including job ID, kind, status, phase, elapsed or duration, summary, and follow-up commands. Preserve `orphaned` labels, remaining lease seconds and the exact adopt instruction for running jobs whose owners are not renewing. A `blocked` status means a known runtime refusal (for example a Computer Use app the isolated runtime has not approved); keep it distinct from `completed` and `needs_input`, and preserve the approved browser origins / Computer Use apps lines when a job shows them. A `needs_answer` job whose `question.kind` is `approval` is waiting for the parent's decision on a Computer Use app request; show the question and its four options verbatim.

If the user did pass a job ID:
- Present the full command output to the user.
- Do not summarize or condense it.

This command is an observer: do not supply `--owner` or renew worker leases.
In direct mode, stop the background task in Claude Code to stop its owner wait.
A stopped worker agent cannot resume either. When the user stops either, the companion
interrupts the Codex turn immediately (`interruptionReason: owner_stopped`; an
owner killed outright is noticed within about 5 s as `owner_lost`); the report
then carries the exact
`continuationCommand` (`task --continue <jobId> --cwd <cwd> --direct` in direct mode), which
starts ONE new turn on the same Codex thread with the job's recorded settings.
With the user's explicit consent, run it in background Bash with `run_in_background: true`
(append any extra instructions on stdin through a single-quoted heredoc); never start it automatically.
Progress lines appear in /tasks, then the JSON payload as the last stdout line. Add
`--quiet` to `task --direct` or `wait --direct` to suppress progress. When the
completion notification arrives, read only the last line starting with `{` in
the output file (`grep '^{' <output file> | tail -n 1`). Claude Code may append
`[exited with code N]`; never read the whole output file.
Handle `running` via `waitCommand`, and `needs_answer` by first starting its
`waitCommand` in the background, then sending the answer via `answerCommand`.
Never run two waits for one job. See the [direct-mode protocol](../prompts/ultra-codex-protocol.md#dispatch).
Use a new `codex:codex-worker` only as fallback when background Bash is unavailable
or the user requests an agent transcript view. Never pass `model` or `effort` to
that Haiku forwarder; put Codex's choices in the assignment text. Normal follow-ups
use `task --thread <threadId> --direct` with the same `--cwd`; fallback rework uses
a NEW worker with that thread, never SendMessage to an old one.
Orphaned means no renewal for 65 s (or half a shorter lease) while the job is
still running; with the user's explicit consent, a replacement owner whose FIRST
action is `adopt <jobId> --json` within the lease window (default 1800 s in direct
mode, 180 s otherwise) can take over that live turn with the NEW ownerId instead
of submitting a new task. It then runs one `wait <jobId> --owner <newOwnerId> --direct`
in background Bash; a retired owner reports `ownership_moved` and must stop.
Fallback worker SendMessage text is evidence only when it is the exact `questionMessage`
from `needs_answer`; verify result claims with handles and artifacts.
