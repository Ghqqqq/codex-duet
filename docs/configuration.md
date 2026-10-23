# Configuration

Back to the [README](../README.md).

Setup changes are idempotent, preserve unrelated configuration byte-for-byte,
and write timestamped backups of existing destination files. Task startup may
apply defaults automatically; new files and temporary per-task app grants have
no backup.

## Match your Codex App

Workers already default to full access and an unrestricted browser, like the
Codex app's own full-access mode. What remains to opt into is the Codex App's
installed browser/desktop tools; preview the change first from the repository
root:

```bash
plugins/codex/bin/duet setup --sync-tools --profile codex-app --replace-cua --dry-run --json
```

After reviewing the preview, rerun without `--dry-run` to apply. The defaults
can be lowered independently: `setup --default-sandbox read-only|workspace-write`
and `setup --browser-approval ask` (undo with `--default-sandbox
danger-full-access` and `--browser-approval never-ask`).
**Security:** together these grant full disk write access, desktop control, and
access to any website with the user's logged-in browser. An isolated Codex home
keeps runtime data separate; it does not confine these capabilities. Workers
still follow the assignment's scope and never elevate after a denial.

The `codex-app` profile selects the newest cached unified-computer-use `.mcp.json`
under the normal Codex home, or an explicit `--cua-template /absolute/.mcp.json`.
It mirrors the resolved `cua_repl` server, rewriting only `CODEX_HOME` and the home
entry in `NODE_REPL_TRUSTED_CODE_PATHS`. It retains Sky, instruction strings,
tool visibility/output limits and the template's timeout settings; it does not
add `tool_timeout_sec`. It reports the resulting surfaces and backends (normally
`browser,computer` and `chrome,iab,mcpapps`). Unknown/credential-bearing template
fields are rejected, and credentials are never copied. A different existing CUA
block requires `--replace-cua`; a dry-run without that flag shows the proposed
diff with old values redacted. The default `chrome` profile stays Chrome-only.
To restore that tool profile, preview and apply
`setup --sync-tools --profile chrome --replace-cua`; sandbox and browser approval
remain separate settings.

Desktop Accessibility and Screen Recording permissions must already be granted
to **Codex Computer Use.app**. Setup does not grant OS permissions or probe tools.
After changing tool/browser configuration, restart the Claude session/shared
Codex runtime when other workers have finished.

The sandbox default is stored in `<isolated-home>/duet/config.toml` and is
`danger-full-access` until you lower it. An explicit `task --sandbox <mode>` wins
for that call in either direction and needs no other flag; `--write` alone
guarantees at least workspace-write and `--write=false` requests read-only.
Lower the default with `setup --default-sandbox read-only` or `workspace-write`;
use `task --sandbox read-only` for one call. Review commands remain read-only.

The browser is unrestricted by default. Before every task the plugin mirrors
top-level `approval_mode = "never_ask"` into the isolated `browser/config.toml`
when the key is absent, so any website opens without a per-origin prompt, and
every sandbox mode (even `--sandbox read-only`) keeps network access on.
`setup --browser-approval ask` removes that key and records the choice in
`duet/config.toml` so later tasks leave it absent; existing per-origin grants
and download/upload/history settings remain unchanged, and a hand-edited custom
value is never overwritten. `setup --json` reports `defaultSandbox`,
`browserOrigins.approval` (the file) and `browserOrigins.preference` (the saved
choice); `setup --list-browser-origins --json` includes the same. See
[worker operations](worker-operations.md#codex-app-profile) and
[browser approvals](browser-approvals.md#all-sites-browser-approval-the-default).

## Computer Use app approvals

Codex's Computer Use tooling asks before it drives a macOS app. The user's own
Codex app records a "This session" choice in
`~/.codex/computer-use/sessions/<thread>.toml` and an "Always" choice in
`~/.codex/computer-use/config.toml` (`[apps] allowed`). The isolated runtime reads
its own copy, `~/.claude/codex-isolated/computer-use/`. An owned worker job
runs with approval policy `never+elicitations`: an app that is not listed there
pauses the tool call and reaches the parent as a question with four fixed
options (`Allow this call`, `Allow for this task`, `Allow always (isolated Codex
home)`, `Deny`); denied, it fails with `Computer Use was not approved to use
<App>` and the report is `blocked`.

By default (`computer_use_approval = "mirror"`) every task first copies the apps
from the user's global `[apps] allowed` list into the isolated file. Only
"always allowed" apps cross over: session-level choices and the `denied` list
are not imported. The runtime still enforces organization policy; `~/.codex` is
only read. The isolated file is validated, backed up privately if it exists and
written atomically; a second pass changes nothing.

```bash
duet setup --list-computer-apps --json          # read-only preview
duet setup --computer-use-approval ask          # stop syncing
duet setup --computer-use-approval mirror       # default
duet setup --allow-computer-app com.google.Chrome
duet setup --revoke-computer-app com.apple.finder
duet task --approve-computer-app com.google.Chrome <<'DUET_TASK'
<brief for the explicitly approved app>
DUET_TASK
```

`--allow-computer-app` adds an app to the isolated runtime even in `ask` mode;
`--revoke-computer-app` removes it and keeps it out of later mirrors until it is
allowed again. Both take bundle identifiers (`com.google.Chrome`), support
`--dry-run` and `--json`, and never run from a worker. `task
--approve-computer-app` approves only the listed apps, only for that call: the
grant is written as a session-scoped approval for the job's own thread while the
turn runs and withdrawn afterwards. `--to`/`--thread` follow-ups inherit recorded
request grants unless explicitly overridden; `--continue` inherits the selected
job's recorded grants. If the user has only ever chosen "This
session" in the Codex app, mirror finds nothing to copy; choose "Always" there,
use `--allow-computer-app`, or answer the forwarded question when a worker asks.
"Allow for this task" grants the app to that worker's thread until the turn
ends; "Allow always" adds an explicit entry to the isolated home's list, never to
`~/.codex`. Details: [Computer Use approvals](computer-use-approvals.md).

## Browser and computer-use tooling

```bash
duet setup --sync-tools --dry-run   # preview
duet setup --sync-tools             # apply
```

Copies only allowlisted browser/computer-use tool settings into the isolated home
and builds a missing `mcp_servers.cua_repl` entry from the installed template
(Chrome/browser only, paths rewritten to the isolated home). Credentials and
provider settings are never copied. For relocated installs add
`--cua-template <file>` and `--chatgpt-resources <dir>`.

Browser assignments always open a fresh, session-owned tab and close it at the
end, including on failure; they never claim an existing user tab.

## Browser origin consent

```bash
duet setup --allow-browser-origin https://www.example.com
duet setup --revoke-browser-origin https://www.example.com
duet setup --list-browser-origins
```

These write the browser runtime's own persisted approval file
(`<isolated home>/browser/config.toml`, `[origins] allowed/denied`), so the bundled
browser service auto-approves exactly that origin without a prompt. Allowing an
origin also removes stale per-thread denies for it. Origins must be bare
`scheme://host[:port]` values: no paths, trailing slash, wildcards or userinfo.
Only add origins the user has explicitly approved; Duet never adds one after a
denial.

`task --approve-browser-origin <origin>` is narrower: it approves only the
schema-defined, network-only command approval for the current turn. With the
unrestricted default and network access on in every sandbox mode it is normally
unnecessary. Unsupported browser elicitations are answered with `cancel`, which
the browser runtime does not persist as a deny. Details:
[browser approvals](browser-approvals.md).

## Model transport

```bash
duet setup --transport status   # read-only
duet setup --transport http
duet setup --transport websocket
```

Switches the isolated home between the WebSocket and HTTP ChatGPT provider. Use
`http` if startup timings show WebSocket retries (workers surface a
`startupWarning` when they do). The default is unchanged.

## Other Codex settings

Model and effort for non-worker operations can be set in
`~/.claude/codex-isolated/config.toml` or a trusted project's `.codex/config.toml`,
for example:

```toml
model = "gpt-5.4-mini"
model_reasoning_effort = "high"
```

See the [Codex configuration reference](https://developers.openai.com/codex/config-reference).


## Runtime selection

The isolated home may contain `runtime.json` with an absolute `codexBinary` path;
`CODEX_COMPANION_BIN` overrides it; otherwise `codex` on PATH is used. A binary
change affects newly started runtimes; an existing workspace broker keeps its
executable until it exits (after 60 s idle by default) or is restarted.
A custom absolute `CODEX_COMPANION_HOME` is supported; homes overlapping
the normal Codex home are rejected. Failures never fall back to the normal
session store.

## Claude instructions and conversation imports

Task dispatch automatically forwards Claude's loaded CLAUDE.md/rules through
Codex's `developerInstructions`. Only the first `prompt.context` in each Claude
session can capture managed, user, project and local instruction files, including
loaded imports; auto-memory entries are excluded. Later contexts are ignored
because this event has no agent attribution. CLAUDE.md edits apply from the next
Claude session. The forwarded text is capped at 60,000 UTF-16 units,
including executor framing and omission notes. `duet result <worker> --details`
includes `claudeMd` metadata: source, completeness, approximate status and omissions.

If the first loaded inventory is unavailable or incomplete, no snapshot is saved;
Duet uses an approximate startup scan of
readable managed policy, user CLAUDE.md/rules and the ancestors of the Claude
session's directory (the worker cwd when that is unknown). It cannot
reproduce effective settings, exclusions, external-import approvals, inline
policy or later path-triggered rules. Managed environments skip user-supplied `prompt.context` hooks, so a personally
installed plugin uses this fallback there.

Threads retain the instructions captured at their creation. Start a new Claude
session and a fresh task to apply changed instructions. To disable forwarding,
start a fresh task:

```bash
duet task --fresh --no-claude-md <<'DUET_TASK'
<brief>
DUET_TASK
```

`CODEX_COMPANION_CLAUDE_MD=0` disables forwarding globally for processes that
inherit it. Opting out on a thread that already has forwarded instructions is
rejected; use a fresh task. These opt-outs do not disable Codex's own AGENTS.md
loading or its CLAUDE.md project fallback. `duet setup --project-docs agents-only`
removes Duet's exact `project_doc_fallback_filenames = ["CLAUDE.md"]` default
from the isolated config; custom lists remain unchanged.

`duet task --fork` imports the current Claude transcript into a new Codex thread,
then runs the stdin brief. The recorded label is “imported Claude conversation
(fidelity not verified)”. It does not promise a lossless copy of Claude's context.
`--source '<jsonl>'` overrides the source; the file must resolve beneath
`~/.claude/projects/`. Imports above the byte limit fail rather than truncate.
`--fork` cannot combine with `--to`, `--thread`, `--continue` or resume flags;
use `--to` after the fork completes.

| Environment variable | Effect |
| --- | --- |
| `CODEX_COMPANION_CLAUDE_MD=0` | Disable instruction capture/forwarding; use a fresh thread to opt out |
| `CODEX_COMPANION_IMPORT_MAX_BYTES` | Positive integer import byte limit; default 20 MiB (20,971,520 bytes) |
| `CODEX_COMPANION_SESSION_ID` | Session scope, exported by SessionStart; `--session <id>` overrides it |
| `CODEX_COMPANION_TRANSCRIPT_PATH` | Current Claude JSONL transcript, exported by SessionStart; `--source` overrides it for imports |

Without a session ID, the launcher warns and scopes jobs to the workspace; they
are not linked to a Claude session. Use `duet task --help` for dispatch options.
