// Known blockers: fixed signatures from the Codex runtime (browser service,
// Computer Use policy) and from Codex's own final answer. Only the matched
// identifiers are retained (bundle id, app display name, tab id, session name);
// surrounding tool output is never copied into a record.

const text = value => String(value ?? "");
const compact = value => text(value).replace(/\s+/g, " ").trim();

export function classifyBrowserBlocker(value) {
  const match = /\bTab (\d+) is already part of browser session ([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})(?![0-9a-z-])/i.exec(text(value));
  return match ? { kind: "stale_browser_tab_claim", tabId: match[1], sessionId: match[2] } : null;
}

// Signatures emitted by node_repl's computer-use-policy.js.
const COMPUTER_USE = [
  { code: "computer_use_app_not_approved", pattern: /Computer Use was not approved to use (?:the app )?['"“]?([^'"”\n]{1,120}?)['"”]?(?=[.,;:!\n]|\s*$|\s*(?:\*\*|\)|\]))/g },
  { code: "computer_use_app_blocked_by_policy", pattern: /Computer Use is blocked from using the app ['"“]([^'"”\n]{1,120})['"”]/g },
  { code: "computer_use_app_forbidden", pattern: /Computer Use is not allowed to use the app ['"“]([^'"”\n]{1,120})['"”]/g }
];

function debuggerBlockers(value) {
  const body = text(value);
  if (!/Debugger (?:unattached|is not attached)/i.test(body)) return [];
  const blockers = [];
  // Table or sentence forms: "| `128187414` | `codex-readme-shots` | Could not close: `Debugger unattached` |",
  // "tab 128187414 (session codex-shots) ... Debugger unattached".
  for (const line of body.split(/\r?\n/)) {
    if (!/Debugger (?:unattached|is not attached)/i.test(line)) continue;
    const tabId = /\b(?:tab(?:\s*id)?\s*[:#]?\s*)?`?(\d{3,})`?/i.exec(line)?.[1] ?? null;
    const sessionId = /\bsession(?:\s*name)?\s*[:=]?\s*`?([A-Za-z0-9][A-Za-z0-9_.-]{0,80})`?/i.exec(line)?.[1]
      ?? (tabId ? /`\d{3,}`\s*\|\s*`?([A-Za-z0-9][A-Za-z0-9_.-]{0,80})`?\s*\|/.exec(line)?.[1] ?? null : null);
    const closed = /\b(?:closed successfully|closed\b(?! *:)|was closed)/i.test(line) ? true : /\b(?:could not close|cannot close|failed to close|not closed|unable to close|close(?:d)? failed)/i.test(line) ? false : null;
    blockers.push({ code: "browser_tab_debugger_unattached", tabId, sessionId, closed, message: compact(line).slice(0, 240) });
  }
  if (!blockers.length) blockers.push({ code: "browser_tab_debugger_unattached", tabId: null, sessionId: null, closed: null, message: "Debugger unattached" });
  // A line naming the tab supersedes prose that only mentions the error.
  return blockers.some(b => b.tabId) ? blockers.filter(b => b.tabId) : blockers.slice(0, 1);
}

// A final answer that declares itself blocked is a blocker even when no
// runtime signature was captured: "Blocked before native capture.", "**Blocked**",
// "status: blocked", "被阻塞".
export function reportedBlocked(value) {
  const body = text(value).trim();
  if (!body) return null;
  const first = body.split(/\r?\n/).find(line => line.trim()) ?? "";
  if (/^(?:[#>*_\s-]*)(?:blocked|阻塞|被阻塞|已阻塞)\b/i.test(first) || /^(?:[#>*_\s-]*)(?:阻塞|被阻塞|已阻塞)/.test(first) ||
      /\b(?:status\s*[:=]\s*["']?|"status"\s*:\s*")blocked\b/i.test(body)) {
    return { code: "reported_blocked", message: compact(first).replace(/\*\*|__/g, "").replace(/^[#>\s-]+/, "").slice(0, 240) };
  }
  return null;
}

export function classifyKnownBlockers(value) {
  const body = text(value), found = [];
  const browser = classifyBrowserBlocker(body);
  if (browser) found.push({ code: browser.kind, tabId: browser.tabId, sessionId: browser.sessionId, message: `tab ${browser.tabId}; session ${browser.sessionId}` });
  for (const { code, pattern } of COMPUTER_USE) {
    for (const match of body.matchAll(pattern)) found.push({ code, app: compact(match[1]).replace(/^`|`$/g, ""), message: compact(match[0]).slice(0, 240) });
  }
  found.push(...debuggerBlockers(body));
  const declared = reportedBlocked(body);
  if (declared) found.push(declared);
  return dedupeBlockers(found);
}

export function dedupeBlockers(blockers) {
  const seen = new Set(), out = [];
  for (const blocker of blockers) {
    if (!blocker || typeof blocker.code !== "string") continue;
    const key = JSON.stringify([blocker.code, blocker.app ?? null, blocker.tabId ?? null, blocker.sessionId ?? null]);
    if (seen.has(key)) continue;
    seen.add(key); out.push(blocker);
  }
  return out;
}

// Scan one completed MCP tool call for the fixed signatures above. Returns
// structured blockers only; arguments and payloads are not retained.
export function toolCallBlockers(item) {
  if (!item || item.type !== "mcpToolCall") return [];
  const parts = [item.error?.message];
  for (const entry of Array.isArray(item.result?.content) ? item.result.content : []) {
    if (entry && typeof entry.text === "string") parts.push(entry.text);
  }
  if (typeof item.result?.structuredContent?.error === "string") parts.push(item.result.structuredContent.error);
  return classifyKnownBlockers(parts.filter(Boolean).join("\n")).filter(blocker => blocker.code !== "reported_blocked");
}
