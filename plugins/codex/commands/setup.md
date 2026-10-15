---
description: Check whether the local Codex CLI is ready and optionally toggle the stop-time review gate
argument-hint: '[--sync-tools [--dry-run]] [--enable-review-gate|--disable-review-gate]'
allowed-tools: Bash(node:*), Bash(npm:*), AskUserQuestion
---

Run:

Use `dangerouslyDisableSandbox: true` on every companion Bash call below. This tool parameter is required for network access and local sockets; it is not a shell argument.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" setup --json $ARGUMENTS
```

If the result says Codex is unavailable and npm is available:
- Use `AskUserQuestion` exactly once to ask whether Claude should install Codex now.
- Put the install option first and suffix it with `(Recommended)`.
- Use these two options:
  - `Install Codex (Recommended)`
  - `Skip for now`
- If the user chooses install, run:

```bash
npm install -g @openai/codex
```

- Then rerun:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" setup --json $ARGUMENTS
```

If Codex is already installed or npm is unavailable:
- Do not ask about installation.

If `auth.status` is `unreachable` (including workspace routing discovery timeouts, network/socket errors, EPERM or EACCES):
- Automatically retry setup once with Bash `dangerouslyDisableSandbox: true` and report the first failure and retry.
- If still unreachable, say: "Codex authentication could not be checked. Rerun the companion with Bash dangerouslyDisableSandbox: true, or allow network access and local sockets, then rerun setup --json. Do not log in again for this transport failure."
- Never present a login command for this branch. `loggedIn: false` is not evidence of logout when status is unreachable or unknown.
- For `auth.status: unknown`, report the runtime error without suggesting login.

`--sync-tools --dry-run` is an offline preview and returns toolSync without auth checks. Present it directly. `--sync-tools` copies only allowlisted tool settings, preserving existing destination sections; present added/present/skipped names and backup path. Do not automatically invoke tool sync from a worker.

Output rules:
- Present the final setup output to the user.
- If installation was skipped, present the original setup output.
- Only for `auth.status: unauthenticated`, preserve the exact isolated `codex-isolated.mjs` login command returned by setup. Do not substitute a bare Codex login.
