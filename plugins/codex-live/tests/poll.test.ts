import { test, expect, mock } from 'claude-code/testing';
import type { EngineInterface, On, PaneOpenArgs, UiScrollArgs } from 'claude-code';
import { boundState, clearFinished, visibleJobs, visibleSessions } from '../hooks/model';
import { feedItems, feedLines, feedWindow, normalizeFeed, scrollFeed, selectedJob } from '../hooks/layout';
import { createPoller } from '../hooks/poll';
import type { CodexLiveState } from '../types';

const epoch = Date.parse('2026-10-18T00:00:00.000Z');
const start = { cwd: '/workspace', surface: 'terminal' as const, isInteractive: true };

function fixture(on: On, failure: () => string | undefined = () => undefined) {
  const clock = mock.clock(on, { now: epoch });
  mock.env(on, { HOME: '/user', CODEX_COMPANION_HOME: '/alias' });
  const files = new Map<string, { text: string; mtime: number }>();
  const reads: string[] = [];
  const lists: string[] = [];
  const opens: PaneOpenArgs[] = [];
  const statuses: (string | undefined)[] = [];
  const writes: CodexLiveState[] = [];
  let open = false;
  let session = 'session-a';
  on('session.start', ($, e) => ({ cwd: e.cwd }));
  on('session.id', () => ({ value: session }));
  on('command.register', ($, e) => ({ value: { command: e.name } }));
  on('ui.panes', () => ({ value: open ? [{ id: 'codex-live', title: 'Codex',
    isShown: true, isFocused: false, isPlaced: true }] : [] }));
  on('ui.open', ($, e) => { opens.push(e); open = true; return { value: { isPlaced: true } }; });
  on('ui.status', ($, e) => { statuses.push(e.text); return { value: undefined }; });
  on('fs.exists', () => ({ value: true }));
  on('fs.stat', ($, e) => {
    if (e.path === '/alias') return { value: {
      kind: 'dir', size: 0, mtimeMs: 0, isLink: true, realPath: '/canonical',
    } };
    const file = files.get(e.path);
    return file ? { value: { kind: 'file', size: file.text.length, mtimeMs: file.mtime, isLink: false } }
      : { deny: 'File removed' };
  });
  on('fs.list', ($, e) => {
    lists.push(e.path);
    return { value: [...files.keys()].filter(path => path.startsWith(`${e.path}/`)).map(path => ({
      name: path.slice(e.path.length + 1), kind: 'file' as const, size: 1, mtimeMs: 1, isLink: false,
    })) };
  });
  on('fs.read', ($, e) => {
    reads.push(e.path);
    const file = files.get(e.path);
    return file ? { value: file.text } : { deny: 'File unreadable' };
  });
  on('state.set', async ($, e, next) => {
    const reason = failure();
    if (reason) return { deny: reason };
    const result = await next(e);
    expect(JSON.stringify(e.value).length <= 900000).toBe(true);
    writes.push(e.value);
    return result;
  });
  function add(id: string, status = 'running', n = 0) {
    const createdAt = new Date(epoch + n * 1000).toISOString();
    files.set(`/canonical/duet/sessions/${session}/${id}.json`, { mtime: 1, text: JSON.stringify({
      v: 1, jobId: id, jobFile: `/jobs/${id}.json`, summary: `Task ${id}`, title: 'Codex Task', createdAt,
    }) });
    files.set(`/jobs/${id}.json`, { mtime: 1, text: JSON.stringify({
      id, status, createdAt, startedAt: createdAt, activity: [{ seq: 1, type: 'agentMessage', text: 'Working' }],
    }) });
  }
  return { clock, files, reads, lists, opens, statuses, writes, add,
    close: () => { open = false; }, switchSession: () => { session = 'session-b'; },
    latest: () => writes[writes.length - 1],
  };
}

// The kit validates trees but does not paint a scrollable window. These unit
// tests use an entirely in-memory engine and assert no engine scrolls occur;
// Mounted session/timer integration tests use the real kit.
function scrollFixture() {
  const files = new Map<string, { text: string; mtime: number }>();
  const markers: string[] = [];
  const scrolls: UiScrollArgs[] = [];
  const opens: PaneOpenArgs[] = [];
  const reads: string[] = [];
  const logs: string[] = [];
  const statuses: (string | undefined)[] = [];
  const unreadable = new Set<string>();
  let observeStateGet: (() => void) | undefined;
  let maxPublishedChars = 0;
  let open = false;
  let now = epoch;
  let state: CodexLiveState = { jobs: [], selectedId: null, nowMs: 0 };
  let version = 0;
  const engine = {
    ui: {
      panes: async () => open ? [{ id: 'codex-live', isFocused: false }] : [],
      open: async (args: PaneOpenArgs) => { opens.push(args); open = true; return { isPlaced: true }; },
      status: (text: string | undefined) => { statuses.push(text); },
      log: (message: string) => { logs.push(message); },
      invalidate: () => {},
      scroll: async (args: UiScrollArgs) => { scrolls.push(args); return {}; },
    },
    session: { id: async () => 'session-a' },
    env: { get: async () => '/home' },
    clock: { now: async () => now },
    fs: {
      exists: async () => true,
      list: async () => markers.map(name => ({ name, kind: 'file' })),
      read: async (path: string) => {
        reads.push(path);
        if (unreadable.has(path)) throw new Error('Simulated unreadable job');
        return files.get(path)!.text;
      },
      stat: async (path: string) => ({ mtimeMs: files.get(path)?.mtime ?? 0, realPath: path }),
    },
    state: {
      get: async () => { observeStateGet?.(); return { value: state, version }; },
      set: async (_ref: unknown, value: CodexLiveState) => { maxPublishedChars = Math.max(maxPublishedChars, JSON.stringify(value).length); state = value; return { isSet: true, version: ++version }; },
    },
  };
  // Fail closed on any new engine capability, including file mutation or companion/tool calls.
  const forbidden: string[] = [];
  const guard = <T extends object>(value: T, prefix: string): T => new Proxy(value, {
    get(target, key, receiver) {
      if (!(key in target)) { forbidden.push(`${prefix}.${String(key)}`); throw new Error(`Read-only violation: ${prefix}.${String(key)}`); }
      return Reflect.get(target, key, receiver);
    },
  });
  engine.fs = guard(engine.fs, 'fs');
  engine.ui = guard(engine.ui, 'ui');
  engine.session = guard(engine.session, 'session');
  const guarded = guard(engine, 'engine') as unknown as EngineInterface;
  const checkedPoller = () => {
    const raw = createPoller(guarded);
    return async (force = false) => {
      await raw(force);
      // Assert outside product catch blocks: a rejected call cannot hide a violation.
      expect(forbidden).toEqual([]);
      expect(scrolls).toEqual([]);
      expect(maxPublishedChars <= 900000).toBe(true);
    };
  };
  const poll = checkedPoller();
  function add(id: string, n = 0) {
    const createdAt = new Date(epoch + n * 1000).toISOString();
    markers.push(`${id}.json`);
    files.set(`/home/duet/sessions/session-a/${id}.json`, { mtime: 1, text: JSON.stringify({
      v: 1, jobId: id, jobFile: `/jobs/${id}.json`, summary: `Task ${id}`, createdAt,
    }) });
    files.set(`/jobs/${id}.json`, { mtime: 1, text: JSON.stringify({
      id, status: 'running', startedAt: createdAt, activity: [{ seq: 1, type: 'agentMessage', text: 'Working' }],
    }) });
  }
  return { forbidden, poll, add, files, scrolls, opens, reads, logs, statuses, unreadable,
    onStateGet: (observer?: () => void) => { observeStateGet = observer; },
    reload: checkedPoller, latest: () => state,
    close: () => { open = false; },
    advance: (ms: number) => { now += ms; },
  };
}

function patchJob(files: Map<string, { text: string; mtime: number }>, id: string, fields: Record<string, unknown>) {
  const file = files.get(`/jobs/${id}.json`)!;
  files.set(`/jobs/${id}.json`, { mtime: file.mtime + 1, text: JSON.stringify({ ...JSON.parse(file.text), ...fields }) });
}

const created = (ms: number) => new Date(ms).toISOString();
const historyPane = { title: 'Codex', isFocused: true, bodyColumns: 56, placement: 'inline' as const,
  scroll: { offset: 0, bodyRows: 14 }, view: {} };
const waitingCount = (text: string | undefined) => Number(text?.match(/(\d+) waiting/)?.[1] ?? 0);

test('discovery caches unchanged files, respects closed panes and opens new active jobs', async ($, on) => {
  const f = fixture(on);
  await $.session.start(start);
  await $.session.start(start); // One timer even after repeated starts.
  await f.clock.advance(5000);
  expect(f.lists.length).toBe(1);
  f.add('a');
  await f.clock.advance(1000);
  expect(f.lists.at(-1)).toBe('/canonical/duet/sessions/session-a');
  expect(f.latest()?.selectedId).toBe('a');
  expect(f.opens.length).toBe(1);
  expect(f.opens[0]?.focus).toBe(undefined);
  f.close();
  const before = [...f.reads];
  await f.clock.advance(5000);
  expect(f.reads).toEqual(before);
  expect(f.opens.length).toBe(1);
  f.add('b', 'queued', 1);
  await f.clock.advance(1000);
  expect(f.opens.length).toBe(2);
  expect(f.latest()?.selectedId).toBe('a');
  expect(f.latest()?.jobs.map(job => job.id)).toEqual(['b', 'a']);
  f.switchSession();
  f.add('other');
  await f.clock.advance(1000);
  expect(f.latest()?.jobs.map(job => job.id)).toEqual(['other']);
  expect(f.lists.at(-1)).toBe('/canonical/duet/sessions/session-b');
});

test('an unrelated worker preserves the following conversation and stays new across reload until viewed', async () => {
  const f = scrollFixture();
  f.add('ada');
  patchJob(f.files, 'ada', { threadId: 'ada', activity: Array.from({ length: 30 }, (_, i) => ({
    seq: i + 1, type: 'agentMessage', text: `Ada update ${i + 1}.`,
  })) });
  await f.poll(true);
  const lines = feedLines(selectedJob(f.latest())!, epoch, 60);
  const view = { ...normalizeFeed(lines, 8, { feedOffset: 0, following: true, seenLines: lines.length }), columns: 60 };
  f.latest().feeds = { 'thread:ada': view };
  f.add('grace', 1);
  patchJob(f.files, 'grace', { threadId: 'grace' });
  await f.poll(true);
  expect(f.latest().selectedId).toBe('thread:ada');
  expect(f.latest().feeds?.['thread:ada']).toEqual(view);
  expect(f.latest().newSessionIds).toEqual(['thread:grace']);
  await f.reload()(true);
  expect(f.latest().selectedId).toBe('thread:ada');
  expect(f.latest().feeds?.['thread:ada']).toEqual(view);
  expect(f.latest().newSessionIds).toEqual(['thread:grace']);
  f.latest().selectedId = 'thread:grace';
  await f.poll(true);
  expect(f.latest().newSessionIds).toEqual([]);
  f.latest().selectedId = 'thread:ada';
  f.add('grace-again', 2);
  patchJob(f.files, 'grace-again', { threadId: 'grace' });
  await f.poll(true);
  expect(f.latest().selectedId).toBe('thread:ada');
  expect(f.latest().newSessionIds).toEqual([]);
  expect(f.logs).toEqual([]);
});

test('a new waiting worker is pinned without moving the stopped reader and is acknowledged when selected', async ($, on) => {
  const f = fixture(on);
  f.add('ada');
  patchJob(f.files, 'ada', { activity: Array.from({ length: 30 }, (_, i) => ({
    seq: i + 1, type: 'agentMessage', text: `Ada update ${i}.`,
  })) });
  await $.session.start(start);
  await f.clock.advance(1000);
  const ui = await $.ui.mount({ plugin: 'codex-live', surface: 'terminal', component: 'Pane', requestId: 'codex-live', props: historyPane });
  await $.ui.scroll({ component: 'Pane', requestId: 'codex-live', offset: 0, by: -20, bodyRows: 14,
    contentRows: 100, origin: { kind: 'person' } });
  const anchor = f.latest()?.feeds?.ada?.anchor;
  expect(anchor).toBeDefined();
  f.add('grace', 'running', 1);
  patchJob(f.files, 'grace', { pendingQuestion: { text: 'Use the existing API?', expiresAt: epoch + 900000 } });
  await f.clock.advance(1000);
  expect(f.latest()?.selectedId).toBe('ada');
  expect(f.latest()?.feeds?.ada?.following).toBe(false);
  expect(f.latest()?.feeds?.ada?.anchor).toEqual(anchor);
  expect((await ui.findAll({ type: 'Button' })).filter(button => ['ada', 'grace'].includes(button.key ?? ''))
    .map(button => button.key)).toEqual(['grace', 'ada']);
  expect(f.latest()?.newSessionIds).toEqual(['grace']);
  const stopped = (await ui.find({ key: 'transcript' }))?.children;
  await ui.press({ key: 'grace' });
  expect(f.latest()?.selectedId).toBe('grace');
  expect(f.latest()?.newSessionIds).toEqual([]);
  await ui.press({ key: 'ada' });
  expect((await ui.find({ key: 'transcript' }))?.children).toEqual(stopped);
  expect(f.latest()?.feeds?.ada?.following).toBe(false);
  expect(f.latest()?.feeds?.ada?.anchor).toEqual(anchor);
  await f.clock.advance(1000);
  expect(f.latest()?.newSessionIds).toEqual([]);
  await ui.unmount();
});

test('open command focuses the pane', async ($, on) => {
  const f = fixture(on);
  await $.session.start(start);
  await $.command.run({ command: 'codex-live', args: '', origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 60 } });
  expect(f.opens[0]).toMatchObject({ id: 'codex-live', focus: true });
});

test('malformed markers and missing jobs recover while preserving the last transcript', async ($, on) => {
  const f = fixture(on);
  f.add('a');
  const path = '/canonical/duet/sessions/session-a/a.json';
  const marker = f.files.get(path)!;
  f.files.set(path, { ...marker, text: '{' });
  await $.session.start(start);
  await f.clock.advance(1000);
  expect(f.latest()?.jobs ?? []).toEqual([]);
  f.files.set(path, marker);
  await f.clock.advance(5000);
  expect(f.latest()?.selectedId).toBe('a');
  const original = f.latest()?.jobs[0]?.events;
  const ui = await $.ui.mount({ plugin: 'codex-live', surface: 'terminal', component: 'Pane', requestId: 'codex-live', props: historyPane });
  f.files.set('/jobs/a.json', { mtime: 2, text: '{' });
  await f.clock.advance(1000);
  expect(f.latest()?.jobs[0]?.detailsUnavailable).toBe(true);
  expect((await ui.find({ key: 'live-status' }))?.children[0]).toMatchObject({ props: { color: 'warning' } });
  expect((await ui.find({ key: 'transcript' }))?.text).toContain('Working');
  expect(f.latest()?.jobs[0]?.events).toEqual(original);
  f.files.delete('/jobs/a.json');
  await f.clock.advance(5000);
  expect(f.latest()?.jobs[0]?.events).toEqual(original);
  f.files.set('/jobs/a.json', { mtime: 2, text: JSON.stringify({ id: 'a', status: 'failed' }) });
  await f.clock.advance(5000);
  expect(f.latest()?.jobs[0]).toMatchObject({ detailsUnavailable: false, finished: true, status: 'failed' });
  patchJob(f.files, 'a', { status: 'completed' });
  await f.clock.advance(10000);
  expect(f.latest()?.jobs[0]?.status).toBe('completed');
  await ui.unmount();
});

test('mounted pane preserves stopped content across polling and resizing, then follows on jump', async ($, on) => {
const f = fixture(on);
let delegated = 0;
on('ui.scroll', () => { delegated++; return {}; });
f.add('a', 'running', 1); f.add('b'); f.add('c', 'completed'); f.add('d', 'failed');
const revise = (lines: number) => patchJob(f.files, 'a', {
  activity: [{ seq: 1, type: 'agentMessage', body: Array.from({ length: lines }, (_, i) => `Line ${i}`).join('\n') }],
});
  revise(35);
  await $.session.start(start);
  await f.clock.advance(1000);
  const ui = await $.ui.mount({ plugin: 'codex-live', surface: 'terminal', component: 'Pane', requestId: 'codex-live', props: historyPane });
  await $.ui.scroll({ component: 'Pane', requestId: 'codex-live', offset: 0, by: -5,
    bodyRows: 14, contentRows: 15, origin: { kind: 'person' } });
  const stopped = (await ui.find({ key: 'transcript' }))?.text;
  const anchor = f.latest()?.feeds?.a?.anchor;
  await ui.redraw({ ...historyPane, scroll: { offset: 0, bodyRows: 8 } });
  const short = (await ui.find({ key: 'transcript' }))?.text;
  revise(38);
  await f.clock.advance(1000);
  expect((await ui.find({ key: 'transcript' }))?.text).toBe(short);
  expect(f.latest()?.feeds?.a?.anchor).toEqual(anchor);
  const state = f.latest()!;
  expect(feedWindow(feedLines(selectedJob(state)!, state.nowMs, 56), 2, state.feeds?.a).newLines).toBe(3);
  await ui.redraw(historyPane);
  expect((await ui.find({ key: 'transcript' }))?.text).toBe(stopped);
  await ui.press({ key: 'jump-bottom' });
  expect(f.latest()?.feeds?.a?.following).toBe(true);
  expect(await ui.find({ key: 'jump-bottom' })).toBe(undefined);
  revise(39);
  await f.clock.advance(1000);
  expect((await ui.find({ key: 'transcript' }))?.text).toContain('Line 38');
  expect(delegated).toBe(0);
  await ui.unmount();
});

test('recent history expires by completion or first observation without deleting records', async ($, on) => {
  const f = fixture(on);
  f.add('selected', 'running', 1); f.add('missing', 'running');
  await $.session.start(start);
  await f.clock.advance(181000);
  patchJob(f.files, 'missing', { status: 'interrupted' });
  patchJob(f.files, 'selected', { status: 'completed', completedAt: created(epoch - 600000) });
  await f.clock.advance(1000);
  const observed = f.latest()?.firstEndedAtMs?.missing;
  expect(observed).toBe(epoch + 182000);
  expect(f.latest()?.recentEndedIds).toEqual(['missing']);
  const ui = await $.ui.mount({ plugin: 'codex-live', surface: 'terminal', component: 'Pane', requestId: 'codex-live', props: historyPane });
  expect(await ui.find({ key: 'missing' })).toBeDefined();
  const files = [...f.files.entries()];
  await f.clock.advance(120000);
  expect(f.latest()?.recentEndedIds).toEqual([]);
  expect(await ui.find({ key: 'missing' })).toBe(undefined);
  expect(f.latest()?.selectedId).toBe('selected');
  expect(f.latest()?.firstEndedAtMs?.missing).toBe(observed);
  expect([...f.files.entries()]).toEqual(files);
  await ui.press({ key: 'toggle-jobs' });
  await ui.press({ key: 'missing' });
  expect(f.latest()?.selectedId).toBe('missing');
  await ui.unmount();
});

test('D1: rejected state writes show a pinned error and debug log until recovery', async ($, on) => {
  let reject = true;
  const f = fixture(on, () => reject ? 'simulated state capacity failure' : undefined);
  f.add('a');
  const logs: { text: string; to: string }[] = [];
  on('ui.log', ($, e) => { logs.push(e); return { value: undefined }; });
  await $.session.start(start);
  await f.clock.advance(1000);
  const ui = await $.ui.mount({ plugin: 'codex-live', surface: 'terminal', component: 'Pane', requestId: 'codex-live',
    props: { ...historyPane, placement: 'dock', bodyColumns: 120 } });
  expect((await ui.find({ key: 'live-status' }))?.children[0]).toMatchObject({ props: { color: 'error' } });
  expect(logs.some(log => log.to === 'debug' && log.text.includes('simulated state capacity failure'))).toBe(true);
  reject = false;
  await f.clock.advance(5000); // With no committed job/open request yet, idle retry cadence is five seconds.
  expect(f.latest()?.jobs[0]?.id).toBe('a');
  expect(f.opens.length).toBe(1);
  expect((await ui.find({ key: 'live-status' }))?.children[0]).not.toMatchObject({ props: { color: 'error' } });
  await ui.unmount();
});

test('D11: a fresh poller adopts session identity, selection, anchors, expansion and missing end times', async () => {
  const f = scrollFixture();
  f.add('a'); f.add('b', 1);
  f.files.set('/jobs/a.json', { mtime: 1, text: JSON.stringify({ id: 'a', status: 'completed',
    activity: [{ seq: 1, type: 'agentMessage', body: 'a\n'.repeat(50) }] }) });
  await f.poll();
  const state = f.latest();
  state.selectedId = 'a'; state.jobsExpanded = true; state.historyPage = 1;
  state.feeds = { a: { feedOffset: 5, following: false, seenLines: 54, columns: 56, rows: 8 } };
  const firstEnd = state.firstEndedAtMs?.a;
  await f.poll(true); // Hydrate the selected transcript before module-local caches are lost.
  f.advance(121000);
  const markerPath = '/home/duet/sessions/session-a/a.json';
  const markerFile = f.files.get(markerPath)!;
  f.files.set(markerPath, { ...markerFile, text: '{' });
  const reloaded = f.reload();
  await reloaded(true);
  expect(f.latest()?.selectedId).toBe('a');
  expect(f.latest()?.jobs.some(job => job.id === 'a')).toBe(true);
  f.files.set(markerPath, markerFile);
  f.advance(5000);
  await reloaded(true);
  expect(f.latest()?.selectedId).toBe('a');
  expect(f.latest()?.jobsExpanded).toBe(true);
  expect(f.latest()?.historyPage).toBe(1);
  expect(f.latest()?.feeds?.a?.following).toBe(false);
  expect(f.latest()?.feeds?.a?.feedOffset).toBe(5);
  expect(f.latest()?.jobs.find(job => job.id === 'a')?.events[0]?.body).toContain('a\n');
  expect(f.latest()?.firstEndedAtMs?.a).toBe(firstEnd);
  expect(f.latest()?.recentEndedIds).toEqual([]);
  expect(f.latest()?.sessionId).toBe('session-a');
  expect(f.latest()?.seenJobIds?.includes('b')).toBe(true);
  expect(f.latest()?.autoOpenedJobIds).toEqual(['b']);
  expect(f.opens.length).toBe(1);
});

test("cleared jobs stay hidden across reloads without file writes or companion calls", async () => {
  const f = scrollFixture();
  f.add('done'); f.add('active', 1);
  f.files.set('/jobs/done.json', { mtime: 1, text: JSON.stringify({ id: 'done', status: 'completed' }) });
  await f.poll();
  f.latest().selectedId = 'done';
  Object.assign(f.latest(), clearFinished(f.latest(), epoch));
  const files = [...f.files.entries()];
  const reloaded = f.reload();
  await reloaded(true);
  expect(f.latest().hiddenJobIds).toEqual(['done']);
  expect(f.latest().hiddenFinishedBefore).toBe(epoch);
  expect(f.latest().selectedId).toBe('active');
  expect(visibleJobs(f.latest()).map(job => job.id)).toEqual(['active']);
  expect([...f.files.entries()]).toEqual(files);
  expect(f.forbidden).toEqual([]);
  expect(f.scrolls).toEqual([]);
  // This old job was never retained or added to hiddenJobIds before the reload.
  f.add('rediscovered', -7200);
  f.files.set('/jobs/rediscovered.json', { mtime: 1, text: JSON.stringify({
    id: 'rediscovered', status: 'blocked', completedAt: created(epoch - 3600000),
  }) });
  f.advance(2000);
  f.add('new', 2);
  await reloaded(true);
  expect(f.latest().selectedId).toBe('active');
  expect(visibleJobs(f.latest()).map(job => job.id)).toEqual(['new', 'active']);
  expect(f.latest().hiddenJobIds).toEqual(['done']);
  expect(f.latest().hiddenFinishedBefore).toBe(epoch);
  expect(f.forbidden).toEqual([]);
});

test('Clear finished survives polling, leaves disk records intact and resets for another session', async ($, on) => {
  const f = fixture(on);
  for (let n = 0; n < 25; n++) {
    f.add(`done-${n}`, 'completed', n - 30);
    if (n % 2 === 0) patchJob(f.files, `done-${n}`, { completedAt: created(epoch - 10000) });
  }
  await $.session.start(start);
  await $.command.run({ command: 'codex-live', args: '', origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 56 } });
  await f.clock.advance(1000);
  const ui = await $.ui.mount({ plugin: 'codex-live', surface: 'terminal', component: 'Pane', requestId: 'codex-live', props: historyPane });
  const files = [...f.files.entries()];
  await ui.press({ key: 'clear-finished' });
  const reads = f.reads.filter(path => path.startsWith('/jobs/')).length;
  for (let cycle = 0; cycle < 2; cycle++) {
    await f.clock.advance(10000);
    expect(visibleJobs(f.latest()!)).toEqual([]);
    expect(f.reads.filter(path => path.startsWith('/jobs/')).length).toBe(reads);
  }
  expect(f.latest()?.hiddenFinishedBefore).toBe(epoch + 1000);
  expect(f.latest()?.selectedId).toBe(null);
  expect(f.latest()?.viewedSessionIds).toEqual([]);
  expect([...f.files.entries()]).toEqual(files);
  expect(await ui.find({ key: 'hidden-notice' })).toBeDefined();
  f.add('new', 'running', 1);
  await f.clock.advance(1000);
  expect(f.latest()?.selectedId).toBe('new');
  expect(await ui.find({ key: 'toggle-jobs' })).toBe(undefined);
  f.switchSession();
  f.add('done', 'completed');
  await f.clock.advance(1000);
  expect(f.latest()?.hiddenJobIds).toBe(undefined);
  expect(f.latest()?.hiddenFinishedBefore).toBe(undefined);
  await ui.unmount();
});

test('jobs active at Clear stay visible when they finish, and new jobs remain selectable', async ($, on) => {
  const f = fixture(on);
  f.add('done', 'completed', -3);
  f.add('running', 'running', -2);
  f.add('missing-end', 'running', -1);
  await $.session.start(start);
  await f.clock.advance(1000);
  const ui = await $.ui.mount({ plugin: 'codex-live', surface: 'terminal', component: 'Pane', requestId: 'codex-live', props: historyPane });
  await ui.press({ key: 'clear-finished' });
  expect(f.latest()?.hiddenFinishedBefore).toBe(epoch + 1000);
  f.files.set('/jobs/running.json', { mtime: 2, text: JSON.stringify({
    id: 'running', status: 'completed', completedAt: created(epoch + 2000),
  }) });
  f.files.set('/jobs/missing-end.json', { mtime: 2, text: JSON.stringify({ id: 'missing-end', status: 'interrupted' }) });
  await f.clock.advance(1000);
  expect(visibleJobs(f.latest()!).map(job => job.id)).toEqual(['missing-end', 'running']);
  expect(f.latest()?.jobs.every(job => job.finished)).toBe(true);
  expect(f.latest()?.firstEndedAtMs?.['missing-end']).toBe(epoch + 2000);
  f.add('new', 'running', 3);
  f.add('new-finished', 'completed', 3);
  await f.clock.advance(1000);
  expect(f.latest()?.selectedId).toBe('missing-end');
  expect(visibleJobs(f.latest()!).map(job => job.id)).toEqual(['new-finished', 'new', 'missing-end', 'running']);
  await ui.press({ key: 'missing-end' });
  await ui.press({ key: 'new' });
  expect(f.latest()?.selectedId).toBe('new');
  await ui.press({ key: 'toggle-jobs' });
  await ui.press({ key: 'new-finished' });
  expect(f.latest()?.selectedId).toBe('new-finished');
  await f.clock.advance(10000);
  expect(visibleJobs(f.latest()!).map(job => job.id)).toEqual(['new-finished', 'new', 'missing-end', 'running']);
  expect(f.latest()?.hiddenJobIds).toEqual(['done']);
  await ui.unmount();
});

test('hidden jobs do not consume the twenty visible retention slots', async () => {
  const f = scrollFixture();
  f.add('old-active', -100);
  f.add('old-selected', -99);
  for (let n = 0; n < 25; n++) {
    const id = `visible-${n}`;
    f.add(id, n - 50);
    f.files.set(`/jobs/${id}.json`, { mtime: 1, text: JSON.stringify({ id, status: 'completed', completedAt: created(epoch + 1) }) });
  }
  f.files.set('/jobs/old-selected.json', { mtime: 1, text: JSON.stringify({
    id: 'old-selected', status: 'completed', completedAt: created(epoch + 1),
  }) });
  await f.poll();
  f.latest().selectedId = 'old-selected';
  // Watermark-only hidden jobs and legacy ID-hidden jobs sort ahead of every visible job.
  f.latest().hiddenFinishedBefore = epoch;
  f.latest().hiddenJobIds = ['legacy'];
  for (const id of ['legacy', ...Array.from({ length: 25 }, (_, n) => `hidden-${n}`)]) {
    f.add(id);
    f.files.set(`/jobs/${id}.json`, { mtime: 1, text: JSON.stringify({
      id, status: 'completed', completedAt: created(epoch + (id === 'legacy' ? 1 : 0)),
    }) });
  }
  f.advance(10000);
  await f.poll(true);
  expect(f.latest().jobs.map(job => job.id)).toEqual([
    ...Array.from({ length: 20 }, (_, n) => `visible-${24 - n}`), 'old-selected', 'old-active',
  ]);
  expect(f.latest().selectedId).toBe('old-selected');
});

test('evicted history reuses mtimes, drops missing marker memos and detects revived jobs', async ($, on) => {
  const f = fixture(on);
  for (let n = 0; n < 25; n++) f.add(`old-${n}`, 'completed', n - 25);
  await $.session.start(start);
  await $.command.run({ command: 'codex-live', args: '', origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 } });
  await f.clock.advance(1000);
  const jobReads = () => f.reads.filter(path => path.startsWith('/jobs/'));
  expect(jobReads().length).toBe(25);
  const firstEndedAtMs = { ...f.latest()?.firstEndedAtMs };
  await f.clock.advance(30000);
  expect(jobReads().length).toBe(25);
  expect(f.latest()?.jobs.length).toBe(20);
  expect(f.latest()?.firstEndedAtMs).toEqual(firstEndedAtMs);

  const marker = '/canonical/duet/sessions/session-a/old-0.json';
  const saved = f.files.get(marker)!;
  f.files.delete(marker);
  await f.clock.advance(1000); // A successful listing confirms disappearance.
  f.files.set(marker, saved);
  await f.clock.advance(10000);
  expect(jobReads().slice(25)).toEqual(['/jobs/old-0.json']); // Same mtime, but its memo was dropped.
  expect(f.latest()?.firstEndedAtMs).toEqual(firstEndedAtMs);

  f.files.set('/jobs/old-0.json', { mtime: 2, text: JSON.stringify({ id: 'old-0', status: 'running',
    activity: [{ seq: 1, type: 'agentMessage', text: 'Revived' }],
  }) });
  await f.clock.advance(10000);
  expect(jobReads().slice(26)).toEqual(['/jobs/old-0.json']);
  expect(f.latest()?.jobs.find(job => job.id === 'old-0')?.active).toBe(true);
  expect(f.latest()?.jobs.length).toBe(21);
  expect(f.latest()?.firstEndedAtMs?.['old-0']).toBe(undefined);

  f.switchSession();
  f.add('old-1', 'running'); // Same marker name and mtime must not reuse another session's memo.
  await f.clock.advance(1000);
  expect(jobReads().slice(27)).toEqual(['/jobs/old-1.json']);
  expect(f.latest()?.jobs.map(job => job.id)).toEqual(['old-1']);
  expect(f.latest()?.jobs[0]?.active).toBe(true);
});

test('a selected following session stays selected and follows a newly auto-opened follow-up', async () => {
  const f = scrollFixture();
  f.add('first');
  patchJob(f.files, 'first', { threadId: 'shared', status: 'completed', completedAt: created(epoch) });
  await f.poll(true);
  expect(f.latest().selectedId).toBe('thread:shared');
  f.latest().feeds = { 'thread:shared': { feedOffset: 0, following: true, seenLines: 0, columns: 60, rows: 8 } };
  f.close();
  f.advance(1000);
  f.add('second', 1);
  patchJob(f.files, 'second', { threadId: 'shared', activity: [{ seq: 1, type: 'agentMessage', body: 'Follow-up result' }] });
  f.add('other-worker', 2);
  await f.poll(true);
  const state = f.latest();
  expect(state.selectedId).toBe('thread:shared');
  expect(visibleSessions(state).length).toBe(2);
  expect(state.jobs.filter(job => job.threadId === 'shared').every(job => job.detailsLoaded && job.events.length === 1)).toBe(true);
  const feed = state.feeds?.['thread:shared'];
  expect(feed?.following).toBe(true);
  const lines = feedLines(selectedJob(state)!, state.nowMs, feed!.columns!);
  expect(feedWindow(lines, feed!.rows!, feed).lines.at(-1)?.spans.map(span => span.text).join('')).toContain('Follow-up result');
  expect(f.opens.length).toBe(1);
  expect(state.autoOpenedJobIds).toEqual(['second', 'other-worker']);
  expect(state.jobs.find(job => job.id === 'other-worker')?.detailsLoaded).toBe(false);
  expect(f.scrolls).toEqual([]);
});

test('a follow-up restores all turns of a cleared session after reload', async () => {
  const f = scrollFixture();
  for (const [n, id] of ['first', 'second'].entries()) {
    f.add(id, n - 2);
    patchJob(f.files, id, { threadId: 'shared', status: 'completed', completedAt: created(epoch) });
  }
  await f.poll(true);
  Object.assign(f.latest(), clearFinished(f.latest(), epoch));
  await f.poll(true); // Evict hidden turns and discard their raw/full cache.
  expect(visibleSessions(f.latest())).toEqual([]);
  const poll = f.reload();
  f.advance(1000);
  f.add('follow-up', 1);
  patchJob(f.files, 'follow-up', { threadId: 'shared' });
  await poll(true);
  expect(f.latest().selectedId).toBe('thread:shared');
  expect(visibleSessions(f.latest()).length).toBe(1);
  expect(selectedJob(f.latest())?.turns.map(job => job.id)).toEqual(['first', 'second', 'follow-up']);
  expect(f.latest().jobs.every(job => job.detailsLoaded && job.events[0]?.text === 'Working')).toBe(true);
  expect(f.latest().hiddenJobIds).toEqual(['second']);
  expect(f.opens.length).toBe(1);
});

test('thread discovery migrates selection and preserves a stopped content anchor', async () => {
  const f = scrollFixture();
  const body = Array.from({ length: 60 }, (_, n) => `Anchored line ${n}`).join('\n');
  f.add('selected', 1);
  patchJob(f.files, 'selected', { threadId: undefined,
    activity: [{ seq: 1, type: 'agentMessage', body }] });
  {
    f.add('earlier');
    patchJob(f.files, 'earlier', { threadId: 'shared', status: 'completed', completedAt: created(epoch) });
  }
  await f.poll(true);
  const before = selectedJob(f.latest())!;
  const lines = feedLines(before, epoch, 60);
  const stopped = { ...scrollFeed(lines, 8, undefined, -25, 16, lines.length), columns: 60, rows: 8, surface: 'anchor-test' };
  f.latest().feeds = { [before.id]: stopped };
  const firstLine = feedWindow(lines, 8, stopped).lines[0]?.spans.map(span => span.text).join('');
  patchJob(f.files, 'selected', { threadId: 'shared' });
  await f.poll(true);
  const feed = f.latest().feeds?.['thread:shared'];
  expect(f.latest().selectedId).toBe('thread:shared');
  expect(feed?.following).toBe(false);
  expect(feed?.anchor?.offset).toBe(stopped.anchor?.offset);
  expect(feed?.anchor?.source).toBe('job:selected:event-1-body');
  const afterLines = feedLines(selectedJob(f.latest())!, epoch, 60);
  expect(feedWindow(afterLines, 8, feed).lines[0]?.spans.map(span => span.text).join('')).toBe(firstLine);
  expect(f.scrolls).toEqual([]);
  expect(f.logs).toEqual([]);
});

test('polling hydrates every selected turn, strips other sessions, and adopts legacy job selection on reload', async () => {
  const f = scrollFixture();
  for (const [n, id] of ['a0', 'a1', 'b0', 'b1'].entries()) {
    f.add(id, n);
    patchJob(f.files, id, { threadId: id[0], status: 'completed', completedAt: created(epoch + n * 1000) });
  }
  await f.poll(true);
  expect(f.latest().selectedId).toBe('thread:b');
  expect(f.latest().jobs.filter(job => job.threadId === 'b').every(job => job.detailsLoaded && job.events.length === 1)).toBe(true);
  expect(f.latest().jobs.filter(job => job.threadId === 'a').every(job => !job.detailsLoaded && !job.events.length)).toBe(true);
  f.latest().selectedId = 'a0';
  f.latest().feeds = { a0: { feedOffset: 0, following: true, seenLines: 0 } };
  await f.reload()(true);
  expect(f.latest().selectedId).toBe('thread:a');
  expect(f.latest().feeds?.['thread:a']?.following).toBe(true);
  expect(f.latest().jobs.filter(job => job.threadId === 'a').every(job => job.detailsLoaded && job.events.length === 1)).toBe(true);
  expect(f.latest().jobs.filter(job => job.threadId === 'b').every(job => !job.detailsLoaded && !job.events.length)).toBe(true);
});

test('retention counts twenty sessions, protects active and selected sessions and restores evicted turns', async () => {
  const f = scrollFixture();
  const addTurn = (id: string, threadId: string, n: number, status = 'completed') => {
    f.add(id, n);
    patchJob(f.files, id, { threadId, status, completedAt: status === 'completed' ? created(epoch + n * 1000) : undefined });
  };
  addTurn('active-old', 'active', -100, 'running');
  addTurn('selected-0', 'selected', -99);
  addTurn('selected-1', 'selected', -98);
  await f.poll(true);
  f.latest().selectedId = 'thread:selected';
  for (let n = 0; n < 21; n++) {
    // An old turn still marked running must not protect a finished session.
    addTurn(`turn-${n}-0`, `session-${n}`, n * 2, n === 0 ? 'running' : 'completed');
    addTurn(`turn-${n}-1`, `session-${n}`, n * 2 + 1);
  }
  // Model the deliberately stale running turn as already observed.
  f.latest().seenJobIds!.push('turn-0-0');
  await f.poll(true);
  expect(visibleSessions(f.latest()).length).toBe(22);
  expect(f.latest().jobs.length).toBe(43);
  expect(f.latest().selectedId).toBe('thread:selected');
  expect(f.latest().jobs.some(job => job.threadId === 'session-0')).toBe(false);
  expect(f.latest().jobs.some(job => job.id === 'active-old')).toBe(true);
  expect(f.latest().jobs.filter(job => job.threadId === 'selected').every(job => job.detailsLoaded)).toBe(true);
  addTurn('follow-up', 'session-0', 50, 'running');
  await f.poll(true); // Still before the evicted marker retry deadline.
  expect(f.latest().selectedId).toBe('thread:selected');
  expect(visibleSessions(f.latest()).find(session => session.id === 'thread:session-0')?.turnCount).toBe(3);
  f.latest().selectedId = 'thread:session-0'; // Explicitly open the restored conversation.
  await f.poll(true);
  expect(f.latest().selectedId).toBe('thread:session-0');
  expect(selectedJob(f.latest())?.turns.map(job => job.id)).toEqual(['turn-0-0', 'turn-0-1', 'follow-up']);
  expect(selectedJob(f.latest())?.turns.every(job => job.detailsLoaded && job.events.length === 1)).toBe(true);
});

test('twenty long-summary conversations stay below budget and publish an active follow-up with its full turn count', async () => {
  const f = scrollFixture();
  const activity = Array.from({ length: 200 }, (_, seq) => ({ seq, type: 'agentMessage', body: 'x'.repeat(4000) }));
  for (let session = 0; session < 20; session++) for (let turn = 0; turn < 23; turn++) {
    const id = `s${session}-t${turn}`;
    f.add(id, session * 23 + turn - 500);
    const markerPath = `/home/duet/sessions/session-a/${id}.json`;
    const marker = f.files.get(markerPath)!;
    f.files.set(markerPath, { ...marker, text: JSON.stringify({ ...JSON.parse(marker.text), summary: 'S'.repeat(1000) }) });
    patchJob(f.files, id, { threadId: `session-${session}`, status: 'completed', completedAt: created(epoch),
      activity: session === 19 && turn >= 18 ? activity : [{ seq: 1, type: 'agentMessage', body: `Turn ${turn}` }] });
  }
  await f.poll(true);
  expect(f.logs).toEqual([]);
  expect(visibleSessions(f.latest()).length).toBe(20);
  expect(visibleSessions(f.latest()).every(session => session.turns.length <= 20 && session.turnCount === 23)).toBe(true);
  expect(f.latest().jobs.length < 400).toBe(true); // The global fallback thinned finished history too.
  expect(JSON.stringify(f.latest()).length < 900000).toBe(true);
  const reloaded = f.reload();
  await reloaded(true);
  expect(visibleSessions(f.latest()).every(session => session.turnCount === 23)).toBe(true);
  f.add('follow-up', 1);
  patchJob(f.files, 'follow-up', { threadId: 'session-0', activity });
  await reloaded(true);
  expect(f.latest().selectedId).toBe('thread:session-19');
  f.latest().selectedId = 'thread:session-0'; // Hydrate it only after explicit selection.
  await reloaded(true);
  const selected = selectedJob(f.latest())!;
  expect(f.logs).toEqual([]);
  expect(f.latest().selectedId).toBe('thread:session-0');
  expect(selected.turns.at(-1)?.id).toBe('follow-up');
  expect(selected.active).toBe(true);
  expect(selected.turnCount).toBe(24);
  expect(selected.turns.filter(job => job.detailsLoaded).length).toBe(5);
  expect(JSON.stringify(f.latest()).length < 900000).toBe(true);
  expect(f.opens.length).toBe(1);
  expect(f.latest().autoOpenedJobIds).toContain('follow-up');
});

test("unchanged large conversations reread no jobs and retain bounded details", async () => {
  const f = scrollFixture();
  const activity = Array.from({ length: 200 }, (_, seq) => ({ seq, type: 'agentMessage', body: 'x'.repeat(4000) }));
  for (let n = 0; n < 200; n++) {
    const id = `turn-${n}`;
    f.add(id, n - 200);
    patchJob(f.files, id, { threadId: 'shared', status: n === 199 ? 'running' : 'completed',
      completedAt: n === 199 ? undefined : created(epoch), activity: n >= 195 ? activity : [] });
  }
  await f.poll(true);
  f.latest().feeds = { 'thread:shared': { feedOffset: 0, following: true, seenLines: 0, columns: 60, rows: 8 } };
  f.reads.length = 0;
  f.advance(1000);
  await f.poll(true);
  expect(f.reads.filter(path => path.startsWith('/jobs/'))).toEqual([]);
  expect(f.latest().jobs.length).toBe(20);
  expect(selectedJob(f.latest())?.turnCount).toBe(200);
  expect(f.latest().jobs.filter(job => job.detailsLoaded).length).toBe(5);
  await f.poll(true); // No clock, file, or feed change at all.
  expect(f.reads.filter(path => path.startsWith('/jobs/'))).toEqual([]);
  expect(f.logs).toEqual([]);
});

test('a follow-up preserves the selected stopped transcript', async () => {
  const f = scrollFixture();
  const body = Array.from({ length: 60 }, (_, n) => `Anchored line ${n}`).join('\n');
  f.add('selected', 1);
  patchJob(f.files, 'selected', { threadId: 'shared',
    activity: [{ seq: 1, type: 'agentMessage', body }] });

  await f.poll(true);
  const before = selectedJob(f.latest())!;
  const lines = feedLines(before, epoch, 60);
  const stopped = { ...scrollFeed(lines, 8, undefined, -25, 16, lines.length), columns: 60, rows: 8, surface: 'anchor-test' };
  f.latest().feeds = { [before.id]: stopped };
  const firstLine = feedWindow(lines, 8, stopped).lines[0]?.spans.map(span => span.text).join('');
  {
    f.add('follow-up', 2);
    patchJob(f.files, 'follow-up', { threadId: 'shared' });
  }
  await f.poll(true);
  const feed = f.latest().feeds?.['thread:shared'];
  expect(f.latest().selectedId).toBe('thread:shared');
  expect(feed?.following).toBe(false);
  expect(feed?.anchor?.offset).toBe(stopped.anchor?.offset);
  expect(feed?.anchor?.source).toBe('job:selected:event-1-body');
  const afterLines = feedLines(selectedJob(f.latest())!, epoch, 60);
  expect(feedWindow(afterLines, 8, feed).lines[0]?.spans.map(span => span.text).join('')).toBe(firstLine);
  expect(f.scrolls).toEqual([]);
  expect(f.logs).toEqual([]);
});

test("unavailable evicted details recover without blocking a follow-up", async () => {
  const f = scrollFixture();
  f.add('earlier');
  patchJob(f.files, 'earlier', { threadId: 'shared', status: 'completed', completedAt: created(epoch) });
  await f.poll(true);
  Object.assign(f.latest(), clearFinished(f.latest(), epoch));
  await f.poll(true); // Discard the earlier turn's raw/full cache.
  f.unreadable.add('/jobs/earlier.json');
  f.add('follow-up', 1);
  patchJob(f.files, 'follow-up', { threadId: 'shared' });
  const reads = f.reads.filter(path => path === '/jobs/earlier.json').length;
  await f.poll(true);
  expect(f.reads.filter(path => path === '/jobs/earlier.json').length).toBe(reads + 1);
  expect(f.latest().selectedId).toBe('thread:shared');
  expect(f.latest().jobs.find(job => job.id === 'earlier')).toMatchObject({ detailsUnavailable: true, detailsLoaded: false });
  expect(f.opens.length).toBe(1);
  f.unreadable.clear();
  f.advance(5000);
  await f.poll(true);
  expect(f.reads.filter(path => path === '/jobs/earlier.json').length).toBe(reads + 2);
  expect(f.latest().jobs.find(job => job.id === 'earlier')).toMatchObject({ detailsUnavailable: false, detailsLoaded: true });
  expect(f.latest().jobs.find(job => job.id === 'earlier')?.events[0]?.text).toBe('Working');
  expect(f.logs).toEqual([]);
});

test('a poll publishes immediately while preserving a concurrent selection and history page', async () => {
const f = scrollFixture();
f.add('first'); f.add('other', 1);
await f.poll(true);
f.add('follow-up', 2);
let gets = 0;
f.onStateGet(() => {
  if (++gets !== 2) return; // Change selection after the original candidate exists.
  f.latest().selectedId = 'first';
  f.latest().historyPage = 2;
  f.latest().jobsExpanded = true;
});
  await f.poll(true);
  f.onStateGet(undefined);
  expect(f.latest().selectedId).toBe('first');
  expect(f.latest().historyPage).toBe(2);
  expect(f.latest().jobsExpanded).toBe(true);
  expect(f.latest().jobs.some(job => job.id === 'follow-up')).toBe(true);
  expect(f.opens.length).toBe(2);
  expect(f.statuses.at(-1)?.match(/(\d+) running/)?.[1]).toBe('3');
  await f.poll(true);
  expect(f.latest().selectedId).toBe('first');
  expect(f.latest().jobs.some(job => job.id === 'follow-up')).toBe(true);
  expect(f.opens.length).toBe(2);
});

test('scroll conflicts on six consecutive polls never starve a waiting follow-up or its question', async () => {
  const f = scrollFixture();
  const body = Array.from({ length: 80 }, (_, n) => `Existing turn line ${n}`).join('\n');
  f.add('earlier');
  patchJob(f.files, 'earlier', { threadId: 'shared', status: 'completed', completedAt: created(epoch),
    activity: [{ seq: 1, type: 'agentMessage', body }] });
  await f.poll(true);
  f.latest().feeds = { 'thread:shared': { feedOffset: 0, following: true, seenLines: 0,
    columns: 60, rows: 8, surface: 'conflict-test' } };
  f.add('follow-up', 1);
  for (let tick = 0; tick < 6; tick++) {
    const question = `Follow-up question ${tick}`;
    patchJob(f.files, 'follow-up', { threadId: 'shared', status: 'waiting', pendingQuestion: { text: question } });
    let gets = 0;
    let scrolled: NonNullable<CodexLiveState['feeds']>[string] | undefined;
    f.onStateGet(() => {
      if (++gets !== 2) return; // The update's read, after the first candidate was composed.
      const state = f.latest();
      const selected = selectedJob(state)!;
      scrolled = { ...scrollFeed(feedLines(selected, state.nowMs, 60), 8,
        state.feeds?.[selected.id], -2, 16, 1000), columns: 60, rows: 8, surface: 'conflict-test' };
      state.feeds = { ...state.feeds, [selected.id]: scrolled };
      state.historyPage = tick + 1;
      state.jobsExpanded = true;
    });
    f.advance(1000);
    await f.poll(true);
    f.onStateGet(undefined);
    expect(gets >= 2).toBe(true);
    expect(scrolled?.following).toBe(false);
    expect(f.latest().selectedId).toBe('thread:shared');
    expect(f.latest().feeds?.['thread:shared']?.following).toBe(false);
    expect(f.latest().feeds?.['thread:shared']?.anchor).toEqual(scrolled?.anchor);
    expect(f.latest().historyPage).toBe(tick + 1);
    expect(f.latest().jobsExpanded).toBe(true);
    expect(f.latest().jobs.find(job => job.id === 'follow-up')?.question?.text).toBe(question);
    expect(feedItems(selectedJob(f.latest())!, f.latest().nowMs).at(-1)?.results[0]?.text).toBe(question);
    expect(waitingCount(f.statuses.at(-1))).toBe(1);
    expect(f.opens.length).toBe(1);
    expect(f.latest().autoOpenedJobIds).toEqual(['follow-up']);
    expect(selectedJob(f.latest())?.turnCount).toBe(2);
    expect(f.logs).toEqual([]);
  }
  patchJob(f.files, 'follow-up', { status: 'completed', completedAt: created(epoch + 6000) });
  await f.poll(true);
  expect(f.statuses.at(-1)).toBe(undefined);
  expect(selectedJob(f.latest())?.finished).toBe(true);
});

test('the second state budget pass evicts history when a new feed snapshot crosses the ceiling', async () => {
  const f = scrollFixture();
  const activity = Array.from({ length: 200 }, (_, seq) => ({ seq, type: 'agentMessage', body: 'x'.repeat(4000) }));
  for (let session = 0; session < 20; session++) for (let turn = 0; turn < 20; turn++) {
    const id = `s${session}-t${turn}`;
    f.add(id, session * 20 + turn - 500);
    const markerPath = `/home/duet/sessions/session-a/${id}.json`;
    const marker = f.files.get(markerPath)!;
    f.files.set(markerPath, { ...marker, text: JSON.stringify({ ...JSON.parse(marker.text), summary: 'S'.repeat(1000) }) });
    patchJob(f.files, id, { threadId: `session-${session}`, status: 'completed', completedAt: created(epoch),
      activity: session === 19 && turn >= 15 ? activity : [] });
  }
  await f.poll(true);
  const selectedId = f.latest().selectedId!;
  const stopped = { feedOffset: 0, following: false, seenLines: 0, columns: 60, rows: 8, surface: 'snapshot-budget-test' };
  f.latest().feeds = { [selectedId]: stopped };
  const beforeLayout = boundState(f.latest());
  expect(JSON.stringify(beforeLayout).length < 900000).toBe(true);
  const selected = selectedJob(beforeLayout)!;
  const normalized = normalizeFeed(feedLines(selected, beforeLayout.nowMs, 60), 8, stopped);
  const afterLayout = { ...beforeLayout, feeds: { [selectedId]: normalized } };
  expect(Object.keys(normalized.seenItems ?? {}).length).toBe(400);
  expect(JSON.stringify(afterLayout).length >= 900000).toBe(true); // Only adding the snapshot caused overflow.
  const previousIds = new Set(beforeLayout.jobs.map(job => job.id));
  await f.poll(true);
  expect(f.logs).toEqual([]);
  expect(JSON.stringify(f.latest()).length < 900000).toBe(true);
  expect(f.latest().selectedId).toBe(selectedId);
  expect(selectedJob(f.latest())?.turns.map(job => job.id)).toEqual(selected.turns.map(job => job.id));
  expect(f.latest().feeds?.[selectedId]?.following).toBe(false);
  expect(Object.keys(f.latest().feeds?.[selectedId]?.seenItems ?? {}).length).toBe(400);
  expect(f.latest().jobs.length < previousIds.size).toBe(true);
  expect(f.latest().jobs.every(job => previousIds.has(job.id))).toBe(true);
});
