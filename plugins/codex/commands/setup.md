---
description: Check Codex readiness and explicitly configure isolated tools, sandbox and browser access
argument-hint: '[--sync-tools [--profile chrome|codex-app] [--replace-cua] [--cua-template <file>] [--dry-run]] [--enable-review-gate|--disable-review-gate] [--default-sandbox read-only|workspace-write|danger-full-access] [--browser-approval never-ask|ask] [--transport http|websocket|status] [--allow-browser-origin <origin>|--revoke-browser-origin <origin>|--list-browser-origins]'
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

`--sync-tools --dry-run` is an offline preview and returns toolSync without auth checks. Present its exact `append` text and source paths directly. The default `--profile chrome` copies only allowlisted tool settings and builds missing Chrome-only `cua_repl` and env tables from the installed bundled template and validated ChatGPT resources. Existing destination sections (including hand-written CUA) are preserved unless replacement is explicitly requested; present added/replaced/present/skipped names, surfaces/backends and backup path. Optional `--cua-template <absolute-file>` and `--chatgpt-resources <absolute-dir>` select a relocated installation; both require `--sync-tools`. Missing resources fail before any config write. Do not automatically invoke tool sync from a worker.

`--sync-tools --profile codex-app` selects the newest unified-computer-use cache
template under the normal Codex home, with `--cua-template` as an override. It
mirrors the resolved server, changing only CODEX_HOME and the home entries in
NODE_REPL_TRUSTED_CODE_PATHS. This retains desktop/Sky, browser backends,
instructions, tool visibility/output limits and exactly the template's timeouts.
It never adds a tool timeout. Unknown fields/credentials/env forwarding are
rejected. `--chatgpt-resources` is incompatible with this profile.

For a different existing CUA server, dry-run shows `toolSync.diff` with old values
redacted and `requiresReplace: true`. Applying refuses to clobber it without
`--replace-cua`. That flag replaces the entire CUA block and subtables after a
private backup, preserving unrelated configuration; an identical server is a
no-op. Desktop permissions must already belong to Codex Computer Use.app. Setup
does not grant OS permissions or run a live tool probe.

`--default-sandbox read-only|workspace-write|danger-full-access` is an independent,
offline setup operation with `--dry-run` and backups. It stores `default_sandbox`
in `<isolated-home>/duet/config.toml`, shared by terminal and Claude sessions.
The built-in default is `danger-full-access` (workers run like the user's own
Codex app in full-access mode); this setting lowers it. Explicit per-call flags
win: `task --sandbox <mode>` narrows or widens one call on its own, `--write`
alone guarantees at least workspace-write, `--write=false` requests read-only.
`setup --json` reports `defaultSandbox`. Workers never modify this setting.

`--browser-approval never-ask|ask` writes or removes only top-level approval_mode
in the isolated browser/config.toml. `never-ask` stores `"never_ask"` and permits
all sites without per-origin prompts. `ask` removes the key; persistent origin
grants still apply. Download/upload/history settings and session files are
unchanged. Both setup JSON and `--list-browser-origins` report browserOrigins.approval.
Support `--dry-run`, show backups, and require explicit user opt-in for this setup
action. Combined with the Codex App profile and danger-full-access default, these
options grant full disk write, desktop control and any website through the user's
logged-in browser. Never enable them automatically after a denial.

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
