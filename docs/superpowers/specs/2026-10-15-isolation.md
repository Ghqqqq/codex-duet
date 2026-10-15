# Isolated Codex plugin for Claude Code

Approved: same Codex account, separate data and authentication directory; persistent resumable plugin threads, no plugin history in the normal Codex store.

Base: openai/codex-plugin-cc db52e28, 1.0.6. Install as codex@codex-isolated-local. Default home ~/.claude/codex-isolated. Optional CODEX_COMPANION_HOME must not overlap normal CODEX_HOME or ~/.codex. All task/review/transfer/background/broker/direct paths use this home. Pin SQLite, logs and file credentials there. Resume/login instructions use a wrapper that preserves the isolated home. Unknown broker homes fail closed. No authentication copies or symlinks.

Global CLAUDE.md trigger: codex-claude collaboration. Claude plans, delegates independent tasks, integrates and accepts. Default gpt-6-astra / xhigh; optionally max on hard tasks if supported. Explicit user choices win.

Verification: process-boundary regression tests, existing suite and typecheck, installed setup, independent OAuth login, real task and resume with thread metadata absent from ordinary home. Final independent code review.

Additional request: fast service tier may be selected explicitly by Claude or user; normal mode is the default on every call, including resume. --fast selects fast, --normal explicitly selects normal. Preserve reasoning effort independently of speed tier.
