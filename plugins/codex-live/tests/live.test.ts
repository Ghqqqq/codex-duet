import { test, expect } from 'claude-code/testing';
import type { On } from 'claude-code';
import type { FoundElement } from 'claude-code/testing';
import type { CodexLiveEvent, CodexLiveMarker, CodexLiveState } from '../types';
import { boundState, clearFinished, groupedSessions, isHiddenJob, normalizeSessions, visibleJobs, visibleSessions, taskText, collapseActivity, elapsed, glyph, jobView, markerView, statusLine } from '../hooks/model';
import { activityItems, eventItem, feedItems, fileResult, fit, headerItem, jobRow, jobState,
  relativePath, toolResult, toolUseCount, unwrapCommand, width, wrap, feedLines, feedWindow,
  footerLayout, headerLayout, inlineSpans, messageLines, recentEndedJobIds, reconcileFeed, scrollFeed, selectedJob } from '../hooks/layout';

const createdAt = '2026-10-18T00:00:00.000Z';
const epoch = Date.parse(createdAt);
const marker = (id = 'job-a'): CodexLiveMarker => ({ jobId: id, jobFile: `/jobs/${id}.json`,
  title: 'Codex Task', summary: `Task ${id}`, createdAt, workspaceRoot: '/workspace' });
const running = () => jobView({ id: 'job-a', status: 'running', startedAt: createdAt, sandbox: 'read-only',
  request: { model: 'gpt-6-astra', effort: 'xhigh', serviceTier: 'priority' },
  activity: [{ seq: 1, type: 'agentMessage', text: 'Inspecting the code' },
    { seq: 2, at: createdAt, type: 'commandExecution', command: 'npm test', lifecycle: 'started' }],
  result: 'must not enter state', rendered: 'must not enter state',
}, marker());

function richJob() {
  return jobView({ id: 'job-a', status: 'running', startedAt: createdAt, sandbox: 'read-only',
    request: { model: 'gpt-6-astra', effort: 'xhigh', serviceTier: 'priority' },
    pendingQuestion: { text: 'Which approach?', options: ['Check leases', { label: 'Run tests' }] },
    activity: [
      { seq: 1, type: 'plan', steps: ['Old plan'] },
      { seq: 2, type: 'agentMessage', text: 'Short fallback', body: "I'll inspect the lease paths first.\n\nThen run the tests." },
      { seq: 3, at: createdAt, type: 'commandExecution', command: "/bin/zsh -lc 'node --test tests/worker-lifecycle.test.mjs'", lifecycle: 'started' },
      { seq: 4, type: 'commandExecution', command: "/bin/zsh -lc 'git status --short'", lifecycle: 'started' },
      { seq: 5, type: 'commandExecution', command: "/bin/zsh -lc 'git status --short'", lifecycle: 'completed', exitCode: 0, durationMs: 400 },
      { seq: 6, type: 'commandExecution', command: '/bin/bash -c "npm test"', lifecycle: 'completed', exitCode: 1, durationMs: 1200 },
      { seq: 7, type: 'fileChange', kind: 'update', path: '/workspace/plugins/codex/scripts/lib/job-runtime.mjs', added: 3, removed: 1 },
      { seq: 8, type: 'mcpToolCall', server: 'server', tool: 'tool', lifecycle: 'started' },
      { seq: 9, type: 'mcpToolCall', server: 'server', tool: 'tool', lifecycle: 'completed', durationMs: 1200 },
      { seq: 10, type: 'dynamicToolCall', tool: 'lookup', lifecycle: 'completed', durationMs: 20 },
      { seq: 11, type: 'plan', steps: ['Read waitForJob', 'Check lease gaps', 'Write the verdict'], statuses: ['completed', 'inProgress', 'pending'] },
    ],
  }, marker());
}

test('running view selects display fields and retains optional transcript data', () => {
  const job = running();
  expect(job.active).toBe(true);
  expect(job.finished).toBe(false);
  expect(job.label).toBe('Task job-a');
  expect(job.model).toBe('gpt-6-astra');
  expect(job.effort).toBe('xhigh');
  expect(job.fast).toBe(true);
  expect(job.sandbox).toBe('read-only');
  expect(job.events.length).toBe(2);
  expect(job.events[1]?.at).toBe(createdAt);
  expect(JSON.stringify(job)).not.toContain('must not enter state');
  expect(elapsed(job, epoch + 65000)).toBe('1m 5s');
  const rich = richJob();
  expect(rich.events.find(event => event.type === 'agentMessage')?.body).toContain('\n\n');
  expect(rich.events.find(event => event.type === 'fileChange')).toMatchObject({ added: 3, removed: 1 });
  expect(rich.events.at(-1)?.statuses).toEqual(['completed', 'inProgress', 'pending']);
});

test('marker validation stays compatible and workspace paths are display-only', () => {
  const raw = { v: 1, jobId: 'a', jobFile: '/jobs/a.json' };
  expect(markerView(raw).name).toBe(undefined);
  expect(jobView({ id: 'a', status: 'completed' }, markerView(raw)).agentName).toBe(undefined);
  expect(markerView(raw).workspaceRoot).toBe(undefined);
  expect(markerView({ ...raw, workspaceRoot: 'relative' }).workspaceRoot).toBe(undefined);
  expect(markerView({ ...raw, workspaceRoot: '/workspace' }).workspaceRoot).toBe('/workspace');
  expect(relativePath('/workspace/src/a.ts', '/workspace/')).toBe('src/a.ts');
  expect(relativePath('/workspace-other/a.ts', '/workspace')).toBe('/workspace-other/a.ts');
  expect(relativePath('/workspace/../outside/a.ts', '/workspace')).toBe('/workspace/../outside/a.ts');
  expect(relativePath('/workspace/src/a.ts')).toBe('/workspace/src/a.ts');
  expect(relativePath('src/a.ts', '/workspace')).toBe('src/a.ts');
});

test('names and first-sentence task labels strip dispatch prefixes in rows, header, footer and status', () => {
  const summary = "Undo's ownership-marker save is fixed. Verify the rest.";
  for (const prefix of ['OBJECTIVE: ', 'FOLLOW-UP on task-123: ', 'REWORK task-123: ', 'REWORK: OBJECTIVE: ']) {
    const m = markerView({ ...marker(), v: 1, name: 'Hopper', summary: prefix + summary });
    const job = jobView({ id: m.jobId, status: 'running' }, m);
    expect(job.agentName).toBe('Hopper');
    expect(job.label).toBe("Undo's ownership-marker save is fixed.");
    expect(headerItem(job, epoch)).toMatchObject({ title: "Hopper(Undo's ownership-marker save is fixed.)", bold: 'Hopper' });
    const row = jobRow(job, true, 90, epoch);
    expect(row.label).toBe('Hopper');
    expect(row.summary).toContain("Undo's ownership-marker save is fixed.");
    const state = { jobs: [job], selectedId: job.id, nowMs: epoch };
    expect(footerLayout(job, state, 100, true, 0).left).toContain('Hopper');
    expect(statusLine([job])).toBe('Hopper · 1 running');
    expect(JSON.stringify(feedLines(job, epoch, 90))).not.toContain('OBJECTIVE:');
    const legacy = jobView({ id: m.jobId, status: 'running' }, { ...m, name: undefined });
    expect(headerItem(legacy, epoch).title).toBe(job.label);
    expect(jobRow(legacy, false, 90, epoch).label).toBe(job.label);
    expect(jobView({ id: m.jobId, status: 'running', agentName: 'Ada' }, m).agentName).toBe('Ada');
    for (const columns of [0, 1, 4, 12, 25, 40, 56]) {
      const narrow = jobRow(job, true, columns, epoch);
      expect(width(Object.values(narrow).join('')) <= columns).toBe(true);
    }
  }
  expect(taskText('OBJECTIVE: Fix version 1.2 and file.js. Then test.')).toBe('Fix version 1.2 and file.js.');
});

test('clearing includes all terminal states, keeps active jobs and chooses the newest visible fallback', () => {
  const jobs = ['completed', 'failed', 'cancelled', 'interrupted', 'stopped', 'blocked', 'needs_input', 'running', 'queued', 'waiting']
    .map((status, i) => jobView({ id: status, status }, { ...marker(status), createdAt: new Date(epoch + (i - 10) * 1000).toISOString() }));
  const state = { jobs, selectedId: 'failed', nowMs: epoch };
  const cleared = clearFinished(state, epoch);
  expect(cleared.hiddenJobIds).toEqual(jobs.slice(0, 7).map(job => job.id));
  expect(visibleJobs(cleared).map(job => job.id)).toEqual(['running', 'queued', 'waiting']);
  expect(cleared.selectedId).toBe('waiting');
  expect(cleared.jobs).toEqual(jobs);
  expect(state).not.toHaveProperty('hiddenJobIds');
  const unknown = jobView({ id: 'unknown', status: 'unknown' }, marker('unknown'));
  expect(clearFinished({ ...state, jobs: [jobs[0]!, unknown], selectedId: 'completed' }, epoch).selectedId).toBe('unknown');
});

test('hidden jobs use completion, first observed end, then creation time and honor legacy IDs', () => {
  const jobs = [
    ['boundary', 'completed', epoch, epoch + 1000],
    ['later-completion', 'completed', epoch + 1, epoch - 1000],
    ['observed-before', 'blocked', undefined, epoch - 1],
    ['observed-after', 'interrupted', undefined, epoch + 1],
    ['creation-only', 'stopped', undefined, undefined],
    ['running', 'running', undefined, undefined],
    ['queued', 'queued', undefined, undefined],
    ['waiting', 'waiting', undefined, undefined],
    ['legacy', 'completed', epoch + 1000, undefined],
  ] as const;
  const state: CodexLiveState = {
    jobs: jobs.map(([id, status, end]) => jobView({ id, status,
      completedAt: end === undefined ? 'invalid' : new Date(end).toISOString(),
    }, { ...marker(id), createdAt: new Date(epoch - 5000).toISOString() })),
    selectedId: 'boundary', nowMs: 0, hiddenFinishedBefore: epoch, hiddenJobIds: ['legacy'],
    firstEndedAtMs: Object.fromEntries(jobs.filter(([, , , end]) => end !== undefined).map(([id, , , end]) => [id, end!])),
  };
  expect(state.jobs.filter(job => isHiddenJob(state, job)).map(job => job.id))
    .toEqual(['boundary', 'observed-before', 'creation-only', 'legacy']);
  expect(visibleJobs(state).map(job => job.id)).toEqual(['later-completion', 'observed-after', 'running', 'queued', 'waiting']);
  expect(selectedJob(state)?.id).toBe('waiting');
  const clearedAgain = clearFinished(state, epoch + 2000);
  expect(clearedAgain.hiddenFinishedBefore).toBe(epoch + 2000);
  expect(clearedAgain.hiddenJobIds).toEqual(['legacy', 'later-completion', 'observed-after']);
  expect(visibleJobs(clearedAgain).map(job => job.id)).toEqual(['running', 'queued', 'waiting']);
  expect(clearFinished(clearedAgain, epoch).hiddenFinishedBefore).toBe(epoch + 2000);
});

test('clearing against newer state preserves jobs that ended after the click timestamp', () => {
  const jobs = ['before', 'after', 'observed-after', 'new'].map(id => jobView({ id, status: 'completed',
    completedAt: id === 'observed-after' ? undefined : new Date(epoch + (id === 'before' ? -1 : 2)).toISOString(),
  }, { ...marker(id), createdAt: new Date(epoch + (id === 'new' ? 1 : -5000)).toISOString() }));
  const cleared = clearFinished({ jobs, selectedId: 'before', nowMs: epoch + 5000,
    firstEndedAtMs: { 'observed-after': epoch + 2 },
  }, epoch);
  expect(cleared.hiddenJobIds).toEqual(['before']);
  expect(visibleJobs(cleared).map(job => job.id)).toEqual(['after', 'observed-after', 'new']);
  expect(cleared.selectedId).toBe('new');
});

test('unanswered question is active even outside running status and appears last', () => {
  const fixture = { id: 'job-a', status: 'waiting', pendingQuestion: {
    id: 'q1', kind: 'choice', text: 'Which approach?', options: ['A', { label: 'B' }],
  } };
  const job = jobView(fixture, marker());
  expect(job.active).toBe(true);
  expect(glyph(job)).toBe('?');
  expect(job.question).toEqual({ text: 'Which approach?', options: ['A', 'B'] });
  expect(statusLine([job])).toBe('Codex · 1 waiting for answer');
  expect(statusLine([job, running()])).toBe('Codex · 1 running · 1 waiting for answer');
  expect(feedItems(job, epoch).at(-1)).toMatchObject({ title: 'Waiting for Claude', color: 'warning',
    results: [{ text: 'Which approach?' }, { text: '1. A' }, { text: '2. B' }] });
  expect(jobView({ ...fixture, pendingQuestion: { ...fixture.pendingQuestion, answer: '' } }, marker()).question).toBe(null);
});

test('completed view keeps report status and touched file count', () => {
  const job = jobView({ id: 'job-a', status: 'completed', startedAt: createdAt,
    completedAt: '2026-10-18T00:00:12.000Z', report: { status: 'completed', touchedFiles: ['a.ts', 'b.ts'] },
  }, marker());
  expect(job.finished).toBe(true);
  expect(job.active).toBe(false);
  expect(job.fileCount).toBe(2);
  expect(job.finalStatus).toBe('completed');
  expect(statusLine([job])).toBe(undefined);
  expect(headerItem(job, 999).results[0]?.text).toBe('Done · 0 tool uses · 12s');
});

test('command pairs collapse at completion across unrelated activity', () => {
  const events: CodexLiveEvent[] = [
    { seq: 4, type: 'commandExecution', command: 'test', lifecycle: 'completed', exitCode: 0 },
    { seq: 1, type: 'commandExecution', command: 'test', lifecycle: 'started' },
    { seq: 2, type: 'agentMessage', text: 'still here' },
    { seq: 3, type: 'commandExecution', command: 'other', lifecycle: 'started' },
    { seq: 5, type: 'commandExecution', command: 'test', lifecycle: 'started' },
    { seq: 6, type: 'commandExecution', command: 'test', lifecycle: 'completed', exitCode: 1 },
    { seq: 7, type: 'commandExecution', command: 'test', lifecycle: 'completed', exitCode: 2 },
  ];
  expect(collapseActivity(events).map(event => event.seq)).toEqual([2, 3, 4, 6, 7]);
  expect(events[0]?.seq).toBe(4);
  expect(eventItem(collapseActivity(events)[3]!, running(), epoch).color).toBe('error');
  expect(toolUseCount(collapseActivity(events))).toBe(4);
});

test('intervening same-command starts do not collapse distinct invocations', () => {
  const activity = [
    { seq: 1, type: 'commandExecution', command: 'same', lifecycle: 'started' },
    { seq: 2, type: 'commandExecution', command: 'same', lifecycle: 'started' },
    { seq: 3, type: 'commandExecution', command: 'same', lifecycle: 'completed' },
  ];
  expect(collapseActivity(activity).map(event => event.seq)).toEqual([2, 3]);
  const job = jobView({ id: 'job-a', status: 'running', activity }, marker());
  expect(activityItems(job).map(event => event.seq)).toEqual([2, 3]);
  expect(toolUseCount(job.events)).toBe(2);
});

test('tool uses include files and calls once, excluding messages and plans', () => {
  expect(toolUseCount(richJob().events)).toBe(6);
  const events: CodexLiveEvent[] = [
    { seq: 1, type: 'dynamicToolCall', server: 's', tool: 'x', lifecycle: 'started' },
    { seq: 2, type: 'mcpToolCall', server: 's', tool: 'x', lifecycle: 'started' },
    { seq: 3, type: 'dynamicToolCall', server: 's', tool: 'x', lifecycle: 'completed' },
    { seq: 4, type: 'mcpToolCall', server: 's', tool: 'x', lifecycle: 'completed' },
  ];
  expect(collapseActivity(events).map(event => event.seq)).toEqual([3, 4]);
  expect(toolUseCount(collapseActivity(events))).toBe(2);
});

test('events remain bounded at 200 and malformed identities are rejected', () => {
  const events = Array.from({ length: 230 }, (_, seq) => ({ seq, type: 'agentMessage', text: `${seq}` }));
  expect(jobView({ id: 'job-a', status: 'running', activity: events }, marker()).events.length).toBe(200);
  expect(collapseActivity(events)[0]?.seq).toBe(30);
  expect(() => jobView({ id: 'other', status: 'running' }, marker())).toThrow();
  expect(() => markerView({ v: 1, jobId: 'a', jobFile: 'relative.json' })).toThrow();
});

test('commands unwrap plain, quoted, cut and shell-escaped arguments', () => {
  for (const [command, expected] of [
    ['git status --short', 'git status --short'],
    ["/bin/zsh -lc 'git status --short'", 'git status --short'],
    ['/bin/bash -lc "git status --short"', 'git status --short'],
    ["/bin/sh -c 'git status --short'", 'git status --short'],
    ['zsh -c git status --short', 'git status --short'],
    ['bash -lc "git status --short"', 'git status --short'],
    ["sh -lc 'git status --short'", 'git status --short'],
    ["/bin/zsh -lc 'git status --short", 'git status --short'],
    ['/bin/zsh -lc "python3 - <<\'PY\'', "python3 - <<'PY'"],
    ["/bin/zsh -lc 'echo '" + '"' + "'" + '"' + "'hello'" + '"' + "'" + '"' + "''", "echo 'hello'"],
    ['echo "already quoted"', 'echo "already quoted"'],
  ]) expect(unwrapCommand(command!)).toBe(expected);
});

test('file result phrases handle singular, plural, omitted zeros and missing counts', () => {
  const base = { seq: 1, type: 'fileChange', path: '/workspace/a.ts' };
  for (const [kind, added, removed, result] of [
    ['update', 3, 1, 'Updated a.ts with 3 additions and 1 removal'],
    ['update', 1, 2, 'Updated a.ts with 1 addition and 2 removals'],
    ['update', 1, 0, 'Updated a.ts with 1 addition'],
    ['update', 0, 1, 'Updated a.ts with 1 removal'],
    ['update', 0, 0, 'Updated a.ts'],
    ['add', 1, 0, 'Wrote 1 line to a.ts'],
    ['add', 5, 0, 'Wrote 5 lines to a.ts'],
    ['delete', 0, 7, 'Deleted a.ts'],
    ['update', undefined, undefined, 'Updated'],
    ['add', undefined, undefined, 'Wrote'],
    ['delete', undefined, undefined, 'Deleted'],
    ['unknown', undefined, undefined, 'Updated'],
  ] as const) expect(fileResult({ ...base, kind, added, removed })).toBe(result);
  for (const [kind, name] of [['add', 'Write'], ['update', 'Update'], ['delete', 'Delete'], ['unknown', 'Edit']]) {
    expect(eventItem({ ...base, kind }, running(), epoch).title).toBe(`${name}(a.ts)`);
  }
});

test('old companions fall back to text, unchecked todos and count-free file results', () => {
  const job = jobView({ id: 'job-a', status: 'running', activity: [
    { seq: 1, type: 'agentMessage', text: 'Legacy message' },
    { seq: 2, type: 'plan', steps: ['One', 'Two'] },
    { seq: 3, type: 'fileChange', kind: 'update', path: 'a.ts' },
  ] }, marker());
  const items = feedItems(job, epoch);
  expect(items[1]?.markdown).toBe('Legacy message');
  expect(items[2]?.results.map(line => line.text)).toEqual(['☐ One', '☐ Two']);
  expect(items[3]?.results[0]?.text).toBe('Updated');
  expect(headerItem(job, epoch).results.length).toBe(1);
});

test('full message bodies preserve Markdown and newlines while cleaning control codes', () => {
  const job = jobView({ id: 'job-a', status: 'running', activity: [
    { seq: 1, type: 'agentMessage', text: 'short', body: '\u001b[31m## Heading\r\n\n- detail\u0000\u202e' },
    { seq: 2, type: 'agentMessage', body: 'x'.repeat(4500) },
  ] }, marker());
  expect(job.events[0]?.body).toBe('## Heading\n\n- detail  ');
  expect(job.events[1]?.body?.length).toBe(4000);
  expect(eventItem(job.events[0]!, job, epoch)).toMatchObject({ color: 'text', markdown: '## Heading\n\n- detail  ' });
});

test('tool results show running age, success duration, unknown exit and explicit errors', () => {
  const command = { seq: 1, type: 'commandExecution' };
  expect(toolResult({ ...command, lifecycle: 'started', at: createdAt }, epoch + 38000).text).toBe('Running… (38s)');
  expect(toolResult({ ...command, lifecycle: 'started' }, epoch).text).toBe('Running…');
  expect(toolResult({ ...command, exitCode: 0, durationMs: 400 }, epoch).text).toBe('Done (0.4s)');
  expect(toolResult({ ...command, exitCode: 1, durationMs: 400 }, epoch)).toEqual({ text: 'Error: exit 1 (0.4s)', color: 'error' });
  expect(toolResult({ ...command, durationMs: 400 }, epoch).text).toBe('Done');
  for (const status of ['failed', 'error']) {
    expect(toolResult({ seq: 1, type: 'mcpToolCall', status }, epoch).text).toBe('Error');
    expect(eventItem({ ...command, status }, running(), epoch).color).toBe('error');
  }
  expect(eventItem({ ...command, lifecycle: 'started' }, running(), epoch).color).toBe('inactive');
  expect(eventItem({ ...command, exitCode: 0 }, running(), epoch).color).toBe('success');
});

test('job states use theme keys and readable state words', () => {
  for (const [status, word, color] of [
    ['running', 'Running', 'claude'], ['queued', 'Queued', 'inactive'], ['waiting', 'Waiting for Claude', 'warning'],
    ['completed', 'Done', 'success'], ['failed', 'Failed', 'error'], ['blocked', 'Blocked', 'error'],
    ['cancelled', 'Stopped', 'inactive'], ['interrupted', 'Stopped', 'inactive'],
  ]) expect(jobState({ ...running(), status: status! })).toEqual({ word, color });
});

test('width helpers cap headers at two lines and keep job rows on one line', () => {
  for (const columns of [1, 2, 4, 12, 40, 60, 80]) {
    const job = { ...running(), label: '修复代码 🧪 '.repeat(8) };
    const row = jobRow(job, true, columns, epoch);
    expect(width(row.selector + row.bullet + row.label + row.summary + row.gap + row.meta) <= columns).toBe(true);
    const lines = wrap(`Codex(${job.label})`, columns, 2);
    expect(lines.length <= 2).toBe(true);
    expect(lines.every(line => width(line) <= columns)).toBe(true);
  }
  expect(width(fit('代码', 3)) <= 3).toBe(true);
  expect(wrap('Bash(' + 'long text '.repeat(30) + ')', 58, 2).at(-1)?.endsWith('…')).toBe(true);
});

test('feed keeps the latest plan in order and the last 80 items plus header and question', () => {
  const job = richJob();
  expect(activityItems(job).map(event => event.seq)).toEqual([2, 3, 5, 6, 7, 9, 10, 11]);
  job.events = Array.from({ length: 200 }, (_, seq) => ({ seq, type: 'agentMessage', text: `Message ${seq}` }));
  expect(activityItems(job).length).toBe(80);
  expect(activityItems(job)[0]?.seq).toBe(120);
  expect(feedItems(job, epoch).length).toBe(82);
  expect(feedItems(job, epoch)[0]?.key).toBe('job-header');
  expect(feedItems(job, epoch).at(-1)?.key).toBe('pending-question');
});

const props = { title: 'Codex', isFocused: true, bodyColumns: 60,
  placement: 'dock' as const, scroll: { offset: 0, bodyRows: 16 }, view: {} };

// Seed only an unset read; writes still reach the real state bottom and redraw.
function seed(on: On, initial: CodexLiveState) {
  on('clock.now', () => ({ value: epoch }));
  on('state.get', async ($, e, next) => {
    const result = await next(e);
    if (!('value' in result)) return result;
    const saved = (result.value?.value ?? initial) as CodexLiveState;
    // Stand in for the poller's private transcript cache in render-only tests.
    // The poll integration tests exercise real selected-detail hydration.
    const jobs = saved.jobs.map(job => job.id === saved.selectedId && job.detailsLoaded === false
      ? initial.jobs.find(cached => cached.id === job.id) ?? job : job);
    return { value: { value: { ...saved, jobs }, version: result.value?.version ?? 0 } };
  });
}

const textOf = (spans: { text: string }[]) => spans.map(span => span.text).join('');
const inlineProps = { ...props, bodyColumns: 56, placement: 'inline' as const, scroll: { offset: 0, bodyRows: 14 } };
function fourJobs(now = epoch) {
  return ['running', 'running', 'completed', 'failed'].map((status, i) => jobView({
    id: `job-${i}`, status, startedAt: createdAt, completedAt: status === 'running' ? undefined : new Date(now - 30000).toISOString(),
    activity: [{ seq: 1, type: 'agentMessage', body: Array.from({ length: 35 }, (_, n) => `Line ${n}`).join('\n') }],
  }, { ...marker(`job-${i}`), createdAt: new Date(epoch - i * 1000).toISOString() }));
}
function track(on: On) {
  const writes: CodexLiveState[] = [];
  on('state.set', async ($, e, next) => { const result = await next(e); writes.push(e.value); return result; });
  return writes;
}
const move = (by: number, bodyRows = 14) => ({ component: 'Pane' as const, requestId: 'codex-live',
  offset: by < 0 ? 0 : 1, by, bodyRows, contentRows: bodyRows + 1, origin: { kind: 'person' as const } });
function rowBoxes(boxes: FoundElement[]) {
  return boxes.filter(box => box.props.height === 1);
}

test('message rows style bold, inline code, headings and links before wrapping', () => {
  const spans = inlineSpans('Read **the `code`** and [docs](https://example.com).');
  expect(textOf(spans)).toBe('Read the code and docs.');
  expect(spans.find(span => span.text === 'the ')?.bold).toBe(true);
  expect(spans.find(span => span.text === 'code')).toMatchObject({ bold: true, color: 'suggestion' });
  expect(messageLines('# Heading', 20)).toEqual([[{ text: 'Heading', bold: true }]]);
  const lines = messageLines('**bold words crossing rows** and `code words crossing rows`', 9);
  expect(lines.length > 3).toBe(true);
  expect(lines.every(row => width(textOf(row)) <= 9)).toBe(true);
  expect(lines.flat().some(span => span.bold)).toBe(true);
  expect(lines.flat().some(span => span.color === 'suggestion')).toBe(true);
  expect(lines.map(textOf).join('')).not.toContain('**');
  expect(lines.map(textOf).join('')).not.toContain('`');
});

test('bullets and numbered items keep their hanging indent', () => {
  expect(messageLines('- alpha beta gamma', 10).map(textOf)).toEqual(['• alpha', '  beta', '  gamma']);
  expect(messageLines('* alpha beta gamma', 10).map(textOf)).toEqual(['• alpha', '  beta', '  gamma']);
  expect(messageLines('1. alpha beta gamma', 10).map(textOf)).toEqual(['1. alpha', '   beta', '   gamma']);
});

test('fences and tables cut at width, preserve spaces and do not wrap', () => {
  const lines = messageLines('```ts\n  const value = 123456;\n```\n| alpha | beta |\n[link](https://example.com)', 12);
  expect(lines.map(textOf)).toEqual(['  const val…', '| alpha | b…', 'link']);
  expect(lines[0]?.[0]?.color).toBe('subtle');
  expect(messageLines('~~~\nx\n~~~', 12).map(textOf)).toEqual(['x']);
});

test('flattened items preserve body/result indents, blank separators and capped titles', () => {
  const job = richJob();
  job.label = 'A long label '.repeat(30);
  const lines = feedLines(job, epoch + 38000, 30);
  const header = lines.filter(line => line.key.startsWith('job-header-body'));
  expect(header.length).toBe(2);
  expect(textOf(header[0]!.spans).startsWith('⏺ ' + job.label.slice(0, 10))).toBe(true);
  expect(textOf(header[1]!.spans).startsWith('  ')).toBe(true);
  expect(textOf(header[1]!.spans).endsWith('…')).toBe(true);
  const command = lines.filter(line => line.key.startsWith('event-3-body'));
  expect(command.length).toBe(2);
  expect(textOf(command[1]!.spans).endsWith('…')).toBe(true);
  const result = lines.filter(line => line.key.startsWith('event-7-result'));
  expect(textOf(result[0]!.spans).startsWith('  ⎿  ')).toBe(true);
  expect(result.slice(1).every(row => textOf(row.spans).startsWith('     '))).toBe(true);
  expect(lines.find(line => line.key === 'event-7-gap')?.spans).toEqual([]);
  expect(lines.every(row => width(textOf(row.spans)) <= 30)).toBe(true);
});

test('all feed lines fit tiny and wide windows, including wide characters and combining marks', () => {
  const job = richJob();
  job.events.push({ seq: 100, type: 'agentMessage', body: '# 修复 🧪\n- **代码代码** `é` [链接](u)\n1. 中文汉字\n```\n🧪🧪🧪\n```\n| 中文 | 🧪 |' });
  for (const columns of [0, 1, 2, 3, 4, 5, 6, 9, 12, 56]) {
    const lines = feedLines(job, epoch, columns);
    expect(lines.every(row => width(textOf(row.spans)) <= columns)).toBe(true);
    expect(lines.every(row => !textOf(row.spans).includes('\n'))).toBe(true);
  }
});

test('job header prioritizes newest active jobs, guarantees selection, and caps expansion at ten', () => {
  const jobs = Array.from({ length: 15 }, (_, i) => ({ ...fourJobs()[0]!, id: `job-${i}`,
    active: i < 4, status: i < 4 ? 'running' : 'completed', createdAt: new Date(epoch - i * 1000).toISOString() }));
  const state = { jobs, selectedId: 'job-14', nowMs: epoch };
  expect(headerLayout(state, jobs[14]!, 14).jobs.map(job => job.id)).toEqual(['job-0', 'job-1', 'job-14']);
  expect(headerLayout({ ...state, jobsExpanded: true }, jobs[14]!, 14).jobs.length).toBe(10);
  for (const [status, glyph] of [['running', '⏺'], ['queued', '…'], ['waiting', '?'], ['completed', '✓'],
    ['failed', '✗'], ['blocked', '✗'], ['cancelled', '■'], ['interrupted', '■']]) {
    expect(jobRow({ ...running(), status: status! }, false, 56, epoch).bullet).toBe(`${glyph} `);
  }
});

test('footer prioritizes the jump button, shortens to Jump, and freezes completed spinners', () => {
  const job = running();
  const state = { jobs: [job], selectedId: job.id, nowMs: epoch, spinnerTick: 4 };
  expect(footerLayout(job, state, 100, true, 0).left).toBe('✻ Running… 0s · 1 tool uses · Task job-a');
  expect(footerLayout(job, state, 56, false, 3).jump).toBe('↓ 3 new · Jump to bottom');
  expect(footerLayout(job, state, 56, false, 0).jump).toBe('↓ Jump to bottom');
  expect(footerLayout(job, state, 9, false, 3).jump).toBe('↓ Jump');
  for (const columns of [3, 4, 9, 14, 23, 30, 56]) {
    const footer = footerLayout(job, state, columns, false, 3);
    expect(width(footer.left + footer.gap + footer.jump) + 3 <= columns).toBe(true);
  }
  const finished = { ...job, status: 'completed', finished: true, completedAt: createdAt };
  expect(footerLayout(finished, state, 100, true, 0)).toEqual(footerLayout(finished, { ...state, spinnerTick: 5 }, 100, true, 0));
  expect(footerLayout(job, { ...state, spinnerTick: 5 }, 100, true, 0).left.startsWith('✽')).toBe(true);
});

for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
  test(`Pane draws fixed Claude-style transcript rows on ${surface}`, async ($, on) => {
    seed(on, { jobs: [richJob()], selectedId: 'job-a', nowMs: epoch + 38000 });
    const tall = { ...props, scroll: { offset: 0, bodyRows: 60 } };
    const ui = await $.ui.mount({ plugin: 'codex-live', surface, component: 'Pane', requestId: 'codex-live', props: tall });
    for (const text of ['Bash(git status --short)', 'Done (', 'Running… (38s)', 'Error: exit 1', 'Update(',
      'with 3 additions and 1 removal', 'server - tool (MCP)', 'Update Todos', '☒', 'Task job-a', 'Waiting for Claude']) {
      expect(await ui.find({ type: 'Text', text })).toBeDefined();
    }
    const transcript = await ui.find({ key: 'transcript' });
    expect(transcript?.text).not.toContain('/bin/zsh -lc');
    expect(transcript?.text).not.toContain('Old plan');
    expect(await ui.find({ type: 'Markdown' })).toBe(undefined);
    expect((await ui.find({ type: 'Text', text: /^Bash$/ }))?.props.bold).toBe(true);
    expect((await ui.find({ type: 'Text', text: /^☒ Read waitForJob$/ }))?.props).toMatchObject({ color: 'subtle', strikethrough: true });
    expect((await ui.find({ type: 'Text', text: /^☐ Check lease gaps$/ }))?.props.bold).toBe(true);
    expect((await ui.find({ type: 'Text', text: /^Error: exit 1/ }))?.props.color).toBe('error');
    expect((await ui.find({ key: 'footer' }))?.text).toContain('? Waiting for Claude');
    const boxes = rowBoxes(await ui.findAll({ type: 'Box' }));
    expect(boxes.length).toBe(61);
    expect(boxes.every(row => width(row.text) <= 60)).toBe(true);
    expect((await ui.findAll({ type: 'Text' })).every(text => text.props.wrap === 'truncate-end' || !String(text.text).includes('\n'))).toBe(true);
    const colors = new Set(['text', 'subtle', 'inactive', 'success', 'error', 'warning', 'claude', 'suggestion']);
    expect((await ui.findAll({ type: 'Text' })).every(text => text.props.color === undefined || colors.has(String(text.props.color)))).toBe(true);
    await ui.unmount();
  });

  test(`Pane pins three jobs and footer, scrolls and selects on ${surface}`, async ($, on) => {
    const jobs = fourJobs(epoch + 192000);
    seed(on, { jobs, selectedId: jobs[0]!.id, nowMs: epoch + 192000 });
    const writes = track(on);
    let delegated = 0;
    on('ui.scroll', () => { delegated++; return {}; });
    const ui = await $.ui.mount({ plugin: 'codex-live', surface, component: 'Pane', requestId: 'codex-live', props: inlineProps });
    const before = rowBoxes(await ui.findAll({ type: 'Box' }));
    expect(before.length).toBe(15);
    expect(before.slice(0, 3).map(row => row.key)).toEqual(['header-job-0', 'header-job-1', 'header-job-2']);
    expect(before[3]?.text).toBe('+1 more  Clear finished');
    expect(before[4]?.text).toBe('─'.repeat(56));
    expect(before[13]?.key).toBe('footer');
    expect(before[13]?.text).toContain('Running… 3m 12s');
    expect(before[14]?.text).toBe(' ');
    expect((await ui.find({ key: 'transcript' }))?.text).toContain('Line 34');
    await $.ui.scroll(move(-5));
    const after = rowBoxes(await ui.findAll({ type: 'Box' }));
    expect(delegated).toBe(0);
    expect(after.slice(0, 5).map(row => row.text)).toEqual(before.slice(0, 5).map(row => row.text));
    expect(after[13]?.key).toBe('footer');
    expect((await ui.find({ key: 'transcript' }))?.text).not.toContain('Line 34');
    expect((await ui.find({ key: 'transcript' }))?.text).toContain('Line 29');
    expect((await ui.find({ key: 'jump-bottom' }))?.text).toBe('↓ Jump to bottom');
    expect((await ui.find({ key: 'jump-bottom' }))?.props.hotkey).toBe('b');
    const lines = feedLines(jobs[0]!, epoch + 192000, 56);
    expect(writes.at(-1)?.feeds?.['job-0']).toMatchObject({ feedOffset: lines.length - 8 - 5, following: false, seenLines: lines.length });
    await ui.press({ key: 'jump-bottom' });
    expect(writes.at(-1)?.feeds?.['job-0']?.following).toBe(true);
    expect(await ui.find({ key: 'jump-bottom' })).toBe(undefined);
    await $.ui.scroll(move(-5));
    await ui.press({ key: 'job-1' });
    expect((await ui.find({ key: 'job-1' }))?.text).toContain('❯ ⏺');
    expect((await ui.find({ key: 'transcript' }))?.text).toContain('Line 34');
    expect(writes.at(-1)?.feeds?.['job-1']?.following).toBe(true);
    expect(writes.at(-1)?.feeds?.['job-0']?.following).toBe(false);
    await ui.press({ key: 'job-0' });
    expect(writes.at(-1)?.feeds?.['job-0']?.following).toBe(true);
    await ui.press({ key: 'toggle-jobs' });
    expect(await ui.find({ key: 'job-3' })).toBeDefined();
    expect((await ui.find({ key: 'toggle-jobs' }))?.text).toBe('− Show fewer');
    await ui.press({ key: 'toggle-jobs' });
    expect(await ui.find({ key: 'job-3' })).toBe(undefined);
    expect(rowBoxes(await ui.findAll({ type: 'Box' })).length).toBe(15);
    await ui.unmount();
  });
}

test('scroll intercepts wheel, arrows, pages, Home/End and ignores wheel over pinned rows', async ($, on) => {
  const jobs = fourJobs();
  seed(on, { jobs, selectedId: jobs[0]!.id, nowMs: epoch });
  const writes = track(on);
  const ui = await $.ui.mount({ plugin: 'codex-live', surface: 'terminal', component: 'Pane', requestId: 'codex-live', props: inlineProps });
  const bottom = feedLines(jobs[0]!, epoch, 56).length - 8;
  await $.ui.scroll(move(-1));
  expect(writes.at(-1)?.feeds?.['job-0']?.feedOffset).toBe(bottom - 1);
  await $.ui.scroll({ ...move(-1), pointer: { row: 6, column: 0 } });
  expect(writes.at(-1)?.feeds?.['job-0']?.feedOffset).toBe(bottom - 2);
  for (const row of [-1, 0, 4, 13, 14]) await $.ui.scroll({ ...move(-1), pointer: { row, column: 0 } });
  expect(writes.at(-1)?.feeds?.['job-0']?.feedOffset).toBe(bottom - 2);
  await $.ui.scroll(move(-14));
  expect(writes.at(-1)?.feeds?.['job-0']?.feedOffset).toBe(bottom - 10);
  await $.ui.scroll(move(14));
  expect(writes.at(-1)?.feeds?.['job-0']?.feedOffset).toBe(bottom - 2);
  await $.ui.scroll(move(-15));
  expect(writes.at(-1)?.feeds?.['job-0']?.feedOffset).toBe(0);
  expect((await ui.find({ key: 'transcript' }))?.text).toContain('⏺ Task job-0');
  await $.ui.scroll(move(15));
  expect(writes.at(-1)?.feeds?.['job-0']?.following).toBe(true);
  await $.ui.scroll(move(-1));
  await $.ui.scroll(move(1));
  expect(writes.at(-1)?.feeds?.['job-0']?.following).toBe(true);
  await ui.unmount();
});

test('a new wrapped line counts while stopped and short/shrunken feeds clamp', () => {
  const job = fourJobs()[0]!;
  const lines = feedLines(job, epoch, 56);
  const stopped = scrollFeed(lines, 8, undefined, -5, 14, 15);
  const grown = feedLines({ ...job, events: [...job.events, { seq: 2, type: 'agentMessage', body: 'new one\nnew two' }] }, epoch, 56);
  expect(feedWindow(grown, 8, stopped).newLines).toBe(3);
  expect(feedWindow(grown, 8, stopped).offset).toBe(stopped.feedOffset);
  expect(feedWindow(lines.slice(0, 2), 8, stopped).offset).toBe(0);
  expect(scrollFeed(lines.slice(0, 2), 8, stopped, 1, 14, 15).following).toBe(true);
});

for (const [status, word, color] of [['running', 'Running', 'claude'], ['waiting', 'Waiting for Claude', 'warning'],
  ['completed', 'Done', 'success'], ['failed', 'Failed', 'error'], ['blocked', 'Blocked', 'error'], ['cancelled', 'Stopped', 'inactive']] as const) {
  test(`Pane footer and retained feed header show ${status} state`, async ($, on) => {
    const job = { ...running(), status, finished: !['running', 'waiting'].includes(status), completedAt: ['running', 'waiting'].includes(status) ? '' : '2026-10-18T00:04:12.000Z' };
    seed(on, { jobs: [job], selectedId: job.id, nowMs: epoch + 252000 });
    const ui = await $.ui.mount({ plugin: 'codex-live', surface: 'terminal', component: 'Pane', requestId: 'codex-live', props: { ...props, bodyColumns: 100 } });
    expect((await ui.find({ key: 'job-header-result-0' }))?.text).toContain(`${word} · 1 tool uses · 4m 12s`);
    expect((await ui.find({ key: 'live-status' }))?.children[0]).toMatchObject({ props: { color } });
    expect((await ui.find({ key: 'footer' }))?.text).toContain('Task job-a');
    expect((await ui.find({ key: 'footer' }))?.text).toContain(word);
    expect(await ui.find({ type: 'Text', text: 'gpt-6-astra · xhigh · fast · read-only' })).toBeDefined();
    expect(!!await ui.find({ key: 'clear-finished' })).toBe(job.finished);
    await ui.unmount();
  });
}

test('Pane pads the empty state to bodyRows plus one', async $ => {
  const ui = await $.ui.mount({ plugin: 'codex-live', surface: 'terminal', component: 'Pane', requestId: 'codex-live', props });
  expect((await ui.find({ type: 'Text', text: /^No Codex jobs/ }))?.text).toContain('No Codex jobs in this session yet.');
  expect((await ui.find({ type: 'Text', text: /^No Codex jobs/ }))?.children).toBeDefined();
  expect(rowBoxes(await ui.findAll({ type: 'Box' })).length).toBe(17);
  expect(await ui.find({ key: 'footer' })).toBe(undefined);
  await ui.unmount();
});

test('tiny heights reserve the footer and resize maintains an exact tree without render writes', async ($, on) => {
  seed(on, { jobs: fourJobs(), selectedId: 'job-0', nowMs: epoch });
  const writes = track(on);
  const ui = await $.ui.mount({ plugin: 'codex-live', surface: 'terminal', component: 'Pane', requestId: 'codex-live', props: inlineProps });
  for (const placement of ['dock', 'inline'] as const) for (const rows of [0, 1, 2, 3, 4, 5, 6, 14]) {
    await ui.redraw({ ...inlineProps, placement, bodyColumns: 12, scroll: { offset: 0, bodyRows: rows } });
    const boxes = rowBoxes(await ui.findAll({ type: 'Box' })).filter(box => box.key !== 'pane' && box.key !== 'transcript');
    expect(boxes.length).toBe(rows + 1);
    expect(boxes.every(box => width(box.text) <= 12)).toBe(true);
    if (rows) expect(boxes.at(-2)?.key).toBe('footer');
  }
  expect(writes.length).toBe(0);
  await ui.unmount();
});

for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
  for (const placement of ['dock', 'inline'] as const) {
    test(`Pane resizes 20 → 14 → 20 with pinned rows and working scroll on ${surface} ${placement}`, async ($, on) => {
      const jobs = fourJobs();
      seed(on, { jobs, selectedId: 'job-0', nowMs: epoch });
      on('session.surface', () => ({ value: surface }));
      const writes = track(on);
      let delegated = 0;
      on('ui.scroll', () => { delegated++; return {}; });
      const pinnedRows = 5;
      const lines = feedLines(jobs[0]!, epoch, 56);
      for (const offset of [0, 1, 5]) {
        const sized = (bodyRows: number) => ({ ...inlineProps, placement, scroll: { offset, bodyRows } });
        const ui = await $.ui.mount({ plugin: 'codex-live', surface, component: 'Pane', requestId: 'codex-live', props: sized(20) });
        const transcript = async () => (await ui.find({ key: 'transcript' }))!;
        const feed = () => writes.at(-1)?.feeds?.['job-0'];
        const scroll = (by: number, bodyRows: number, pointer?: { row: number; column: number }) =>
          $.ui.scroll({ ...move(by, bodyRows), offset, contentRows: offset + bodyRows + 1, pointer });
        const headers = async () => (await ui.findAll({ type: 'Box' }))
          .filter(box => /^header-job-|^header-toggle$|^header-rule$/.test(box.key ?? '')).map(box => box.text);
        const originalHeader = await headers();
        const check = async (bodyRows: number) => {
          const pane = (await ui.find({ key: 'pane' }))!;
          expect(pane.props).toMatchObject({ height: offset + bodyRows + 1, minHeight: 0, flexShrink: 1 });
          const children = pane.children.filter(child => typeof child !== 'string') as FoundElement[];
          let position = 0;
          const positions = new Map<string, number>();
          for (const child of children) {
            positions.set(child.props.key as string, position);
            position += Number(child.props.height);
          }
          expect(position).toBe(offset + bodyRows + 1);
          expect(positions.get('header-job-0')).toBe(offset);
          expect(positions.get('transcript')).toBe(offset + pinnedRows);
          expect(positions.get('footer')).toBe(offset + bodyRows - 1);
          expect(positions.get('scroll-sentinel')).toBe(offset + bodyRows);
          expect(children.at(-2)?.props.key).toBe('footer');
          expect(await headers()).toEqual(originalHeader);
          expect((await transcript()).props).toMatchObject({ height: bodyRows - pinnedRows - 1, flexShrink: 1, minHeight: 0, overflow: 'hidden' });
          expect((await transcript()).children.length).toBe(bodyRows - pinnedRows - 1);
          expect((await ui.find({ key: 'footer' }))?.text).toContain('Running');
        };
        await check(20);
        const initialRows = (await transcript()).children;
        // Changed metrics on the same mounted instance: no cached taller body,
        // no render writes, six fewer feed rows, then the identical tail back.
        const beforeResize = writes.length;
        await ui.redraw(sized(14));
        await check(14);
        expect((await transcript()).children).toEqual(initialRows.slice(6));
        await ui.redraw(sized(20));
        await check(20);
        expect((await transcript()).children).toEqual(initialRows);
        expect(writes.length).toBe(beforeResize);

        await scroll(-20, 20);
        expect(feed()?.feedOffset).toBe(lines.length - 2 * (20 - pinnedRows - 1));
        expect(feed()?.following).toBe(false);
        const anchor = feed()?.anchor;
        const stoppedRows = (await transcript()).children;
        const beforeStoppedResize = writes.length;
        await ui.redraw(sized(14));
        await check(14);
        expect((await transcript()).children).toEqual(stoppedRows.slice(0, 14 - pinnedRows - 1));
        expect((await ui.find({ key: 'jump-bottom' }))?.text).toBe('↓ Jump to bottom');
        await ui.redraw(sized(20));
        await check(20);
        expect((await transcript()).children).toEqual(stoppedRows);
        expect(feed()?.anchor).toEqual(anchor);
        expect(writes.length).toBe(beforeStoppedResize);

        await ui.redraw(sized(14));
        const beforeWheel = feed()?.feedOffset;
        for (let row = 0; row < pinnedRows; row++) await scroll(-1, 14, { row, column: 0 });
        await scroll(-1, 14, { row: 13, column: 0 });
        expect(feed()?.feedOffset).toBe(beforeWheel);
        await scroll(-1, 14, { row: pinnedRows, column: 0 });
        expect(feed()?.feedOffset).toBe(beforeWheel! - 1);
        await scroll(-14, 14);
        expect(feed()?.feedOffset).toBe(Math.max(0, beforeWheel! - 1 - (14 - pinnedRows - 1)));
        expect(feed()?.rows).toBe(14 - pinnedRows - 1);
        await scroll(-(offset + 15), 14);
        expect(feed()?.feedOffset).toBe(0);
        await ui.press({ key: 'jump-bottom' });
        expect(feed()?.following).toBe(true);
        expect(await ui.find({ key: 'jump-bottom' })).toBe(undefined);
        expect((await transcript()).text).toContain('Line 34');
        await scroll(-1, 14);
        await ui.press({ key: 'jump-bottom' });
        expect(feed()?.following).toBe(true);
        await scroll(-1, 14);
        await scroll(offset + 15, 14);
        expect(feed()?.following).toBe(true);
        await ui.redraw(sized(20));
        expect((await transcript()).children).toEqual(initialRows);
        expect(delegated).toBe(0);
        await ui.unmount();
      }
    });
  }
}

test('Pane windows retained items and keeps older long bodies intact within the drawing budget', async ($, on) => {
  const job = jobView({ id: 'job-a', status: 'running', activity: Array.from({ length: 100 }, (_, seq) => ({
    seq, type: 'agentMessage', body: `${seq}: ` + 'x'.repeat(3996),
  })) }, marker());
  job.detailsUnavailable = true;
  const items = feedItems(job, epoch).filter(item => item.markdown !== undefined);
  expect(items.length).toBe(80);
  expect(items[0]?.markdown).toBe(job.events[20]?.body);
  expect(items.at(-1)?.markdown).toBe(job.events.at(-1)?.body);
  seed(on, { jobs: [job], selectedId: job.id, nowMs: epoch });
  const ui = await $.ui.mount({ plugin: 'codex-live', surface: 'terminal', component: 'Pane', requestId: 'codex-live', props });
  expect((await ui.findAll({ type: 'Markdown' })).length).toBe(0);
  expect(rowBoxes(await ui.findAll({ type: 'Box' })).length).toBe(17);
  expect((await ui.find({ key: 'transcript' }))?.children.length).toBe(15);
  expect(JSON.stringify(await ui.drawn()).length < 100000).toBe(true);
  await $.ui.scroll(move(-17, 16));
  expect((await ui.find({ key: 'transcript' }))?.text).toContain('Details unavailable · showing the last good view');
  expect((await ui.find({ key: 'transcript' }))?.text).toContain('20: ');
  await ui.unmount();
});

test('retention keeps a stopped row anchored and counts new rows even at the 80-item cap', () => {
  const job = running();
  job.events = Array.from({ length: 200 }, (_, seq) => ({ seq, type: 'agentMessage', text: `Message ${seq}` }));
  const lines = feedLines(job, epoch, 56);
  const stopped = { ...scrollFeed(lines, 8, undefined, -5, 14, 15), columns: 56 };
  const next = { ...job, events: [...job.events.slice(1), { seq: 200, type: 'agentMessage', text: 'Message 200' }] };
  const after = feedLines(next, epoch, 56);
  expect(after.length).toBe(lines.length);
  const updated = reconcileFeed(job, next, stopped, epoch);
  expect(feedWindow(after, 8, updated).lines.map(line => line.key)).toEqual(feedWindow(lines, 8, stopped).lines.map(line => line.key));
  expect(feedWindow(after, 8, updated).newLines).toBe(2); // Item plus its separator.
  expect(updated.seenLines).toBe(stopped.seenLines);
  const moved = scrollFeed(after, 8, updated, -1, 14, 15);
  expect(feedWindow(after, 8, moved).newLines).toBe(2);
  expect(scrollFeed(after, 8, moved, 15, 14, 15).following).toBe(true);
});

test('legacy message text also preserves line structure for headings and lists', () => {
  const job = jobView({ id: 'job-a', status: 'running', activity: [
    { seq: 1, type: 'agentMessage', text: '# Heading\n- **detail**\n1. `code`' },
  ] }, marker());
  const lines = feedLines(job, epoch, 56).filter(line => line.key.startsWith('event-1-body'));
  expect(lines.map(line => textOf(line.spans))).toEqual(['⏺ Heading', '  • detail', '  1. code']);
});

function historyJobs() {
  return [
    { id: 'running', status: 'running', age: 0, created: -1000 },
    { id: 'recent-done', status: 'completed', age: 30000, created: -5000 },
    { id: 'recent-stopped', status: 'interrupted', age: 30000, created: -6000 },
    { id: 'old-done', status: 'completed', age: 600000, created: -2000 },
    { id: 'older-done', status: 'completed', age: 600000, created: -3000 },
  ].map(({ id, status, age, created }) => jobView({ id, status, startedAt: new Date(epoch - 900000).toISOString(),
    completedAt: status === 'running' ? undefined : new Date(epoch - age).toISOString(),
    activity: [{ seq: 1, type: 'agentMessage', text: `Feed for ${id}` }],
  }, { ...marker(id), createdAt: new Date(epoch + created).toISOString() }));
}

test('collapsed history expires at two minutes and recent jobs sort by end, not creation', () => {
  const jobs = historyJobs();
  const state = { jobs, selectedId: 'running', nowMs: epoch };
  expect(headerLayout(state, jobs[0]!, 14)).toMatchObject({ more: 2, toggle: true, rows: 5 });
  expect(headerLayout(state, jobs[0]!, 14).jobs.map(job => job.id)).toEqual(['running', 'recent-done', 'recent-stopped']);
  expect(headerLayout({ ...state, nowMs: epoch + 89999 }, jobs[0]!, 14).more).toBe(2);
  const expired = headerLayout({ ...state, nowMs: epoch + 90000 }, jobs[0]!, 14);
  expect(expired.jobs.map(job => job.id)).toEqual(['running']);
  expect(expired).toMatchObject({ more: 4, toggle: true, rows: 3 });
  jobs[2] = { ...jobs[2]!, completedAt: new Date(epoch - 20000).toISOString() };
  expect(recentEndedJobIds(jobs, epoch)).toEqual(['recent-stopped', 'recent-done']);
  expect(headerLayout(state, jobs[0]!, 14).jobs.map(job => job.id)).toEqual(['running', 'recent-stopped', 'recent-done']);
});

test('all terminal job states use the recent-end window while queued and waiting stay active', () => {
  const statuses = ['completed', 'failed', 'blocked', 'cancelled', 'interrupted', 'stopped'];
  const jobs = statuses.map((status, i) => jobView({ id: status, status,
    completedAt: new Date(epoch - i * 1000).toISOString(),
  }, marker(status)));
  expect(jobs.every(job => job.finished && !job.active)).toBe(true);
  expect(recentEndedJobIds(jobs, epoch)).toEqual(statuses);
  expect(recentEndedJobIds(jobs, epoch + 120000)).toEqual([]);
  const waiting = jobView({ id: 'waiting', status: 'waiting', pendingQuestion: { text: 'Help?' } }, marker('waiting'));
  const queued = jobView({ id: 'queued', status: 'queued' }, { ...marker('queued'), createdAt: new Date(epoch + 1000).toISOString() });
  const state = { jobs: [...jobs, queued, waiting], selectedId: 'waiting', nowMs: epoch + 600000 };
  expect(headerLayout(state, waiting, 14).jobs.map(job => job.id)).toEqual(['queued', 'waiting']);
});

test('history toggle appears only for omitted jobs, including sessions with fewer than four jobs', () => {
  const jobs = historyJobs();
  const selected = jobs[0]!;
  expect(headerLayout({ jobs: [selected], selectedId: selected.id, nowMs: epoch }, selected, 14).rows).toBe(0);
  expect(headerLayout({ jobs: jobs.slice(0, 3), selectedId: selected.id, nowMs: epoch }, selected, 14)).toMatchObject({ more: 0, toggle: false });
  const state = { jobs: [selected, jobs[3]!], selectedId: selected.id, nowMs: epoch };
  expect(headerLayout(state, selected, 14)).toMatchObject({ more: 1, toggle: true });
  expect(headerLayout({ ...state, jobsExpanded: true }, selected, 14)).toMatchObject({ more: 0, toggle: true });
  // The clear row can displace a job at small heights; it must remain reachable.
  expect(headerLayout({ ...state, jobs: jobs.slice(0, 3) }, selected, 6)).toMatchObject({ more: 1, toggle: true, clear: true, rows: 4 });
});

for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
  test(`history expands, selects an old job, and collapses with its feed intact on ${surface}`, async ($, on) => {
    const jobs = historyJobs();
    seed(on, { jobs, selectedId: 'running', nowMs: epoch });
    const writes = track(on);
    const ui = await $.ui.mount({ plugin: 'codex-live', surface, component: 'Pane', requestId: 'codex-live', props: inlineProps });
    const headerIds = async () => (await ui.findAll({ type: 'Button' })).map(button => button.key).filter(key => key !== 'toggle-jobs' && key !== 'clear-finished');
    expect(await headerIds()).toEqual(['running', 'recent-done', 'recent-stopped']);
    expect((await ui.find({ key: 'toggle-jobs' }))?.text).toBe('+2 more');
    await ui.press({ key: 'toggle-jobs' });
    expect(await headerIds()).toEqual(['running', 'recent-done', 'recent-stopped', 'old-done', 'older-done']);
    expect((await ui.find({ key: 'toggle-jobs' }))?.text).toBe('− Show fewer');
    await ui.press({ key: 'old-done' });
    expect(writes.at(-1)?.selectedId).toBe('old-done');
    expect(writes.at(-1)?.feeds?.['old-done']?.following).toBe(true);
    expect((await ui.find({ key: 'transcript' }))?.text).toContain('Feed for old-done');
    await ui.press({ key: 'toggle-jobs' });
    expect(await headerIds()).toEqual(['running', 'old-done', 'recent-done']);
    expect((await ui.find({ key: 'old-done' }))?.text).toContain('❯ ✓');
    expect((await ui.find({ key: 'toggle-jobs' }))?.text).toBe('+2 more');
    expect((await ui.find({ key: 'transcript' }))?.text).toContain('Feed for old-done');
    await ui.press({ key: 'toggle-jobs' });
    expect(await headerIds()).toEqual(['running', 'old-done', 'recent-done', 'older-done', 'recent-stopped']);
    await ui.press({ key: 'toggle-jobs' });
    expect(rowBoxes(await ui.findAll({ type: 'Box' })).length).toBe(15);
    await ui.unmount();
  });
}

test('D1: maximum transcripts retain only selected details and shorten oldest bodies first', () => {
  const jobs = Array.from({ length: 20 }, (_, n) => jobView({ id: `max-${n}`, status: 'running',
    activity: Array.from({ length: 200 }, (_, seq) => ({ seq, type: 'agentMessage', body: 'x'.repeat(4000) })),
  }, marker(`max-${n}`)));
  const state = boundState({ jobs, selectedId: 'max-0', nowMs: epoch });
  expect(JSON.stringify(state).length < 600000).toBe(true);
  expect(state.jobs.slice(1).every(job => job.events.length === 0 && !job.detailsLoaded)).toBe(true);
  expect(state.jobs[0]?.events.at(-1)?.body?.length).toBe(4000);
  expect(state.jobs[0]!.events[0]!.body!.length < 4000).toBe(true);
});

test('D5: stale details remain visible in the pinned footer while reading the bottom', async ($, on) => {
  const job = { ...fourJobs()[0]!, detailsUnavailable: true, lastUpdateMs: epoch - 65000 };
  seed(on, { jobs: [job], selectedId: job.id, nowMs: epoch });
  const ui = await $.ui.mount({ plugin: 'codex-live', surface: 'terminal', component: 'Pane', requestId: 'codex-live',
    props: { ...inlineProps, placement: 'dock', bodyColumns: 120 } });
  expect((await ui.find({ key: 'footer' }))?.text).toContain('⚠ stale · last update 65s ago');
  expect((await ui.find({ key: 'live-status' }))?.children[0]).toMatchObject({ props: { color: 'warning' } });
  expect((await ui.find({ key: 'transcript' }))?.text).not.toContain('Details unavailable');
  await ui.unmount();
});

test('D6 D7 D8: terminal status wins over questions, needs_input freezes, and queued stays distinct', () => {
  for (const status of ['completed', 'failed', 'blocked', 'stopped', 'cancelled', 'interrupted', 'needs_input']) {
    const job = jobView({ id: 'a', status, startedAt: createdAt, completedAt: new Date(epoch + 5000).toISOString(),
      pendingQuestion: { text: 'Unanswerable question' } }, marker('a'));
    expect(job.active).toBe(false);
    expect(job.finished).toBe(true);
    expect(job.question).toBe(null);
    const legacy = { ...job, active: true, finished: false, question: { text: 'Old unanswered question', options: [] } };
    expect(jobState(legacy)).toEqual(jobState(job));
    expect(feedItems(legacy, epoch).some(item => item.key === 'pending-question')).toBe(false);
    expect(boundState({ jobs: [legacy], selectedId: 'a', nowMs: epoch }).jobs[0]?.active).toBe(false);
    expect(elapsed(job, epoch + 600000)).toBe('5s');
    expect(recentEndedJobIds([job], epoch + 60000)).toEqual(['a']);
    expect(feedItems(job, epoch).some(item => item.key === 'pending-question')).toBe(false);
    if (status === 'needs_input') {
      expect(jobState(job)).toEqual({ word: 'Needs input', color: 'warning' });
      expect(jobRow(job, false, 56, epoch).bullet).toBe('? ');
    }
  }
  const ended = jobView({ id: 'a', status: 'running', completedAt: createdAt, pendingQuestion: { text: 'Old' } }, marker('a'));
  expect(jobState(ended).word).toBe('Done');
  const unknown = jobView({ id: 'a', status: 'unrecognized', pendingQuestion: { text: 'Old' } }, marker('a'));
  expect(unknown.active).toBe(false);
  const queued = jobView({ id: 'q', status: 'queued' }, marker('q'));
  const state = { jobs: [queued], selectedId: 'q', nowMs: epoch, spinnerTick: 1 };
  expect(jobState(queued)).toEqual({ word: 'Queued', color: 'inactive' });
  expect(jobRow(queued, false, 56, epoch).bullet).toBe('… ');
  expect(statusLine([running(), queued])).toBe('Codex · 1 running · 1 queued');
  expect(footerLayout(queued, state, 120, true, 0)).toEqual(footerLayout(queued, { ...state, spinnerTick: 2 }, 120, true, 0));
});

test('D9 D10: overlapping identical invocations pair FIFO and abandoned tools are interrupted', () => {
  for (const type of ['commandExecution', 'mcpToolCall', 'dynamicToolCall']) {
    const base = { type, command: 'same', server: 's', tool: 'same', at: createdAt };
    const starts = [{ ...base, seq: 1, lifecycle: 'started' }, { ...base, seq: 2, lifecycle: 'started' }];
    const one = collapseActivity([...starts, { ...base, seq: 3, lifecycle: 'completed' }]);
    expect(one.map(event => event.seq)).toEqual([2, 3]);
    const paired = collapseActivity([...starts, { ...base, seq: 3, lifecycle: 'completed' }, { ...base, seq: 4, lifecycle: 'completed' }]);
    expect(paired.map(event => event.seq)).toEqual([3, 4]);
    expect(toolUseCount(paired)).toBe(2);
    const ended = jobView({ id: 'a', status: 'completed', activity: starts }, marker('a'));
    expect(eventItem(ended.events[0]!, ended, epoch + 60000)).toMatchObject({ color: 'inactive', results: [{ text: 'Interrupted', color: 'inactive' }] });
    for (const status of ['cancelled', 'declined']) {
      expect(eventItem({ ...base, seq: 1, status }, running(), epoch)).toMatchObject({ color: 'inactive', results: [{ text: 'Cancelled', color: 'inactive' }] });
    }
  }
});

test('D12: retained engine offsets 0, 1 and 5 pad above the pinned drawing', async ($, on) => {
  seed(on, { jobs: fourJobs(), selectedId: 'job-0', nowMs: epoch });
  const ui = await $.ui.mount({ plugin: 'codex-live', surface: 'terminal', component: 'Pane', requestId: 'codex-live', props: inlineProps });
  for (const offset of [0, 1, 5]) {
    await ui.redraw({ ...inlineProps, scroll: { offset, bodyRows: 14 } });
    const pane = (await ui.find({ key: 'pane' }))!;
    expect(pane.props.height).toBe(offset + 15);
    const children = pane.children.filter(child => typeof child !== 'string') as FoundElement[];
    let row = 0;
    const positions = new Map<string | undefined, number>();
    for (const child of children) { positions.set(child.props.key as string, row); row += Number(child.props.height); }
    expect(positions.get('header-job-0')).toBe(offset);
    expect(positions.get('footer')).toBe(offset + 13);
    expect(positions.get('scroll-sentinel')).toBe(offset + 14);
    await $.ui.scroll({ ...move(-1), offset });
    expect((await ui.find({ key: 'jump-bottom' }))?.text).toContain('Jump');
  }
  await ui.unmount();
});

test('grapheme widths include default emoji and never cut or wrap inside a cluster', () => {
  const emoji = '✅⌚⌛⏩⏪⏫⏬⏰⏳◽◾☔☕♈♓♿⚓⚡⚪⚫⚽⚾⛄⛅⛎⛔⛪⛲⛳⛵⛺⛽✊✋✨❌❎❓❔❕❗➕➖➗➰➿⬛⬜⭐⭕';
  for (const char of emoji) expect(width(char)).toBe(2);
  for (const cluster of ['👩‍💻', '🇺🇸', '1️⃣', '♥️', 'e\u0301']) {
    const size = cluster.startsWith('e') ? 1 : 2;
    expect(width(cluster)).toBe(size);
    expect(fit(cluster.repeat(3), size + 1)).toBe(`${cluster}…`);
    expect(messageLines(cluster.repeat(3), size).map(textOf)).toEqual([cluster, cluster, cluster]);
  }
  expect(messageLines('**e**\u0301x', 1).map(textOf)).toEqual(['e\u0301', 'x']);
  const capped = jobView({ id: 'a', status: 'running', activity: [{ seq: 1, type: 'agentMessage',
    text: 'x'.repeat(299) + '👩‍💻', body: 'x'.repeat(3999) + '👩‍💻' }] }, marker('a'));
  expect(capped.events[0]?.text).toBe('x'.repeat(299));
  expect(capped.events[0]?.body).toBe('x'.repeat(3999));
  expect(messageLines('**👩**‍💻x', 2).map(textOf)).toEqual(['👩‍💻', 'x']);
});

test('resize, plan shrink, identity-based new counts and clock ticks preserve stopped content', () => {
  const job = jobView({ id: 'a', status: 'running', startedAt: createdAt, activity: [
    { seq: 1, type: 'plan', steps: Array.from({ length: 40 }, (_, i) => `Step ${i}`) },
    { seq: 2, type: 'agentMessage', body: 'long words to wrap '.repeat(50) },
    { seq: 3, type: 'commandExecution', command: 'wait', lifecycle: 'started', at: createdAt },
  ] }, marker('a'));
  const lines = feedLines(job, epoch, 60);
  const stopped = { ...scrollFeed(lines, 8, undefined, -5, 14, 15), columns: 60 };
  const initial = feedWindow(lines, 8, stopped);
  const narrow = feedWindow(feedLines(job, epoch, 20), 8, stopped);
  expect(narrow.newLines).toBe(0);
  expect(narrow.lines[0]?.source).toBe(initial.lines[0]?.source);
  expect((narrow.lines[0]?.start ?? 0) <= stopped.anchor!.offset).toBe(true);
  const clockOnly = feedWindow(feedLines(job, epoch + 3600000, 60), 8, stopped);
  expect(clockOnly.newLines).toBe(0);
  expect(clockOnly.lines[0]?.key).toBe(initial.lines[0]?.key);
  const changed = { ...job, events: [...job.events.filter(event => event.type !== 'plan'),
    { seq: 4, type: 'plan', steps: ['One'] }, { seq: 5, type: 'agentMessage', text: 'New content' }] };
  const after = feedWindow(feedLines(changed, epoch, 60), 8, stopped);
  expect(after.offset <= after.bottom).toBe(true);
  expect(after.newLines > 0).toBe(true);
  expect(feedWindow(feedLines(job, epoch, 1000), 100, stopped).following).toBe(true);
  expect(feedWindow(feedLines(changed, epoch, 20), 8, { ...stopped, following: true }).following).toBe(true);
});

test('cross-surface scroll uses the originating surface width and anchors survive another rendering', async ($, on) => {
  const job = jobView({ id: 'a', status: 'running', activity: [{ seq: 1, type: 'agentMessage', body: 'x'.repeat(4000) }] }, marker('a'));
  seed(on, { jobs: [job], selectedId: 'a', nowMs: epoch });
  const writes = track(on);
  on('session.surface', () => ({ value: 'terminal' }));
  const terminal = await $.ui.mount({ plugin: 'codex-live', surface: 'terminal', component: 'Pane', requestId: 'codex-live', props });
  const desktop = await $.ui.mount({ plugin: 'codex-live', surface: 'desktop', component: 'Pane', requestId: 'codex-live', props: { ...props, bodyColumns: 120 } });
  await $.ui.scroll(move(-5, 16));
  expect(writes.at(-1)?.feeds?.a?.feedOffset).toBe(feedLines(job, epoch, 60).length - 15 - 5);
  expect(writes.at(-1)?.feeds?.a?.columns).toBe(60);
  const anchor = writes.at(-1)?.feeds?.a?.anchor;
  await desktop.redraw({ ...props, bodyColumns: 100 });
  expect(writes.at(-1)?.feeds?.a?.anchor).toEqual(anchor);
  await terminal.unmount(); await desktop.unmount();
});

test('history pagination makes all twenty retained jobs reachable and then collapses', async ($, on) => {
  const jobs = Array.from({ length: 20 }, (_, n) => jobView({ id: `h-${n}`, status: n ? 'completed' : 'running',
    completedAt: n ? new Date(epoch - 600000).toISOString() : undefined,
  }, { ...marker(`h-${n}`), createdAt: new Date(epoch - n * 1000).toISOString() }));
  seed(on, { jobs, selectedId: 'h-0', nowMs: epoch });
  const writes = track(on);
  const ui = await $.ui.mount({ plugin: 'codex-live', surface: 'terminal', component: 'Pane', requestId: 'codex-live', props: inlineProps });
  const reached = new Set<string>();
  await ui.press({ key: 'toggle-jobs' });
  for (let page = 0; page < 2; page++) {
    for (const row of await ui.findAll({ type: 'Button' })) if (row.key?.startsWith('h-')) reached.add(row.key);
    if (page === 1) { await ui.press({ key: 'h-19' }); expect(writes.at(-1)?.selectedId).toBe('h-19'); }
    await ui.press({ key: 'toggle-jobs' });
  }
  expect(reached.size).toBe(20);
  expect(writes.at(-1)?.jobsExpanded).toBe(false);
  expect(await ui.find({ key: 'h-19' })).toBeDefined();
  await ui.redraw({ ...inlineProps, scroll: { offset: 0, bodyRows: 2 } });
  await ui.press({ key: 'toggle-jobs' });
  expect(writes.at(-1)?.selectedId).toBe('h-0');
  await ui.unmount();
});

test('watermark-only hiding applies to history counts, paging and tiny cycling', async ($, on) => {
  const jobs = Array.from({ length: 20 }, (_, n) => jobView({ id: `visible-${n}`, status: n ? 'completed' : 'running',
    completedAt: n ? new Date(epoch - 500000).toISOString() : undefined,
  }, { ...marker(`visible-${n}`), createdAt: new Date(epoch - 900000 - n * 1000).toISOString() }));
  const hidden = Array.from({ length: 5 }, (_, n) => jobView({ id: `hidden-${n}`, status: 'blocked',
    completedAt: new Date(epoch - 600000).toISOString(),
  }, { ...marker(`hidden-${n}`), createdAt: new Date(epoch - 700000 - n * 1000).toISOString() }));
  seed(on, { jobs: [...hidden, ...jobs], selectedId: 'visible-0', nowMs: epoch, hiddenFinishedBefore: epoch - 600000 });
  const writes = track(on);
  const ui = await $.ui.mount({ plugin: 'codex-live', surface: 'terminal', component: 'Pane', requestId: 'codex-live', props: inlineProps });
  expect((await ui.find({ key: 'toggle-jobs' }))?.text).toBe('+19 more');
  await ui.press({ key: 'toggle-jobs' });
  const reached: string[] = [];
  for (let page = 0; page < 2; page++) {
    const buttons = await ui.findAll({ type: 'Button' });
    expect(buttons.some(button => button.key?.startsWith('hidden-'))).toBe(false);
    reached.push(...buttons.filter(button => button.key?.startsWith('visible-')).map(button => button.key!));
    expect((await ui.find({ key: 'toggle-jobs' }))?.text).toBe('+10 more');
    await ui.press({ key: 'toggle-jobs' });
  }
  expect(reached).toEqual(jobs.map(job => job.id));
  expect(writes.at(-1)?.jobsExpanded).toBe(false);
  await ui.redraw({ ...inlineProps, scroll: { offset: 0, bodyRows: 2 } });
  expect((await ui.find({ key: 'toggle-jobs' }))?.text).toBe('+19 more');
  await ui.press({ key: 'toggle-jobs' });
  expect(writes.at(-1)?.selectedId).toBe('visible-1');
  await ui.unmount();
});

test('an empty watermark-only view keeps the retention notice after hidden jobs are evicted', async ($, on) => {
  seed(on, { jobs: [], selectedId: null, nowMs: 0, hiddenFinishedBefore: epoch });
  const ui = await $.ui.mount({ plugin: 'codex-live', surface: 'terminal', component: 'Pane', requestId: 'codex-live',
    props: { ...props, bodyColumns: 100 } });
  expect((await ui.find({ key: 'transcript' }))?.text).toContain('No Codex jobs in this session yet.');
  expect((await ui.find({ key: 'hidden-notice' }))?.text).toBe('Finished jobs are hidden. Their records stay for 30 days.');
  expect(await ui.find({ key: 'clear-finished' })).toBe(undefined);
  expect(await ui.find({ key: 'toggle-jobs' })).toBe(undefined);
  await ui.unmount();
});

for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
  test(`named rows and Clear finished preserve selection and records on ${surface}`, async ($, on) => {
    const jobs = historyJobs().map(job => ({ ...job, agentName: job.id === 'running' ? 'Hopper' : 'Ada',
      label: 'OBJECTIVE: Repair ownership saves. Run verification.' }));
    seed(on, { jobs, selectedId: 'recent-done', nowMs: epoch });
    const writes = track(on);
    const ui = await $.ui.mount({ plugin: 'codex-live', surface, component: 'Pane', requestId: 'codex-live', props: {
      ...inlineProps, bodyColumns: 100, scroll: { offset: 0, bodyRows: 24 },
    } });
    expect((await ui.find({ key: 'running' }))?.text).toContain('Hopper  Repair ownership saves.');
    expect((await ui.find({ key: 'recent-done' }))?.text).not.toContain('OBJECTIVE:');
    expect((await ui.find({ key: 'job-header-body-0' }))?.text).toBe('⏺ Ada(Repair ownership saves.)');
    expect((await ui.find({ type: 'Text', text: /^Ada$/ }))?.props.bold).toBe(true);
    expect((await ui.find({ type: 'Text', text: /^\(Repair ownership saves\.\)$/ }))?.props.color).toBe('subtle');
    expect((await ui.find({ type: 'Text', text: /^  Repair ownership saves\.$/ }))?.props.color).toBe('subtle');
    expect((await ui.find({ key: 'clear-finished' }))?.props.plain).toBe(true);
    await ui.press({ key: 'clear-finished' });
    expect(writes.at(-1)?.hiddenJobIds).toEqual(jobs.slice(1).map(job => job.id));
    expect(writes.at(-1)?.selectedId).toBe('running');
    expect(writes.at(-1)?.jobs.length).toBe(jobs.length);
    expect((await ui.find({ key: 'job-header-body-0' }))?.text).toBe('⏺ Hopper(Repair ownership saves.)');
    expect((await ui.find({ key: 'footer' }))?.text).toContain('Hopper');
    expect(await ui.find({ key: 'toggle-jobs' })).toBe(undefined);
    expect(await ui.find({ key: 'clear-finished' })).toBe(undefined);
    await ui.unmount();
  });
}

test('clearing the final job shows the empty state and the dim retention notice', async ($, on) => {
  const job = { ...running(), status: 'completed', completedAt: createdAt };
  seed(on, { jobs: [job], selectedId: job.id, nowMs: epoch });
  const writes = track(on);
  const ui = await $.ui.mount({ plugin: 'codex-live', surface: 'terminal', component: 'Pane', requestId: 'codex-live',
    props: { ...props, bodyColumns: 100 } });
  await ui.press({ key: 'clear-finished' });
  expect(writes.at(-1)?.selectedId).toBe(null);
  expect((await ui.find({ key: 'transcript' }))?.text).toContain('No Codex jobs in this session yet.');
  const notice = await ui.find({ key: 'hidden-notice' });
  expect(notice?.text).toBe('Finished jobs are hidden. Their records stay for 30 days.');
  expect((await ui.findAll({ type: 'Text', text: /^Finished jobs are hidden/ })).some(text => text.props.color === 'subtle')).toBe(true);
  expect(rowBoxes(await ui.findAll({ type: 'Box' })).length).toBe(props.scroll.bodyRows + 1);
  await ui.unmount();
});

test('tiny heights put whole Clear finished and history controls in the footer', async ($, on) => {
  seed(on, { jobs: historyJobs(), selectedId: 'recent-done', nowMs: epoch });
  const ui = await $.ui.mount({ plugin: 'codex-live', surface: 'terminal', component: 'Pane', requestId: 'codex-live',
    props: { ...inlineProps, scroll: { offset: 0, bodyRows: 3 } } });
  expect((await ui.find({ key: 'footer' }))?.text).toContain('Clear finished');
  expect((await ui.find({ key: 'toggle-jobs' }))?.text).toBe('+4 more');
  for (const columns of [14, 25, 56]) {
    await ui.redraw({ ...inlineProps, bodyColumns: columns, scroll: { offset: 0, bodyRows: 3 } });
    expect((await ui.find({ key: 'clear-finished' }))?.text).toBe('Clear finished');
    expect(width((await ui.find({ key: 'footer' }))?.text ?? '') <= columns).toBe(true);
  }
  await ui.redraw({ ...inlineProps, bodyColumns: 12, scroll: { offset: 0, bodyRows: 3 } });
  expect(await ui.find({ key: 'clear-finished' })).toBe(undefined);
  expect((await ui.find({ key: 'toggle-jobs' }))?.text).toBe('+4 more');
  await ui.redraw({ ...inlineProps, scroll: { offset: 0, bodyRows: 3 } });
  await ui.press({ key: 'clear-finished' });
  expect(await ui.find({ key: 'clear-finished' })).toBe(undefined);
  expect(await ui.find({ key: 'toggle-jobs' })).toBe(undefined);
  await ui.unmount();
});

function conversationTurn(id: string, n: number, status = 'running', threadId = 'shared') {
  const time = new Date(epoch + n * 1000).toISOString();
  return jobView({ id, threadId, agentName: 'Euclid', status, startedAt: time,
    completedAt: status === 'completed' ? time : undefined,
    activity: [{ seq: 1, type: 'agentMessage', body: `Activity from turn ${n}.` }],
  }, { ...marker(id), createdAt: time, summary: `Turn ${n} task.` });
}

test('same-thread turns render one latest-status row and a chronological continuous transcript', async ($, on) => {
  const first = conversationTurn('first', 0, 'completed');
  const second = conversationTurn('second', 1);
  const state = { jobs: [second, first], selectedId: 'thread:shared', nowMs: epoch + 96000 };
  seed(on, state);
  const writes = track(on);
  const ui = await $.ui.mount({ plugin: 'codex-live', surface: 'terminal', component: 'Pane', requestId: 'codex-live',
    props: { ...props, bodyColumns: 100, scroll: { offset: 0, bodyRows: 30 } } });
  const headers = (await ui.findAll({ type: 'Box' })).filter(box => box.key?.startsWith('header-') && box.key !== 'header-rule');
  expect(headers.map(box => box.key)).toEqual(['header-thread:shared']);
  const row = await ui.find({ key: 'thread:shared' });
  expect(row?.text).toContain('❯ ⏺ Euclid  Turn 1 task.');
  expect(row?.text).toContain('2 turns · 1m 35s');
  expect((await ui.findAll({ type: 'Text' })).some(text => text.text === '⏺ ' && text.props.color === 'claude')).toBe(true);
  await ui.press({ key: 'thread:shared' });
  expect(writes.at(-1)?.selectedId).toBe('thread:shared');
  const transcript = (await ui.find({ key: 'transcript' }))!.text;
  const parts = ['Euclid(Turn 0 task.)', 'Activity from turn 0.', 'Euclid(Turn 1 task.)', 'Activity from turn 1.'];
  const positions = parts.map(part => transcript.indexOf(part));
  expect(positions.every(index => index >= 0)).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
  expect((await ui.find({ key: 'footer' }))?.text).toContain('Running… 1m 35s');
  expect(await ui.find({ key: 'clear-finished' })).toBe(undefined);
  const session = selectedJob(state)!;
  expect(jobRow(session, true, 24, state.nowMs).meta).toBe(' 1m 35s');
  for (const columns of [0, 1, 4, 12, 24, 40, 100]) {
    expect(width(Object.values(jobRow(session, true, columns, state.nowMs)).join('')) <= columns).toBe(true);
  }
  await ui.unmount();
});

test('latest turn alone determines session lifecycle, questions, status counts and clearing', () => {
  const old = { ...conversationTurn('old', 0), question: { text: 'Obsolete question', options: [] } };
  const latest = { ...conversationTurn('latest', 1), status: 'waiting', question: { text: 'Latest question', options: ['Yes'] } };
  const state = { jobs: [old, latest], selectedId: 'old', nowMs: epoch + 2000 };
  const session = selectedJob(state)!;
  expect(statusLine(state.jobs)).toBe('Euclid · 1 waiting for answer');
  expect(statusLine([old, { ...latest, status: 'queued', question: null }])).toBe('Euclid · 1 queued');
  expect(statusLine([old, { ...latest, status: 'running', question: null }])).toBe('Euclid · 1 running');
  const items = feedItems(session, state.nowMs);
  expect(JSON.stringify(items)).not.toContain('Obsolete question');
  expect(items.at(-1)?.results[0]?.text).toBe('Latest question');
  expect(footerLayout(session, state, 100, true, 0).left).toContain('Waiting for Claude');
  expect(visibleSessions(clearFinished(state, state.nowMs)).length).toBe(1);
  const done = { ...state, jobs: [old, conversationTurn('latest', 1, 'completed')] };
  expect(statusLine(done.jobs)).toBe(undefined);
  expect(selectedJob(done)?.finished).toBe(true);
  expect(jobRow(selectedJob(done)!, true, 100, done.nowMs).bullet).toBe('✓ ');
  const cleared = clearFinished(done, done.nowMs);
  expect(visibleJobs(cleared)).toEqual([]);
  expect(cleared.selectedId).toBe(null);
  const resumed = { ...cleared, jobs: [...cleared.jobs, conversationTurn('follow-up', 3)] };
  expect(visibleSessions(resumed).length).toBe(1);
  expect(selectedJob(resumed)?.turns.map(job => job.id)).toEqual(['old', 'latest', 'follow-up']);
});

test('unthreaded jobs stay separate and equal creation times have deterministic turn order', () => {
  const first = { ...conversationTurn('a', 0), threadId: undefined };
  const second = { ...conversationTurn('b', 0), threadId: '' };
  const third = { ...conversationTurn('c', 0), threadId: '   ' };
  expect(groupedSessions([first, second, third]).map(session => session.id)).toEqual(['a', 'b', 'c']);
  const sessions = groupedSessions([conversationTurn('z', 0), conversationTurn('a', 0)]);
  expect(sessions[0]?.turns.map(job => job.id)).toEqual(['a', 'z']);
  expect(sessions[0]?.label).toBe('Turn 0 task.');
});

test('legacy job selection and feed anchors render as their session before the first poll', async ($, on) => {
  const first = conversationTurn('first', 0, 'completed');
  first.events = [{ seq: 1, type: 'agentMessage', body: Array.from({ length: 40 }, (_, i) => `Old line ${i}`).join('\n') }];
  const second = conversationTurn('second', 1);
  const legacyLines = feedLines({ ...first, threadId: undefined }, epoch, 60);
  const legacyFeed = scrollFeed(legacyLines, 8, undefined, -20, 16, legacyLines.length);
  const state: CodexLiveState = { jobs: [conversationTurn('other', 2, 'running', 'other'), second, first],
    selectedId: 'first', nowMs: epoch, feeds: { first: { ...legacyFeed, columns: 60, rows: 8 } } };
  seed(on, state);
  const writes = track(on);
  const normalized = normalizeSessions(state);
  expect(normalized.selectedId).toBe('thread:shared');
  expect(normalized.feeds?.['thread:shared']?.anchor?.source).toBe('job:first:event-1-body');
  expect(normalizeSessions(normalized)).toEqual(normalized);
  const ui = await $.ui.mount({ plugin: 'codex-live', surface: 'terminal', component: 'Pane', requestId: 'codex-live', props });
  expect((await ui.find({ key: 'thread:shared' }))?.text).toContain('❯ ⏺ Euclid');
  expect((await ui.find({ key: 'transcript' }))?.text).toContain('Old line');
  expect(await ui.find({ key: 'jump-bottom' })).not.toBe(undefined);
  expect(writes.length).toBe(0);
  await $.ui.scroll(move(-1, 16));
  expect(writes.at(-1)?.selectedId).toBe('thread:shared');
  expect(writes.at(-1)?.feeds?.['thread:shared']?.following).toBe(false);
  expect(writes.at(-1)?.feeds?.first).toBe(undefined);
  expect(selectedJob({ ...state, selectedId: 'removed' })?.id).toBe('thread:other');
  await ui.unmount();
});

test('combined transcript anchors survive follow-ups, repeated sequence numbers and resizing', () => {
  const first = conversationTurn('first', 0);
  first.events = Array.from({ length: 30 }, (_, seq) => ({ seq, type: 'agentMessage', body: `First turn message ${seq}` }));
  const before = groupedSessions([first])[0]!;
  const lines = feedLines(before, epoch, 60);
  const stopped = scrollFeed(lines, 8, undefined, -20, 16, lines.length);
  const next = groupedSessions([conversationTurn('second', 1), first])[0]!;
  const nextLines = feedLines(next, epoch, 60);
  expect(new Set(nextLines.map(line => line.key)).size).toBe(nextLines.length);
  const reconciled = reconcileFeed(before, next, stopped, epoch);
  expect(reconciled.following).toBe(false);
  expect(reconciled.anchor).toEqual(stopped.anchor);
  expect(feedWindow(nextLines, 8, reconciled).newLines > 0).toBe(true);
  expect(feedWindow(feedLines(next, epoch + 5000, 40), 8, reconciled).view.anchor?.source).toBe(stopped.anchor?.source);
  const following = reconcileFeed(before, next, { feedOffset: 0, following: true, seenLines: 0 }, epoch);
  expect(following.following).toBe(true);
  expect(feedWindow(nextLines, 8, following).lines.at(-1)?.key).toBe(nextLines.at(-1)?.key);
});

test('selected-session turns share one serialized event budget and other sessions keep summaries', () => {
  const jobs = Array.from({ length: 4 }, (_, n) => {
    const job = conversationTurn(`turn-${n}`, n, 'running', n === 3 ? 'other' : 'shared');
    job.events = Array.from({ length: 200 }, (_, seq) => ({ seq, type: 'agentMessage', body: 'x'.repeat(4000) }));
    return job;
  });
  const state = boundState({ jobs: [...jobs].reverse(), selectedId: 'turn-0', nowMs: epoch });
  expect(state.selectedId).toBe('thread:shared');
  expect(state.jobs.filter(job => job.threadId === 'shared').every(job => job.detailsLoaded)).toBe(true);
  expect(state.jobs.find(job => job.id === 'turn-3')).toMatchObject({ events: [], detailsLoaded: false });
  expect(state.jobs.flatMap(job => job.events).reduce((size, event) => size + JSON.stringify(event).length, 0) <= 450000).toBe(true);
  expect(JSON.stringify(state).length < 900000).toBe(true);
  expect(state.jobs.find(job => job.id === 'turn-0')?.events[0]?.body).toBe('…');
  expect(state.jobs.find(job => job.id === 'turn-2')?.events.at(-1)?.body?.length).toBe(4000);
  expect(feedItems(selectedJob(state)!, epoch).filter(item => item.key.startsWith('job-header')).length).toBe(3);
});

test('23 turns retain twenty headers, five detailed turns and a subtle omission notice', async ($, on) => {
  const jobs = Array.from({ length: 23 }, (_, n) => conversationTurn(`turn-${n}`, n, 'completed'));
  const state = boundState({ jobs, selectedId: 'thread:shared', nowMs: epoch,
    feeds: { 'thread:shared': { feedOffset: 0, following: false, seenLines: 1000 } } });
  const selected = selectedJob(state)!;
  expect(selected.turnCount).toBe(23);
  expect(selected.turns.map(job => job.id)).toEqual(jobs.slice(3).map(job => job.id));
  expect(selected.turns.filter(job => job.detailsLoaded).map(job => job.id)).toEqual(jobs.slice(-5).map(job => job.id));
  expect(selected.turns.slice(0, 15).every(job => job.detailsOmitted && job.events.length === 0)).toBe(true);
  expect(jobRow(selected, true, 100, epoch).meta).toContain('23 turns');
  const items = feedItems(selected, epoch);
  expect(items[0]).toMatchObject({ title: '3 earlier turns not shown', color: 'subtle', notice: true });
  expect(items.filter(item => item.key.startsWith('job-header')).length).toBe(20);
  expect(items.filter(item => item.markdown !== undefined).map(item => item.markdown))
    .toEqual(jobs.slice(-5).map(job => job.events[0]!.body));
  expect(items.some(item => item.title === 'Loading transcript…')).toBe(false);
  expect(feedLines(selected, epoch, 100)[0]?.spans).toEqual([{ text: '3 earlier turns not shown', color: 'subtle' }]);
  seed(on, state);
  const ui = await $.ui.mount({ plugin: 'codex-live', surface: 'terminal', component: 'Pane', requestId: 'codex-live',
    props: { ...props, bodyColumns: 100 } });
  expect((await ui.find({ key: 'thread:shared' }))?.text).toContain('23 turns');
  expect((await ui.find({ key: 'earlier-turns' }))?.text).toBe('3 earlier turns not shown');
  await ui.unmount();
});

test('turn retention protects old active turns and the latest turn before applying its twenty-turn limit', () => {
  const jobs = Array.from({ length: 30 }, (_, n) => conversationTurn(`turn-${n}`, n, n === 0 ? 'running' : 'completed'));
  const state = boundState({ jobs, selectedId: 'thread:shared', nowMs: epoch });
  expect(state.jobs.length).toBe(20);
  expect(state.jobs.some(job => job.id === 'turn-0')).toBe(true);
  expect(state.jobs.some(job => job.id === 'turn-29')).toBe(true);
  expect(state.jobs.filter(job => job.detailsLoaded).length).toBe(5);
  const active = jobs.map(job => ({ ...job, status: 'running', completedAt: '' }));
  const protectedState = boundState({ jobs: active, selectedId: 'thread:shared', nowMs: epoch });
  expect(protectedState.jobs.length).toBe(30);
  expect(protectedState.jobs.every(job => job.active)).toBe(true);
  expect(protectedState.jobs.filter(job => job.detailsLoaded).length).toBe(5);
});

test('global state safety evicts finished sessions after exhausting removable history and protects active jobs', () => {
  const jobs = Array.from({ length: 900 }, (_, n) => ({
    ...conversationTurn(`session-${n}`, n, 'completed', `thread-${n}`), label: 'x'.repeat(1000),
  }));
  const active = { ...conversationTurn('active', -1), threadId: 'active', label: 'y'.repeat(1000) };
  const state = boundState({ jobs: [active, ...jobs], selectedId: 'thread:thread-899', nowMs: epoch });
  expect(JSON.stringify(state).length < 900000).toBe(true);
  expect(state.jobs.length < jobs.length).toBe(true);
  expect(state.jobs.some(job => job.id === 'session-0')).toBe(false);
  expect(state.jobs.some(job => job.id === 'session-899')).toBe(true);
  expect(state.jobs.some(job => job.id === 'active' && job.active)).toBe(true);
});
