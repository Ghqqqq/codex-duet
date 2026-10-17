import { redactActivity } from "./activity.mjs";
import fs from "node:fs";
import { resolveJobFile } from "./state.mjs";
import { classifyBrowserBlocker, classifyKnownBlockers, dedupeBlockers } from "./blockers.mjs";

export { classifyBrowserBlocker };

const shorten = (text, max = 240) => redactActivity(text).replace(/\s+/g, " ").trim().slice(0, max);
const lines = text => String(text ?? "").split(/\r?\n/).map(s => s.trim()).filter(Boolean);

// Outcome statuses: completed; blocked (a known runtime refusal or a final
// answer that declares itself blocked); needs_input (a question or unfinished
// work); failed (non-zero exit).
export function classifyWorkerOutcome(text, exitCode = 0) {
  if (exitCode !== 0) return "failed";
  if (classifyKnownBlockers(text).length) return "blocked";
  const body = String(text ?? "").trim();
  if (!body) return "needs_input";
  if (/\b(?:status\s*[:=]\s*["']?|"status"\s*:\s*")(?:needs_input|incomplete|in_progress|running|pending)\b/i.test(body)) return "needs_input";
  if (/^(?:needs_input|incomplete)\b/i.test(body)) return "needs_input";
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

// Structured blocker: { code, app? | tabId?, sessionId?, closed?, message? }; null fields are dropped.
const blockerEntry = blocker => Object.fromEntries(Object.entries({ ...blocker, ...(typeof blocker.message === "string" ? { message: shorten(blocker.message) } : {}) }).filter(([, v]) => v !== null && v !== undefined));
export const REPORT_LINE_BUDGET = 60;
const BUDGET_LISTS = [["touchedFiles", "touchedFilesOmitted", 1], ["keyFindings", null, 1], ["verification", null, 1], ["preExistingChanges", "preExistingChangesOmitted", 1], ["assumptions", null, 0], ["blockers", "blockersOmitted", 1]];
const reportLines = report => `${JSON.stringify(report, null, 2)}\n`.split("\n").length;
// Trim lists (longest first, blockers last) until the pretty-printed report
// fits the budget; omitted counters account for every dropped entry.
function fitBudget(report) {
  for (let guard = 0; reportLines(report) > REPORT_LINE_BUDGET && guard < 200; guard += 1) {
    const candidates = BUDGET_LISTS.filter(([key, , min]) => Array.isArray(report[key]) && report[key].length > min);
    if (!candidates.length) break;
    const [key, omitted] = candidates.reduce((best, entry) => report[entry[0]].length > report[best[0]].length ? entry : best, candidates[0]);
    report[key] = report[key].slice(0, -1);
    if (omitted) report[omitted] = (report[omitted] ?? 0) + 1;
  }
  return report;
}

export function buildWorkerReport(payload, meta = {}) {
  const text = `${payload.rawOutput ?? ""}\n${payload.error ?? ""}`;
  const browserBlocker = classifyBrowserBlocker(text);
  // Captured refusals (tool results, declined elicitations) come first; the
  // final answer's own signatures follow. Either makes a zero-exit turn blocked.
  const known = dedupeBlockers([...(payload.blockers ?? []), ...classifyKnownBlockers(text)]);
  const status = payload.status !== 0 ? "failed" : known.length ? "blocked" : classifyWorkerOutcome(payload.rawOutput, payload.status);
  const findings = lines(payload.rawOutput);
  const touched = payload.touchedFiles ?? [];
  const commands = payload.commandExecutions ?? [];
  const preExisting = payload.preExistingChanges ?? [];
  const origins = payload.approvedBrowserOrigins ?? [];
  // Budgets keep a fully populated report within about 60 lines, including the
  // run settings (model/effort/serviceTier) below.
  const apps = payload.approvedComputerApps ?? [];
  const touchedLimit = known.length ? 4 : 9;
  const findingsLimit = payload.startupTimings || known.length ? 1 : origins.length > 3 ? 1 : origins.length ? 2 : 5;
  const blockers = known.length ? known.slice(0, 3).map(blockerEntry)
    : status === "needs_input" ? [{ code: "needs_input", message: shorten(findings.find(line => /[?？]\s*$/.test(line)) ?? findings[0] ?? "No final answer was captured.") }]
    : payload.error ? [{ code: "error", message: shorten(payload.error) }] : [];
  const assumptionIndex = findings.findIndex(line => /^(?:#+\s*)?(?:\*\*)?assumptions?\b/i.test(line));
  return fitBudget({
    status,
    jobId: meta.jobId ?? null,
    threadId: payload.threadId ?? null,
    turnId: payload.turnId ?? null,
    exitCode: payload.status,
    sandbox: payload.sandbox ?? "unknown",
    approvalPolicy: payload.approvalPolicy ?? "unknown",
    // Run settings, so the parent can confirm e.g. that --fast took effect.
    model: payload.model ?? meta.request?.model ?? null,
    effort: payload.effort ?? meta.request?.effort ?? null,
    serviceTier: payload.serviceTier ?? meta.request?.serviceTier ?? null,
    ...(payload.startupTimings ? { startupTimings: Object.entries(payload.startupTimings).map(([phase, value]) => `${phase}: ${value == null ? "unobserved" : typeof value === "number" ? `${value}ms` : `elapsed=${value.elapsedMs ?? "unknown"}ms${value.durationMs !== undefined ? ` duration=${value.durationMs}ms` : ""}`}`).join("; ") } : {}),
    ...(payload.startupWarning ? { startupWarning: payload.startupWarning } : {}),
    ...(payload.interruptionReason ? { interruptionReason: payload.interruptionReason, interruptionConfirmed: payload.interruptionConfirmed } : {}),
    approvedBrowserOrigins: origins.slice(0, 3),
    ...(origins.length > 3 ? { approvedBrowserOriginsOmitted: origins.length - 3 } : {}),
    ...(apps.length ? { approvedComputerApps: apps.slice(0, 3), ...(apps.length > 3 ? { approvedComputerAppsOmitted: apps.length - 3 } : {}) } : {}),
    rawOutputFile: meta.rawOutputFile ?? null,
    resultFile: meta.resultFile ?? null,
    touchedFiles: touched.slice(0, touchedLimit).map(s => shorten(s)),
    touchedFilesOmitted: Math.max(0, touched.length - touchedLimit),
    preExistingChanges: preExisting.slice(0, 3).map(s => shorten(s)),
    preExistingChangesOmitted: Math.max(0, preExisting.length - 3),
    fileTrackingStatus: payload.fileTracking?.status ?? "partial",
    fileTrackingBasis: payload.fileTracking?.basis ?? "Reported file-change events only; no workspace snapshot.",
    verification: commands.slice(origins.length ? -2 : -3).map(c => shorten(`${c.command ?? "command"}: exit ${c.exitCode ?? "unknown"}, ${c.status ?? "unknown"}`)),
    verificationBasis: "Captured command events; parent has not independently verified.",
    keyFindings: findings.slice(0, findingsLimit).map(s => shorten(s)),
    findingsBasis: "Codex-reported, not independently verified; full output includes any omitted assumptions and details.",
    assumptions: assumptionIndex < 0 ? [] : findings.slice(assumptionIndex, assumptionIndex + 2).map(s => shorten(s)),
    ...(browserBlocker ? { browserBlocker } : {}),
    blockers,
    ...(known.length > 3 ? { blockersOmitted: known.length - 3 } : {}),
    ...(status === "needs_input" ? { question: shorten(payload.rawOutput || "No final answer was captured; inspect the stored turn.", 600) } : {})
  });
}

export function persistTaskArtifacts(workspaceRoot, jobId, payload) {
  const paths = taskArtifactPaths(workspaceRoot, jobId);
  fs.writeFileSync(paths.rawOutputFile, payload.rawOutput ?? "", { mode: 0o600 });
  fs.writeFileSync(paths.resultFile, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  return paths;
}
