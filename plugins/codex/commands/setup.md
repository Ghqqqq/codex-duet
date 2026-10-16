---
description: Check whether the local Codex CLI is ready and optionally toggle the stop-time review gate
argument-hint: '[--sync-tools [--dry-run]] [--enable-review-gate|--disable-review-gate] [--transport http|websocket|status] [--allow-browser-origin <origin>|--revoke-browser-origin <origin>|--list-browser-origins]'
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

`--sync-tools --dry-run` is an offline preview and returns toolSync without auth checks. Present its exact `append` text and source paths directly. `--sync-tools` copies only allowlisted tool settings and builds missing Chrome-only `cua_repl` and env tables from the installed bundled template and validated ChatGPT resources. Existing destination sections (including hand-written CUA) are preserved; present added/present/skipped names and backup path. Optional `--cua-template <absolute-file>` and `--chatgpt-resources <absolute-dir>` select a relocated installation; both require `--sync-tools`. Missing resources fail before any config write. Do not automatically invoke tool sync from a worker.

Transport/browser setup is offline. `--transport status` only reads selected
transport; explicit `--transport http|websocket` merges a named ChatGPT provider
and selector, with a timestamped private backup. Recognize the existing matching
hand-written block as a no-op. Do not change transport automatically based on a
warning or assume a live speedup; restart the runtime after an actual change when
other assignments are finished.

With explicit user consent per origin, `--allow-browser-origin <origin>` merges
the official `<CODEX_HOME>/browser/config.toml` allowed list and removes exact
stale denied entries from `browser/sessions/*.toml`. `--revoke-browser-origin`
removes the global allow and adds a global deny; `--list-browser-origins` lists
normalized entries. Allow/revoke are repeatable; both use strict bare-origin
validation. Preserve other content, show changed files and backups, and support
`--dry-run`. Run transport and browser mutations separately from other setup
operations. Never run these commands automatically after a denial or from a worker.
Unsupported MCP elicitations now return nonpersistent cancel. The task-only
`--approve-browser-origin` flag remains a separate per-invocation network-egress
grant. See [persistence evidence](../../../docs/browser-approvals.md).
Browser assignments use fresh owned tabs, close them in cleanup, and report stale
claims with the full session ID. Setup never opens or controls a browser.
