import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTempDir, run, writeExecutable } from "./helpers.mjs";
import { buildEnv } from "./fake-codex-fixture.mjs";
import { listModels, readModelCache } from "../plugins/codex/scripts/lib/models.mjs";

const plugin = new URL("../plugins/codex/", import.meta.url);
const launcher = new URL("bin/duet", plugin).pathname;
const fetchedAt = "2026-10-31T00:00:00Z";
const models = [
  { slug: "fixture-routine", display_name: "Routine", description: "Fast workhorse", visibility: "list", priority: 2,
    supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }], default_reasoning_level: "low", context_window: 128000 },
  { slug: "fixture-strong", display_name: "Strong", description: "Most capable", visibility: "list", priority: 1,
    supported_reasoning_levels: [{ effort: "high" }, { effort: "xhigh" }], default_reasoning_level: "xhigh", context_window: 256000 },
  { slug: "fixture-hidden", display_name: "Hidden", description: "Preview", visibility: "hide", priority: 3,
    supported_reasoning_levels: [{ effort: "ultra" }], default_reasoning_level: "ultra", context_window: 512000 }
];

function fixture({ cache = true, runtime = null, runtimeModels = models } = {}) {
  const dir = makeTempDir("models-"), home = path.join(dir, "isolated");
  fs.mkdirSync(home);
  const env = { ...buildEnv(dir), CODEX_COMPANION_HOME: home, CLAUDE_PLUGIN_DATA: path.join(dir, "data"),
    CODEX_COMPANION_BIN: path.join(dir, runtime ? "codex" : "missing-codex"), CODEX_COMPANION_SESSION_ID: "models-test" };
  const cacheFile = path.join(home, "models_cache.json"), calls = path.join(dir, "calls.jsonl"), pidFile = path.join(dir, "pid");
  const writeCache = (entries = models) => fs.writeFileSync(cacheFile, JSON.stringify({ fetched_at: fetchedAt, identity: { token: "CACHE_SECRET" },
    client_version: "fixture", etag: "PRIVATE_ETAG", models: entries.map(model => ({ ...model, token: "MODEL_SECRET" })) }));
  if (cache) writeCache();
  if (runtime) writeExecutable(env.CODEX_COMPANION_BIN, `#!/usr/bin/env node
const fs = require('node:fs'), readline = require('node:readline');
const behavior = ${JSON.stringify(runtime)}, models = ${JSON.stringify(runtimeModels)};
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
const send = (id, result) => process.stdout.write(JSON.stringify({id, result}) + '\\n');
readline.createInterface({input: process.stdin}).on('line', line => {
  const message = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(message) + '\\n');
  if (message.method === 'initialize') return send(message.id, {});
  if (message.method !== 'model/list') return;
  if (behavior === 'hang') return;
  if (behavior === 'error') return process.stdout.write(JSON.stringify({id: message.id, error: {code: -32601, message: 'RUNTIME_SECRET'}}) + '\\n');
  if (behavior === 'malformed') return send(message.id, {data: 'RUNTIME_SECRET'});
  const index = message.params.cursor === null ? 0 : 1;
  const offset = Number(message.params.cursor ?? 0);
  const chunk = behavior === 'catalog' ? models : behavior === 'paged' ? models.slice(offset, offset + 100) : index ? [models[2]] : [models[0], models[1]];
  const data = chunk.map(model => ({model: model.slug, id: 'not-the-slug',
    displayName: model.display_name, description: model.description, hidden: model.visibility === 'hide',
    defaultReasoningEffort: model.default_reasoning_level,
    supportedReasoningEfforts: model.supported_reasoning_levels.map(({effort}) => ({reasoningEffort: effort})), token: 'RUNTIME_SECRET'}));
  const nextCursor = behavior === 'catalog' ? null : behavior === 'paged' ? (offset + 100 < models.length ? String(offset + 100) : null)
    : behavior === 'loop' || index === 0 ? 'second-page' : null;
  send(message.id, {data, nextCursor});
});
`);
  return { dir, home, env, cacheFile, writeCache, calls, pidFile,
    call: (...args) => run(process.execPath, [launcher, ...args], { env, cwd: dir }) };
}
function json(result) {
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.doesNotMatch(result.stdout + result.stderr, /CACHE_SECRET|MODEL_SECRET|RUNTIME_SECRET|PRIVATE_ETAG|identity|token/);
  return JSON.parse(result.stdout);
}
test("models CLI uses the sanitized cache, marks effective tiers and optionally includes hidden models", () => {
  const f = fixture();
  json(f.call("setup", "--default-model", "fixture-strong", "--default-effort", "high", "--ultra-routine-model", "fixture-routine", "--json"));
  const report = json(f.call("models", "--json"));
  assert.equal(report.source, "cache");
  assert.deepEqual(report.models.map(model => model.slug), ["fixture-strong", "fixture-routine"]);
  assert.deepEqual(report.models.map(model => model.inUse), [["strong"], ["routine"]]);
  assert.deepEqual(report.models[0].efforts, ["high", "xhigh"]);
  assert.equal(report.models[0].contextWindow, 256000);
  assert.equal(report.tiers.strong.source, "saved");
  const human = f.call("models");
  assert.equal(human.status, 0, human.stderr);
  assert.doesNotMatch(human.stdout + human.stderr, /fixture-hidden|SECRET|identity|token/);
  assert.equal(json(f.call("models", "--all", "--json")).models[2].visibility, "hide");
  fs.rmSync(f.cacheFile);
  assert.equal(f.call("models", "--json").status, 1);
});

test("models prefers the paginated app-server catalog and closes its runtime", () => {
  const f = fixture({ runtime: "ok" }); f.writeCache([{ ...models[0], slug: "cache-only" }]);
  const report = json(f.call("models", "--all", "--json"));
  assert.equal(report.source, "app-server");
  assert.deepEqual(report.models.map(model => model.slug), models.map(model => model.slug));
  assert.equal(report.models[0].contextWindow, null);
  const calls = fs.readFileSync(f.calls, "utf8").trim().split("\n").map(JSON.parse).filter(call => call.method === "model/list");
  assert.deepEqual(calls.map(call => call.params.cursor), [null, "second-page"]);
  assert.ok(calls.every(call => call.params.includeHidden));
  assert.throws(() => process.kill(Number(fs.readFileSync(f.pidFile, "utf8")), 0), { code: "ESRCH" });
});

test("invalid pages, cursor loops and a stalled app-server fall back and clean up", async () => {
  for (const runtime of ["malformed", "loop", "hang"]) {
    const f = fixture({ runtime });
    const report = await listModels({ env: f.env, cwd: f.dir, timeoutMs: 3000 });
    assert.equal(report.source, "cache", runtime);
    assert.equal(report.models.length, 2);
    assert.doesNotMatch(JSON.stringify(report), /SECRET|identity|token/);
    // Under heavy parallel load the fake runtime may not start before the deadline; the contract is fallback plus cleanup.
    if (fs.existsSync(f.pidFile)) assert.throws(() => process.kill(Number(fs.readFileSync(f.pidFile, "utf8")), 0), { code: "ESRCH" }, runtime);
  }
});

test("cache and API catalogs reject unsafe tokens and bound untrusted display fields", () => {
  const controls = "\u0000\n\u202e", invalid = ["fixture --sandbox danger-full-access", "../fixture", "x".repeat(101), null];
  const hostile = { ...models[0], slug: "fixture-safe", display_name: `display${controls}${"x".repeat(2048)}`,
    description: `description${controls}${"x".repeat(2048)}`, default_reasoning_level: `default${controls}${"x".repeat(2048)}`,
    supported_reasoning_levels: [{ effort: "ultra" }, { effort: "high\n" }, { effort: "x".repeat(65) }] };
  const entries = [hostile, { ...models[0], slug: " SPARK " }, ...invalid.map(slug => ({ ...models[0], slug }))];
  for (const runtime of [null, "catalog"]) {
    const f = fixture({ runtime, runtimeModels: entries });
    fs.writeFileSync(f.cacheFile, JSON.stringify({ fetched_at: "2026-10-31 (\nINJECTED\n)", models: entries }));
    const report = json(f.call("models", "--json"));
    assert.deepEqual(report.models.map(model => model.slug), ["fixture-safe", "gpt-5.3-codex-spark"]);
    assert.equal(report.droppedInvalid, invalid.length);
    assert.equal(report.fetchedAt, new Date(report.fetchedAt).toISOString());
    for (const field of ["displayName", "description", "defaultEffort"]) {
      assert.ok(report.models[0][field].length <= 1024);
      assert.doesNotMatch(report.models[0][field], /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu);
    }
    assert.deepEqual(report.models[0].efforts, ["ultra"]);
    assert.doesNotMatch(JSON.stringify(report), /--sandbox|INJECTED/);
  }
});

test("catalog byte and entry caps reject oversized caches and paginated API totals", () => {
  const f = fixture(), body = JSON.stringify({ models: [models[0]] }), limit = 8 * 1024 * 1024;
  fs.writeFileSync(f.cacheFile, body + " ".repeat(limit - Buffer.byteLength(body)));
  assert.equal(readModelCache(f.env).models.length, 1);
  fs.appendFileSync(f.cacheFile, " ");
  assert.equal(readModelCache(f.env), null);
  const entries = Array.from({ length: 1001 }, (_, index) => ({ ...models[0], slug: `fixture-${index}` }));
  f.writeCache(entries);
  assert.equal(readModelCache(f.env), null);
  const oversized = fixture({ runtime: "paged", runtimeModels: entries });
  assert.equal(json(oversized.call("models", "--json")).source, "cache");
});

test("models rejects invalid options and overlapping homes before runtime startup", async () => {
  const f = fixture({ runtime: "ok" });
  assert.equal(f.call("models", "--typo").status, 1);
  const env = { ...f.env, CODEX_COMPANION_HOME: f.env.CODEX_HOME };
  assert.equal(readModelCache(env), null);
  await assert.rejects(listModels({ env }), /must not overlap/);
  assert.equal(fs.existsSync(f.pidFile), false);
});
