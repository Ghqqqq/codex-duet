---
description: Delegate investigation, an explicit fix request, or follow-up rescue work to the Codex rescue subagent
argument-hint: "[--background|--wait] [--resume|--fresh] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh|max>] [--fast|--normal] [what Codex should investigate, solve, or continue]"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `fugato:codex-rescue` subagent via the `Agent` tool (`subagent_type: "fugato:codex-rescue"`), forwarding the raw user request as the prompt.
`fugato:codex-rescue` is a subagent, not a skill — do not call `Skill(fugato:codex-rescue)` (no such skill) or `Skill(fugato:rescue)` (that re-enters this command and hangs the session). The command runs inline so the `Agent` tool stays in scope; forked general-purpose subagents do not expose it.
The rescue subagent returns Codex's output to the parent unchanged. The parent may summarize that result for the user while preserving findings, evidence boundaries, and failures. During `codex-claude collaboration`, the parent also inspects changes and verification evidence before accepting the work.

For parallel delegation, use `Agent(subagent_type: "fugato:codex-native")` by default from the first dispatch unless saved dispatch guidance selects Bash: `fugato setup --dispatch bash` selects it immediately, while `auto` prefers it for 24 hours after the last native-unavailable observation, or until `fugato setup --dispatch` is run without `--dry-run`. Use background `fugato task` when selected by that guidance, the native agent returns `native_adapter_unavailable` or `native_capacity`, a per-call option is rejected by the `DUET:` line (`--run`, `--approve-browser-origin`, `--approve-computer-app`, `--lease-sec`, `--question-timeout-sec`), or following up a worker launched through Bash. For that route, use background Bash with a single-quoted `DUET_TASK` heredoc. The report arrives with the completion notification; only if missing, run `fugato result <worker>`. Follow-ups use SendMessage for native agents, or `fugato task --to <worker>` with a new stdin brief. Native answers use SendMessage, which already pins the displayed question. Bash answers use the report's `next` verbatim, or `fugato answer <worker> --question '<questionId>'` with the displayed ID and a `DUET_ANSWER` heredoc. A bare `fugato answer <worker>` can answer a newer pending question. Full evidence is in `fugato result <worker> --details`; do not parse output files. `fugato:codex-worker` is the Haiku fallback when neither native dispatch nor background Bash is available, or the user requests a forwarding-agent transcript. Follow the [dispatch protocol](../prompts/ultra-codex-protocol.md#dispatch). This command remains the explicit rescue entrypoint.

Raw user request:
$ARGUMENTS

Execution mode:

- If the request includes `--background`, run the `fugato:codex-rescue` subagent in the background.
- If the request includes `--wait`, run the `fugato:codex-rescue` subagent in the foreground.
- If neither flag is present, default to foreground.
- `--background` and `--wait` are execution flags for Claude Code. Do not forward them to `task`, and do not treat them as part of the natural-language task text.
- `--model` and `--effort` are runtime-selection flags. Preserve them for the forwarded `task` call, but do not treat them as part of the natural-language task text.
- If the request includes `--resume`, do not ask whether to continue. The user already chose.
- If the request includes `--fresh`, do not ask whether to continue. The user already chose.
- If the parent supplies `--to <jobId>`, preserve that exact target and do not ask or select a latest thread.
- Otherwise, before starting Codex, check for a resumable rescue thread from this Claude session by running:

```bash
fugato task-resume-candidate --json
```

- If that helper reports `available: true`, use `AskUserQuestion` exactly once to ask whether to continue the current Codex thread or start a new one.
- The two choices must be:
  - `Continue current Codex thread`
  - `Start a new Codex thread`
- If the user is clearly giving a follow-up instruction such as "continue", "keep going", "resume", "apply the top fix", or "dig deeper", put `Continue current Codex thread (Recommended)` first.
- Otherwise put `Start a new Codex thread (Recommended)` first.
- Retain the helper's exact `candidate.id` while asking. If the user chooses continue, add `--to <jobId>` with that ID before routing to the subagent; do not add `--resume` or resolve the candidate again.
- If the user chooses a new thread, add `--fresh` before routing to the subagent.
- If the helper reports `available: false`, do not ask. Route normally.

Operating rules:

- The subagent is a Haiku forwarder only; do not pass it model or effort overrides. It forwards the request verbatim except for routing and runtime flags, without rewriting or adding instructions. It should use one `Bash` call to invoke `fugato task --quiet --timeout-sec 570` with stdin via a single-quoted `DUET_TASK` heredoc and return that command's stdout as-is.
- Preserve the Codex companion output as evidence. The parent may give a concise user-facing explanation and continue authorized integration or verification.
- The wrapper's forwarding restriction does not restrict the parent Claude agent's planning, verification, or final response.
- Do not ask the subagent to inspect files, monitor progress, poll `/fugato:status`, fetch `/fugato:result`, call `/fugato:cancel`, summarize output, or do follow-up work of its own.
- Omit `--model` and `--effort` unless the user chose them; Fugato then applies the saved defaults (see the `fugato:models` skill). Respect explicit user choices, and allow `max` for difficult work when supported.
- Pass explicit model choices and aliases through to Fugato for normalization.
- Leave `--to <jobId>`, explicit `--resume` and `--fresh` in the forwarded request. The subagent handles that routing when it builds the `task` command; an offered candidate must keep its exact job ID.
- If the helper reports that Codex is missing or unauthenticated, stop and tell the user to run `/fugato:setup`.
- If the user did not supply a request, ask what Codex should investigate or fix.

Isolated runtime and collaboration:
- Pass `--fast` when the caller explicitly selects fast mode, including a parent Claude selection for latency-sensitive work; otherwise fresh tasks use normal mode. Follow-ups inherit recorded speed; pass `--normal` to reset it. These flags are runtime controls, not prompt text. Reasoning effort and speed mode are independent.
- Use only this plugin runtime and its printed `codex-isolated.mjs` login/resume commands. Never fall back to the ordinary Codex home.
- During `codex-claude collaboration`, the outer Claude agent owns planning, parallel worker assignments, integration and acceptance. The thin forwarding rules apply only to this rescue subagent; the outer agent must inspect changes and verification evidence.
