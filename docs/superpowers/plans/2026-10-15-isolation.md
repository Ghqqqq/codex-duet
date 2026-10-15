# Isolated Codex plugin implementation plan

> Execute inline with executing-plans; user already approved implementation.

**Spec:** docs/superpowers/specs/2026-10-15-isolation.md
**Goal:** Install a resumable Codex integration whose state and credentials remain separate from daily Codex.
**Global Constraints:** Never print credentials, never copy normal history/auth; preserve explicit model settings; no global Codex configuration mutation.
**Review Focus:** inherited SQLite and home overrides, symlinks, broker mismatch and fallback, shell quoting in resume commands, background workers, default model/effort and max propagation.

### Task 1: Implement isolated runtime and regression coverage
**Files:** plugins/codex/scripts, command/agent/runtime docs, tests, manifests.
**Interfaces:** resolveIsolatedCodexHome / isolatedCodexEnv / isolatedCodexArgs / isolatedCodexCommand consumed by all launch paths and rendered commands.
1. Add process-boundary tests asserting home/SQLite/credential flags, persistent tasks, max forwarding and isolated resume commands; run node --test tests/isolation.test.mjs. Expected: failure at missing isolation.
2. Add centralized home validation and invocation wrapper; wire direct/broker/import/resume paths; include broker home handshake; add max acceptance and local marketplace identity. Update docs and tests for changed contract.
3. Run node --test tests/*.test.mjs and npm run build. Expected: all tests pass and typecheck exits zero.
4. Commit implementation after verification.

### Task 2: Install and verify actual isolated integration
**Files:** stable outputs/codex-plugin-isolated, ~/.claude plugin registration, ~/.claude/codex-isolated, ~/.claude/CLAUDE.md.
**Interfaces:** Task 1 plugin and wrapper installed via Claude marketplace CLI.
1. Copy the verified plugin source to stable outputs path and register local marketplace; install user-scoped plugin. Expected: plugin list enabled.
2. Independently log in to isolated Codex home using same ChatGPT account. Expected: isolated auth status logged in.
3. Run real read-only task, resume it, inspect only thread identifiers in normal and isolated stores. Expected: successful result and resume, thread exists only in isolated store.
4. Validate CLAUDE.md policy, record installation and verification in outputs guide.
5. Request one fresh same-model review; resolve material findings with regression coverage. Commit final verified source.
