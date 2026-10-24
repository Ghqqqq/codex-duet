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
Use `duet status <worker>` to inspect a named worker. Stop active native tasks or
background Bash waits from `/tasks`, or run `duet cancel <worker>`. Thread context
and edits persist. Continue user-stopped work only with explicit consent: use
SendMessage to a native agent, or `duet task --to <worker>` with a new stdin brief
through a single-quoted `DUET_TASK` heredoc. `duet result <worker> --details`
provides handles and compatibility recovery commands when needed.

Reports arrive with completion notifications; only if missing, run
`duet result <worker>`. Handle `running` with one background `duet wait <worker>`;
handle `needs_answer` with the report's `next` command verbatim, or one background
`duet answer <worker> --question '<questionId>'` using the displayed ID and a
single-quoted `DUET_ANSWER` heredoc. A bare `duet answer <worker>` can answer a
newer pending question. Native agents already pin the displayed question through
SendMessage and handle waits themselves. Never parse output files or run two
waits. See the [dispatch protocol](../prompts/ultra-codex-protocol.md#dispatch).

Orphaned means no renewal for half the lease in direct mode (900 s by default),
or the smaller of 65 s and half the lease otherwise. With explicit user consent,
a replacement owner's FIRST action is `duet adopt <jobId> --json` within the
lease window. It then runs one `duet wait <jobId> --owner '<newOwnerId>'` in
background Bash. A retired owner reports `ownership_moved` and must stop.
The Haiku fallback uses a NEW agent for rework; SendMessage to that fallback only
answers its pending question. Verify all result claims with the diff and evidence.
