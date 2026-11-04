import { test, expect } from 'claude-code/testing';
import { commandDisplay, fitCommand } from '../hooks/command';
import type { On } from 'claude-code';
import type { CodexLiveMarker, CodexLiveState, ForumRoom } from '../types';
import { attention, attentionCounts, boundState, clearFinished, groupedSessions, normalizeSessions, visibleJobs, visibleSessions,
  collapseActivity, isAbsolutePath, jobSummary, jobView, markerView, reusedAgentName, statusLine, validView } from '../hooks/model';
import { activityItems, eventItem, feedItems, feedLines, feedWindow, footerLayout, headerLayout, jobRow, jobRowColor, jobState,
  normalizeFeed, paneLayout, reconcileFeed, relativePath, scrollFeed, selectedJob, togglePrompt, toggleForumPosts, width, tableRow, timelineAxis, timelineSpans, emptyLines, sessionFooter } from '../hooks/layout';

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

const props = { title: 'Fugato', isFocused: true, bodyColumns: 60,
  placement: 'dock' as const, scroll: { offset: 0, bodyRows: 16 }, view: {} };

// Seed an unset or explicitly replaced read; writes still reach the real state bottom and redraw.
function seed(on: On, initial: CodexLiveState, replacement?: () => CodexLiveState | undefined) {
  on('clock.now', () => ({ value: epoch }));
  on('state.get', async ($, e, next) => {
    const result = await next(e);
    if (!('value' in result)) return result;
    const saved = (replacement?.() ?? result.value?.value ?? initial) as CodexLiveState;
    // Stand in for the poller's private transcript cache in render-only tests.
    // The poll integration tests exercise real selected-detail hydration.
    const jobs = saved.jobs.map(job => job.id === saved.selectedId && job.detailsLoaded === false
      ? initial.jobs.find(cached => cached.id === job.id) ?? job : job);
    return { value: { value: { ...saved, jobs }, version: result.value?.version ?? 0 } };
  });
}

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
const move = (by: number, bodyRows = 14) => ({ component: 'Pane' as const, requestId: 'fugato-live',
  offset: by < 0 ? 0 : 1, by, bodyRows, contentRows: bodyRows + 1, origin: { kind: 'person' as const } });

test('job status labels distinguish progress, attention and confirmed outcomes', async ($, on) => {
  for (const [status, word, color] of [
    ['queued', 'Queued', 'subtle'], ['running', 'Running', 'claude'], ['waiting', 'Waiting for Claude', 'warning'],
    ['completed', 'Done', 'success'], ['failed', 'Failed', 'error'], ['blocked', 'Needs your attention', 'error'],
    ['needs_input', 'Needs your attention', 'warning'], ['interrupted', 'Stopped', 'inactive'],
  ]) expect(jobState(jobView({ id: status, status }, marker(status)))).toEqual({ word, color });
  const question = 'Use the existing API?';
  const job = jobView({ id: 'job-a', status: 'running', pendingQuestion: { text: question } }, marker());
  expect(jobState(job)).toEqual({ word: 'Question for Claude', color: 'warning' });
  seed(on, { jobs: [job], selectedId: job.id, nowMs: epoch });
  const ui = await $.ui.mount({ plugin: 'fugato-live', surface: 'terminal', component: 'Pane', requestId: 'fugato-live', props });
  expect((await ui.find({ key: 'live-status' }))?.text).toContain('needs answer');
  expect((await ui.find({ key: 'transcript' }))?.text).toContain(question);
  await ui.unmount();
});

test('finished needs_input reports retain a terminal question separately from pending questions', () => {
  const question = 'x'.repeat(650) + ' Which deployment region should receive the fix?';
  const report = { status: 'needs_input', summary: 'A repository is required.', question };
  const captured = [{ seq: 1, type: 'agentMessage', body: report.summary, question }];
  const compactReport = { ...report, question: question.slice(0, 600) };
  expect(question.length).toBe(698);
  for (const fields of [{ report }, { activity: captured, report: compactReport },
    { result: { structured: report }, report: compactReport }]) {
    const job = jobView({ id: 'job-a', status: 'needs_input', completedAt: createdAt,
      pendingQuestion: { text: 'Obsolete pending question' }, ...fields }, marker());
    expect(job).toMatchObject({ active: false, finished: true, question: null, terminalQuestion: question });
    expect(attentionCounts([job])).toEqual({ question: 0, blocked: 1, unresolved: 0 });
    const state = boundState({ jobs: [job], selectedId: job.id, nowMs: epoch });
    expect(validView(state)).toBe(true);
    expect(jobSummary(job).terminalQuestion?.endsWith('…')).toBe(true);
    const items = feedItems(selectedJob(state)!, epoch);
    expect(items.at(-1)).toMatchObject({ key: 'terminal-question', results: [{ text: question, color: 'subtle' }] });
    expect(items.some(item => item.key === 'pending-question')).toBe(false);
    expect(feedLines(selectedJob(state)!, epoch, 1000).flatMap(line => line.spans).map(span => span.text).join('')).toContain(question);
  }
  const truncated = jobView({ id: 'job-a', status: 'needs_input',
    report: { ...report, question: 'x'.repeat(2100) } }, marker()).terminalQuestion!;
  expect(truncated.length).toBe(2000);
  expect(truncated.endsWith('…')).toBe(true);
});

test('clearing the final job hides its row and retains its record', async ($, on) => {
  const job = { ...running(), status: 'completed', completedAt: createdAt };
  seed(on, { jobs: [job], selectedId: job.id, nowMs: epoch });
  const writes = track(on);
  const ui = await $.ui.mount({ plugin: 'fugato-live', surface: 'terminal', component: 'Pane', requestId: 'fugato-live', props });
  await ui.press({ key: 'clear-finished' });
  expect(writes.at(-1)?.selectedId).toBe(null);
  expect(writes.at(-1)?.jobs.map(job => job.id)).toEqual([job.id]);
  expect((await ui.find({ key: 'empty-message' }))?.text).toBe('    No workers yet. They enter here when Claude starts one.');
  expect((await ui.find({ key: 'empty-commands' }))?.text).toBe('    /fugato:pair <task>  ·  /fugato:roundtable <task>');
  expect(emptyLines(60).slice(0, 4).map(line => width(line.spans[0]!.text))).toEqual([28, 28, 28, 28]);
  expect((await ui.find({ key: 'footer' }))?.text).toContain('this session');
  expect(await ui.find({ key: 'clear-finished' })).toBe(undefined);
  await ui.unmount();
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

test('live and unresolved members control lifecycle, pending questions, status counts and clearing', async ($, on) => {
  const old = { ...conversationTurn('old', 0), question: { text: 'Obsolete question', options: [] } };
  const latest = jobView({ id: 'latest', threadId: 'shared', status: 'waiting',
    pendingQuestion: { text: 'Continue?', options: ['Yes', { label: 'No' }] } }, marker('latest'));
  latest.createdAt = new Date(epoch + 1000).toISOString();
  const state = { jobs: [old, latest], selectedId: 'old', nowMs: epoch + 2000 };
  const session = selectedJob(state)!;
  expect(session.question).toEqual({ text: 'Continue?', options: ['Yes', 'No'] });
  expect(feedItems(session, epoch).at(-1)?.results[0]?.text).toBe('Continue?');
  expect(JSON.stringify(feedItems(session, epoch))).not.toContain('Obsolete question');
  const queued = jobView({ id: 'queued', status: 'queued' }, marker('queued'));
  const countedJobs = [...state.jobs, running(), queued];
  const sessions = groupedSessions(countedJobs);
  expect(sessions.filter(job => job.active && job.status === 'running' && !job.question).length).toBe(1);
  expect(sessions.filter(job => job.active && job.status === 'queued' && !job.question).length).toBe(1);
  expect(attentionCounts(countedJobs)).toEqual({ question: 1, blocked: 0, unresolved: 0 });
  const terminalAttention = ['needs_input', 'blocked'].map(status => jobView({ id: status, status,
    pendingQuestion: { text: 'Stale question' }, completedAt: createdAt }, marker(status)));
  const unknown = jobView({ id: 'unknown', jobClass: 'task', status: 'failed' }, marker('unknown'));
  expect(terminalAttention.map(attention)).toEqual(['blocked', 'blocked']);
  expect(terminalAttention.every(job => job.question === null && job.finished)).toBe(true);
  expect(attention(unknown)).toBe('unresolved');
  expect(attentionCounts([...countedJobs, ...terminalAttention, unknown], 3))
    .toEqual({ question: 1, blocked: 5, unresolved: 1 });
  expect(attentionCounts([])).toEqual({ question: 0, blocked: 0, unresolved: 0 });
  expect(visibleSessions(clearFinished(state, state.nowMs)).length).toBe(1);
  const done = { ...state, jobs: [old, { ...latest, status: 'needs_input', completedAt: createdAt }] };
  expect(selectedJob(done)).toMatchObject({ active: true, finished: false, lifecycleJobId: old.id });
  expect(jobView({ id: 'terminal', status: 'needs_input', pendingQuestion: { text: 'Old' } }, marker('terminal')).question).toBe(null);
  expect(feedItems(selectedJob(done)!, epoch).some(item => item.key.endsWith(':pending-question'))).toBe(true);
  expect(statusLine(done.jobs)).toBe(statusLine([old]));
  const cleared = clearFinished(done, state.nowMs);
  expect(visibleJobs(cleared).map(job => job.id)).toEqual(['old', 'latest']);
  expect(statusLine(visibleJobs(cleared))).toBe(statusLine(done.jobs));
  expect(cleared.selectedId).toBe('thread:shared');
  const resumed = { ...cleared, jobs: [...cleared.jobs, conversationTurn('follow-up', 3)] };
  expect(selectedJob(resumed)?.turns.map(job => job.id)).toEqual(['old', 'latest', 'follow-up']);
  expect(jobView({ id: 'answered', status: 'waiting', pendingQuestion: { text: 'Answered', answer: '' } }, marker('answered')).question).toBe(null);

  const refusals = Array.from({ length: 7 }, (_, n) => jobView({ id: `refusal-${n}`, threadId: 'shared', status: 'blocked',
    completedAt: new Date(epoch + 3000 + n).toISOString(), result: { blockers: [{ code: 'thread_busy' }] } },
  { ...marker(`refusal-${n}`), createdAt: new Date(epoch + 3000 + n).toISOString() }));
  const refused = boundState({ ...state, jobs: [...state.jobs, ...refusals] });
  const owner = selectedJob(refused)!;
  expect(owner).toMatchObject({ active: true, finished: false, lifecycleJobId: latest.id, question: latest.question });
  expect(refused.jobs.find(job => job.id === latest.id)?.detailsLoaded).toBe(true);
  expect(refused.jobs.filter(job => job.detailsLoaded).length).toBe(5);
  expect(feedItems(owner, epoch).some(item => item.key.endsWith(':pending-question'))).toBe(true);
  expect(visibleJobs(clearFinished(refused, epoch + 10000)).length).toBe(refused.jobs.length);
  const ended = { ...state, jobs: [conversationTurn('old', 0, 'completed'), ...refusals] };
  expect(selectedJob(ended)).toMatchObject({ status: 'completed', lifecycleJobId: 'old' });
  expect(visibleJobs(clearFinished(ended, epoch + 10000))).toEqual([]);

  for (const fields of [
    { status: 'completed', result: { inferredCompletion: true, turnEnded: false } },
    { status: 'failed', result: { failureSource: 'transport', turnEnded: false } },
    { status: 'interrupted', turnId: null, turnSubmission: { at: createdAt }, result: { turnEnded: false, interruptionConfirmed: false } },
  ]) {
    const raw = { id: 'lost', jobClass: 'task', threadId: 'shared', turnId: 'turn', completedAt: createdAt, ...fields };
    const lost = jobView(raw, marker('lost'));
    expect(lost).toMatchObject({ unresolved: true, finished: false, active: false });
    expect(jobState(lost).word).toBe('Outcome unknown');
    const unresolved = boundState({ jobs: [lost, ...refusals], selectedId: 'thread:shared', nowMs: epoch });
    expect(selectedJob(unresolved)?.lifecycleJobId).toBe('lost');
    expect(visibleJobs(clearFinished(unresolved, epoch + 10000)).length).toBe(unresolved.jobs.length);
    expect(jobView({ ...raw, recovered: true }, marker('lost')).finished).toBe(true);
    expect(jobView({ ...raw, result: { ...fields.result, turnEnded: true } }, marker('lost')).finished).toBe(true);
  }
  expect(jobView({ id: 'pending-cancelled', jobClass: 'task', status: 'cancelled',
    turnSubmission: { at: createdAt } }, marker('pending-cancelled')))
    .toMatchObject({ status: 'unresolved', unresolved: true, finished: false, active: false });

  const pending = { id: 'expires', status: 'running', pendingQuestion: { text: 'Continue?', expiresAt: epoch + 1000 } };
  const expires = jobView(pending, marker('expires'), true, epoch);
  expect(expires.question?.expiresAt).toBe(epoch + 1000);
  expect(jobSummary(expires).question?.expiresAt).toBe(epoch + 1000);
  expect(jobView(pending, marker('expires'), true, epoch + 1000).question).toBe(null);
  const expired = boundState({ jobs: [expires], selectedId: expires.id, nowMs: epoch + 1000 });
  expect(expired.jobs[0]?.question).toBe(null);
  expect(attentionCounts(expired.jobs).question).toBe(0);
  expect(feedItems(selectedJob(expired)!, expired.nowMs).some(item => item.key.endsWith(':pending-question'))).toBe(false);
  expect(validView({ ...expired, jobs: [{ ...expires, question: { ...expires.question, expiresAt: 'bad' } }] })).toBe(false);
  const coded = ['needs_input', 'blocked'].map((status, i) => jobView({ id: status, status, completedAt: createdAt,
    [i ? 'result' : 'report']: { blockers: [{ code: 'provider_refused' }, { code: 'ignored' }] } }, marker(status)));
  expect(coded.map(job => job.blockerCode)).toEqual(['provider_refused', 'provider_refused']);
  expect(coded.map(jobRowColor)).toEqual(['warning', 'error']);
  const codedState = boundState({ jobs: coded, selectedId: coded[0]!.id, nowMs: epoch });
  expect(validView(codedState)).toBe(true);
  expect(codedState.jobs.map(job => job.blockerCode)).toEqual(['provider_refused', 'provider_refused']);
  for (const job of coded) expect(feedLines(job, epoch, 200).flatMap(line => line.spans).map(span => span.text).join('')).toContain(job.blockerCode!);
  for (const code of ['', 'invalid code', 'bad\ncode', 'x'.repeat(65), '<bad>', 12]) {
    const malformed = jobView({ id: 'bad', status: 'blocked', report: { blockers: [{ code }] } }, marker('bad'));
    expect(malformed.blockerCode).toBe(undefined);
    expect(validView({ ...codedState, jobs: [{ ...coded[0]!, blockerCode: code }] })).toBe(false);
  }
  seed(on, codedState);
  const ui = await $.ui.mount({ plugin: 'fugato-live', surface: 'terminal', component: 'Pane', requestId: 'fugato-live', props });
  const texts = await ui.findAll({ type: 'Text' });
  const bullet = '? ';
  expect(texts.filter(text => text.text === bullet).map(text => text.props.color))
    .toEqual(['warning']);
  await ui.unmount();
});

test('attention keeps an old waiting worker visible with its question and orders unanswered questions by age', () => {
  const question = 'Use the existing API?';
  const jobs = [
    { id: 'waiting', status: 'waiting', ago: 720000,
      pendingQuestion: { text: question, expiresAt: epoch + 890000 } },
    { id: 'blocked', status: 'blocked', ago: 600000, completedAt: new Date(epoch - 300000).toISOString() },
    { id: 'tests', status: 'running', ago: 400000 },
    { id: 'build', status: 'running', ago: 300000 },
    { id: 'quiet', status: 'running', ago: 200000 },
  ].map(({ ago, ...job }) => jobView(job, { ...marker(job.id), createdAt: new Date(epoch - ago).toISOString() }, false, epoch));
  const state = boundState({ jobs, selectedId: 'tests', nowMs: epoch });
  const header = headerLayout(state, selectedJob(state)!, 14);
  expect(header.jobs.map(job => job.id)).toEqual(['waiting', 'blocked', 'tests']);
  expect(header.jobs[0]?.question?.text).toBe(question);
  expect(header.jobs[0]?.events).toEqual([]);
  expect(state.selectedId).toBe('tests');

  // A newer worker's older approval takes priority over worker creation order.
  const approval = jobView({ id: 'build', status: 'running', questionTimeoutSec: 60,
    pendingQuestion: { text: 'Allow access?', kind: 'approval', expiresAt: epoch + 40000 },
  }, { ...marker('build'), createdAt: jobs[3]!.createdAt }, false, epoch);
  const next = boundState({ ...state, jobs: state.jobs.map(job => job.id === 'build' ? approval : job) });
  expect(headerLayout(next, selectedJob(next)!, 14).jobs.map(job => job.id)).toEqual(['build', 'waiting', 'tests']);
  expect(headerLayout({ ...next, jobsExpanded: true }, selectedJob(next)!, 14).jobs.map(job => job.id))
    .toEqual(['build', 'waiting', 'blocked', 'quiet', 'tests']);
});

test('overlapping tool invocations remain distinct and completed jobs stop abandoned tools', () => {
  const base = { type: 'commandExecution', command: 'same', at: createdAt };
  const starts = [{ ...base, seq: 1, lifecycle: 'started' }, { ...base, seq: 2, lifecycle: 'started' }];
  const events = [...starts, { seq: 3, type: 'agentMessage', text: 'Still working' },
    { ...base, seq: 4, lifecycle: 'completed', exitCode: 1 }];
  expect(collapseActivity(events).map(event => event.seq)).toEqual([2, 3, 4]);
  const job = jobView({ id: 'a', status: 'completed', activity: events }, marker('a'));
  expect(activityItems(job).map(event => event.seq)).toEqual([2, 3, 4]);
  expect(eventItem(job.events[0]!, job, epoch).color).toBe('inactive');
  expect(eventItem(job.events.at(-1)!, job, epoch).color).toBe('error');
});

test('command outcomes retain warning and failure labels without inventing success', () => {
  for (const [status, exitCode, lifecycle, color, text] of [
    ['completed', null, 'completed', 'warning', 'exit ?'],
    ['completed', 0, 'completed', 'success', '✓'],
    ['completed', 9, 'completed', 'error', '✗ exit 9'],
    ['inProgress', undefined, 'started', 'claude', 'running —'],
    ['cancelled', undefined, 'completed', 'inactive', 'cancelled'],
  ] as const) {
    const item = eventItem({ seq: 1, type: 'commandExecution', command: 'echo check', status, exitCode, lifecycle }, running(), epoch);
    expect(item.color).toBe(color);
    expect(item.results[0]!.text).toBe(text);
  }
  const raw = '/bin/zsh -lc "node --test /workspace/tests/really-long-integration-test-file-name.mjs"';
  const job = jobView({ id: 'a', status: 'completed', completedAt: createdAt, activity: [
    { seq: 1, type: 'agentMessage', body: 'Checking the change.' },
    { seq: 2, type: 'commandExecution', command: raw, exitCode: 0, lifecycle: 'completed', durationMs: 999 },
    { seq: 3, type: 'fileChange', path: '/workspace/hooks/layout.ts', added: 6, removed: 1, status: 'completed' },
    { seq: 4, type: 'agentMessage', body: 'All checks passed.' },
  ] }, marker('a'));
  for (const columns of [100, 60, 40]) {
    const rows = feedLines(job, epoch, columns), text = rows.map(line => line.spans.map(span => span.text).join(''));
    const command = rows.findIndex(line => line.key === 'event-2-body-0');
    expect(text[command]!.startsWith('  › node ')).toBe(true);
    expect(text[command]!.endsWith(' ✓')).toBe(true);
    expect(width(text[command]!)).toBe(columns);
    expect(rows[command + 1]?.key).toBe('event-3-body-0');
    expect(text[command + 1]!.startsWith('  › edit hooks/layout.ts')).toBe(true);
    expect(text[command + 1]!.endsWith('+6 −1')).toBe(true);
    expect(text[command + 1]!).not.toContain('✓');
    expect(rows[command + 1]?.spans.some(span => span.text === '+6' && span.color === 'diffAdded')).toBe(true);
    expect(rows[command + 1]?.spans.some(span => span.text === '−1' && span.color === 'diffRemoved')).toBe(true);
    expect(rows[command + 1]?.spans.some(span => span.text === 'layout.ts' && span.color === 'text')).toBe(true);
    expect(text.some(line => /[⎿└]|Done/.test(line))).toBe(false);
    const created = feedLines(jobView({ id: 'n', status: 'running', activity: [{ seq: 1, type: 'fileChange', path: '/workspace/new.ts', added: 2, removed: 0, status: 'completed' }] }, marker('n')), epoch, columns)
      .map(line => line.spans.map(span => span.text).join('')).find(line => line.includes('edit new.ts'));
    expect(created?.endsWith(' +2')).toBe(true);
    expect(rows.find(line => line.key === 'event-4-body-0')?.spans[0]).toMatchObject({ text: '▏', color: 'success' });
  }
  for (const exitCode of [9, undefined]) {
    const failed = jobView({ id: 'a', status: 'running', activity: [{ seq: 1, type: 'fileChange', path: '/workspace/layout.ts', status: 'failed', exitCode, added: 6, removed: 1 }] }, marker('a'));
    const row = feedLines(failed, epoch, 60).find(line => line.key === 'event-1-body-0')!;
    expect(row.spans.map(span => span.text).join('')).toBe('  › edit layout.ts'.padEnd(exitCode === undefined ? 53 : 52) + (exitCode === undefined ? '✗ error' : '✗ exit 9'));
    expect(row.spans.some(span => span.text === 'layout.ts' && span.color === 'text')).toBe(true);
  }
  expect(job.events[1]?.command).toBe(raw);
  const failure = feedLines({ ...job, status: 'blocked' }, epoch, 60).find(line => line.key === 'event-4-body-0');
  expect(failure?.spans[0]).toMatchObject({ text: '▏', color: 'error' });
  const explored = feedItems(jobView({ id: 'a', status: 'completed', activity: [
    { seq: 1, type: 'commandExecution', command: "/bin/zsh -lc 'rg one'", exitCode: 0, lifecycle: 'completed', durationMs: 700 },
    { seq: 2, type: 'commandExecution', command: '/bin/zsh -lc "rg two"', exitCode: 0, lifecycle: 'completed', durationMs: 800 },
    { seq: 3, type: 'commandExecution', command: `/bin/zsh -lc "sed -n '1,80p' a.ts"`, exitCode: 0, lifecycle: 'completed', durationMs: 1000 },
  ] }, marker('a')), epoch).find(item => item.rowKind === 'explored');
  expect(explored?.title).toBe('explored 3 commands · rg ×2, sed');
  expect(explored?.results[0]?.text).toBe('✓ 2s');
  const environment = jobView({ id: 'a', status: 'completed', activity: [
    `/bin/zsh -lc 'LANG=C env -u TEST rg one'`, `/bin/zsh -lc 'env -i LC_ALL=C cat README.md'`,
  ].map((command, i) => ({ seq: i + 1, type: 'commandExecution', command, exitCode: 0, lifecycle: 'completed' })) }, marker('a'));
  expect(feedItems(environment, epoch).find(item => item.rowKind === 'explored')?.title).toBe('explored 2 commands · rg, cat');
});

test('legacy tool totals count all retained paired events beyond the transcript cap', () => {
  const activity = Array.from({ length: 201 }, (_, index) => [
    { seq: index * 2, type: 'commandExecution', command: `echo ${index}`, lifecycle: 'started' },
    { seq: index * 2 + 1, type: 'commandExecution', command: `echo ${index}`, lifecycle: 'completed', exitCode: 0 },
  ]).flat();
  const raw = { id: 'job-a', status: 'completed', activity };
  const job = jobView(raw, marker());
  expect(job.events.length).toBe(200);
  expect(job.toolUses).toBe(201);
  expect(jobView(raw, marker(), false).toolUses).toBe(201);
  expect(jobView({ ...raw, activityTotals: { toolUses: 999 } }, marker()).toolUses).toBe(999);
});

test('transcript projection rejects bad identities, bounds events and preserves safe Unicode content', () => {
  const activity = Array.from({ length: 230 }, (_, seq) => ({ seq, type: 'agentMessage', body: 'x'.repeat(3999) + '👩‍💻' }));
  const job = jobView({ id: 'job-a', status: 'running', activity }, marker());
  expect(JSON.stringify(running())).not.toContain('must not enter state');
  expect(job.events.length).toBe(200);
  expect(job.events[0]?.seq).toBe(30);
  expect(job.events.at(-1)?.body).toBe('x'.repeat(3999) + '…');
  const message = 'x'.repeat(4030);
  const captured = { seq: 1, type: 'agentMessage', body: 'x'.repeat(3999) + '…' };
  for (const event of [captured, { seq: 1, type: 'agentMessage', body: message }]) {
    const projected = jobView({ id: 'job-a', status: 'completed', activity: [{ ...event, seq: 1 }] }, marker());
    expect(projected.events[0]?.body?.length).toBe(4000);
    expect(eventItem(projected.events[0]!, projected, epoch).markdown?.endsWith('…')).toBe(true);
    expect(feedLines(projected, epoch, 80).flatMap(line => line.spans).map(span => span.text).join('').endsWith('…')).toBe(true);
  }
  expect(() => jobView({ id: 'other' }, marker())).toThrow();
  expect(() => markerView({ v: 1, jobId: 'a', jobFile: 'relative.json' })).toThrow();
  const absolutePaths = ['/jobs/a.json', 'C:\\Users\\x\\jobs\\a.json', 'C:/Users/x/jobs/a.json', '\\\\server\\share\\jobs\\a.json'];
  expect(absolutePaths.map(jobFile => {
    try {
      const parsed = markerView({ v: 1, jobId: 'a', jobFile, workspaceRoot: jobFile });
      return [parsed.jobFile, parsed.workspaceRoot];
    } catch { return null; }
  })).toEqual(absolutePaths.map(path => [path, path]));
  for (const path of [...absolutePaths, '/', 'C:\\', 'C:/', '\\\\server\\share']) expect(isAbsolutePath(path)).toBe(true);
  for (const path of ['', 'jobs/a.json', 'C:jobs\\a.json', '\\jobs\\a.json', '\\\\server', '\\\\server\\',
    '\\\\\\server\\share\\a.json', '/jobs/a\0.json', 'C:\\jobs\\a\0.json', '\\\\server\\share\\a\0.json']) {
    expect(isAbsolutePath(path)).toBe(false);
    expect(() => markerView({ v: 1, jobId: 'a', jobFile: path })).toThrow();
    expect(markerView({ v: 1, jobId: 'a', jobFile: '/jobs/a.json', workspaceRoot: path }).workspaceRoot).toBe(undefined);
  }
  for (const [path, root, relative] of [
    ['/workspace/src/../a.ts', '/workspace', 'a.ts'],
    ['/Workspace/a.ts', '/workspace', '/Workspace/a.ts'],
    ['/workspace/a\\b.ts', '/workspace', 'a\\b.ts'],
    ['C:\\Repo\\src\\File.ts', 'c:/repo', 'src/File.ts'],
    ['C:/REPO/src/../File.ts', 'C:\\Repo', 'File.ts'],
    ['C:/src/File.ts', 'c:\\', 'src/File.ts'],
    ['C:/Repo-other/File.ts', 'C:/Repo', 'C:/Repo-other/File.ts'],
    ['D:/Repo/File.ts', 'C:/Repo', 'D:/Repo/File.ts'],
    ['C:/Repo/../File.ts', 'C:/Repo', 'C:/Repo/../File.ts'],
    ['\\\\SERVER\\share\\repo\\src\\File.ts', '\\\\server\\SHARE\\repo', 'src/File.ts'],
    ['\\\\server\\other\\repo\\File.ts', '\\\\server\\share\\repo', '\\\\server\\other\\repo\\File.ts'],
    ['\\\\server\\share\\..\\repo\\File.ts', '\\\\server\\share\\repo', 'File.ts'],
  ]) expect(relativePath(path!, root)).toBe(relative);
  const clean = jobView({ id: 'job-a', status: 'running', activity: [{ seq: 1, type: 'agentMessage',
    body: '\u001b[31m# 修复 👩‍💻\r\n- é\u0000\u202e' }] }, marker());
  expect(clean.events[0]?.body).toBe('# 修复 👩‍💻\n- é  ');
  const rendered = feedLines(clean, epoch, 12).filter(line => line.source === 'event-1-body');
  expect(rendered.every(line => width(line.spans.map(span => span.text).join('')) <= 12)).toBe(true);
  expect(rendered.flatMap(line => line.spans).map(span => span.text).join('')).toContain('👩‍💻');
  const row = jobRow({ ...clean, agentName: '艾达 👩‍💻', lastActivityAt: createdAt,
    question: { text: '检查 é?', options: [] } }, false, 12, epoch + 120000, true);
  expect(width(row.map(span => span.text).join('')) <= 12).toBe(true);

  for (const agentName of ['Tesla-3', 'Tesla-12']) expect(reusedAgentName(jobView({ id: 'job-a', status: 'running', agentName }, marker()))).toBe(true);
  for (const agentName of [undefined, 'Tesla', 'Tesla3', 'Tesla-three', 'Tesla-3-more']) {
    expect(reusedAgentName(jobView({ id: 'job-a', status: 'running', agentName }, marker()))).toBe(false);
  }
  expect(reusedAgentName(jobView({ id: 'job-a', status: 'running' }, { ...marker(), name: 'Tesla-3' }))).toBe(true);
});

test('pane navigation preserves each selection and resumes following', async ($, on) => {
  seed(on, { jobs: fourJobs(), selectedId: 'job-0', nowMs: epoch });
  const writes = track(on);
  const ui = await $.ui.mount({ plugin: 'fugato-live', surface: 'terminal', component: 'Pane', requestId: 'fugato-live', props: inlineProps });
  await $.ui.scroll(move(-5));
  const stopped = writes.at(-1)?.feeds?.['job-0'];
  expect(stopped?.following).toBe(false);
  await ui.press({ key: 'job-1' });
  expect(writes.at(-1)?.selectedId).toBe('job-1');
  expect(writes.at(-1)?.feeds?.['job-0']?.anchor).toEqual(stopped?.anchor);
  await ui.press({ key: 'job-0' });
  await ui.press({ key: 'jump-bottom' });
  expect(writes.at(-1)?.feeds?.['job-0']?.following).toBe(true);
  expect(await ui.find({ key: 'jump-bottom' })).toBe(undefined);
  await ui.unmount();
});

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
  const ui = await $.ui.mount({ plugin: 'fugato-live', surface: 'terminal', component: 'Pane', requestId: 'fugato-live', props });
  expect(JSON.stringify(await ui.drawn()).length < 100000).toBe(true);
  await $.ui.scroll(move(-17, 16));
  expect((await ui.find({ key: 'transcript' }))?.text).toContain('20:');
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
  expect(feedWindow(lines.slice(0, 2), 8, stopped).offset).toBe(0);
  expect(scrollFeed(lines.slice(0, 2), 8, stopped, 1, 14, 15).following).toBe(true);
  expect(feedWindow(feedLines(job, epoch, 1000), 100, stopped).following).toBe(true);
  expect(feedWindow(feedLines(changed, epoch, 20), 8, { ...stopped, following: true }).following).toBe(true);
});

test('cross-surface scroll uses the originating surface width and anchors survive another rendering', async ($, on) => {
  const job = jobView({ id: 'a', status: 'running', activity: [{ seq: 1, type: 'agentMessage', body: 'x'.repeat(4000) }] }, marker('a'));
  seed(on, { jobs: [job], selectedId: 'a', nowMs: epoch });
  const writes = track(on);
  on('session.surface', () => ({ value: 'terminal' }));
  const terminal = await $.ui.mount({ plugin: 'fugato-live', surface: 'terminal', component: 'Pane', requestId: 'fugato-live', props });
  const desktop = await $.ui.mount({ plugin: 'fugato-live', surface: 'desktop', component: 'Pane', requestId: 'fugato-live', props: { ...props, bodyColumns: 120 } });
  await $.ui.scroll(move(-5, 16));
  expect(writes.at(-1)?.feeds?.a?.feedOffset).toBe(feedLines(job, epoch, 60).length - paneLayout({ jobs: [job], selectedId: 'a', nowMs: epoch }, job, 16).rows - 5);
  expect(writes.at(-1)?.feeds?.a?.columns).toBe(60);
  const anchor = writes.at(-1)?.feeds?.a?.anchor;
  await desktop.redraw({ ...props, bodyColumns: 100 });
  expect(writes.at(-1)?.feeds?.a?.anchor).toEqual(anchor);
  await terminal.unmount(); await desktop.unmount();
});

test('history paging reaches retained jobs, excludes cleared history and keeps tiny controls usable', async ($, on) => {
  const jobs = Array.from({ length: 20 }, (_, n) => jobView({ id: `h-${n}`, status: n ? 'completed' : 'running',
    completedAt: n ? new Date(epoch - 500000).toISOString() : undefined,
  }, { ...marker(`h-${n}`), createdAt: new Date(epoch - n * 1000).toISOString() }));
  const hidden = jobView({ id: 'hidden', status: 'completed', completedAt: new Date(epoch - 600000).toISOString() }, marker('hidden'));
  const forumRooms: ForumRoom[] = Array.from({ length: 3 }, (_, n) => ({ roomId: `rt-a-${n}`, sessionId: 'session-a',
    goal: 'Review the release', status: 'open', intensity: 'standard', members: ['critic'], createdAt, postCount: 0 }));
  const navigationState: CodexLiveState = { jobs: [jobs[0]!, { ...jobs[1]!, status: 'running', completedAt: '', active: true, finished: false }],
    forumRooms, selectedId: 'forum:rt-a-0', nowMs: epoch };
  let navigationAtWrite = -1;
  seed(on, { jobs: [hidden, ...jobs], selectedId: 'h-0', nowMs: epoch, hiddenFinishedBefore: epoch - 600000 },
    () => writes.length === navigationAtWrite ? navigationState : undefined);
  const writes = track(on);
  const ui = await $.ui.mount({ plugin: 'fugato-live', surface: 'terminal', component: 'Pane', requestId: 'fugato-live', props: inlineProps });
  const reached = new Set<string>();
  await ui.press({ key: 'toggle-jobs' });
  const pages = paneLayout({ jobs: [hidden, ...jobs], selectedId: 'h-0', nowMs: epoch, jobsExpanded: true, hiddenFinishedBefore: epoch - 600000 }, jobs[0], inlineProps.scroll.bodyRows).header.pageCount!;
  for (let page = 0; page < pages; page++) {
    const rows = await ui.findAll({ type: 'Button' });
    expect(rows.some(row => row.key === 'hidden')).toBe(false);
    for (const row of rows) if (row.key?.startsWith('h-')) reached.add(row.key);
    if (page === pages - 1) await ui.press({ key: 'h-19' });
    await ui.press({ key: 'toggle-jobs' });
  }
  expect(reached.size).toBe(20);
  expect(writes.at(-1)?.jobsExpanded).toBe(false);
  expect(writes.at(-1)?.selectedId).toBe('h-19');
  expect(await ui.find({ key: 'h-19' })).toBeDefined();
  await ui.redraw({ ...inlineProps, bodyColumns: 14, scroll: { offset: 0, bodyRows: 2 } });
  await ui.press({ key: 'toggle-jobs' });
  expect(writes.at(-1)?.selectedId).toBe('h-0');
  await ui.press({ key: 'toggle-jobs' });
  expect(writes.at(-1)?.selectedId).toBe('h-1');
  await ui.press({ key: 'clear-finished' });
  expect(writes.at(-1)?.selectedId).toBe('h-0');
  expect(visibleSessions(writes.at(-1)!).map(job => job.id)).toEqual(['h-0']);
  expect(writes.at(-1)?.jobs.length).toBe(21);
  expect(await ui.find({ key: 'clear-finished' })).toBe(undefined);
  expect(await ui.find({ key: 'toggle-jobs' })).toBe(undefined);
  navigationAtWrite = writes.length;
  await ui.redraw({ ...inlineProps, scroll: { offset: 0, bodyRows: 10 } });
  const navigation = [(await ui.find({ key: 'toggle-jobs' }))?.text];
  await ui.press({ key: 'toggle-jobs' }); navigation.push(writes.at(-1)?.selectedId ?? undefined);
  await ui.press({ key: 'h-1' }); navigation.push(writes.at(-1)?.selectedId ?? undefined);
  await ui.press({ key: 'forum:rt-a-0' }); navigation.push(writes.at(-1)?.selectedId ?? undefined);
  await ui.redraw({ ...inlineProps, scroll: { offset: 0, bodyRows: 2 } });
  for (let i = 0; i < 3; i++) {
    await ui.press({ key: 'toggle-jobs' }); navigation.push(writes.at(-1)?.selectedId ?? undefined);
  }
  expect(navigation).toEqual(['+2 more', 'h-0', 'h-1', 'forum:rt-a-0', 'h-0', 'h-1', 'forum:rt-a-2']);
  await ui.unmount();
});


function conversationTurn(id: string, n: number, status = 'running', threadId = 'shared') {
  const time = new Date(epoch + n * 1000).toISOString();
  return jobView({ id, threadId, agentName: 'Euclid', status, startedAt: time,
    completedAt: status === 'completed' ? time : undefined,
    activity: [{ seq: 1, type: 'agentMessage', body: `Activity from turn ${n}.` }],
  }, { ...marker(id), createdAt: time, summary: `Turn ${n} task.` });
}

test('same-thread turns render one selectable row and chronological transcript', async ($, on) => {
  const first = conversationTurn('first', 0, 'completed');
  const second = conversationTurn('second', 1);
  const state = { jobs: [second, first], selectedId: 'thread:shared', nowMs: epoch };
  seed(on, state);
  const writes = track(on);
  const ui = await $.ui.mount({ plugin: 'fugato-live', surface: 'terminal', component: 'Pane', requestId: 'fugato-live',
    props: { ...props, scroll: { offset: 0, bodyRows: 30 } } });
  const rows = (await ui.findAll({ type: 'Button' })).filter(row => state.jobs.some(job => row.key === job.id) || row.key === 'thread:shared');
  expect(rows.map(row => row.key)).toEqual(['thread:shared']);
  await ui.press({ key: 'thread:shared' });
  expect(writes.at(-1)?.selectedId).toBe('thread:shared');
  const transcript = (await ui.find({ key: 'transcript' }))!.text;
  const positions = ['Activity from turn 0.', 'Activity from turn 1.'].map(part => transcript.indexOf(part));
  expect(positions.every(index => index >= 0)).toBe(true);
  expect(positions[0]! < positions[1]!).toBe(true);
  expect(await ui.find({ key: 'clear-finished' })).toBe(undefined);
  await ui.unmount();
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
  const ui = await $.ui.mount({ plugin: 'fugato-live', surface: 'terminal', component: 'Pane', requestId: 'fugato-live', props });
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

test('turn retention keeps twenty headers, five detailed turns and protects active work', async ($, on) => {
  const jobs = Array.from({ length: 23 }, (_, n) => conversationTurn(`turn-${n}`, n, 'completed'));
  const state = boundState({ jobs, selectedId: 'thread:shared', nowMs: epoch,
    feeds: { 'thread:shared': { feedOffset: 0, following: false, seenLines: 1000 } } });
  const selected = selectedJob(state)!;
  expect(selected.turnCount).toBe(23);
  expect(selected.turns.map(job => job.id)).toEqual(jobs.slice(3).map(job => job.id));
  expect(selected.turns.filter(job => job.detailsLoaded).map(job => job.id)).toEqual(jobs.slice(-5).map(job => job.id));
  expect(selected.turns.slice(0, 15).every(job => job.detailsOmitted && !job.events.length)).toBe(true);
  seed(on, state);
  const ui = await $.ui.mount({ plugin: 'fugato-live', surface: 'terminal', component: 'Pane', requestId: 'fugato-live', props });
  expect(await ui.find({ key: 'earlier-turns' })).toBeDefined();
  await ui.unmount();
  jobs[0] = conversationTurn('turn-0', 0);
  const protectedState = boundState({ ...state, jobs });
  expect(protectedState.jobs.length).toBe(20);
  expect(protectedState.jobs.some(job => job.id === 'turn-0' && job.active)).toBe(true);
  expect(protectedState.jobs.some(job => job.id === 'turn-22')).toBe(true);
  const active = jobs.map(job => ({ ...job, status: 'running', completedAt: '' }));
  expect(boundState({ ...state, jobs: active }).jobs.length).toBe(23);
});

test('each detailed turn exposes its prompt and hint clicks preserve the reading anchor across reload', async ($, on) => {
  const prompt = [
    'OBJECTIVE: Invalidate cached records.',
    '- Keep the existing cache API while rejecting stale results from reads started before the write.',
    '  * Preserve failed-write behavior and avoid clearing unrelated entries when a record update fails.',
    '1. Run regression checks before reporting the final result.',
    'VERIFY: npm test',
    'REPORT: Summarize the fix.',
  ].join('\n');
  const first = jobView({ id: 'prompt-first', status: 'completed', completedAt: createdAt, threadId: 'prompt',
    request: { prompt, report: true },
    activity: [{ seq: 1, type: 'agentMessage', body: Array.from({ length: 50 }, (_, i) => `Activity ${i}`).join('\n') }],
  }, marker('prompt-first'));
  const second = jobView({ id: 'prompt-second', status: 'running', threadId: 'prompt',
    request: { prompt: 'Verify the production build.' },
  }, { ...marker('prompt-second'), createdAt: new Date(epoch + 1).toISOString() });
  const state = boundState({ jobs: [first, second], selectedId: 'thread:prompt', nowMs: epoch });
  const selected = selectedJob(state)!;
  const sized = { ...props, scroll: { offset: 0, bodyRows: 36 } };
  const rows = paneLayout(state, selected, sized.scroll.bodyRows).rows;
  const lines = feedLines(selected, epoch, props.bodyColumns);
  const stopped = normalizeFeed(lines, rows, { feedOffset: 1, following: false, seenLines: lines.length, columns: props.bodyColumns });
  state.feeds = { [selected.id]: stopped };
  seed(on, state);
  const writes = track(on);
  const promptRows = (feed = stopped) => feedLines(selected, epoch, props.bodyColumns, feed)
    .filter(line => line.source === 'job:prompt-first:prompt-results');
  expect(feedItems(selected, epoch).filter(item => item.prompt).map(item => item.prompt!.turnId)).toEqual([first.id, second.id]);
  expect(first.prompt).toBe(prompt);
  const brief = feedLines({ ...first, threadId: undefined, prompt: 'x'.repeat(70) }, epoch, 60);
  expect(brief.find(line => line.key === 'prompt-result-0')?.spans.map(span => span.text).join('')).toBe('Claude › ' + 'x'.repeat(50) + '…');
  expect(brief.find(line => line.key === 'prompt-toggle')?.spans.map(span => span.text).join('')).toBe('         ⋯ 1 more line');
  expect(promptRows()[0]?.spans.map(span => span.text).join('')).toBe('Claude › OBJECTIVE: Invalidate cached records.');
  const ownBrief = 'Review the cache repair.\nCheck saved-state recovery.\nReport observed checks.';
  const roleParagraphs = [
    'Codex reviewer role: Review the assigned changes without modifying files. Prioritize actionable correctness, regression and security findings; cite file locations and explain impact. Report checks actually run and any review limits.',
    'Codex investigator role: Investigate the assigned question without modifying files. Trace the relevant code and evidence, distinguish observations from hypotheses, and report supported conclusions with file locations and remaining uncertainty.',
    'Codex implementer role: Implement the bounded assignment in the authorized workspace. Respect owned paths and existing changes, keep the solution focused, and run appropriate verification. Report the changes, observed checks and remaining limitations.',
  ];
  const presetBriefs = roleParagraphs.map(paragraph => {
    const wrapped = `${paragraph}\n\n${ownBrief}`;
    const job = { ...first, threadId: undefined, prompt: wrapped };
    const collapsed = feedLines(job, epoch, 60);
    const expanded = feedLines(job, epoch, 60, { feedOffset: 0, following: true, seenLines: 0, expandedPromptIds: [job.id] });
    return [collapsed.find(line => line.key === 'prompt-result-0')?.spans.map(span => span.text).join(''),
      collapsed.find(line => line.key === 'prompt-toggle')?.spans.map(span => span.text).join(''),
      expanded.sources?.['prompt-results'] === wrapped + '\n', job.prompt === wrapped];
  });
  const literalBriefs = ['Codex reviewer role: My own instructions.\n\n' + ownBrief,
    roleParagraphs[0] + '\n' + ownBrief];
  expect({ presetBriefs, literalPrefixes: literalBriefs.map(prompt => feedLines({ ...first, threadId: undefined, prompt }, epoch, 60)
    .find(line => line.key === 'prompt-result-0')?.spans.map(span => span.text).join('').startsWith('Claude › Codex reviewer role:')) }).toEqual({
    presetBriefs: Array.from({ length: 3 }, () => ['Claude › Review the cache repair.', '         ⋯ 2 more lines', true, true]),
    literalPrefixes: [true, true],
  });
  const mount = () => $.ui.mount({ plugin: 'fugato-live', surface: 'terminal', component: 'Pane', requestId: 'fugato-live', props: sized });
  let ui = await mount();
  expect((await ui.find({ key: 'toggle-prompt-prompt-first' }))?.props.plain).toBe(true);
  await ui.press({ key: 'toggle-prompt-prompt-first' });
  const expanded = writes.at(-1)!.feeds![selected.id]!;
  expect(expanded.expandedPromptIds).toEqual([first.id]);
  expect(expanded.anchor).toEqual(stopped.anchor);
  expect(promptRows(expanded).length > 3).toBe(true);
  expect(promptRows(expanded).at(-1)!.spans.map(span => span.text).join('')).toContain(prompt.split('\n').at(-1)!);
  await ui.unmount();
  ui = await mount();
  const reloaded = JSON.parse(JSON.stringify(expanded));
  expect(reconcileFeed(selected, selected, reloaded, epoch).anchor).toEqual(stopped.anchor);
  await ui.press({ key: 'toggle-prompt-prompt-first' });
  const collapsed = writes.at(-1)!.feeds![selected.id]!;
  expect(collapsed.expandedPromptIds).toEqual([]);
  expect(collapsed.anchor).toEqual(stopped.anchor);
  await ui.unmount();
});

test('parent calls match C3 history only by callId across timeouts, approvals and missing history', () => {
  const questionHistory = [
    { id: 'timeout', callId: 'call-timeout', kind: 'question', text: 'Keep the cache expiry?', options: [], askedAt: createdAt,
      answer: 'Not an answered resolution', resolution: 'timeout' },
    { id: 'approval', callId: null, kind: 'approval', text: 'Allow the test runner?', options: [], askedAt: createdAt,
      answeredAt: createdAt, answer: 'Allow', resolution: 'answered' },
    { id: 'answered', callId: 'call-answer', kind: 'question', text: 'Keep the cache API?', options: [], askedAt: createdAt,
      answeredAt: createdAt, answer: 'Y'.repeat(2100), resolution: 'answered' },
    { id: 'legacy', kind: 'question', text: 'Legacy entry without a call ID', options: [], askedAt: createdAt,
      answeredAt: createdAt, answer: 'Must not appear', resolution: 'answered' },
  ];
  const raw = { id: 'job-a', status: 'running', questionHistory,
    pendingQuestion: { text: 'A pending question is not an answer source', answer: 'Not history', options: [] },
    activity: [
      { seq: 1, type: 'dynamicToolCall', tool: 'ask_parent', callId: 'call-timeout', lifecycle: 'started' },
      { seq: 2, type: 'dynamicToolCall', tool: 'ask_parent', callId: 'call-timeout', lifecycle: 'completed' },
      { seq: 3, type: 'mcpToolCall', server: 'duet_parent', tool: 'ask_parent', callId: 'call-answer', lifecycle: 'completed' },
      { seq: 4, type: 'dynamicToolCall', tool: 'ask_parent', callId: 'no-history', lifecycle: 'completed' },
      { seq: 5, type: 'dynamicToolCall', tool: 'ask_parent', lifecycle: 'completed' },
    ] };
  const job = jobView(raw, marker());
  expect(job.events.map(event => [event.seq, event.questionText, event.answer])).toEqual([
    [2, questionHistory[0]!.text, undefined],
    [3, questionHistory[2]!.text, 'Y'.repeat(2000)], [4, undefined, undefined], [5, undefined, undefined],
  ]);
  const items = job.events.map(event => eventItem(event, job, epoch));
  expect(items[0]!.results[1]!.text).toBe(questionHistory[0]!.text);
  expect(items[1]!.results[2]!.text).toContain('Y'.repeat(2000));
  const capped = jobView({ ...raw, questionHistory: questionHistory.slice(1) }, marker());
  expect(capped.events.map(event => [event.seq, event.answer])).toEqual([
    [2, undefined], [3, 'Y'.repeat(2000)], [4, undefined], [5, undefined],
  ]);
  const older = jobView({ ...raw, questionHistory: undefined }, marker());
  expect(older.events.every(event => event.answer === undefined && event.questionText === undefined)).toBe(true);
  expect(jobView(raw, marker(), false).events).toEqual([]);
});


test('forum posts form a two-row index and expand full bodies with stable anchors and bounded widths', () => {
  const room: ForumRoom = { roomId: 'rt-a-long', sessionId: 'session-a', goal: 'Review the proposal', status: 'open',
    intensity: 'standard', members: ['critic'], createdAt, postCount: 1, posts: [{ seq: 1, at: createdAt,
      author: { kind: 'member', name: 'critic' }, kind: 'finding', thread: 1, replyTo: null, title: 'Review notes',
      body: Array.from({ length: 9 }, (_, i) => `Body line ${i + 1}`).join('\n'), label: 'observed', refs: ['review.md'], mentions: [],
    }] };
  const root = { ...room.posts![0]!, initial: true };
  const chain = { ...room, postCount: 5, posts: [root,
    { ...root, seq: 2, initial: false, kind: 'candidate' as const, replyTo: 1, title: 'Candidate', body: 'A bounded proposal.' },
    { ...root, seq: 3, initial: false, kind: 'request' as const, replyTo: 2, mentions: ['chair'], title: 'Review', body: 'Please decide.' },
    { ...root, seq: 4, initial: false, kind: 'decision' as const, author: { kind: 'chair', name: 'chair' }, replyTo: 3, title: 'Accepted', body: 'Proceed.' },
    { ...root, seq: 5, initial: false, kind: 'idea' as const, title: '', body: 'Untitled first line\nHidden second line' },
  ] };
  const text = (line: ReturnType<typeof feedLines>[number]) => line.spans.map(span => span.text).join('');
  for (let columns = 0; columns <= 100; columns++) {
    const rendered = feedLines(chain, epoch + 60000, columns);
    const title = (seq: number) => rendered.find(line => line.key === `post:${seq}-title`)!;
    expect(rendered.length).toBe(10);
    expect(rendered.every(line => !!line.togglePostId)).toBe(true);
    expect(rendered.every(line => width(text(line)) <= columns)).toBe(true);
    const expanded = togglePrompt(chain, epoch + 60000, columns, 4, undefined, 'post:1');
    const full = feedLines(chain, epoch + 60000, columns, expanded);
    expect(full.every(line => width(text(line)) <= columns)).toBe(true);
    for (const following of [false, true]) {
      const footer = footerLayout(chain, { jobs: [], selectedId: 'forum:rt-a-long', nowMs: epoch,
        feeds: { 'forum:rt-a-long': expanded } }, columns, following, 2);
      expect(width(footer.left + (footer.toggleGap ?? '') + (footer.toggle ?? '') + footer.gap + footer.right + footer.jump) +
        (!following ? Math.min(3, Math.max(0, columns - width(footer.toggle ?? '') - width(footer.toggleGap ?? ''))) : 0) <= columns).toBe(true);
    }
    if (columns !== 60 && columns !== 100) continue;
    expect([1, 2, 3, 4, 5].map(seq => title(seq).spans[0]!.text.length)).toEqual([15, 17, 19, 19, 15]);
    expect(title(1).spans.some(span => span.text === 'Review notes' && span.bold)).toBe(true);
    expect(title(5).spans.some(span => span.text === 'Untitled first line' && !span.bold && span.color === 'text')).toBe(true);
    expect(title(1).spans.at(-1)).toMatchObject({ text: '▸', color: 'suggestion' });
    expect(full.find(line => line.key === 'post:1-title')?.spans.at(-1)?.text).toBe('▾');
    expect(full.filter(line => line.source === 'post:1-body').length).toBe(9);
    expect(full.map(text).join('\n')).toContain('refs  review.md');
    expect(full.findIndex(line => line.key === 'post:1-gap')).toBe(full.findIndex(line => line.key === 'post:1-refs') + 1);
    expect(full[full.findIndex(line => line.key === 'post:1-gap') + 1]?.key).toBe('post:2-meta');
    expect(feedWindow(full, 4, expanded).newLines).toBe(0);
    const stopped = normalizeFeed(full, 4, { ...expanded, following: false, feedOffset: 5, anchor: undefined });
    const collapsed = togglePrompt(chain, epoch, columns, 4, stopped, 'post:1');
    expect(collapsed.anchor?.source).toBe('post:1-title');
    const all = toggleForumPosts(chain, epoch, columns, 4, expanded);
    expect(all.expandedPromptIds?.length).toBe(5);
    expect(toggleForumPosts(chain, epoch, columns, 4, all).expandedPromptIds).toEqual([]);
    expect(rendered.find(line => line.key === 'post:1-meta')?.spans.some(span => span.text.includes('first record') && span.color === 'inactive')).toBe(true);
    expect(rendered.find(line => line.key === 'post:2-meta')?.spans.some(span => span.text.startsWith('candidate') && span.color === 'success')).toBe(true);
    expect(rendered.find(line => line.key === 'post:3-meta')?.spans.some(span => span.text === ' → chair' && span.color === 'warning')).toBe(true);
    expect(rendered.find(line => line.key === 'post:4-meta')?.spans.some(span => span.text.startsWith('decision') && span.color === 'claude')).toBe(true);
  }
  const eight = { ...room, postCount: 8, posts: Array.from({ length: 8 }, (_, i) => ({ ...root, seq: i + 1,
    body: 'First line\nSecond line\nThird line', refs: ['review.md'] })) };
  const partial = { feedOffset: 0, following: false, seenLines: 0, expandedPromptIds: ['post:3'] };
  const partialLines = feedLines(eight, epoch, 60, partial);
  const before = normalizeFeed(partialLines, 4, { ...partial, feedOffset: partialLines.findIndex(line => line.key === 'post:3-gap') });
  const all = toggleForumPosts(eight, epoch, 60, 4, before);
  const none = toggleForumPosts(eight, epoch, 60, 4, all);
  const top = (view: typeof before, rows = 4) => {
    const window = feedWindow(feedLines(eight, epoch, 60, view), rows, view);
    return [window.lines[0]?.key, view.anchor?.source, view.following, window.following];
  };
  const fittingExpand = toggleForumPosts(eight, epoch, 60, 100);
  const fitting = toggleForumPosts(eight, epoch, 60, 100, all);
  const fittingReloaded = JSON.parse(JSON.stringify(fitting));
  expect({ anchors: [top(before), top(all), top(none)], fitting: [fittingExpand.following,
    feedWindow(feedLines(eight, epoch, 60, fittingExpand), 100, fittingExpand).following, fitting.following,
    feedWindow(feedLines(eight, epoch, 60, fittingReloaded), 100, fittingReloaded).following],
    resumed: scrollFeed(feedLines(eight, epoch, 60, fitting), 100, fitting, 1, 100, 16).following }).toEqual({
    anchors: [['post:3-gap', 'post:3-gap', false, false], ['post:3-gap', 'post:3-gap', false, false],
      ['post:3-title', 'post:3-title', false, false]], fitting: [false, false, false, false], resumed: true,
  });
});

test('command cleanup follows shared vectors, redirections, heredocs and the forty-cell word limit', () => {
  const vectors = [
    [String.raw`/bin/zsh -lc "rg -n --hidden -g '!native-captures.mjs' 'codex:|codex@fugato' plugins"`, 'rg', "-n --hidden -g '!native-captures.mjs' 'codex:|codex@fugato' plugins"],
    [String.raw`/bin/zsh -lc 'rg -n -g '"'"'!x'"'"' foo'`, 'rg', "-n -g '!x' foo"],
    [String.raw`/bin/zsh -lc "git -c user.name=Ghqqqq -c user.email=a@b commit -m \"Rename main\""`, 'git', "commit -m 'Rename main'"],
    [String.raw`/bin/zsh -lc "nl -ba plugins/codex-live/hooks/poll.ts | sed -n '1,80p'"`, 'nl', '-ba plugins/codex-live/hooks/poll.ts +1'],
    [String.raw`/bin/zsh -lc "N=/x/node env -u CLAUDE_CONFIG_DIR npm_config_offline=true node --test a.mjs"`, 'node', '--test a.mjs'],
    ['/usr/bin/git status --short', 'git', 'status --short'],
    ['env -u TEST /bin/zsh -lc "git status"', 'git', 'status'],
    ['git -C /work/repo -c user.name=Alice status', 'git', '-C . status'],
    [String.raw`/bin/zsh -lc "cd /work/repo && npm test"`, 'cd', '. +1'],
  ];
  expect(vectors.map(([raw]) => { const { verb, args } = commandDisplay(raw!, '/work/repo', '/home/user', false); return [verb, args]; }))
    .toEqual(vectors.map(([, verb, args]) => [verb, args]));
  const scriptVectors = [
    [`/bin/zsh -lc "python3 - <<'PY'\nfrom pathlib import Path\nPY"`, 'python3', "- <<'PY'"],
    [`/bin/zsh -lc "cat > check.mjs <<'EOF'\nimport x\nEOF"`, 'cat', "> check.mjs <<'EOF'"],
    ['/bin/zsh -lc "npm test 2>&1 | tail -5"', 'npm', 'test 2>&1 +1'],
    ['/bin/zsh -lc "cd /x\nnpm test"', 'cd', '. +1'],
    ['/bin/zsh -lc "rg foo < list.txt > out.txt"', 'rg', 'foo < list.txt > out.txt'],
    ['cat <<EOF > a.txt\nhi\nEOF\necho done', 'cat', '<<EOF > a.txt +1'],
    ['sort <<< "b a"', 'sort', "<<< 'b a'"],
    ['cat <<"EOF"\nhidden && command > output\nEOF\necho done', 'cat', '<<"EOF" +1'],
    ['cat <<-EOF\n\thidden\n\tEOF\necho done', 'cat', '<<-EOF +1'],
    ["cat << 'EOF'\nhidden\nEOF", 'cat', "<< 'EOF'"],
    ["cat <<A <<'B' > /x/out\nfirst\nA\nsecond\nB\necho done", 'cat', "<<A <<'B' > out +1"],
    ["cat <<'EOF'\nhidden\nEOF_SUFFIX\nstill hidden\nEOF", 'cat', "<<'EOF'"],
    ['cat <<EOF\nunterminated body\necho hidden', 'cat', '<<EOF'],
    ['npm test 1>&2 0<&3 &>> /x/log || echo failed', 'npm', 'test 1>&2 0<&3 &>> log +1'],
    ['echo one\n\necho two; echo three | cat', 'echo', 'one +3'],
    ['echo one\\\n two\necho three', 'echo', 'one two +1'],
    ['npm test 2\\\n>&1 | tail -5', 'npm', 'test 2>&1 +1'],
    ['npm test 2>&\\\n1 | tail -5', 'npm', 'test 2>&1 +1'],
    ['npm test 2>\\\n&1 | tail -5', 'npm', 'test 2>&1 +1'],
    ['echo one &\\\n& echo two', 'echo', 'one +1'],
    ['echo ">" "2>&1" "<<EOF" "&>"', 'echo', "'>' '2>&1' '<<EOF' '&>'"],
  ];
  for (const shorten of [false, true]) {
    expect(scriptVectors.map(([raw]) => { const { verb, args } = commandDisplay(raw!, '/x', '/h', shorten); return [verb, args]; }))
      .toEqual(scriptVectors.map(([, verb, args]) => [verb, args]));
  }
  for (const operator of ['>', '>>', '<', '>&', '<&', '&>', '&>>', '>|', '2>', '1>>', '0<', '3>&', '0<&']) {
    expect(commandDisplay(`cat ${operator} "/x/a b.txt"`, '/x', '/h').args).toBe(`${operator} 'a b.txt'`);
  }
  const heredocPath = commandDisplay("cat <<'long/delimiter' > /x/leading/path/out.txt\nhidden\nlong/delimiter", '/x');
  expect(fitCommand(heredocPath.program, heredocPath.words, 39)).toEqual({ verb: 'cat', args: "<<'long/delimiter' > …/path/out.txt" });
  const redirectedPath = jobView({ id: 'a', status: 'running', request: { cwd: '/x' }, activity: [{ seq: 1,
    type: 'commandExecution', command: 'cat 2>&1 > "/x/leading/path/my file.txt"', exitCode: 0, lifecycle: 'completed' }] }, marker('a'));
  const redirectionRow = feedLines(redirectedPath, epoch, 40).find(line => line.key === 'event-1-body-0')!;
  expect(redirectionRow.spans.map(span => span.text).join('')).toBe("  › cat 2>&1 > '…/path/my file.txt'".padEnd(39) + '✓');
  expect(redirectionRow.spans).toContainEqual({ text: '2>&1', color: 'subtle' });
  expect(redirectionRow.spans).toContainEqual({ text: '>', color: 'subtle' });
  expect(redirectionRow.spans).toContainEqual({ text: "my file.txt'", color: 'text' });
  const word = 'abcdefghijklmnopqrstuvwx' + 'middle'.repeat(8) + 'last-fifteen.mjs';
  expect(commandDisplay(`node /work/repo/${word}`, '/work/repo').args).toBe(`${word.slice(0, 24)}…${word.slice(-15)}`);
  expect(width(commandDisplay(`node ${word}`).args)).toBe(40);
  expect(commandDisplay('echo $(printf "a && b") && node a.mjs', undefined, undefined, false).args).toBe("'$(printf \"a && b\")' +1");
  expect(commandDisplay('/bin/dash -l -c "git -C /work/repo status"', '/work/repo').args).toBe('-C . status');
  expect(commandDisplay('cat /home/user/cache/log.txt', '/work/repo', '/home/user').args).toBe('~/cache/log.txt');
  expect(commandDisplay('cat /Users/me/notes.txt', '/work/repo', '/Users/me').args).toBe('~/notes.txt');
  const nativePath = 'plugins/codex/tests/native-integration.mjs';
  expect(commandDisplay(`node --test ${nativePath}`).args).toBe(`--test ${nativePath}`);
  const commands = jobView({ id: 'a', status: 'running', request: { cwd: '/work/repo' }, activity: [
    { seq: 1, type: 'commandExecution', command: `node --test ${nativePath}`, exitCode: 0, lifecycle: 'completed', durationMs: 164000 },
    { seq: 2, type: 'commandExecution', command: 'git diff d26053a HEAD -- /work/repo/plugins/codex-live/hooks/forum.ts /work/repo/plugins/codex-live/hooks/layout.ts', exitCode: 0, lifecycle: 'completed', durationMs: 500 },
  ] }, marker('a'));
  const commandRow = (columns: number, key: string) => feedLines(commands, epoch, columns).find(line => line.key === key)!;
  expect(commandRow(100, 'event-1-body-0').spans.map(span => span.text).join(''))
    .toBe('  › node --test plugins/codex/tests/native-integration.mjs'.padEnd(92) + '✓ 2m 44s');
  expect(commandRow(60, 'event-1-body-0').spans.map(span => span.text).join(''))
    .toBe('  › node --test …/tests/native-integration.mjs'.padEnd(52) + '✓ 2m 44s');
  expect(commandRow(60, 'event-2-body-0').spans.map(span => span.text).join(''))
    .toBe('  › git diff d26053a HEAD -- …/hooks/forum.ts …/layout.ts'.padEnd(59) + '✓');
  expect(commandRow(60, 'event-1-body-0').spans.some(span => span.text === '…/tests/' && span.color === 'subtle')).toBe(true);
  expect(commandRow(60, 'event-1-body-0').spans.some(span => span.text === 'native-integration.mjs' && span.color === 'text')).toBe(true);
  const spacedWord = 'a'.repeat(25) + ' ' + 'b'.repeat(20);
  expect(commandDisplay(`echo '${spacedWord}'`).args).toBe("'" + 'a'.repeat(24) + '…' + 'b'.repeat(15) + "'");
  const fortyCells = 'a'.repeat(19) + ' ' + 'b'.repeat(20);
  expect(commandDisplay(`echo '${fortyCells}'`).args).toBe(`'${fortyCells}'`);
  const compound = jobView({ id: 'a', status: 'running', activity: [{ seq: 1, type: 'commandExecution',
    command: `node ${nativePath} && npm test`, exitCode: 0, lifecycle: 'completed' }] }, marker('a'));
  const compoundLine = feedLines(compound, epoch, 40).find(line => line.key === 'event-1-body-0')!;
  expect(compoundLine.spans.map(span => span.text).join('')).toBe('  › node …/native-integration.mjs +1'.padEnd(39) + '✓');
  const spacedPath = jobView({ id: 'a', status: 'running', request: { cwd: '/work/repo' }, activity: [{ seq: 1, type: 'commandExecution',
    command: 'cat "/work/repo/src/my file.ts"', exitCode: 0, lifecycle: 'completed' }] }, marker('a'));
  const pathLine = feedLines(spacedPath, epoch, 60).find(line => line.key === 'event-1-body-0')!;
  expect(pathLine.spans.map(span => span.text).join('')).toBe("  › cat 'src/my file.ts'".padEnd(59) + '✓');
  expect(pathLine.spans).toContainEqual({ text: "'src/", color: 'subtle' });
  expect(pathLine.spans).toContainEqual({ text: "my file.ts'", color: 'text' });
  for (const raw of ['sed -i s/a/b/ target', 'find . -delete', 'rg foo . && touch output',
    "/bin/zsh -lc 'sed -i s/a/b/ target'", "/bin/zsh -lc 'rg foo . && touch output'", "/bin/zsh -lc 'BASH_ENV=./reader cat README.md'",
    'sed -n 1p -i target', 'git diff --output=output', 'rg --pre=writer foo .', 'cat README.md > output', 'BASH_ENV=./reader cat README.md',
    'cat README.md\ntouch output']) {
    const unsafe = jobView({ id: 'a', status: 'running', activity: [raw, 'cat README.md'].map((command, i) => ({ seq: i + 1,
      type: 'commandExecution', command, exitCode: 0, lifecycle: 'completed' })) }, marker('a'));
    expect(feedItems(unsafe, epoch).filter(item => item.rowKind === 'action').length).toBe(2);
    expect(feedItems(unsafe, epoch).some(item => item.rowKind === 'explored')).toBe(false);
    expect(unsafe.events[0]?.command).toBe(raw);
  }
});

test('the list shares one fourteen-cell time axis and hides timeline/detail at their width thresholds', () => {
  const live = { ...running(), agentName: 'Carnot', role: 'reviewer', startedAt: new Date(epoch + 60000).toISOString() };
  const done = { ...running(), id: 'done', agentName: 'Sohonie', role: 'implementer', status: 'completed', active: false, finished: true,
    completedAt: new Date(epoch + 120000).toISOString() };
  const room: ForumRoom = { roomId: 'rt-a-axis', sessionId: 'session-a', goal: 'Review the release', status: 'open', intensity: 'deep',
    members: ['critic'], createdAt, postCount: 2, timeline: [epoch + 30000, -(epoch + 150000)] };
  const entries = [room, live, done], nowMs = epoch + 180000;
  const state: CodexLiveState = { jobs: [live, done], forumRooms: [room], selectedId: done.id, nowMs, newSessionIds: [live.id] };
  const axis = timelineAxis(entries, nowMs);
  expect(axis).toEqual({ start: epoch, end: nowMs });
  expect(timelineSpans(live, axis).map(span => span.text).join('')).toBe('    ━━━━━━━━━━');
  expect(timelineSpans(done, axis).map(span => span.text).join('')).toBe('━━━━━━━━━╌╌╌╌╌');
  expect(timelineSpans(room, axis).map(span => span.text).join('')).toBe('  ·       •   ');
  expect(timelineSpans(room, axis).find(span => span.text === '•')?.color).toBe('claude');
  const projected = jobView({ id: 'role', status: 'running', request: { agentType: 'fugato:fugato-reviewer', cwd: '/work/repo/subdir', model: 'gpt-6-astra', effort: 'xhigh' } }, marker('role'));
  expect(feedItems(projected, nowMs)[0]?.title).toContain(' · reviewer · astra xhigh · subdir');
  expect(feedItems({ ...projected, cwd: 'C:\\work\\repo' }, nowMs)[0]?.title).toContain(' · repo');
  expect(jobView({ id: 'role', status: 'running', request: { roundtable: { persona: 'calibrator' } } }, marker('role')).role).toBe('calibrator');
  const row = (columns: number) => tableRow(live, false, columns, state, entries);
  expect(row(100).map(span => span.text).join('')).toContain('reviewer · astra xhigh');
  expect(row(100).at(-1)?.color).toBe('suggestion');
  expect(row(60).map(span => span.text).join('')).not.toContain('━');
  expect(row(47).map(span => span.text).join('')).not.toContain('reviewer');
  expect([100, 60, 47, 12].map(columns => width(row(columns).map(span => span.text).join('')))).toEqual([100, 60, 47, 12]);
  const tiny = jobView({ id: 'tiny', status: 'completed', completedAt: createdAt, request: { prompt: 'A', report: true },
    activity: [{ seq: 1, type: 'agentMessage', body: 'D' }] }, marker('tiny'));
  const expanded = { feedOffset: 0, following: true, seenLines: 0, expandedPromptIds: ['tiny'] };
  expect(feedLines(tiny, epoch, 9).find(line => line.key === 'prompt-result-0')?.spans.map(span => span.text).join('')).toBe('Claude › ');
  expect(feedLines({ ...tiny, prompt: 'Hello world' }, epoch, 8, expanded).find(line => line.key === 'prompt-result-0')?.spans.map(span => span.text).join('')).toBe('Claude …');
  expect(feedLines(tiny, epoch, 1).find(line => line.key === 'event-1-body-0')?.spans.map(span => span.text).join('')).toBe('▏');
  const narrowRoom: ForumRoom = { ...room, posts: [{ seq: 1, at: createdAt, author: { kind: 'member', name: 'critic' }, kind: 'finding',
    thread: 1, replyTo: null, title: 'A title', body: 'Hello world\nMore\nBody\nLines\nHere\nAnd\nHere', label: '', refs: ['src/my file.ts'], mentions: ['chair'] }] };
  for (let columns = 0; columns <= 100; columns++) {
    const lines = [...feedLines(tiny, epoch, columns), ...feedLines({ ...tiny, prompt: 'Hello world' }, epoch, columns, expanded),
      ...feedLines(narrowRoom, epoch, columns), ...emptyLines(columns)];
    expect(lines.every(line => width(line.spans.map(span => span.text).join('')) <= columns)).toBe(true);
    expect(width(row(columns).map(span => span.text).join('')) <= columns).toBe(true);
  }
  expect(sessionFooter({ ...state, usageByJob: {
    a: { model: 'gpt-6-astra', usage: { inputTokens: 609000, cachedInputTokens: 0, outputTokens: 0, totalTokens: 609000 } },
    b: { model: 'gpt-6-sol', usage: { inputTokens: 526000, cachedInputTokens: 0, outputTokens: 0, totalTokens: 526000 } },
    c: { model: 'gpt-6-terra', usage: { inputTokens: 5000, cachedInputTokens: 0, outputTokens: 0, totalTokens: 5000 } },
  } }, 100).right).toBe('1.14M tokens · astra 609k · sol 526k · +1');
  const footerJob = running();
  const footerState = { jobs: [footerJob], selectedId: footerJob.id, nowMs: epoch + 12000 };
  const unknown = footerLayout(footerJob, footerState, 60, true, 0);
  const known = { ...footerJob, usage: { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 234, totalTokens: 1234 } };
  expect({ unknown: [unknown.left, unknown.right], known: footerLayout(known, footerState, 60, true, 0).right,
    zero: footerLayout({ ...known, usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0 } }, footerState, 60, true, 0).right,
    stopped: footerLayout(footerJob, footerState, 60, false, 3).jump }).toEqual({
    unknown: ['running · 1 tool · 12s', ''], known: '1.23k tokens', zero: '0 tokens', stopped: '↓ 3 new',
  });
});
