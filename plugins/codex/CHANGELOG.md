# Changelog

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
