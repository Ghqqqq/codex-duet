import { test, expect, mock } from 'claude-code/testing';
import type { EngineInterface, On, PaneOpenArgs, UiScrollArgs } from 'claude-code';
import { boundState, clearFinished, visibleJobs, visibleSessions } from '../hooks/model';
import { feedItems, feedLines, feedWindow, jobRow, normalizeFeed, scrollFeed, selectedJob } from '../hooks/layout';
import { createPoller } from '../hooks/poll';
import type { CodexLiveState } from '../types';

const epoch = Date.parse('2026-10-18T00:00:00.000Z');
const start = { cwd: '/workspace', surface: 'terminal' as const, isInteractive: true };

function fixture(on: On, failure: () => string | undefined = () => undefined) {
  const clock = mock.clock(on, { now: epoch });
  mock.env(on, { HOME: '/user', CODEX_COMPANION_HOME: '/alias' });
  const files = new Map<string, { text: string; mtime: number }>();
  const reads: string[] = [];
  const stats: string[] = [];
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
    stats.push(e.path);
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
  return { clock, files, reads, stats, lists, opens, statuses, writes, add,
    close: () => { open = false; }, switchSession: () => { session = 'session-b'; },
    latest: () => writes[writes.length - 1],
  };
}

test('polling caches mtimes, refreshes elapsed, preserves closed panes and opens new jobs', async ($, on) => {
  const f = fixture(on);
  f.add('a');
  await $.session.start(start);
  await $.session.start(start); // Must not create a second interval.
  await f.clock.advance(1000);
  expect(f.lists).toEqual(['/canonical/duet/sessions/session-a']);
  expect(f.opens.length).toBe(1);
  expect(f.opens[0]?.focus).toBe(undefined);
  expect(f.latest()?.selectedId).toBe('a');
  expect(f.statuses).toEqual(['Codex · 1 running']);
  const initialWrites = f.writes.length;
  f.close();
  await f.clock.advance(2000);
  expect(f.writes.length).toBe(initialWrites);
  expect(f.reads.filter(path => path === '/jobs/a.json').length).toBe(1);
  expect(f.opens.length).toBe(1);
  await f.clock.advance(2000);
  expect(f.latest()?.nowMs).toBe(epoch + 5000);
  f.add('b', 'queued', 1);
  await f.clock.advance(1000);
  expect(f.opens.length).toBe(2);
  expect(f.latest()?.selectedId).toBe('b');
  expect(f.latest()?.jobs.map(job => job.id)).toEqual(['b', 'a']);
  expect(f.reads.filter(path => path.endsWith('/a.json')).length).toBe(2); // One marker, one job.
});

test('bad JSON and removed files preserve the last view; changed files recover and finish', async ($, on) => {
  const f = fixture(on);
  f.add('a');
  await $.session.start(start);
  await f.clock.advance(1000);
  f.files.set('/jobs/a.json', { mtime: 2, text: '{' });
  await f.clock.advance(1000);
  expect(f.latest()?.jobs[0]?.detailsUnavailable).toBe(true);
  expect(f.latest()?.jobs[0]?.events[0]?.text).toBe('Working');
  await f.clock.advance(1000);
  expect(f.reads.filter(path => path === '/jobs/a.json').length).toBe(2);
  f.files.delete('/jobs/a.json');
  await f.clock.advance(1000);
  expect(f.latest()?.jobs[0]?.detailsUnavailable).toBe(true);
  f.files.set('/jobs/a.json', { mtime: 3, text: JSON.stringify({ id: 'a', status: 'completed',
    completedAt: new Date(epoch + 5000).toISOString(), report: { status: 'completed', touchedFiles: [] },
  }) });
  await f.clock.advance(3000); // Retry five seconds after the failed read.
  expect(f.latest()?.jobs[0]?.detailsUnavailable).toBe(false);
  expect(f.latest()?.jobs[0]?.finished).toBe(true);
  expect(f.statuses[f.statuses.length - 1]).toBe(undefined);
  const statCount = f.stats.filter(path => path === '/jobs/a.json').length;
  await f.clock.advance(5000);
  expect(f.stats.filter(path => path === '/jobs/a.json').length).toBe(statCount);
});

test('idle polling backs off, bounds jobs and switches session directories', async ($, on) => {
  const f = fixture(on);
  await $.session.start(start);
  await f.clock.advance(5000);
  expect(f.lists.length).toBe(1);
  for (let n = 0; n < 25; n++) f.add(`job-${n}`, 'completed', n);
  await f.clock.advance(1000);
  expect(f.latest()?.jobs.length).toBe(20);
  expect(f.latest()?.jobs[0]?.id).toBe('job-24');
  expect(f.opens.length).toBe(0);
  f.switchSession();
  f.add('other', 'running');
  await f.clock.advance(5000);
  expect(f.latest()?.jobs.map(job => job.id)).toEqual(['other']);
  expect(f.lists[f.lists.length - 1]).toBe('/canonical/duet/sessions/session-b');
});

test('command asks to open and focus the pane and returns the required acknowledgement', async ($, on) => {
  const f = fixture(on);
  await $.session.start(start);
  const result = await $.command.run({ command: 'codex-live', args: '',
    origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 60 } });
  expect(result.text).toBe('Codex pane opened.');
  expect(f.opens[0]).toEqual({ id: 'codex-live', title: 'Codex', focus: true });
});

// The kit validates trees but does not paint a scrollable window. These unit
// tests use an entirely in-memory engine and assert no engine scrolls occur;
// the session/timer integration tests above continue to use the real kit.
function scrollFixture() {
  const files = new Map<string, { text: string; mtime: number }>();
  const markers: string[] = [];
  const scrolls: UiScrollArgs[] = [];
  const opens: PaneOpenArgs[] = [];
  const reads: string[] = [];
  const logs: string[] = [];
  const statuses: (string | undefined)[] = [];
  const unreadable = new Set<string>();
  let observeRead: ((path: string) => void) | undefined;
  let observeStateGet: (() => void) | undefined;
  let compositions = 0;
  const diagnostics = { onCompose: () => { compositions++; } };
  let open = false;
  let focused = false;
  let now = epoch;
  let state: CodexLiveState = { jobs: [], selectedId: null, nowMs: 0 };
  let version = 0;
  const engine = {
    ui: {
      panes: async () => open ? [{ id: 'codex-live', isFocused: focused }] : [],
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
        observeRead?.(path);
        if (unreadable.has(path)) throw new Error('Simulated unreadable job');
        return files.get(path)!.text;
      },
      stat: async (path: string) => ({ mtimeMs: files.get(path)?.mtime ?? 0, realPath: path }),
    },
    state: {
      get: async () => { observeStateGet?.(); return { value: state, version }; },
      set: async (_ref: unknown, value: CodexLiveState) => { state = value; return { isSet: true, version: ++version }; },
    },
  };
  const poll = createPoller(engine as unknown as EngineInterface, diagnostics);
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
  return { poll, add, files, scrolls, opens, reads, logs, statuses, unreadable, compositions: () => compositions,
    onRead: (observer?: (path: string) => void) => { observeRead = observer; },
    onStateGet: (observer?: () => void) => { observeStateGet = observer; },
    reload: () => createPoller(engine as unknown as EngineInterface, diagnostics), latest: () => state,
    focus: (value: boolean) => { focused = value; }, close: () => { open = false; },
    advance: (ms: number) => { now += ms; },
  };
}

test('poller never scrolls the engine on new items, focus changes or closed panes', async () => {
  const f = scrollFixture();
  f.add('a');
  await f.poll();
  expect(f.scrolls).toEqual([]);
  const revise = (seq: number) => f.files.set('/jobs/a.json', { mtime: seq, text: JSON.stringify({
    id: 'a', status: 'running', startedAt: new Date(epoch).toISOString(),
    activity: Array.from({ length: seq }, (_, index) => ({ seq: index + 1, type: 'agentMessage', text: `Message ${index}` })),
  }) });
  f.advance(5000); // The elapsed-time redraw alone must not scroll.
  await f.poll();
  expect(f.scrolls.length).toBe(0);
  revise(2);
  await f.poll();
  expect(f.scrolls.length).toBe(0);
  f.focus(true);
  revise(3);
  await f.poll();
  expect(f.scrolls.length).toBe(0);
  f.focus(false);
  await f.poll(); // Unfocusing alone does not jump to the bottom.
  expect(f.scrolls.length).toBe(0);
  revise(4);
  await f.poll();
  expect(f.scrolls.length).toBe(0);
  f.close();
  revise(5);
  await f.poll();
  expect(f.scrolls.length).toBe(0);
  expect(f.opens.length).toBe(1);
});

test('new activity in an unselected job does not scroll the selected feed', async () => {
  const f = scrollFixture();
  f.add('a');
  f.add('b', 1);
  await f.poll();
  expect(f.latest().selectedId).toBe('b');
  const before = f.scrolls.length;
  f.files.set('/jobs/a.json', { mtime: 2, text: JSON.stringify({ id: 'a', status: 'running', activity: [
    { seq: 1, type: 'agentMessage', text: 'Working' }, { seq: 2, type: 'agentMessage', text: 'More work' },
  ] }) });
  await f.poll();
  expect(f.scrolls.length).toBe(before);
});

test('poller retains newest activity after the display/event caps without engine scrolling', async () => {
  const f = scrollFixture();
  f.add('a');
  const revise = (last: number) => f.files.set('/jobs/a.json', { mtime: last, text: JSON.stringify({
    id: 'a', status: 'running', activity: Array.from({ length: 200 }, (_, index) => ({
      seq: last - 199 + index, type: 'agentMessage', text: `Message ${last - 199 + index}`,
    })),
  }) });
  revise(200);
  await f.poll();
  expect(f.latest().jobs[0]?.events.length).toBe(200);
  expect(f.scrolls.length).toBe(0);
  revise(201);
  await f.poll();
  expect(f.latest().jobs[0]?.events.length).toBe(200);
  expect(f.scrolls.length).toBe(0);
});

for (const placement of ['dock', 'inline'] as const) {
test(`mounted ${placement} pane keeps a resized stopped feed fixed through polling, counts three new lines, and jumps`, async ($, on) => {
  const f = fixture(on);
  let delegated = 0;
  on('ui.scroll', () => { delegated++; return {}; });
  f.add('a', 'running', 1);
  f.add('b', 'running');
  f.add('c', 'completed');
  f.add('d', 'failed');
  const revise = (lines: number, mtime: number) => f.files.set('/jobs/a.json', { mtime, text: JSON.stringify({
    id: 'a', status: 'running', startedAt: new Date(epoch).toISOString(),
    activity: [{ seq: 1, type: 'agentMessage', body: Array.from({ length: lines }, (_, i) => `Line ${i}`).join('\n') }],
  }) });
  revise(35, 1);
  await $.session.start(start);
  await f.clock.advance(1000);
  const props = { title: 'Codex', isFocused: true, bodyColumns: 56, placement,
    scroll: { offset: 0, bodyRows: 14 }, view: {} };
  const ui = await $.ui.mount({ plugin: 'codex-live', surface: 'terminal', component: 'Pane', requestId: 'codex-live', props });
  const scroll = (by: number) => $.ui.scroll({ component: 'Pane', requestId: 'codex-live', offset: 0,
    by, bodyRows: 14, contentRows: 15, origin: { kind: 'person' } });
  const bottom = (await ui.find({ key: 'transcript' }))?.text;
  const headers = await Promise.all(['a', 'b', 'c'].map(async key => (await ui.find({ key }))?.text));
  await scroll(-5);
  const stopped = (await ui.find({ key: 'transcript' }))?.text;
  const offset = f.latest()?.feeds?.a?.feedOffset;
  expect(stopped).not.toBe(bottom);
  expect((await ui.find({ key: 'jump-bottom' }))?.text).toBe('↓ Jump to bottom');
  await ui.redraw({ ...props, scroll: { offset: 0, bodyRows: 8 } });
  const shortStopped = (await ui.find({ key: 'transcript' }))?.text;
  const firstGlyph = (await ui.find({ key: 'live-status' }))?.text[0];
  revise(38, 2);
  await f.clock.advance(1000);
  expect((await ui.find({ key: 'transcript' }))?.text).toBe(shortStopped);
  expect(f.latest()?.feeds?.a?.feedOffset).toBe(offset);
  expect(f.latest()?.feeds?.a?.rows).toBe(2);
  expect((await ui.find({ key: 'jump-bottom' }))?.text).toBe('↓ 3 new · Jump to bottom');
  expect((await ui.find({ key: 'live-status' }))?.text[0]).not.toBe(firstGlyph);
  expect(await Promise.all(['a', 'b', 'c'].map(async key => (await ui.find({ key }))?.text))).toEqual(headers);
  await ui.redraw(props);
  expect((await ui.find({ key: 'transcript' }))?.text).toBe(stopped);
  expect((await ui.find({ key: 'jump-bottom' }))?.props.hotkey).toBe('b');
  await ui.press({ key: 'jump-bottom' });
  expect(f.latest()?.feeds?.a?.following).toBe(true);
  expect(await ui.find({ key: 'jump-bottom' })).toBe(undefined);
  expect((await ui.find({ key: 'transcript' }))?.text).toContain('Line 37');
  revise(39, 3);
  await f.clock.advance(1000);
  expect((await ui.find({ key: 'transcript' }))?.text).toContain('Line 38');
  expect(delegated).toBe(0);
  await ui.unmount();
});
}

test('spinner ticks only while active and open; finished footer is stable while another job runs', async ($, on) => {
  const f = fixture(on);
  f.add('a');
  await $.session.start(start);
  await f.clock.advance(1000);
  const first = f.latest()?.spinnerTick;
  await f.clock.advance(1000);
  expect(f.latest()?.spinnerTick).toBe(first! + 1);
  f.close();
  const closed = f.latest()?.spinnerTick;
  await f.clock.advance(5000);
  expect(f.latest()?.spinnerTick).toBe(closed);
  f.add('b', 'running', 1);
  await f.clock.advance(1000);
  f.files.set('/jobs/a.json', { mtime: 2, text: JSON.stringify({ id: 'a', status: 'completed',
    startedAt: new Date(epoch).toISOString(), completedAt: new Date(epoch + 8000).toISOString() }) });
  await f.clock.advance(1000);
  const ui = await $.ui.mount({ plugin: 'codex-live', surface: 'terminal', component: 'Pane', requestId: 'codex-live',
    props: { title: 'Codex', isFocused: true, bodyColumns: 56, placement: 'inline', scroll: { offset: 0, bodyRows: 14 }, view: {} } });
  await ui.press({ key: 'a' });
  const footer = (await ui.find({ key: 'live-status' }))?.text;
  const tick = f.latest()?.spinnerTick;
  await f.clock.advance(2000);
  expect(f.latest()?.spinnerTick).toBe(tick! + 2);
  expect((await ui.find({ key: 'live-status' }))?.text).toBe(footer);
  f.files.set('/jobs/b.json', { mtime: 2, text: JSON.stringify({ id: 'b', status: 'completed', completedAt: new Date(epoch).toISOString() }) });
  await f.clock.advance(1000);
  const finished = f.latest()?.spinnerTick;
  const writeCount = f.writes.length;
  await f.clock.advance(3000);
  expect(f.latest()?.spinnerTick).toBe(finished);
  expect(f.writes.length).toBe(writeCount);
  await ui.unmount();
});

const historyPane = { title: 'Codex', isFocused: true, bodyColumns: 56, placement: 'inline' as const,
  scroll: { offset: 0, bodyRows: 14 }, view: {} };

test('poll ticks age recent done/stopped jobs into history at two minutes without deleting jobs', async ($, on) => {
  const f = fixture(on);
  const entries = [
    ['running', 'running', undefined],
    ['recent-done', 'completed', epoch - 29000],
    ['recent-stopped', 'interrupted', epoch - 29000],
    ['old-done', 'completed', epoch - 599000],
    ['older-done', 'completed', epoch - 599000],
  ] as const;
  entries.forEach(([id, status, completed], i) => {
    f.add(id, status, -i);
    f.files.set(`/jobs/${id}.json`, { mtime: 1, text: JSON.stringify({ id, status,
      startedAt: new Date(epoch - 900000).toISOString(),
      completedAt: completed === undefined ? undefined : new Date(completed).toISOString(),
      activity: [{ seq: 1, type: 'agentMessage', text: `Feed for ${id}` }],
    }) });
  });
  await $.session.start(start);
  await f.clock.advance(1000); // Recent jobs ended exactly 30 seconds ago.
  const ui = await $.ui.mount({ plugin: 'codex-live', surface: 'terminal', component: 'Pane', requestId: 'codex-live', props: historyPane });
  const rows = async () => (await ui.findAll({ type: 'Button' })).map(button => button.key).filter(key => key !== 'clear-finished');
  expect(await rows()).toEqual(['running', 'recent-done', 'recent-stopped', 'toggle-jobs']);
  expect((await ui.find({ key: 'toggle-jobs' }))?.text).toBe('+2 more');
  const jobReads = f.reads.filter(path => path.startsWith('/jobs/')).length;
  const finishedStats = f.stats.filter(path => path.startsWith('/jobs/') && path !== '/jobs/running.json').length;
  await f.clock.advance(89000);
  expect((await ui.find({ key: 'toggle-jobs' }))?.text).toBe('+2 more');
  const displayClock = f.latest()?.nowMs;
  await f.clock.advance(1000); // Expire on a tick between five-second display updates.
  expect(f.latest()?.nowMs).toBe(displayClock);
  expect(await rows()).toEqual(['running', 'toggle-jobs']);
  expect((await ui.find({ key: 'toggle-jobs' }))?.text).toBe('+4 more');
  expect(f.latest()?.selectedId).toBe('running');
  expect((await ui.find({ key: 'transcript' }))?.text).toContain('Feed for running');
  expect(f.latest()?.jobs.length).toBe(5);
  expect(f.files.size).toBe(10);
  expect(f.opens.length).toBe(1);
  expect(f.reads.filter(path => path.startsWith('/jobs/')).length).toBe(jobReads);
  expect(f.stats.filter(path => path.startsWith('/jobs/') && path !== '/jobs/running.json').length).toBe(finishedStats + 36); // Four ended jobs, nine ten-second checks.
  await ui.press({ key: 'toggle-jobs' });
  expect((await ui.findAll({ type: 'Button' })).length).toBe(7);
  await ui.press({ key: 'old-done' });
  await ui.press({ key: 'toggle-jobs' });
  expect(await rows()).toEqual(['running', 'old-done', 'toggle-jobs']);
  expect((await ui.find({ key: 'transcript' }))?.text).toContain('Feed for old-done');
  expect(f.latest()?.selectedId).toBe('old-done');
  await ui.unmount();
});

test('missing end times persist their first observation and expire even with no active jobs', async ($, on) => {
  const f = fixture(on);
  f.add('selected', 'completed', 1);
  f.add('missing', 'cancelled');
  f.files.set('/jobs/selected.json', { mtime: 1, text: JSON.stringify({ id: 'selected', status: 'completed',
    completedAt: new Date(epoch - 600000).toISOString(), activity: [{ seq: 1, type: 'agentMessage', text: 'Selected history feed' }],
  }) });
  await $.session.start(start);
  await $.command.run({ command: 'codex-live', args: '', origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 56 } });
  await f.clock.advance(1000);
  const ui = await $.ui.mount({ plugin: 'codex-live', surface: 'terminal', component: 'Pane', requestId: 'codex-live', props: historyPane });
  expect(f.latest()?.selectedId).toBe('selected');
  expect(f.latest()?.recentEndedIds).toEqual(['missing']);
  expect(await ui.find({ key: 'missing' })).toBeDefined();
  expect(await ui.find({ key: 'toggle-jobs' })).toBe(undefined);
  const nowMs = f.latest()?.nowMs;
  const spinner = f.latest()?.spinnerTick;
  const source = f.files.get('/jobs/missing.json')?.text;
  await f.clock.advance(119000);
  expect(await ui.find({ key: 'missing' })).toBeDefined();
  await f.clock.advance(1000);
  expect(await ui.find({ key: 'missing' })).toBe(undefined);
  expect((await ui.find({ key: 'toggle-jobs' }))?.text).toBe('+1 more');
  expect(f.latest()?.recentEndedIds).toEqual([]);
  expect(f.latest()?.nowMs).toBe(nowMs);
  expect(f.latest()?.spinnerTick).toBe(spinner);
  expect(f.latest()?.jobs.find(job => job.id === 'missing')?.completedAt).toBe('');
  expect(f.latest()?.firstEndedAtMs?.missing).toBe(epoch + 1000);
  expect(f.files.get('/jobs/missing.json')?.text).toBe(source);
  expect(f.reads.filter(path => path === '/jobs/missing.json').length).toBe(1);
  expect(f.stats.filter(path => path === '/jobs/missing.json').length).toBe(13);
  expect((await ui.find({ key: 'transcript' }))?.text).toContain('Selected history feed');
  f.switchSession();
  f.add('missing', 'cancelled');
  await f.clock.advance(1000);
  expect(f.latest()?.recentEndedIds).toEqual(['missing']); // A new session has its own cache.
  await ui.unmount();
});

test('a main-agent stop starts the fallback window when first observed, not when the job started', async ($, on) => {
  const f = fixture(on);
  f.add('a', 'running');
  f.add('b', 'running', 1);
  await $.session.start(start);
  await f.clock.advance(181000);
  f.files.set('/jobs/a.json', { mtime: 2, text: JSON.stringify({ id: 'a', status: 'interrupted',
    interruptionReason: 'owner_stopped', startedAt: new Date(epoch).toISOString(),
    activity: [{ seq: 1, type: 'agentMessage', text: 'Stopped by main agent' }],
  }) });
  await f.clock.advance(1000);
  const ui = await $.ui.mount({ plugin: 'codex-live', surface: 'terminal', component: 'Pane', requestId: 'codex-live', props: historyPane });
  expect(f.latest()?.recentEndedIds).toEqual(['a']);
  expect((await ui.find({ key: 'a' }))?.text).toContain('■');
  await ui.press({ key: 'a' });
  const selectedView = f.latest()?.feeds?.a;
  await f.clock.advance(120000);
  expect(f.latest()?.recentEndedIds).toEqual([]);
  expect(f.latest()?.selectedId).toBe('a');
  expect(f.latest()?.feeds?.a).toEqual(selectedView);
  expect((await ui.find({ key: 'a' }))?.text).toContain('❯ ■');
  expect((await ui.find({ key: 'transcript' }))?.text).toContain('Stopped by main agent');
  await ui.press({ key: 'b' });
  expect(await ui.find({ key: 'a' })).toBe(undefined);
  expect((await ui.find({ key: 'toggle-jobs' }))?.text).toBe('+1 more');
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
  expect((await ui.find({ key: 'footer' }))?.text).toContain('Pane update failed');
  expect((await ui.find({ key: 'footer' }))?.text).toContain('simulated state capacity failure');
  expect((await ui.find({ key: 'live-status' }))?.children[0]).toMatchObject({ props: { color: 'error' } });
  expect(logs.some(log => log.to === 'debug' && log.text.includes('simulated state capacity failure'))).toBe(true);
  reject = false;
  await f.clock.advance(5000); // With no committed job/open request yet, idle retry cadence is five seconds.
  expect(f.latest()?.jobs[0]?.id).toBe('a');
  expect(f.opens.length).toBe(1);
  expect((await ui.find({ key: 'footer' }))?.text).not.toContain('Pane update failed');
  await ui.unmount();
});

test('D2: retention protects active and selected jobs and rediscovers evicted markers', async ($, on) => {
  const f = fixture(on);
  f.add('old-active', 'running', -10);
  f.add('old-selected', 'completed', -9);
  await $.session.start(start);
  await f.clock.advance(1000);
  const ui = await $.ui.mount({ plugin: 'codex-live', surface: 'terminal', component: 'Pane', requestId: 'codex-live', props: historyPane });
  await ui.press({ key: 'old-selected' });
  for (let n = 0; n < 21; n++) f.add(`new-${n}`, 'completed', n);
  await f.clock.advance(1000);
  expect(f.latest()?.jobs.length).toBe(22); // Newest 20 plus active and selected exceptions.
  expect(f.latest()?.jobs.some(job => job.id === 'old-active')).toBe(true);
  expect(f.latest()?.selectedId).toBe('old-selected');
  expect(f.latest()?.jobs.some(job => job.id === 'new-0')).toBe(false);
  f.files.set('/jobs/new-0.json', { mtime: 2, text: JSON.stringify({ id: 'new-0', status: 'running' }) });
  await f.clock.advance(10000);
  expect(f.latest()?.jobs.some(job => job.id === 'new-0' && job.active)).toBe(true);
  expect(f.reads.filter(path => path.endsWith('/sessions/session-a/new-0.json')).length).toBe(2);
  expect(f.latest()?.selectedId).toBe('old-selected');
  await ui.unmount();
});

test('D3: marker and job parse failures retry the same mtime only after five seconds', async ($, on) => {
  const f = fixture(on);
  f.add('a');
  const marker = '/canonical/duet/sessions/session-a/a.json';
  const good = f.files.get(marker)!;
  f.files.set(marker, { mtime: good.mtime, text: '{' });
  await $.session.start(start);
  await $.command.run({ command: 'codex-live', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 56 } });
  await f.clock.advance(1000);
  f.files.set(marker, good);
  await f.clock.advance(4000);
  expect(f.reads.filter(path => path === marker).length).toBe(1);
  await f.clock.advance(1000);
  expect(f.latest()?.jobs[0]?.id).toBe('a');
  f.files.set('/jobs/a.json', { mtime: 2, text: '{' });
  await f.clock.advance(1000);
  const attempts = f.reads.filter(path => path === '/jobs/a.json').length;
  f.files.set('/jobs/a.json', { mtime: 2, text: JSON.stringify({ id: 'a', status: 'completed', completedAt: created(epoch + 7000) }) });
  await f.clock.advance(4000);
  expect(f.reads.filter(path => path === '/jobs/a.json').length).toBe(attempts);
  await f.clock.advance(1000);
  expect(f.latest()?.jobs[0]?.status).toBe('completed');
  expect(f.latest()?.jobs[0]?.detailsUnavailable).toBe(false);
});
const created = (ms: number) => new Date(ms).toISOString();

test('D4: finished jobs stat at ten seconds and reconcile a rewritten terminal status', async ($, on) => {
  const f = fixture(on);
  f.add('a', 'failed');
  await $.session.start(start);
  await $.command.run({ command: 'codex-live', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 56 } });
  await f.clock.advance(1000);
  f.files.set('/jobs/a.json', { mtime: 2, text: JSON.stringify({ id: 'a', status: 'completed', completedAt: created(epoch) }) });
  await f.clock.advance(9000);
  expect(f.latest()?.jobs[0]?.status).toBe('failed');
  expect(f.stats.filter(path => path === '/jobs/a.json').length).toBe(1);
  await f.clock.advance(1000);
  expect(f.latest()?.jobs[0]?.status).toBe('completed');
  expect(f.stats.filter(path => path === '/jobs/a.json').length).toBe(2);
  await f.clock.advance(10000);
  expect(f.stats.filter(path => path === '/jobs/a.json').length).toBe(3);
  expect(f.reads.filter(path => path === '/jobs/a.json').length).toBe(2);
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

test('cleared jobs remain hidden through fresh poller reloads and new jobs appear', async () => {
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
  // This old job was never retained or added to hiddenJobIds before the reload.
  f.add('rediscovered', -7200);
  f.files.set('/jobs/rediscovered.json', { mtime: 1, text: JSON.stringify({
    id: 'rediscovered', status: 'blocked', completedAt: created(epoch - 3600000),
  }) });
  f.advance(2000);
  f.add('new', 2);
  await reloaded(true);
  expect(f.latest().selectedId).toBe('new');
  expect(visibleJobs(f.latest()).map(job => job.id)).toEqual(['new', 'active']);
  expect(f.latest().hiddenJobIds).toEqual(['done']);
  expect(f.latest().hiddenFinishedBefore).toBe(epoch);
});

test('Clear finished survives polling, leaves disk records intact and resets for another session', async ($, on) => {
  const f = fixture(on);
  f.add('done', 'completed');
  await $.session.start(start);
  await $.command.run({ command: 'codex-live', args: '', origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 56 } });
  await f.clock.advance(1000);
  const ui = await $.ui.mount({ plugin: 'codex-live', surface: 'terminal', component: 'Pane', requestId: 'codex-live', props: historyPane });
  const files = [...f.files.entries()];
  await ui.press({ key: 'clear-finished' });
  await f.clock.advance(10000);
  expect(f.latest()?.hiddenJobIds).toEqual(['done']);
  expect(f.latest()?.selectedId).toBe(null);
  expect([...f.files.entries()]).toEqual(files);
  expect((await ui.find({ key: 'transcript' }))?.text).toContain('Finished jobs are hidden.');
  f.add('new', 'running', 1);
  await f.clock.advance(1000);
  expect(f.latest()?.selectedId).toBe('new');
  expect((await ui.find({ key: 'job-header-body-0' }))?.text).toContain('Task new');
  expect(await ui.find({ key: 'toggle-jobs' })).toBe(undefined);
  f.switchSession();
  f.add('done', 'completed');
  await f.clock.advance(1000);
  expect(f.latest()?.hiddenJobIds).toBe(undefined);
  expect(f.latest()?.hiddenFinishedBefore).toBe(undefined);
  expect((await ui.find({ key: 'clear-finished' }))?.text).toBe('Clear finished');
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
  expect(f.latest()?.selectedId).toBe('new');
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

test('Clear finished hides all 25 finished jobs across repeated marker rediscovery', async ($, on) => {
  const f = fixture(on);
  for (let n = 0; n < 25; n++) {
    const id = `old-${n}`;
    const status = n === 0 ? 'blocked' : 'completed';
    f.add(id, status, n - 7200);
    if (n % 2 === 0) f.files.set(`/jobs/${id}.json`, { mtime: 1, text: JSON.stringify({
      id, status, completedAt: created(epoch - 3600000),
    }) });
  }
  await $.session.start(start);
  await $.command.run({ command: 'codex-live', args: '', origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 } });
  await f.clock.advance(8000); // The idle display clock is stale when Clear is pressed.
  expect(f.latest()?.jobs.length).toBe(20);
  expect(f.latest()?.jobs.some(job => job.id === 'old-0')).toBe(false);
  const jobReads = () => f.reads.filter(path => path.startsWith('/jobs/'));
  expect(jobReads().length).toBe(25);
  const firstEndedAtMs = { ...f.latest()?.firstEndedAtMs };
  const ui = await $.ui.mount({ plugin: 'codex-live', surface: 'terminal', component: 'Pane', requestId: 'codex-live',
    props: { ...historyPane, bodyColumns: 100 } });
  const files = [...f.files.entries()];
  await ui.press({ key: 'clear-finished' });
  for (let cycle = 0; cycle < 3; cycle++) {
    await f.clock.advance(10000);
    expect(visibleJobs(f.latest()!).map(job => job.id)).toEqual([]);
    expect(f.latest()?.selectedId).toBe(null);
    expect((await ui.find({ key: 'transcript' }))?.text).toContain('No Codex jobs in this session yet.');
    expect((await ui.find({ key: 'hidden-notice' }))?.text).toBe('Finished jobs are hidden. Their records stay for 30 days.');
    expect(await ui.find({ key: 'toggle-jobs' })).toBe(undefined);
    expect(await ui.find({ key: 'clear-finished' })).toBe(undefined);
  }
  expect(f.latest()?.hiddenFinishedBefore).toBe(epoch + 8000);
  expect(f.reads.filter(path => path === '/canonical/duet/sessions/session-a/old-0.json').length).toBe(4);
  expect([...f.files.entries()]).toEqual(files);
  expect(jobReads().slice(25).length).toBe(0);
  expect(f.latest()?.firstEndedAtMs).toEqual(firstEndedAtMs);
  const changed = '/jobs/old-0.json'; // Hidden by the watermark, outside hiddenJobIds.
  f.files.set(changed, { ...f.files.get(changed)!, mtime: 2 });
  await f.clock.advance(10000);
  expect(jobReads().slice(25)).toEqual([changed]);
  await f.clock.advance(10000);
  expect(jobReads().slice(25)).toEqual([changed]);
  expect(visibleJobs(f.latest()!).map(job => job.id)).toEqual([]);
  expect(f.latest()?.firstEndedAtMs).toEqual(firstEndedAtMs);
  await ui.unmount();
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
  expect(f.stats.filter(path => path === '/jobs/old-0.json').length).toBe(4);
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

function patchJob(files: Map<string, { text: string; mtime: number }>, id: string, fields: Record<string, unknown>) {
  const file = files.get(`/jobs/${id}.json`)!;
  files.set(`/jobs/${id}.json`, { mtime: file.mtime + 1, text: JSON.stringify({ ...JSON.parse(file.text), ...fields }) });
}

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
  await f.poll(true);
  const state = f.latest();
  expect(state.selectedId).toBe('thread:shared');
  expect(visibleSessions(state).length).toBe(1);
  expect(state.jobs.every(job => job.detailsLoaded && job.events.length === 1)).toBe(true);
  const feed = state.feeds?.['thread:shared'];
  expect(feed?.following).toBe(true);
  const lines = feedLines(selectedJob(state)!, state.nowMs, feed!.columns!);
  expect(feedWindow(lines, feed!.rows!, feed).lines.at(-1)?.spans.map(span => span.text).join('')).toContain('Follow-up result');
  expect(f.opens.length).toBe(1);
  expect(state.autoOpenedJobIds).toEqual(['second']);
  expect(f.scrolls).toEqual([]);
});

for (const reload of [false, true]) {
  test(`a follow-up restores all turns of a cleared session ${reload ? 'after reload' : 'before evicted marker retry'}`, async () => {
    const f = scrollFixture();
    for (const [n, id] of ['first', 'second'].entries()) {
      f.add(id, n - 2);
      patchJob(f.files, id, { threadId: 'shared', status: 'completed', completedAt: created(epoch) });
    }
    await f.poll(true);
    Object.assign(f.latest(), clearFinished(f.latest(), epoch));
    await f.poll(true); // Evict hidden turns and discard their raw/full cache.
    expect(visibleSessions(f.latest())).toEqual([]);
    const poll = reload ? f.reload() : f.poll;
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
}

test('polling keeps unthreaded jobs separate then migrates selection and feed when a thread appears', async () => {
  const f = scrollFixture();
  f.add('first'); f.add('second', 1); f.add('unthreaded', 2);
  patchJob(f.files, 'first', { threadId: 'shared' });
  patchJob(f.files, 'second', { threadId: '' });
  patchJob(f.files, 'unthreaded', { threadId: '   ' });
  await f.poll(true);
  expect(visibleSessions(f.latest()).length).toBe(3);
  f.latest().selectedId = 'second';
  f.latest().feeds = {
    'thread:shared': { feedOffset: 0, following: false, seenLines: 0 },
    second: { feedOffset: 0, following: true, seenLines: 0, columns: 60, rows: 8 },
  };
  patchJob(f.files, 'second', { threadId: 'shared' });
  await f.poll(true);
  expect(visibleSessions(f.latest()).map(session => session.id)).toEqual(['unthreaded', 'thread:shared']);
  expect(f.latest().selectedId).toBe('thread:shared');
  expect(f.latest().feeds?.['thread:shared']?.following).toBe(true);
  expect(f.latest().feeds?.second).toBe(undefined);
  expect(selectedJob(f.latest())?.turns.map(job => job.id)).toEqual(['first', 'second']);
  expect(f.latest().jobs.filter(job => job.threadId === 'shared').every(job => job.detailsLoaded)).toBe(true);
  expect(f.opens.length).toBe(1); // Discovering an existing job's thread is not a new job.
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
  // Seed seen IDs to keep the deliberately stale running turn from auto-selecting.
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
  expect(f.latest().selectedId).toBe('thread:session-0');
  expect(selectedJob(f.latest())?.turns.map(job => job.id)).toEqual(['turn-0-0', 'turn-0-1', 'follow-up']);
  expect(selectedJob(f.latest())?.turns.every(job => job.detailsLoaded && job.events.length === 1)).toBe(true);
});

test('poll status and recent-end eligibility use the latest turn of each session', async ($, on) => {
  const f = fixture(on);
  f.add('old', 'running'); f.add('latest', 'waiting', 1);
  patchJob(f.files, 'old', { threadId: 'shared', agentName: 'Euclid' });
  patchJob(f.files, 'latest', { threadId: 'shared', agentName: 'Euclid', pendingQuestion: { text: 'Continue?' } });
  await $.session.start(start);
  await f.clock.advance(1000);
  expect(f.statuses).toEqual(['Euclid · 1 waiting for answer']);
  expect(f.latest()?.selectedId).toBe('thread:shared');
  patchJob(f.files, 'latest', { status: 'completed', completedAt: created(epoch + 1000) });
  await f.clock.advance(1000);
  expect(f.statuses.at(-1)).toBe(undefined);
  expect(f.latest()?.recentEndedIds).toEqual(['thread:shared']);
  const ui = await $.ui.mount({ plugin: 'codex-live', surface: 'terminal', component: 'Pane', requestId: 'codex-live', props: historyPane });
  await ui.press({ key: 'clear-finished' });
  expect(visibleSessions(f.latest()!)).toEqual([]);
  expect(f.latest()?.selectedId).toBe(null);
  await ui.unmount();
});

test('a selected session receiving a follow-up keeps focus when another worker starts in the same poll', async () => {
  const f = scrollFixture();
  f.add('first');
  patchJob(f.files, 'first', { threadId: 'shared', status: 'completed', completedAt: created(epoch) });
  await f.poll(true);
  f.latest().feeds = { 'thread:shared': { feedOffset: 0, following: true, seenLines: 0, columns: 60, rows: 8 } };
  f.add('follow-up', 1);
  patchJob(f.files, 'follow-up', { threadId: 'shared' });
  f.add('other-worker', 2);
  await f.poll(true);
  expect(f.latest().selectedId).toBe('thread:shared');
  expect(f.latest().feeds?.['thread:shared']?.following).toBe(true);
  expect(f.latest().jobs.find(job => job.id === 'other-worker')?.detailsLoaded).toBe(false);
  expect(f.latest().autoOpenedJobIds?.length).toBe(2);
  expect(f.opens.length).toBe(1);
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
  const selected = selectedJob(f.latest())!;
  expect(f.logs).toEqual([]);
  expect(f.latest().selectedId).toBe('thread:session-0');
  expect(selected.turns.at(-1)?.id).toBe('follow-up');
  expect(selected.active).toBe(true);
  expect(selected.turnCount).toBe(24);
  expect(jobRow(selected, true, 100, epoch).meta).toContain('24 turns');
  expect(selected.turns.filter(job => job.detailsLoaded).length).toBe(5);
  expect(JSON.stringify(f.latest()).length < 900000).toBe(true);
  expect(f.opens.length).toBe(1);
  expect(f.latest().autoOpenedJobIds).toContain('follow-up');
});

test('an unchanged 200-turn poll composes once, including spinner writes, and reads no job files', async () => {
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
  let before = f.compositions();
  f.reads.length = 0;
  const spinner = f.latest().spinnerTick;
  f.advance(1000);
  await f.poll(true);
  expect(f.compositions() - before).toBe(1);
  expect(f.reads.filter(path => path.startsWith('/jobs/'))).toEqual([]);
  expect(f.latest().spinnerTick).not.toBe(spinner);
  expect(f.latest().jobs.length).toBe(20);
  expect(selectedJob(f.latest())?.turnCount).toBe(200);
  expect(f.latest().jobs.filter(job => job.detailsLoaded).length).toBe(5);
  before = f.compositions();
  await f.poll(true); // No clock, file, or feed change at all.
  expect(f.compositions() - before).toBe(1);
  expect(f.reads.filter(path => path.startsWith('/jobs/'))).toEqual([]);
  expect(f.logs).toEqual([]);
});

for (const arrival of ['follow-up', 'merge']) {
  test(`polling preserves a stopped content anchor when a ${arrival} joins the selected conversation`, async () => {
    const f = scrollFixture();
    const body = Array.from({ length: 60 }, (_, n) => `Anchored line ${n}`).join('\n');
    f.add('selected', 1);
    patchJob(f.files, 'selected', { threadId: arrival === 'follow-up' ? 'shared' : undefined,
      activity: [{ seq: 1, type: 'agentMessage', body }] });
    if (arrival === 'merge') {
      f.add('earlier');
      patchJob(f.files, 'earlier', { threadId: 'shared', status: 'completed', completedAt: created(epoch) });
    }
    await f.poll(true);
    const before = selectedJob(f.latest())!;
    const lines = feedLines(before, epoch, 60);
    const stopped = { ...scrollFeed(lines, 8, undefined, -25, 16, lines.length), columns: 60, rows: 8, surface: 'anchor-test' };
    f.latest().feeds = { [before.id]: stopped };
    const firstLine = feedWindow(lines, 8, stopped).lines[0]?.spans.map(span => span.text).join('');
    if (arrival === 'follow-up') {
      f.add('follow-up', 2);
      patchJob(f.files, 'follow-up', { threadId: 'shared' });
    } else patchJob(f.files, 'selected', { threadId: 'shared' });
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
}

test('failed hydration of an evicted turn publishes unavailable details and recovers after five seconds', async () => {
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
  expect(feedItems(selectedJob(f.latest())!, epoch).find(item => item.key === 'job-header:earlier')?.results.at(-1)?.text)
    .toContain('Details unavailable');
  expect(f.opens.length).toBe(1);
  f.unreadable.clear();
  f.advance(4000);
  await f.poll(true);
  expect(f.reads.filter(path => path === '/jobs/earlier.json').length).toBe(reads + 1);
  expect(f.latest().jobs.find(job => job.id === 'earlier')?.detailsUnavailable).toBe(true);
  f.advance(1000);
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
  const count = f.compositions();
  await f.poll(true);
  f.onStateGet(undefined);
  expect(f.compositions() - count).toBe(2);
  expect(f.latest().selectedId).toBe('first');
  expect(f.latest().historyPage).toBe(2);
  expect(f.latest().jobsExpanded).toBe(true);
  expect(f.latest().jobs.some(job => job.id === 'follow-up')).toBe(true);
  expect(f.opens.length).toBe(2);
  expect(f.statuses.at(-1)).toBe('Codex · 3 running');
  await f.poll(true);
  expect(f.compositions() - count).toBe(3);
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
    const compositions = f.compositions();
    f.advance(1000);
    await f.poll(true);
    f.onStateGet(undefined);
    expect(gets >= 2).toBe(true);
    expect(f.compositions() - compositions).toBe(2);
    expect(scrolled?.following).toBe(false);
    expect(f.latest().selectedId).toBe('thread:shared');
    expect(f.latest().feeds?.['thread:shared']?.following).toBe(false);
    expect(f.latest().feeds?.['thread:shared']?.anchor).toEqual(scrolled?.anchor);
    expect(f.latest().historyPage).toBe(tick + 1);
    expect(f.latest().jobsExpanded).toBe(true);
    expect(f.latest().jobs.find(job => job.id === 'follow-up')?.question?.text).toBe(question);
    expect(feedItems(selectedJob(f.latest())!, f.latest().nowMs).at(-1)?.results[0]?.text).toBe(question);
    expect(f.statuses.at(-1)).toBe('Codex · 1 waiting for answer');
    expect(f.opens.length).toBe(1);
    expect(f.latest().autoOpenedJobIds).toEqual(['follow-up']);
    expect(selectedJob(f.latest())?.turnCount).toBe(2);
    expect(f.logs).toEqual([]);
  }
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
