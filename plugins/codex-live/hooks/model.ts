import { limitChars } from './text';
import type { CodexLiveEvent, CodexLiveJob, CodexLiveMarker, CodexLiveSession, CodexLiveState } from '../types';

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
const string = (value: unknown): string => typeof value === 'string' ? value : '';
const number = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

// Display text only: discard terminal escapes, control codes and bidi controls.
export function cleanBody(value: unknown): string {
  return string(value).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ' ');
}

export function clean(value: unknown): string {
  return cleanBody(value).replace(/\s+/g, ' ').trim();
}

// Keep the row's "asks: " prefix plus excerpt within 60 characters.
export function questionExcerpt(value: unknown): string {
  const text = clean(value);
  return text.length <= 54 ? text : `${limitChars(text, 53)}…`;
}

export function taskText(value: unknown): string {
  let text = clean(value);
  const prefix = /^(?:OBJECTIVE\s*:|FOLLOW[- ]UP(?:\s+on\b[^:]*)?\s*:|REWORK\b[^:]*:)\s*/i;
  while (prefix.test(text)) text = text.replace(prefix, '');
  return text.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? text;
}

export function markerView(value: unknown): CodexLiveMarker {
  const m = object(value);
  if (m.v !== 1 || !string(m.jobId) || !string(m.jobFile).startsWith('/')) {
    throw new Error('Invalid session marker');
  }
  return {
    jobId: string(m.jobId), jobFile: string(m.jobFile),
    summary: limitChars(clean(m.summary), 1000), title: limitChars(clean(m.title), 200),
    name: limitChars(clean(m.name), 100) || undefined,
    createdAt: string(m.createdAt),
    workspaceRoot: string(m.workspaceRoot).startsWith('/') ? clean(m.workspaceRoot) : undefined,
  };
}

// Keep the completion at its own sequence number. Interleaved unrelated events
// stay in order; repeated invocations of an identical command stay separate.
export function collapseActivity<T extends CodexLiveEvent>(events: readonly T[], limit = 200): T[] {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const outstanding = new Map<string, number[]>();
  const removed = new Set<number>();
  sorted.forEach((event, index) => {
    const key = event.type === 'commandExecution' && event.command !== undefined
      ? JSON.stringify([event.type, event.command])
      : ['mcpToolCall', 'dynamicToolCall'].includes(event.type)
        ? JSON.stringify([event.type, event.server, event.tool]) : undefined;
    if (key === undefined) return;
    const queue = outstanding.get(key) ?? [];
    if (event.lifecycle === 'started') queue.push(index);
    else if (event.lifecycle === 'completed' || ['completed', 'failed', 'cancelled', 'declined'].includes(event.status ?? '')) {
      const prior = queue.shift();
      if (prior !== undefined) removed.add(prior);
    }
    outstanding.set(key, queue);
  });
  return sorted.filter((_, index) => !removed.has(index)).slice(-limit);
}

function eventView(value: unknown, index: number): CodexLiveEvent {
  const e = object(value);
  return {
    seq: number(e.seq) ?? index, at: string(e.at), type: string(e.type),
    status: clean(e.status), lifecycle: string(e.lifecycle),
    text: limitChars(e.type === 'agentMessage' ? cleanBody(e.text) : clean(e.text), 300), command: string(e.command),
    body: typeof e.body === 'string' ? limitChars(cleanBody(e.body), 4000) : undefined,
    exitCode: number(e.exitCode), durationMs: number(e.durationMs),
    path: limitChars(clean(e.path), 1000), kind: clean(e.kind),
    added: count(e.added), removed: count(e.removed),
    server: limitChars(clean(e.server), 100), tool: limitChars(clean(e.tool), 100),
    steps: Array.isArray(e.steps) ? e.steps.map(step =>
      limitChars(clean(typeof step === 'string' ? step : object(step).step), 200)).slice(0, 50) : [],
    statuses: Array.isArray(e.statuses) ? e.statuses.slice(0, 50).map(status =>
      status === 'completed' || status === 'inProgress' ? status : 'pending') : undefined,
  };
}

function count(value: unknown): number | undefined {
  const n = number(value);
  return n !== undefined && n >= 0 ? Math.floor(n) : undefined;
}

// Derive lifecycle from authoritative fields, including persisted older views.
export function jobLifecycle(job: { status: string; completedAt: string; finalStatus?: string }) {
  const terminal = ['completed', 'failed', 'cancelled', 'interrupted', 'stopped', 'blocked', 'needs_input'];
  const ended = Number.isFinite(Date.parse(job.completedAt));
  const status = ended && !terminal.includes(job.status)
    ? terminal.includes(job.finalStatus ?? '') ? job.finalStatus! : 'completed' : job.status;
  const finished = terminal.includes(status);
  return { status, finished, active: !finished && ['running', 'queued', 'waiting'].includes(status) };
}

export function unwrapCommand(command: string): string {
  let result = clean(command);
  const wrapper = /^(?:\/bin\/)?(?:zsh|bash|sh)\s+-(?:lc|c)\s+/;
  if (!wrapper.test(result)) return result;
  result = result.replace(wrapper, '');
  const quote = result[0];
  if (quote === "'" || quote === '"') {
    result = result.slice(1);
    if (result.endsWith(quote)) result = result.slice(0, -1);
  }
  return result.replace(/'"'"'/g, "'");
}

function isoTime(value: unknown): string | undefined {
  const ms = typeof value === 'number' ? value : Date.parse(string(value));
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function summaryFields(job: Pick<CodexLiveJob, 'currentOperation' | 'lastActivityAt'>) {
  return { currentOperation: limitChars(clean(job.currentOperation), 60), lastActivityAt: isoTime(job.lastActivityAt) };
}

export function jobView(value: unknown, marker: CodexLiveMarker, details = true): CodexLiveJob {
  const job = object(value);
  if (job.id !== marker.jobId || !string(job.status)) throw new Error('Invalid job');
  const request = object(job.request);
  const report = object(job.report);
  const pending = object(job.pendingQuestion);
  const { status, finished, active } = jobLifecycle({ status: clean(job.status),
    completedAt: string(job.completedAt), finalStatus: clean(report.status) });
  // Companion questions carry expiry + timeout rather than a creation timestamp.
  const questionTime = isoTime(pending.createdAt) ?? (number(pending.expiresAt) === undefined ? undefined
    : isoTime(number(pending.expiresAt)! - (number(job.questionTimeoutSec) ?? 900) * 1000));
  const question = active && typeof pending.text === 'string' && pending.answer === undefined
    ? { ...(questionTime ? { createdAt: questionTime } : {}), text: limitChars(clean(pending.text), 2000), options: Array.isArray(pending.options)
      ? pending.options.map(option => limitChars(clean(typeof option === 'string' ? option :
        object(option).label ?? object(option).text), 300)).slice(0, 20) : [] } : null;
  const activity = Array.isArray(job.activity) ? job.activity : [];
  // Pair lifecycles on lightweight metadata before cleaning retained bodies.
  const allPaired = collapseActivity(activity.map((value, index) => {
    const e = object(value);
    return { seq: number(e.seq) ?? index, type: string(e.type), command: string(e.command),
      server: string(e.server), tool: string(e.tool), lifecycle: string(e.lifecycle), status: string(e.status), index };
  }), Infinity);
  const paired = allPaired.slice(-200);
  const latest = object(activity[allPaired.at(-1)?.index ?? -1]);
  const operation = [...allPaired].reverse().find(event =>
    ['commandExecution', 'mcpToolCall', 'dynamicToolCall'].includes(event.type) &&
    event.lifecycle !== 'completed' && !['completed', 'failed', 'error', 'cancelled', 'declined'].includes(event.status) &&
    (event.lifecycle === 'started' || ['inProgress', 'running', 'queued'].includes(event.status)));
  const currentOperation = operation?.type === 'commandExecution' ? unwrapCommand(operation.command)
    : operation ? [operation.server, operation.tool].filter(Boolean).join('.') : clean(latest.text);
  const events = details ? paired.map(event => {
    const projected = eventView(activity[event.index], event.seq);
    return { ...projected, command: limitChars(clean(projected.command), 2000) };
  }) : [];
  return {
    id: marker.jobId, label: taskText(marker.summary || job.summary || marker.title) || 'Codex Task', status,
    threadId: string(job.threadId).trim() || undefined,
    agentName: limitChars(clean(job.agentName), 100) || marker.name,
    active, finished,
    createdAt: marker.createdAt || string(job.createdAt),
    startedAt: string(job.startedAt) || marker.createdAt || string(job.createdAt),
    completedAt: string(job.completedAt), model: limitChars(clean(request.model), 100),
    effort: limitChars(clean(request.effort), 40), fast: request.serviceTier === 'priority',
    sandbox: limitChars(clean(job.sandbox), 100), workspaceRoot: marker.workspaceRoot,
    ...summaryFields({ currentOperation, lastActivityAt: string(latest.at) }),
    question, finalStatus: clean(report.status) || status,
    fileCount: Array.isArray(report.touchedFiles) ? report.touchedFiles.length : null,
    events: details ? events : [], detailsLoaded: details,
    toolUses: paired.filter(event => ['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall'].includes(event.type)).length,
    detailsUnavailable: false,
  };
}

export function unavailableJob(marker: CodexLiveMarker): CodexLiveJob {
  return { ...jobView({ id: marker.jobId, status: 'unknown' }, marker), detailsUnavailable: true };
}

export function elapsed(job: CodexLiveJob, now: number): string {
  const start = Date.parse(job.startedAt);
  const end = jobLifecycle(job).finished ? Date.parse(job.completedAt) : now;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '—';
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
}

export function glyph(job: CodexLiveJob): string {
  const { status, active } = jobLifecycle(job);
  if (attention(job) === 'blocked') return '!';
  if (active && (job.question || status === 'waiting')) return '?';
  return ({ running: '●', queued: '…', completed: '✓', failed: '✗', blocked: '!',
    cancelled: '■', interrupted: '■', stopped: '■' } as Record<string, string>)[status] ?? '·';
}

// Attention is independent of recency, and always belongs to the latest turn.
export function attention(job: CodexLiveJob): 'question' | 'blocked' | undefined {
  const { status, active } = jobLifecycle(job);
  if (active && job.question) return 'question';
  if (status === 'blocked' || status === 'needs_input') return 'blocked';
  return undefined;
}

export function attentionOrder(a: CodexLiveJob, b: CodexLiveJob): number {
  const kindA = attention(a), kindB = attention(b);
  if (kindA !== kindB) return kindA === 'question' ? -1 : 1;
  const time = (job: CodexLiveJob) => [job.question?.createdAt, job.completedAt, job.createdAt]
    .map(value => Date.parse(value ?? '')).find(Number.isFinite) ?? 0;
  return time(a) - time(b) || a.id.localeCompare(b.id);
}

export function statusLine(jobs: readonly CodexLiveJob[]): string | undefined {
  jobs = groupedSessions(jobs);
  const waiting = jobs.filter(job => attention(job));
  const running = jobs.filter(job => jobLifecycle(job).active && job.status === 'running' && !job.question).length;
  const queued = jobs.filter(job => jobLifecycle(job).active && job.status === 'queued' && !job.question).length;
  const otherWaiting = jobs.filter(job => jobLifecycle(job).active && job.status === 'waiting' && !job.question).length;
  const needsYou = waiting.length === 1 ? `${waiting[0]!.agentName || '1'} waiting for you`
    : waiting.length ? `${waiting.length} waiting for you` : '';
  const parts = [needsYou, running ? `${running} running` : '', queued ? `${queued} queued` : '',
    otherWaiting ? `${otherWaiting} waiting for answer` : ''].filter(Boolean);
  const active = jobs.filter(job => jobLifecycle(job).active);
  const name = !waiting.length && active.length === 1 ? active[0]?.agentName : undefined;
  return parts.length ? `${name || 'Codex'} · ${parts.join(' · ')}` : undefined;
}

export function sessionId(job: CodexLiveJob): string {
  const threadId = job.threadId?.trim();
  return threadId ? `thread:${threadId}` : job.id;
}

export const oldestJob = (a: CodexLiveJob, b: CodexLiveJob) =>
  a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

export function groupedSessions(jobs: readonly CodexLiveJob[], turnCounts: Readonly<Record<string, number>> = {}): CodexLiveSession[] {
  const groups: CodexLiveJob[][] = [];
  const threads = new Map<string, CodexLiveJob[]>();
  for (const job of jobs) {
    const id = sessionId(job);
    const existing = job.threadId?.trim() ? threads.get(id) : undefined;
    if (existing) existing.push(job);
    else {
      const turns = [job];
      groups.push(turns);
      if (job.threadId?.trim()) threads.set(id, turns);
    }
  }
  return groups.map(group => {
    const turns = group.sort(oldestJob);
    const latest = turns[turns.length - 1]!;
    const id = sessionId(latest);
    return { ...latest, ...jobLifecycle(latest), id, turns, turnCount: Math.max(turns.length, turnCounts[id] ?? 0) };
  });
}

export const TURN_LIMIT = 20;
export const DETAIL_TURN_LIMIT = 5;

export function retainedTurns(session: CodexLiveSession): CodexLiveJob[] {
  const latest = session.turns.at(-1)!;
  const protectedIds = new Set(session.turns.filter(job => job.id === latest.id || jobLifecycle(job).active).map(job => job.id));
  // Protecting active turns and the latest turn takes precedence over the cap.
  const slots = TURN_LIMIT - protectedIds.size;
  if (slots > 0) for (const job of session.turns.filter(job => !protectedIds.has(job.id)).slice(-slots)) protectedIds.add(job.id);
  return session.turns.filter(job => protectedIds.has(job.id));
}

export function sessionForId(sessions: readonly CodexLiveSession[], id: string | null): CodexLiveSession | undefined {
  return sessions.find(session => session.id === id) ?? sessions.find(session => session.turns.some(job => job.id === id));
}

// Keep turn identities stable as follow-ups arrive (event sequence numbers restart).
export function turnKey(key: string, jobId: string): string {
  return key.startsWith('job-header') ? key.replace('job-header', `job-header:${encodeURIComponent(jobId)}`)
    : `job:${encodeURIComponent(jobId)}:${key}`;
}

// Old views used job IDs for selection/feeds and unqualified event anchors.
// Normalize at read as well as write time, so the first render needs no poll.
export function normalizeSessions(state: CodexLiveState): CodexLiveState {
  const sessions = groupedSessions(state.jobs);
  const selectedId = sessionForId(sessions, state.selectedId)?.id ?? state.selectedId;
  const viewedSessionIds = [...new Set([
    ...(state.viewedSessionIds ?? Object.keys(state.feeds ?? {})),
    ...(selectedId ? [selectedId] : []),
  ].map(id => sessionForId(sessions, id)?.id ?? id))];
  const newSessionIds = [...new Set((state.newSessionIds ?? []).map(id => sessionForId(sessions, id)?.id ?? id))]
    .filter(id => !viewedSessionIds.includes(id));
  state = { ...state, viewedSessionIds, newSessionIds };
  if (!state.feeds) return { ...state, selectedId };
  const feeds: NonNullable<CodexLiveState['feeds']> = {};
  // When an unthreaded selected job joins an existing session, its current
  // window wins over that session's older saved window.
  const priority = (id: string) => id === state.selectedId ? 0 : sessions.some(session => session.id === id) ? 1 : 2;
  const entries = Object.entries(state.feeds).sort(([a], [b]) => priority(a) - priority(b));
  for (const [id, feed] of entries) {
    const session = sessionForId(sessions, id);
    if (!session || feeds[session.id]) continue;
    feeds[session.id] = id === session.id ? feed : {
      ...feed,
      anchor: feed.anchor ? { ...feed.anchor, source: turnKey(feed.anchor.source, id) } : undefined,
      seenItems: feed.seenItems && Object.fromEntries(Object.entries(feed.seenItems).map(([source, item]) => [turnKey(source, id), item])),
    };
  }
  return { ...state, selectedId, feeds };
}

export function isHiddenJob(state: CodexLiveState, job: CodexLiveJob): boolean {
  if (state.hiddenJobIds?.includes(job.id)) return true;
  if (state.hiddenFinishedBefore === undefined || !jobLifecycle(job).finished) return false;
  const completedAt = Date.parse(job.completedAt);
  const endedAt = Number.isFinite(completedAt) ? completedAt
    : number(state.firstEndedAtMs?.[job.id]) ?? Date.parse(job.createdAt);
  return endedAt <= state.hiddenFinishedBefore;
}

export function visibleJobs(state: CodexLiveState): CodexLiveJob[] {
  const ids = new Set(visibleSessions(state).flatMap(session => session.turns.map(job => job.id)));
  return state.jobs.filter(job => ids.has(job.id));
}

export function visibleSessions(state: CodexLiveState): CodexLiveSession[] {
  // Only the latest turn's tombstone/end time hides a conversation. A new turn
  // reopens it, including all of its previously cleared transcript.
  return groupedSessions(state.jobs, state.turnCounts).filter(session => !isHiddenJob(state, session.turns.at(-1)!));
}

export function clearFinished(state: CodexLiveState, nowMs: number): CodexLiveState {
  const clearing = { ...state, hiddenFinishedBefore: Math.max(state.hiddenFinishedBefore ?? nowMs, nowMs) };
  // A concurrent poll may have added completions after the captured clear time.
  const hiddenJobIds = [...new Set([...(state.hiddenJobIds ?? []),
    ...visibleSessions(state).map(session => session.turns.at(-1)!)
      .filter(job => isHiddenJob(clearing, job)).map(job => job.id)])];
  const cleared = { ...clearing, hiddenJobIds };
  const jobs = visibleSessions(cleared).sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  const selectedId = sessionForId(jobs, state.selectedId)?.id
    ?? jobs.find(job => jobLifecycle(job).active)?.id ?? jobs[0]?.id ?? null;
  return { ...cleared, selectedId, historyPage: 0 };
}

// Header-only summaries are the only information retained for unselected jobs.
export function jobSummary(job: CodexLiveJob): CodexLiveJob {
  const lifecycle = jobLifecycle(job);
  return { ...job, ...lifecycle, ...summaryFields(job), events: [], detailsLoaded: false,
    toolUses: job.toolUses ?? job.events.filter(event => ['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall'].includes(event.type)).length,
    question: lifecycle.active && job.question ? { text: questionExcerpt(job.question.text), options: [],
      createdAt: isoTime(job.question.createdAt) } : null };
}

export function boundState(state: CodexLiveState): CodexLiveState {
  state = normalizeSessions(state);
  const sessions = groupedSessions(state.jobs, state.turnCounts);
  const retained = new Set(sessions.flatMap(session => retainedTurns(session).map(job => job.id)));
  const selectedSession = sessionForId(sessions, state.selectedId);
  const detailed = new Set(selectedSession ? retainedTurns(selectedSession).slice(-DETAIL_TURN_LIMIT).map(job => job.id) : []);
  const turnCounts = { ...state.turnCounts, ...Object.fromEntries(sessions.map(session => [session.id, session.turnCount])) };
  const jobs = state.jobs.filter(job => retained.has(job.id)).map(previous => {
    const lifecycle = jobLifecycle(previous);
    const job = { ...previous, ...lifecycle, ...summaryFields(previous),
      question: lifecycle.active && previous.question ? { ...previous.question, createdAt: isoTime(previous.question.createdAt) } : null };
    if (sessionId(job) !== state.selectedId) return jobSummary(job);
    if (!detailed.has(job.id)) return { ...jobSummary(job), detailsOmitted: true };
    return { ...job, detailsOmitted: undefined, events: job.events.slice(-200).map(event => ({ ...event })) };
  });
  // One event budget across the selected conversation, oldest bodies first.
  // Every turn keeps its header even when its oldest activity must be dropped.
  const selected = jobs.filter(job => sessionId(job) === state.selectedId).sort(oldestJob);
  const events = selected.flatMap(job => job.events);
  let total = events.reduce((n, event) => n + JSON.stringify(event).length, 0);
  for (const event of events) {
    if (total <= 450_000) break;
    if (event.body === undefined) continue;
    const before = JSON.stringify(event).length;
    event.body = `${limitChars(event.body, Math.max(0, event.body.length - (total - 450_000) - 1))}…`;
    total += JSON.stringify(event).length - before;
  }
  for (const job of selected) {
    while (total > 450_000 && job.events.length) total -= JSON.stringify(job.events.shift()).length;
  }
  return fitState({ ...state, jobs, turnCounts });
}

// Apply this again after feed normalization, which can add anchor snapshots.
// Measure once and subtract removed jobs; do not reserialize the entire state
// for every eviction. Active turns and the selected conversation are protected.
export function fitState(state: CodexLiveState): CodexLiveState {
  // Bound read acknowledgements before measuring and again after budget eviction.
  const retainedSessionIds = new Set(state.jobs.map(sessionId));
  state = { ...state, viewedSessionIds: state.viewedSessionIds?.filter(id => retainedSessionIds.has(id)) };
  let size = JSON.stringify(state).length;
  if (size < 900_000) return state;
  const sessions = groupedSessions(state.jobs, state.turnCounts);
  const latestIds = new Set(sessions.map(session => session.turns.at(-1)!.id));
  const removed = new Set<string>();
  const remove = (job: CodexLiveJob) => {
    if (removed.has(job.id)) return;
    removed.add(job.id);
    size -= JSON.stringify(job).length + 1;
  };
  // First thin history without removing its session row.
  const history = state.jobs.filter(job => sessionId(job) !== state.selectedId &&
    jobLifecycle(job).finished && !latestIds.has(job.id)).sort(oldestJob);
  for (const job of history) {
    if (size < 899_000) break;
    remove(job);
  }
  // Then discard whole finished, unselected sessions, oldest first.
  for (const session of sessions.sort(oldestJob)) {
    if (size < 899_000) break;
    if (session.id === state.selectedId || !session.finished || session.turns.some(job => jobLifecycle(job).active)) continue;
    for (const job of session.turns) remove(job);
  }
  const jobs = state.jobs.filter(job => !removed.has(job.id));
  const ids = new Set(jobs.map(sessionId));
  const result = { ...state, jobs,
    viewedSessionIds: state.viewedSessionIds?.filter(id => ids.has(id)),
    feeds: state.feeds && Object.fromEntries(Object.entries(state.feeds).filter(([id]) => ids.has(id))),
    recentEndedIds: state.recentEndedIds?.filter(id => ids.has(id)),
  };
  if (JSON.stringify(result).length >= 900_000) throw new Error('View exceeds the 900,000 character budget');
  return result;
}
