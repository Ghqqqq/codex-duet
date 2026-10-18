import { test, expect, mock } from 'claude-code/testing';
import type { EngineInterface, On, PaneOpenArgs, UiScrollArgs } from 'claude-code';
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
  let open = false;
  let focused = false;
  let now = epoch;
  let state: CodexLiveState = { jobs: [], selectedId: null, nowMs: 0 };
  let version = 0;
  const engine = {
    ui: {
      panes: async () => open ? [{ id: 'codex-live', isFocused: focused }] : [],
      open: async (args: PaneOpenArgs) => { opens.push(args); open = true; return { isPlaced: true }; },
      status: () => {},
      scroll: async (args: UiScrollArgs) => { scrolls.push(args); return {}; },
    },
    session: { id: async () => 'session-a' },
    env: { get: async () => '/home' },
    clock: { now: async () => now },
    fs: {
      exists: async () => true,
      list: async () => markers.map(name => ({ name, kind: 'file' })),
      read: async (path: string) => files.get(path)!.text,
      stat: async (path: string) => ({ mtimeMs: files.get(path)?.mtime ?? 0, realPath: path }),
    },
    state: {
      get: async () => ({ value: state, version }),
      set: async (_ref: unknown, value: CodexLiveState) => { state = value; return { isSet: true, version: ++version }; },
    },
  };
  const poll = createPoller(engine as unknown as EngineInterface);
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
  return { poll, add, files, scrolls, opens, reload: () => createPoller(engine as unknown as EngineInterface), latest: () => state,
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

test('mounted pane keeps a stopped feed fixed through polling, counts three new lines, and jumps', async ($, on) => {
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
  const props = { title: 'Codex', isFocused: true, bodyColumns: 56, placement: 'inline' as const,
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
  const firstGlyph = (await ui.find({ key: 'live-status' }))?.text[0];
  revise(38, 2);
  await f.clock.advance(1000);
  expect((await ui.find({ key: 'transcript' }))?.text).toBe(stopped);
  expect(f.latest()?.feeds?.a?.feedOffset).toBe(offset);
  expect((await ui.find({ key: 'jump-bottom' }))?.text).toBe('↓ 3 new · Jump to bottom');
  expect((await ui.find({ key: 'live-status' }))?.text[0]).not.toBe(firstGlyph);
  expect(await Promise.all(['a', 'b', 'c'].map(async key => (await ui.find({ key }))?.text))).toEqual(headers);
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
  const rows = async () => (await ui.findAll({ type: 'Button' })).map(button => button.key);
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
  expect((await ui.findAll({ type: 'Button' })).length).toBe(6);
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
    props: { ...historyPane, bodyColumns: 120 } });
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
