# Reproducible inference transport validation

Status: offline implementation and fixture coverage only. No authenticated
comparison was run in the implementation environment. HTTP-only remains an
unverified mitigation for the [recorded CUA delay](cua-delay-investigation.md).
The WebSocket failure's network/root cause remains unknown.

## Offline implementation record

Implementation baseline: `Ghqqqq/codex-duet` main `2027b9505f1d1801e2af0b50a958324776a817c6`.
The Linux execution environment has Node `24.19.0` and an explicitly located
Codex CLI `0.159.2` (different from the investigated local `0.162.0-alpha.17.2`).
Both WS/HTTP custom-provider `features list` checks exited 0 in empty homes.
Offline JSON-schema generation also exited 0 and confirmed `thread/start`
supports `config`, `modelProvider`, sandbox and policy fields. These checks did
not initialize CUA or submit authenticated inference.

The final dedicated diagnostic suite passed all 12 tests. The full-suite run
reported 156 passes, 9 skips and one existing failure, `background worker preserves
fast mode and isolated home`, also observed on the unmodified baseline. Its
isolated rerun passed. Nine local-socket tests were skipped by the repository's
existing EPERM capability gate; no sandbox changes were made to bypass it.
The diagnostic fixtures separately exercise opt-in gating, same-provider
WS/HTTP/rollback, auth/config preservation, evidence redaction, unsupported
configuration, missing/wrong/erroring tools, timeouts and external config drift.

## Scope

`scripts/diagnose-transport.mjs` reuses Duet's isolated-home resolution, direct
app-server client, request-denial policy and process-group cleanup helper. No
production transport layer, persistent provider setting or shared broker changes.

The sequence is **WS-capable → HTTP-only → WS-capable rollback**, each in a fresh
app-server/ephemeral thread. Both arms use the same temporary provider ID, name,
ChatGPT endpoint and auth semantics. Only `supports_websockets` changes. WS-capable
runs can still fall back to HTTP; requested and observed transport are separate.

The fixed prompt requests one arithmetic evaluation in `cua_repl`, without
browser connection, navigation, tab claim or network action. It measures CUA tool
invocation/completion, subject to tool instructions. It does not validate Origin
permission, browser ownership or a complete browser task. Missing CUA, prohibited
probes and unrecognized tool event shapes produce invalid samples. A shell call
cannot substitute for CUA to manufacture a pass.

## Local procedure

From the repository root, use macOS/Linux, Node 18.18+ and an already installed
Codex CLI. `CODEX_COMPANION_BIN` or existing isolated `runtime.json` selects the
same executable as Duet. No installation/login is performed. Each output
directory must be new.

1. Run offline tests and installed-CLI parser checks:

   ```bash
   node --test tests/transport-diagnostics.test.mjs
   mkdir -p .test-tmp
   node scripts/diagnose-transport.mjs check \
     --out .test-tmp/transport-config-check
   ```

   `check` runs `features list` twice in a fresh empty temporary home with a
   minimal environment, then removes it. No real credentials, MCP startup, tools
   or inference. Exit 0 establishes parsing only. The historical parser result
   for `0.162.0-alpha.17.2` remains in the investigation; fixture tests cannot
   establish acceptance by the operator's installed CLI.

2. Finish competing Duet/browser work. Keep cwd, tool configuration, network/proxy
   route and exact model/effort fixed. Reuse existing setup/status diagnostics;
   no tool sync, timeout reduction or new Origin approval belongs in this test.
   Replace both model/effort placeholders:

   ```bash
   node scripts/diagnose-transport.mjs run --live \
     --home "$HOME/.claude/codex-isolated" \
     --model '<same model ID for every run>' \
     --effort '<same supported effort>' \
     --timeout-ms 180000 \
     --out .test-tmp/transport-comparison-01
   ```

   `--live` enables up to three authenticated turns using existing isolated
   login. Account status uses `refreshToken:false`. The script never reads/copies
   credential files or issues login/logout/config-write RPCs. The runtime's
   ordinary authentication/refresh behavior still applies during inference.

   Preflight accepts built-in `openai` with ChatGPT login and the standard
   endpoint only. Custom providers, explicit endpoints and API-key/access-token
   environment overrides fail before inference. Those cases need a separate
   reviewed experiment preserving endpoint, headers and auth. The existing home
   must pass Duet's isolation checks; the normal Codex home cannot be selected.

   Each child uses `thread/start.config`, `read-only` sandbox and
   `approvalPolicy:never`. No browser origins are approved. The runtime must
   acknowledge provider/model/policy before inference. Timeouts/interrupts stop
   only this diagnostic's process group, including app-server/MCP children.
   Partial recognized evidence is retained. A turn timeout still allows the
   rollback attempt when preflight/configuration were acknowledged. Interrupts,
   failed preflight, unacknowledged configuration and config drift stop the run.

3. Repeat at least three sequences with new directories and unchanged settings.
   The final WS arm brackets HTTP to expose order effects. Fresh processes do
   not imply cold OS/model/prompt caches. Report every sample, failure and
   median/spread; one fast turn is insufficient.

## Results

`comparison.json` and per-arm JSON retain selected metadata/sanitized evidence
with private file modes. No raw RPC payloads, tool arguments/results, credentials,
log URLs or arbitrary runtime errors are exported. Known errors have stable
codes; others have a fingerprint/stage for local correlation. Prefer `threadId`:
`launcherPid` may identify a wrapper rather than its native child. Keep reports
under ignored `.test-tmp/` and review even sanitized metadata before sharing.

| Field | Meaning / limitation |
| --- | --- |
| `config-check.json` / `parsed` | Empty-home CLI parser acceptance; no inference |
| `configurationAcknowledged` | Thread accepted provider/model/policy; no proof of wire transport |
| `timingsMs.initialize` | App-server JSON-RPC startup, **not CUA MCP startup** |
| `processToFirstTool` | Worker start to receipt of first tool-start event |
| `threadRequestToFirstTool` | Before thread/start to first tool; includes thread prewarm |
| `turnRequestToFirstTool` | Before turn/start request to first tool |
| `turnStartedToFirstTool` | Receipt of turn/started to first tool; null if absent |
| `firstTool.isCua`, `firstTool.isJs`, `toolCompleted` | Recognized CUA JS invocation / completion without structured tool error |
| `transportBeforeFirstTool` | Evidence received before first tool event |
| `transport` | Whole-child evidence, including prewarm/later requests |
| `effectiveConfigSha256` | Pre-override effective config hash; differences invalidate a controlled comparison |
| `configUnchanged` | Isolated config.toml bytes match before/after; not all external config files |
| `rollback` | Config integrity, final WS probe status and observed transport |

Durations use a monotonic clock in milliseconds and client event arrival. They
are not interchangeable with server rollout timestamps or the historical
**121.802 s** interval. For paired differences, use a consistent boundary,
normally `threadRequestToFirstTool` to include prewarm:

\[
\Delta_i = \frac{L_{\mathrm{WS,before},i}+L_{\mathrm{WS,rollback},i}}{2}
           - L_{\mathrm{HTTP},i}.
\]

Report both WS observations too: disagreement can reveal cache/load drift. This
estimates a local difference, without identifying the network fault or proving
a universal transport advantage.

## Evidence rules and existing-log fallback

A successful `codex.websocket_request` records a WebSocket request; a 2xx
`codex.api_request` specifically at the Responses endpoint records HTTP. A
connected socket, /models request, generic SSE event, selected flag or fallback
announcement alone is insufficient. Some versions use SSE telemetry for
WebSockets too. Prewarm requests count, so all observed transports are listed
without attributing every tool-generating response to one.

Failure counts prefer `codex.websocket_connect` telemetry (including outer
timeouts), otherwise connection-error log records. Both sources can appear for
one attempt; do not sum them as distinct failures. Zero means zero recognized
records, not proof of no failures. Missing/unsupported records yield `unknown`.

The process-local RUST_LOG filter enables connection/request metadata, without
payload trace logging. Versions may route telemetry to SQLite instead of stderr
or change record shapes. Empty stderr cannot establish HTTP success. Reuse the
investigation's read-only SQLite workflow: inspect the installed schema, select
only the matching thread/process and time window, and export text retaining the
runtime target. Never mix concurrent workers. Then:

```bash
node scripts/diagnose-transport.mjs analyze --log '<scoped runtime log export>'
```

Unsupported formats remain unknown and require inspection of that installed
runtime. References for record shapes and settings:

- [Fallback](https://github.com/openai/codex/blob/main/codex-rs/core/src/client.rs)
- [WebSocket logs](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/endpoint/responses_websocket.rs)
- [Request telemetry](https://github.com/openai/codex/blob/main/codex-rs/otel/src/events/session_telemetry.rs)
- [Thread overrides](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/v2/ThreadStartParams.ts)
- [Provider configuration](https://developers.openai.com/codex/config-reference)

## Acceptance and rollback

- **Configuration:** both installed-CLI parser checks pass. Fixture success alone
  cannot satisfy this gate.
- **CUA startup:** compared arms acknowledge policy, invoke CUA, complete the tool
  and complete the turn. Browser success is a separate gate.
- **Latency improvement:** repeated valid samples with matching config/model/
  effort show a stable decrease, with HTTP request evidence and an explanation
  of WS retries/fallback. Missing evidence, failed tools or one fast sample is
  inconclusive. `latencyImprovementVerified` stays false for manual review.
- **Rollback:** config bytes remain unchanged; the final WS-capable probe runs and
  records transport even if it falls back. Exiting drops temporary selection.
  Config drift stops the sequence without overwriting external changes.
- **Browser acceptance:** after transport evidence is satisfactory, repeat the
  original read-only browser task through normal Duet with its already approved
  origins, capturing rollout/log timings. The arithmetic probe does not expand
  permissions or predict browser-task duration. Approval failures remain a
  separate issue. This PR applies no persistent HTTP setting.

Reverting the diagnostic commit removes the change. No migration, credential
restore or production broker restart is required.
