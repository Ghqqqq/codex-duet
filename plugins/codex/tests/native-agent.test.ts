import { test, expect, mock } from 'claude-code/testing';
import { captures as recordedCaptures } from './native-captures.mjs';
import { register as registerNative } from '../hooks/native-agent.mjs';

const root = '/private/tmp/duet14-g-fixture';
const TYPE = 'codex:codex-native';
const clone = (value: any) => JSON.parse(JSON.stringify(value));
// Migrate only the two captured usage labels; preserve the recorded execution.
const captures = recordedCaptures.map(capture => {
  const started = capture.notices.find((notice: any) => notice.message.content[0].text.includes('started · job '));
  const model = started?.message.content[0].text.match(/ · ([^ ]+) \/ /)?.[1] ?? 'unknown';
  return JSON.parse(JSON.stringify(capture)
    .replaceAll('Codex usage · 150 input (40 cached) · 30 output tokens',
      `Codex tokens (provider: OpenAI Codex, model ${model}) · 150 input · 40 cached · 30 output · 180 total`)
    .replaceAll('Codex usage · 12,345 input (8,000 cached) · 678 output tokens',
      `Codex tokens (provider: OpenAI Codex, model ${model}) · 12,345 input · 8,000 cached · 678 output · 13,023 total`));
});
async function drain(stream: any) {
  const chunks = []; let item;
  do { item = await stream.next(); if (!item.done) chunks.push(item.value); } while (!item.done);
  return { chunks, result: item.value };
}

// A held companion keeps a real native flight open while ancillary work fails.
// Advance timer callbacks independently, as the host does, without resolving
// the held lookup until after observing the live stream.
async function faultKeepalives(fault: 'append' | 'lookup' | 'queue' | 'owner-append' | 'owner-save') {
  const capture: any = captures[3], hooks = new Map(), store = new Map(), timers = new Set<any>();
  const on: any = (name: string, matcher: any, handler: any) => {
    hooks.set(name, typeof matcher === 'function' ? matcher : handler);
    return { catch() {} };
  };
  registerNative(on);
  let now = 1800000000000, releaseOwner!: () => void, releaseLookup!: () => void, faultActive = true;
  let injected = false, consumed = false, earlyClose = false, logs = 0;
  const owner = new Promise<void>(resolve => { releaseOwner = resolve; });
  const lookup = new Promise<void>(resolve => { releaseLookup = resolve; });
  const notices: any[] = [], chunks: any[] = [];
  const state = { type: TYPE, session: 'native-session', agentId: 'native-agent', name: 'native-worker',
    v: 2, cwd: root + '/repo', permissionMode: 'default', incoming: { turnId: 'turn-1', text: 'Held fixture task.' } };
  store.set('native:v2:native-session:native-agent', state);
  const timer = (ms: number, fn: any, once = false) => {
    const item = { ms, fn, once, due: now + ms }; timers.add(item);
    return { cancel: () => timers.delete(item) };
  };
  const $: any = {
    plugin: { root: '/plugin' }, ui: { invalidate() {}, log() { logs++; } }, env: { get: async () => undefined },
    session: { id: async () => 'native-session', root: async () => root + '/repo', append: async (row: any) => {
      if (faultActive && fault === 'append' && notices.length) return { deny: 'Fixture refusal' };
      if (!faultActive && fault === 'owner-append' && !injected) { injected = true; return { deny: 'Fixture refusal' }; }
      notices.push(clone(row)); return {};
    } },
    agent: { list: async () => [{ id: 'native-agent', name: 'native-worker', type: TYPE }] },
    store: { get: async (key: string) => clone(store.get(key) ?? null),
      set: async (key: string, value: any) => {
        if (!faultActive && fault === 'owner-save' && !injected && value.notices?.count > noticesBeforeOwner) {
          injected = true; throw new Error('Fixture progress save failure');
        }
        store.set(key, clone(value));
      } },
    clock: { now: async () => now, every: (ms: number, fn: any) => timer(ms, fn), after: (ms: number, fn: any) => timer(ms, fn, true) },
    process: { run: async (argv: string[], init: any) => {
      if (argv[0] === 'node') return { exitCode: 0, stdout: '/host/node\n' };
      expect(argv[2]).toBe('status');
      expect(init.timeoutMs > 0 && init.timeoutMs <= 15000).toBe(true);
      if (faultActive && fault === 'lookup') await lookup;
      return capture.processes.find((p: any) => p.kind === 'run' && p.request.argv[2] === 'status'
        && (p.request.argv[3] === '--all') === (argv[3] === '--all')).value;
    }, spawn: (request: any) => {
      const command = request.argv[2];
      const record = capture.processes.find((p: any) => p.kind === 'spawn' && p.request.argv[2] === command
        && (command !== 'status' || (p.request.argv[3] === '--all') === (request.argv[3] === '--all')));
      const stream = (async function* () {
        if (command === 'task') await owner;
        try {
          if (command === 'task' && fault.startsWith('owner-')) yield { stream: 'stdout', text: '[0] Owner progress\n' };
          for (const chunk of record.chunks) yield chunk;
          if (command === 'task') consumed = true;
        } finally { if (command === 'task' && !consumed) earlyClose = true; }
      })();
      return Object.assign(stream, { result: Promise.resolve({ code: 0 }) });
    } },
  };
  const stream = hooks.get('turn.step')($, { agentId: 'native-agent', turnId: 'turn-1', index: 0 }, () => { throw new Error('Unexpected model'); });
  let resumeReader!: () => void, heartbeatPending = 0, maxHeartbeatPending = 0;
  const readerGate = new Promise<void>(resolve => { resumeReader = resolve; });
  const pending = (async () => {
    let item;
    do {
      item = await stream.next();
      if (!item.done) chunks.push(item.value);
      if (fault === 'queue' && faultActive) await readerGate;
    } while (!item.done);
    return item.value;
  })();
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  const advance = async (offset: number) => {
    now = 1800000000000 + offset;
    for (const item of [...timers].sort((a, b) => a.due - b.due)) if (item.due <= now) {
      if (item.once) timers.delete(item); else item.due = now + item.ms;
      if (item.ms === 30000) heartbeatPending++;
      void Promise.resolve(item.fn()).catch(() => {}).finally(() => {
        if (item.ms === 30000) heartbeatPending--;
      });
    }
    await settle();
    maxHeartbeatPending = Math.max(maxHeartbeatPending, heartbeatPending);
  };
  let observed, noticesBeforeOwner = 0;
  try {
    await settle();
    await advance(1500);
    let liveUpdates = 0;
    for (let tick = 1; tick <= (fault === 'queue' ? 500 : 24); tick++) {
      const before = chunks.length;
      await advance(tick * 30000);
      if (tick > 1 && chunks.length > before) liveUpdates++;
    }
    observed = fault === 'queue' ? { maxHeartbeatPending, heartbeatPending }
      : { thinking: chunks.filter(chunk => chunk.kind === 'thinking').length,
        notices: notices.length, finalChunks: chunks.filter(chunk => chunk.kind !== 'thinking').length, liveUpdates };
  } finally {
    noticesBeforeOwner = notices.length;
    faultActive = false; resumeReader(); releaseLookup(); releaseOwner();
    const result = await pending;
    expect({ fault, report: JSON.parse(result.answer) }).toEqual({ fault, report: expect.objectContaining({ status: 'completed' }) });
    expect(timers.size).toBe(0);
  }
  if (fault.startsWith('owner-')) return { injected, consumed, earlyClose, logged: logs > 0 };
  return observed;
}

// Exercise append/start orderings, independently minted coordinator echoes,
// normalized render ids, identical briefs, and overlapping command titles.
async function displayReplay(exercise?: (api: any) => Promise<void>) {
  const hooks = new Map(), store = new Map(), engine = { type: 'engine', ref: 0 };
  registerNative((name: string, matcher: any, handler: any) => {
    const key = name === 'ui.render' ? matcher.component : name;
    const callback = typeof matcher === 'function' ? matcher : handler;
    hooks.set(key, callback);
    return { catch(fallback: any) {
      if (name === 'ui.render') hooks.set(key, async (...args: any[]) => {
        try { return await callback(...args); } catch { return fallback(...args); }
      });
    } };
  });
  const capture: any = captures[3], text = 'Identical native brief.';
  let current: any, phaseTrees: any[] = [], summaryTrees: any[] = [], forwarded: any, columns = 120;
  const renderAccess: string[] = [];
  const renderHost = new Proxy({}, { get(_, key) { renderAccess.push(String(key)); throw new Error('Render must use display state only'); } });
  const $: any = {
    plugin: { root: '/plugin' }, ui: { invalidate() {} }, env: { get: async () => undefined },
    session: { id: async () => 'native-session', root: async () => root + '/repo', append: async () => ({}) },
    fs: { stat: async (path: string) => ({ kind: 'dir', realPath: path }) },
    agent: { list: async () => [{ id: current.agentId, name: current.agentId, type: TYPE }] },
    store: { delete: async (key: string) => { store.delete(key); }, get: async (key: string) => clone(store.get(key) ?? null), set: async (key: string, value: any) => { store.set(key, clone(value)); } },
    clock: { now: async () => 1800000000000, every: () => ({ cancel() {} }), after: () => ({ cancel() {} }) },
    process: { run: async (argv: string[], init: any) => {
      if (argv[0] === 'node') return { exitCode: 0, stdout: '/host/node\n' };
      expect(argv[2]).toBe('status');
      expect(init.timeoutMs > 0 && init.timeoutMs <= 15000).toBe(true);
      const value = capture.processes.find((p: any) => p.kind === 'run' && p.request.argv[2] === 'status'
        && (p.request.argv[3] === '--all') === (argv[3] === '--all')).value;
      return { ...value, stdout: value.stdout.replaceAll('native-session:native-agent:turn-1',
        `native-session:${current.agentId}:${current.turnId}`) };
    }, spawn: (request: any) => {
      const command = request.argv[2];
      const record = capture.processes.find((p: any) => p.kind === 'spawn' && p.request.argv[2] === command
        && (command !== 'status' || (p.request.argv[3] === '--all') === (request.argv[3] === '--all')));
      const stream = (async function* () {
        if (command === 'task') for (const line of current.lines) {
          yield { stream: 'stdout', text: `[0] ${line}\n` };
          phaseTrees.push(await render(current.requestId, current.kind, current.text));
          if (exercise) summaryTrees.push(await hooks.get('ToolUse')(renderHost, { component: 'ToolUse', surface: 'terminal',
            viewport: { columns }, props: { tool: 'Agent', tool_use_id: current.uuid, input: { subagent_type: TYPE } } }, async () => engine));
        }
        for (const chunk of record.chunks) yield { ...chunk,
          text: chunk.text.replaceAll('native-session:native-agent:turn-1', `native-session:${current.agentId}:${current.turnId}`) };
      })();
      return Object.assign(stream, { result: Promise.resolve({ code: 0 }) });
    } },
  };
  const render = async (uuid: string, kind = 'unclassified', body = text) => {
    const input = { component: 'UserMessage', surface: 'terminal', requestId: uuid, viewport: { columns },
      props: { text: body, origin: { kind }, isExpanded: true } };
    const original = clone(input);
    let drawing: any;
    const tree = await hooks.get('UserMessage')(renderHost, input, async (e: any) => { drawing = forwarded = clone(e); return engine; });
    expect(input).toEqual(original);
    expect(drawing).toEqual({ ...original, props: { ...original.props, text: drawing.props.text } });
    return tree;
  };
  let appendCalls = 0;
  const append = async (uuid: string, agentId?: string, door = 'prompt', body = text, plain = false) => {
    const input = { uuid, agentId, door, origin: { kind: plain ? 'coordinator' : agentId ? 'unclassified' : 'composer' },
      message: { type: 'user', content: plain ? body : [{ type: 'text', text: body }] } };
    const result = { uuid, message: input.message };
    const next = async (e: any) => { expect(e).toEqual(input); appendCalls++; return result; };
    expect(await (hooks.has('session.append') ? hooks.get('session.append')($, input, next) : next(input))).toEqual(result);
  };
  const run = async (agentId: string, turnId: string, before: boolean, lines: string[], body = text, appended = body, plain = false,
    row: { uuid?: string, echo?: boolean, append?: boolean } = {}) => {
    const uuid = row.uuid ?? `${agentId}:${turnId}`;
    current = { agentId, turnId, uuid, requestId: row.echo ? `${uuid}-echo` : uuid,
      kind: row.echo ? 'coordinator' : 'unclassified', lines, text: body };
    // plain: like a SendMessage follow-up, the row's content is a string and
    // turn.start receives the same framed text.
    const started = plain ? appended : body;
    store.set(`native:v2:native-session:${agentId}`, { type: TYPE, session: 'native-session', agentId, name: agentId,
      v: 2, cwd: root + '/repo', permissionMode: 'default', incoming: { turnId, text: started } });
    if (exercise) {
      await hooks.get('agent.spawn')($, { subagentType: TYPE, tool_use_id: current.uuid }, async () => ({ agentId }));
      store.delete(`native:binding-failed:v1:native-session:${agentId}`);
    }
    const write = (body: string) => row.append === false ? Promise.resolve() : append(current.uuid, agentId, 'prompt', body, plain);
    if (before) await write(appended);
    await hooks.get('classic.SubagentStart')($, { session_id: 'native-session', agent_id: agentId, agent_type: TYPE }, async () => ({}));
    await hooks.get('turn.start')($, { agentId, turnId, text: started }, async () => ({ turnId }));
    if (!before) await write(body);
    // A replayed row must not steal the next turn's binding.
    await write(body);
    phaseTrees = []; summaryTrees = [];
    const result = await drain(hooks.get('turn.step')($, { agentId, turnId, index: 0 }, () => { throw new Error('Unexpected model'); }));
    expect({ agentId, turnId, report: JSON.parse(result.result.answer) }).toEqual({ agentId, turnId, report: expect.objectContaining({ status: 'completed' }) });
    return { tree: clone(await render(current.requestId, current.kind, body)), phases: clone(phaseTrees), summaries: clone(summaryTrees) };
  };
  await append('parent');
  const first = await run('agent-a', 'turn-1', true,
    ['Bash(same) · running', 'Bash(same) · running', 'Bash(same) · Done (1s)', 'Bash(same) · Done (1s)']);
  const parent = await render('parent', 'composer'), unidentified = await render('unidentified');
  const second = await run('agent-b', 'turn-1', false, ['Codex: second agent']);
  const firstRetained = JSON.stringify(await render('agent-a:turn-1')) === JSON.stringify(first.tree);
  const frame = (body: string) => `The coordinator sent a message while you were working:\n${body}\n\nAddress this before completing your current task.`;
  // The appended coordinator row is hidden. Its visible echo has a separate
  // id and bare text, while turn.start receives the full framed text.
  const followup = await run('agent-a', 'turn-2', true, ['Codex: follow-up'], text,
    frame(text), true, { echo: true });
  const followupLog = JSON.stringify(followup.tree) === JSON.stringify(await render('agent-a:turn-2', 'coordinator', text));
  const uuid = '12345678-1234-1234-1234-123456789abc';
  const normalized = await run('agent-normalized', 'turn-1', true, ['Codex: normalized id'], text, text, false, { uuid });
  const normalizedId = normalized.tree.type === 'Box'
    && JSON.stringify(await render(uuid.slice(0, 24) + '000000000001')) === JSON.stringify(normalized.tree);
  await run('agent-prefix-collision', 'turn-1', true, ['Codex: colliding prefix'], text, text, false,
    { uuid: uuid.slice(0, 24) + 'bbbbbbbbbbbb' });
  const ambiguousPrefix = await render(uuid.slice(0, 24) + '000000000001');
  const repeated = 'Identical follow-up message.';
  // The same text cannot identify either turn, even within one agent. Both
  // echoes must stay undecorated when the newer row renders first.
  await run('agent-repeat', 'turn-1', true, ['Codex: first repeat'], repeated, frame(repeated), true);
  await run('agent-repeat', 'turn-2', true, ['Codex: second repeat', 'Codex: another entry'], repeated, frame(repeated), true);
  const nonCoordinator = await render('repeat-unclassified', 'unclassified', repeated);
  const unmatchedCoordinator = await render('unmatched-coordinator', 'coordinator', 'No recorded turn matches this message.');
  const echoOrder = [await render('repeat-echo-2', 'coordinator', repeated), await render('repeat-echo-1', 'coordinator', repeated)];
  // Re-rendering in chronological order must not resolve that ambiguity.
  const echoRetained = [await render('repeat-echo-1', 'coordinator', repeated), await render('repeat-echo-2', 'coordinator', repeated)];
  const extraEcho = await render('repeat-echo-3', 'coordinator', repeated);
  // Once the framed turn is consumed, identical bare first-turn text must
  // never supply another coordinator echo's log.
  const bareFallback = await render('bare-echo', 'coordinator', text);
  const unappended = await run('agent-unappended', 'turn-1', true, ['Codex: unappended'], 'Unappended follow-up.',
    frame('Unappended follow-up.'), true, { echo: true, append: false });
  const oldTurnsRetained = [first, second].map((value, i) =>
    render(`${i ? 'agent-b' : 'agent-a'}:turn-1`).then((tree: any) => JSON.stringify(tree) === JSON.stringify(value.tree)));
  const events = (tree: any) => (tree.children ?? []).slice(1).filter((row: any) => row.children?.[0]?.children?.[1]?.children?.[0]?.props.bold);
  const phases = first.phases.map(tree => events(tree).map((entry: any) => entry.children[0].children[0].children[0].props.color ?? 'dim'));
  const observed = { parent, unidentified, decorated: [first, second, followup].map(value => value.tree.type === 'Box'),
    firstRetained, oldTurnsRetained: await Promise.all(oldTurnsRetained), phases, appendCalls,
    binding: { followupLog, normalizedId, ambiguousPrefix, nonCoordinator, unmatchedCoordinator, echoOrder, echoRetained, extraEcho,
      bareFallback, unappended: unappended.tree.type === 'Box' } };
  const brief = '\nKeep this brief.\n\n  Preserve its indentation.\n';
  const header = "DUET: --model=gpt-6-astra --effort xhigh --fast --sandbox read-only --cwd '/very/long/absolute path/int-145/'\r\n";
  const projected = await run('agent-header', 'turn-1', true, ['Codex: header fixture'], header + brief);
  expect(forwarded.props.text).toBe(brief);
  const nodes = (tree: any): any[] => typeof tree === 'object' ? [tree, ...(tree.children ?? []).flatMap(nodes)] : [];
  const plain = await render(current.uuid, 'unclassified', brief);
  expect(forwarded.props.text).toBe(brief);
  const nonNative = await render('unidentified', 'unclassified', header + brief);
  expect(forwarded.props.text).toBe(header + brief);
  const invalid = 'DUET: --unsupported\n' + brief;
  const fallback = await render(current.uuid, 'unclassified', invalid);
  expect(forwarded.props.text).toBe(invalid);
  if (exercise) await exercise({ run, setColumns: (value: number) => { columns = value; },
    setHome: (value: string) => { $.env.get = async (name: string) => name === 'HOME' ? value : undefined; } });
  const shared = 'Same follow-up for different agents.';
  await run('agent-ambiguous-a', 'turn-1', true, ['Codex: first candidate'], shared, frame(shared), true);
  await run('agent-ambiguous-b', 'turn-1', true, ['Codex: second candidate', 'Codex: another entry'], shared, frame(shared), true);
  const ambiguous = [await render('ambiguous-echo-1', 'coordinator', shared), await render('ambiguous-echo-2', 'coordinator', shared)];
  // Expire only the older candidate through the 256-turn retention boundary.
  // Losing history cannot identify the old echo, so it must remain unbound.
  // These starts record display history without running any additional jobs.
  for (let i = 0; i < 255; i++) {
    const turnId = `retention-${i}`, agentId = 'agent-ambiguous-b', text = 'Unrelated retention fixture.';
    const key = `native:v2:native-session:${agentId}`;
    store.set(key, { ...store.get(key), incoming: { turnId, text } });
    await hooks.get('turn.start')($, { agentId, turnId, text }, async () => ({ turnId }));
  }
  const ambiguityResolved = await render('ambiguous-echo-1', 'coordinator', shared);
  const ambiguityConsumed = await render('ambiguous-echo-3', 'coordinator', shared);
  return { ...observed, ambiguity: { ambiguous, resolved: ambiguityResolved, consumed: ambiguityConsumed }, projection: {
    hostNodes: nodes(projected.tree).filter(node => node.type === 'engine').length,
    promptAndLogKept: nodes(plain).every(node => nodes(projected.tree).some(other => JSON.stringify(node) === JSON.stringify(other)) || node === plain),
    nonNative, fallback, renderAccess
  } };
}

function fixture(on: any, observeProgress?: (notices: any) => Promise<void>) {
  let agents: any[] = [], store = new Map(), processes: any[] = [], expectedPrompt: string;
  let permissionMode = 'unknown';
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
  on('store.set', (_: any, e: any) => {
    store.set(e.key, clone(e.value));
    // Observe admission while its producer is suspended, without changing
    // replay chunks or depending on how quickly the turn stream is drained.
    if (observeProgress && e.value.notices?.count) return observeProgress(clone(e.value.notices)).then(() => ({ value: undefined }));
    return { value: undefined };
  });
  on('agent.list', () => {
    if (listFailure) throw new Error('Injected agent-list failure');
    return { value: agents };
  });
  on('classic.SubagentStart', () => ({}));
  on('tool.call', () => ({ result: {} }));
  on('agent.spawn', (_: any, e: any) => {
    if (e.subagentType === TYPE) {
      permissionMode = e.permissionMode ?? 'unknown';
      expect(e.prompt).toBe(expectedPrompt);
      agents = [{ id: 'native-agent', type: TYPE, name: e.name, description: e.description, status: 'running' }];
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
    // Historical captures predate internal permission context. Assert its
    // exact host values, then compare the unchanged legacy request. Fresh
    // integration captures contain these fields and are compared in full.
    if (expected && !expected.request.argv.includes('--claude-permission-mode') && normalized.argv.includes('--claude-permission-mode')) {
      const at = normalized.argv.indexOf('--claude-permission-mode');
      expect(normalized.argv.slice(at, at + 4)).toEqual(['--claude-permission-mode', permissionMode, '--native-cwd', root + '/repo']);
      normalized.argv.splice(at, 4);
    }
    // The engine supplies this checkout's plugin root; capture paths are portable.
    if (normalized.argv[1]?.endsWith('/plugins/codex/scripts/codex-companion.mjs') && normalized.argv[2] === 'reserve-name') {
      if (normalized.argv[0] !== 'node') normalized.argv[0] = '/host/node';
      normalized.argv[1] = '/plugin/scripts/codex-companion.mjs';
    } else if (normalized.argv[0] !== 'node') {
      if (!normalized.argv[1].endsWith('/plugins/codex/bin/fugato')) problems.push('Wrong launcher');
      normalized.argv[0] = '/host/node';
      normalized.argv[1] = '/plugin/bin/fugato';
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
    notices: () => transcript.appended(),
    async replay($: any, capture: any, discoveryDown = false) {
      const replayedChunks: any[] = [];
      store = new Map(); processes = clone(capture.processes); agents = [];
      listFailure = discoveryDown;
      if (discoveryDown) {
        await $.classic.SubagentStart({ session_id: sessionId, agent_id: 'native-agent', agent_type: TYPE });
        // The observed Agent spawn retains the explicit name even when list
        // discovery is unavailable; replay the same name and dispatch argv.
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
          replayedChunks.push(...chunks);
          expect(chunks).toEqual(event.chunks);
          expect(result).toEqual(event.result);
        } else expect(await $[noun][verb](event.input)).toEqual(event.result);
        if (event.event === 'turn.start') {
          const { agentId, turnId, text } = event.input;
          await $.session.append({ uuid: `${agentId}:${turnId}`, agentId, door: 'prompt', origin: { kind: 'unclassified' },
            message: { type: 'user', content: [{ type: 'text', text }] } });
        }
      }
      // Host prompt rows above are fixture input; captured plugin notices must
      // still match byte for byte, with no additional durable plugin output.
      expect(transcript.appended().filter((row: any) => row.door !== 'prompt')
        .map((row: any) => ({ agentId: row.agentId, message: { type: row.message.type, content: row.message.content } }))).toEqual(capture.notices);
      expect(processes).toHaveLength(0);
      expect(problems).toEqual([]);
      const stored: any = clone(Object.fromEntries(store));
      for (const [key, value] of Object.entries(stored) as any) {
        if (value.nativeHostCwd !== undefined && capture.store[key]?.nativeHostCwd === undefined) {
          expect(value.nativeHostCwd).toBe(root + '/repo'); delete value.nativeHostCwd;
        }
        if (value.claudePermissionMode !== undefined && capture.store[key]?.claudePermissionMode === undefined) {
          expect(value.claudePermissionMode).toBe(value.permissionMode ?? 'unknown'); delete value.claudePermissionMode;
        }
      }
      expect(stored).toEqual(capture.store);
      expect(modelCalls).toBe(0);
      listFailure = false;
      return replayedChunks;
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
  // Replays drive real UI mounts and recovery timers; a loaded machine needs headroom.
  test(`native replay ${index + 1}: ${capture.behavior}`, { timeoutMs: 30000 }, async ($, on) => {
    const f = fixture(on), prompts: any[] = [];
    const engine = { type: 'engine', ref: 0 };
    if (index === 0) {
      on('ui.render', { component: 'UserMessage' }, () => engine as any);
      for (const event of capture.events.filter((event: any) => event.event === 'turn.start')) {
        prompts.push(await $.ui.mount({ plugin: 'codex', surface: 'terminal', component: 'UserMessage',
          requestId: `${event.input.agentId}:${event.input.turnId}`,
          props: { text: event.input.text, origin: { kind: 'unclassified' }, isExpanded: true } }));
      }
    }
    try {
      for (const ui of prompts) expect(await ui.drawn()).toEqual(engine);
      await f.replay($, capture);
      // A follow-up must retain the preceding turn's log under its own prompt.
      for (const ui of prompts) {
        const tree = await ui.drawn();
        expect(tree.children[0]).toEqual(engine);
        expect(tree.children.length > 1).toBe(true);
      }
    } finally { for (const ui of prompts) await ui.unmount(); }
  });
}

test('other loops pass untouched; process and hook failures block without a model', async ($, on) => {
  const f = fixture(on);
  await f.isolation($);
  await f.errors($);
});

test('typed blockers preserve runtime recovery and only native reports are projected', async ($, on) => {
  const f = fixture(on), reports = new Map();
  let drawn: any;
  on('ui.render', { component: 'AssistantMessage' }, (_, e) => { drawn = e; return { type: 'engine', ref: 0 }; });
  for (const code of ['fixture_blocker', 'context_window_exceeded', 'provider_refused', 'auth_required']) {
    reports.set(code, await f.report($, { status: 'blocked', blockers: [{ code }] }));
  }
  for (const code of ['context_window_exceeded', 'provider_refused', 'auth_required']) {
    expect(reports.get(code).next).not.toBe(reports.get('fixture_blocker').next);
    const next = 'fugato status predecessor --json';
    expect((await f.report($, { status: 'blocked', blockers: [{ code }, { code: 'thread_busy' }], next })).next).toBe(next);
  }
  const render = async (text: string) => {
    await $.ui.render({ surface: 'terminal', component: 'AssistantMessage', requestId: 'report', props: { text } });
    return drawn.props.text;
  };
  const native = captures[3].events.find((event: any) => event.event === 'turn.step').result.answer;
  expect(await render(native)).not.toBe(native);
  const legacy = JSON.stringify({ ...JSON.parse(native), details: `duet result '${JSON.parse(native).jobId}' --details` });
  expect(await render(legacy)).toBe(await render(native));
  const question = 'Choose the fixture direction?';
  expect(await render(JSON.stringify({ ...JSON.parse(native), status: 'needs_answer',
    question: { text: question, options: ['A', 'B'] } }))).toContain(question);
  for (const text of ['ordinary assistant text', JSON.stringify({ status: 'completed', summary: 'ordinary JSON' }),
    JSON.stringify({ ...JSON.parse(native), data: { kept: true } })]) {
    expect(await render(text)).toBe(text);
  }
});

test('SubagentStart identifies the first native turn while discovery rejects; other types still pass through', async ($, on) => {
  const f = fixture(on);
  await f.replay($, captures[3], true);
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
  lines.splice(0, 6, 'Codex: progress · running', 'Bash(example) · Done (1s)', 'Bash(example) · Error: exit 1 (1s)',
    '✓ exit 0 · 1.0s · legacy command', '✗ legacy failure', '? Waiting for Claude: discuss · running');
  const liveOnly = ['▸ legacy command', 'Bash(example) · running'];
  const longLine = 'y'.repeat(240);
  task.chunks.unshift(
    { stream: 'stderr', text: '[1] stderr must never be progress\n' },
    { stream: 'stdout', text: '[0' },
    { stream: 'stdout', text: '] repeat\n[1] repeat\n' + liveOnly.map(text => `[2] ${text}\n`).join('') + '[2] ' + 'x'.repeat(5000) },
    { stream: 'stdout', text: '\n[3] ' + longLine + '\n' + lines.map((text, i) => `[${i + 4}] ${text}\n`).join('') },
  );
  // After the durable cap, keep activity arriving between heartbeat ticks.
  // Neither repeated lines nor live-only command starts may starve the stream.
  task.timeline = [
    ...task.chunks.slice(0, 4).map((chunk: any) => ({ chunk })),
    ...['burst 244', ...liveOnly, 'burst 244'].flatMap(text => [
      { advance: 15000 }, { chunk: { stream: 'stdout', text: `[250] ${text}\n` } },
    ]),
    { advance: 30000 },
    ...task.chunks.slice(4).map((chunk: any) => ({ chunk })),
  ];
  const start = capture.notices[0];
  // The final usage notice is exempt from the progress cap.
  const usage = capture.notices.filter((n: any) => n.message.content[0].text.startsWith('Codex tokens (provider: OpenAI Codex,'));
  capture.notices = [start, ...['repeat', longLine.slice(0, 200), ...lines.slice(0, 197)].map(text => ({ agentId: 'native-agent',
    message: { type: 'system', content: [{ type: 'text', text }] } })), ...usage];
  step.chunks = [...capture.notices.slice(0, 200).map((notice: any) => ({ kind: 'thinking', index: 0,
    text: notice.message.content[0].text + '\n' })),
    ...Array.from({ length: 3 }, () => ({ kind: 'thinking', index: 0, text: expect.any(String) })),
    ...step.chunks.filter((chunk: any) => chunk.kind !== 'thinking')];
  const state: any = Object.values(capture.store)[0];
  state.finishedAt += 90000;
  state.notices = { turnId: 'turn-1', count: 200, last: 'burst 196', started: true };
  if (usage.length) Object.assign(state.notices, { count: 200 + usage.length, last: usage.at(-1).message.content[0].text, usage: true });
  const engine = { type: 'engine', ref: 0 };
  let spinner: any, toolRow: any, promptRow: any, endedLog: any, refusedRow: any;
  let replayedChunks: any[] = [], nativeSpinnerHostCalls = 0;
  const counts: number[] = [];
  const f = fixture(on, async notices => {
    if (counts.at(-1) === notices.count || ![1, 5, capture.notices.length].includes(notices.count)) return;
    counts.push(notices.count);
    expect((await spinner.drawn()).type).toBe('Box');
    expect(nativeSpinnerHostCalls).toBe(0);
    const tree = await promptRow.drawn();
    expect(tree.children[0]).toEqual(engine);
    expect(tree.children.length > 1).toBe(true);
    expect((await toolRow.drawn()).children[0]).toEqual(engine);
    endedLog = clone(tree);
  });
  on('ui.render', { component: 'Spinner' }, () => { nativeSpinnerHostCalls++; return engine as any; });
  on('ui.render', { component: 'ToolUse' }, () => engine as any);
  on('ui.render', { component: 'UserMessage' }, () => engine as any);
  spinner = await $.ui.mount({ plugin: 'codex', surface: 'terminal', component: 'Spinner', requestId: 'native-agent',
    props: { word: 'Working', message: null, suffix: '…', mode: 'thinking' } });
  promptRow = await $.ui.mount({ plugin: 'codex', surface: 'terminal', component: 'UserMessage',
    requestId: 'native-agent:turn-1', props: { text: capture.events.find((event: any) => event.event === 'turn.start').input.text,
      origin: { kind: 'unclassified' }, isExpanded: true } });
  toolRow = await $.ui.mount({ plugin: 'codex', surface: 'terminal', component: 'ToolUse', requestId: 'spawn-1',
    props: { tool_use_id: 'spawn-1', tool: 'Agent', input: { subagent_type: TYPE },
      isRunning: false, isErrored: false, isInterrupted: false } });
  try {
    expect(await spinner.drawn()).toEqual(engine);
    nativeSpinnerHostCalls = 0;
    replayedChunks = await f.replay($, capture);
    expect(counts).toEqual([1, 5, capture.notices.length]);
    expect(await promptRow.drawn()).toEqual(endedLog);
    expect(f.notices().filter((notice: any) => liveOnly.includes(notice.message.content[0].text))).toHaveLength(0);
    await $.turn.start({ agentId: 'native-agent', turnId: 'refused-turn', text: 'x'.repeat(65537) });
    const refused = await drain($.turn.step({ ...step.input, turnId: 'refused-turn' }));
    expect(JSON.parse(refused.result.answer).status).toBe('blocked');
    refusedRow = await toolRow.drawn();
  } finally {
    for (const ui of [spinner, toolRow, promptRow]) await ui.unmount();
  }
  expect(capture.notices).toHaveLength(200 + usage.length);
  const thinking = replayedChunks.filter((chunk: any) => chunk.kind === 'thinking');
  expect(thinking).toHaveLength(203);
  expect(thinking.every((chunk: any) => chunk.text.trimEnd().length <= 200)).toBe(true);
  expect(step.result.answer.includes('burst')).toBe(false);
  expect(step.result.answer.includes('repeat')).toBe(false);
  const append = await faultKeepalives('append'), lookup = await faultKeepalives('lookup');
  expect({ refusedRow, append, lookup }).toEqual({ refusedRow: engine,
    append: { thinking: 24, notices: 1, finalChunks: 0, liveUpdates: 23 }, lookup: { thinking: 24, notices: 0, finalChunks: 0, liveUpdates: 23 } });
  const queue = await faultKeepalives('queue'), display = await displayReplay();
  expect({ queue, display }).toEqual({ queue: { maxHeartbeatPending: 1, heartbeatPending: 1 }, display: {
    parent: engine, unidentified: engine, decorated: [true, true, true], firstRetained: true, oldTurnsRetained: [true, true],
    phases: [['dim'], ['dim', 'dim'], ['success', 'dim'], ['success', 'success']], appendCalls: 15,
    binding: { followupLog: true, normalizedId: true, ambiguousPrefix: engine, nonCoordinator: engine, unmatchedCoordinator: engine,
      echoOrder: [engine, engine], echoRetained: [engine, engine], extraEcho: engine, bareFallback: engine, unappended: true },
    ambiguity: { ambiguous: [engine, engine], resolved: engine, consumed: engine },
    projection: { hostNodes: 1, promptAndLogKept: true, nonNative: engine, fallback: engine, renderAccess: [] }
  } });
  for (const fault of ['owner-append', 'owner-save'] as const) {
    expect(await faultKeepalives(fault)).toEqual({ injected: true, consumed: true, earlyClose: false, logged: true });
  }
});

test('compact logs retain failed and unfamiliar commands beside folded exploration', async () => {
  await displayReplay(async ({ run }: any) => {
    const plain = (node: any): string => typeof node === 'string' ? node : (node.children ?? []).map(plain).join('');
    const entries = (tree: any) => tree.children.filter((entry: any) => entry.props?.flexDirection === 'column'
      && (entry.children[0]?.children.length === 3 || entry.children[0]?.children[0]?.props.color === 'text'));
    const foldCount = (entry: any) => Number(/· (\d+) commands/.exec(plain(entry))?.[1] ?? 0);
    const command = (text: string, result = 'Done') => `Bash(${text}) · ${result}`;
    const result = await run('compact', 'turn-1', true, [command('cat a'), command('rg --files lib'),
      command('node change.mjs', 'Error: exit 1')]);
    const log = entries(result.phases.at(-1));
    expect(log.map(foldCount)).toEqual([2, 0]);
    expect(log.at(-1).children[0].children[0].children[0].props.color).toBe('error');
    // Commands the display cannot classify must remain visible individually.
    for (const [index, text] of ['cat b > output', 'find . -de"lete"', 'rg --pre=script x b'].entries()) {
      const boundary = await run(`boundary-${index}`, 'turn-1', true, ['cat a', text, 'cat c'].map(value => command(value)));
      expect(entries(boundary.phases.at(-1)).map(foldCount)).toEqual([0, 0, 0]);
    }
    const paired = await run('paired', 'turn-1', true, [command('cat a', 'running'), command('cat a', 'running'),
      command('cat a'), command('cat a'), command('rg x b', 'running'), command('rg x b', 'Error: exit 3')]);
    expect(entries(paired.phases.at(-1)).map(foldCount)).toEqual([2, 0]);
  });
});
