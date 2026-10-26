import { test, expect } from 'claude-code/testing';
import type { On } from 'claude-code';
import type { CodexLiveMarker, CodexLiveState } from '../types';
import { attention, attentionCounts, boundState, clearFinished, groupedSessions, isHiddenJob, normalizeSessions, visibleJobs, visibleSessions,
  collapseActivity, jobSummary, jobView, markerView, reusedAgentName, statusLine, validView } from '../hooks/model';
import { activityItems, eventItem, feedItems, feedLines, feedWindow, footerLayout, headerLayout, jobRow, jobRowColor, recentEndedJobIds,
  normalizeFeed, paneLayout, reconcileFeed, scrollFeed, selectedJob, width } from '../hooks/layout';

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
  }, { ...marker(), summary: 'OBJECTIVE: Task job-a' });
}

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

// Goldens cover a whole pane. Outside these two tests, strings are fixture data,
// identifiers or semantic counts, never prescribed product wording/spacing.
async function paneText(ui: { findAll: Function }) {
  return (await ui.findAll({ type: 'Box' })).filter((box: { props: { height?: number } }) => box.props.height === 1)
    .map((box: { text: string }) => box.text.trimEnd()).join('\n').trimEnd();
}

test('golden: rich pane with tools, Markdown, current plan and pending question', async ($, on) => {
  const job = richJob();
  job.events[1]!.body = "# Review\nRead **the `code`** and [docs](https://example.com).\n- Check leases\n1. Run tests\n```ts\n  const ok = true;\n```\n| result | ok |";
  job.agentName = 'Ada';
  const waiting = jobView({ id: 'waiting', status: 'running', agentName: 'Grace',
    pendingQuestion: { text: 'Use the existing API?', expiresAt: epoch + 899000 },
  }, { ...marker('waiting'), createdAt: new Date(epoch - 2000).toISOString() }, true, epoch);
  const quiet = jobView({ id: 'quiet', status: 'running', agentName: 'Linus',
    activity: [{ seq: 1, at: new Date(epoch - 120000).toISOString(), type: 'commandExecution',
      command: 'npm test', lifecycle: 'started' }],
  }, marker('quiet'));
  seed(on, boundState({ jobs: [job, waiting, quiet], selectedId: job.id, nowMs: epoch + 38000,
    newSessionIds: ['waiting'] }));
  const ui = await $.ui.mount({ plugin: 'codex-live', surface: 'terminal', component: 'Pane', requestId: 'codex-live',
    props: { ...props, scroll: { offset: 0, bodyRows: 44 } } });
  expect(await paneText(ui)).toBe(`  ? Grace  asks: Use the existing API? • new             40s
❯ ? Ada  asks: Which approach?                           38s
  ⏺ Linus  npm test                           38s · quiet 2m
────────────────────────────────────────────────────────────
⏺ Ada(Task job-a)
  ⎿  Question for Claude · 6 tool uses · 38s
     gpt-6-astra · xhigh · fast · read-only

⏺ Review
  Read the code and docs.
  • Check leases
  1. Run tests
    const ok = true;
  | result | ok |

⏺ Bash(node --test tests/worker-lifecycle.test.mjs)
  ⎿  Running… (38s)

⏺ Bash(git status --short)
  ⎿  Done (0.4s)

⏺ Bash(npm test)
  ⎿  Error: exit 1 (1.2s)

⏺ Update(plugins/codex/scripts/lib/job-runtime.mjs)
  ⎿  Updated job-runtime.mjs with 3 additions and 1 removal

⏺ server - tool (MCP)
  ⎿  Done (1.2s)

⏺ lookup
  ⎿  Done (0.0s)

⏺ Update Todos
  ⎿  ☒ Read waitForJob
     ☐ Check lease gaps
     ☐ Write the verdict

⏺ Question for Claude
  ⎿  Which approach?
     1. Check leases
     2. Run tests

? Question for Claude · 38s`);
  await ui.unmount();
});

test('golden: clearing the final job leaves an empty pane with retention notice', async ($, on) => {
  const job = { ...running(), status: 'completed', completedAt: createdAt };
  seed(on, { jobs: [job], selectedId: job.id, nowMs: epoch });
  const writes = track(on);
  const ui = await $.ui.mount({ plugin: 'codex-live', surface: 'terminal', component: 'Pane', requestId: 'codex-live', props });
  await ui.press({ key: 'clear-finished' });
  expect(writes.at(-1)?.selectedId).toBe(null);
  expect(writes.at(-1)?.jobs.map(job => job.id)).toEqual([job.id]);
  expect(await paneText(ui)).toBe(`No Codex jobs in this session yet. They appear here when
Claude starts one.
Finished jobs are hidden. Their records follow your Duet
cleanup settings.`);
  expect(await ui.find({ key: 'clear-finished' })).toBe(undefined);
  await ui.unmount();
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

  const results = [
    { status: 'failed', result: { failureSource: 'transport', turnEnded: false } },
    { status: 'failed', result: { errorCode: 'BROKER_CONNECTION_CLOSED' } },
    { status: 'failed', result: { error: 'Connection to Codex closed while the turn was running.' } },
    { status: 'failed' },
    { status: 'interrupted', result: { turnEnded: false, interruptionConfirmed: false } },
    { status: 'cancelled', result: { turnEnded: false, interruptionConfirmed: false } },
  ];
  for (const fields of results) {
    const raw = { id: 'lost', jobClass: 'task', threadId: 'shared', turnId: 'turn', pid: 123, completedAt: createdAt, ...fields };
    const lost = jobView(raw, marker('lost'));
    expect(lost).toMatchObject({ unresolved: true, finished: false, active: false });
    expect(attention(lost)).toBeDefined();
    expect(statusLine([lost])).toBeDefined();
    const unresolved = boundState({ jobs: [lost, ...refusals], selectedId: 'thread:shared', nowMs: epoch });
    expect(selectedJob(unresolved)?.lifecycleJobId).toBe('lost');
    expect(visibleJobs(clearFinished(unresolved, epoch + 10000)).length).toBe(unresolved.jobs.length);
    expect(jobView({ ...raw, recovered: true }, marker('lost')).finished).toBe(true);
    expect(jobView({ ...raw, result: { ...fields.result, turnEnded: true } }, marker('lost')).finished).toBe(true);
    expect(jobView({ ...raw, status: 'running', completedAt: undefined }, marker('lost')).active).toBe(true);
  }
  for (const fields of [
    { status: 'failed', result: { failureSource: 'transport', structured: { status: 'blocked' } } },
    { status: 'failed', result: { workerStatus: 'failed', errorCode: 'BROKER_CONNECTION_CLOSED' } },
    { status: 'interrupted', result: { turnEnded: false, interruptionConfirmed: true } },
    { status: 'cancelled', result: { turnEnded: false, interruptionConfirmed: false }, turnId: undefined },
  ]) expect(jobView({ id: 'resolved', jobClass: 'task', turnId: 'turn', ...fields }, marker('resolved')).finished).toBe(true);

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
  for (const [deadline, present] of [[null, false], [String(epoch - 1), false], [String(epoch), false],
    [String(epoch + 1000), true], [undefined, true], ['bad', true]] as const) {
    const question = { text: 'Continue?', ...(deadline === undefined ? {} : { expiresAt: deadline }) };
    const projected = jobView({ ...pending, pendingQuestion: question }, marker('expires'), true, epoch);
    expect(Boolean(projected.question)).toBe(present);
    expect(validView({ jobs: [projected], selectedId: projected.id, nowMs: epoch })).toBe(true);
    if (deadline === String(epoch + 1000)) {
      expect(projected.question?.expiresAt).toBe(epoch + 1000);
      expect(boundState({ jobs: [projected], nowMs: epoch + 1000 }).jobs[0]?.question).toBe(null);
    }
  }

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

test('transcript projection rejects bad identities, bounds events and preserves safe Unicode content', () => {
  const activity = Array.from({ length: 230 }, (_, seq) => ({ seq, type: 'agentMessage', body: 'x'.repeat(3999) + '👩‍💻' }));
  const job = jobView({ id: 'job-a', status: 'running', activity }, marker());
  expect(JSON.stringify(running())).not.toContain('must not enter state');
  expect(job.events.length).toBe(200);
  expect(job.events[0]?.seq).toBe(30);
  expect(job.events.at(-1)?.body).toBe('x'.repeat(3999));
  expect(() => jobView({ id: 'other' }, marker())).toThrow();
  expect(() => markerView({ v: 1, jobId: 'a', jobFile: 'relative.json' })).toThrow();
  const clean = jobView({ id: 'job-a', status: 'running', activity: [{ seq: 1, type: 'agentMessage',
    body: '\u001b[31m# 修复 👩‍💻\r\n- é\u0000\u202e' }] }, marker());
  expect(clean.events[0]?.body).toBe('# 修复 👩‍💻\n- é  ');
  const rendered = feedLines(clean, epoch, 12).filter(line => line.source === 'event-1-body');
  expect(rendered.every(line => width(line.spans.map(span => span.text).join('')) <= 12)).toBe(true);
  expect(rendered.flatMap(line => line.spans).map(span => span.text).join('')).toContain('👩‍💻');
  const row = jobRow({ ...clean, agentName: '艾达 👩‍💻', lastActivityAt: createdAt,
    question: { text: '检查 é?', options: [] } }, false, 12, epoch + 120000, true);
  expect(width(Object.values(row).join('')) <= 12).toBe(true);

  const toolActivity = Array.from({ length: 100 }, (_, seq) => ({ seq, type: 'commandExecution', lifecycle: 'completed' }));
  const raw = { id: 'job-a', status: 'running', activity: toolActivity };
  for (const details of [true, false]) {
    const totalled = jobView({ ...raw, activityTotals: { events: 500, toolUses: 300 } }, marker(), details);
    expect(totalled.toolUses).toBe(300);
    expect(totalled.events.length).toBe(details ? 100 : 0);
    expect(jobSummary(totalled).toolUses).toBe(300);
    const bounded = boundState({ jobs: [totalled], selectedId: totalled.id, nowMs: epoch });
    expect(bounded.jobs[0]?.toolUses).toBe(300);
    expect(validView(bounded)).toBe(true);
    expect(jobView({ ...raw, activity: toolActivity.slice(-10), activityTotals: { toolUses: 300 } }, marker(), details).toolUses).toBe(300);
    for (const toolUses of [undefined, null, '300', NaN, Infinity, -Infinity]) {
      expect(jobView({ ...raw, activityTotals: { toolUses } }, marker(), details).toolUses).toBe(100);
    }
    expect(jobView(raw, marker(), details).toolUses).toBe(100);
    expect(jobView({ ...raw, activityTotals: { toolUses: 0 } }, marker(), details).toolUses).toBe(0);
  }
  for (const agentName of ['Tesla-3', 'Tesla-12']) expect(reusedAgentName(jobView({ ...raw, agentName }, marker()))).toBe(true);
  for (const agentName of [undefined, 'Tesla', 'Tesla3', 'Tesla-three', 'Tesla-3-more']) {
    expect(reusedAgentName(jobView({ ...raw, agentName }, marker()))).toBe(false);
  }
  expect(reusedAgentName(jobView(raw, { ...marker(), name: 'Tesla-3' }))).toBe(true);
});

test('pane navigation pins controls, preserves selection and anchors through resize, and resumes following', async ($, on) => {
  seed(on, { jobs: fourJobs(), selectedId: 'job-0', nowMs: epoch });
  const writes = track(on);
  let delegated = 0;
  on('ui.scroll', () => { delegated++; return {}; });
  const sized = (rows: number) => ({ ...inlineProps, scroll: { offset: 5, bodyRows: rows } });
  const ui = await $.ui.mount({ plugin: 'codex-live', surface: 'terminal', component: 'Pane', requestId: 'codex-live', props: sized(20) });
  const transcript = async () => (await ui.find({ key: 'transcript' }))!;
  const original = (await transcript()).children;
  const feed = () => writes.at(-1)?.feeds?.['job-0'];
  await ui.redraw(sized(0));
  expect(await ui.find({ key: 'footer' })).toBe(undefined);
  await ui.redraw(sized(14));
  await ui.redraw(sized(20));
  expect((await transcript()).children).toEqual(original);
  expect(writes.length).toBe(0);
  expect((await ui.find({ key: 'engine-offset-pad' }))?.props.height).toBe(5);
  await $.ui.scroll(move(-1, 20));
  const stopped = feed();
  const stoppedRows = (await transcript()).children;
  const count = writes.length;
  await ui.redraw(sized(14));
  expect((await transcript()).children).toEqual(stoppedRows.slice(0, 8));
  await ui.redraw(sized(20));
  expect((await transcript()).children).toEqual(stoppedRows);
  expect(writes.length).toBe(count);
  expect(feed()?.anchor).toEqual(stopped?.anchor);
  await $.ui.scroll({ ...move(-1, 20), pointer: { row: 0, column: 0 } });
  await $.ui.scroll({ ...move(-1, 20), pointer: { row: 19, column: 0 } });
  expect(feed()?.anchor).toEqual(stopped?.anchor);
  await $.ui.scroll({ ...move(-1, 20), pointer: { row: 6, column: 0 } });
  expect(feed()?.feedOffset).toBe(stopped!.feedOffset - 1);
  await $.ui.scroll(move(-20, 20)); // Page up.
  expect(feed()?.feedOffset).toBeLessThan(stopped!.feedOffset - 1);
  await $.ui.scroll(move(20, 20)); // Page down.
  expect(feed()?.feedOffset).toBe(stopped!.feedOffset - 1);
  await $.ui.scroll(move(-21, 20)); // Home.
  expect(feed()?.feedOffset).toBe(0);
  await $.ui.scroll(move(21, 20)); // End.
  expect(feed()?.following).toBe(true);
  await $.ui.scroll(move(-5, 20));
  await ui.press({ key: 'job-1' });
  expect(writes.at(-1)?.selectedId).toBe('job-1');
  expect(writes.at(-1)?.feeds?.['job-1']?.following).toBe(true);
  expect(feed()?.following).toBe(false);
  await ui.press({ key: 'job-0' });
  await $.ui.scroll(move(-1, 20));
  await ui.press({ key: 'jump-bottom' });
  expect(feed()?.following).toBe(true);
  expect(await ui.find({ key: 'jump-bottom' })).toBe(undefined);
  expect(delegated).toBe(0);
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
  // Selection must remain possible with Clear present, including explicit
  // opens too narrow to show the full control labels.
  for (const bodyColumns of [1, 14, 20, 24]) for (const bodyRows of [2, 14]) {
    await ui.redraw({ ...inlineProps, bodyColumns, scroll: { offset: 0, bodyRows } });
    for (const job of jobs) {
      if (bodyRows === 2) {
        for (let n = 0; n < jobs.length && writes.at(-1)?.selectedId !== job.id; n++) await ui.press({ key: 'toggle-jobs' });
      } else {
        for (let n = 0; n < 4 && !await ui.find({ key: job.id }); n++) await ui.press({ key: 'toggle-jobs' });
        await ui.press({ key: job.id });
      }
      expect(writes.at(-1)?.selectedId).toBe(job.id);
    }
  }
  await ui.redraw({ ...inlineProps, scroll: { offset: 0, bodyRows: 2 } });
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
  expect(state.jobs.find(job => job.id === 'turn-0')?.events[0]?.body!.length < 4000).toBe(true);
  expect(state.jobs.find(job => job.id === 'turn-2')?.events.at(-1)?.body?.length).toBe(4000);
  expect(feedItems(selectedJob(state)!, epoch).filter(item => item.key.startsWith('job-header')).length).toBe(3);
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

test('recent history sorts by completion and expires while preserving selection', () => {
  const jobs = [conversationTurn('older', 0, 'completed', 'older'), conversationTurn('newer', 1, 'completed', 'newer')];
  jobs[0]!.completedAt = new Date(epoch + 2000).toISOString();
  const state = { jobs, selectedId: 'thread:newer', nowMs: epoch + 3000 };
  expect(recentEndedJobIds(groupedSessions(jobs), state.nowMs)).toEqual(['thread:older', 'thread:newer']);
  const selected = selectedJob(state)!;
  expect(headerLayout(state, selected, 14).jobs.length).toBe(2);
  expect(headerLayout({ ...state, nowMs: epoch + 123000 }, selected, 14).jobs.map(job => job.id)).toEqual(['thread:newer']);
  expect(state.jobs.length).toBe(2);
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
  expect(promptRows().length).toBe(3);
  const mount = () => $.ui.mount({ plugin: 'codex-live', surface: 'terminal', component: 'Pane', requestId: 'codex-live', props: sized });
  let ui = await mount();
  expect((await ui.find({ key: 'toggle-prompt-prompt-first' }))?.props.plain).toBe(true);
  await ui.press({ key: 'toggle-prompt-prompt-first' });
  const expanded = writes.at(-1)!.feeds![selected.id]!;
  expect(expanded.expandedPromptIds).toEqual([first.id]);
  expect(expanded.anchor).toEqual(stopped.anchor);
  expect(promptRows(expanded).length > 3).toBe(true);
  expect(promptRows(expanded).at(-1)!.spans.map(span => span.text).join('')).toContain(prompt.split('\n').at(-1)!);
  // Alignment is measured against fixture content, not a layout-string golden.
  const list = promptRows(expanded).filter(line => line.start! >= prompt.indexOf('- ') && line.start! < prompt.indexOf('\n  *'));
  const contentColumn = list[0]!.spans.map(span => span.text).join('').indexOf('Keep');
  expect(list.slice(1).every(line => /^ */.exec(line.spans.map(span => span.text).join(''))![0].length === contentColumn)).toBe(true);
  await ui.unmount();
  ui = await mount();
  const reloaded = JSON.parse(JSON.stringify(expanded));
  expect(reconcileFeed(selected, selected, reloaded, epoch).anchor).toEqual(stopped.anchor);
  await ui.press({ key: 'toggle-prompt-prompt-first' });
  const collapsed = writes.at(-1)!.feeds![selected.id]!;
  expect(collapsed.expandedPromptIds).toEqual([]);
  expect(collapsed.anchor).toEqual(stopped.anchor);
  expect(promptRows(collapsed).length).toBe(3);
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
  expect(items.map(item => item.results.length)).toEqual([2, 3, 1, 1]);
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
