# Changelog

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
