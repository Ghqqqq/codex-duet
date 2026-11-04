import type { ThemeKey } from 'claude-code';
import type { CodexLiveEvent, CodexLiveFeedView, CodexLiveJob, CodexLiveSession, CodexLiveState, ForumRoom } from '../types';
import { attention, attentionOrder, clean, cleanBody, detailedTurns, elapsed, EXPANDED_ID_LIMIT, glyph, isAbsolutePath, jobLifecycle, questionExcerpt, reusedAgentName, sessionForId, taskText, turnKey, unwrapCommand, visibleForums, visibleSessions } from './model';

import { commandDisplay, fitCommand, tokenize } from './command';
import { forumOrder, selectedForum } from './forum';

import { cells, clusters, fit, width } from './text';
export { fit, width } from './text';
export { unwrapCommand } from './model';

// Explicitly break capped headers so word wrapping on either surface cannot
// turn a two-line header into three. Indentation belongs to the surrounding Box.
export function wrap(text: string, columns: number, maxRows: number): string[] {
  if (columns < 1 || maxRows < 1) return [];
  let chars = clusters(clean(text));
  const lines: string[] = [];
  while (chars.length && lines.length < maxRows) {
    if (lines.length === maxRows - 1) { lines.push(fit(chars.join(''), columns)); break; }
    let used = 0;
    let end = 0;
    while (end < chars.length && used + cells(chars[end]!) <= columns) used += cells(chars[end++]!);
    if (!end) { chars.shift(); lines.push('…'); continue; }
    if (end < chars.length && chars[end] !== ' ') {
      const space = chars.slice(0, end).lastIndexOf(' ');
      if (space > 0) end = space;
    }
    lines.push(chars.slice(0, end).join('').trimEnd());
    chars = chars.slice(end);
    while (chars[0] === ' ') chars.shift();
  }
  return lines;
}

export function jobState(job: CodexLiveJob): { word: string; color: ThemeKey } {
  const { status, active } = jobLifecycle(job);
  if (active && job.question) return { word: 'Question for Claude', color: 'warning' };
  if (active && status === 'waiting') return { word: 'Waiting for Claude', color: 'warning' };
  switch (status) {
    case 'unresolved': return { word: 'Outcome unknown', color: 'warning' };
    case 'queued': return { word: 'Queued', color: 'subtle' };
    case 'running': return { word: 'Running', color: 'claude' };
    case 'completed': return { word: 'Done', color: 'success' };
    case 'failed': return { word: 'Failed', color: 'error' };
    case 'needs_input': return { word: 'Needs your attention', color: 'warning' };
    case 'blocked': return { word: 'Needs your attention', color: 'error' };
    case 'cancelled':
    case 'stopped':
    case 'interrupted': return { word: 'Stopped', color: 'inactive' };
    default: return { word: 'Unknown', color: 'warning' };
  }
}

function staleJob(job: CodexLiveJob | CodexLiveSession): boolean {
  return job.detailsUnavailable || 'turns' in job && job.turns.some(turn => turn.detailsUnavailable);
}

export function jobRowColor(job: CodexLiveJob | CodexLiveSession): ThemeKey {
  return staleJob(job) ? 'warning' : jobState(job).color;
}

export function jobRow(job: CodexLiveJob | CodexLiveSession, selected: boolean, columns: number, now: number, isNew = false): Span[] {
  return tableRow(job, selected, columns, { jobs: [job], selectedId: selected ? job.id : null, nowMs: now,
    newSessionIds: isNew ? [job.id] : [] }, [job]);
}

export type ResultLine = { text: string; color: ThemeKey; bold?: boolean };
export type FeedItem = {
  key: string;
  notice?: boolean;
  title: string;
  bold?: string;
  maxRows?: number;
  markdown?: string;
  prompt?: { turnId: string; text: string; report: boolean };
  color: ThemeKey;
  results: ResultLine[];
  rowKind?: 'prose' | 'action' | 'change' | 'explored' | 'claude' | 'question' | 'notice';
  action?: { verb: string; args: string; program?: string; words?: string[]; more?: number; added?: number; removed?: number };
  header?: { name: string; detail: string };
  final?: ThemeKey;
  durationMs?: number;
  rawCommand?: string;
};

function failed(event: CodexLiveEvent): boolean {
  return ['failed', 'error'].includes(event.status ?? '') ||
    event.type === 'commandExecution' && event.exitCode != null && event.exitCode !== 0;
}

function unknownExit(event: CodexLiveEvent): boolean { return event.type === 'commandExecution' && event.exitCode == null; }

function inProgress(event: CodexLiveEvent): boolean {
  return event.lifecycle === 'started' || ['inProgress', 'running', 'queued'].includes(event.status ?? '');
}

function cancelled(event: CodexLiveEvent): boolean { return ['cancelled', 'declined'].includes(event.status ?? ''); }

export function compactNumber(value: number): string {
  if (value < 1000) return String(Math.max(0, Math.floor(value)));
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 2 : value < 100_000 ? 1 : 0).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')}k`;
  return `${(value / 1_000_000).toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}M`;
}
function duration(seconds: number): string {
  seconds = Math.max(0, Math.floor(seconds));
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
    : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
}
export function toolResult(event: CodexLiveEvent, now: number, job?: CodexLiveJob): ResultLine {
  if (cancelled(event)) return { text: event.status!, color: 'inactive' };
  if (inProgress(event) && job?.unresolved) return { text: 'unresolved', color: 'warning' };
  if (inProgress(event) && job && !jobLifecycle(job).active) return { text: 'interrupted', color: 'inactive' };
  if (failed(event)) return { text: event.exitCode == null ? '✗ error' : `✗ exit ${event.exitCode}`, color: 'error' };
  if (inProgress(event)) {
    const start = Date.parse(event.at ?? '');
    return { text: `running ${Number.isFinite(start) ? duration((now - start) / 1000) : '—'}`, color: 'claude' };
  }
  if (['interrupted', 'stopped'].includes(event.status ?? '')) return { text: event.status!, color: 'inactive' };
  if (unknownExit(event)) return { text: 'exit ?', color: 'warning' };
  return { text: `✓${(event.durationMs ?? 0) >= 1000 ? ` ${duration(event.durationMs! / 1000)}` : ''}`, color: 'success' };
}

// Display-only path handling. No filesystem reads or resolution are needed.
export function relativePath(path: string, workspaceRoot?: string): string {
  if (!workspaceRoot || !isAbsolutePath(workspaceRoot) || !isAbsolutePath(path)) return path;
  if ((workspaceRoot[0] === '/') !== (path[0] === '/')) return path;
  const windows = path[0] !== '/';
  const normalize = (value: string) => {
    const source = windows ? value.replace(/\\/g, '/') : value;
    // Keep the drive or UNC share outside the components that '..' can remove.
    const volume = windows ? source.match(/^(?:[a-z]:|\/\/[^/]+\/[^/]+)/i)![0] : '';
    const parts: string[] = [];
    for (const part of source.slice(volume.length).split('/')) {
      if (part === '..') parts.pop();
      else if (part && part !== '.') parts.push(part);
    }
    return `${volume}/${parts.join('/')}`;
  };
  const root = normalize(workspaceRoot);
  const normalized = normalize(path);
  const prefix = root.endsWith('/') ? root : `${root}/`;
  const compare = (value: string) => windows ? value.toLowerCase() : value;
  return compare(normalized).startsWith(compare(prefix)) ? normalized.slice(prefix.length) : path;
}

export function eventItem(event: CodexLiveEvent, job: CodexLiveJob, now: number): FeedItem {
  const result = toolResult(event, now, job);
  const base: FeedItem = { key: `event-${event.seq}`, title: '', rowKind: 'notice', color: result.color, results: [], durationMs: event.durationMs };
  switch (event.type) {
    case 'agentMessage': return { ...base, rowKind: 'prose', color: 'text', markdown: event.body ?? event.text ?? '' };
    case 'commandExecution': {
      const command = commandDisplay(clean(event.command), job.cwd ?? job.workspaceRoot, job.homeDir);
      return { ...base, rawCommand: event.command, rowKind: 'action', title: `${command.verb}${command.args ? ` ${command.args}` : ''}`,
        action: command, results: [result] };
    }
    case 'fileChange': {
      const path = relativePath(event.path ?? '', job.cwd ?? job.workspaceRoot);
      return { ...base, rowKind: 'change', title: `edit ${path}`, action: { verb: 'edit', args: path, added: event.added, removed: event.removed }, results: [result] };
    }
    case 'mcpToolCall':
    case 'dynamicToolCall': {
      const name = [event.server, event.tool || 'unknown'].filter(Boolean).join('.');
      return { ...base, rowKind: event.tool === 'ask_parent' ? 'question' : 'action', title: event.tool === 'ask_parent'
        ? `? asks Claude · ${event.questionText?.split('\n')[0] ?? 'Waiting for a question record'}` : name,
        action: { verb: 'call', args: name }, results: [result,
          ...(event.questionText === undefined ? [] : [{ text: event.questionText, color: 'warning' as const },
            ...(event.answer === undefined ? [] : [{ text: event.answer, color: 'subtle' as const }])])] };
    }
    case 'plan': return { ...base, title: 'Plan', color: failed(event) ? 'error' : 'subtle',
      results: (event.steps ?? []).map((step, i) => ({ text: `${event.statuses?.[i] === 'completed' ? '☒' : '☐'} ${step}`,
        color: 'subtle', bold: event.statuses?.[i] === 'inProgress' })) };
    default: return { ...base, title: clean(`${event.type} ${event.status ?? ''}`) };
  }
}

// jobView has already collapsed lifecycles. Collapsing again can incorrectly
// pair an older overlapping start with a completion already matched once.
export function toolUseCount(events: readonly CodexLiveEvent[]): number {
  return events.filter(event =>
    ['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall'].includes(event.type)).length;
}

export const shortModel = (model: string) => model.replace(/^gpt-[\d.]+-(.+)$/, '$1');
export function workerRole(job: CodexLiveJob): string {
  const role = job.role?.replace(/^.*(?:codex|fugato)[-:]/, '') ?? '';
  if (['reviewer', 'investigator', 'implementer', 'conjecturer', 'critic', 'improver', 'integrator', 'steward', 'calibrator'].includes(role)) return role;
  return ['conjecturer', 'critic', 'improver', 'integrator', 'steward', 'calibrator'].includes(job.agentName ?? '') ? job.agentName! : 'worker';
}
export function workerHeader(job: CodexLiveJob): { name: string; detail: string } {
  const cwd = (job.cwd ?? job.workspaceRoot)?.replace(/[\\/]$/, '').split(/[\\/]/).at(-1);
  return { name: job.agentName || taskText(job.label),
    detail: ` · ${workerRole(job)} · ${[shortModel(job.model), job.effort].filter(Boolean).join(' ') || 'model unknown'}${cwd ? ` · ${cwd}` : ''}` };
}
export function headerItem(job: CodexLiveJob, _now: number): FeedItem {
  const header = workerHeader(job);
  return { key: 'job-header', title: header.name + header.detail, header, rowKind: 'notice',
    color: 'subtle', results: [
      ...(job.blockerCode ? [{ text: `Needs attention · ${job.blockerCode}`, color: 'warning' as const }] : []),
      ...(job.detailsUnavailable ? [{ text: 'Details unavailable · showing the last good view', color: 'warning' as const }] : []),
    ] };
}

export function activityItems(job: CodexLiveJob): CodexLiveEvent[] {
  const events = job.events;
  const latestPlan = events.filter(event => event.type === 'plan').at(-1);
  return events.filter(event => event.type !== 'plan' || event === latestPlan).slice(-80);
}

export function feedItems(job: CodexLiveJob | CodexLiveSession, now: number): FeedItem[] {
  const turns = 'turns' in job ? job.turns : [job];
  const detailedIds = new Set(('turns' in job ? detailedTurns(job) : turns).map(turn => turn.id));
  const ownerId = 'turns' in job ? job.lifecycleJobId : job.id;
  const omitted = 'turns' in job ? Math.max(0, job.turnCount - turns.length) : 0;
  const notice: FeedItem[] = omitted ? [{ key: 'earlier-turns', notice: true,
    title: `${omitted} earlier ${omitted === 1 ? 'turn' : 'turns'} not shown`, color: 'subtle', results: [] }] : [];
  return [...notice, ...turns.flatMap(turn => {
    const detailed = detailedIds.has(turn.id) && !turn.detailsOmitted;
    const prompt: FeedItem[] = detailed && turn.prompt !== undefined ? [{ key: 'prompt', title: 'Claude', rowKind: 'claude', maxRows: 1,
      color: 'claude', results: [], prompt: { turnId: turn.id, text: turn.prompt, report: turn.promptReport === true } }] : [];
    const activity = detailed ? activityItems(turn) : [];
    const closing = new Set<number>();
    if (['completed', 'failed', 'blocked'].includes(turn.status) && !turn.unresolved) {
      for (const event of [...activity].reverse()) {
        if (event.type !== 'agentMessage') break;
        closing.add(event.seq);
      }
    }
    const projected = activity.map(event => ({ ...eventItem(event, turn, now),
      ...(closing.has(event.seq) ? { final: [turn.status, turn.finalStatus].some(status => ['failed', 'blocked'].includes(status)) ? 'error' as const : 'success' as const } : {}) }));
    const items = [headerItem(turn, now), ...prompt, ...exploredItems(projected)];
    if (turn.id === ownerId && jobLifecycle(turn).active && turn.question) items.push({ key: 'pending-question', title: `? asks Claude · ${turn.question.text.split('\n')[0]}`, rowKind: 'question', color: 'warning',
      results: [{ text: turn.question.text, color: 'subtle' },
        ...turn.question.options.map((option, i): ResultLine => ({ text: `${i + 1}. ${option}`, color: 'subtle' }))] });
    if (jobLifecycle(turn).finished && turn.status === 'needs_input' && turn.terminalQuestion) items.push({
      key: 'terminal-question', title: `? asks Claude · ${turn.terminalQuestion.split('\n')[0]}`, rowKind: 'question', color: 'warning', results: [{ text: turn.terminalQuestion, color: 'subtle' }] });
    if (detailed && turn.detailsLoaded === false && !turn.detailsUnavailable) items.push({ key: 'loading', title: 'Loading transcript…', color: 'subtle', results: [] });
    return turn.threadId?.trim() ? items.map(item => ({ ...item, key: turnKey(item.key, turn.id) })) : items;
  })];
}

export type Span = { text: string; color?: ThemeKey; bold?: boolean; italic?: boolean; dim?: boolean; start?: number; end?: number };
export type FeedLine = { key: string; spans: Span[]; source?: string; start?: number; end?: number; togglePromptId?: string; togglePostId?: string };
export type FeedLines = FeedLine[] & { sources?: Record<string, string> };

function clipLines(lines: FeedLines, columns: number): FeedLines {
  for (const line of lines) line.spans = clipSpans(line.spans, columns);
  return lines;
}

// Small inline grammar, deliberately not a Markdown renderer: every output
// line has a known cell width. Parse styles before wrapping, including links.
export function inlineSpans(text: string, style: Omit<Span, 'text'> = {}): Span[] {
  const spans: Span[] = [];
  const pattern = /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\([^)]+\)/g;
  let start = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > start) spans.push({ ...style, text: text.slice(start, match.index) });
    if (match[1] !== undefined) spans.push(...inlineSpans(match[1], { ...style, bold: true }));
    else if (match[2] !== undefined) spans.push({ ...style, color: 'suggestion', text: match[2] });
    else spans.push(...inlineSpans(match[3]!, style));
    start = match.index + match[0].length;
  }
  if (start < text.length) spans.push({ ...style, text: text.slice(start) });
  return spans;
}

function compact(spans: Span[]): Span[] {
  const result: Span[] = [];
  for (const span of spans) {
    if (!span.text) continue;
    const last = result.at(-1);
    if (last && last.color === span.color && last.bold === span.bold && last.italic === span.italic && last.dim === span.dim) {
      last.text += span.text;
      last.end = span.end;
    } else result.push({ ...span });
  }
  return result;
}

function clipSpans(spans: Span[], columns: number): Span[] {
  const text = spans.map(span => span.text).join('');
  if (width(text) <= columns) return spans;
  const fitted = fit(text, columns);
  let remaining = Math.max(0, fitted.length - 1);
  const result: Span[] = [];
  for (const span of spans) {
    if (!remaining) break;
    result.push({ ...span, text: span.text.slice(0, remaining) });
    remaining -= Math.min(remaining, span.text.length);
  }
  if (columns > 0) result.push({ ...result.at(-1), text: '…' });
  return compact(result);
}

function wrapSpans(spans: Span[], columns: number, first = '', hanging = '', maxRows = Infinity): Span[][] {
  if (columns < 1) return [[]];
  // Segment across style boundaries too: a combining mark or ZWJ may follow
  // a Markdown delimiter. The cluster takes the first code point's style.
  let offset = 0;
  let spanIndex = 0;
  let spanEnd = spans[0]?.text.length ?? 0;
  const chars = clusters(spans.map(span => span.text).join('')).map(text => {
    while (offset >= spanEnd && spanIndex < spans.length - 1) spanEnd += spans[++spanIndex]!.text.length;
    const start = offset; offset += text.length;
    return { ...spans[spanIndex], text, start, end: offset };
  });
  const lines: Span[][] = [];
  let start = 0;
  do {
    const prefix = fit(lines.length ? hanging : first, Math.max(0, columns - 1));
    const room = columns - width(prefix);
    const indent: Span[] = prefix ? [{ text: prefix }] : [];
    if (lines.length === maxRows - 1) {
      lines.push([...indent, ...clipSpans(compact(chars.slice(start)), room)]);
      break;
    }
    let end = start;
    let used = 0;
    let space = -1;
    while (end < chars.length && used + cells(chars[end]!.text) <= room) {
      if (chars[end]!.text === ' ') space = end;
      used += cells(chars[end++]!.text);
    }
    if (end === start && end < chars.length) {
      // A wide glyph in a one-cell window must still consume input.
      lines.push([...indent, { ...chars[start], text: '…' }]);
      start++;
      continue;
    }
    if (end < chars.length && chars[end]!.text !== ' ' && space > start) end = space;
    let trimmed = end;
    while (trimmed > start && chars[trimmed - 1]!.text === ' ') trimmed--;
    lines.push([...indent, ...compact(chars.slice(start, trimmed))]);
    start = end;
    while (chars[start]?.text === ' ') start++;
  } while (start < chars.length);
  return lines;
}

type LaidRow = { spans: Span[]; start: number; end: number };
function laid(spans: Span[][], base = 0): LaidRow[] {
  return spans.map(row => ({ spans: row, start: base + (row.find(span => span.start !== undefined)?.start ?? 0),
    end: base + ([...row].reverse().find(span => span.end !== undefined)?.end ?? 0) }));
}
function messageLayout(body: string, columns: number): { rows: LaidRow[]; text: string } {
  const rows: LaidRow[] = [];
  let text = '';
  let fence: string | undefined;
  // Trailing newlines in a message are not rows: the feed adds its own spacing.
  for (const line of cleanBody(body).replace(/\t/g, '    ').replace(/\n+$/, '').split('\n')) {
    const delimiter = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (delimiter && (!fence || delimiter[0] === fence[0] && delimiter.length >= fence.length)) {
      fence = fence ? undefined : delimiter;
      continue;
    }
    const heading = fence ? null : /^#{1,6}\s+(.+)$/.exec(line);
    const list = fence ? null : /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(line);
    const prefix = list ? `${list[1]}${list[2] === '-' || list[2] === '*' ? '•' : list[2]} ` : '';
    const spans = fence ? [{ text: line, color: 'subtle' as const }] : inlineSpans(heading?.[1] ?? list?.[3] ?? line, heading ? { bold: true } : {});
    const plain = spans.map(span => span.text).join('');
    const cut = fence || /^\s*\|.*\|\s*$/.test(line);
    if (cut) rows.push({ spans: clipSpans(spans, columns), start: text.length, end: text.length + plain.length });
    else rows.push(...laid(wrapSpans(spans, columns, prefix, ' '.repeat(width(prefix))), text.length));
    text += `${plain}\n`;
  }
  return { rows: rows.length ? rows : [{ spans: [], start: 0, end: 0 }], text };
}
export function messageLines(body: string, columns: number): Span[][] {
  // Positions are layout metadata, not part of the public inline-style shape.
  return messageLayout(body, columns).rows.map(row => row.spans.map(({ start, end, ...span }) => span));
}

// A brief is literal text: preserve its headings, list markers and indentation.
// Unlike agent Markdown, blank runs become one row and no inline syntax changes.
function promptLayout(body: string, columns: number): { rows: LaidRow[]; text: string } {
  const rows: LaidRow[] = [];
  let text = '';
  let blank = false;
  for (const line of cleanBody(body).replace(/\t/g, '    ').split('\n')) {
    const empty = !line.trim();
    if (empty && blank) continue;
    blank = empty;
    const literal = empty ? '' : line;
    const prefix = /^ *(?:(?:[-*]|\d+\.) +)?/.exec(literal)![0];
    const indent = ' '.repeat(width(prefix));
    rows.push(...laid(wrapSpans([{ text: literal, color: 'subtle' }], columns, '', indent), text.length));
    text += `${literal}\n`;
  }
  return { rows, text };
}

// Exact role paragraphs and separator from codex/hooks/presets.mjs applyPreset.
// Keep the full brief for expansion; only its collapsed preview skips this prefix.
const presetRolePrompts = [
  'Codex reviewer role: Review the assigned changes without modifying files. Prioritize actionable correctness, regression and security findings; cite file locations and explain impact. Report checks actually run and any review limits.',
  'Codex investigator role: Investigate the assigned question without modifying files. Trace the relevant code and evidence, distinguish observations from hypotheses, and report supported conclusions with file locations and remaining uncertainty.',
  'Codex implementer role: Implement the bounded assignment in the authorized workspace. Respect owned paths and existing changes, keep the solution focused, and run appropriate verification. Report the changes, observed checks and remaining limitations.',
];
function collapsedBrief(body: string): string {
  const prefix = presetRolePrompts.find(prompt => body.startsWith(`${prompt}\n\n`));
  return prefix ? body.slice(prefix.length + 2) : body;
}

// Folding is deliberately independent of display cleanup. These conservative
// rules match native-agent's classifier: unsafe or incomplete shell text stays
// visible, even when cleanup can display just its first program.
function explorationCommand(command: string): string | undefined {
  const parts: string[] = [];
  let start = 0, quote = '', depth = 0, safe = true;
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!, next = command[i + 1];
    if (char === '\\' && quote !== "'") { i++; continue; }
    if (quote) {
      if (char === quote) quote = '';
      else if (quote !== "'" && (char === '`' || char === '$' && next === '(')) safe = false;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') { quote = char; if (char === '`') safe = false; continue; }
    if ('<>'.includes(char) || char === '#' || char === '\n') safe = false;
    if ('({'.includes(char)) { depth++; safe = false; }
    else if (')}'.includes(char)) { depth--; safe = false; }
    if (depth !== 0 || !';&|'.includes(char)) continue;
    if (char === '&' && next !== '&') { safe = false; continue; }
    parts.push(command.slice(start, i).trim());
    if (next === char && char !== ';') i++;
    start = i + 1;
  }
  parts.push(command.slice(start).trim());
  if (!safe || quote || depth !== 0 || !parts.every(Boolean) || command.endsWith('…') || command.length >= 160) return;
  const longOption = (arg: string, ...names: string[]) => {
    const name = arg.split('=')[0]!;
    return name.length > 2 && name.startsWith('--') && names.some(full => full.startsWith(name));
  };
  const programs = parts.map(part => {
    const words = part.match(/(?:[^\s'"\\]+|'[^']*'|"(?:\\.|[^"\\])*"|\\.)+/g) ?? [];
    if (words.some(word => !/^(?:[^\s'"\\$`*?\[\]~]+|'[^'\\$`]*'|"[^"\\$`]*")$/.test(word))) return;
    const [first, ...args] = words.map(word => /^(?:'[^']*'|"[^"\\]*")$/.test(word) ? word.slice(1, -1) : word);
    if (!/^(?:(?:\/usr(?:\/local)?|\/opt\/homebrew)?\/bin\/)?[a-z][a-z-]*$/.test(first ?? '')) return;
    const name = first!.split('/').at(-1)!;
    if (name === 'sed') return args[0] === '-n' && /^(?:(?:[\d$]+(?:,[\d$]+)?)?p\s*;?\s*)+$/.test(args[1] ?? '')
      && !args.slice(2).some(arg => arg.startsWith('-')) ? name : undefined;
    if (name === 'find' && args.some(arg => /^-(?:exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/.test(arg))) return;
    if (name === 'git') return ['diff', 'show', 'log', 'status', 'rev-parse', 'ls-files'].includes(args[0] ?? '')
      && !args.some(arg => /%[-+ ]?G/.test(arg) || longOption(arg, '--output', '--ext-diff', '--textconv', '--show-signature', '--help',
        '--remerge-diff', '--diff-merges', '--submodule', '--alternate-refs')) ? name : undefined;
    return ['rg', 'grep', 'nl', 'cat', 'head', 'tail', 'ls', 'wc', 'find', 'tree', 'file', 'stat'].includes(name)
      && !(name === 'tree' && args.some(arg => /^-[^-]*[oR]/.test(arg) || longOption(arg, '--output')))
      && !(name === 'rg' && args.some(arg => /^-[^-]*z/.test(arg) || longOption(arg, '--pre', '--hostname-bin', '--search-zip')))
      && !(name === 'file' && args.some(arg => /^-[^-]*[CzZp]/.test(arg)
        || longOption(arg, '--compile', '--uncompress', '--uncompress-noreport', '--preserve-date'))) ? name : undefined;
  });
  return programs.every(Boolean) ? programs[0] : undefined;
}

function exploredItems(items: FeedItem[]): FeedItem[] {
  const output: FeedItem[] = [];
  const inspection = (item: FeedItem) => item.rowKind === 'action' && item.results[0]?.text.startsWith('✓') && item.rawCommand !== undefined && !item.rawCommand.includes('\n')
    ? explorationCommand(unwrapCommand(clean(item.rawCommand))) : undefined;
  for (let i = 0; i < items.length; i++) {
    const group = [items[i]!];
    if (inspection(group[0]!)) while (items[i + 1] && inspection(items[i + 1]!)) group.push(items[++i]!);
    if (group.length < 2) output.push(group[0]!);
    else {
      const counts = new Map<string, number>();
      for (const item of group) { const name = inspection(item)!; counts.set(name, (counts.get(name) ?? 0) + 1); }
      const args = `${group.length} commands · ${[...counts].map(([verb, n]) => `${verb}${n > 1 ? ` ×${n}` : ''}`).join(', ')}`;
      output.push({ ...group[0]!, rowKind: 'explored', title: `explored ${args}`, action: { verb: 'explored', args },
        results: [toolResult({ seq: 0, type: 'explored', exitCode: 0, durationMs: group.every(item => item.durationMs !== undefined)
          ? group.reduce((sum, item) => sum + item.durationMs!, 0) : undefined }, 0)] });
    }
  }
  return output;
}
function spanText(spans: Span[]) { return spans.map(span => span.text).join(''); }
export function alignSpans(left: Span[], right: Span[], columns: number, minGap = 1): Span[] {
  right = clipSpans(right, Math.max(0, columns));
  const rightWidth = width(spanText(right));
  left = clipSpans(left, Math.max(0, columns - rightWidth - (rightWidth ? minGap : 0)));
  return [...left, { text: ' '.repeat(Math.max(0, columns - width(spanText(left)) - rightWidth)) }, ...right];
}
function pathSpans(text: string): Span[] {
  const spans: Span[] = [];
  let offset = 0;
  for (const word of tokenize(text)) {
    if (word.start > offset) spans.push({ text: text.slice(offset, word.start), color: 'subtle' });
    const raw = text.slice(word.start, word.end), slash = raw.lastIndexOf('/');
    if (slash < 0 || word.text.startsWith('-')) spans.push({ text: raw, color: 'subtle' });
    else spans.push({ text: raw.slice(0, slash + 1), color: 'subtle' }, { text: raw.slice(slash + 1), color: 'text' });
    offset = word.end;
  }
  if (offset < text.length) spans.push({ text: text.slice(offset), color: 'subtle' });
  return spans;
}

function actionSpans(item: FeedItem, columns: number): Span[] {
  const action = item.action!;
  const status = item.results[0];
  let right: Span[] = status?.text.startsWith('✓') ? [{ text: '✓', color: 'success' },
    ...(status.text.length > 1 ? [{ text: status.text.slice(1), color: 'subtle' as const }] : [])] : status ? [status] : [];
  if (item.rowKind === 'change' && status?.text.startsWith('✓')) {
    // A zero side is omitted when the other side changed: a new file reads `+2`.
    const added = action.added !== undefined && !(action.added === 0 && action.removed);
    const removed = action.removed !== undefined && !(action.removed === 0 && action.added);
    right = [
      ...(added ? [{ text: `+${action.added}`, color: 'diffAdded' as const }] : []),
      ...(added && removed ? [{ text: ' ' }] : []),
      ...(removed ? [{ text: `−${action.removed}`, color: 'diffRemoved' as const }] : []),
    ];
  }
  const leftColumns = Math.max(0, columns - width(spanText(right)) - (right.length ? 1 : 0));
  const suffix = action.more ? ` +${action.more}` : '';
  const bodyColumns = Math.max(0, leftColumns - width(suffix));
  const fitted = action.words ? fitCommand(action.program ?? action.verb, action.words, Math.max(0, bodyColumns - 4))
    : item.rowKind === 'change' ? fitCommand(action.verb, [action.args], Math.max(0, bodyColumns - 4), true, false) : action;
  const slash = fitted.args.lastIndexOf('/');
  const args: Span[] = item.rowKind === 'change' ? [
    { text: fitted.args.slice(0, slash + 1), color: 'subtle' }, { text: fitted.args.slice(slash + 1), color: 'text' },
  ] : pathSpans(fitted.args);
  const left = clipSpans([{ text: '  › ', color: 'subtle' }, { text: fitted.verb, color: 'text' },
    ...(fitted.args ? [{ text: ' ' }, ...args] : [])], bodyColumns);
  return alignSpans([...left, ...clipSpans(suffix ? [{ text: suffix, color: 'subtle' }] : [], leftColumns)], right, columns);
}

export function feedLines(job: CodexLiveJob | ForumRoom, now: number, columns: number, view?: CodexLiveFeedView): FeedLines {
  if ('roomId' in job) return forumFeedLines(job, now, columns, view);
  const lines: FeedLines = [];
  const sources: Record<string, string> = {};
  let previous = '';
  for (const item of feedItems(job, now)) {
    const kind = item.rowKind ?? 'notice';
    const action = ['action', 'change', 'explored'].includes(kind);
    const beforeAction = ['action', 'change', 'explored'].includes(previous);
    const source = `${item.key}-body`;
    if (lines.length && ((previous === 'prose' || kind === 'prose') && !(action && beforeAction) ||
        previous === 'claude' || kind === 'claude' && previous !== 'notice')) {
      lines.push({ key: `${item.key}-gap`, spans: [], source, start: 0, end: 0 });
    }
    previous = kind;
    if (item.notice) {
      lines.push({ key: item.key, source: 'job-header-omitted', start: 0, end: item.title.length,
        spans: [{ text: fit(item.title, columns), color: 'subtle' }] });
      continue;
    }
    if (item.prompt) {
      const resultSource = `${item.key}-results`;
      const expanded = view?.expandedPromptIds?.includes(item.prompt.turnId);
      const prompt = promptLayout(expanded ? item.prompt.text : collapsedBrief(item.prompt.text), Math.max(0, columns - 9));
      const shown = expanded ? prompt.rows : prompt.rows.slice(0, 1);
      sources[resultSource] = prompt.text;
      shown.forEach((row, i) => {
        const cut = !expanded && !!prompt.text.slice(row.end, prompt.text.indexOf('\n')).trim();
        const spans = cut ? clipSpans([...row.spans, { text: '…' }], Math.max(0, columns - 9)) : row.spans;
        lines.push({ key: `${item.key}-result-${i}`, source: resultSource, start: row.start, end: row.end,
          spans: [{ text: fit(i ? '         ' : 'Claude › ', columns), color: 'claude' },
            ...spans.map(span => ({ ...span, color: 'subtle' as const, italic: true }))] });
      });
      if (expanded && item.prompt.report) lines.push({ key: `${item.key}-report`, source: `${item.key}-report`, start: 0, end: 0,
        spans: [{ text: fit('         + standard report instructions', columns), color: 'subtle' }] });
      if (item.prompt.report) sources[`${item.key}-report`] = '+ standard report instructions';
      if (expanded || prompt.rows.length > 1) {
        const toggleSource = `${item.key}-toggle`;
        sources[toggleSource] = 'Prompt';
        lines.push({ key: toggleSource, source: toggleSource, start: 0, end: 0, togglePromptId: item.prompt.turnId,
          spans: [{ text: fit(expanded ? '         click to collapse' : `         ⋯ ${prompt.rows.length - 1} more ${prompt.rows.length === 2 ? 'line' : 'lines'}`, columns), color: 'suggestion' }] });
      }
      continue;
    }
    if (item.markdown !== undefined) {
      const body = messageLayout(item.markdown, Math.max(0, columns - (item.final ? 1 : 0)));
      sources[source] = body.text;
      body.rows.forEach((row, i) => lines.push({ key: `${item.key}-body-${i}`, source, start: row.start, end: row.end,
        spans: [...(item.final ? [{ text: fit('▏', columns), color: item.final }] : []), ...row.spans] }));
      continue;
    }
    sources[source] = item.title;
    const spans: Span[] = item.action && action ? actionSpans(item, columns) : item.header
      ? clipSpans([{ text: item.header.name, bold: true }, { text: item.header.detail, color: 'subtle' }], columns)
      : [{ text: fit(item.title, columns), color: kind === 'question' ? 'warning' : item.color }];
    lines.push({ key: `${item.key}-body-0`, source, start: 0, end: item.title.length, spans });
    // Questions and notices may carry content; tool completion rows never do.
    const results = kind === 'question' ? item.action ? item.results.slice(2).map(result => ({ ...result, text: `↳ answered · ${result.text}`, color: 'subtle' as const })) : item.results.slice(1)
      : action ? [] : item.results;
    const resultSource = `${item.key}-results`;
    let text = '';
    for (const result of results) {
      for (const row of laid(wrapSpans([result], columns), text.length)) lines.push({ key: `${item.key}-result-${lines.length}`,
        source: resultSource, start: row.start, end: row.end, spans: row.spans });
      text += `${result.text}\n`;
    }
    if (text) sources[resultSource] = text;
  }
  lines.sources = sources;
  return clipLines(lines, columns);
}

export function selectedJob(state: CodexLiveState): CodexLiveSession | undefined {
  if (selectedForum(state)) return;
  const jobs = visibleSessions(state).sort(newestJob);
  const selected = sessionForId(jobs, state.selectedId) ?? jobs.find(job => jobLifecycle(job).active) ?? jobs[0];
  return selected && state.usageByJob ? { ...selected, sessionUsage: state.usageByJob, usagePartial: state.usagePartial } : selected;
}

const newestJob = (a: CodexLiveJob, b: CodexLiveJob) =>
  b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);

export function recentEndedJobIds(jobs: readonly CodexLiveJob[], now: number,
  endTime = (job: CodexLiveJob): number => Date.parse(job.completedAt)): string[] {
  return jobs.filter(job => jobLifecycle(job).finished && now >= endTime(job) && now - endTime(job) < 120_000)
    .sort((a, b) => endTime(b) - endTime(a) || newestJob(a, b)).map(job => job.id);
}

export function headerLayout(state: CodexLiveState, selected: CodexLiveJob, bodyRows: number, force = false) {
  // In tiny windows reserve the footer and one feed row before the list.
  const sessions = visibleSessions(state);
  selected = sessionForId(sessions, selected.id) ?? selected;
  const clear = sessions.some(job => jobLifecycle(job).finished) || visibleForums(state).some(room => room.status === 'closed');
  const room = Math.max(0, bodyRows - 2);
  if ((!force && sessions.length < 2 && !clear && (sessions[0]?.turnCount ?? 0) < 2) || room < 2) return { jobs: [], toggle: false, more: 0, rows: 0 };
  const newest = [...sessions].sort(newestJob);
  // The poller computes this list against its actual tick, even when no jobs
  // remain active. Older persisted states can still use explicit completedAt.
  const recent = (state.recentEndedIds ?? recentEndedJobIds(sessions, state.nowMs))
    .map(id => sessionForId(sessions, id)).filter((job): job is CodexLiveSession => !!job && jobLifecycle(job).finished);
  const active = newest.filter(job => jobLifecycle(job).active);
  const unique = (jobs: CodexLiveJob[]) => jobs.filter((job, i) => jobs.findIndex(other => other.id === job.id) === i);
  const needingAttention = newest.filter(job => attention(job)).sort(attentionOrder);
  const priority = unique([...needingAttention, ...active, selected, ...recent]);
  const take = (candidates: CodexLiveJob[], limit: number) => {
    if (limit < 1) return [];
    const jobs = candidates.slice(0, limit);
    // Preserve the selected row even when active jobs fill the available slots.
    if (!jobs.some(job => job.id === selected.id)) {
      if (jobs.length === limit) jobs.pop();
      jobs.push(selected);
    }
    return jobs;
  };
  const collapsed = take(priority, 3);
  // Expand the collapsed prefix, then remaining history by creation time.
  // Extra active jobs still lead when they exceeded the collapsed row limit.
  const candidates = state.jobsExpanded ? unique([...needingAttention, ...active, ...collapsed, ...newest]) : priority;
  const limit = state.jobsExpanded ? 10 : 3;
  let jobs = take(candidates, Math.min(limit, room - (clear ? 2 : 1)));
  // In expanded mode keep "Show fewer" when all history is visible, never +0.
  const showToggle = jobs.length < sessions.length || !!state.jobsExpanded && collapsed.length < sessions.length;
  if (showToggle || clear) jobs = take(candidates, Math.min(limit, room - 2));
  const capacity = Math.max(1, Math.min(10, room - 2));
  const pageCount = Math.ceil(candidates.length / capacity);
  const page = Math.min(Math.max(0, state.historyPage ?? 0), Math.max(0, pageCount - 1));
  if (state.jobsExpanded) jobs = candidates.slice(page * capacity, (page + 1) * capacity);
  if (!jobs.length || room < 3 && (showToggle || clear)) return { jobs: [], toggle: false, more: sessions.length, rows: 0, pageCount: 0 };
  return { jobs, toggle: showToggle, clear, more: sessions.length - jobs.length,
    rows: jobs.length + 1 + (showToggle || clear ? 1 : 0), pageCount, page };

}

// Render uses its current props, scroll uses its current event, and polling
// uses the last measurement. Never grow a render to an older measured height.
export function paneLayout(state: CodexLiveState, selected: CodexLiveJob | ForumRoom | undefined,
  availableRows: number, failure = false, columns = 60) {
  const bodyRows = Math.max(0, Math.floor(availableRows));
  const forum = selected && 'roomId' in selected ? selected : undefined;
  const worker = selected && !('roomId' in selected) ? selected : visibleSessions(state).sort(newestJob)[0];
  const nameHint = selected && !forum && reusedAgentName(selected as CodexLiveJob) && bodyRows > 2
    ? '-N: name reused after this session used every name' : undefined;
  const hintRows = nameHint ? 1 : 0;
  const footerRows = bodyRows > 0 ? (bodyRows > 2 ? 2 : 1) + hintRows : 0;
  const listedRooms = visibleForums(state).sort(forumOrder);
  const roomControls = listedRooms.some(room => room.status === 'closed') ? 1 : 0;
  const titleRows = bodyRows >= 7 && (visibleSessions(state).length || listedRooms.length) ? 1 : 0;
  const top: Span[][] = forum ? [
    clipSpans([{ text: fit(forum.goal.split('\n')[0] ?? '', Math.min(40,
      Math.max(0, columns - width(` · ${forum.intensity} · ${forum.status} · ${forum.postCount} posts`)))), bold: true },
      { text: ` · ${forum.intensity} · ${forum.status} · ${forum.postCount} posts`, color: 'subtle' }], columns),
    [{ text: fit(forum.members.join(' · '), columns), color: 'subtle' as const }],
  ].slice(0, Math.max(0, bodyRows - footerRows - titleRows - 1)) : [];
  const roomBudget = Math.max(0, bodyRows - footerRows - titleRows - top.length - 2 - roomControls);
  const forumRooms = listedRooms.slice(0, Math.min(3, roomBudget));
  const header = worker ? headerLayout(state, worker, bodyRows - hintRows - top.length - forumRooms.length - titleRows - (bodyRows > 2 ? 1 : 0), true)
    : { jobs: [], toggle: false, clear: false, more: 0, rows: 0, pageCount: 0 };
  const roomClear = !header.rows && forumRooms.some(room => room.status === 'closed');
  const headerRows = header.rows + forumRooms.length + titleRows + (roomClear ? 1 : 0) + ((forumRooms.length || titleRows) && !header.rows ? 1 : 0);
  const pinnedRows = headerRows + top.length;
  return { bodyRows, header: { ...header, clear: header.clear || roomClear, rows: headerRows, workerRows: header.rows, forumRooms, titleRows }, top, pinnedRows, footerRows, nameHint,
    rows: Math.max(0, bodyRows - pinnedRows - footerRows) };
}

function hash(text: string): number {
  let n = 2166136261;
  for (let i = 0; i < text.length; i++) n = Math.imul(n ^ text.charCodeAt(i), 16777619);
  return n >>> 0;
}
function snapshot(lines: FeedLines): NonNullable<CodexLiveFeedView['seenItems']> {
  return Object.fromEntries(Object.entries(lines.sources ?? {}).filter(([key]) => !key.startsWith('job-header'))
    .map(([key, text]) => [key, { length: text.length, hash: hash(text) }]));
}
export function normalizeFeed(lines: FeedLines, rows: number, view?: CodexLiveFeedView): CodexLiveFeedView {
  const bottom = Math.max(0, lines.length - rows);
  let feedOffset = view?.feedOffset ?? bottom;
  if (view?.anchor && !view.following) {
    const matches = lines.map((line, i) => ({ line, i })).filter(({ line }) => line.source === view.anchor!.source);
    if (matches.length) feedOffset = matches.filter(({ line }) => (line.start ?? 0) <= view.anchor!.offset).at(-1)?.i ?? matches[0]!.i;
  }
  const following = view?.following !== false || !view?.keepStopped && feedOffset >= bottom;
  feedOffset = following ? bottom : Math.max(0, Math.min(bottom, feedOffset));
  const line = lines[feedOffset];
  return { ...view, feedOffset, following, keepStopped: following ? undefined : view?.keepStopped,
    rows, seenLines: following ? lines.length : view?.seenLines ?? lines.length,
    seenItems: following ? undefined : view?.seenItems ?? snapshot(lines),
    anchor: line?.source ? { source: line.source, offset: line.start ?? 0 } : undefined };
}
export function feedWindow(lines: FeedLines, rows: number, view?: CodexLiveFeedView) {
  const normalized = normalizeFeed(lines, rows, view);
  const seen = normalized.seenItems ?? {};
  const sources = lines.sources ?? {};
  const known = new Map(Object.entries(seen).map(([key, item]) => [key,
    hash((sources[key] ?? '').slice(0, item.length)) === item.hash]));
  const newLines = normalized.following ? 0 : lines.filter(line => {
    if (!line.source || line.source.startsWith('job-header')) return false;
    const previous = seen[line.source];
    return !previous || !known.get(line.source) || (line.end ?? 0) > previous.length;
  }).length;
  return { offset: normalized.feedOffset, bottom: Math.max(0, lines.length - rows), following: normalized.following, newLines,
    lines: lines.slice(normalized.feedOffset, normalized.feedOffset + rows), view: normalized };
}
export function scrollFeed(lines: FeedLines, rows: number, view: CodexLiveFeedView | undefined,
  by: number, bodyRows: number, contentRows: number, wheel = false): CodexLiveFeedView {
  const current = normalizeFeed(lines, rows, view);
  const bottom = Math.max(0, lines.length - rows);
  const end = !wheel && contentRows > 0 && Math.abs(by) >= contentRows;
  const delta = !wheel && Math.abs(by) === bodyRows ? Math.sign(by) * rows : by;
  const feedOffset = end ? (by < 0 ? 0 : bottom) : Math.max(0, Math.min(bottom, current.feedOffset + delta));
  return normalizeFeed(lines, rows, { ...current, anchor: undefined, keepStopped: undefined, feedOffset, following: feedOffset === bottom,
    seenItems: current.following ? snapshot(lines) : current.seenItems, seenLines: current.following ? lines.length : current.seenLines });
}
export function reconcileFeed(previous: CodexLiveJob, job: CodexLiveJob, view: CodexLiveFeedView, now: number): CodexLiveFeedView {
  const columns = view.columns ?? 60;
  const rows = view.rows ?? 8;
  const before = view.anchor && view.seenItems ? view : normalizeFeed(feedLines(previous, now, columns, view), rows, view);
  return normalizeFeed(feedLines(job, now, columns, view), rows, before);
}

export function togglePrompt(job: CodexLiveJob | ForumRoom, now: number, columns: number, rows: number,
  view: CodexLiveFeedView | undefined, turnId: string): CodexLiveFeedView {
  const lines = feedLines(job, now, columns, view);
  const before = normalizeFeed(lines, rows, view);
  const expanded = new Set(before.expandedPromptIds);
  if (expanded.has(turnId)) expanded.delete(turnId);
  else expanded.add(turnId);
  return expandFeed(job, now, columns, rows, lines, before, [...expanded]);
}

export function toggleForumPosts(room: ForumRoom, now: number, columns: number, rows: number,
  view?: CodexLiveFeedView): CodexLiveFeedView {
  const lines = feedLines(room, now, columns, view);
  const before = normalizeFeed(lines, rows, view);
  const ids = (room.posts ?? []).map(post => `post:${post.seq}`);
  const expanded = new Set(before.expandedPromptIds);
  const collapse = ids.every(id => expanded.has(id));
  for (const id of ids) { if (collapse) expanded.delete(id); else expanded.add(id); }
  return expandFeed(room, now, columns, rows, lines, before, [...expanded], true);
}

function expandFeed(job: CodexLiveJob | ForumRoom, now: number, columns: number, rows: number,
  lines: FeedLines, before: CodexLiveFeedView, expandedPromptIds: string[], keepStopped = false): CodexLiveFeedView {
  // Freeze the current top source/character offset even when following the end.
  // normalizeFeed resolves that same anchor after reflow, like scrolling/polls.
  const next = { ...before, expandedPromptIds: expandedPromptIds.slice(-EXPANDED_ID_LIMIT), following: false,
    keepStopped: keepStopped || undefined, seenItems: before.seenItems ?? snapshot(lines), columns };
  // A collapsed body's anchor moves to that post's stable title row.
  const post = 'roomId' in job && next.anchor?.source.match(/^(post:\d+)-(?:body|refs|gap)$/)?.[1];
  if (post && !next.expandedPromptIds.includes(post)) next.anchor = { source: `${post}-title`, offset: 0 };
  return normalizeFeed(feedLines(job, now, columns, next), rows, next);
}

export function footerLayout(job: CodexLiveJob | ForumRoom, state: CodexLiveState, columns: number, following: boolean, newLines: number) {
  if ('roomId' in job) {
    const expanded = state.feeds?.[`forum:${job.roomId}`]?.expandedPromptIds ?? [];
    const label = job.posts?.length && job.posts.every(post => expanded.includes(`post:${post.seq}`)) ? 'collapse all' : 'expand all';
    const toggle = fit(label, columns);
    const toggleGap = columns >= width(toggle) + 3 ? ' · ' : '';
    return { ...feedFooter(`forum · ${job.status} · ${job.postCount} posts${following ? ' · following' : ''}`, 'subtle',
      Math.max(0, columns - width(toggle) - width(toggleGap)), following, newLines), toggle, toggleGap };
  }
  const { word } = jobState(job);
  const color = jobRowColor(job);
  const turns = 'turns' in job ? (job as CodexLiveSession).turns : [job];
  const uses = turns.reduce((sum, turn) => sum + (turn.toolUses ?? toolUseCount(turn.events)), 0);
  const ids = new Set(turns.map(turn => turn.id));
  const tokens = new Map(Object.entries(state.usageByJob ?? {}).filter(([id, entry]) => entry.sessionId === job.id || ids.has(id))
    .map(([id, entry]) => [id, entry.usage.totalTokens]));
  for (const turn of turns) if (!tokens.has(turn.id) && turn.usage) tokens.set(turn.id, turn.usage.totalTokens);
  const total = [...tokens.values()].reduce((sum, n) => sum + n, 0);
  const known = tokens.size > 0;
  const statusWord = job.unresolved ? 'unknown' : job.active && (job.question || job.status === 'waiting') || job.status === 'needs_input'
    ? 'needs answer' : ['cancelled', 'interrupted', 'stopped'].includes(job.status) ? 'stopped' : job.status === 'completed' ? 'done' : job.status === 'blocked' ? 'blocked' : word.toLowerCase();
  const status = `${statusWord}${job.detailsUnavailable ? ' · stale' : ''}`;
  const detail = ` · ${uses} tool${uses === 1 ? '' : 's'} · ${elapsed(job, state.nowMs)}`;
  return feedFooter(status + detail, color, columns, following, newLines, known ? `${compactNumber(total)} tokens` : '', status.length);
}

function feedFooter(status: string, color: ThemeKey, columns: number, following: boolean, newLines: number, tokens = '', wordLength = status.length):
  { left: string; leftSpans: Span[]; right: string; jump: string; color: ThemeKey; gap: string; toggle?: string; toggleGap?: string } {
  const jump = following ? '' : fit(`↓ ${newLines} new`, Math.max(0, columns - 3));
  const right = following ? fit(tokens, Math.max(0, columns - 1)) : jump;
  const rightWidth = width(right) + (!following ? 3 : 0);
  const left = fit(status, Math.max(0, columns - rightWidth - (rightWidth && columns > rightWidth ? 1 : 0)));
  const leftSpans: Span[] = [{ text: left.slice(0, wordLength), color }, { text: left.slice(wordLength), color: 'subtle' }];
  return { left, leftSpans, right: following ? right : '', jump, color, gap: ' '.repeat(Math.max(0, columns - width(left) - rightWidth)) };
}

export function emptyLines(columns: number): FeedLines {
  const lines: FeedLines = [20, 18, 16, 14].map((length, i) => ({ key: `empty-score-${i}`,
    spans: [{ text: fit(' '.repeat(8 + i * 2) + '━'.repeat(length), columns), color: i < 3 ? 'inactive' : 'subtle' }] }));
  lines.push({ key: 'empty-gap', spans: [] });
  for (const [key, text, color] of [
    ['empty-message', 'No workers yet. They enter here when Claude starts one.', 'text'],
    ['empty-commands', '/fugato:pair <task>  ·  /fugato:roundtable <task>', 'subtle'],
  ] as const) messageLines(text, Math.max(0, columns - 4)).forEach((spans, i) => lines.push({ key: i ? `${key}-${i}` : key,
    spans: [{ text: fit('    ', columns) }, ...spans.map(span => ({ ...span, color }))] }));
  return clipLines(lines, columns);
}
export function sessionFooter(state: CodexLiveState, columns: number) {
  const models = new Map<string, number>();
  for (const entry of Object.values(state.usageByJob ?? {})) models.set(entry.model, (models.get(entry.model) ?? 0) + entry.usage.totalTokens);
  const ranked = [...models].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const total = ranked.reduce((sum, [, n]) => sum + n, 0);
  const right = `${compactNumber(total)} tokens${ranked.slice(0, 2).map(([model, n]) => ` · ${shortModel(model)} ${compactNumber(n)}`).join('')}${ranked.length > 2 ? ` · +${ranked.length - 2}` : ''}`;
  return feedFooter('this session', 'subtle', columns, true, 0, right);
}

type TableEntry = CodexLiveJob | ForumRoom;
const entryName = (entry: TableEntry) => 'roomId' in entry ? 'Roundtable' : entry.agentName || taskText(entry.label);
const roomTimes = (room: ForumRoom): number[] => room.timeline ?? (room.posts ?? []).map(post =>
  (post.kind === 'decision' && post.author.kind === 'chair' ? -1 : 1) * Date.parse(post.at));
export function timelineAxis(entries: readonly TableEntry[], now: number) {
  const starts = entries.flatMap(entry => 'roomId' in entry ? roomTimes(entry).map(Math.abs)
    : [Date.parse(entry.startedAt)]).filter(Number.isFinite);
  return { start: starts.length ? Math.min(now, ...starts) : now, end: now };
}
export function timelineSpans(entry: TableEntry, axis: { start: number; end: number }): Span[] {
  const cell = (time: number) => Math.max(0, Math.min(13, Math.floor((time - axis.start) / Math.max(1, axis.end - axis.start) * 13)));
  if ('roomId' in entry) {
    const cells: Span[] = Array.from({ length: 14 }, () => ({ text: ' ' }));
    for (const time of roomTimes(entry)) {
      if (!Number.isFinite(time)) continue;
      const index = cell(Math.abs(time));
      if (time < 0) cells[index] = { text: '•', color: 'claude' };
      else if (cells[index]!.text !== '•') cells[index] = { text: '·', color: 'subtle' };
    }
    return compact(cells);
  }
  const start = Date.parse(entry.startedAt);
  if (!Number.isFinite(start)) return [{ text: ' '.repeat(14) }];
  const first = cell(start);
  const ended = jobLifecycle(entry).finished ? Date.parse(entry.completedAt) : axis.end;
  const last = Math.max(first, cell(Number.isFinite(ended) ? ended : axis.end));
  return compact(Array.from({ length: 14 }, (_, i) => ({ text: i < first ? ' ' : i <= last ? '━' : '╌',
    color: i <= last ? jobRowColor(entry) : 'inactive' })));
}
export function listTitle(state: CodexLiveState, columns: number): Span[] {
  const workers = visibleSessions(state).length, rooms = visibleForums(state).length;
  return alignSpans([{ text: 'Fugato', bold: true }, { text: `${workers ? ` · ${workers} worker${workers === 1 ? '' : 's'}` : ''}${rooms ? ` · ${rooms} roundtable${rooms === 1 ? '' : 's'}` : ''}`, color: 'subtle' }],
    columns >= 64 ? [{ text: 'start ─── now', color: 'inactive' }] : [], columns);
}
export function tableRow(entry: TableEntry, selected: boolean, columns: number, state: CodexLiveState, entries: readonly TableEntry[]): Span[] {
  const room = 'roomId' in entry ? entry : undefined;
  const worker = room ? undefined : entry as CodexLiveJob;
  const color = room ? room.status === 'closed' ? 'inactive' : 'suggestion' : jobRowColor(worker!);
  const bullet = room ? room.status === 'closed' ? '◇' : '◆' : staleJob(worker!) ? '⚠' : worker!.status === 'blocked' ? '✗'
    : worker!.status === 'needs_input' ? '?' : worker!.status === 'unknown' ? '!' : glyph(worker!);
  const labelWidth = Math.min(12, Math.max(1, ...entries.map(item => width(entryName(item)))));
  const isNew = room ? room.status !== 'closed' && room.postCount > (room.viewedPosts ?? 0) : state.newSessionIds?.includes(worker!.id);
  const meta = room ? `${room.postCount} posts` : elapsed(worker!, state.nowMs);
  const metaWidth = Math.max(...entries.map(item => width('roomId' in item ? `${item.postCount} posts` : elapsed(item, state.nowMs))), width(meta));
  const right: Span[] = [
    ...(columns >= 64 ? [...timelineSpans(entry, timelineAxis(entries, state.nowMs)), { text: '  ' }] : []),
    { text: ' '.repeat(Math.max(0, metaWidth - width(meta))) + meta, color: isNew && !selected ? 'suggestion' : 'subtle' },
  ];
  const detail = room ? `${room.status === 'open' ? '' : `${room.status} · `}${room.goal.split('\n')[0] ?? ''}` : worker!.question && jobLifecycle(worker!).active
    ? `asks: ${questionExcerpt(worker!.question.text)}` : `${workerRole(worker!)} · ${[shortModel(worker!.model), worker!.effort].filter(Boolean).join(' ')}`;
  const prefix: Span[] = [{ text: selected ? '❯' : ' ', color: 'suggestion' }, { text: `${bullet} `, color },
    { text: fit(entryName(entry), labelWidth) + ' '.repeat(labelWidth + 2 - width(fit(entryName(entry), labelWidth))), bold: true }];
  if (columns >= 48) prefix.push({ text: detail, color: worker?.question && jobLifecycle(worker).active ? 'warning' : 'subtle' });
  return alignSpans(prefix, right, columns, 2);
}
export function forumRow(room: ForumRoom, selected: boolean, columns: number) {
  return spanText(tableRow(room, selected, columns, { jobs: [], selectedId: selected ? `forum:${room.roomId}` : null,
    forumRooms: [room], nowMs: Date.now() }, [room]));
}

function forumFeedLines(room: ForumRoom, now: number, columns: number, view?: CodexLiveFeedView): FeedLines {
  const lines: FeedLines = [];
  const sources: Record<string, string> = {};
  const notice = (key: string, text: string) => {
    sources[key] = text;
    lines.push(...wrap(text, columns, 2).map((text, i) => ({ key: `${key}-${i}`, source: key,
      start: 0, end: text.length, spans: [{ text, color: 'subtle' as const }] })));
  };
  if (room.warning) lines.push({ key: 'forum-warning', spans: [{ text: fit(room.warning, columns), color: 'warning' }] });
  else {
    if (room.malformed) notice('forum-malformed', `${room.malformed} malformed forum lines skipped.`);
    if (room.omitted) notice('forum-omitted', `${room.omitted} earlier posts omitted · fugato forum read ${room.roomId}`);
    if (!room.posts?.length) notice('forum-empty', 'No forum posts yet.');
    let previous: { seq: number; nest: number } | undefined;
    for (const post of room.posts ?? []) {
      const nest = post.replyTo === previous?.seq ? Math.min(4, previous.nest + 2) : 0;
      previous = { seq: post.seq, nest };
      const key = `post:${post.seq}`;
      const color: ThemeKey = post.kind === 'decision' ? 'claude' : post.kind === 'candidate' ? 'success'
        : ['question', 'request'].includes(post.kind) ? 'warning' : post.kind === 'finding' ? 'text' : 'subtle';
      const seconds = Math.max(0, Math.floor((now - Date.parse(post.at)) / 1000));
      const time = seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m`
        : seconds < 86400 ? `${Math.floor(seconds / 3600)}h` : `${Math.floor(seconds / 86400)}d`;
      const meta: Span[] = [{ text: ' '.repeat(nest) + String(post.seq).padStart(3) + ' ', color: 'subtle' },
        { text: post.kind.padEnd(10) + ' ', color }, { text: post.author.name, bold: true },
        ...(post.mentions.length ? [{ text: ` → ${post.mentions.join(' ')}`, color: post.mentions.includes('chair') ? 'warning' as const : 'subtle' as const }] : []),
        ...(post.replyTo === null ? [] : [{ text: ` ↳ ${post.replyTo}`, color: 'subtle' as const }]),
        ...(post.initial && post.author.kind === 'member' ? [{ text: '  first record', color: 'inactive' as const }] : [])];
      sources[`${key}-meta`] = spanText(meta);
      lines.push({ key: `${key}-meta`, source: `${key}-meta`, start: 0, end: sources[`${key}-meta`]!.length, togglePostId: key,
        spans: alignSpans(meta, [{ text: time, color: 'subtle' }], columns) });
      const indent = ' '.repeat(Math.min(15 + nest, Math.max(0, columns - 1)));
      const bodyColumns = Math.max(0, columns - width(indent));
      const expanded = view?.expandedPromptIds?.includes(key);
      const title = post.title || cleanBody(post.body).replace(/\t/g, '    ').split('\n')[0] || '';
      sources[`${key}-title`] = title;
      lines.push({ key: `${key}-title`, source: `${key}-title`, start: 0, end: title.length, togglePostId: key,
        spans: alignSpans([{ text: indent }, { text: title, bold: !!post.title, color: 'text' }],
          [{ text: expanded ? '▾' : '▸', color: 'suggestion' }], columns) });
      const body = promptLayout(post.body, bodyColumns);
      sources[`${key}-body`] = body.text;
      if (expanded) body.rows.forEach((row, i) => lines.push({ key: `${key}-body-${i}`,
        source: `${key}-body`, start: row.start, end: row.end, spans: [{ text: indent }, ...row.spans.map(span => ({ ...span, color: 'text' as const }))] }));
      if (post.refs.length) {
        const text = `refs  ${post.refs.join(', ')}`;
        sources[`${key}-refs`] = text;
        if (expanded) lines.push({ key: `${key}-refs`, source: `${key}-refs`, start: 0, end: text.length,
          spans: [{ text: fit(indent + text, columns), color: 'subtle' }] });
      }
      sources[`${key}-gap`] = '';
      if (expanded) lines.push({ key: `${key}-gap`, source: `${key}-gap`, start: 0, end: 0, spans: [] });
    }
  }
  lines.sources = sources;
  return clipLines(lines, columns);
}
