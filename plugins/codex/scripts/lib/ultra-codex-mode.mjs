import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolveStateDir } from "./state.mjs";

// Ultra-codex mode is a per-Claude-session switch, like `/effort ultracode`:
// while it is on, a UserPromptSubmit hook adds a one-line reminder to every
// prompt and Claude applies the orchestration protocol to each substantive
// task. The switch is a small JSON file in the workspace's state directory,
// keyed by the Claude session id, so two sessions in one repository do not
// share it; SessionEnd and `ultra-codex off` remove it.
export const PROTOCOL_PATH = fileURLToPath(new URL("../../prompts/ultra-codex-protocol.md", import.meta.url));
export const ULTRA_SCALES = ["auto", "quick", "thorough"];
export const DEFAULT_MAX_WORKERS = 6;
const MODE_DIR = "ultra-codex";
const SESSION_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const COMMAND_PROMPT = /^\s*\/(?:codex:)?ultra-codex\b/;

function modeDir(cwd, env) { return path.join(resolveStateDir(cwd, env), MODE_DIR); }
export function modeFile(cwd, sessionId, env = process.env) {
  if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) throw new Error("Ultra-codex mode needs the Claude session id (CODEX_COMPANION_SESSION_ID, exported by the SessionStart hook); run this inside Claude Code.");
  return path.join(modeDir(cwd, env), `${sessionId}.json`);
}

export function readMode(cwd, sessionId, env = process.env) {
  let file;
  try { file = modeFile(cwd, sessionId, env); } catch { return null; }
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!value || typeof value !== "object" || !ULTRA_SCALES.includes(value.scale)) return null;
    return { sessionId, scale: value.scale, maxWorkers: Number.isInteger(value.maxWorkers) && value.maxWorkers > 0 ? value.maxWorkers : DEFAULT_MAX_WORKERS, since: typeof value.since === "string" ? value.since : null, file };
  } catch { return null; }
}

export function setMode(cwd, sessionId, { scale = "auto", maxWorkers = DEFAULT_MAX_WORKERS } = {}, env = process.env) {
  if (!ULTRA_SCALES.includes(scale)) throw new Error("Scale must be auto, quick or thorough.");
  if (!Number.isInteger(maxWorkers) || maxWorkers < 1 || maxWorkers > 64) throw new Error("--max-workers must be an integer from 1 to 64.");
  const file = modeFile(cwd, sessionId, env);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const previous = readMode(cwd, sessionId, env);
  const record = { sessionId, scale, maxWorkers, since: previous?.since ?? new Date().toISOString() };
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
  return { ...record, file };
}

export function clearMode(cwd, sessionId, env = process.env) {
  let file;
  try { file = modeFile(cwd, sessionId, env); } catch { return false; }
  try { fs.rmSync(file); return true; } catch { return false; }
}

// Mode files outlive a session only when SessionEnd never ran (crash, kill);
// SessionStart removes stale ones so a reused session id cannot inherit a mode.
export function pruneModes(cwd, maxAgeMs = 30 * 24 * 60 * 60 * 1000, env = process.env) {
  const dir = modeDir(cwd, env);
  let names;
  try { names = fs.readdirSync(dir); } catch { return 0; }
  let removed = 0;
  for (const name of names) {
    const file = path.join(dir, name);
    try { if (Date.now() - fs.statSync(file).mtimeMs > maxAgeMs) { fs.rmSync(file); removed += 1; } } catch { /* already gone */ }
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
export function reminderText(mode, protocolPath = PROTOCOL_PATH) {
  const version = protocolVersion(fs.readFileSync(protocolPath, "utf8"));
  return `Ultra-codex mode on (${mode.scale}, max ${mode.maxWorkers} workers). Apply protocol v${version} to substantive tasks; re-read ${protocolPath} only if v${version} is not in your context.`;
}
