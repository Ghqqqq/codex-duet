# Browser origin approvals: protocol evidence and limits

The staging companion logs server callbacks and supports explicit, per-invocation
origin grants for the schema-defined network-egress request. It does **not** yet
approve the bundled CUA browser-origin elicitation. That request's metadata is
opaque in the installed app-server schema, and a live request-shape probe could
not run in this sandbox. This is the conservative schema-only fallback, not a
verified resolution of the observed Overleaf origin denial.

## Generated evidence

On 2026-10-15, the installed ChatGPT Codex CLI (`0.162.0-alpha.17.2`) generated
schemas offline, with scratch homes inside staging and no authentication copied:

```sh
mkdir -p .test-tmp/item15-schema .test-tmp/item15-home
env -i HOME="$PWD/.test-tmp/item15-home" CODEX_HOME="$PWD/.test-tmp/item15-home" TMPDIR=/private/tmp PATH=/usr/bin:/bin /Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex app-server generate-json-schema --out "$PWD/.test-tmp/item15-schema"
```

Paths below are relative to `.test-tmp/item15-schema` (ignored, excluded from
promotion). Fixture tests do not read these generated files or the installed app.

| File / JSON pointer | Evidence |
| --- | --- |
| `ServerRequest.json` `/oneOf/0/properties/method` | `item/commandExecution/requestApproval` |
| Same, `/definitions/CommandExecutionRequestApprovalParams/properties/networkApprovalContext` | Optional `NetworkApprovalContext` or null |
| Same, `/definitions/NetworkApprovalContext/properties/host` and `/properties/protocol` | Required string host and protocol enum; HTTP/HTTPS carry the scheme, host supplies the authority |
| Same, `/definitions/NetworkApprovalProtocol/enum` | `http`, `https`, `socks5Tcp`, `socks5Udp`; only HTTP(S) accepted by this flag |
| Same, `/definitions/CommandExecutionRequestApprovalParams/required` | `itemId`, `startedAtMs`, `threadId`, `turnId` |
| `CommandExecutionRequestApprovalResponse.json` `/properties/decision`, `/definitions/CommandExecutionApprovalDecision/oneOf/0` | `decision` accepts the string `accept`; separate variants permit session/policy grants, which this implementation never uses |
| `ServerRequest.json` `/oneOf/3`, `/definitions/McpServerElicitationRequestParams/oneOf/0/properties/_meta` | `mcpServer/elicitation/request`; `_meta: true` has no declared fields. Other form/url variants also leave `_meta` opaque |
| Same, `/oneOf/4`, `/definitions/RequestPermissionProfile/properties/network`, `/definitions/AdditionalNetworkPermissions/properties/enabled` | General network permission is a boolean, with no origin field; never approved by this flag |

Schema SHA-256 values:

```text
ServerRequest.json f339be472737a0003efa25fba2e6e6c9237e621cd065b6d6995c51256e9dc1fb
CommandExecutionRequestApprovalResponse.json 6d0767113e22f311381809b6b236b0dde2b99b01992879c26bf7b1ea0e003cb7
```

The protocol defines no separate port in `NetworkApprovalContext`. The handler
accepts an HTTP(S) authority in `host` (including an explicit port), and otherwise
uses that scheme's default port. It never infers a nondefault port, accepts a
SOCKS grant, or derives authority from free-text reasons or command text. This
authority interpretation is conservative and fixture-tested, not live-verified.

For a matching pure network request with ID 7, the exact JSON-RPC response is:

```json
{"id":7,"result":{"decision":"accept"}}
```

It requires the current thread and turn, a strict set of known fields, and no
command/stdin, working directory, remote environment, nonempty command actions
or policy amendments. Otherwise the existing response is retained:

```json
{"id":7,"error":{"code":-32601,"message":"Unsupported server request: item/commandExecution/requestApproval"}}
```

Explicit origin grants do not change `approvalPolicy: never`, enable interactive
prompts, or authorize general command/file permissions. A server may never emit
this supported request under that policy; tests establish handler behavior, not
that every browser/backend produces it.

## Bundled browser code: observation versus inference

Read-only inspection of
`/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/@oai/browser-desktop/scripts/browser-service.mjs`
(minified line 5516, function `Uk`) shows `createElicitation` metadata containing
`codex_approval_kind`, `codex_sensitive_action`, `connector_id`, `tool_name`,
`tool_params.origin` and `origin`. The ordinary browser path uses the
`access_browser_origin` tool name; other paths request different capabilities.
This supports the inference that CUA's denial uses MCP elicitation rather than
the command network-approval variant. It does not prove the app-server's emitted
envelope or response expectations for that call. No metadata value is treated as
permission in this implementation.

Previously `app-server.mjs` answered every callback with `-32601` without logging
it. The new handler logs method, safe ID, request kind, normalized origin when
available, decision and reason before replying. For MCP elicitation it also logs
fixed allowlisted field names/types, including the observed browser metadata
names, without values or nested page/form schemas. Arbitrary keys, free text,
URLs with paths, raw payloads and page content are not logged by this handler.
Unknown methods and string IDs are hashed. An unsupported elicitation remains
visible as `unsupported-method`; no misleading “user approved” claim is emitted.

## Probe status and parent command

No live browser probe was run and no tab was opened. Its local socket prerequisite
failed with:

```text
listen EPERM: operation not permitted /Users/ghq/Documents/Codex/2026-10-15/ban/outputs/codex-plugin-isolated.next/.test-tmp/item15-probe.sock
code=EPERM; syscall=listen
```

The parent can run this exact denied probe from the staging workspace in its
socket/network-capable, explicitly authorized environment. It deliberately has
**no** `--approve-browser-origin` flag. Use a separate staging job/broker data
directory so an older live broker cannot silently consume the callback. Normal
runtime authentication/home prerequisites must already be available; this
command is documentation, and was not executed in this assignment.

```sh
env CLAUDE_PLUGIN_DATA="$PWD/.test-tmp/browser-origin-probe-data" CODEX_COMPANION_APP_SERVER_ENDPOINT='' TMPDIR="$PWD/.test-tmp" node plugins/codex/scripts/codex-companion.mjs task --fresh --json --report --write --sandbox danger-full-access --model gpt-6-astra --effort xhigh --normal <<'BROWSER_ORIGIN_PROBE'
Perform one browser-origin approval diagnostic only. Use the installed CUA tool
documentation to call cua.createBrowserTab("chrome", "https://example.com",
{ sessionName: "Origin approval probe" }) once. Do not claim an existing tab.
No origin approval has been granted: expect denial and do not retry or add flags.
Do not inspect, snapshot, screenshot, read or report page content, and perform no
other browser actions except closing the newly created tab if creation unexpectedly
succeeds. Always clean up that owned tab using the documented API. Do not edit
files, settings or authentication. Report only success/denial, normalized origin,
whether the owned tab was closed, and a blocker if cleanup could not complete.
BROWSER_ORIGIN_PROBE
```

The stderr job handle names its log. Inspect only the lines beginning `Server
request` (after their timestamp prefix) for method, allowed field names/types and
origin. Do not copy a rollout, request payload or browser output into the repo or
report. A safe observed envelope plus runtime/schema evidence is still needed
before adding an elicitation approval branch. Fresh tabs and successful cleanup
must also be accepted live; fixtures cannot establish extension ownership.
