---
description: Check Codex readiness and explicitly configure isolated tools, sandbox and browser access
argument-hint: '[--sync-tools [--profile chrome|codex-app] [--replace-cua] [--cua-template <file>] [--dry-run]] [--enable-review-gate|--disable-review-gate] [--default-sandbox read-only|workspace-write|danger-full-access] [--browser-approval never-ask|ask] [--transport http|websocket|status] [--allow-browser-origin <origin>|--revoke-browser-origin <origin>|--list-browser-origins] [--computer-use-approval mirror|ask] [--allow-computer-app <bundle-id>|--revoke-computer-app <bundle-id>|--list-computer-apps] [--project-docs claude-md|agents-only]'
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

Browser access is unrestricted by default, like the user's own Codex app: before
every task the plugin mirrors top-level `approval_mode = "never_ask"` into the
isolated browser/config.toml when that key is absent, so workers reach any site
without per-origin prompts. `--browser-approval never-ask|ask` records the user's
choice in `<isolated home>/duet/config.toml` (`browser_approval`) and writes or
removes the browser key: `ask` removes it and later tasks leave it absent, so the
runtime's ordinary origin checks and persistent grants apply again. A hand-edited
custom value is never overwritten. Download/upload/history settings and session
files are unchanged. Setup JSON and `--list-browser-origins` report
browserOrigins.approval (the file) and browserOrigins.preference (the saved
choice). Support `--dry-run` and show backups. Combined with the Codex App
profile and the full-access sandbox default, workers have full disk write,
desktop control and any website through the user's logged-in browser; the user
lowers any of these explicitly with setup.

Computer Use app approvals follow the user's own Codex app by default:
`--computer-use-approval mirror` (the default, saved as `computer_use_approval` in
`<isolated home>/duet/config.toml`) makes every task copy the apps listed as
"Always" allowed in `~/.codex/computer-use/config.toml` (`[apps] allowed`, read
only; never session-level choices, the denied list or anything an organization
policy blocks) into `<isolated home>/computer-use/config.toml`, where node_repl
reads them. `ask` stops the sync and removes the mirrored entries; unapproved
apps are then denied by the runtime and reported as `blocked` with
`computer_use_app_not_approved`. `--allow-computer-app <bundle-id>` adds one app
(also in ask mode), `--revoke-computer-app <bundle-id>` removes it and keeps it
out of later mirrors, `--list-computer-apps` is read-only. Bundle identifiers
such as `com.google.Chrome` are validated before any write; invalid input is not
echoed. Support `--dry-run` and `--json`; the JSON `computerUse` object lists
`preference`, `allowed` (with `source: mirrored|explicit`), `revoked`, the
`codexApp` source file, `changedFiles` and `backups`. Run these flags separately
from other setup changes. For one call the parent may instead pass
`task --approve-computer-app <bundle-id>`. If the user has only chosen "This
session" in the Codex app, mirror has nothing to copy; tell them to choose
"Always" there or use `--allow-computer-app`. An app that no list covers is not
refused outright on an owned worker job: the request reaches the parent as a
pending question with four fixed options (allow this call, allow for this task,
allow always in the isolated home, deny), so the user decides at run time.

Project instructions: Codex reads `AGENTS.md` itself; `--project-docs claude-md`
(the default, saved as `project_docs` in `<isolated home>/duet/config.toml`)
makes every task set Codex's own `project_doc_fallback_filenames = ["CLAUDE.md"]`
in the isolated home's `config.toml`, so workers read the project's `CLAUDE.md`
wherever an `AGENTS.md` is missing. `--project-docs agents-only` removes Duet's
list and is remembered; a hand-written list is reported as `custom` and left
alone. Run this flag separately from other setup changes; supports `--dry-run`
and `--json` (`projectDocs`: `projectDocs`, `fallbackFilenames`, `custom`,
`changedFiles`). The user-level `~/.claude/CLAUDE.md` is never involved.

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
grant; it is normally unnecessary because every sandbox mode keeps network access
on. See [persistence evidence](../../../docs/browser-approvals.md).
Browser assignments use fresh owned tabs, close them in cleanup, and report stale
claims with the full session ID. Setup never opens or controls a browser.
