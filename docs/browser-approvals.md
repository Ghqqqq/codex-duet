# Browser origin consent and persistence

## All-sites browser approval

With the user's explicit opt-in, `setup --browser-approval never-ask` writes
top-level `approval_mode = "never_ask"` in the isolated `browser/config.toml`.
This permits any website through the user's logged-in browser without per-origin
prompts. It is separate from Codex's sandbox, desktop permissions, and the
request-scoped `task --approve-browser-origin` mechanism.

```sh
node plugins/codex/scripts/codex-companion.mjs setup --browser-approval never-ask --dry-run --json
node plugins/codex/scripts/codex-companion.mjs setup --browser-approval never-ask --json
node plugins/codex/scripts/codex-companion.mjs setup --browser-approval ask --dry-run --json
node plugins/codex/scripts/codex-companion.mjs setup --browser-approval ask --json
```

`ask` removes only that top-level key. It restores the runtime's ordinary origin
checks; existing persistent origin grants/denials still apply. Neither option
changes download, upload or history approval settings, origin lists, or session
files. Merges preserve other TOML text, use a private timestamped backup and an
atomic write, and are idempotent. Dry-run makes no files or runtime calls.
`setup --json` and `setup --list-browser-origins --json` expose
`browserOrigins.approval` as `never-ask`, `ask` (key absent), or `custom` (another
existing value). Workers never enable this setting after a denial.

The parent verified the installed browser service's `approval_mode`/`never_ask`
constants on 2026-10-16; this release uses that supplied evidence. Fixture tests
verify serialization, backups and removal. They do not establish live browser
behavior, bypass managed policies, or grant OS permissions. Reconnect/restart
the runtime after changing browser preferences when other live work has ended.

## Per-origin persistence

Item 15 uses the browser runtime's official persistence format. With explicit
user consent per origin, the parent can run:

```sh
node plugins/codex/scripts/codex-companion.mjs setup --list-browser-origins --json
node plugins/codex/scripts/codex-companion.mjs setup --allow-browser-origin https://example.com --dry-run --json
node plugins/codex/scripts/codex-companion.mjs setup --allow-browser-origin https://example.com --json
node plugins/codex/scripts/codex-companion.mjs setup --revoke-browser-origin https://example.com --json
```

Allow/revoke accept repeated flags and require bare HTTP(S) origins. Scheme/host
case and default ports normalize; wildcard, path (even `/`), query, fragment,
userinfo and malformed values fail before writing. A redirect/subdomain is a
separate origin. Workers never add consent or run setup after a denial.

The global file is `<CODEX_HOME>/browser/config.toml`:

```toml
[origins]
allowed = ["https://example.com"]
denied = []
```

Allow merges `allowed`, removes that exact origin from global `denied`, and
removes exact stale denies from every `browser/sessions/<threadId>.toml`. A thread
deny takes precedence over a global allow. Revoke removes the global allow and
adds a global deny, which also takes precedence over thread allows. It does not
terminate an already open tab or revoke other capabilities implicitly. Persistent
grants apply across later jobs until explicitly revoked; this differs from the
per-invocation task flag below.

All selected TOML is validated before mutation. Other settings/comments are
preserved; unchanged files are byte-exact no-ops. Each changed existing file gets
a timestamped 0600 backup before its atomic replacement, with a lock and concurrent
content check. Changed filenames/backups are reported, including repaired thread
files. Symlinks, hard links and unsupported inline/selected TOML fail clearly.
Multi-file repair is not a cross-file transaction; if an external writer races,
inspect the reported/error context and retry. Setup does not open a browser,
copy credentials, or change managed browser/network policy. Restart/reconnect
when needed to refresh a runtime's cached preferences, after other live work ends.

## Source evidence

Read-only source inspected on 2026-10-16:
`/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/@oai/browser-desktop/scripts/browser-service.mjs`.
It is minified; these are source symbols and actual line numbers:

| Symbol / line | Observed behavior |
| --- | --- |
| `wT`, line 5448 | Global relative filename `browser/config.toml`. |
| `maybeAutoAnswerBrowserUseRequest`, line 8880 | Checks persisted global and thread origins before elicitation; thread denied wins over global allowed. Global denied also overrides thread allowed. |
| `ZQ`, `Fc`, `Uc`, line 8880 | Keys are `origins`, `allowed`, `denied`. |
| `Uk`, line 5516 | Calls createElicitation for `access_browser_origin`; sends its result to handleOriginPromptResult. |
| `S_` / `oee`, line 8880 | `accept` maps to approve, `decline` to deny, all other actions to null and immediate return. Origin defaults to conversation scope unless persistence metadata selects another scope. |
| `aee`, line 8880 | Writes the allowed/denied arrays in global or session config, removing the opposing entry. |
| `Ut`, line 5516 | Accepts accept/decline/cancel as valid actions; transport errors throw approval_failed_closed. This function does not itself persist an error. |
| `hN`, line 8880 | Managed/browser-use policies remain authoritative; an allowlist does not bypass a deny policy. |

The parent's acceptance observed that the earlier `-32601` path left a per-thread
deny. The source proves how a **decline** is persisted and that **cancel** is not;
`Ut` alone does not establish where the earlier transport error became a decline.
That part remains the parent's observed runtime behavior, not a fabricated source
trace. Duet now returns a schema-valid nonpersistent cancellation for unsupported
MCP elicitations, through direct and broker transports:

```json
{"id":7,"result":{"action":"cancel"}}
```

No `_meta`, content, persistence hint or approval is added. Other unsupported
methods retain their existing `-32601` behavior. Safe summaries log
`unsupported-elicitation-nonpersistent`, method, hashed string request ID, kind,
normalized origin when available, and fixed field names/types, never full payloads.

## Per-invocation network requests

`task --approve-browser-origin <origin>` still authorizes only a schema-defined,
network-only `item/commandExecution/requestApproval` in the current thread/turn.
No command, cwd, environment, nonempty action or policy amendment is approved by
matching an origin. The exact response remains:

```json
{"id":7,"result":{"decision":"accept"}}
```

Flags are normalized/persisted/reported for that job and never inherited by a
`--thread` follow-up. This path is distinct from durable browser consent: opaque
MCP metadata never triggers an automatic accept.

Generated evidence is under ignored `.test-tmp/w5-schema`:
`ServerRequest.json#/oneOf/0`,
`#/definitions/CommandExecutionRequestApprovalParams/properties/networkApprovalContext`,
`#/definitions/NetworkApprovalContext/properties/host` and `/protocol`;
`CommandExecutionRequestApprovalResponse.json#/definitions/CommandExecutionApprovalDecision/oneOf/0`.
The cancellation response is defined by
`McpServerElicitationRequestResponse.json#/properties/action` and
`#/definitions/McpServerElicitationAction/enum` (`accept`, `decline`, `cancel`).
No guessed browser metadata approval branch is needed to close item 15.

Every browser assignment still opens a fresh session-owned tab and closes it in
cleanup, including on failure. A stale claim is `stale_browser_tab_claim` with the
full owning session ID; never steal or close an unrelated tab. No live browser or
model smoke was performed during W5. Fixture verification covers merges, backups,
idempotence, stale-deny removal and cancel replies; parent acceptance remains live.
