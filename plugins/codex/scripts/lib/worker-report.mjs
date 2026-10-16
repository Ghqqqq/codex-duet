import fs from "node:fs";
import { resolveJobFile } from "./state.mjs";

const shorten = (text, max = 240) => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const lines = text => String(text ?? "").split(/\r?\n/).map(s => s.trim()).filter(Boolean);

export function classifyBrowserBlocker(text) {
  const match = /\bTab (\d+) is already part of browser session ([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})(?![0-9a-z-])/i.exec(String(text ?? ""));
  return match ? { kind: "stale_browser_tab_claim", tabId: match[1], sessionId: match[2] } : null;
}

export function classifyWorkerOutcome(text, exitCode = 0) {
  if (exitCode !== 0) return "failed";
  if (classifyBrowserBlocker(text)) return "needs_input";
  const body = String(text ?? "").trim();
  if (!body) return "needs_input";
  if (/\b(?:status\s*[:=]\s*["']?|"status"\s*:\s*")(?:needs_input|blocked|incomplete|in_progress|running|pending)\b/i.test(body)) return "needs_input";
  if (/^(?:needs_input|blocked|incomplete)\b/i.test(body)) return "needs_input";
  const delivered = /\b(?:implemented|fixed|changed|verified|passed|completed|found|tested|results?)\b|已(?:完成|修复|实现|验证)/i.test(body);
  const asks = /[?？]\s*$/.test(body) || /\b(?:please (?:provide|confirm|choose|specify)|need (?:your|more) (?:input|confirmation|information)|awaiting (?:input|approval))\b|请(?:提供|确认|选择)/i.test(body);
  const startsRequest = /^(?:which|what|where|when|why|how|who|can you|could you|would you|should I|please (?:provide|confirm|choose|specify)|I need (?:your|more)|请(?:提供|确认|选择))\b/i.test(body);
  const unfinished = /^(?:I(?:'ll| will|’ll)|I(?: am|'m|’m) (?:working|starting|going|waiting)|Let me|Next I|Working on|Still (?:working|running)|Starting|In progress|我将|我会|正在)/i.test(body) || /\b(?:not yet (?:finished|complete|implemented)|work remains|awaiting input)\b/i.test(body);
  return unfinished || (asks && (startsRequest || !delivered)) ? "needs_input" : "completed";
}

export function taskArtifactPaths(workspaceRoot, jobId) {
  const base = resolveJobFile(workspaceRoot, jobId).replace(/\.json$/, "");
  return { rawOutputFile: `${base}.output.txt`, resultFile: `${base}.result.json` };
}

export function buildWorkerReport(payload, meta = {}) {
  const browserBlocker = classifyBrowserBlocker(`${payload.rawOutput ?? ""}\n${payload.error ?? ""}`);
  const status = browserBlocker && payload.status === 0 ? "needs_input" : classifyWorkerOutcome(payload.rawOutput, payload.status);
  const findings = lines(payload.rawOutput);
  const touched = payload.touchedFiles ?? [];
  const commands = payload.commandExecutions ?? [];
  const preExisting = payload.preExistingChanges ?? [];
  const origins = payload.approvedBrowserOrigins ?? [];
  const touchedLimit = browserBlocker ? 6 : 10;
  const findingsLimit = payload.startupTimings ? 1 : origins.length > 3 ? 1 : origins.length ? 2 : 5;
  const assumptionIndex = findings.findIndex(line => /^(?:#+\s*)?(?:\*\*)?assumptions?\b/i.test(line));
  return {
    status,
    jobId: meta.jobId ?? null,
    threadId: payload.threadId ?? null,
    turnId: payload.turnId ?? null,
    exitCode: payload.status,
    sandbox: payload.sandbox ?? "unknown",
    approvalPolicy: payload.approvalPolicy ?? "unknown",
    ...(payload.startupTimings ? { startupTimings: Object.entries(payload.startupTimings).map(([phase, value]) => `${phase}: ${value == null ? "unobserved" : typeof value === "number" ? `${value}ms` : `elapsed=${value.elapsedMs ?? "unknown"}ms${value.durationMs !== undefined ? ` duration=${value.durationMs}ms` : ""}`}`).join("; ") } : {}),
    ...(payload.startupWarning ? { startupWarning: payload.startupWarning } : {}),
    ...(payload.interruptionReason ? { interruptionReason: payload.interruptionReason, interruptionConfirmed: payload.interruptionConfirmed } : {}),
    approvedBrowserOrigins: origins.slice(0, 3),
    ...(origins.length > 3 ? { approvedBrowserOriginsOmitted: origins.length - 3 } : {}),
    rawOutputFile: meta.rawOutputFile ?? null,
    resultFile: meta.resultFile ?? null,
    touchedFiles: touched.slice(0, touchedLimit).map(s => shorten(s)),
    touchedFilesOmitted: Math.max(0, touched.length - touchedLimit),
    preExistingChanges: preExisting.slice(0, 4).map(s => shorten(s)),
    preExistingChangesOmitted: Math.max(0, preExisting.length - 4),
    fileTrackingStatus: payload.fileTracking?.status ?? "partial",
    fileTrackingBasis: payload.fileTracking?.basis ?? "Reported file-change events only; no workspace snapshot.",
    verification: commands.slice(origins.length ? -3 : -4).map(c => shorten(`${c.command ?? "command"}: exit ${c.exitCode ?? "unknown"}, ${c.status ?? "unknown"}`)),
    verificationBasis: "Captured command events; parent has not independently verified.",
    keyFindings: findings.slice(0, findingsLimit).map(s => shorten(s)),
    findingsBasis: "Codex-reported, not independently verified; full output includes any omitted assumptions and details.",
    assumptions: assumptionIndex < 0 ? [] : findings.slice(assumptionIndex, assumptionIndex + 2).map(s => shorten(s)),
    ...(browserBlocker ? { browserBlocker } : {}),
    blockers: browserBlocker ? [`stale_browser_tab_claim: tab ${browserBlocker.tabId}; session ${browserBlocker.sessionId}`] : status === "needs_input" ? findings.slice(0, 3).map(s => shorten(s)) : payload.error ? [shorten(payload.error)] : [],
    ...(status === "needs_input" ? { question: shorten(payload.rawOutput || "No final answer was captured; inspect the stored turn.", 600) } : {})
  };
}

export function persistTaskArtifacts(workspaceRoot, jobId, payload) {
  const paths = taskArtifactPaths(workspaceRoot, jobId);
  fs.writeFileSync(paths.rawOutputFile, payload.rawOutput ?? "", { mode: 0o600 });
  fs.writeFileSync(paths.resultFile, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  return paths;
}
