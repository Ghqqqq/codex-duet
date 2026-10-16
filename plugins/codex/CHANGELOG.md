# Changelog

## 1.0.6-isolated.10

- Add opt-in `setup --sync-tools --profile codex-app`: mirror the newest resolved unified-computer-use cache template (or `--cua-template`), rewriting only home/trust-home fields. Preserve desktop/Sky, Chrome/IAB/MCP Apps, instructions, tool visibility/output limits and template timeouts without injecting a short tool timeout. Keep Chrome-only sync as the default profile; reject unknown/credential-bearing template fields.
- Preview changed CUA fields safely and refuse replacement without `--replace-cua`. Replace the whole server and subtables with the existing backup/atomic-write protections; report resulting surfaces/backends.
- Persist plugin-wide `setup --default-sandbox read-only|workspace-write|danger-full-access`. Tasks without per-call flags use the setting; write-capable defaults imply write. Explicit flags win, reviews stay read-only, and workers rely on the configured default without self-elevating after a denial.
- Add `setup --browser-approval never-ask|ask` to merge/remove only top-level browser approval_mode, with offline dry-run and private backups. Preserve download/upload/history settings, origin lists and session files. Expose browser approval and sandbox defaults in setup JSON.
- Document the independent opt-ins, full disk/desktop/logged-in-browser security implications, rollback and restart requirements. Add fake-template and fake-runtime coverage for mirroring, discovery, replacement/refusal, default persistence/precedence and browser merge/removal; no live home or desktop/browser changes are required by tests.

## 1.0.6-isolated.9

- Narrow env-style redaction to uppercase assignments (case-sensitive) so ordinary flags such as `--effort=xhigh` stay readable in the feed; keyword-named keys/tokens/passwords/secrets/credentials remain redacted case-insensitively.
- Stream redacted activity into native worker Bash output: assistant snippets, command lines/exits/durations, file changes, tool names/status/durations and plan titles. Wait returns on activity after a default 10-second minimum, with a 30-second maximum, per-owner persistent cursors, and one final JSON line; `--json` stays pure JSON. Tool arguments, command outputs and page payloads are excluded.
- Generate unique per-job owners and retain Claude session identity separately. Only explicit matching owners renew unexpired leases; parent status/result and ownerless waits never renew. Keep legacy session-ID-owned jobs readable and SessionEnd-scoped.
- Restrict worker SendMessage to the exact companion-provided questionMessage for needs_answer. Final results use the agent return value; progress/completion claims and placeholder evidence are forbidden.
- Adopt a stopped worker's running job from a replacement worker: atomically rotate ownership and renew the lease without starting another turn; retired owners report ownership_moved. Claude Code stopped agents cannot resume, so launching a replacement requires explicit user consent. Expired/ended jobs report an unexecuted task --thread continuation command. Status shows stale owners as orphaned with remaining lease seconds and the exact adopt instruction.
- Add fake app-server coverage for streaming/early return, independent cursors, redaction and excluded payloads, per-job renewal, adoption/expiry and retired-owner rejection, legacy records and question formatting. Document parent live acceptance and the inferred orphan threshold.

## 1.0.6-isolated.8

- Rename the marketplace to `duet`; the install ID becomes `codex@duet`. The plugin name, `/codex:*` commands and `codex:codex-worker` agent are unchanged. README documents the upgrade path and plugin-data migration.

## 1.0.6-isolated.7

- Run native workers as one detached task with owner-renewed leases and bounded `wait` progress snapshots. Show startup phases, safe item summaries and WebSocket retry warnings in logs and reports.
- Register experimental `ask_parent` for same-turn questions, add stdin `answer`, and route native Agent questions to `main` with SendMessage. Bound unanswered questions to 15 minutes; retain final `needs_input` when registration is unavailable.
- Interrupt on cancellation, lease expiry, session end and worker signals; distinguish confirmed turn completion from unconfirmed cancellation. Prewarm the shared broker without blocking SessionStart, exit idle brokers and reap owned app-server process groups.
- Harden fixture isolation with temporary homes/data, real-home/executable guards, a spawned-process ledger and teardown survivor assertions. Explain the inherited-environment path behind the archived baseline leak.
- Add explicit, backed-up, idempotent `setup --transport http|websocket|status` without changing defaults. Add official browser allow/revoke/list setup, preserving unrelated TOML and removing exact stale per-thread denies when granting consent.
- Return nonpersistent MCP elicitation cancel instead of unsupported errors; document installed browser-service decline/cancel persistence and schema evidence. Keep per-task network-origin grants separate from durable browser consent.
- Add fixture coverage for progress, questions, timeouts, interruption, session cleanup, broker idle exit, home guards and setup merges. Live model/browser acceptance remains a separate parent check.

## 1.0.6-isolated.6

- Require fresh session-owned browser tabs and cleanup; classify full-UUID stale tab claims as distinct blockers with the owning session ID.
- Add repeatable, strictly validated `task --approve-browser-origin` grants with per-invocation persistence/reporting and no follow-up inheritance. Approve only schema-defined, current-turn, network-only requests with an exact normalized origin; retain unsupported replies for broader requests.
- Log safe server-request summaries and denial reasons through direct and broker transports; route broker replies only from the owning client. Add fixture coverage for policy, parsing, persistence, reset, redaction and report limits.
- Document generated protocol evidence and the blocked live probe. Opaque CUA MCP origin elicitations remain unsupported pending an observed request shape; do not treat the new flag as a verified fix for that path. Keep this unpromoted staging iteration at isolated.6.

- Build missing Chrome-only `cua_repl` and env tables from installed bundled templates and validated ChatGPT resources, with strict setting/value allowlists and isolated home/trust paths. Preserve existing CUA and node_repl sections.
- Add `setup --sync-tools --cua-template <file> --chatgpt-resources <dir>` selectors, exact append-only dry-run output, fail-before-write resource checks, and CUA configuration availability. Retain timestamped private backups, locking and concurrent-edit checks.
- Add fixture-only coverage for CUA discovery, path reconstruction, secret rejection, missing assets, idempotence, CLI validation and inline-table conflicts.
- Trace the recorded pre-tool delay to WebSocket prewarm/connection retries before HTTP fallback; document an isolated provider transport workaround and its trade-offs without changing user settings or task model/effort defaults.

## 1.0.6-isolated.5

- Fix status mislabeling a saved shared runtime as direct startup when the inherited endpoint variable is empty.
- Make broker tests skip explicitly only when a socket bind probe is denied; require an actual broker when sockets are available, and add a socket-free runtime-label regression test.
- Track task edits with before/after content, mode and index hashes in dirty workspaces, merge turn file-change events, and report pre-existing changes and coverage separately. Interrupted recovery conservatively uses exact-turn events.
- Add deliberate `task --sandbox read-only|workspace-write|danger-full-access` overrides with strict validation, explicit `--write` for write-capable policies, background persistence and policy reporting. Preserve default policies and reset elevation on follow-up turns; approvals remain noninteractive.
- Test dirty trees with 26 shell-edited files, policy propagation/reset, visible socket skips and bounded reports with the additional metadata.

## 1.0.6-isolated.4

- Distinguish unreachable network/socket/sandbox auth probes from logout; keep isolated login guidance only for confirmed missing auth.
- Add offline `setup --sync-tools --dry-run`, additive allowlisted tool sync with backups and overlap checks, and configuration-only tool availability.
- Default worker/rescue Bash calls outside the sandbox, with one safe transport retry and no interactive worker prompts. Document optional user-level permission/exclusion settings and browser timeout diagnostics.
- Add compact `--report` output, private raw-output artifacts, early job/thread/turn handles and read-only status/result recovery by job or tracked thread.
- Emit progress and periodic item/tool/activity heartbeats on stderr and logs without changing JSON stdout.
- Inject conservative-assumption task guidance and report question-only/unfinished answers as `needs_input` without starting another turn.
- Isolate all test homes and runtime environment; cover sync, transport classification, bounded reports and interrupted-wrapper recovery with fixtures.

## 1.0.0

- Initial version of the Codex plugin for Claude Code
