---
name: codex-cli-runtime
description: Internal helper contract for calling the codex-companion runtime from Claude Code
user-invocable: false
---

# Codex Runtime

Use this skill only inside the `codex:codex-rescue` subagent. Its restrictions apply to that wrapper. The parent Claude agent owns planning, parallel task assignments, integration, verification, and user-facing summaries. The self-contained `codex:codex-worker` agent uses its own instructions for fallback delegation and worker-specific follow-ups; do not load this rescue-only skill there.

The parent prefers `Agent(subagent_type: "codex:codex-native")` when available,
otherwise `duet task` in background Bash. Its report arrives with the completion
notification; only if missing, use `duet result <worker>`. Follow-ups use
`duet task --to <worker>`; pending questions use the report's `next` command verbatim, or
`duet answer <worker> --question '<questionId>'` with the displayed ID. A bare
`duet answer <worker>` can answer a newer pending question. Native
agents instead receive both through SendMessage, which already pins the displayed question. Do not parse output files.

Primary helper: `duet task --quiet` with the brief only on stdin via a
single-quoted `DUET_TASK` heredoc. `duet task --help` lists flags without starting
a job. Single-quote runtime arguments; double quotes, pipes and commands outside
the permission hook's grammar use normal permissions.

Execution rules:
- When Claude's Bash sandbox is on, set `dangerouslyDisableSandbox: true`. `duet task` implies `--direct`; use `--quiet --timeout-sec 570` with Bash `timeout: 600000` for one JSON report v2. Do not add `--report --json` or `--follow`. Full evidence and artifact paths are available to the parent through `duet result <worker> --details`. The companion injects a conservative-assumptions, finish-this-turn contract; preserve needs_input and its question as incomplete work. No AskUserQuestion or confirmations in the wrapper.
- On an unreachable/sandbox/socket/timeout failure before any job handle, retry once outside the Bash sandbox and report it. If a handle exists, return it for the parent's status/result recovery; never automatically submit another turn.
- The rescue subagent is a forwarder, not an orchestrator. Its only job is to invoke `task` once and return that stdout unchanged.
- Prefer the helper over hand-rolled `git`, direct Codex CLI strings, or any other Bash activity.
- Do not call `setup`, `review`, `adversarial-review`, `status`, `result`, or `cancel` from `codex:codex-rescue`.
- Use `task` for every rescue request, including diagnosis, planning, research, and explicit fix requests.
- You may use the `gpt-5-4-prompting` skill to rewrite the user's request into a tighter Codex prompt before the single `task` call.
- That prompt drafting is the only Claude-side work allowed. Do not inspect the repo, solve the task yourself, or add independent analysis outside the forwarded prompt text.
- Default to `--effort xhigh`; respect explicit user effort, and allow `max` for difficult work when supported.
- Default to `--model gpt-6-astra`; respect explicit user model choices and map `spark` to `gpt-5.3-codex-spark`.
- Map `spark` to `--model gpt-5.3-codex-spark`.
- For implementation and fix requests, add `--write`. For read-only requests or review, diagnosis, planning, or research without edits, pass `--sandbox read-only` explicitly instead.

Command selection:
- Use exactly one `task` invocation per rescue handoff.
- Keep the inner helper call in the foreground; the parent controls the Agent lifecycle. Direct mode manages the detached Codex job and attached owner wait internally. Return a nonterminal report unchanged for the parent to wait or answer; never treat it as completion.
- If the forwarded request includes `--background` or `--wait`, treat that as Claude-side execution control only. Strip it before calling `task`, and do not treat it as part of the natural-language task text.
- If the forwarded request includes `--model`, normalize `spark` to `gpt-5.3-codex-spark` and pass it through to `task`.
- If the forwarded request includes `--effort`, pass it through to `task`.
- If the forwarded request includes `--resume`, strip that token from the task text and add `--resume-last`.
- If the forwarded request includes `--fresh`, strip that token from the task text and do not add `--resume-last`.
- `--resume`: always use `task --resume-last`, even if the request text is ambiguous.
- `--fresh`: always use a fresh `task` run, even if the request sounds like a follow-up.
- `--effort`: accepted values are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`.
- `task --resume-last`: internal helper for "keep going", "resume", "apply the top fix", or "dig deeper" after a previous rescue run. It inherits the selected thread's recorded model, effort, sandbox and speed unless explicitly overridden; missing sandbox settings require explicit `--sandbox`. Request grants require original dispatch in the same Claude session. Never use latest-thread selection for parallel workers.

Safety rules:
- Default to write-capable Codex work in `codex:codex-rescue` for implementation and fix requests. Pass `--sandbox read-only` explicitly for diagnosis, planning, research, and review without requested edits.
- Pass task text through a single-quoted `DUET_TASK` heredoc with its delimiter absent as a complete line from the prompt. Keep runtime flags separate and shell-quote their values. Do not interpolate prompt text into shell command syntax.
- Preserve the user's task text as-is apart from stripping routing flags.
- Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own.
- Return the stdout of the `task` command exactly as-is.
- If the Bash call fails or Codex cannot be invoked, return the failure and captured stderr to the outer Claude agent. Do not hide authentication, isolation, unsupported model/effort/tier, or runtime errors; do not claim successful execution.

Isolated runtime and collaboration:
- Pass `--fast` when the caller explicitly selects fast mode, including a parent Claude selection for latency-sensitive work; otherwise fresh tasks use normal mode. Follow-ups inherit recorded speed; pass `--normal` to reset it. These flags are runtime controls, not prompt text. Reasoning effort and speed mode are independent.
- Use only this plugin runtime and its printed `codex-isolated.mjs` login/resume commands. Never fall back to the ordinary Codex home.
- During `codex-claude collaboration`, the outer Claude agent owns planning, parallel worker assignments, integration and acceptance. The thin forwarding rules apply only to this rescue subagent; the outer agent must inspect changes and verification evidence.
