import { test, expect, mock } from 'claude-code/testing';
import { captures } from './native-captures.mjs';

const root = '/private/tmp/duet14-g-fixture';
const TYPE = 'codex:codex-native';
const clone = (value: any) => JSON.parse(JSON.stringify(value));
async function drain(stream: any) {
  const chunks = []; let item;
  do { item = await stream.next(); if (!item.done) chunks.push(item.value); } while (!item.done);
  return { chunks, result: item.value };
}

function fixture(on: any) {
  let agents: any[] = [], store = new Map(), processes: any[] = [], expectedPrompt: string;
  let modelCalls = 0, calls = 0, listFailure = false, processFailure = false, getFailure = false, missingNode = false;
  let sessionId = 'native-session';
  const problems: string[] = [];
  mock.env(on, {});
  const clock = mock.clock(on, { now: 1800000000000 });
  const transcript = mock.session(on);
  on('fs.stat', (_: any, e: any) => ({ value: { kind: 'dir', realPath: e.path } }));
  on('store.keys', () => ({ value: [...store.keys()] }));
  on('store.delete', (_: any, e: any) => { store.delete(e.key); return { value: undefined }; });
  on('session.id', () => ({ value: sessionId }));
  on('session.cwd', () => ({ value: root + '/repo' }));
  on('session.root', () => ({ value: root + '/repo' }));
  on('prompt.submit', (_: any, e: any) => ({ text: e.text, context: e.context, origin: e.origin }));
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'Intro', scope: 'shared' }] }));
  on('store.get', (_: any, e: any) => {
    if (getFailure) { getFailure = false; throw new Error('Injected hook failure'); }
    return { value: store.get(e.key) };
  });
  on('store.set', (_: any, e: any) => { store.set(e.key, clone(e.value)); return { value: undefined }; });
  on('agent.list', () => {
    if (listFailure) throw new Error('Injected agent-list failure');
    return { value: agents };
  });
  on('classic.SubagentStart', () => ({}));
  on('tool.call', () => ({ result: {} }));
  on('agent.spawn', (_: any, e: any) => {
    if (e.subagentType === TYPE) {
      expect(e.prompt).toBe(expectedPrompt);
      agents = [{ id: 'native-agent', type: TYPE, name: 'native-worker', description: e.description, status: 'running' }];
    }
    return { model: 'haiku', agentId: 'native-agent' };
  });
  on('turn.start', (_: any, e: any) => ({ turnId: e.turnId }));
  on('turn.complete', (_: any, e: any) => ({ text: e.answer }));
  on('turn.step', async function* (_: any, e: any) {
    modelCalls++;
    yield { kind: 'text', index: 0, text: 'unchanged model bottom' };
    yield { kind: 'stop', stopReason: 'end_turn', usage: null };
    return { turnId: e.turnId, index: e.index, answer: 'unchanged model bottom',
      stopReason: 'end_turn', toolUses: [], usage: null };
  });
  function take(kind: string, request: any) {
    calls++;
    const expected = processes.shift();
    const normalized = clone(request);
    // The engine supplies this checkout's plugin root; capture paths are portable.
    if (normalized.argv[0] !== 'node') {
      if (!normalized.argv[1].endsWith('/plugins/codex/bin/duet')) problems.push('Wrong launcher');
      normalized.argv[0] = '/host/node';
      normalized.argv[1] = '/plugin/bin/duet';
    } else if (normalized.argv[1]?.endsWith('/plugins/codex/scripts/lib/report-delivery.mjs') && normalized.argv[2] === '--mark-emitted') {
      normalized.argv[1] = '/plugin/scripts/lib/report-delivery.mjs';
    }
    if (!expected || expected.kind !== kind || JSON.stringify(expected.request) !== JSON.stringify(normalized)) {
      // Structural comparison below also ignores harmless key order differences.
      try { expect({ kind, request: normalized }).toEqual({ kind: expected?.kind, request: expected?.request }); }
      catch (e) { problems.push(String(e)); throw e; }
    }
    return expected;
  }
  on('process.spawn', async function* (_: any, e: any) {
    if (processFailure) throw new Error('Injected process failure');
    const record = take('spawn', e);
    for (const step of record.timeline || record.chunks.map((chunk: any) => ({ chunk }))) {
      if (step.advance) await clock.advance(step.advance);
      else yield step.chunk;
    }
    // The test engine skips a throwing mock instead of rejecting the caller
    // with its error. Carry the captured rejection through the companion's
    // error envelope so the adapter catches the same message. The integration
    // fixture exercises the actual rejected stream and aborted turn signal.
    if (record.error) yield { stream: 'stdout', text: '\n' + JSON.stringify({ status: 'error', summary: record.error }) + '\n' };
    // A rejected stream supplied no CLI return value. Do not turn this mock
    // envelope into structural evidence of an exited companion's rejection.
    return { value: record.error ? { ...record.exit, code: null } : record.exit };
  });
  on('process.run', (_: any, e: any) => {
    // Native captures contain only the native prompt handler. The separate
    // report-delivery host contract exercises the composer lookup itself.
    const argv = [...e.argv];
    if (argv[1]?.endsWith('/plugins/codex/scripts/lib/report-delivery.mjs')) argv[1] = '/plugin/scripts/lib/report-delivery.mjs';
    if (JSON.stringify(argv) === JSON.stringify(['node', '/plugin/scripts/lib/report-delivery.mjs', '--claim-unreported'])) {
      return { value: { exitCode: 0, stdout: '[]', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } };
    }
    return { value: missingNode
      ? { exitCode: 127, stdout: '', stderr: 'Node unavailable', isStdoutTruncated: false, isStderrTruncated: false }
      : take('run', e).value };
  });
  return {
    async replay($: any, capture: any, discoveryDown = false) {
      store = new Map(); processes = clone(capture.processes); agents = [];
      listFailure = discoveryDown;
      if (discoveryDown) {
        await $.classic.SubagentStart({ session_id: sessionId, agent_id: 'native-agent', agent_type: TYPE });
        // Without discovery the display name is unavailable; the id still routes
        // SendMessage. Everything else must match the real companion capture.
        capture = JSON.parse(JSON.stringify(capture).replaceAll('native-worker', 'native-agent'));
      }
      for (let index = 0; index < capture.events.length; index++) {
        const event = capture.events[index];
        if (event.event === 'reload') { store = new Map(Object.entries(clone(event.store))); continue; }
        if (event.event === 'agent.spawn') expectedPrompt = capture.events[index + 1].input.text;
        const [noun, verb] = event.event.split('.');
        // The replay host cannot unload one module mid-case. Its node resolution
        // is cached; consume only the captured reload's identical prerequisite probe.
        if (event.event === 'turn.step' && processes[0]?.request.argv[0] === 'node' && calls > 0) {
          const probe = processes.shift(); expect(probe.value.stdout).toBe('/host/node\n');
        }
        if (event.event === 'turn.step') {
          const { chunks, result } = await drain($[noun][verb](event.input));
          expect(chunks).toEqual(event.chunks);
          expect(result).toEqual(event.result);
        } else expect(await $[noun][verb](event.input)).toEqual(event.result);
      }
      expect(transcript.appended().map((row: any) => ({ agentId: row.agentId, message: { type: row.message.type, content: row.message.content } }))).toEqual(capture.notices);
      expect(processes).toHaveLength(0);
      expect(problems).toEqual([]);
      expect(Object.fromEntries(store)).toEqual(capture.store);
      expect(modelCalls).toBe(0);
      listFailure = false;
    },
    async isolation($: any, discoveryDown = false) {
      const before = calls;
      listFailure = discoveryDown;
      for (const type of [undefined, 'general-purpose', 'Explore', 'fork', 'other-plugin:codex-native', 'codex:codex-worker']) {
        const agentId = type ? `other-${type}` : undefined;
        agents = type ? [{ id: agentId, type, status: 'running', description: 'unchanged' }] : [];
        // A stale record must not hijack a live agent of a different type.
        if (agentId) store.set(`native:v2:native-session:${agentId}`, { type: TYPE });
        if (discoveryDown && agentId) await $.classic.SubagentStart({ session_id: sessionId, agent_id: agentId, agent_type: type });
        const start = { agentId, turnId: 'other-turn', text: 'Leave this agent alone.' };
        expect(await $.turn.start(start)).toEqual({ turnId: 'other-turn' });
        const { result } = await drain($.turn.step({ agentId, turnId: 'other-turn', index: 0, model: 'haiku', messageCount: 1 }));
        expect(result.answer).toBe('unchanged model bottom');
      }
      expect(modelCalls).toBe(6);
      expect(calls).toBe(before);
      listFailure = false;
    },
    async errors($: any) {
      const initialModelCalls = modelCalls;
      processes = [clone(captures[0].processes[0])];
      agents = [{ id: 'native-agent', type: TYPE, status: 'running', description: 'failure' }];
      const dispatch = captures[0].events[1].input;
      for (const failure of ['process', 'hook', 'missing-node']) {
        store = new Map();
        if (failure === 'missing-node') sessionId = 'missing-node-session';
        // Establish the permission binding before testing unrelated failures.
        const spawn = captures[0].events.find((event: any) => event.event === 'agent.spawn').input;
        expectedPrompt = spawn.prompt;
        await $.agent.spawn(spawn);
        await $.turn.start(dispatch);
        processFailure = failure === 'process'; getFailure = failure === 'hook'; missingNode = failure === 'missing-node';
        const { result } = await drain($.turn.step(captures[0].events[2].input));
        expect(JSON.parse(result.answer).status).toBe('blocked');
        if (missingNode) expect(JSON.parse(result.answer).summary.includes('Node.js')).toBe(true);
        expect(result.usage).toBeNull();
        expect(modelCalls).toBe(initialModelCalls);
      }
    },
    async report($: any, fields: any) {
      const capture = clone(captures[3]);
      const step = capture.events.find((event: any) => event.event === 'turn.step');
      store = new Map(); agents = []; processes = capture.processes.slice(0, step.processCount);
      const task = processes.find((record: any) => record.kind === 'spawn' && record.request.argv[2] === 'task');
      const lines = task.chunks.filter((chunk: any) => chunk.stream === 'stdout').map((chunk: any) => chunk.text).join('').trimEnd().split('\n');
      const report = { ...JSON.parse(lines.pop()), ...fields };
      task.chunks = [{ stream: 'stdout', text: [...lines, JSON.stringify(report)].join('\n') + '\n' }];
      task.exit.code = report.status === 'blocked' ? 2 : 0;
      if (calls > 0 && processes[0]?.request.argv[0] === 'node') processes.shift();
      const spawn = capture.events.find((event: any) => event.event === 'agent.spawn');
      const start = capture.events.find((event: any) => event.event === 'turn.start');
      expectedPrompt = start.input.text;
      await $.agent.spawn(spawn.input);
      await $.turn.start(start.input);
      const { result } = await drain($.turn.step(step.input));
      const answer = JSON.parse(result.answer);
      expect(answer.status).toBe(report.status);
      expect(answer.blockers).toEqual(report.blockers);
      expect(processes).toHaveLength(0);
      expect(problems).toEqual([]);
      expect(modelCalls).toBe(0);
      return answer;
    },
  };
}

for (const [index, capture] of captures.entries()) {
  test(`native replay ${index + 1}: ${capture.behavior}`, async ($, on) => {
    await fixture(on).replay($, capture);
  });
}

test('other loops pass untouched; process and hook failures block without a model', async ($, on) => {
  const f = fixture(on);
  await f.isolation($);
  await f.errors($);
});

test('typed runtime blockers select recovery without overriding thread-busy actions', async ($, on) => {
  const f = fixture(on), reports = new Map();
  for (const code of ['fixture_blocker', 'usage_limit', 'context_window_exceeded', 'provider_refused', 'auth_required']) {
    reports.set(code, await f.report($, { status: 'blocked', blockers: [{ code }] }));
  }
  const continuation = reports.get('fixture_blocker').next;
  expect(reports.get('usage_limit').next).toBe(continuation);
  for (const code of ['context_window_exceeded', 'provider_refused', 'auth_required']) {
    const { next } = reports.get(code);
    expect(typeof next).toBe('string');
    expect(next.length > 0).toBe(true);
    expect(next === continuation).toBe(false);
    expect(next.includes('native-worker')).toBe(false);
    const nextAction = 'duet status predecessor --json';
    const busy = await f.report($, { status: 'blocked', blockers: [{ code }, { code: 'thread_busy' }], next: nextAction });
    expect(busy.next).toBe(nextAction);
  }
  expect(reports.get('context_window_exceeded').next === reports.get('provider_refused').next).toBe(false);
  expect(reports.get('auth_required').next.match(/\/[a-z]+:[a-z]+/g)).toEqual(['/codex:setup']);
});

test('SubagentStart identifies the first native turn while discovery rejects; other types still pass through', async ($, on) => {
  const f = fixture(on);
  await f.replay($, captures[0], true);
  await f.isolation($, true);
});

// Exercise the same engine path with adversarial stdout chunk boundaries and
// a burst beyond the notice budget, keeping the captured final C2 unchanged.
test('progress is bounded, split lines survive, duplicate notices collapse, and JSON stays final-only', async ($, on) => {
  const capture: any = clone(captures[3]);
  const step = capture.events.find((e: any) => e.event === 'turn.step');
  const reload = capture.events.find((e: any) => e.event === 'reload');
  capture.events = capture.events.slice(0, capture.events.indexOf(reload));
  capture.processes = capture.processes.slice(0, step.processCount);
  const task = capture.processes.find((p: any) => p.kind === 'spawn' && p.request.argv[2] === 'task');
  const lines = Array.from({ length: 245 }, (_, i) => `burst ${i}`);
  task.chunks.unshift(
    { stream: 'stderr', text: '[1] stderr must never be progress\n' },
    { stream: 'stdout', text: '[0' },
    { stream: 'stdout', text: '] repeat\n[1] repeat\n' + '[2] ' + 'x'.repeat(5000) },
    { stream: 'stdout', text: '\n' + lines.map((text, i) => `[${i + 3}] ${text}\n`).join('') },
  );
  const added = ['repeat', 'repeat', ...lines].map(text => ({ kind: 'thinking', index: 0, text }));
  step.chunks.unshift(...added);
  const start = capture.notices[0];
  // The final usage notice is exempt from the progress cap.
  const usage = capture.notices.filter((n: any) => n.message.content[0].text.startsWith('Codex usage'));
  capture.notices = [start, ...['repeat', ...lines.slice(0, 198)].map(text => ({ agentId: 'native-agent',
    message: { type: 'system', content: [{ type: 'text', text }] } })), ...usage];
  const state: any = Object.values(capture.store)[0];
  state.notices = { turnId: 'turn-1', count: 200, last: 'burst 197', started: true };
  if (usage.length) Object.assign(state.notices, { count: 200 + usage.length, last: usage.at(-1).message.content[0].text, usage: true });
  await fixture(on).replay($, capture);
  expect(capture.notices).toHaveLength(200 + usage.length);
  expect(step.result.answer.includes('burst')).toBe(false);
  expect(step.result.answer.includes('repeat')).toBe(false);
});
