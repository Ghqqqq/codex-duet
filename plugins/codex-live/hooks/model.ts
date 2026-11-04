import { limitChars } from './text';
import type { CodexLiveEvent, CodexLiveJob, CodexLiveMarker, CodexLiveSession, CodexLiveState, CodexLiveUsage, CodexLiveUsageEntry, ForumRoom } from '../types';

export const EXPANDED_ID_LIMIT = 5000;
const EXPANDED_ID_LENGTH = 200;
const FORUM_FEED_LIMIT = 20;
const FORUM_FEED_BUDGET = 100_000;
export const forumFeedId = (id: string) => /^forum:rt-[a-z0-9]+-[a-z0-9-]+$/.test(id) && id.length <= 134;

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
const string = (value: unknown): string => typeof value === 'string' ? value : '';
const number = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const validBlockerCode = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z0-9_.:-]{1,64}$/i.test(value);
const usageKeys = ['inputTokens', 'cachedInputTokens', 'outputTokens', 'totalTokens'] as const;
export function usageView(value: unknown): CodexLiveUsage | undefined {
  const usage = object(value);
  return usageKeys.every(key => Number.isSafeInteger(usage[key]) && (usage[key] as number) >= 0)
    ? Object.fromEntries(usageKeys.map(key => [key, usage[key]])) as CodexLiveUsage : undefined;
}
export function usageSnapshots(previous: CodexLiveState['usageByJob'], jobs: readonly CodexLiveJob[]) {
  const snapshots = { ...previous };
  for (const job of jobs) if (job.usage) snapshots[job.id] = { model: job.model || 'unknown', usage: job.usage, sessionId: sessionId(job) };
  return snapshots;
}
export function usageLines(entries: Record<string, CodexLiveUsageEntry>, label = 'Codex session total'): string[] {
  const models = new Map<string, CodexLiveUsage>();
  for (const entry of Object.values(entries)) {
    const sum = models.get(entry.model) ?? { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0 };
    for (const key of usageKeys) sum[key] += entry.usage[key];
    models.set(entry.model, sum);
  }
  return [...models].map(([model, usage]) => `${label} (provider: OpenAI Codex, model ${model}): ` +
    usageKeys.map((key, i) => `${usage[key].toLocaleString('en-US')} ${['input', 'cached', 'output', 'total'][i]}`).join(' · '));
}

// Persisted atoms can contain valid JSON with an invalid shape. Check every
// nested collection consumed by rendering/polling before trusting the cache.
export function validView(value: unknown): value is CodexLiveState {
  const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
  const text = (v: unknown) => typeof v === 'string';
  const finite = (v: unknown) => number(v) !== undefined;
  const bool = (v: unknown) => typeof v === 'boolean';
  const list = (v: unknown, check: (item: unknown) => boolean) => Array.isArray(v) && v.every(check);
  const strings = (v: unknown) => list(v, text);
  const optional = (v: Record<string, unknown>, keys: string[], check: (item: unknown) => boolean) =>
    keys.every(key => v[key] === undefined || check(v[key]));
  const dictionary = (v: unknown, check: (item: unknown) => boolean) => record(v) && Object.values(v).every(check);
  const event = (v: unknown) => record(v) && finite(v.seq) && text(v.type) &&
    optional(v, ['at', 'status', 'lifecycle', 'text', 'body', 'command', 'path', 'kind', 'server', 'tool', 'questionText', 'answer'], text) &&
    optional(v, ['exitCode', 'durationMs', 'added', 'removed'], finite) && optional(v, ['steps', 'statuses'], strings);
  const job = (v: unknown) => record(v) &&
    ['id', 'label', 'status', 'createdAt', 'startedAt', 'completedAt', 'model', 'effort', 'sandbox', 'finalStatus'].every(key => text(v[key])) &&
    ['active', 'finished', 'fast', 'detailsUnavailable'].every(key => bool(v[key])) &&
    optional(v, ['threadId', 'agentName', 'role', 'homeDir', 'cwd', 'workspaceRoot', 'prompt', 'currentOperation', 'lastActivityAt', 'terminalQuestion'], text) &&
    optional(v, ['blockerCode'], validBlockerCode) &&
    optional(v, ['unresolved', 'notStarted', 'promptReport', 'detailsLoaded', 'detailsOmitted'], bool) &&
    optional(v, ['toolUses', 'lastUpdateMs'], finite) && (v.fileCount === null || finite(v.fileCount)) &&
    optional(v, ['usage'], usage => usageView(usage) !== undefined) &&
    (v.question === null || record(v.question) && text(v.question.text) && strings(v.question.options) &&
      optional(v.question, ['createdAt'], text) && optional(v.question, ['expiresAt'], finite)) &&
    list(v.events, event);
  const feed = (v: unknown) => record(v) && finite(v.feedOffset) && bool(v.following) && finite(v.seenLines) &&
    optional(v, ['columns', 'rows'], finite) && optional(v, ['surface'], text) && optional(v, ['keepStopped'], bool) &&
    optional(v, ['expandedPromptIds'], ids => strings(ids) && (ids as string[]).length <= EXPANDED_ID_LIMIT) &&
    optional(v, ['anchor'], a => record(a) && text(a.source) && finite(a.offset)) &&
    optional(v, ['seenItems'], items => dictionary(items, item => record(item) && finite(item.length) && finite(item.hash)));
  const post = (v: unknown) => record(v) && finite(v.seq) && text(v.at) && record(v.author) &&
    text(v.author.kind) && text(v.author.name) && ['idea', 'finding', 'question', 'request', 'intent', 'candidate', 'decision'].includes(String(v.kind)) &&
    optional(v, ['initial'], bool) && finite(v.thread) && (v.replyTo === null || finite(v.replyTo)) && ['title', 'body', 'label'].every(key => text(v[key])) && strings(v.refs) && strings(v.mentions);
  const room = (v: unknown) => record(v) && ['roomId', 'sessionId', 'goal', 'intensity', 'createdAt'].every(key => text(v[key])) &&
    ['open', 'paused', 'closed'].includes(String(v.status)) && strings(v.members) && finite(v.postCount) &&
    optional(v, ['viewedPosts', 'malformed', 'omitted'], finite) && optional(v, ['warning'], text) &&
    optional(v, ['posts'], posts => list(posts, post)) && optional(v, ['timeline'], times => list(times, finite));
  return record(value) && optional(value, ['forumRooms'], rooms => list(rooms, room)) && list(value.jobs, job) && (value.selectedId === null || text(value.selectedId)) && finite(value.nowMs) &&
    optional(value, ['sessionId', 'discoveryWarning', 'openedJobId'], text) && optional(value, ['jobsExpanded'], bool) &&
    optional(value, ['hiddenFinishedBefore', 'spinnerTick', 'historyPage', 'attentionOmitted'], finite) &&
    optional(value, ['newSessionIds', 'viewedSessionIds', 'hiddenJobIds', 'recentEndedIds', 'seenJobIds', 'autoOpenedJobIds'], strings) &&
    optional(value, ['hiddenRoomIds'], ids => list(ids, id => typeof id === 'string' && forumFeedId(`forum:${id}`)) &&
      (ids as string[]).length <= 2000) &&
    optional(value, ['turnCounts', 'firstEndedAtMs'], v => dictionary(v, finite)) &&
    optional(value, ['usagePartial'], bool) &&
    optional(value, ['usageByJob'], v => dictionary(v, entry => record(entry) && text(entry.model) && optional(entry, ['sessionId'], text) && usageView(entry.usage) !== undefined)) &&
    optional(value, ['feeds'], v => dictionary(v, feed));
}

// Display text only: discard terminal escapes, control codes and bidi controls.
export function cleanBody(value: unknown): string {
  return string(value).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ' ');
}

export function clean(value: unknown): string {
  return cleanBody(value).replace(/\s+/g, ' ').trim();
}

function markedLimit(text: string, length: number): string {
  return text.length <= length ? text : `${limitChars(text, length - 1)}…`;
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

// The hook can read markers from any supported host, independent of its own OS.
export function isAbsolutePath(text: string): boolean {
  return !text.includes('\0') && (text.startsWith('/') || /^[a-z]:[\\/]/i.test(text) ||
    /^\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/.test(text));
}

export function markerView(value: unknown): CodexLiveMarker {
  const m = object(value);
  if (m.v !== 1 || !string(m.jobId) || !isAbsolutePath(string(m.jobFile))) {
    throw new Error('Invalid session marker');
  }
  return {
    jobId: string(m.jobId), jobFile: string(m.jobFile),
    summary: limitChars(clean(m.summary), 1000), title: limitChars(clean(m.title), 200),
    name: limitChars(clean(m.name), 100) || undefined,
    createdAt: string(m.createdAt),
    workspaceRoot: isAbsolutePath(string(m.workspaceRoot)) ? clean(m.workspaceRoot) : undefined,
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
    body: typeof e.body === 'string' ? markedLimit(cleanBody(e.body), 4000) : undefined,
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
export function jobLifecycle(job: { status: string; completedAt: string; finalStatus?: string; unresolved?: boolean }) {
  if (job.unresolved) return { status: 'unresolved', finished: false, active: false };
  const terminal = ['completed', 'failed', 'cancelled', 'interrupted', 'stopped', 'blocked', 'needs_input'];
  const ended = Number.isFinite(Date.parse(job.completedAt));
  const status = ended && !terminal.includes(job.status)
    ? terminal.includes(job.finalStatus ?? '') ? job.finalStatus! : 'completed' : job.status;
  const finished = terminal.includes(status);
  return { status, finished, active: !finished && ['running', 'queued', 'waiting'].includes(status) };
}

// Mirror plugins/codex/scripts/lib/state.mjs:356-374 (unresolvedTask).
// The hook sandbox has no PID-liveness API and must not spawn processes.
// Keep queued/running records active; conservatively apply the result checks
// to terminal task records even when a recorded PID may still be alive.
function unresolvedTask(job: Record<string, unknown>): boolean {
  if (job.jobClass !== 'task' || job.recovered || ['queued', 'running', 'waiting'].includes(string(job.status))) return false;
  if (!job.result) return job.status !== 'cancelled' || Boolean(job.turnSubmission);
  const result = object(job.result);
  if (['interrupted', 'cancelled'].includes(string(job.status))) {
    return Boolean(job.turnId || job.turnSubmission) && result.turnEnded === false && result.interruptionConfirmed !== true;
  }
  if (job.status === 'completed' && result.inferredCompletion === true) {
    return Boolean(job.turnId) && result.turnEnded === false;
  }
  if (job.status !== 'failed' || result.turnEnded || result.structured) return false;
  if (result.failureSource === 'transport') return true;
  if (result.workerStatus) return false;
  return result.errorCode === 'BROKER_CONNECTION_CLOSED' ||
    /^(Codex broker connection closed during startup\.|Connection to Codex closed while the turn was running\.|Codex connection closed before turn completion; recover the recorded job\.)$/i.test(string(result.error ?? job.errorMessage));
}

// Match activity.mjs's commandExcerpt: hide only environment prefixes whose
// meaning is known, retaining assignments that can change a reader's behavior.
function stripEnvironment(command: string): string {
  const inert = /^(?:LANG|LANGUAGE|LC_[A-Z]+|TZ|TERM|COLUMNS|LINES|NO_COLOR|FORCE_COLOR|CLICOLOR(?:_FORCE)?|CI|npm_config_[A-Za-z0-9_]+)$/;
  const reader = /^(?:rg|grep|nl|cat|head|tail|ls|wc|find|tree|file|stat|sed|git|zsh|bash|sh)$/;
  const word = /^(?:[^\s'"\\;&|<>()`]|'[^']*'|"(?:\\.|[^"\\])*"|\\.)+(?=\s|[;&|<>()]|$)/;
  let rest = command, env = false, options = false, assigned = false;
  for (;;) {
    const token = word.exec(rest)?.[0];
    if (!token || token.startsWith('#')) return command;
    if (token === 'env' && !env) { env = true; options = true; }
    else if (options && token === '-i') { /* ignore inherited environment */ }
    else if (options && token === '-u') {
      const next = rest.slice(token.length).trimStart();
      const name = word.exec(next)?.[0];
      if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return command;
      rest = next.slice(name.length).trimStart();
      continue;
    } else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      if (/[$`\\]/.test(token)) return command;
      assigned ||= !inert.test(token.slice(0, token.indexOf('=')));
      options = false;
    } else {
      if (env && (token.startsWith('-') || /^['"][A-Za-z_][A-Za-z0-9_]*=/.test(token))) return command;
      return assigned && reader.test(token.replace(/['"\\]/g, '').split('/').at(-1)!) ? command : rest;
    }
    rest = rest.slice(token.length).trimStart();
  }
}

export function unwrapCommand(command: string): string {
  let result = clean(command);
  const wrapper = /^(?:\/bin\/)?(?:zsh|bash|sh)\s+-(?:lc|c)\s+/;
  if (!wrapper.test(result)) return stripEnvironment(result);
  result = result.replace(wrapper, '');
  const quote = result[0];
  if (quote === "'" || quote === '"') {
    result = result.slice(1);
    if (result.endsWith(quote)) result = result.slice(0, -1);
  }
  if (quote !== '"' || !result.includes('\\')) result = stripEnvironment(result);
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

export function expireQuestion(job: CodexLiveJob, nowMs: number): CodexLiveJob {
  return job.question?.expiresAt !== undefined && nowMs >= job.question.expiresAt ? { ...job, question: null } : job;
}

export function jobView(value: unknown, marker: CodexLiveMarker, details = true, nowMs = Date.now()): CodexLiveJob {
  const job = object(value);
  if (job.id !== marker.jobId || !string(job.status)) throw new Error('Invalid job');
  const request = object(job.request);
  const report = object(job.report);
  const result = object(job.result);
  const blockers = Array.isArray(report.blockers) && report.blockers.length ? report.blockers : result.blockers;
  const blockerCode = clean(object(Array.isArray(blockers) ? blockers[0] : undefined).code);
  const unresolved = unresolvedTask(job);
  const notStarted = [object(job.recovery).turnStatus, result.turnStatus].includes('notStarted') ||
    (job.status === 'blocked' || report.status === 'blocked') && ![job.turnId, result.turnId, report.turnId].some(Boolean);
  const pending = object(job.pendingQuestion);
  const { status, finished, active } = jobLifecycle({ status: clean(job.status),
    completedAt: string(job.completedAt), finalStatus: clean(report.status), unresolved });
  // Companion questions carry expiry + timeout rather than a creation timestamp.
  const questionTime = isoTime(pending.createdAt) ?? (number(pending.expiresAt) === undefined ? undefined
    : isoTime(number(pending.expiresAt)! - (number(job.questionTimeoutSec) ?? 900) * 1000));
  // Match the companion's comparison: null is zero, absent/invalid is NaN.
  const deadline = Number(pending.expiresAt), expiresAt = number(deadline);
  const question = active && typeof pending.text === 'string' && pending.answer === undefined && !(deadline <= nowMs)
    ? { ...(questionTime ? { createdAt: questionTime } : {}), ...(expiresAt === undefined ? {} : { expiresAt }),
      text: limitChars(clean(pending.text), 2000), options: Array.isArray(pending.options)
      ? pending.options.map(option => limitChars(clean(typeof option === 'string' ? option :
        object(option).label ?? object(option).text), 300)).slice(0, 20) : [] } : null;
  const activity = Array.isArray(job.activity) ? job.activity : [];
  const terminalQuestion = finished && status === 'needs_input'
    ? markedLimit([
      clean([...activity].reverse().map(object)
        .find(event => event.type === 'agentMessage' && typeof event.question === 'string')?.question),
      clean(object(result.structured).question), clean(report.question),
    ].reduce((longest, question) => question.length > longest.length ? question : longest, ''), 2000) : '';
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
  // C3 identity matching only: approvals and capped/legacy history cannot shift answers.
  const history = new Map((details && Array.isArray(job.questionHistory) ? job.questionHistory.slice(-20).map(object) : [])
    .filter(question => typeof question.callId === 'string' && question.callId.length > 0)
    .map(question => [string(question.callId), question]));
  const events = details ? paired.map(event => {
    const projected = eventView(activity[event.index], event.seq);
    const callId = object(activity[event.index]).callId;
    const question = ['dynamicToolCall', 'mcpToolCall'].includes(event.type) && event.tool === 'ask_parent' && typeof callId === 'string'
      ? history.get(callId) : undefined;
    return { ...projected, command: limitChars(cleanBody(projected.command), 2000),
      ...(typeof question?.text === 'string' ? { questionText: limitChars(clean(question.text), 2000),
        ...(question.resolution === 'answered' && typeof question.answer === 'string'
          ? { answer: limitChars(clean(question.answer), 2000) } : {}) } : {}) };
  }) : [];
  return {
    id: marker.jobId, label: taskText(marker.summary || job.summary || marker.title) || 'Codex Task', status,
    threadId: string(job.threadId).trim() || undefined,
    agentName: limitChars(clean(job.agentName), 100) || marker.name,
    role: limitChars(clean(object(job.roundtable).persona || object(request.roundtable).persona || request.persona || job.agentType || request.agentType || job.agent_type || job.preset || request.preset), 100) || undefined,
    homeDir: isAbsolutePath(string(job.homeDir)) ? string(job.homeDir) : undefined,
    cwd: isAbsolutePath(string(request.cwd)) ? limitChars(clean(request.cwd), 1000) : marker.workspaceRoot,
    active, finished, unresolved, notStarted,
    createdAt: marker.createdAt || string(job.createdAt),
    startedAt: string(job.startedAt) || marker.createdAt || string(job.createdAt),
    completedAt: string(job.completedAt), model: limitChars(clean(request.model), 100),
    // These are already per-turn deltas from the runtime; never use thread totals.
    usage: usageView(result.usage ?? report.usage ?? job.usage),
    effort: limitChars(clean(request.effort), 40), fast: request.serviceTier === 'priority',
    sandbox: limitChars(clean(job.sandbox), 100), workspaceRoot: marker.workspaceRoot,
    ...summaryFields({ currentOperation, lastActivityAt: string(latest.at) }),
    question, ...(terminalQuestion ? { terminalQuestion } : {}), finalStatus: clean(report.status) || status,
    ...(validBlockerCode(blockerCode) ? { blockerCode } : {}),
    ...(details && typeof request.prompt === 'string'
      ? { prompt: limitChars(cleanBody(request.prompt), 20_000), promptReport: request.report === true } : {}),
    fileCount: Array.isArray(report.touchedFiles) ? report.touchedFiles.length : null,
    events: details ? events : [], detailsLoaded: details,
    toolUses: number(object(job.activityTotals).toolUses)
      ?? allPaired.filter(event => ['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall'].includes(event.type)).length,
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
  if (attention(job) === 'blocked' || job.unresolved) return '!';
  if (active && (job.question || status === 'waiting')) return '?';
  return ({ running: '●', queued: '…', completed: '✓', failed: '✗', blocked: '!',
    cancelled: '■', interrupted: '■', stopped: '■' } as Record<string, string>)[status] ?? '·';
}

// Attention follows the live or unresolved owner, independently of recency.
export function attention(job: CodexLiveJob): 'question' | 'blocked' | 'unresolved' | undefined {
  const { status, active } = jobLifecycle(job);
  if (active && job.question) return 'question';
  if (job.unresolved) return 'unresolved';
  if (status === 'blocked' || status === 'needs_input') return 'blocked';
  return undefined;
}

export function attentionOrder(a: CodexLiveJob, b: CodexLiveJob): number {
  const kindA = attention(a), kindB = attention(b);
  const rank = (kind: ReturnType<typeof attention>) => kind === 'question' ? 0 : kind === 'unresolved' ? 1 : kind === 'blocked' ? 2 : 3;
  if (kindA !== kindB) return rank(kindA) - rank(kindB);
  const time = (job: CodexLiveJob) => [job.question?.createdAt, job.completedAt, job.createdAt]
    .map(value => Date.parse(value ?? '')).find(Number.isFinite) ?? 0;
  return time(a) - time(b) || a.id.localeCompare(b.id);
}

export function attentionCounts(jobs: readonly CodexLiveJob[], attentionOmitted = 0) {
  // Active questions and unresolved sessions are never evicted. Omissions are
  // terminal attention beyond the retention cap or serialized state budget.
  const counts = { question: 0, blocked: attentionOmitted, unresolved: 0 };
  for (const job of groupedSessions(jobs)) {
    const kind = attention(job);
    if (kind) counts[kind]++;
  }
  return counts;
}

export function reusedAgentName(job: Pick<CodexLiveJob, 'agentName'>): boolean {
  return /-\d+$/.test(job.agentName ?? '');
}

export function statusLine(jobs: readonly CodexLiveJob[], attentionOmitted = 0): string | undefined {
  const counts = attentionCounts(jobs, attentionOmitted);
  jobs = groupedSessions(jobs);
  const waiting = jobs.filter(job => attention(job));
  const running = jobs.filter(job => jobLifecycle(job).active && job.status === 'running' && !job.question).length;
  const queued = jobs.filter(job => jobLifecycle(job).active && job.status === 'queued' && !job.question).length;
  const otherWaiting = jobs.filter(job => jobLifecycle(job).active && job.status === 'waiting' && !job.question).length;
  const parts = [counts.question ? `${counts.question} ${counts.question === 1 ? 'question' : 'questions'} for Claude` : '',
    counts.blocked ? `${counts.blocked} needs your attention` : '',
    counts.unresolved ? `${counts.unresolved} outcome unknown` : '',
    running ? `${running} running` : '', queued ? `${queued} queued` : '',
    otherWaiting ? `${otherWaiting} waiting for answer` : '', attentionOmitted
      ? `${attentionOmitted} older attention sessions omitted · attention cap ${ATTENTION_SESSION_LIMIT}, subject to state budget` : ''].filter(Boolean);
  const active = jobs.filter(job => jobLifecycle(job).active);
  const name = active.length === 1 ? active[0]?.agentName
    : !active.length && waiting.length === 1 && !attentionOmitted ? waiting[0]?.agentName : undefined;
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
    const active = turns.filter(job => jobLifecycle(job).active);
    const owner = active.filter(job => job.question).at(-1) ?? active.at(-1) ??
      turns.filter(job => job.unresolved).at(-1) ?? turns.filter(job => !job.notStarted).at(-1) ?? latest;
    return { ...owner, ...jobLifecycle(owner), id, lifecycleJobId: owner.id, turns,
      turnCount: Math.max(turns.length, turnCounts[id] ?? 0) };
  });
}

export const TURN_LIMIT = 20;
export const DETAIL_TURN_LIMIT = 5;
// Additional terminal attention protection, below the existing state ceiling.
export const ATTENTION_SESSION_LIMIT = 40;

export function retainedTurns(session: CodexLiveSession): CodexLiveJob[] {
  const latest = session.turns.at(-1)!;
  const protectedIds = new Set(session.turns.filter(job => job.id === latest.id || job.id === session.lifecycleJobId ||
    jobLifecycle(job).active || job.unresolved).map(job => job.id));
  // Protecting active turns and the latest turn takes precedence over the cap.
  const slots = TURN_LIMIT - protectedIds.size;
  if (slots > 0) for (const job of session.turns.filter(job => !protectedIds.has(job.id)).slice(-slots)) protectedIds.add(job.id);
  return session.turns.filter(job => protectedIds.has(job.id));
}

export function detailedTurns(session: CodexLiveSession): CodexLiveJob[] {
  const turns = retainedTurns(session);
  const owner = turns.find(job => job.id === session.lifecycleJobId && jobLifecycle(job).active);
  const ids = new Set(owner ? [owner.id] : []);
  for (const job of [...turns].reverse()) if (ids.size < DETAIL_TURN_LIMIT) ids.add(job.id);
  return turns.filter(job => ids.has(job.id));
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
  state = { ...state, jobs: state.jobs.map(job => expireQuestion(job, state.nowMs)) };
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
    if (!session) {
      if (forumFeedId(id)) feeds[id] = feed;
      continue;
    }
    if (feeds[session.id]) continue;
    feeds[session.id] = id === session.id ? feed : {
      ...feed,
      anchor: feed.anchor ? { ...feed.anchor, source: turnKey(feed.anchor.source, id) } : undefined,
      seenItems: feed.seenItems && Object.fromEntries(Object.entries(feed.seenItems).map(([source, item]) => [turnKey(source, id), item])),
    };
  }
  return { ...state, selectedId, feeds };
}

export function isHiddenJob(state: CodexLiveState, job: CodexLiveJob): boolean {
  if (state.openedJobId === job.id) return false;
  if (jobLifecycle(job).active || job.unresolved) return false;
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
  // A refusal cannot hide its owner. A new started turn reopens the history.
  return groupedSessions(state.jobs, state.turnCounts).filter(session =>
    session.active || session.unresolved || !isHiddenJob(state, session.turns.find(job => job.id === session.lifecycleJobId)!));
}

export function isHiddenRoom(state: CodexLiveState, room: ForumRoom): boolean {
  return room.status === 'closed' && !!state.hiddenRoomIds?.includes(room.roomId);
}

export const visibleForums = (state: CodexLiveState): ForumRoom[] =>
  (state.forumRooms ?? []).filter(room => !isHiddenRoom(state, room));

export function clearFinished(state: CodexLiveState, nowMs: number): CodexLiveState {
  const clearing = { ...state, openedJobId: undefined, hiddenFinishedBefore: Math.max(state.hiddenFinishedBefore ?? nowMs, nowMs) };
  // A concurrent poll may have added completions after the captured clear time.
  const hiddenJobIds = [...new Set([...(state.hiddenJobIds ?? []),
    ...visibleSessions(state).filter(session => !session.active && !session.unresolved)
      .map(session => session.turns.find(job => job.id === session.lifecycleJobId)!)
      .filter(job => isHiddenJob(clearing, job)).map(job => job.id)])];
  const hiddenRoomIds = [...new Set([...(state.hiddenRoomIds ?? []),
    ...(state.forumRooms ?? []).filter(room => room.status === 'closed').map(room => room.roomId)])].slice(-2000);
  const forumRooms = state.forumRooms?.filter(room => room.status !== 'closed' || !hiddenRoomIds.includes(room.roomId));
  const cleared = { ...clearing, hiddenJobIds, hiddenRoomIds, forumRooms };
  const jobs = visibleSessions(cleared).sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  const nextRoom = forumRooms?.find(room => room.status === 'open') ?? forumRooms?.[0];
  const selectedId = forumRooms?.some(room => `forum:${room.roomId}` === state.selectedId) ? state.selectedId : sessionForId(jobs, state.selectedId)?.id
    ?? jobs.find(job => jobLifecycle(job).active)?.id ?? jobs[0]?.id
    ?? (nextRoom ? `forum:${nextRoom.roomId}` : null);
  return { ...cleared, selectedId, historyPage: 0, attentionOmitted: 0 };
}

// Header-only summaries are the only information retained for unselected jobs.
export function jobSummary(job: CodexLiveJob): CodexLiveJob {
  const lifecycle = jobLifecycle(job);
  return { ...job, ...lifecycle, ...summaryFields(job), events: [], detailsLoaded: false,
    prompt: undefined, promptReport: undefined,
    terminalQuestion: job.terminalQuestion ? questionExcerpt(job.terminalQuestion) : undefined,
    toolUses: job.toolUses ?? job.events.filter(event => ['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall'].includes(event.type)).length,
    question: lifecycle.active && job.question ? { text: questionExcerpt(job.question.text), options: [],
      createdAt: isoTime(job.question.createdAt), ...(job.question.expiresAt === undefined ? {} : { expiresAt: job.question.expiresAt }) } : null };
}

export function boundState(state: CodexLiveState): CodexLiveState {
  if (state.forumRooms) {
    const rooms = visibleForums(state).sort((a, b) => Number(b.status === 'open') - Number(a.status === 'open') ||
      b.createdAt.localeCompare(a.createdAt) || b.roomId.localeCompare(a.roomId));
    const selected = state.forumRooms.find(room => `forum:${room.roomId}` === state.selectedId);
    const shown = rooms.slice(0, 3);
    if (selected && !shown.some(room => room.roomId === selected.roomId)) shown.push(selected);
    state = { ...state, forumRooms: shown
      .map(room => `forum:${room.roomId}` === state.selectedId ? room
        : { ...room, posts: undefined, malformed: undefined, omitted: undefined, warning: undefined }) };
  }
  if (state.usageByJob || state.jobs.some(job => job.usage)) state = { ...state, usageByJob: usageSnapshots(state.usageByJob, state.jobs) };
  state = normalizeSessions(state);
  const sessions = groupedSessions(state.jobs, state.turnCounts);
  const retained = new Set(sessions.flatMap(session => retainedTurns(session).map(job => job.id)));
  const selectedSession = sessionForId(sessions, state.selectedId);
  const detailed = new Set(selectedSession ? detailedTurns(selectedSession).map(job => job.id) : []);
  const turnCounts = { ...state.turnCounts, ...Object.fromEntries(sessions.map(session => [session.id, session.turnCount])) };
  const jobs = state.jobs.filter(job => retained.has(job.id)).map(previous => {
    const lifecycle = jobLifecycle(previous);
    const job = { ...previous, ...lifecycle, ...summaryFields(previous),
      question: lifecycle.active && previous.question ? { ...previous.question, createdAt: isoTime(previous.question.createdAt) } : null };
    if (sessionId(job) !== state.selectedId) return jobSummary(job);
    if (!detailed.has(job.id)) return { ...jobSummary(job), detailsOmitted: true };
    return { ...job, detailsOmitted: undefined,
      prompt: job.prompt === undefined ? undefined : limitChars(cleanBody(job.prompt), 20_000),
      events: job.events.slice(-200).map(event => ({ ...event,
        ...(event.answer === undefined ? {} : { answer: limitChars(clean(event.answer), 2000) }) })) };
  });
  // Briefs share the existing detail budget; count JSON escaping as well.
  // One event budget across the selected conversation, oldest bodies first.
  // Every turn keeps its header even when its oldest activity must be dropped.
  const selected = jobs.filter(job => sessionId(job) === state.selectedId).sort(oldestJob);
  const events = selected.flatMap(job => job.events);
  let total = selected.reduce((n, job) => n + JSON.stringify({ prompt: job.prompt, promptReport: job.promptReport }).length, 0)
    + events.reduce((n, event) => n + JSON.stringify(event).length, 0);
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
  const feeds = state.feeds && Object.fromEntries(Object.entries(state.feeds).map(([id, feed]) => [id,
    feed.expandedPromptIds ? { ...feed, expandedPromptIds: [...new Set(feed.expandedPromptIds)]
      .filter(turnId => turnId.length <= EXPANDED_ID_LENGTH && (jobs.some(job => job.id === turnId && sessionId(job) === id) ||
        forumFeedId(id) && /^post:[1-9]\d{0,15}$/.test(turnId) && Number.isSafeInteger(Number(turnId.slice(5)))))
      .slice(-EXPANDED_ID_LIMIT) } : feed]));
  return fitState({ ...state, jobs, turnCounts, feeds });
}

// Apply this again after feed normalization, which can add anchor snapshots.
// Measure once and subtract removed jobs; do not reserialize the entire state
// for every eviction. Active turns and the selected conversation are protected.
export function fitState(state: CodexLiveState): CodexLiveState {
  // Keep accounting separate from transcript retention. At the state ceiling,
  // show a partial total explicitly rather than growing an unbounded ledger.
  if (state.usageByJob && JSON.stringify(state.usageByJob).length > 200_000) {
    let size = 2;
    const entries = Object.entries(state.usageByJob).reverse().filter(entry => {
      size += JSON.stringify(entry).length + 1;
      return size <= 200_000;
    }).reverse();
    state = { ...state, usageByJob: Object.fromEntries(entries), usagePartial: true };
  }
  // Lifetime metadata must shrink with history, including old oversized views.
  // Run before measurement and after eviction so a failed publish can recover.
  const trim = (value: CodexLiveState): CodexLiveState => {
    const jobIds = new Set(value.jobs.map(job => job.id));
    const ids = new Set([...value.jobs.map(sessionId), ...(value.forumRooms ?? []).map(room => `forum:${room.roomId}`)]);
    let forumFeeds = 0;
    let forumBytes = 0;
    return { ...value,
      seenJobIds: value.seenJobIds?.filter(id => jobIds.has(id)),
      autoOpenedJobIds: value.autoOpenedJobIds?.filter(id => jobIds.has(id)),
      // Tombstones also cover cleared jobs no longer in the visible cache.
      hiddenJobIds: value.hiddenJobIds?.slice(-2000),
      hiddenRoomIds: value.hiddenRoomIds?.slice(-2000),
      firstEndedAtMs: value.firstEndedAtMs && Object.fromEntries(Object.entries(value.firstEndedAtMs).filter(([id]) => jobIds.has(id))),
      turnCounts: value.turnCounts && Object.fromEntries(Object.entries(value.turnCounts).filter(([id]) => ids.has(id))),
      viewedSessionIds: value.viewedSessionIds?.filter(id => ids.has(id)),
      newSessionIds: value.newSessionIds?.filter(id => ids.has(id)),
      recentEndedIds: value.recentEndedIds?.filter(id => ids.has(id)),
      feeds: value.feeds && Object.fromEntries(Object.entries(value.feeds)
        .sort(([a], [b]) => Number(b === value.selectedId) - Number(a === value.selectedId))
        .filter(([id]) => ids.has(id) || forumFeedId(id)).filter(([id, feed]) => {
          if (!forumFeedId(id)) return true;
          // Keep the selected window; older room windows share a small cache
          // budget so their snapshots cannot crowd out the live transcript.
          const size = id === value.selectedId ? 0 : JSON.stringify(feed).length;
          if (forumFeeds >= FORUM_FEED_LIMIT || forumBytes + size > FORUM_FEED_BUDGET) return false;
          forumFeeds++; forumBytes += size;
          return true;
        })),
    };
  };
  state = trim(state);
  let size = JSON.stringify(state).length;
  if (size < 900_000) return state;
  const sessions = groupedSessions(state.jobs, state.turnCounts);
  const latestIds = new Set(sessions.flatMap(session => [session.turns.at(-1)!.id, session.lifecycleJobId]));
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
  // Ordinary finished history yields before attention; if the byte ceiling
  // still requires eviction, keep the newest attention and count the omission.
  let attentionOmitted = state.attentionOmitted ?? 0;
  const visible = new Set(visibleSessions(state).map(session => session.id));
  const needsAttention = (session: CodexLiveSession) => visible.has(session.id) && !!attention(session);
  for (const session of sessions.sort((a, b) => Number(needsAttention(a)) - Number(needsAttention(b)) || oldestJob(a, b))) {
    if (size < 899_000) break;
    if (session.id === state.selectedId || !session.finished || session.turns.some(job => jobLifecycle(job).active || job.unresolved)) continue;
    for (const job of session.turns) remove(job);
    if (needsAttention(session)) attentionOmitted++;
  }
  const jobs = state.jobs.filter(job => !removed.has(job.id));
  const result = trim({ ...state, jobs, attentionOmitted });
  if (JSON.stringify(result).length >= 900_000) throw new Error('View exceeds the 900,000 character budget');
  return result;
}
