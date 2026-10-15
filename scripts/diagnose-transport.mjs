#!/usr/bin/env node
// Opt-in diagnostics only; production broker/config/auth paths are unchanged.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { CodexAppServerClient } from "../plugins/codex/scripts/lib/app-server.mjs";
import { isolatedCodexArgs, isolatedCodexEnv, resolveCodexBinary, resolveCodexRuntimeIdentity, resolveIsolatedCodexHome } from "../plugins/codex/scripts/lib/codex-home.mjs";
import { terminateProcessTree } from "../plugins/codex/scripts/lib/process.mjs";
import { parseArgs } from "../plugins/codex/scripts/lib/args.mjs";

const SELF = fileURLToPath(import.meta.url);
const PROVIDER = "duet-transport-probe";
const BASE_URL = "https://chatgpt.com/backend-api/codex";
const LOG_FILTER = "warn,codex_api::endpoint::responses_websocket=info,codex_otel::events::session_telemetry=info,codex_otel.trace_safe=info";
export const PROBE_PROMPT = "Use the configured cua_repl JavaScript tool exactly once to evaluate 1 + 1, then report the result. Do not initialize or access a browser, network, files, shell, or another tool. If the tool is unavailable or its instructions prohibit this probe, report that and stop.";
const sha = value => createHash("sha256").update(value).digest("hex");
const json = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });

export function providerOverrides(mode) {
  if (!["ws", "http"].includes(mode)) throw new Error("Expected ws or http mode.");
  return {
    model_provider: PROVIDER,
    [`model_providers.${PROVIDER}`]: {
      name: "OpenAI", base_url: BASE_URL, wire_api: "responses",
      requires_openai_auth: true, supports_websockets: mode === "ws"
    }
  };
}

export function providerArgs(mode) {
  const config = providerOverrides(mode);
  const provider = config[`model_providers.${PROVIDER}`];
  return ["-c", `model_provider=${JSON.stringify(PROVIDER)}`,
    ...Object.entries(provider).flatMap(([key, value]) => ["-c", `model_providers.${PROVIDER}.${key}=${JSON.stringify(value)}`])];
}

// Only recognized runtime records are retained. Never return URLs, headers,
// prompts, arbitrary error messages or full JSON-RPC notifications.
export function transportEvidence(stderr) {
  const events = [];
  for (const [index, raw] of stderr.split(/\r?\n/).entries()) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, "");
    let kind = null;
    if (/codex_api::endpoint::responses_websocket\b/.test(line)) {
      if (/successfully connected to websocket:/i.test(line)) kind = "ws_connected";
      else if (/failed to connect to websocket:/i.test(line)) kind = "ws_connect_failed";
      else if (/connecting to websocket:/i.test(line)) kind = "ws_connect_attempt";
    }
    if (/codex_core::client\b/.test(line) && /falling back to HTTP\b/.test(line)) kind = "http_fallback";
    if (/codex_otel(?:::events::session_telemetry|\.trace_safe)\b/.test(line)) {
      if (/event.name="?codex\.websocket_connect"?(?:\s|$)/.test(line)) {
        if (/\bsuccess="?false"?(?:\s|$)/.test(line)) kind = "ws_connect_result_failed";
        else if (/\bsuccess="?true"?(?:\s|$)/.test(line)) kind = "ws_connect_result_success";
      }
      if (/event.name="?codex\.websocket_request"?(?:\s|$)/.test(line) && /\bsuccess="?true"?(?:\s|$)/.test(line)) kind = "ws_request_success";
      if (/event.name="?codex\.api_request"?(?:\s|$)/.test(line) &&
          /http.response.status_code=2\d\d\b/.test(line) &&
          /endpoint="?(?:responses|(?:https:\/\/[^\s"?]+)?\/responses)"?(?:\s|$)/.test(line)) kind = "http_response_success";
    }
    if (kind) events.push({ line: index + 1, kind,
      timestamp: /^\d{4}-\d\d-\d\dT[\d:.]+Z/.exec(line)?.[0] ?? null,
      ...(kind.startsWith("ws_connect_result") ? { durationMs: Number(/\bduration_ms=(\d+)/.exec(line)?.[1] ?? NaN) || null } : {}),
      ...(["ws_connect_failed", "ws_connect_result_failed"].includes(kind) ? { failureClass: /timed? ?out|timeout/i.test(line) ? "timeout" : "other" } : {}) });
  }
  const observed = [];
  if (events.some(e => e.kind === "ws_request_success")) observed.push("websocket");
  if (events.some(e => e.kind === "http_response_success")) observed.push("http");
  const telemetry = events.some(e => e.kind.startsWith("ws_connect_result"));
  return { observedRequestTransports: observed.length ? observed : ["unknown"], events,
    wsFailureCountSource: telemetry ? "connect_telemetry" : "connection_error_log",
    wsConnectionFailures: events.filter(e => e.kind === (telemetry ? "ws_connect_result_failed" : "ws_connect_failed")).length,
    httpFallbacks: events.filter(e => e.kind === "http_fallback").length };
}

// Keep this deliberately narrow: custom/API-key/proxy providers need a separate
// reviewed experiment that preserves their own headers, endpoint and auth.
export function requireStandardChatGPT(config, account, env) {
  if ((config.model_provider ?? "openai") !== "openai" || account?.account?.type !== "chatgpt") {
    throw Object.assign(new Error("Probe requires the existing built-in openai provider and ChatGPT login."), { code: "unsupported_provider_or_auth" });
  }
  if (config.openai_base_url || config.chatgpt_base_url || config.model_providers?.openai || config.model_providers?.[PROVIDER] ||
      ["OPENAI_BASE_URL", "OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN"].some(key => env[key])) {
    throw Object.assign(new Error("Endpoint/auth/provider overrides require manual review; no inference was submitted."), { code: "endpoint_or_auth_override" });
  }
}

function configFingerprint(home) {
  const file = path.join(home, "config.toml");
  return fs.existsSync(file) ? sha(fs.readFileSync(file)) : null;
}

export function offlineCheck(binary, out) {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "duet-transport-check-"));
  // Do not inherit API keys, proxy credentials, real homes or broker settings.
  const source = { PATH: process.env.PATH, HOME: staging, USERPROFILE: staging,
    CODEX_COMPANION_HOME: path.join(staging, "isolated"), CODEX_COMPANION_BIN: binary };
  const env = isolatedCodexEnv(source);
  const checks = [];
  try {
    for (const mode of ["ws", "http"]) {
      const result = spawnSync(binary, isolatedCodexArgs(["features", "list", ...providerArgs(mode)], env),
        { env, cwd: staging, encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024 });
      checks.push({ mode, parsed: !result.error && result.status === 0,
        exitCode: result.status, errorCode: result.error?.code ?? null });
      fs.writeFileSync(path.join(out, `${mode}-config-check.txt`), (result.stdout ?? "") + (result.stderr ?? ""), { mode: 0o600 });
    }
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  const report = { scope: "offline CLI parsing only", checks, inferenceSubmitted: false, toolStartupVerified: false, latencyImprovementVerified: false };
  json(path.join(out, "config-check.json"), report);
  return report;
}

async function sample(input, resultFile) {
  const report = { mode: input.mode, label: input.label, startedAt: new Date().toISOString(),
    outcome: "incomplete", configurationAcknowledged: false, firstTool: null,
    toolCompleted: false, turnStatus: null, timingsMs: {}, approvals: [] };
  let client;
  let threadId;
  let threadAt;
  let turnAt;
  let startedAt;
  let firstItemId;
  const start = performance.now();
  const source = { ...process.env, CODEX_COMPANION_HOME: input.home, CODEX_COMPANION_BIN: input.binary, RUST_LOG: LOG_FILTER };
  let before;
  const checkpoint = () => json(resultFile, report);
  checkpoint();
  try {
    before = configFingerprint(input.home);
    client = await CodexAppServerClient.connect(input.cwd, { env: source, disableBroker: true,
      onServerRequestLog: summary => { report.approvals.push({ kind: summary.kind, decision: summary.decision }); checkpoint(); } });
    report.timingsMs.initialize = performance.now() - start;
    report.launcherPid = client.proc.pid;
    // Persist recognized evidence as it arrives, including a run killed by the
    // parent deadline before a first tool or final response.
    let evidenceCount = 0;
    client.proc.stderr.on("data", () => {
      const evidence = transportEvidence(client.stderr);
      if (evidence.events.length !== evidenceCount) {
        evidenceCount = evidence.events.length;
        report.transport = evidence;
        checkpoint();
      }
    });
    const { config } = await client.request("config/read", { cwd: input.cwd, includeLayers: false });
    const account = await client.request("account/read", { refreshToken: false });
    requireStandardChatGPT(config, account, source);
    report.effectiveConfigSha256 = sha(JSON.stringify(config));
    report.configBefore = before;
    report.preflightPassed = true;
    let done;
    const completed = new Promise(resolve => { done = resolve; });
    client.setNotificationHandler(message => {
      const p = message.params;
      if (!threadId || p?.threadId !== threadId) return;
      const now = performance.now();
      if (message.method === "turn/started") startedAt ??= now;
      const item = p?.item;
      const toolTypes = ["mcpToolCall", "dynamicToolCall", "commandExecution", "webSearch", "fileChange"];
      if (message.method === "item/started" && toolTypes.includes(item?.type) && report.firstTool === null) {
        firstItemId = item.id;
        report.firstTool = { type: item.type, isCua: item.type === "mcpToolCall" && /(?:^|__)cua_repl$/.test(item.server ?? ""), isJs: item.tool === "js" };
        report.timingsMs.processToFirstTool = now - start;
        report.timingsMs.threadRequestToFirstTool = now - threadAt;
        report.timingsMs.turnRequestToFirstTool = now - turnAt;
        report.timingsMs.turnStartedToFirstTool = startedAt === undefined ? null : now - startedAt;
        report.transportBeforeFirstTool = transportEvidence(client.stderr);
        checkpoint();
      }
      if (message.method === "item/completed" && item?.id === firstItemId && firstItemId !== undefined) {
        report.toolCompleted = item.status === "completed" && !item.error && item.result?.isError !== true;
        checkpoint();
      }
      if (message.method === "turn/completed") { report.turnStatus = p.turn?.status ?? "unknown"; done(); }
    });
    threadAt = performance.now();
    const response = await client.request("thread/start", { cwd: input.cwd, model: input.model,
      modelProvider: PROVIDER, config: providerOverrides(input.mode),
      approvalPolicy: "never", sandbox: "read-only", ephemeral: true });
    threadId = response.thread.id;
    if (response.modelProvider !== PROVIDER || response.model !== input.model ||
        response.sandbox?.type !== "readOnly" || response.approvalPolicy !== "never") {
      throw Object.assign(new Error("Runtime did not acknowledge the requested provider, model or read-only policy."), { code: "configuration_not_acknowledged" });
    }
    report.configurationAcknowledged = true;
    report.threadId = threadId;
    checkpoint();
    turnAt = performance.now();
    const turn = await client.request("turn/start", { threadId, input: [{ type: "text", text: PROBE_PROMPT, text_elements: [] }],
      model: input.model, effort: input.effort, serviceTier: null, approvalPolicy: "never" });
    report.turnId = turn.turn?.id ?? null;
    if (turn.turn?.status && turn.turn.status !== "inProgress") { report.turnStatus = turn.turn.status; done(); }
    await Promise.race([completed, client.exitPromise.then(() => { throw new Error("App-server exited before turn completion."); })]);
    report.outcome = report.turnStatus === "completed" && report.firstTool?.isCua && report.firstTool.isJs && report.toolCompleted ? "probe_completed" : "invalid_sample";
  } catch (error) {
    report.outcome = "failed";
    // Error messages can contain authentication headers or response bodies.
    report.error = { name: error.name, fingerprint: sha(String(error.message)),
      code: ["unsupported_provider_or_auth", "endpoint_or_auth_override", "configuration_not_acknowledged"].includes(error.code) ? error.code : "runtime_error",
      stage: report.configurationAcknowledged ? "turn" : report.preflightPassed ? "thread" : "preflight" };
  } finally {
    report.timingsMs.total = performance.now() - start;
    report.transport = transportEvidence(client?.stderr ?? "");
    report.configUnchanged = before === configFingerprint(input.home);
    checkpoint();
    if (client) await client.close();
  }
}

// Each sample owns a process group. Timeouts and interrupts stop only that
// group, including app-server and its MCP children; never attach to a broker.
async function runChild(input, resultFile, timeoutMs) {
  const child = spawn(process.execPath, [SELF, "_sample", resultFile], {
    detached: true, stdio: ["pipe", "ignore", "ignore"], env: process.env
  });
  child.stdin.end(JSON.stringify(input));
  let timedOut = false;
  let interrupted = false;
  let spawnError = null;
  let killTimer;
  const stop = () => {
    if (terminateProcessTree(child.pid).delivered) {
      killTimer ??= setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 1000);
    }
  };
  const interrupt = () => { interrupted = true; stop(); };
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  const timeout = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
  const code = await new Promise(resolve => {
    child.once("error", error => { spawnError = error.code; resolve(null); });
    child.once("exit", resolve);
  });
  clearTimeout(timeout);
  // Clean up any descendants even when the worker exited first.
  stop();
  await new Promise(resolve => setTimeout(resolve, 1100));
  clearTimeout(killTimer);
  process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
  let result;
  try { result = JSON.parse(fs.readFileSync(resultFile, "utf8")); }
  catch { result = { mode: input.mode, label: input.label, outcome: "failed" }; }
  result.processExitCode = code;
  if (timedOut || interrupted || spawnError || code !== 0) result.outcome = timedOut ? "timeout" : interrupted ? "interrupted" : "failed";
  result.configUnchanged = input.configBefore === configFingerprint(input.home);
  json(resultFile, result);
  return result;
}

async function main(argv) {
  if (argv[0] === "_sample") {
    let input = ""; for await (const chunk of process.stdin) input += chunk;
    return sample(JSON.parse(input), argv[1]);
  }
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ["out", "home", "binary", "model", "effort", "timeout-ms", "log"], booleanOptions: ["live", "help"]
  });
  if (options.help || !positionals.length) {
    console.log("diagnose-transport.mjs check --out NEW_DIR [--binary /absolute/codex]\n" +
      "diagnose-transport.mjs run --live --home /isolated/home --model MODEL --effort EFFORT --out NEW_DIR [--timeout-ms 180000]\n" +
      "diagnose-transport.mjs analyze --log EXPORTED_LOG\nSee docs/transport-validation.md for scope and local acceptance.");
    return;
  }
  if (positionals.length !== 1 || !["check", "run", "analyze"].includes(positionals[0])) throw new Error("Unknown command or argument.");
  const command = positionals[0];
  if (command === "analyze") { console.log(JSON.stringify(transportEvidence(fs.readFileSync(options.log, "utf8")), null, 2)); return; }
  if (!options.out) throw new Error("--out must name a new diagnostics directory.");
  if (command === "run" && (!options.live || !options.home || !options.model || !options.effort)) throw new Error("run requires --live, --home, --model and --effort.");
  if (command === "run" && process.platform === "win32") throw new Error("Live process-group diagnostics currently require macOS or Linux.");
  const source = { ...process.env, ...(options.home ? { CODEX_COMPANION_HOME: options.home } : {}),
    ...(options.binary ? { CODEX_COMPANION_BIN: options.binary } : {}) };
  const home = resolveIsolatedCodexHome(source);
  if (command === "run" && !fs.statSync(home).isDirectory()) throw new Error("An existing isolated home is required.");
  let binary = resolveCodexBinary(source);
  const timeoutMs = Number(options["timeout-ms"] ?? 180000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) throw new Error("timeout-ms must be 1000..600000.");
  const out = path.resolve(options.out);
  fs.mkdirSync(out, { mode: 0o700 }); // refuse overwrite / reuse
  const check = offlineCheck(binary, out);
  if (command === "check" || check.checks.some(c => !c.parsed)) {
    console.log(JSON.stringify(check, null, 2));
    process.exitCode = check.checks.every(c => c.parsed) ? 0 : 2;
    return;
  }
  binary = JSON.parse(resolveCodexRuntimeIdentity(source)).path;
  const version = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 15000, env: source });
  const manifest = { scope: "fresh app-server, metadata-only CUA probe; no browser task", binary,
    version: version.status === 0 ? version.stdout.trim() : "unknown", model: options.model, effort: options.effort,
    baseUrl: BASE_URL, promptSha256: sha(PROBE_PROMPT), configBefore: configFingerprint(home),
    samples: [], latencyImprovementVerified: false, rollback: { configuration: "pending", probe: "pending", transport: "unknown" } };
  json(path.join(out, "comparison.json"), manifest);
  for (const [index, mode] of ["ws", "http", "ws"].entries()) {
    const label = ["ws-before", "http-only", "ws-rollback"][index];
    console.error(`Running ${label}; deadline ${timeoutMs} ms.`);
    const input = { mode, label, home, binary, cwd: process.cwd(), model: options.model, effort: options.effort, configBefore: manifest.configBefore };
    const result = await runChild(input, path.join(out, `${label}.json`), timeoutMs);
    manifest.samples.push(result);
    json(path.join(out, "comparison.json"), manifest);
    if (result.outcome === "interrupted" || !result.configUnchanged || !result.preflightPassed || !result.configurationAcknowledged) break;
  }
  const rollback = manifest.samples.find(s => s.label === "ws-rollback");
  manifest.rollback = { configuration: manifest.configBefore === configFingerprint(home) ? "unchanged" : "changed",
    probe: rollback?.outcome ?? "not_run", transport: rollback?.transport?.observedRequestTransports ?? ["unknown"] };
  json(path.join(out, "comparison.json"), manifest);
  console.log(JSON.stringify(manifest, null, 2));
  if (manifest.samples.length !== 3 || manifest.samples.some(s => s.outcome !== "probe_completed") || manifest.rollback.configuration !== "unchanged") process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
