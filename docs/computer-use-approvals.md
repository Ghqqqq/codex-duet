# Computer Use app approvals

Codex's Computer Use tooling (the `node_repl` MCP server bundled with the Codex
app, `cua.getApp(...)`, `sky.get_app_state(...)`) asks for permission before it
drives a macOS application. This document records where that permission lives,
how the isolated runtime used by Duet workers handles it, and what Duet does so
that workers see the same approvals as the user's own Codex app.

## Findings (Codex app 0.162.0-alpha.17.2, cua_node bundle)

- The elicitation is issued by `computer-use-policy.js` inside `node_repl`:
  `createElicitation({ message: 'Allow Computer Use to use "<App>"?', meta: {
  codex_approval_kind: "mcp_tool_call", connector_id: "computer-use",
  connector_name: "Computer Use", persist: ["session", "always"], riskLevel,
  tool_name, tool_params: { app: "<bundle id>" }, tool_params_display } })`.
  The request is accepted when the answer carries
  `content.source === "computer-use-persisted-state"` (node_repl found a stored
  approval) or `action === "accept"`; anything else throws
  `Computer Use was not approved to use <App display name>`. Organization and
  safety policy produce `Computer Use is blocked from using the app '<id>' by
  your organization's policy` and `Computer Use is not allowed to use the app
  '<id>' for safety reasons`.
- Persistence is node_repl's own, under `$CODEX_HOME/computer-use/`
  (parsed with `toml_edit`):
  - `sessions/<thread-id>.toml` — the "This session" choice (`conversation` scope);
  - `config.toml` — the "Always" choice (`global` scope);
  both with `[apps] allowed = [...]` and `denied = [...]`.
  The user's Codex app on this machine had only a session file, so the app had
  been allowed for one conversation, not "always".
- The isolated runtime starts node_repl with `CODEX_HOME=<isolated home>`
  (`~/.claude/codex-isolated`), so it consults
  `<isolated home>/computer-use/` — empty on a fresh install. Duet runs turns
  with `approvalPolicy: "never"`; under that policy Codex resolves the
  elicitation itself and the worker never receives a server request (a failing
  job log shows no `Server request` lines). An approval therefore has to be
  present in node_repl's persisted state before the tool call; answering the
  prompt at run time is only possible on runtimes that forward it, which Duet
  also supports.

## What Duet does

### Mirror (default)

`computer_use_approval = "mirror"` in `<isolated home>/duet/config.toml`
(absent means mirror). Before every task, `ensureComputerUseApproval()` runs one
idempotent pass:

```text
isolated allowed = (current − previously mirrored − revoked)
                 ∪ (user's ~/.codex/computer-use/config.toml [apps].allowed − revoked)
```

- Source: only the user's **global** `[apps] allowed` list. Session files, the
  `denied` list, malformed entries and unreadable files are ignored. The user's
  home (`CODEX_COMPANION_NORMAL_HOME`, else `CODEX_HOME`, else `~/.codex`; never
  the isolated home) is only read; the fixture tests prove it by hashing every
  file under it before and after.
- Target: `<isolated home>/computer-use/config.toml`, only the `[apps] allowed`
  key. `denied` and other tables are left alone. Writes go through the same
  path as the browser settings: symlink/hard-link refusal, a `.duet-lock`,
  a private `0600` backup, atomic rename, `0700` directories, and no write when
  nothing changed.
- Bookkeeping: `computer_use_mirrored_apps` and `computer_use_revoked_apps` in
  `duet/config.toml` remember which entries came from the mirror and which the
  user withdrew, so a later `ask` removes exactly the mirrored ones and a
  revoked app stays out until it is allowed again.

### Ask

`setup --computer-use-approval ask` stops the sync and removes previously
mirrored apps from the isolated file. Explicitly allowed and hand-written entries
stay. Apps without an approval are denied by the runtime and reported as
blockers.

### Individual apps

```bash
setup --allow-computer-app <bundle id>     # add (also clears a revocation)
setup --revoke-computer-app <bundle id>    # remove; excluded from later mirrors
setup --list-computer-apps [--json]        # read-only
setup … --dry-run                          # preview changedFiles without writing
```

Bundle identifiers are validated (`com.google.Chrome`: reverse-DNS labels, no
spaces or wildcards) before any file is touched, and invalid input is not
echoed. The JSON result (`computerUse`) lists `preference`, `file`,
`allowed: [{ app, source: "mirrored" | "explicit" }]`, `revoked`,
`codexApp: { file, allowed, readable }`, `changedFiles`, `backups` and `dryRun`;
`setup --json` includes the same summary without writing. Workers never run
`setup`.

### Per-call approval

`task --approve-computer-app <bundle id>` (repeatable) approves only the listed
apps for that call. Two mechanisms cover both runtimes:

- Before `turn/start` the apps are merged into
  `<isolated home>/computer-use/sessions/<thread id>.toml` `[apps] allowed`, the
  session-scoped persisted state node_repl consults on every app request, and
  the file is restored (or removed) when the turn ends, even on failure.
- If the runtime forwards the elicitation (`mcpServer/elicitation/request` with
  `_meta.connector_id = "computer-use"`), the policy accepts it only for an
  exact bundle-id match on the current thread/turn, with
  `{ action: "accept" }` and no `_meta.persist`, so nothing outlives the request.
  Everything else is cancelled (`cancel` is not persisted as a deny).

A follow-up with `--thread` does not inherit the grant; `task --continue` does,
and rejects the flag. The job record, `status`, `result` and the report show
`approvedComputerApps`.

## Honest blocking

A denied authorization is a blocker, not a success. Reports use
`status: "blocked"` (exit code 2, like `needs_input`) with structured
`blockers` entries:

| `code` | fields | source |
| --- | --- | --- |
| `computer_use_app_not_approved` | `app` | cancelled/declined elicitation (bundle id) or `Computer Use was not approved to use <App>` in a tool result or the final answer (display name) |
| `computer_use_app_blocked_by_policy` | `app` | organization policy message |
| `computer_use_app_forbidden` | `app` | safety policy message |
| `browser_tab_debugger_unattached` | `tabId`, `sessionId`, `closed` | `Debugger unattached` in the final answer; `closed` is `false` when the worker says it could not close the tab, `true` when it did, absent when unknown |
| `stale_browser_tab_claim` | `tabId`, `sessionId` | `Tab <id> is already part of browser session <uuid>` |
| `reported_blocked` | — | the final answer starts with "Blocked"/"阻塞" or states `status: blocked` |
| `needs_input` / `error` | — | question-only answers; non-zero exit |

Tool-call blockers are captured from completed `mcpToolCall` items while the
turn runs; only the matched identifiers are retained, never the tool arguments or
payload. Each entry carries a short `message`; `blockersOmitted` counts entries
dropped to keep the report within 60 lines. A `blocked` report also includes
`continuationCommand` so the parent can resume after fixing the approval.

## Tab cleanup on `Debugger unattached`

The worker contract asks for: discard the stale binding, re-obtain the tab by id
through the browser session and close it; if that fails, report the tab id, the
session name and that the tab could not be closed, and let the parent decide.
Duet does not reach into Chrome itself; the report makes the leftover visible.

## Verification

Fixture tests (`tests/computer-use-approvals.test.mjs`,
`tests/server-requests.test.mjs`, `tests/worker-report.test.mjs`) run with
temporary user and isolated homes under the test-home guard and cover: mirror
from a user file with allowed, denied and session-level entries; idempotency;
`ask` removing mirrored apps while keeping explicit ones; allow/revoke/list and
dry runs; rejection of invalid bundle ids before any write; unchanged hashes for
every file under the user's Codex home; the per-call session file observed by
the fake runtime at `turn/start` and removed afterwards; an elicitation accepted
with the flag and cancelled without it (report `blocked`, non-empty `blockers`,
exit 2); and a refusal that surfaces only through a tool result.

Live verification against the real runtime is a manual step for the parent
session: `setup --allow-computer-app com.google.Chrome` followed by a small task
that calls `cua.getApp("Google Chrome")`, then `setup --computer-use-approval ask`
and the same task reporting `blocked`.

Observed live (codex-cli 0.162.0-alpha.17.2): `setup --allow/--revoke/--list`
on the real homes left every file under `~/.codex/computer-use` byte-identical;
a `task --approve-computer-app com.apple.finder` wrote
`computer-use/sessions/<thread>.toml` for the turn and removed it afterwards;
Codex's own "Status: blocked" answers came back as `status: blocked`, exit 2.
`cua.getApp(...)` resolves the app's window **before** the approval gate, so an
app without an enumerable window fails with `Computer Use server error -10005:
cgWindowNotFound` whether or not it is approved; that error is not an approval
problem and is not classified as one. Finder (always has the Desktop window) is
also allowed by Codex's own policy without an elicitation, so it cannot be used
to prove the gate. Re-run the Chrome check while Chrome has a visible window.

## Limitations

- "This session" approvals in the user's Codex app are not mirrored; choose
  "Always" there or use `--allow-computer-app`.
- The file formats belong to node_repl; a future Codex release may change them.
- Whether a warm, long-running node_repl re-reads the files between tool calls
  is runtime behaviour; a cold start (new broker) always sees the current files.
