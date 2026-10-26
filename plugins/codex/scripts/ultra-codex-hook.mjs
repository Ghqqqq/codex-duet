#!/usr/bin/env node
// UserPromptSubmit hook: while ultra-codex mode is on for this Claude session,
// add a one-line reminder to the prompt. Silent otherwise, and silent on any
// error: a hook failure must never block the user's prompt.
import fs from "node:fs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import { isModeCommandPrompt, readMode, reminderText } from "./lib/ultra-codex-mode.mjs";

try {
  const raw = fs.readFileSync(0, "utf8").trim();
  const input = raw ? JSON.parse(raw) : {};
  const sessionId = input.session_id || process.env.CODEX_COMPANION_SESSION_ID;
  if (sessionId) {
    const mode = readMode(resolveWorkspaceRoot(input.cwd || process.cwd()), sessionId);
    if (mode && !isModeCommandPrompt(input.prompt)) process.stdout.write(`${reminderText(mode)}\n`);
  }
} catch { /* silent */ }
