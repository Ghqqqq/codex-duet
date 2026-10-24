---
name: codex-result-handling
description: Internal guidance for presenting Codex helper output back to the user
user-invocable: false
---

# Codex Result Handling

Background `duet task`/`wait`/`answer` reports arrive with the completion notification;
native `codex:codex-native` reports arrive as agent results. Only if a report is
missing, use `duet result <worker>`. Do not parse output files or poll.
Report v2 gives `status`, `worker`, `jobId`, `summary`, nonempty evidence, `next`
and `details`. `checks.ran` is captured evidence; `checks.claimed` is Codex's
account. Use `duet result <worker> --details` for shortened fields, full handles,
settings, file-tracking basis and artifact paths. A suggested `next` command is
not permission to continue user-stopped work.

For `running`, background `duet wait <worker>`; for `needs_answer`, background
the report's `next` command verbatim, or `duet answer <worker> --question '<questionId>'`
with the displayed ID and stdin via a single-quoted `DUET_ANSWER` heredoc.
A bare `duet answer <worker>` answers whatever question is pending now, which
may be newer than the one you saw.
Never run two waits. Follow up with `duet task --to <worker>` and a `DUET_TASK`
heredoc. Native agents receive answers and follow-ups via SendMessage instead;
that answer path already pins the displayed question and is unchanged.

When the helper returns Codex output:
- Preserve the helper's verdict, summary, findings, and next steps structure.
- For review output, present findings first and keep them ordered by severity.
- Use the file paths and line numbers exactly as the helper reports them.
- Preserve evidence boundaries. If Codex marked something as an inference, uncertainty, or follow-up question, keep that distinction.
- Preserve output sections when the prompt asked for them, such as observed facts, inferences, open questions, touched files, or next steps.
- If there are no findings, say that explicitly and keep the residual-risk note brief.
- If Codex made edits, say so explicitly and list the touched files when the helper provides them.
- Inside the `codex:codex-rescue` wrapper, do not turn a failed or incomplete Codex run into a Claude-side implementation attempt. Report the failure to the parent and stop the wrapper.
- Inside that wrapper, if Codex was never successfully invoked, do not generate a substitute answer at all. The parent must preserve that failure when deciding its next step.
- For a standalone review-only request, including `/codex:review` and `/codex:adversarial-review`, present findings and stop without changing code. Fixes require an authorized implementation request.
- During an already authorized implementation or fix task, review findings may feed the parent's verification and repair loop. Do not require a new user confirmation for fixes within that authorized scope. The parent owns integration, acceptance, and the final user-facing summary.
- If the helper reports malformed output or a failed Codex run, include the actionable stderr and clearly report the failure. Never guess a successful result. A parent conducting authorized collaboration may diagnose the failure or issue an appropriate follow-up; wrapper-only stop rules do not stop the parent's task.
- If the helper reports that setup or authentication is required, direct the user to `/codex:setup` and do not improvise alternate auth flows.
