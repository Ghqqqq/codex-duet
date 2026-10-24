import type { ThemeKey } from 'claude-code';
import type { CodexLiveEvent, CodexLiveFeedView, CodexLiveJob, CodexLiveSession, CodexLiveState } from '../types';
import { attention, attentionOrder, clean, cleanBody, detailedTurns, elapsed, jobLifecycle, questionExcerpt, sessionForId, taskText, turnKey, unwrapCommand, visibleSessions } from './model';

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
  if (active && (job.question || status === 'waiting')) return { word: 'Waiting for Claude', color: 'warning' };
  switch (status) {
    case 'unresolved': return { word: 'Unresolved', color: 'warning' };
    case 'queued': return { word: 'Queued', color: 'inactive' };
    case 'running': return { word: 'Running', color: 'claude' };
    case 'completed': return { word: 'Done', color: 'success' };
    case 'failed': return { word: 'Failed', color: 'error' };
    case 'needs_input': return { word: 'Needs input', color: 'warning' };
    case 'blocked': return { word: 'Blocked', color: 'error' };
    case 'cancelled':
    case 'stopped':
    case 'interrupted': return { word: 'Stopped', color: 'inactive' };
    default: return { word: 'Unknown', color: 'subtle' };
  }
}

export function jobRowColor(job: CodexLiveJob): ThemeKey {
  return attention(job) === 'blocked' ? 'error' : jobState(job).color;
}

export function jobRow(job: CodexLiveJob | CodexLiveSession, selected: boolean, columns: number, now: number, isNew = false) {
  const selector = fit(`${selected ? '❯' : ' '} `, columns);
  const { word } = jobState(job);
  const { active } = jobLifecycle(job);
  const glyph = attention(job) === 'blocked' ? '!' : ({ Running: '⏺', Queued: '…', 'Needs input': '?', 'Waiting for Claude': '?', Done: '✓', Failed: '✗',
    Blocked: '✗', Stopped: '■', Unresolved: '!' } as Record<string, string>)[word] ?? '·';
  const bullet = fit(`${glyph} `, Math.max(0, columns - width(selector)));
  const available = Math.max(0, columns - width(selector + bullet));
  const marker = isNew && !selected && available >= 7 ? ' • new' : '';
  const contentColumns = available - width(marker);
  const metaColumns = Math.max(0, contentColumns - Math.min(12, Math.ceil(contentColumns / 2)));
  const age = ` ${elapsed(job, now)}`;
  const count = 'turns' in job && job.turnCount > 1 ? ` ${job.turnCount} turns ·` : '';
  const quietMinutes = active ? Math.floor((now - Date.parse(job.lastActivityAt ?? '')) / 60_000) : 0;
  const quiet = quietMinutes >= 1 ? `${quietMinutes}m` : '';
  // Keep the quiet age after dropping its word, then sacrifice turn count.
  const choices = quiet ? [`${count}${age} · quiet ${quiet}`, `${count}${age} · ${quiet}`, `${age} · ${quiet}`, age]
    : [`${count}${age}`, age];
  const meta = fit(choices.find(text => width(text) <= metaColumns) ?? age, metaColumns);
  const labelColumns = contentColumns - width(meta);
  const label = fit(job.agentName || taskText(job.label), labelColumns);
  const description = active && job.question ? `asks: ${questionExcerpt(job.question.text) || '…'}`
    : active && job.currentOperation ? job.currentOperation : taskText(job.label);
  const summary = (job.agentName || description !== taskText(job.label)) && labelColumns > width(label) + 2
    ? `  ${fit(description, labelColumns - width(label) - 2)}` : '';
  return { selector, bullet, label, summary, marker, gap: ' '.repeat(Math.max(0, labelColumns - width(label + summary))), meta };
}

export type ResultLine = { text: string; color: ThemeKey; bold?: boolean; boldPrefix?: string; strikethrough?: boolean };
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
};

function failed(event: CodexLiveEvent): boolean {
  return ['failed', 'error'].includes(event.status ?? '') ||
    event.type === 'commandExecution' && event.exitCode !== undefined && event.exitCode !== 0;
}

function inProgress(event: CodexLiveEvent): boolean {
  return event.lifecycle === 'started' || ['inProgress', 'running', 'queued'].includes(event.status ?? '');
}

function cancelled(event: CodexLiveEvent): boolean { return ['cancelled', 'declined'].includes(event.status ?? ''); }

export function toolResult(event: CodexLiveEvent, now: number, job?: CodexLiveJob): ResultLine {
  if (cancelled(event)) return { text: 'Cancelled', color: 'inactive' };
  if (inProgress(event) && job?.unresolved) return { text: 'Unresolved', color: 'warning' };
  if (inProgress(event) && job && !jobLifecycle(job).active) return { text: 'Interrupted', color: 'inactive' };
  const duration = event.durationMs === undefined ? '' : ` (${(Math.max(0, event.durationMs) / 1000).toFixed(1)}s)`;
  if (failed(event)) return { text: `${event.type === 'commandExecution' && event.exitCode !== undefined && event.exitCode !== 0
    ? `Error: exit ${event.exitCode}` : 'Error'}${duration}`, color: 'error' };
  if (inProgress(event)) {
    const start = Date.parse(event.at ?? '');
    const age = Number.isFinite(start) ? ` (${Math.max(0, Math.floor((now - start) / 1000))}s)` : '';
    return { text: `Running…${age}`, color: 'subtle' };
  }
  return { text: `Done${event.type === 'commandExecution' && event.exitCode === undefined ? '' : duration}`, color: 'subtle' };
}

// Display-only path handling. No filesystem reads or resolution are needed.
export function relativePath(path: string, workspaceRoot?: string): string {
  if (!workspaceRoot?.startsWith('/') || !path.startsWith('/')) return path;
  const normalize = (value: string) => {
    const parts: string[] = [];
    for (const part of value.split('/')) {
      if (part === '..') parts.pop();
      else if (part && part !== '.') parts.push(part);
    }
    return `/${parts.join('/')}`;
  };
  const root = normalize(workspaceRoot);
  const normalized = normalize(path);
  const prefix = root === '/' ? '/' : `${root}/`;
  return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : path;
}

export function fileResult(event: CodexLiveEvent): string {
  const basename = event.path?.split('/').filter(Boolean).pop() || 'file';
  if (event.kind === 'delete') return event.added !== undefined || event.removed !== undefined ? `Deleted ${basename}` : 'Deleted';
  if (event.kind === 'add') return event.added === undefined ? 'Wrote'
    : `Wrote ${event.added} ${event.added === 1 ? 'line' : 'lines'} to ${basename}`;
  const changes = [event.added ? `${event.added} addition${event.added === 1 ? '' : 's'}` : '',
    event.removed ? `${event.removed} removal${event.removed === 1 ? '' : 's'}` : ''].filter(Boolean);
  if (event.added === undefined && event.removed === undefined) return 'Updated';
  return `Updated ${basename}${changes.length ? ` with ${changes.join(' and ')}` : ''}`;
}

export function eventItem(event: CodexLiveEvent, job: CodexLiveJob, now: number): FeedItem {
  const color = cancelled(event) || inProgress(event) && !jobLifecycle(job).active ? 'inactive' : failed(event) ? 'error' : inProgress(event) ? 'inactive' : 'success';
  const base: FeedItem = { key: `event-${event.seq}`, title: '', color, results: [] };
  switch (event.type) {
    case 'agentMessage': return { ...base, color: 'text', markdown: event.body ?? event.text ?? '' };
    case 'commandExecution': return { ...base, title: `Bash(${unwrapCommand(event.command ?? '')})`, bold: 'Bash', maxRows: 2,
      results: [toolResult(event, now, job)] };
    case 'fileChange': {
      const name = ({ add: 'Write', update: 'Update', delete: 'Delete' } as Record<string, string>)[event.kind ?? ''] ?? 'Edit';
      return { ...base, title: `${name}(${relativePath(event.path ?? '', job.workspaceRoot)})`, bold: name,
        results: [cancelled(event) || failed(event) || inProgress(event) ? toolResult(event, now, job) : { text: fileResult(event), color: 'subtle' }] };
    }
    case 'mcpToolCall':
    case 'dynamicToolCall': {
      const name = event.type === 'mcpToolCall' ? `${event.server || 'unknown'} - ${event.tool || 'unknown'}` : event.tool || 'unknown';
      return { ...base, title: `${name}${event.type === 'mcpToolCall' ? ' (MCP)' : ''}`, bold: name,
        results: [toolResult(event, now, job),
          ...(event.tool === 'ask_parent' && event.questionText !== undefined
            ? [{ text: event.questionText, color: 'subtle' as const },
              ...(event.answer === undefined ? [] : [{ text: `Answer: ${event.answer}`, color: 'text' as const, boldPrefix: 'Answer:' }])] : [])] };
    }
    case 'plan': return { ...base, title: 'Update Todos', bold: 'Update Todos',
      color: failed(event) ? 'error' : event.steps?.length && event.steps.every((_, i) => event.statuses?.[i] === 'completed') ? 'success' : 'inactive',
      results: [...(failed(event) ? [toolResult(event, now, job)] : []), ...(event.steps ?? []).map((step, i): ResultLine => {
        const status = event.statuses?.[i];
        return { text: `${status === 'completed' ? '☒' : '☐'} ${step}`,
          color: status === 'completed' ? 'subtle' : 'text', bold: status === 'inProgress', strikethrough: status === 'completed' };
      })] };
    default: return { ...base, title: clean(`${event.type} ${event.status ?? ''}`),
      results: failed(event) ? [toolResult(event, now, job)] : [] };
  }
}

// jobView has already collapsed lifecycles. Collapsing again can incorrectly
// pair an older overlapping start with a completion already matched once.
export function toolUseCount(events: readonly CodexLiveEvent[]): number {
  return events.filter(event =>
    ['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall'].includes(event.type)).length;
}

export function headerItem(job: CodexLiveJob, now: number): FeedItem {
  const { word, color } = jobState(job);
  const model = [job.model, job.effort, job.fast ? 'fast' : '', job.sandbox].filter(Boolean).join(' · ');
  return { key: 'job-header', title: job.agentName ? `${job.agentName}(${taskText(job.label)})` : taskText(job.label), bold: job.agentName, maxRows: 2, color,
    results: [{ text: `${word} · ${job.toolUses ?? toolUseCount(job.events)} tool uses · ${elapsed(job, now)}`, color },
      ...(model ? [{ text: model, color: 'subtle' as const }] : []),
      ...(job.detailsUnavailable ? [{ text: 'Details unavailable · showing the last good view', color: 'subtle' as const }] : [])] };
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
    const prompt: FeedItem[] = detailed && turn.prompt !== undefined ? [{ key: 'prompt', title: 'Prompt', bold: 'Prompt', maxRows: 1,
      color: 'suggestion', results: [], prompt: { turnId: turn.id, text: turn.prompt, report: turn.promptReport === true } }] : [];
    const items = [headerItem(turn, now), ...prompt, ...(detailed ? activityItems(turn).map(event => eventItem(event, turn, now)) : [])];
    if (turn.id === ownerId && jobLifecycle(turn).active && turn.question) items.push({ key: 'pending-question', title: 'Waiting for Claude', color: 'warning',
      results: [{ text: turn.question.text, color: 'subtle' },
        ...turn.question.options.map((option, i): ResultLine => ({ text: `${i + 1}. ${option}`, color: 'subtle' }))] });
    if (detailed && turn.detailsLoaded === false && !turn.detailsUnavailable) items.push({ key: 'loading', title: 'Loading transcript…', color: 'subtle', results: [] });
    return turn.threadId?.trim() ? items.map(item => ({ ...item, key: turnKey(item.key, turn.id) })) : items;
  })];
}

export type Span = { text: string; color?: ThemeKey; bold?: boolean; strikethrough?: boolean; start?: number; end?: number };
export type FeedLine = { key: string; spans: Span[]; source?: string; start?: number; end?: number; togglePromptId?: string };
export type FeedLines = FeedLine[] & { sources?: Record<string, string> };

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
    if (last && last.color === span.color && last.bold === span.bold && last.strikethrough === span.strikethrough) {
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
  for (const line of cleanBody(body).replace(/\t/g, '    ').split('\n')) {
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

export function feedLines(job: CodexLiveJob, now: number, columns: number, view?: CodexLiveFeedView): FeedLines {
  const lines: FeedLines = [];
  const sources: Record<string, string> = {};
  for (const item of feedItems(job, now)) {
    if (item.notice) {
      lines.push({ key: item.key, source: 'job-header-omitted', start: 0, end: item.title.length,
        spans: [{ text: fit(item.title, columns), color: 'subtle' }] });
      continue;
    }
    const source = `${item.key}-body`;
    const titleSpans: Span[] = item.bold
      ? [{ text: item.title.slice(0, item.bold.length), bold: true }, { text: item.title.slice(item.bold.length), color: item.key.startsWith('job-header') ? 'subtle' : undefined }]
      : [{ text: item.title, color: item.key.endsWith('pending-question') ? 'warning' : 'text' }];
    const message = item.markdown !== undefined ? messageLayout(item.markdown, Math.max(0, columns - 2)) : undefined;
    const body = message?.rows ?? laid(wrapSpans(titleSpans, Math.max(0, columns - 2), '', '', item.maxRows));
    sources[source] = message?.text ?? item.title;
    if (lines.length) lines.push({ key: `${item.key}-gap`, spans: [], source, start: 0, end: 0 });
    body.forEach((row, i) => lines.push({ key: `${item.key}-body-${i}`, source, start: row.start, end: row.end, spans: [
      { text: fit(i ? '  ' : '⏺ ', columns), color: item.color }, ...row.spans,
    ] }));
    let resultRow = 0;
    const resultSource = `${item.key}-results`;
    let resultText = '';
    if (item.prompt) {
      const prompt = promptLayout(item.prompt.text, Math.max(0, columns - 5));
      const expanded = view?.expandedPromptIds?.includes(item.prompt.turnId);
      const shown = expanded ? prompt.rows : prompt.rows.slice(0, 3);
      for (const row of shown) lines.push({ key: `${item.key}-result-${resultRow}`, source: resultSource,
        start: row.start, end: row.end, spans: [
          { text: fit(resultRow++ ? '     ' : '  ⎿  ', columns), color: 'subtle' }, ...row.spans,
        ] });
      // Snapshot all prompt text even while collapsed: toggles are not new work.
      sources[resultSource] = prompt.text;
      if (expanded && item.prompt.report) lines.push({ key: `${item.key}-report`, source: `${item.key}-report`, start: 0, end: 0,
        spans: [{ text: fit('     + standard report instructions', columns), color: 'subtle' }] });
      if (item.prompt.report) sources[`${item.key}-report`] = '+ standard report instructions';
      if (expanded || prompt.rows.length > 3) {
        const toggleSource = `${item.key}-toggle`;
        sources[toggleSource] = 'Prompt';
        lines.push({ key: toggleSource, source: toggleSource, start: 0, end: 0, togglePromptId: item.prompt.turnId,
          spans: [{ text: fit(`     ${expanded ? 'click to collapse' : `… +${prompt.rows.length - 3} lines · click to expand`}`, columns), color: 'subtle' }] });
      }
      continue;
    }
    for (const result of item.results) {
      // Clock text is display-only and cannot create unseen content identities.
      const stable = result.text.replace(/Running… \(\d+s\)/g, 'Running…');
      const spans: Span[] = result.boldPrefix ? [{ text: result.boldPrefix, bold: true, color: result.color },
        { text: result.text.slice(result.boldPrefix.length), color: result.color }] : [result];
      for (const row of laid(wrapSpans(spans, Math.max(0, columns - 5)), resultText.length)) {
        lines.push({ key: `${item.key}-result-${resultRow}`, source: resultSource, start: row.start, end: Math.min(row.end, resultText.length + stable.length), spans: [
          { text: fit(resultRow++ ? '     ' : '  ⎿  ', columns), color: 'subtle' }, ...row.spans,
        ] });
      }
      resultText += `${stable}\n`;
    }
    if (resultText) sources[resultSource] = resultText;
  }
  lines.sources = sources;
  return lines;
}

export function selectedJob(state: CodexLiveState): CodexLiveSession | undefined {
  const jobs = visibleSessions(state).sort(newestJob);
  return sessionForId(jobs, state.selectedId) ?? jobs.find(job => jobLifecycle(job).active) ?? jobs[0];
}

const newestJob = (a: CodexLiveJob, b: CodexLiveJob) =>
  b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);

export function recentEndedJobIds(jobs: readonly CodexLiveJob[], now: number,
  endTime = (job: CodexLiveJob): number => Date.parse(job.completedAt)): string[] {
  return jobs.filter(job => jobLifecycle(job).finished && now >= endTime(job) && now - endTime(job) < 120_000)
    .sort((a, b) => endTime(b) - endTime(a) || newestJob(a, b)).map(job => job.id);
}

export function headerLayout(state: CodexLiveState, selected: CodexLiveJob, bodyRows: number) {
  // In tiny windows reserve the footer and one feed row before the list.
  const sessions = visibleSessions(state);
  selected = sessionForId(sessions, selected.id) ?? selected;
  const clear = sessions.some(job => jobLifecycle(job).finished);
  const room = Math.max(0, bodyRows - 2);
  if ((sessions.length < 2 && !clear && (sessions[0]?.turnCount ?? 0) < 2) || room < 2) return { jobs: [], toggle: false, more: 0, rows: 0 };
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
export function paneLayout(state: CodexLiveState, selected: CodexLiveJob | undefined,
  availableRows: number, failure = false) {
  const bodyRows = Math.max(0, Math.floor(availableRows));
  const footerRows = bodyRows > 0 && (selected || failure) ? 1 : 0;
  const header = selected ? headerLayout(state, selected, bodyRows)
    : { jobs: [], toggle: false, clear: false, more: 0, rows: 0 };
  const pinnedRows = header.rows;
  return { bodyRows, header, pinnedRows, rows: Math.max(0, bodyRows - pinnedRows - footerRows) };
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
    const matches = lines.map((line, i) => ({ line, i })).filter(({ line }) => line.source === view.anchor!.source && line.spans.length);
    if (matches.length) feedOffset = matches.filter(({ line }) => (line.start ?? 0) <= view.anchor!.offset).at(-1)?.i ?? matches[0]!.i;
  }
  const following = view?.following !== false || feedOffset >= bottom;
  feedOffset = following ? bottom : Math.max(0, Math.min(bottom, feedOffset));
  const line = lines[feedOffset];
  return { ...view, feedOffset, following, rows, seenLines: following ? lines.length : view?.seenLines ?? lines.length,
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
  return normalizeFeed(lines, rows, { ...current, anchor: undefined, feedOffset, following: feedOffset === bottom,
    seenItems: current.following ? snapshot(lines) : current.seenItems, seenLines: current.following ? lines.length : current.seenLines });
}
export function reconcileFeed(previous: CodexLiveJob, job: CodexLiveJob, view: CodexLiveFeedView, now: number): CodexLiveFeedView {
  const columns = view.columns ?? 60;
  const rows = view.rows ?? 8;
  const before = view.anchor && view.seenItems ? view : normalizeFeed(feedLines(previous, now, columns, view), rows, view);
  return normalizeFeed(feedLines(job, now, columns, view), rows, before);
}

export function togglePrompt(job: CodexLiveJob, now: number, columns: number, rows: number,
  view: CodexLiveFeedView | undefined, turnId: string): CodexLiveFeedView {
  const lines = feedLines(job, now, columns, view);
  const before = normalizeFeed(lines, rows, view);
  const expanded = new Set(before.expandedPromptIds);
  if (expanded.has(turnId)) expanded.delete(turnId);
  else expanded.add(turnId);
  // Freeze the current top source/character offset even when following the end.
  // normalizeFeed resolves that same anchor after reflow, like scrolling/polls.
  const next = { ...before, expandedPromptIds: [...expanded], following: false,
    seenItems: before.seenItems ?? snapshot(lines), columns };
  return normalizeFeed(feedLines(job, now, columns, next), rows, next);
}

export function footerLayout(job: CodexLiveJob, state: CodexLiveState, columns: number, following: boolean, newLines: number) {
  const { word, color: stateColor } = jobState(job);
  const age = elapsed(job, state.nowMs);
  const uses = `${job.toolUses ?? toolUseCount(job.events)} tool uses`;
  const spinner = ['·', '✢', '✳', '✶', '✻', '✽'][(state.spinnerTick ?? 0) % 6];
  let status = word === 'Running' ? `${spinner} Running… ${age} · ${uses}`
    : word === 'Waiting for Claude' ? `? Waiting for Claude · ${age}` : `${word === 'Queued' ? '…' : word === 'Needs input' ? '?' : '⏺'} ${word} · ${uses} · ${age}`;
  if (visibleSessions(state).length === 1) status += ` · ${job.agentName || taskText(job.label)}`;
  const stale = job.detailsUnavailable ? `⚠ stale · last update ${job.lastUpdateMs === undefined ? 'unknown' : `${Math.max(0, Math.floor((state.nowMs - job.lastUpdateMs) / 1000))}s`} ago` : '';
  if (stale) status = `${stale} · ${status}`;
  const color = stale ? 'warning' : stateColor;
  let jump = '';
  if (!following) {
    // A plain hotkey Button reserves three cells for the engine's "b: ".
    const room = Math.max(0, columns - 3);
    const choices = [newLines ? `↓ ${newLines} new · Jump to bottom` : '↓ Jump to bottom',
      newLines ? `↓ ${newLines} new · Jump` : '↓ Jump', '↓ Jump'];
    jump = choices.find(text => width(text) <= room) ?? fit('↓ Jump', room);
  }
  const right = following ? 0 : width(jump) + 3;
  const left = fit(status, Math.max(0, columns - right - (right && columns > right ? 1 : 0)));
  return { left, jump, color, gap: ' '.repeat(Math.max(0, columns - width(left) - right)) };
}
