# Configuration

Back to the [README](../README.md).

Setup changes are idempotent, preserve unrelated configuration byte-for-byte,
and write timestamped backups of existing destination files. Task startup may
apply defaults automatically; new files and temporary per-task app grants have
no backup.

Setup and tool sync share one PID-aware `.duet-lock` per destination file,
with a bounded wait and a content recheck before replacement. Comments,
including commented-out assignments, are preserved. New keys extend existing
dotted paths in their current section instead of adding conflicting tables.

## Match your Codex App

Workers already default to full access and an unrestricted browser, like the
Codex app's own full-access mode. What remains to opt into is the Codex App's
installed browser/desktop tools; preview the change first from the repository
root:

```bash
plugins/codex/bin/fugato setup --sync-tools --profile codex-app --replace-cua --dry-run --json
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

Before any write, including a dry-run or an otherwise identical definition,
`codex-app` validates a regular executable node file and a regular readable CUA
launcher. Missing or stale asset paths fail without a config write or backup;
repair the installation or select a current template before retrying.

Desktop Accessibility and Screen Recording permissions must already be granted
to **Codex Computer Use.app**. Setup does not grant OS permissions or run live tools.
`setup --json` checks the configured enabled CUA executable locally and reports
`tools.cuaReplReason` when it cannot launch. Other assets and extension connections
remain unprobed. Missing optional CUA tools do not by themselves make core
runtime/invocation/authentication readiness (`ready`) false.
After tool/browser configuration changes, run `fugato runtime restart` when
other workers have finished to reload configuration on the next task. Restart
Claude when switching to a different isolated home. A changed Codex binary is
handled automatically; see [runtime selection](#runtime-selection).

The sandbox default is stored in `<isolated-home>/duet/config.toml` and is
`danger-full-access` until you lower it. An explicit `task --sandbox <mode>` wins
for that call in either direction and needs no other flag; `--write` alone
guarantees at least workspace-write and `--write=false` requests read-only.
Lower the default with `setup --default-sandbox read-only` or `workspace-write`;
use `task --sandbox read-only` for one call. Review commands and the optional
stop review gate always run read-only, including in plan mode; the configured
default does not apply to the gate.

The browser is unrestricted by default. Before every task the plugin mirrors
top-level `approval_mode = "never_ask"` into the isolated `browser/config.toml`
when the key is absent, so any website opens without a per-origin prompt, and
with permission mapping off, every sandbox mode (even `--sandbox read-only`)
keeps network access on.
`setup --browser-approval ask` removes that key and records the choice in
`duet/config.toml` so later tasks leave it absent; existing per-origin grants
and download/upload/history settings remain unchanged, and a hand-edited custom
value is never overwritten. `setup --json` reports `defaultSandbox`,
`browserOrigins.approval` (the file) and `browserOrigins.preference` (the saved
choice); `setup --list-browser-origins --json` includes the same. See
[worker operations](worker-operations.md#codex-app-profile) and
[browser approvals](browser-approvals.md#all-sites-browser-approval-the-default).

## Claude permission mapping (opt-in)

`fugato setup --permission-mapping claude|off` controls native agents' mapping
from Claude permission modes to Codex sandbox and approval policy. The default
is `off`: the configured Codex sandbox and existing approval behavior apply.
The setting is saved as `permission_mapping` in `<isolated-home>/duet/config.toml`.
Run this change separately from other setup changes; `--dry-run` previews it.

```bash
fugato setup --permission-mapping claude --dry-run
fugato setup --permission-mapping claude
fugato setup --permission-mapping off
```

With mapping enabled, the native adapter supplies the current Claude mode:

| Claude mode | Codex sandbox | Codex approval policy |
| --- | --- | --- |
| `default` | workspace-write | `untrusted` |
| `acceptEdits` | workspace-write | `on-request` |
| `dontAsk`, `auto` | workspace-write | `never` (no action approvals) |
| `plan`, absent or unknown | read-only | `never` |
| `bypassPermissions` | explicit sandbox, else saved sandbox, else workspace-write | `on-request`, or `never` if read-only |

An explicit sandbox can narrow the mapped ceiling; it cannot widen it except
as selected in bypass mode. Role presets still enforce their own sandbox and
plan mode remains read-only. Mapped read-only/workspace-write turns disable
sandbox network access; workspace-write excludes the default `/tmp` and
`TMPDIR` write grants. Browser-origin settings remain separate.

Writable roots are the resolved cwd, or the isolation worktree plus its validated
private Git index/state directory. With `isolation: "worktree"` (also detected
under `.claude/worktrees`), `DUET: --cwd` cannot escape that worktree, and full
access is clamped to workspace-write. Shared Git refs/objects are not added to
writable roots; access requiring approval must be approved per action. A changed
Claude mode cannot be applied to a live turn: it is stopped before continuing.

Supported Codex command/file approval requests become parent questions with
`question.kind: "action-approval"` and choices `Allow once` / `Deny`. Only the
exact answer `Allow once` approves that action; numbers, prose, timeout and stale
answers deny it. Requests whose operation cannot be displayed exactly within
the size limit, malformed requests and persistent root grants are refused.

This maps sandbox and approval requests only. Claude allow/deny rules, the
auto-mode classifier and PreToolUse do not apply to Codex actions. With mapping
off, worktree placement alone does not confine a full-access Codex worker.

## Task budgets (opt-in)

Both defaults are `off`. Save limits for new task turns with
`fugato setup --default-max-minutes <n|off>` and
`fugato setup --default-max-tokens <n|off>` (`default_max_minutes` and
`default_max_tokens` in the shared Fugato config). Minutes accept a positive
number, including fractions; tokens require a positive integer. The two flags
can combine with each other, `--dry-run` and `--json`, but run separately from
other setup changes.

```bash
fugato setup --default-max-minutes 10 --default-max-tokens 100000 --dry-run
fugato setup --default-max-minutes 10 --default-max-tokens 100000
fugato setup --default-max-minutes off --default-max-tokens off
```

Override either default for one task with `--max-minutes <n>` or
`--max-tokens <n>`; native agents accept both in the `DUET:` header. Per-task
flags require positive values, not `off`. Each new task turn gets a fresh budget;
follow-ups use the current defaults unless given explicit limits. Reaching a
limit interrupts the turn and adds a `budget_exceeded` blocker. Wall time excludes
queueing and parked parent questions; tokens are this turn's total, excluding
earlier turns. Token consumption can overshoot by one usage update. See
[operating examples](worker-operations.md#task-budgets).

## Worker context and concurrency

These settings are shared by workspaces using the same isolated home and are
off by default. The two setup flags can combine with each other, `--dry-run`
and `--json`, but run separately from other setup changes.

| Flag | Default | Effect and example |
| --- | --- | --- |
| `--agent-memory on\|off` | `off` | Load Fugato-owned memory keyed by canonical workspace and agent role (the preset type for native agents). Enable with `fugato setup --agent-memory on`; disable with `fugato setup --agent-memory off`. |
| `--max-concurrent <n\|off>` | `off` | Queue new Codex turns at a Fugato-wide cap across workspaces/processes sharing this home. Set a positive integer with `fugato setup --max-concurrent 4`; clear with `fugato setup --max-concurrent off`. |

Memory is stored under `<isolated-home>/duet/agent-memory/<workspace-hash>/<role-hash>/MEMORY.md`
and loaded up to 200 lines / 25 KiB. Workers may update it only when their
existing sandbox permits that path; enabling memory grants no extra write
access. Current native dispatch records `codex:codex-native` for memory/skill
lookup, including preset agents; these presets therefore share that memory scope.
Ordinary companion workers use the `worker` scope.

At task dispatch, a best-effort Git preamble includes branch/upstream and at
most 40 changed paths (a 1.5 s status-read deadline). It is on by default; opt
out with `CODEX_COMPANION_GIT_CONTEXT=0`. Skills declared by the plugin's public
agent definition can be preloaded as bounded text; skills merely invoked in
the parent are not forwarded. The shipped native/preset definitions currently
declare no skills. Fork import omissions are visible as `forkSlice` in
`fugato result <worker> --details`; see [worker context](worker-operations.md#worker-context).

## Default worker models

Discover the current account's model names with `fugato models` (or `--json`),
then choose using the returned descriptions and supported efforts. Add `--all`
to include hidden models. Agents load the model-invocable `codex:models` skill
when asked to check, compare or change worker models or efforts, or when a
dispatch fails on an unknown model. Do not rely on remembered model names.

Save worker defaults in `<isolated-home>/duet/config.toml`, alongside the sandbox
and orchestration-mode preferences:

| Setting | Use and built-in default | Setup flag |
| --- | --- | --- |
| `defaultModel` | Configured worker model (default `gpt-6-astra`) for ordinary delegation, pair, duel and ultra's strong tier: verification, judging and hard debugging | `--default-model <model\|default>` |
| `defaultEffort` | Worker effort (default `xhigh`) for ordinary delegation, pair and duel; ultra retains its effort by stage | `--default-effort <effort\|default>` |
| `ultraRoutineModel` | Configured routine model (default `gpt-6.1-sol`) for ultra's scans, implementation and ordinary review | `--ultra-routine-model <model\|default>` |

An explicit user choice in the conversation or an explicit `--model`/`--effort`
on a call wins. Dispatch precedence is explicit flags, then recorded thread
settings on follow-ups, then saved defaults, then built-ins. Changing a saved
default does not replace an existing thread's recorded settings. Missing,
invalid or malformed preferences fall back to the built-in value; reading them
does not throw.

```text
fugato setup --default-model <model|default> [--default-effort <effort|default>] [--ultra-routine-model <model|default>]
```

Each flag can also be used alone. The three flags may combine with one another
and `--dry-run`, but not with another setup change such as `--default-mode` or
`--default-sandbox`. All supplied values are validated before any write.
`/codex:setup` passes the same flags:

```bash
fugato setup --default-model gpt-6.1-sol --default-effort high --ultra-routine-model gpt-6.1-sol --dry-run
fugato setup --default-model gpt-6.1-sol --default-effort high --ultra-routine-model gpt-6.1-sol
/codex:setup --default-model gpt-6-astra --default-effort xhigh
fugato setup --ultra-routine-model spark
```

Use `default` to remove the corresponding saved key and restore its built-in:

```bash
fugato setup --default-model default --default-effort default --ultra-routine-model default
```

Model names use the existing alias normalization (`spark` remains an alias for
`gpt-5.3-codex-spark`), then must match `/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/`.
Effort accepts `none`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`, plus
efforts listed by any model in Codex's isolated `models_cache.json` (including
hidden models). Setup and hooks check the cache synchronously and never start
a runtime. The static set applies when the cache is missing.
The selected model/runtime must support the effort. `--default-model` and
`--ultra-routine-model` must also appear in the isolated model cache when it is
available; hidden models count. When the cache was fetched within the last
24 hours, an unknown name is refused before any write, with a hint to refresh
the cache through `fugato models` and retry. With an older cache, or without a
usable cache, a syntactically valid name is accepted with a warning. Codex
refreshes the cache whenever it starts a runtime, so `fugato models` also
refreshes it; `fugato models --all` includes hidden models. Cache validation does
not prove that a later dispatch will succeed.

The setup change returns a JSON report with `file`, `defaultModel`,
`defaultEffort` and `ultraRoutineModel`, showing each effective value and its
`source` (`saved` or `built-in`). No-argument `fugato setup` status includes the
same effective values; human output adds
`Default models: worker <model>/<effort>, ultra routine <routineModel>.`
Mode reminders name the effective values. `fugato ultra-codex status`,
`fugato pair status` and `fugato duel status` show
`models: worker <model>/<effort>, ultra routine <routineModel>`; their JSON has
`models: { model, effort, routineModel }`.

`fugato models` prefers the official app-server `model/list` API and falls back to
the isolated cache when the runtime or method is unavailable. It reports the
source and fetch time. The JSON envelope is `{ source, fetchedAt, models, tiers }`;
each model has `slug`, `displayName`, `description`, `efforts`, `defaultEffort`,
`contextWindow`, `visibility` and `inUse` (`strong`, `routine`, or both).
`tiers.strong`, `tiers.effort` and `tiers.routine` each contain `value` and
`source` (`saved` or `built-in`). Fetch time is the retrieval time for the API
or the cache's recorded fetch time. An unavailable context window is `null`
(`unknown` in text); the pinned app-server schema does not expose it. Cache
identity and account credentials are never included. If both sources are
unavailable, the command exits nonzero with a `/codex:setup` hint.

## Worker dispatch

`fugato setup --dispatch auto|native|bash|default` changes the guidance Claude
receives about dispatching workers. Run it separately from other setup changes;
`--dry-run` previews the change. The saved `dispatch` key lives in
`<isolated-home>/duet/config.toml`; `fugato setup --json` reports the effective route.

| Route | Guidance |
| --- | --- |
| `auto` (built-in default) | Start with the native agent; prefer background Bash after a recent native-unavailable observation. |
| `native` | Always advertise native dispatch, even with a recorded unavailable observation. |
| `bash` | Use background `fugato task` through `codex:native-fallback` from the first dispatch. |
| `default` | Remove the saved route and restore `auto`. |

Fugato records an unavailable observation when the host never delivers the native
turn start. `auto` honors it for 24 hours after the last observation, or until
`fugato setup --dispatch` is run without `--dry-run`. These settings change guidance
rather than disable a tool: explicit native calls remain possible. See the
[dispatch recipe](direct-mode.md#native-subagent-default).

## Roundtable persona models

`fugato setup --persona-model <id>=<model>[:<effort>]` saves defaults in
`[roundtable.personas.<id>]` in `<isolated-home>/duet/config.toml`. Repeat it
for different personas; `<id>=default` removes both saved fields. A model-only
change clears an earlier saved effort, allowing the intensity's built-in effort
adjustment. Ordinary worker defaults do not override this mapping.

Run mapping changes separately from all other setup changes. `--dry-run --json`
validates and previews without writing. Persona ids, model syntax/catalog and
supported reasoning efforts are checked before any write. Setup JSON includes
`personaModels.<id>.model` and `.effort`, each `{ value, source }` with source
`saved` or `built-in`; reported built-in efforts are for standard intensity.
See [Roundtable models](roundtable.md#models-and-redefinition) for defaults,
intensity shifts, per-room overrides and examples.

## Default orchestration mode

`fugato setup --default-mode off|ultra|pair|duel|roundtable` saves the mode for fresh Claude
sessions and `/clear`. Run it separately from other setup changes; add
`--dry-run` to preview it. The `defaultMode` key lives in
`<isolated-home>/duet/config.toml`; `off` is stored explicitly. Missing or invalid
values also mean `off`, the default for new installs. `fugato setup --json` and
each mode's `status --json` report `defaultMode`.

This is opt-in because active orchestration consumes Codex quota, and duel also
consumes Claude quota. Each fresh session uses the mode's standard options:
ultra has auto scale and auto workers, pair has no options, duel has three
rounds, and roundtable has standard intensity with a chair-recommended roster.
Per-session `on`, `off` and switches leave the saved default unchanged;
resume and compaction preserve the session's choice, including off. Save `off`
to stop automatic activation in future sessions.

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
fugato setup --list-computer-apps --json          # read-only preview
fugato setup --computer-use-approval ask          # stop syncing
fugato setup --computer-use-approval mirror       # default
fugato setup --allow-computer-app com.google.Chrome
fugato setup --revoke-computer-app com.apple.finder
fugato task --approve-computer-app com.google.Chrome <<'DUET_TASK'
<brief for the explicitly approved app>
DUET_TASK
```

`--allow-computer-app` adds an app to the isolated runtime even in `ask` mode;
`--revoke-computer-app` removes it and keeps it out of later mirrors until it is
allowed again. Both take bundle identifiers (`com.google.Chrome`), support
`--dry-run` and `--json`, and never run from a worker. `task
--approve-computer-app` approves only the listed apps, only for that call: the
grant is written as a session-scoped approval for the job's own thread while the
turn runs and withdrawn afterwards; stale task grants after worker death are
released at the next start or recovery. `--to`/`--thread` follow-ups inherit
original request grants only from the same Claude session, unless explicitly
overridden; `--continue` inherits only eligible recorded grants. Runtime-only
approvals and foreign dispatches after adoption are excluded. An explicit
`--thread` may still inherit model, effort, sandbox and speed across sessions.
If the user has only ever chosen "This session" in the Codex app, mirror finds nothing to copy; choose "Always" there,
use `--allow-computer-app`, or answer the forwarded question when a worker asks.
"Allow for this task" grants the app to that worker's thread until the turn
ends; "Allow always (isolated Codex home)" adds an explicit entry to the isolated
home's list, never to `~/.codex`. Submit only an exact displayed option label,
its number `1`–`4`, or `call`/`once`/`task`/`always`/`deny`/`no`. Answers are
trimmed and case-insensitive; exact labels allow a trailing period. Anything
else, including `yes` or an explanation appended to a choice, denies the request.
Details: [Computer Use approvals](computer-use-approvals.md#forwarded-approvals-owned-jobs).

## Browser and computer-use tooling

```bash
fugato setup --sync-tools --dry-run   # preview
fugato setup --sync-tools             # apply
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
fugato setup --allow-browser-origin https://www.example.com
fugato setup --revoke-browser-origin https://www.example.com
fugato setup --list-browser-origins
```

These write the browser runtime's own persisted approval file
(`<isolated home>/browser/config.toml`, `[origins] allowed/denied`), so the bundled
browser service auto-approves exactly that origin without a prompt. Allowing an
origin also removes stale per-thread denies for it. Origins must be bare
`scheme://host[:port]` values: no paths, trailing slash, wildcards or userinfo.
Only add origins the user has explicitly approved; Fugato never adds one after a
denial.

`task --approve-browser-origin <origin>` is narrower: it approves only the
schema-defined, network-only command approval for the current turn. With
permission mapping off, the unrestricted default keeps sandbox network access on, so it is normally
unnecessary. Unsupported browser elicitations are answered with `cancel`, which
the browser runtime does not persist as a deny. Details:
[browser approvals](browser-approvals.md).

## Model transport

```bash
fugato setup --transport status   # read-only
fugato setup --transport http
fugato setup --transport websocket
```

Switches the isolated home between the WebSocket and HTTP ChatGPT provider. Use
`http` if startup timings show WebSocket retries (workers surface a
`startupWarning` when they do). The default is unchanged.

## Other Codex settings

Model and effort defaults for direct Codex CLI sessions through
`codex-isolated.mjs`, without explicit CLI overrides, can be set in
`~/.claude/codex-isolated/config.toml` or a trusted project's `.codex/config.toml`,
for example:

```toml
model = "gpt-5.4-mini"
model_reasoning_effort = "high"
```

`/codex:review` and adversarial reviews pass the saved
[worker defaults](#default-worker-models) or built-ins explicitly unless overridden
on the call; these `config.toml` model settings do not apply to them.

See the [Codex configuration reference](https://developers.openai.com/codex/config-reference).


## Runtime selection

The isolated home may contain `runtime.json` with an absolute `codexBinary` path;
`CODEX_COMPANION_BIN` overrides it; otherwise `codex` on PATH is used. A binary
change is detected automatically: new work bypasses a stale workspace broker
and uses a private runtime. An idle stale broker is asked to retire; a busy one
keeps serving its active work. No Claude restart is needed for a binary change.
Setup reports `codex.warning.code: "desktop_managed_codex_runtime"` when the
selected executable or its resolved symlink target is under
`~/.codex/plugins/.plugin-appserver/` or
`ChatGPT.app/Contents/Resources/codex-cli/`. Desktop-app updates can stop the
app-servers launched from these managed CLIs; a ChatGPT desktop auto-update was
one observed cause of interrupted turns. Pin a stable CLI, such as an installed
npm `@openai/codex` binary, with `CODEX_COMPANION_BIN` or `runtime.json`'s
`codexBinary`. Setup includes the warning even when the CLI is available; it
does not change the pin or make `ready` false.

If a pinned runtime is missing or unusable, setup may probe PATH's `codex` to
enrich its repair guidance, but it still reports the broken pin. These optional
version/help probes share setup's 45-second deadline, with a 20-second cap per
probe and no probe when the budget is exhausted. Repair or remove the pin to
select another runtime; installing a global Codex does not override it.
A custom absolute `CODEX_COMPANION_HOME` is supported; homes overlapping
the normal Codex home are rejected. Failures never fall back to the normal
session store.

## Claude instructions and conversation imports

Task dispatch automatically forwards Claude's loaded CLAUDE.md/rules through
Codex's `developerInstructions`. Only the first `prompt.context` in each Claude
session can capture managed, user, project and local instruction files, including
loaded imports; auto-memory entries are excluded. The scan fallback resolves
auto-memory directories and candidate files to real paths, excluding indirect
aliases even when their names contain no memory-directory component. This also
covers symlinked configuration and memory directories. Later contexts are ignored
because this event has no agent attribution. CLAUDE.md edits apply from the next
Claude session. The forwarded text is capped at 60,000 UTF-16 units,
including executor framing and omission notes. `fugato result <worker> --details`
includes `claudeMd` metadata: source, completeness, approximate status and omissions.

A valid loaded inventory remains authoritative even when the capture budget
truncates it: omissions are reported without scanning filtered-out files back
in. If the first inventory is unavailable or invalid, no snapshot is saved;
Fugato uses an approximate startup scan of
readable managed policy, user CLAUDE.md/rules and the ancestors of the Claude
session's directory (the worker cwd when that is unknown). It cannot
reproduce effective settings, exclusions, external-import approvals, inline
policy or later path-triggered rules. Managed environments skip user-supplied `prompt.context` hooks, so a personally
installed plugin uses this fallback there. Project and local files, `.claude/rules`
and their `@` imports are read only when their real path lies inside the ancestor
directory that owns them: a repository's symlinked `.claude` or `.claude/rules`
cannot pull in files from elsewhere on disk. User and managed profiles may still be
symlinks.

User instructions/rules and auto-memory exclusions use an absolute
`CLAUDE_CONFIG_DIR` when set, otherwise `~/.claude`. Missing, empty or relative
values fall back to `~/.claude` for instruction scanning and transcript imports.
Real-path exclusions also cover symlinked profile and memory directories; the
loaded inventory, when available, remains authoritative.
When the selected profile resolves to a different directory from `HOME/.claude`,
the fallback ancestor scan skips that unselected default profile's CLAUDE.md and
rules. A workspace under HOME therefore does not pick them up as project
instructions. The comparison uses real paths, including symlinked profiles.

Threads retain the instructions captured at their creation. Start a new Claude
session and a fresh task to apply changed instructions. To disable forwarding,
start a fresh task:

```bash
fugato task --fresh --no-claude-md <<'DUET_TASK'
<brief>
DUET_TASK
```

`CODEX_COMPANION_CLAUDE_MD=0` disables forwarding globally for processes that
inherit it. Opting out on a thread that already has forwarded instructions is
rejected; use a fresh task. These opt-outs do not disable Codex's own AGENTS.md
loading or its CLAUDE.md project fallback. `fugato setup --project-docs agents-only`
removes Fugato's exact `project_doc_fallback_filenames = ["CLAUDE.md"]` default
from the isolated config; custom lists remain unchanged.
When forwarding covers every project CLAUDE.md on the worker's path and no
`.codex/config.toml` on that path sets `project_doc_fallback_filenames`, the thread
disables that default fallback to avoid duplicate delivery. On runtimes that
reject per-thread config, the compatibility retry drops the override, so Codex's
own CLAUDE.md fallback stays on and project instructions can arrive twice; see
[delivery to workers](claude-md.md#delivery-to-workers).

`fugato task --fork` imports the current Claude transcript into a new Codex thread,
then runs the stdin brief. The recorded label is “imported Claude conversation
(fidelity not verified)”. It does not promise a lossless copy of Claude's context.
`--source '<jsonl>'` overrides the source; the file must resolve beneath
the selected Claude profile's `projects/` directory (`~/.claude/projects/` by
default), including when the profile root is symlinked. Both discovered and
explicit sources are checked by real path; sources or symlink targets outside
that root are refused. Private fork/transfer staging and abandoned-stage cleanup
use that same profile's projects root. Imports above the byte limit fail rather than truncate.
`--fork` cannot combine with `--to`, `--thread`, `--continue` or resume flags;
use `--to` after the fork completes.

| Environment variable | Effect |
| --- | --- |
| `CLAUDE_CONFIG_DIR` | Absolute Claude profile root for fallback instructions/rules, auto-memory exclusions, transcript discovery/validation and import staging/cleanup; missing, empty or relative values use `~/.claude` for these operations |
| `CODEX_COMPANION_CLAUDE_MD=0` | Disable instruction capture/forwarding; use a fresh thread to opt out |
| `CODEX_COMPANION_CONNECT_TIMEOUT_MS` | Positive integer deadline for starting and initializing the Codex runtime (broker startup and direct fallback included) for tasks, reviews and transfers; default 60,000 ms |
| `CODEX_COMPANION_IMPORT_MAX_BYTES` | Positive integer cap on the Claude transcript read for `--fork`; default 128 MiB |
| `CODEX_COMPANION_FORK_BUDGET_BYTES` | Positive integer byte budget for the post-compaction slice a fork imports; default 2 MiB (about 175k tokens) |
| `CODEX_COMPANION_SESSION_ID` | Session scope, exported by SessionStart; `--session <id>` overrides it |
| `CODEX_COMPANION_TRANSCRIPT_PATH` | Current Claude JSONL transcript, exported by SessionStart; `--source` overrides it for imports |

Without a session ID, the launcher warns and scopes jobs to the workspace; they
are not linked to a Claude session. Use `fugato task --help` for dispatch options.
