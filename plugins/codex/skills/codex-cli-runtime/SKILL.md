---
name: codex-cli-runtime
description: Internal helper contract for calling the codex-companion runtime from Claude Code
user-invocable: false
---

# Codex Runtime

Use this skill only inside the `codex:codex-rescue` subagent. Its restrictions apply to that wrapper. The parent Claude agent owns planning, parallel task assignments, integration, verification, and user-facing summaries. The self-contained `codex:codex-worker` agent uses its own instructions for native parallel delegation and explicit-thread follow-ups; do not load this rescue-only skill there.

For the parent's background `task --direct` and `wait --direct` calls, compact progress lines appear in /tasks, then the JSON payload as the last stdout line. On completion, read only the last line starting with `{` in the output file (`grep '^{' <output file> | tail -n 1`). Claude Code may append `[exited with code N]`; never read the whole output file. Add `--quiet` for exactly one JSON line without progress; it requires `--direct`. The rescue wrapper's foreground invocation below is unchanged.

Primary helper:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task "<raw arguments>"`
- `node "$CODEX_COMPANION" task --help` (or `-h`) lists every task flag and examples without starting a job. Unknown task flags before `--` are errors; pass literal option-like task text after `--` or on stdin.

Execution rules:
- Set Bash `dangerouslyDisableSandbox: true` for every companion call. Add `--report --json` so stdout is a concise report with rawOutputFile/resultFile paths. The companion injects a conservative-assumptions, finish-this-turn contract; preserve needs_input and its question as incomplete work. No AskUserQuestion or confirmations in the wrapper.
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
- Default to a write-capable Codex run by adding `--write` unless the user explicitly asks for read-only behavior or only wants review, diagnosis, or research without edits.

Command selection:
- Use exactly one `task` invocation per rescue handoff.
- Keep the inner helper in the foreground. The parent controls the native Agent lifecycle; do not launch a detached runtime background task.
- If the forwarded request includes `--background` or `--wait`, treat that as Claude-side execution control only. Strip it before calling `task`, and do not treat it as part of the natural-language task text.
- If the forwarded request includes `--model`, normalize `spark` to `gpt-5.3-codex-spark` and pass it through to `task`.
- If the forwarded request includes `--effort`, pass it through to `task`.
- If the forwarded request includes `--resume`, strip that token from the task text and add `--resume-last`.
- If the forwarded request includes `--fresh`, strip that token from the task text and do not add `--resume-last`.
- `--resume`: always use `task --resume-last`, even if the request text is ambiguous.
- `--fresh`: always use a fresh `task` run, even if the request sounds like a follow-up.
- `--effort`: accepted values are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`.
- `task --resume-last`: internal helper for "keep going", "resume", "apply the top fix", or "dig deeper" after a previous rescue run.

Safety rules:
- Default to write-capable Codex work in `codex:codex-rescue` for implementation and fix requests. Keep diagnosis, planning, research, and review without requested edits read-only.
- Pass task text safely through stdin with a single-quoted heredoc delimiter absent from the prompt. Keep runtime flags separate and shell-quote their values. Do not interpolate prompt text into shell command syntax.
- Preserve the user's task text as-is apart from stripping routing flags.
- Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own.
- Return the stdout of the `task` command exactly as-is.
- If the Bash call fails or Codex cannot be invoked, return the failure and captured stderr to the outer Claude agent. Do not hide authentication, isolation, unsupported model/effort/tier, or runtime errors; do not claim successful execution.

Isolated runtime and collaboration:
- Pass `--fast` when the caller explicitly selects fast mode, including a parent Claude selection for latency-sensitive work; otherwise use normal mode (omit `--fast` or pass `--normal`). Never inherit fast from an earlier task. These flags are runtime controls, not prompt text. Reasoning effort and speed mode are independent.
- Use only this plugin runtime and its printed `codex-isolated.mjs` login/resume commands. Never fall back to the ordinary Codex home.
- During `codex-claude collaboration`, the outer Claude agent owns planning, parallel worker assignments, integration and acceptance. The thin forwarding rules apply only to this rescue subagent; the outer agent must inspect changes and verification evidence.
