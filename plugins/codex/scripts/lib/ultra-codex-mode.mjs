import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolveStateRoot } from "./state.mjs";

// One orchestration mode per Claude session, shared across workspaces. Keep
// the ultra-codex directory and module path for compatibility with old sessions.
export const PROTOCOL_PATH = fileURLToPath(new URL("../../prompts/ultra-codex-protocol.md", import.meta.url));
export const ULTRA_SCALES = ["auto", "quick", "thorough"];
export const DEFAULT_MAX_WORKERS = "auto";
export const PAIR_MAX_REWORK_ROUNDS = 2;
export const DEFAULT_DUEL_ROUNDS = 3;
export const MODE_NAMES = ["ultra", "pair", "duel"];
const MODE_DIR = "ultra-codex";
const SESSION_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const COMMAND_PROMPT = /^\s*\/(?:codex:)?(?:ultra-codex|pair|duel)(?=\s|$)/;
const OPTION_KEYS = { ultra: ["scale", "maxWorkers"], pair: [], duel: ["rounds"] };

function isObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function validSavedCap(value) { return value === "auto" || value === "unlimited" || (Number.isInteger(value) && value > 0); }
function validRounds(value) { return Number.isInteger(value) && value >= 1 && value <= 3; }
function validOptions(name, options) {
  return isObject(options) && Object.keys(options).length === OPTION_KEYS[name].length &&
    Object.keys(options).every(key => OPTION_KEYS[name].includes(key)) &&
    (name === "pair" || (name === "duel" ? validRounds(options.rounds) :
      ULTRA_SCALES.includes(options.scale) && validSavedCap(options.maxWorkers)));
}

export function effectiveMaxWorkers(setting, cpuCount = os.availableParallelism?.() ?? os.cpus().length) {
  if (setting === "unlimited") return null;
  return setting === "auto" ? Math.min(16, Math.max(1, cpuCount - 2)) : setting;
}

function modeDir(env) { return path.join(path.dirname(resolveStateRoot(env)), MODE_DIR); }
function realDirectory(directory) {
  try { return fs.lstatSync(directory).isDirectory() && fs.realpathSync(directory) === directory; } catch { return false; }
}
function legacyModeDirs(env) {
  const root = resolveStateRoot(env);
  if (!realDirectory(root)) return [];
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && /^.+-[a-f0-9]{16}$/.test(entry.name))
      .map(entry => path.join(root, entry.name, MODE_DIR))
      .filter(realDirectory);
  } catch { return []; }
}
function clearLegacyModes(sessionId, env) {
  for (const directory of legacyModeDirs(env)) {
    const file = path.join(directory, `${sessionId}.json`);
    try { if (fs.lstatSync(file).isFile()) fs.unlinkSync(file); } catch { /* best effort; never read legacy mode */ }
  }
}
export function modeFile(cwd, sessionId, env = process.env) {
  if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) throw new Error("Orchestration mode needs the Claude session id (CODEX_COMPANION_SESSION_ID, exported by the SessionStart hook); run this inside Claude Code.");
  return path.join(modeDir(env), `${sessionId}.json`);
}

export function readMode(cwd, sessionId, env = process.env) {
  let file;
  try { file = modeFile(cwd, sessionId, env); clearLegacyModes(sessionId, env); } catch { return null; }
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!isObject(value) || (Object.hasOwn(value, "sessionId") && value.sessionId !== sessionId)) return null;
    let name, options;
    if (Object.hasOwn(value, "schemaVersion")) {
      if (value.schemaVersion !== 2 || !MODE_NAMES.includes(value.name) || !validOptions(value.name, value.options)) return null;
      name = value.name;
      options = { ...value.options };
    } else {
      if (!ULTRA_SCALES.includes(value.scale)) return null;
      name = "ultra";
      options = { scale: value.scale, maxWorkers: Number.isInteger(value.maxWorkers) && value.maxWorkers > 0 ? value.maxWorkers : DEFAULT_MAX_WORKERS };
    }
    return { schemaVersion: 2, sessionId, name, options, since: typeof value.since === "string" ? value.since : null, file };
  } catch { return null; }
}

export function setMode(cwd, sessionId, input = {}, env = process.env) {
  if (!isObject(input)) throw new Error("Mode input must be an object.");
  const named = Object.hasOwn(input, "name") || Object.hasOwn(input, "options");
  const name = named ? input.name : "ultra";
  if (!MODE_NAMES.includes(name)) throw new Error("Mode must be ultra, pair or duel.");
  if (Object.keys(input).some(key => !(named ? ["name", "options"] : OPTION_KEYS.ultra).includes(key))) throw new Error("Do not mix mode input shapes or options from another mode.");
  const supplied = named ? (Object.hasOwn(input, "options") ? input.options : {}) : input;
  if (!isObject(supplied) || Object.keys(supplied).some(key => !OPTION_KEYS[name].includes(key))) throw new Error(`Invalid options for ${name} mode.`);
  if (Object.hasOwn(supplied, "scale") && !ULTRA_SCALES.includes(supplied.scale)) throw new Error("Scale must be auto, quick or thorough.");
  if (Object.hasOwn(supplied, "maxWorkers") && !(supplied.maxWorkers === "auto" || supplied.maxWorkers === "unlimited" ||
      (Number.isInteger(supplied.maxWorkers) && supplied.maxWorkers >= 1 && supplied.maxWorkers <= 64))) throw new Error("--max-workers must be an integer from 1 to 64, auto or unlimited.");
  if (Object.hasOwn(supplied, "rounds") && !validRounds(supplied.rounds)) throw new Error("--rounds must be an integer from 1 to 3.");
  // Validate everything before readMode's legacy cleanup or any filesystem write.
  const file = modeFile(cwd, sessionId, env);
  const previous = readMode(cwd, sessionId, env);
  const matching = previous?.name === name ? previous : null;
  const options = name === "ultra"
    ? { scale: supplied.scale ?? "auto", maxWorkers: supplied.maxWorkers ?? matching?.options.maxWorkers ?? DEFAULT_MAX_WORKERS }
    : name === "duel" ? { rounds: supplied.rounds ?? matching?.options.rounds ?? DEFAULT_DUEL_ROUNDS } : {};
  const record = { schemaVersion: 2, sessionId, name, options, since: matching?.since ?? new Date().toISOString() };
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
  return { ...record, file };
}

export function clearMode(cwd, sessionId, env = process.env) {
  let file;
  try { file = modeFile(cwd, sessionId, env); clearLegacyModes(sessionId, env); } catch { return false; }
  try { fs.rmSync(file); return true; } catch { return false; }
}

// Mode files outlive a session only when SessionEnd never ran (crash, kill);
// SessionStart removes stale ones so a reused session id cannot inherit a mode.
export function pruneModes(cwd, maxAgeMs = 30 * 24 * 60 * 60 * 1000, env = process.env) {
  let removed = 0;
  // Include untouched legacy sessions, even if their workspace is no longer
  // used. This keeps the existing 30-day SessionStart policy for mode records.
  for (const dir of [modeDir(env), ...legacyModeDirs(env)].filter(realDirectory)) {
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith(".json") || !SESSION_ID.test(name.slice(0, -5))) continue;
      const file = path.join(dir, name);
      try {
        const stat = fs.lstatSync(file);
        if (stat.isFile() && Date.now() - stat.mtimeMs > maxAgeMs) { fs.unlinkSync(file); removed += 1; }
      } catch { /* already gone */ }
    }
  }
  return removed;
}

export function isModeCommandPrompt(prompt) {
  return COMMAND_PROMPT.test(String(prompt ?? ""));
}

// Exclude only the version line to avoid a self-referential hash. Tests pin the
// checked-in header to the body; runtime callers always hash the current text.
export function protocolVersion(text = fs.readFileSync(PROTOCOL_PATH, "utf8")) {
  const body = text.replace(/^<!-- Ultra-codex protocol v[0-9a-f]{8} -->\r?\n/, "");
  return createHash("sha256").update(body).digest("hex").slice(0, 8);
}

// What the UserPromptSubmit hook adds to the prompt while the mode is on.
// Short on purpose: it is paid on every prompt. The protocol itself is read
// only when its current version is absent (including after compaction).
export const BUILTIN_WORKER_DEFAULTS = Object.freeze({ model: "gpt-6-astra", effort: "xhigh", routineModel: "gpt-6.1-sol" });
export function reminderText(mode, protocolPath = PROTOCOL_PATH, models = BUILTIN_WORKER_DEFAULTS) {
  const version = protocolVersion(fs.readFileSync(protocolPath, "utf8"));
  const { model, effort, routineModel } = models;
  const name = mode.name ?? "ultra", options = mode.options ?? mode;
  const suffix = `v${version} to substantive tasks; re-read ${protocolPath} only if v${version} is not in your context.`;
  if (name === "pair") return `Pair mode on (one primary Codex worker on ${model}/${effort}, max ${PAIR_MAX_REWORK_ROUNDS} rework rounds). Apply pair protocol ${suffix}`;
  if (name === "duel") return `Duel mode on (Claude vs Codex on ${model}/${effort}, max ${options.rounds} rounds). Apply duel protocol ${suffix}`;
  const cap = options.maxWorkers === "unlimited" ? "no worker cap" : `max ${effectiveMaxWorkers(options.maxWorkers)} workers${options.maxWorkers === "auto" ? " (auto)" : ""}`;
  return `Ultra-codex mode on (${options.scale}, ${cap}, routine ${routineModel}, strong ${model}). Apply protocol ${suffix}`;
}
