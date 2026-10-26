---
description: Run a Codex review that challenges the implementation approach and design choices
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [focus ...]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run an adversarial Codex review through the shared plugin runtime.
Position it as a challenge review that questions the chosen implementation, design choices, tradeoffs, and assumptions.
It is not just a stricter pass over implementation defects.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return Codex's output verbatim to the user.
- Keep the framing focused on whether the current approach is the right one, what assumptions it depends on, and where the design could fail under real-world conditions.

Execution mode rules:
- If the raw arguments include `--wait`, do not ask. Run in the foreground.
- If the raw arguments include `--background`, do not ask. Run in a Claude background task.
- Otherwise, estimate the review size before asking:
  - For working-tree review, start with `git status --short --untracked-files=all`.
  - For working-tree review, also inspect both `git diff --shortstat --cached` and `git diff --shortstat`.
  - For base-branch review, use `git diff --shortstat <base>...HEAD`.
  - Treat untracked files or directories as reviewable work for auto or working-tree review even when `git diff --shortstat` is empty.
  - Only conclude there is nothing to review when the relevant scope is actually empty.
  - Recommend waiting only when the scoped review is clearly tiny, roughly 1-2 files total and no sign of a broader directory-sized change.
  - In every other case, including unclear size, recommend background.
  - When in doubt, run the review instead of declaring that there is nothing to review.
- Then use `AskUserQuestion` exactly once with two options, putting the recommended option first and suffixing its label with `(Recommended)`:
  - `Wait for results`
  - `Run in background`

Argument handling:
- Pass the raw `$ARGUMENTS` unchanged through the single-quoted heredoc below, without shell expansion. Do not split, reorder, unquote or rewrite the arguments; the companion parses them deterministically.
- If an argument line is exactly `DUET_ARGS`, choose a delimiter absent from the arguments and change both heredoc delimiters together.
- Do not strip `--wait` or `--background` yourself.
- Do not weaken the adversarial framing or rewrite the user's focus text.
- The companion script parses `--wait` and `--background`, but Claude Code's `Bash(..., run_in_background: true)` is what actually detaches the run.
- `/codex:adversarial-review` uses the same review target selection as `/codex:review`.
- It supports working-tree review, branch review, and `--base <ref>`.
- It does not support `--scope staged` or `--scope unstaged`.
- Unlike `/codex:review`, it can take extra focus text. Without an explicit separator, the first non-option starts literal focus; trailing `--wait`, `--background` and `--json` tokens are still options.
- In the option prefix, unknown flags within two character edits of a supported option are rejected as likely typos, with a suggested option and usage. Unknown flags inside focus remain unchanged.
- Users should put `--` before focus that starts with something option-like: `-- --baes main` passes `--baes main` as focus without changing the review target.

Foreground flow:
- Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" adversarial-review --args-stdin <<'DUET_ARGS'
$ARGUMENTS
DUET_ARGS
```
- Return the command stdout verbatim, exactly as-is.
- Do not paraphrase, summarize, or add commentary before or after it.
- Do not fix any issues mentioned in the review output.

Background flow:
- Run this command with `Bash(..., run_in_background: true)`:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" adversarial-review --args-stdin <<'DUET_ARGS'
$ARGUMENTS
DUET_ARGS
```
- Do not call `BashOutput` or wait for completion in this turn.
- After launching the command, tell the user: "Codex adversarial review started in the background. Check `/codex:status` for progress."
