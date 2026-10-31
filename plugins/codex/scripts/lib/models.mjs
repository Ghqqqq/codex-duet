import fs from "node:fs";
import path from "node:path";
import { resolveIsolatedCodexHome } from "./codex-home.mjs";
import { normalizeRequestedModel } from "./setup-config.mjs";

const MAX_CACHE_BYTES = 8 * 1024 * 1024;
const MAX_MODELS = 1000;

// Catalog strings are untrusted display text, including JSON consumed by agents.
const text = value => typeof value === "string"
  ? value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 1024) : "";
const contextWindow = value => Number.isSafeInteger(value) && value > 0 ? value : null;
const efforts = (values, key) => [...new Set((Array.isArray(values) ? values : [])
  .map(value => value?.[key]).filter(value => typeof value === "string" && value === value.trim() && /^[a-z][a-z0-9_-]{0,63}$/.test(value)))];

function normalizeModel(model, source) {
  if (!model || typeof model !== "object") return null;
  const cache = source === "cache", rawSlug = cache ? model.slug : model.model;
  const slug = typeof rawSlug === "string" ? normalizeRequestedModel(rawSlug) : null;
  // Slugs become dispatch arguments. Validate the full token after the same
  // alias normalization as saved preferences; never sanitize or truncate it.
  if (!slug || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(slug)) return null;
  // Whitelist public catalog fields: never forward cache identity or runtime/account data.
  return {
    slug,
    displayName: text(cache ? model.display_name : model.displayName) || slug,
    description: text(model.description),
    efforts: efforts(cache ? model.supported_reasoning_levels : model.supportedReasoningEfforts, cache ? "effort" : "reasoningEffort"),
    defaultEffort: text(cache ? model.default_reasoning_level : model.defaultReasoningEffort) || null,
    contextWindow: contextWindow(cache ? model.context_window : model.contextWindow),
    visibility: (cache ? model.visibility === "hide" : model.hidden === true) ? "hide" : "list"
  };
}

function readCacheText(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_CACHE_BYTES) return null;
    // One extra byte detects growth after fstat without an unbounded read.
    const buffer = Buffer.alloc(stat.size + 1);
    let bytes = 0, count;
    while (bytes < buffer.length && (count = fs.readSync(fd, buffer, bytes, buffer.length - bytes, null)) > 0) bytes += count;
    if (bytes > stat.size) return null;
    return buffer.toString("utf8", 0, bytes);
  } finally { fs.closeSync(fd); }
}

// Setup and hooks use only this read-only cache path; neither starts a runtime.
export function readModelCache(env = process.env) {
  try {
    const cache = JSON.parse(readCacheText(path.join(resolveIsolatedCodexHome(env), "models_cache.json")));
    // Oversized catalogs are unavailable rather than silently incomplete.
    if (!Array.isArray(cache?.models) || cache.models.length > MAX_MODELS) return null;
    const models = [...cache.models].sort((a, b) => (a?.priority ?? Infinity) - (b?.priority ?? Infinity))
      .map(model => normalizeModel(model, "cache")).filter(Boolean);
    const droppedInvalid = cache.models.length - models.length;
    const fetchedMs = typeof cache.fetched_at === "string" ? Date.parse(cache.fetched_at) : NaN;
    const fetchedAt = Number.isFinite(fetchedMs) ? new Date(fetchedMs).toISOString() : null;
    return { source: "cache", fetchedAt, models, droppedInvalid };
  } catch { return null; }
}

export function cachedReasoningEfforts(env = process.env) {
  return new Set(readModelCache(env)?.models.flatMap(model => model.efforts) ?? []);
}

export async function listModels({ env = process.env, cwd = process.cwd(), all = false, timeoutMs = 5000 } = {}) {
  // Validate isolation before even attempting runtime startup or cache fallback.
  resolveIsolatedCodexHome(env);
  let client, catalog;
  const deadline = Date.now() + timeoutMs;
  try {
    const { CodexAppServerClient } = await import("./app-server.mjs");
    client = await CodexAppServerClient.connect(cwd, { env, disableBroker: true, connectTimeoutMs: timeoutMs, connectDeadline: deadline });
    const models = [], cursors = new Set();
    let processed = 0, droppedInvalid = 0;
    let cursor = null;
    do {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("Model listing timed out.");
      // Codex 0.146.0 exposes this API; the local dispatch-only method map omits it.
      const page = await client.request(/** @type {any} */ ("model/list"), { cursor, limit: 100, includeHidden: true }, { timeoutMs: remaining });
      if (!Array.isArray(page?.data)) throw new Error("Invalid model list.");
      if (page.data.length > MAX_MODELS - processed) throw new Error("Model catalog exceeds the entry limit.");
      processed += page.data.length;
      for (const item of page.data) {
        const model = normalizeModel(item, "app-server");
        if (model) models.push(model);
        else droppedInvalid++;
      }
      cursor = page.nextCursor ?? null;
      if (cursor !== null && (typeof cursor !== "string" || cursors.has(cursor))) throw new Error("Invalid model cursor.");
      cursors.add(cursor);
    } while (cursor !== null);
    catalog = { source: "app-server", fetchedAt: new Date().toISOString(), models, droppedInvalid };
  } catch {
    // Errors can contain runtime diagnostics/account details. Never print them here.
  } finally {
    if (client) await client.close();
  }
  catalog ??= readModelCache(env);
  if (!catalog) throw new Error("Codex models are unavailable from the app-server and isolated model cache. Run /codex:setup to check the runtime and sign in, then retry duet models.");
  return { ...catalog, models: catalog.models.filter(model => all || model.visibility !== "hide") };
}

export function renderModels(report) {
  const clean = value => text(String(value ?? "unknown"));
  const rows = report.models.map(model => [model.slug, model.displayName, model.efforts.join(", ") || "none listed", model.defaultEffort,
    model.contextWindow, model.inUse.join(", ") || "—", model.description].map(clean).join(" | "));
  const { strong, effort, routine } = report.tiers;
  return [`Models source: ${clean(report.source)}; fetched: ${clean(report.fetchedAt)}; invalid entries dropped: ${clean(report.droppedInvalid)}`,
    "Slug | Display name | Supported efforts | Default effort | Context window | In use | Description", ...rows,
    `Duet tiers: strong ${clean(strong.value)}/${clean(effort.value)} (model: ${clean(strong.source)}, effort: ${clean(effort.source)}); routine ${clean(routine.value)} (${clean(routine.source)})`, ""].join("\n");
}
