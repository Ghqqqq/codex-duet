import { limitChars } from './text';
import type { CodexLiveEvent, CodexLiveJob, CodexLiveMarker, CodexLiveState } from '../types';

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

export function markerView(value: unknown): CodexLiveMarker {
  const m = object(value);
  if (m.v !== 1 || !string(m.jobId) || !string(m.jobFile).startsWith('/')) {
    throw new Error('Invalid session marker');
  }
  return {
    jobId: string(m.jobId), jobFile: string(m.jobFile),
    summary: limitChars(clean(m.summary), 1000), title: limitChars(clean(m.title), 200),
    createdAt: string(m.createdAt),
    workspaceRoot: string(m.workspaceRoot).startsWith('/') ? clean(m.workspaceRoot) : undefined,
  };
}

// Keep the completion at its own sequence number. Interleaved unrelated events
// stay in order; repeated invocations of an identical command stay separate.
export function collapseActivity<T extends CodexLiveEvent>(events: readonly T[]): T[] {
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
  return sorted.filter((_, index) => !removed.has(index)).slice(-200);
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

export function jobView(value: unknown, marker: CodexLiveMarker, details = true): CodexLiveJob {
  const job = object(value);
  if (job.id !== marker.jobId || !string(job.status)) throw new Error('Invalid job');
  const request = object(job.request);
  const report = object(job.report);
  const pending = object(job.pendingQuestion);
  const { status, finished, active } = jobLifecycle({ status: clean(job.status),
    completedAt: string(job.completedAt), finalStatus: clean(report.status) });
  const question = active && typeof pending.text === 'string' && pending.answer === undefined
    ? { text: limitChars(clean(pending.text), 2000), options: Array.isArray(pending.options)
      ? pending.options.map(option => limitChars(clean(typeof option === 'string' ? option :
        object(option).label ?? object(option).text), 300)).slice(0, 20) : [] } : null;
  const activity = Array.isArray(job.activity) ? job.activity : [];
  // Pair lifecycles on lightweight metadata before cleaning retained bodies.
  const paired = collapseActivity(activity.map((value, index) => {
    const e = object(value);
    return { seq: number(e.seq) ?? index, type: string(e.type), command: string(e.command),
      server: string(e.server), tool: string(e.tool), lifecycle: string(e.lifecycle), status: string(e.status), index };
  }));
  const events = details ? paired.map(event => {
    const projected = eventView(activity[event.index], event.seq);
    return { ...projected, command: limitChars(clean(projected.command), 2000) };
  }) : [];
  return {
    id: marker.jobId, label: marker.summary || marker.title || 'Codex Task', status,
    active, finished,
    createdAt: marker.createdAt || string(job.createdAt),
    startedAt: string(job.startedAt) || marker.createdAt || string(job.createdAt),
    completedAt: string(job.completedAt), model: limitChars(clean(request.model), 100),
    effort: limitChars(clean(request.effort), 40), fast: request.serviceTier === 'priority',
    sandbox: limitChars(clean(job.sandbox), 100), workspaceRoot: marker.workspaceRoot,
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
  if (active && (job.question || status === 'waiting') || status === 'needs_input') return '?';
  return ({ running: '●', queued: '…', completed: '✓', failed: '✗', blocked: '!',
    cancelled: '■', interrupted: '■', stopped: '■' } as Record<string, string>)[status] ?? '·';
}

export function statusLine(jobs: readonly CodexLiveJob[]): string | undefined {
  // A job waiting for Claude's answer is counted once, as waiting.
  const waiting = jobs.filter(job => jobLifecycle(job).active && (job.question !== null || job.status === 'waiting')).length;
  const running = jobs.filter(job => jobLifecycle(job).active && job.status === 'running' && job.question === null).length;
  const queued = jobs.filter(job => jobLifecycle(job).active && job.status === 'queued' && job.question === null).length;
  const parts = [running ? `${running} running` : '', queued ? `${queued} queued` : '', waiting ? `${waiting} waiting for answer` : ''].filter(Boolean);
  return parts.length ? `Codex · ${parts.join(' · ')}` : undefined;
}

// Header-only summaries are the only information retained for unselected jobs.
export function jobSummary(job: CodexLiveJob): CodexLiveJob {
  const lifecycle = jobLifecycle(job);
  return { ...job, ...lifecycle, events: [], detailsLoaded: false,
    toolUses: job.toolUses ?? job.events.filter(event => ['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall'].includes(event.type)).length,
    question: lifecycle.active && job.question ? { text: '', options: [] } : null };
}

export function boundState(state: CodexLiveState): CodexLiveState {
  const jobs = state.jobs.map(previous => {
    const lifecycle = jobLifecycle(previous);
    const job = { ...previous, ...lifecycle, question: lifecycle.active ? previous.question : null };
    if (job.id !== state.selectedId) return jobSummary(job);
    // Bound serialized events, not just body lengths (plans and escaping count).
    const events = job.events.slice(-200).map(event => ({ ...event }));
    let total = events.reduce((n, event) => n + JSON.stringify(event).length, 0);
    for (const event of events) {
      if (total <= 450_000) break;
      if (event.body === undefined) continue;
      const before = JSON.stringify(event).length;
      event.body = `${limitChars(event.body, Math.max(0, event.body.length - (total - 450_000) - 1))}…`;
      total += JSON.stringify(event).length - before;
    }
    while (total > 450_000 && events.length) total -= JSON.stringify(events.shift()).length;
    return { ...job, events };
  });
  const result = { ...state, jobs };
  if (JSON.stringify(result).length >= 900_000) throw new Error('View exceeds the 900,000 character budget');
  return result;
}
