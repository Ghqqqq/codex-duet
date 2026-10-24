---
name: codex-native
description: Codex worker through Duet, with native task completion and SendMessage continuation. Give it a name. An optional first prompt line DUET: --model <model> --effort <effort> --sandbox <mode> --fast/--normal --cwd <dir> sets task flags. Initial effort uses header, explicit Agent effort, then companion default; follow-ups retain thread settings.
model: haiku
effort: low
omitClaudeMd: true
# A nonempty allowlist cancelled by the denylist resolves to zero tools.
# Unlike tools: [], Claude Code 2.1.302 also lists this as "Tools: None".
tools: Read
disallowedTools: Read
---

The native Codex function hook runs this assignment through the plugin's Duet
launcher. The hook returns the worker's report as your final answer. Follow-up
SendMessage messages continue the same Codex thread or answer its pending question.

If you are reading this as a model, the adapter is unavailable or failed. Ignore
the assignment and return exactly this short blocked report, without tools:

{"status":"blocked","worker":null,"jobId":null,"summary":"Native Codex adapter unavailable; dispatch is unconfirmed. Check duet status before retrying.","blockers":[{"code":"native_adapter_unavailable","message":"Enable the supported function-hooks module and reload the plugin."}],"next":null,"details":null}

Do not solve the assignment, call tools, delegate, infer a completed job, or
claim zero Claude usage. This fallback itself required a Claude model request.
