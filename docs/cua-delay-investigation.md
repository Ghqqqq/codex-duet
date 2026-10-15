# CUA startup and the recorded pre-tool delay

Investigation: 2026-10-15. Read-only evidence from the isolated home and installed
runtime; all new measurement artifacts live under staging `.test-tmp/`. No
browser/tool invocation, authenticated model request or live config write was
made during this investigation.

## Observed cause

The final browser task's 121.802-second pre-tool interval is dominated by failed
inference WebSocket connections followed by HTTP fallback. MCP startup was fast.
This refines the earlier fix report's tentative attribution to model effort and
tool discovery. The logs do not establish why the WebSocket connection failed
(proxy, routing, firewall or upstream transport failure remain possibilities).

Sources:

- `~/.claude/codex-isolated/logs_2.sqlite`, `logs` table, opened with SQLite
  `mode=ro`. Rows below are from the same process as row 32374 and the final task,
  avoiding unrelated concurrent workers. Timestamps combine `ts` and `ts_nanos`.
- `~/.claude/codex-isolated/sessions/2026/10/15/rollout-2026-10-15T17-59-51-01a13f00-fa09-70d1-997e-090877a69f37.jsonl`.
- `~/.claude/codex-isolated/browser-diagnostics/20261015-175950-final.meta.json`:
  elapsed 132.791 seconds, exit 0. Its stderr file is empty.
- Prior context: sibling `codex-isolated-browser-fix.md` and
  `codex-isolated-browser-diagnosis.md` in the staging workspace's parent directory.

All times below are UTC on 2026-10-15 (local time is UTC+08:00).

| Event | Time | Source |
| --- | --- | --- |
| MCP startup notifications | 09:59:51.102334 | SQLite row 32369 |
| Cached node_repl / cua_repl / codex_apps catalogs used without waiting for startup | 09:59:51.104702–.105003 | rows 32374–32376 |
| node_repl initialized | 09:59:51.207346 | row 32381 |
| WebSocket prewarm connection begins | 09:59:51.242484 | row 32383 |
| CUA initialized | 09:59:51.321241 | row 32384, CUA server instructions identify it |
| Task started | 09:59:51.486 | rollout line 3 |
| Third MCP service initialized (`plugin-runtime`) | 09:59:52.357205 | row 32397 |
| Startup WebSocket prewarm timed out | 10:00:06.104972 | row 32407 |
| Turn context recorded | 10:00:11.160 | rollout line 9 |
| Sampling WebSocket attempts begin | 10:00:11.263473 | row 32435 |
| Retry 1, timeout; backoff 200 ms | 10:00:26.172458 | row 32443 |
| Retry 2, timeout; backoff 363 ms | 10:00:41.381949 | row 32507 |
| Retry 3, timeout; backoff 766 ms | 10:00:56.757093 | row 32519 |
| Retry 4, timeout; backoff 1628 ms | 10:01:12.532460 | row 32577 |
| Retry 5, timeout; backoff 3096 ms | 10:01:29.170221 | row 32674 |
| Sixth connection begins | 10:01:32.371987 | row 32681 |
| Runtime falls back to HTTP | 10:01:47.274665 | row 32814 |
| First tool call (`js`) | 10:01:53.288 | rollout line 14 |
| Tool output | 10:01:53.488 | rollout line 17 |
| Task completed | 10:02:03.602 | rollout line 23 |

Calculated intervals: CUA startup notification to initialized **218.907 ms**;
prewarm connection to timeout **14.862488 s**; sampling connection attempts through
HTTP fallback **96.011192 s**; HTTP fallback to first tool **6.013335 s**. Task
start to recorded context is **19.674 s**; context to tool is **102.128 s**. The
tool envelope is **0.200 s**. Rollout line 23 reports first-token latency 120307 ms.
The first sampling usage record reports 59 output tokens, zero reasoning output
tokens (line 15); zero reported tokens is not proof that no internal reasoning
occurred. The timestamps and explicit retries establish the dominant delay.

There is an additional approximately five-second interval between prewarm timeout
and context recording that these selected events do not fully attribute. No
claim is made that all non-tool latency disappears under HTTP, or that the
task will meet a 30-second total deadline.

## Code and independent measurements

`plugins/codex/scripts/lib/broker-lifecycle.mjs` polls a new broker for 2000 ms
(50 ms polling), and an existing endpoint for 150 ms. Broker initialization is
before server `task_started`; there is no plugin 120-second pre-tool sleep.
`app-server.mjs` forwards protocol traffic; `codex.mjs` submits the turn and waits
for its notifications. No plugin transport retry policy was changed.

The installed official launcher is
`/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/@oai/cua-repl/dist/lib/js/oai_js_cua_repl/src/launch.js`
(minified line 1). It loads instructions, constructs tool descriptions/banner,
spawns `CUA_REPL_NODE_REPL_PATH`, and forwards stdio/signals; it contains no fixed
120-second delay. The bundled template at
`/Applications/ChatGPT.app/Contents/Resources/plugins/openai-bundled/plugins/unified-computer-use/.mcp.json`
sets `startup_timeout_sec=120`. That is a startup deadline, not a mandatory wait;
see the [official MCP options](https://developers.openai.com/codex/mcp/).

Three new stdio-only measurements used the official launcher with fresh staging
HOME/CODEX_HOME/TMPDIR, a minimal environment, and the rebuilt Chrome-only env.
Only MCP `initialize`, `notifications/initialized`, and `tools/list` were sent.
No `tools/call`, CUA JavaScript, browser connection or model call was sent. Each
new process group was terminated after listing tools; stderr was empty.

| Start UTC | Initialize elapsed | Tools list elapsed from spawn |
| --- | ---: | ---: |
| 10:44:39.013 | 31.758 ms | 31.941 ms |
| 10:44:39.046 | 29.537 ms | 29.687 ms |
| 10:44:39.078 | 28.384 ms | 28.539 ms |

Artifacts: `.test-tmp/measure-mcp.mjs`, `.test-tmp/mcp-handshake.jsonl` (ignored,
not promotion inputs). These measure metadata startup only. The raw server lists
four tools; the generated config filters out `js_add_node_module_dir`, retaining
the three template-enabled tools. Automated tests use only fixture assets and
do not run these real-runtime measurements.

## Proposed configuration and trade-offs

For this installed CLI (`0.162.0-alpha.17.2`) using isolated ChatGPT login, use the
following in the isolated user config, with the top-level key before tables:

```toml
model_provider = "openai-http"

[model_providers.openai-http]
name = "OpenAI HTTP"
base_url = "https://chatgpt.com/backend-api/codex"
wire_api = "responses"
requires_openai_auth = true
supports_websockets = false
```

This retains the observed endpoint and isolated authentication. It does not copy
credentials or change model/effort. Restart the shared runtime to load it. A
custom/API-key provider should retain its own endpoint/auth and disable WebSockets
on that selected provider instead. HTTP avoids these failed connection attempts
but forgoes persistent WebSocket continuation benefits on a healthy network.
Restoring the previous `model_provider` reverses this transport selection.
See the [provider option](https://developers.openai.com/codex/config-reference)
and [HTTP transport guidance](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).

Offline check: invoking the installed CLI's `features list` in an empty staging
home with all six settings as `-c` arguments succeeded (exit 0). Artifact:
`.test-tmp/transport-config-check-custom.txt`. The simpler
`model_providers.openai.supports_websockets=false` attempt **failed**: `model_providers
contains reserved built-in provider IDs: openai. Built-in providers cannot be
overridden.` Artifact: `.test-tmp/transport-config-check.txt`. The old
`responses_websockets` and `responses_websockets_v2` feature flags are listed as
`removed`, so they are not recommended as a transport fix. No authenticated
before/after speedup has been tested and no live settings were changed.

Lowering CUA `startup_timeout_sec` from 120 to 10 only shortens failure detection
for a stalled MCP server, risking lost tools on slower launches; it does not
affect inference WebSocket connection retries. Disabling unused node_repl removes
its tools but saves little in this measured startup (about 105 ms and concurrent
with CUA). The `omit_tools_from` settings govern tool visibility and are not
evidence of lazy startup. Keep direct CUA enabled for browser work. The plugin
therefore preserves existing node_repl and template startup policy, and documents
the provider change instead of applying it automatically.
