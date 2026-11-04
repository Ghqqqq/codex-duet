import { test, expect } from 'claude-code/testing';
import type { On } from 'claude-code';
import type { CodexLiveMarker, CodexLiveState } from '../types';
import { attention, attentionCounts, boundState, clearFinished, groupedSessions, normalizeSessions, visibleJobs, visibleSessions,
  collapseActivity, isAbsolutePath, jobSummary, jobView, markerView, reusedAgentName, statusLine, validView } from '../hooks/model';
import { activityItems, eventItem, feedItems, feedLines, feedWindow, footerLayout, headerLayout, jobRow, jobRowColor, jobState,
  normalizeFeed, paneLayout, reconcileFeed, relativePath, scrollFeed, selectedJob, width } from '../hooks/layout';

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

test('job status labels distinguish progress, attention and confirmed outcomes', async ($, on) => {
  for (const [status, word, color] of [
    ['queued', 'Queued', 'inactive'], ['running', 'Running', 'claude'], ['waiting', 'Waiting for Claude', 'warning'],
    ['completed', 'Done', 'success'], ['failed', 'Failed', 'error'], ['blocked', 'Needs your attention', 'error'],
    ['needs_input', 'Needs your attention', 'warning'], ['interrupted', 'Stopped', 'inactive'],
  ]) expect(jobState(jobView({ id: status, status }, marker(status)))).toEqual({ word, color });
  const question = 'Use the existing API?';
  const job = jobView({ id: 'job-a', status: 'running', pendingQuestion: { text: question } }, marker());
  expect(jobState(job)).toEqual({ word: 'Question for Claude', color: 'warning' });
  seed(on, { jobs: [job], selectedId: job.id, nowMs: epoch });
  const ui = await $.ui.mount({ plugin: 'codex-live', surface: 'terminal', component: 'Pane', requestId: 'codex-live', props });
  expect((await ui.find({ key: 'live-status' }))?.text).toContain('Question for Claude');
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
  const ui = await $.ui.mount({ plugin: 'codex-live', surface: 'terminal', component: 'Pane', requestId: 'codex-live', props });
  await ui.press({ key: 'clear-finished' });
  expect(writes.at(-1)?.selectedId).toBe(null);
  expect(writes.at(-1)?.jobs.map(job => job.id)).toEqual([job.id]);
  expect((await ui.find({ key: 'hidden-notice' }))?.text).toBe('Finished jobs are hidden. Their records follow your Fugato');
  expect((await ui.find({ key: 'hidden-notice-1' }))?.text).toBe('cleanup settings.');
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
  for (const job of coded) expect(footerLayout(job, codedState, 200, true, 0).left.includes(job.blockerCode!)).toBe(true);
  for (const code of ['', 'invalid code', 'bad\ncode', 'x'.repeat(65), '<bad>', 12]) {
    const malformed = jobView({ id: 'bad', status: 'blocked', report: { blockers: [{ code }] } }, marker('bad'));
    expect(malformed.blockerCode).toBe(undefined);
    expect(validView({ ...codedState, jobs: [{ ...coded[0]!, blockerCode: code }] })).toBe(false);
  }
  seed(on, codedState);
  const ui = await $.ui.mount({ plugin: 'codex-live', surface: 'terminal', component: 'Pane', requestId: 'codex-live', props });
  const texts = await ui.findAll({ type: 'Text' });
  const bullet = jobRow(coded[0]!, true, props.bodyColumns, epoch).bullet;
  expect(texts.filter(text => text.text === bullet).map(text => text.props.color))
    .toEqual(headerLayout(codedState, selectedJob(codedState)!, props.scroll.bodyRows).jobs.map(jobRowColor));
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
    ['completed', null, 'completed', 'warning', 'Done · exit unknown'],
    ['completed', 0, 'completed', 'success', 'Done'],
    ['completed', 9, 'completed', 'error', 'Error: exit 9'],
    ['inProgress', undefined, 'started', 'inactive', 'Running…'],
    ['cancelled', undefined, 'completed', 'inactive', 'Cancelled'],
  ] as const) {
    const item = eventItem({ seq: 1, type: 'commandExecution', command: 'echo check', status, exitCode, lifecycle }, running(), epoch);
    expect(item.color).toBe(color);
    expect(item.results[0]!.text).toBe(text);
  }
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
  expect(width(Object.values(row).join('')) <= 12).toBe(true);

  for (const agentName of ['Tesla-3', 'Tesla-12']) expect(reusedAgentName(jobView({ id: 'job-a', status: 'running', agentName }, marker()))).toBe(true);
  for (const agentName of [undefined, 'Tesla', 'Tesla3', 'Tesla-three', 'Tesla-3-more']) {
    expect(reusedAgentName(jobView({ id: 'job-a', status: 'running', agentName }, marker()))).toBe(false);
  }
  expect(reusedAgentName(jobView({ id: 'job-a', status: 'running' }, { ...marker(), name: 'Tesla-3' }))).toBe(true);
});

test('pane navigation preserves each selection and resumes following', async ($, on) => {
  seed(on, { jobs: fourJobs(), selectedId: 'job-0', nowMs: epoch });
  const writes = track(on);
  const ui = await $.ui.mount({ plugin: 'codex-live', surface: 'terminal', component: 'Pane', requestId: 'codex-live', props: inlineProps });
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
  const ui = await $.ui.mount({ plugin: 'codex-live', surface: 'terminal', component: 'Pane', requestId: 'codex-live', props });
  expect(JSON.stringify(await ui.drawn()).length < 100000).toBe(true);
  await $.ui.scroll(move(-17, 16));
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

test('history paging reaches retained jobs, excludes cleared history and keeps tiny controls usable', async ($, on) => {
  const jobs = Array.from({ length: 20 }, (_, n) => jobView({ id: `h-${n}`, status: n ? 'completed' : 'running',
    completedAt: n ? new Date(epoch - 500000).toISOString() : undefined,
  }, { ...marker(`h-${n}`), createdAt: new Date(epoch - n * 1000).toISOString() }));
  const hidden = jobView({ id: 'hidden', status: 'completed', completedAt: new Date(epoch - 600000).toISOString() }, marker('hidden'));
  seed(on, { jobs: [hidden, ...jobs], selectedId: 'h-0', nowMs: epoch, hiddenFinishedBefore: epoch - 600000 });
  const writes = track(on);
  const ui = await $.ui.mount({ plugin: 'codex-live', surface: 'terminal', component: 'Pane', requestId: 'codex-live', props: inlineProps });
  const reached = new Set<string>();
  await ui.press({ key: 'toggle-jobs' });
  for (let page = 0; page < 2; page++) {
    const rows = await ui.findAll({ type: 'Button' });
    expect(rows.some(row => row.key === 'hidden')).toBe(false);
    for (const row of rows) if (row.key?.startsWith('h-')) reached.add(row.key);
    if (page === 1) await ui.press({ key: 'h-19' });
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
  const ui = await $.ui.mount({ plugin: 'codex-live', surface: 'terminal', component: 'Pane', requestId: 'codex-live',
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
  const ui = await $.ui.mount({ plugin: 'codex-live', surface: 'terminal', component: 'Pane', requestId: 'codex-live', props });
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
  const ui = await $.ui.mount({ plugin: 'codex-live', surface: 'terminal', component: 'Pane', requestId: 'codex-live', props });
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
  const mount = () => $.ui.mount({ plugin: 'codex-live', surface: 'terminal', component: 'Pane', requestId: 'codex-live', props: sized });
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
