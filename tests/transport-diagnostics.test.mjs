import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { makeTempDir, run } from "./helpers.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { providerArgs, providerOverrides, requireStandardChatGPT, transportEvidence } from "../scripts/diagnose-transport.mjs";

const script = fileURLToPath(new URL("../scripts/diagnose-transport.mjs", import.meta.url));
function fixture(behavior = "transport-probe") {
  const dir = makeTempDir("transport-probe-");
  const bin = path.join(dir, "bin"); fs.mkdirSync(bin);
  installFakeCodex(bin, behavior);
  const home = path.join(dir, "isolated"); fs.mkdirSync(home);
  const normal = path.join(dir, "normal"); fs.mkdirSync(normal);
  for (const target of [home, normal]) {
    fs.writeFileSync(path.join(target, "config.toml"), '# unchanged fixture config\nmodel_provider = "openai"\n');
    fs.writeFileSync(path.join(target, "auth.json"), "DO_NOT_READ_OR_COPY_AUTH");
  }
  const env = { ...buildEnv(bin), CODEX_COMPANION_HOME: home, CODEX_HOME: normal,
    CODEX_COMPANION_APP_SERVER_ENDPOINT: "unix:///must-not-connect" };
  const out = path.join(dir, "output");
  return { dir, bin, home, normal, env, out, invoke: (...args) => run(process.execPath, [script, ...args], { cwd: dir, env }),
    state: () => JSON.parse(fs.readFileSync(path.join(bin, "fake-codex-state.json"), "utf8")) };
}
function liveArgs(f, ...rest) { return ["run", "--live", "--home", f.home, "--model", "fixture-model", "--effort", "low", "--out", f.out, ...rest]; }
const readReport = f => JSON.parse(fs.readFileSync(path.join(f.out, "comparison.json"), "utf8"));

test("paired providers differ only in capability; never override reserved openai", () => {
  const ws = providerOverrides("ws"); const http = providerOverrides("http");
  ws["model_providers.duet-transport-probe"].supports_websockets = false;
  assert.deepEqual(ws, http);
  assert.equal(http["model_providers.duet-transport-probe"].requires_openai_auth, true);
  assert.ok(providerArgs("http").includes("model_providers.duet-transport-probe.supports_websockets=false"));
  assert.ok(!providerArgs("http").some(arg => arg.startsWith("model_providers.openai.")));
  assert.throws(() => providerOverrides("auto"));
});

test("transport evidence distinguishes connection, fallback and actual successful requests", () => {
  const log = [
    'INFO node_repl: successfully connected to websocket: browser',
    'INFO codex_otel::events::session_telemetry: event.name="codex.api_request" http.response.status_code=200 endpoint="/models"',
    'INFO codex_otel::events::session_telemetry: event.name="codex.api_request" http.response.status_code=401 endpoint="/responses"',
    'INFO codex_otel::events::session_telemetry: event.name="codex.sse_event" event.kind="response.completed"',
    '2026-10-15T09:59:51.242484Z INFO codex_api::endpoint::responses_websocket: connecting to websocket: SECRET',
    'ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: timed out SECRET',
    'INFO codex_api::endpoint::responses_websocket: successfully connected to websocket: SECRET',
    'WARN codex_core::client: falling back to HTTP'
  ].join("\n");
  const unknown = transportEvidence(log);
  assert.deepEqual(unknown.observedRequestTransports, ["unknown"]);
  assert.equal(unknown.wsConnectionFailures, 1);
  assert.equal(unknown.httpFallbacks, 1);
  assert.equal(unknown.events[0].timestamp, "2026-10-15T09:59:51.242484Z");
  assert.ok(!JSON.stringify(unknown).includes("SECRET"));
  const actual = transportEvidence(log + '\nINFO codex_otel::events::session_telemetry: event.name="codex.websocket_request" success="true"\nINFO codex_otel::events::session_telemetry: event.name="codex.api_request" http.response.status_code=200 endpoint="https://chatgpt.com/backend-api/codex/responses"');
  assert.deepEqual(actual.observedRequestTransports, ["websocket", "http"]);
  assert.deepEqual(transportEvidence("").observedRequestTransports, ["unknown"]);
  const timedOut = transportEvidence(log + '\nINFO codex_otel.trace_safe: event.name="codex.websocket_connect" success="false" duration_ms=15000 error.message="request timed out"');
  assert.equal(timedOut.wsConnectionFailures, 1, "do not double-count error and telemetry for one attempt");
  assert.equal(timedOut.wsFailureCountSource, "connect_telemetry");
  assert.equal(timedOut.events.at(-1).durationMs, 15000);
  assert.deepEqual(transportEvidence('INFO codex_otel.trace_safe: event.name="codex.api_request" http.response.status_code=200 endpoint="responses"').observedRequestTransports, ["http"]);
});

test("preflight refuses a changed endpoint, custom provider or API-key authentication", () => {
  const account = { account: { type: "chatgpt" } };
  requireStandardChatGPT({}, account, {});
  for (const config of [{ model_provider: "custom" }, { chatgpt_base_url: "https://proxy.invalid" }, { openai_base_url: "https://proxy.invalid" }, { model_providers: { "duet-transport-probe": {} } }]) {
    assert.throws(() => requireStandardChatGPT(config, account, {}));
  }
  assert.throws(() => requireStandardChatGPT({}, { account: { type: "apiKey" } }, {}));
  assert.throws(() => requireStandardChatGPT({}, account, { OPENAI_API_KEY: "secret" }));
});

test("offline check uses empty homes, strips credentials/broker and submits no inference", () => {
  const f = fixture(); f.env.OPENAI_API_KEY = "SECRET";
  const result = f.invoke("check", "--out", f.out);
  assert.equal(result.status, 0, result.stderr);
  const state = f.state();
  assert.equal(state.appServerStarts, 0);
  assert.equal(state.configChecks.length, 2);
  for (const check of state.configChecks) {
    assert.equal(check.inheritedApiKey, false); assert.equal(check.inheritedBroker, false);
    assert.notEqual(check.home, f.home); assert.notEqual(check.home, f.normal);
    assert.equal(fs.existsSync(check.home), false, "staging removed");
  }
  assert.equal(JSON.parse(result.stdout).latencyImprovementVerified, false);
});

test("live operation is opt-in and unsupported CLI stops before app-server", () => {
  const f = fixture("transport-unsupported");
  const missingFlag = f.invoke(...liveArgs(f).filter(arg => arg !== "--live"));
  assert.notEqual(missingFlag.status, 0); assert.equal(fs.existsSync(f.out), false);
  const result = f.invoke(...liveArgs(f));
  assert.equal(result.status, 2, result.stderr);
  assert.equal(f.state().appServerStarts, 0);
});

test("fresh WS/HTTP/rollback runs preserve auth/config and capture first tool separately from transport", { skip: process.platform === "win32" }, () => {
  const f = fixture();
  const result = f.invoke(...liveArgs(f));
  assert.equal(result.status, 0, result.stderr);
  const report = readReport(f);
  assert.deepEqual(report.samples.map(s => s.mode), ["ws", "http", "ws"]);
  assert.equal(report.rollback.configuration, "unchanged");
  assert.equal(report.rollback.probe, "probe_completed");
  assert.deepEqual(report.rollback.transport, ["http"], "rollback restores WS capability, not guaranteed WS connectivity");
  assert.equal(report.latencyImprovementVerified, false);
  for (const sample of report.samples) {
    assert.equal(sample.outcome, "probe_completed");
    assert.ok(sample.timingsMs.threadRequestToFirstTool >= sample.timingsMs.turnRequestToFirstTool);
    assert.ok(sample.timingsMs.turnRequestToFirstTool >= 0);
    assert.equal(sample.toolCompleted, true);
    assert.deepEqual(sample.transport.observedRequestTransports, ["http"]);
  }
  assert.equal(report.samples[0].transport.wsConnectionFailures, 1);
  assert.equal(report.samples[1].transport.wsConnectionFailures, 0);
  const state = f.state();
  assert.equal(state.appServerStarts, 3, "no shared broker");
  assert.deepEqual(state.transportTurns.map(t => t.ws), [true, false, true]);
  for (const turn of state.transportTurns) {
    assert.equal(turn.thread.sandbox, "read-only");
    assert.equal(turn.params.approvalPolicy, "never");
    assert.equal(turn.params.effort, "low");
    assert.equal(turn.params.model, "fixture-model");
    assert.equal(turn.params.serviceTier, null);
  }
  for (const home of [f.home, f.normal]) {
    assert.equal(fs.readFileSync(path.join(home, "config.toml"), "utf8"), '# unchanged fixture config\nmodel_provider = "openai"\n');
    assert.equal(fs.readFileSync(path.join(home, "auth.json"), "utf8"), "DO_NOT_READ_OR_COPY_AUTH");
  }
  assert.ok(!result.stdout.includes("DO_NOT_LOG"));
  assert.ok(!result.stdout.includes("DO_NOT_READ_OR_COPY_AUTH"));
});

for (const behavior of ["transport-no-tool", "transport-tool-error", "transport-ignored", "transport-wrong-tool"]) {
  test(`${behavior} cannot be reported as a successful probe`, { skip: process.platform === "win32" }, () => {
    const f = fixture(behavior); const result = f.invoke(...liveArgs(f));
    assert.equal(result.status, 2, result.stderr);
    assert.ok(readReport(f).samples.every(s => s.outcome !== "probe_completed"));
    if (behavior === "transport-ignored") assert.equal(f.state().transportTurns, undefined);
  });
}

test("deadline retains partial connection evidence and reports missing first tool", { skip: process.platform === "win32" }, () => {
  const f = fixture("transport-hang");
  const result = f.invoke(...liveArgs(f, "--timeout-ms", "1500"));
  assert.equal(result.status, 2, result.stderr);
  const report = readReport(f);
  assert.equal(report.samples[0].outcome, "timeout");
  assert.equal(report.samples[0].firstTool, null);
  assert.equal(report.samples[0].transport.wsConnectionFailures, 1);
  assert.equal(report.rollback.configuration, "unchanged");
});

test("configuration drift stops the sequence without overwriting external changes", { skip: process.platform === "win32" }, () => {
  const f = fixture("transport-mutate-config");
  const result = f.invoke(...liveArgs(f));
  assert.equal(result.status, 2, result.stderr);
  const report = readReport(f);
  assert.equal(report.samples.length, 2);
  assert.equal(report.rollback.configuration, "changed");
  assert.equal(report.rollback.probe, "not_run");
  assert.match(fs.readFileSync(path.join(f.home, "config.toml"), "utf8"), /fixture mutation/);
});
