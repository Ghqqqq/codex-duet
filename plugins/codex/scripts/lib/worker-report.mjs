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

export const WORKER_REPORT_STATUSES = ["completed", "needs_input", "blocked"];
const stringList = (value, max) => Array.isArray(value) ? value.filter(v => typeof v === "string" && v.trim()).map(v => v.trim()).slice(0, max) : [];
const stringOrNull = value => typeof value === "string" && value.trim() ? value.trim() : null;
// The worker-report schema (schemas/worker-report.schema.json) makes the final
// message a JSON object. A trailing ```json block is accepted too, so a turn
// that ran without the schema (interrupted, resumed elsewhere) still parses.
// Returns null when the text is not a report; callers then fall back to the
// heuristics above.
export function parseStructuredReport(rawOutput) {
  const text = String(rawOutput ?? "").trim();
  if (!text) return null;
  const fenced = [...text.matchAll(/```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/g)].map(match => match[1].trim());
  for (const candidate of [...fenced.reverse(), text]) {
    let value;
    try { value = JSON.parse(candidate); } catch { continue; }
    if (!value || typeof value !== "object" || Array.isArray(value) || !WORKER_REPORT_STATUSES.includes(value.status) || typeof value.summary !== "string") continue;
    const verification = stringList(value.verification, Infinity);
    const keyFindings = stringList(value.key_findings, Infinity);
    const assumptions = stringList(value.assumptions, Infinity);
    return {
      status: value.status,
      summary: value.summary.trim(),
      keyFindings: keyFindings.slice(0, 500),
      ...(keyFindings.length > 500 ? { keyFindingsOmitted: keyFindings.length - 500 } : {}),
      assumptions: assumptions.slice(0, 500),
      ...(assumptions.length > 500 ? { assumptionsOmitted: assumptions.length - 500 } : {}),
      verification: verification.slice(0, 500),
      ...(verification.length > 500 ? { verificationOmitted: verification.length - 500 } : {}),
      blockers: (Array.isArray(value.blockers) ? value.blockers : []).filter(b => b && typeof b === "object" && typeof b.code === "string" && b.code.trim()).slice(0, 6)
        .map(b => ({ code: b.code.trim().slice(0, 64), message: stringOrNull(b.message), app: stringOrNull(b.app), tabId: stringOrNull(b.tab_id ?? b.tabId), sessionId: stringOrNull(b.session_id ?? b.sessionId) })),
      question: stringOrNull(value.question)
    };
  }
  return null;
}

export function taskArtifactPaths(workspaceRoot, jobId) {
  const base = resolveJobFile(workspaceRoot, jobId).replace(/\.json$/, "");
  return { rawOutputFile: `${base}.output.txt`, resultFile: `${base}.result.json` };
}

// Structured blocker: { code, app? | tabId?, sessionId?, closed?, message? }; null fields are dropped.
const blockerEntry = blocker => Object.fromEntries(Object.entries({ ...blocker, ...(typeof blocker.message === "string" ? { message: shorten(blocker.message) } : {}) }).filter(([, v]) => v !== null && v !== undefined));
export const REPORT_LINE_BUDGET = 60;
/** @type {[string, string | null, number][]} */
const BUDGET_LISTS = [["touchedFiles", "touchedFilesOmitted", 1], ["keyFindings", null, 1], ["verification", null, 1], ["claimedVerification", null, 1], ["preExistingChanges", "preExistingChangesOmitted", 1], ["assumptions", null, 0], ["blockers", "blockersOmitted", 1]];
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

// Declared blockers and essential questions outrank a successful declaration.
// A plan-only summary also contradicts "completed", as for unstructured prose.
function declaredStatus(structured) {
  if (structured.blockers.length) return "blocked";
  if (structured.question) return "needs_input";
  if (structured.status !== "completed") return structured.status;
  return classifyWorkerOutcome(structured.summary, 0);
}

export function buildWorkerReport(payload, meta = {}) {
  const text = `${payload.rawOutput ?? ""}\n${payload.error ?? ""}`;
  const browserBlocker = classifyBrowserBlocker(text);
  const structured = payload.structured && WORKER_REPORT_STATUSES.includes(payload.structured.status) ? payload.structured : null;
  // Captured refusals (tool results, declined elicitations) come first; the
  // final answer's own signatures follow. Either makes a zero-exit turn blocked.
  const known = dedupeBlockers([...(payload.blockers ?? []), ...classifyKnownBlockers(text)]);
  const status = payload.status !== 0 ? "failed" : known.length ? "blocked" : structured ? declaredStatus(structured) : classifyWorkerOutcome(payload.rawOutput, payload.status);
  // Blockers Codex declared itself; a declared "blocked" without any entry still
  // names the summary so the parent sees why.
  const declared = structured ? (structured.blockers.length || status !== "blocked" ? structured.blockers : [{ code: "reported_blocked", message: structured.summary || "Codex reported blocked without details." }]) : [];
  const findings = structured ? structured.keyFindings : lines(payload.rawOutput);
  const touched = payload.touchedFiles ?? [];
  const commands = payload.commandExecutions ?? [];
  const preExisting = payload.preExistingChanges ?? [];
  const origins = payload.approvedBrowserOrigins ?? [];
  // Budgets keep a fully populated report within about 60 lines, including the
  // run settings (model/effort/serviceTier) below.
  const apps = payload.approvedComputerApps ?? [];
  const touchedLimit = known.length ? 4 : 9;
  const findingsLimit = payload.startupTimings || known.length ? 1 : origins.length > 3 ? 1 : origins.length ? 2 : 5;
  const questionLine = structured?.question ?? findings.find(line => /[?？]\s*$/.test(line)) ?? (structured ? structured.summary : findings[0]) ?? "No final answer was captured.";
  const blockers = known.length ? known.slice(0, 3).map(blockerEntry)
    : declared.length ? declared.slice(0, 3).map(blockerEntry)
    : status === "needs_input" ? [{ code: "needs_input", message: shorten(questionLine) }]
    : payload.error ? [{ code: "error", message: shorten(payload.error) }] : [];
  const assumptionIndex = structured ? -1 : findings.findIndex(line => /^(?:#+\s*)?(?:\*\*)?assumptions?\b/i.test(line));
  const assumptions = structured ? structured.assumptions.slice(0, 3).map(s => shorten(s)) : assumptionIndex < 0 ? [] : findings.slice(assumptionIndex, assumptionIndex + 2).map(s => shorten(s));
  const omittedBlockers = Math.max(known.length, declared.length) - 3;
  return fitBudget({
    status: status === "completed" && blockers.length ? "blocked" : status,
    // Present when Codex filled the worker-report schema; absent when the final
    // message was prose and status/findings were inferred from it.
    ...(structured ? { reportFormat: "structured", declaredStatus: structured.status } : {}),
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
    ...(structured?.verification.length ? { claimedVerification: structured.verification.slice(0, 3).map(s => shorten(s)) } : {}),
    keyFindings: findings.slice(0, structured ? 5 : findingsLimit).map(s => shorten(s)),
    findingsBasis: structured ? "Declared by Codex in its structured report, not independently verified; the summary is in the raw output file." : "Codex-reported, not independently verified; full output includes any omitted assumptions and details.",
    assumptions,
    ...(browserBlocker ? { browserBlocker } : {}),
    blockers,
    ...(omittedBlockers > 0 ? { blockersOmitted: omittedBlockers } : {}),
    ...(status === "needs_input" ? { question: shorten(structured?.question ?? payload.rawOutput ?? "", 600) || "No final answer was captured; inspect the stored turn." } : {})
  });
}

export function persistTaskArtifacts(workspaceRoot, jobId, payload) {
  const paths = taskArtifactPaths(workspaceRoot, jobId);
  fs.writeFileSync(paths.rawOutputFile, payload.rawOutput ?? "", { mode: 0o600 });
  fs.writeFileSync(paths.resultFile, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  return paths;
}
