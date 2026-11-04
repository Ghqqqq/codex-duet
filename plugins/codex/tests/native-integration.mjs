// Run: node --test plugins/codex/tests/native-integration.mjs
// Replays fresh real-companion captures from a temporary plugin copy.
// Set UPDATE_NATIVE_CAPTURES=1 to also replace the tracked replay fixtures.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { installFakeCodex as generateFakeCodex } from '../../../tests/fake-codex-fixture.mjs';
import { register } from '../hooks/register.mjs';
import { AGENT_TYPE } from '../hooks/native-agent.mjs';
import { AGENT_NAMES } from '../scripts/lib/agent-names.mjs';
import { instructionInventory } from '../hooks/claude-memory.mjs';
import { EXECUTOR_FRAMING, writeClaudeSnapshot } from '../scripts/lib/claude-memory.mjs';
import { isC2Report } from '../scripts/lib/report-delivery.mjs';
import { updateJob } from '../scripts/lib/state.mjs';
import { register as reportHooks } from '../hooks/report-delivery.mjs';
import { lifecycleStoreSize } from '../hooks/lifecycle-hooks.mjs';
import { createRoom, postEvent, readRoom, setStatus, updateMember, pending as forumPending } from '../scripts/lib/forum.mjs';

const plugin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const captures = [];
const roots = [];
// Every fixture retains its own state and process ledger while executable
// bytes are shared. No broker, job, adapter store or Codex thread is shared.
const suiteRoot = process.env.CODEX_COMPANION_TEST_ROOT;
const cacheRoot = fs.mkdtempSync(path.join(suiteRoot, 'native-codex-'));
const executableCache = new Map();
let gitTemplate;
function initGitRepo(cwd) {
  if (!gitTemplate) {
    gitTemplate = path.join(cacheRoot, 'repo');
    fs.mkdirSync(gitTemplate);
    const result = spawnSync('git', ['init', '-q', gitTemplate]);
    assert.equal(result.status, 0, result.stderr?.toString());
  }
  fs.cpSync(path.join(gitTemplate, '.git'), path.join(cwd, '.git'), { recursive: true });
}
function installFakeCodex(dir, behavior, mutable) {
  if (mutable) return generateFakeCodex(dir, behavior);
  if (!executableCache.has(behavior)) {
    const cached = fs.mkdtempSync(path.join(cacheRoot, 'bin-'));
    generateFakeCodex(cached, behavior);
    const file = path.join(cached, 'codex'), original = fs.readFileSync(file, 'utf8');
    const literal = JSON.stringify(path.join(cached, 'fake-codex-state.json'));
    const source = original.replace(`const STATE_PATH = ${literal};`,
      'const STATE_PATH = process.env.CODEX_FIXTURE_STATE_PATH;');
    assert.notEqual(source, original);
    assert.equal(source.replace('process.env.CODEX_FIXTURE_STATE_PATH', literal), original);
    fs.writeFileSync(file, source);
    executableCache.set(behavior, file);
  }
  fs.symlinkSync(executableCache.get(behavior), path.join(dir, 'codex'));
}
const clone = value => JSON.parse(JSON.stringify(value));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (const deadline = Date.now() + 20000; Date.now() < deadline; await delay(25)) {
    const value = await check();
    if (value) return value;
  }
  throw new Error('Fixture did not reach the expected state');
}

function fixture(behavior, name = 'native-worker', { mutable = false, memoryStore = false, hostOnly = false } = {}) {
  const root = fs.mkdtempSync(path.join(suiteRoot, 'native-'));
  roots.push(root);
  for (const part of ['bin', 'repo', 'home', 'normal']) fs.mkdirSync(`${root}/${part}`);
  if (!hostOnly) {
    installFakeCodex(`${root}/bin`, behavior, mutable);
    initGitRepo(`${root}/repo`);
  }
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('CODEX_') || key.startsWith('CLAUDE_')) delete env[key];
  Object.assign(env, { HOME: `${root}/home`, USERPROFILE: `${root}/home`, CODEX_HOME: `${root}/normal`,
    CODEX_SQLITE_HOME: `${root}/normal`, CODEX_COMPANION_NORMAL_HOME: `${root}/normal`, CODEX_COMPANION_NORMAL_SQLITE_HOME: `${root}/normal`,
    CODEX_COMPANION_HOME: `${root}/isolated`, CODEX_COMPANION_BIN: `${root}/bin/codex`,
    CLAUDE_PLUGIN_DATA: `${root}/data`, CODEX_COMPANION_TEST_MODE: '1', CODEX_COMPANION_TEST_ROOT: suiteRoot,
    CODEX_FIXTURE_STATE_PATH: `${root}/bin/fake-codex-state.json`,
    CODEX_COMPANION_TEST_PROCESSES: `${root}/processes`, CODEX_COMPANION_BROKER_IDLE_SEC: '2' });
  const storeFile = `${root}/adapter-store.json`;
  fs.writeFileSync(storeFile, '{}');
  // Pure host interleavings use a serialized in-memory store. Integration
  // cases retain the disk store, including reload/persistence-gap captures.
  let memory = {};
  const readStore = () => memoryStore ? clone(memory) : JSON.parse(fs.readFileSync(storeFile, 'utf8'));
  const setStore = data => {
    if (memoryStore) memory = clone(data);
    else fs.writeFileSync(storeFile, JSON.stringify(data));
  };
  const jobs = () => {
    const directory = `${root}/isolated/duet/sessions/native-session`;
    return fs.existsSync(directory) ? fs.readdirSync(directory).filter(name => name.endsWith('.json')).map(name => {
      const marker = JSON.parse(fs.readFileSync(`${directory}/${name}`, 'utf8'));
      return JSON.parse(fs.readFileSync(marker.jobFile, 'utf8'));
    }) : [];
  };
  const capture = { behavior, events: [], processes: [], notices: [] };
  const pluginState = new Map();
  let now = 1800000000000;
  const timers = new Set();
  let controller = new AbortController(), agents = [], hooks, toolHooks;
  let modelCalls = 0, onWait, syntheticUsage;
  const $ = {
    plugin: { name: 'fugato', root: plugin },
    session: { id: async () => 'native-session', cwd: async () => `${root}/repo`, root: async () => `${root}/repo`,
      append: async notice => { capture.notices.push(clone(notice)); return { message: notice.message, uuid: String(capture.notices.length) }; } },
    agent: { list: async () => agents },
    state: {
      get: async ref => clone(pluginState.get(`${ref.plugin}:${ref.key}`) ?? { version: 0 }),
      set: async (ref, value, { ifVersion } = {}) => {
        const key = `${ref.plugin}:${ref.key}`, version = pluginState.get(key)?.version ?? 0;
        if (ifVersion !== undefined && ifVersion !== version) return { isSet: false, version };
        pluginState.set(key, { value: clone(value), version: version + 1 });
        return { isSet: true, version: version + 1 };
      },
    },
    settings: { read: async () => ({}) },
    env: { get: async name => env[name], set: async (name, value) => { env[name] = value; } },
    clock: { now: async () => now, every(ms, fn) {
      const timer = { ms, due: now + ms, fn }; timers.add(timer);
      return { cancel: () => timers.delete(timer) };
    }, after(ms, fn) {
      const timer = { ms, due: now + ms, fn, once: true }; timers.add(timer);
      return { cancel: () => timers.delete(timer) };
    } },
    fs: { stat: async file => {
      const stat = fs.statSync(file);
      return { kind: stat.isDirectory() ? 'dir' : 'file', realPath: fs.realpathSync(file), size: stat.size, mtimeMs: stat.mtimeMs };
    },
      exists: async file => fs.existsSync(file),
      write: async (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); } },
    store: {
      get: async key => memoryStore ? (key in memory ? clone(memory[key]) : undefined) : readStore()[key],
      keys: async () => Object.keys(memoryStore ? memory : readStore()),
      delete: async key => {
        if (memoryStore) delete memory[key];
        else { const data = readStore(); delete data[key]; setStore(data); }
      },
      set: async (key, value) => {
        if (memoryStore) memory[key] = clone(value);
        else setStore({ ...readStore(), [key]: value });
      },
    },
    model: new Proxy({}, { get() { modelCalls++; throw new Error('Forbidden model request'); } }),
    process: {
      spawn(request) {
        const record = { kind: 'spawn', request: clone(request), chunks: [] };
        capture.processes.push(record);
        let settle, fail;
        const result = new Promise((resolve, reject) => { settle = resolve; fail = reject; });
        // Observe rejection even if the caller exits the stream early.
        result.catch(() => {});
        const signal = controller.signal;
        async function* stream() {
          const child = spawn(request.argv[0], request.argv.slice(1), {
            cwd: request.cwd, env: { ...env, ...request.env }, stdio: ['pipe', 'pipe', 'pipe'],
          });
          const queue = [];
          let wake, ended = false, error, unread = 0;
          // 2.1.302 ProcessSpawnChunk: cap unread text at 1,048,576 characters,
          // apply backpressure, and settle result after the stream is drained.
          const push = value => {
            queue.push(value); unread += value.text.length;
            if (unread >= 1048576) { child.stdout.pause(); child.stderr.pause(); }
            wake?.();
          };
          child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
          child.stdout.on('data', text => push({ stream: 'stdout', text }));
          child.stderr.on('data', text => push({ stream: 'stderr', text }));
          child.on('error', value => { error = value; ended = true; wake?.(); });
          child.on('close', (code, signal) => { record.exit = { code, signal }; ended = true; wake?.(); });
          const kill = () => child.kill('SIGTERM');
          signal.addEventListener('abort', kill, { once: true });
          child.stdin.end(request.input ?? '');
          // Stop an attached owner, even when the initial task now waits for
          // the whole turn instead of handing off to a separate wait process.
          const stopTimer = onWait && ['task', 'answer', 'wait'].includes(request.argv[2]) ? setInterval(() => {
            if (jobs().some(job => job.ownerWaitPid === child.pid && job.turnId)) { clearInterval(stopTimer); onWait(); }
          }, 25) : null;
          try {
            while (!ended || queue.length) {
              if (!queue.length) { await new Promise(resolve => { wake = resolve; }); wake = undefined; continue; }
              const chunk = queue.shift(); unread -= chunk.text.length;
              if (unread < 1048576) { child.stdout.resume(); child.stderr.resume(); }
              record.chunks.push(chunk); record.timeline?.push({ chunk }); yield chunk;
            }
            if (error) throw error;
            // The hook host rejects an aborted stream even if the child wrote
            // owner_stopped before exiting; that output is not a return value.
            if (signal.aborted) {
              record.error = `$.process.spawn(${request.argv[0]}) aborted`;
              throw Object.assign(new Error(record.error), { name: 'AbortError' });
            }
            if (syntheticUsage && request.argv[2] === 'task') {
              const report = JSON.parse(record.chunks.filter(c => c.stream === 'stdout').map(c => c.text).join('').trim().split('\n').at(-1));
              const chunk = { stream: 'stdout', text: JSON.stringify({ ...report, usage: syntheticUsage }) + '\n' };
              record.chunks.push(chunk); record.timeline?.push({ chunk }); yield chunk;
            }
            settle(record.exit); return record.exit;
          } catch (error) { fail(error); throw error; }
          finally {
            clearInterval(stopTimer); signal.removeEventListener('abort', kill);
            if (!ended) { kill(); fail(new Error('Spawn stream closed before EOF')); }
          }
        }
        return Object.assign(stream(), { result });
      },
      async run(argv, init) {
        // Claude Code 2.1.302 refuses host process calls in a dispatch aborted
        // from /tasks (observed live); turn.complete runs as its own dispatch.
        if (controller.signal.aborted) throw new Error(`$.process.run(${argv[0]}) aborted`);
        const result = spawnSync(argv[0], argv.slice(1), {
          cwd: init.cwd, env: { ...env, ...init.env }, input: init.stdin, encoding: 'utf8', timeout: init.timeoutMs,
        });
        if (result.error) throw result.error;
        const value = { exitCode: result.status, stdout: result.stdout, stderr: result.stderr,
          isStdoutTruncated: false, isStderrTruncated: false };
        capture.processes.push({ kind: 'run', request: { argv, init }, value });
        return value;
      },
    },
  };
  function reload(record = true, install = register) {
    if (record) capture.events.push({ event: 'reload', store: readStore() });
    hooks = new Map(); toolHooks = [];
    install((event, matcher, fn) => {
      if (typeof matcher === 'function') fn = matcher;
      const entry = { fn, matcher: typeof matcher === 'function' ? null : matcher };
      if (event === 'tool.call') toolHooks.push(entry);
      else hooks.set(event === 'ui.render' ? `${event}:${matcher.component}` : event, entry);
      return { catch(handler) { entry.catch = handler; } };
    });
  }
  reload(false);
  async function invoke(event, input, bottom) {
    const e = clone(input), record = { event, input: e };
    capture.events.push(record);
    let called = false, cached;
    const next = Object.assign(input => {
      if (called && event !== 'turn.step') return cached;
      called = true;
      return cached = bottom(input);
    }, { signal: controller.signal });
    // Roundtable's unfiltered post-tool hook composes with the native Agent
    // matcher; model the host's hook frames instead of overwriting either one.
    const hook = event === 'tool.call' ? { fn: async ($, e, next) => {
      const dispatch = async (index, input) => {
        const current = toolHooks[index];
        if (!current) return next(input);
        const onward = Object.assign(value => dispatch(index + 1, value), { signal: next.signal });
        if (current.matcher?.tool && current.matcher.tool !== input.tool) return onward(input);
        try { return await current.fn($, input, onward); }
        catch (error) { if (!current.catch) throw error; return current.catch($, input, onward); }
      };
      return dispatch(0, e);
    } } : hooks.get(event === 'ui.render' ? `${event}:${e.component}` : event);
    if (event === 'turn.step') {
      const value = (async function* () {
        try { return yield* (hook ? hook.fn($, e, next) : next(e)); }
        catch (error) { if (!hook?.catch) throw error; return yield* hook.catch($, e, next); }
      })();
      const chunks = []; let step;
      do { step = await value.next(); if (!step.done) { chunks.push(step.value); record.chunks = chunks; } } while (!step.done);
      record.chunks = chunks; record.result = step.value; record.processCount = capture.processes.length;
      assert.equal(step.value.usage, null);
      assert.deepEqual(chunks.at(-1), { kind: 'stop', stopReason: 'end_turn', usage: null });
      assert.equal(chunks.filter(c => c.kind === 'text').map(c => c.text).join(''), step.value.answer);
      return step.value;
    }
    try { record.result = await (hook ? hook.fn($, e, next) : next(e)); }
    catch (error) { if (!hook?.catch) throw error; record.result = await hook.catch($, e, next); }
    return record.result;
  }
  async function turn(text, number, aborted = false, options = {}) {
    controller = new AbortController();
    let rewritten;
    const agentId = options.agentId ?? 'native-agent';
    const agentType = options.agentType ?? AGENT_TYPE;
    const toolUseId = options.agentId ? `spawn-${agentId}-${number}` : `spawn-${number}`;
    let agentName = options.name ?? (number > 1 ? agents.find(agent => agent.id === agentId)?.name ?? name : name);
    if (options.toolCall || options.effort || options.isolation || agentName === null) await invoke('tool.call', { tool: 'Agent', tool_use_id: toolUseId,
      subagent_type: agentType, description: 'Native fake task', prompt: text, effort: options.effort, isolation: options.isolation,
      ...(agentName === null ? {} : { name: agentName }), ...(number > 1 ? { resume: agentId } : {}) },
    async e => { agentName = e.name; return options.toolResult ?? { result: {} }; });
    const spawnInput = { tool_use_id: toolUseId, prompt: text, description: 'Native fake task',
      subagentType: agentType, provider: { plugin: 'fugato', tier: 'user' }, parentModel: 'haiku',
      background: options.background ?? true, permissionMode: options.permissionMode ?? 'default',
      fork: false, name: agentName, cwd: `${root}/repo`,
      ...(options.teammate ? { isTeammate: true } : {}),
      ...(number > 1 ? { resume: { agentId } } : {}) };
    const spawning = options.wake ? Promise.resolve(rewritten = text) : invoke('agent.spawn', spawnInput, async e => {
      rewritten = e.prompt;
      agents = [...agents.filter(agent => agent.id !== agentId), { id: agentId, type: agentType, name: e.name, description: e.description, status: 'running',
        ...(options.teammate ? { teammateId: `${e.name}@fixture` } : {}) }];
      return { model: 'haiku', agentId, ...(options.teammateId ? { teammateId: options.teammateId } : {}) };
    });
    await spawning;
    await options.afterSpawn?.();
    await invoke('turn.start', { agentId, turnId: `turn-${number}`, text: rewritten }, async e => ({ turnId: e.turnId }));
    const result = await invoke('turn.step', { agentId, turnId: `turn-${number}`, index: 0, model: 'haiku', effort: 'low', messageCount: 1 }, async function* () {
      modelCalls++; throw new Error('Claude model bottom was reached');
    });
    if (aborted) controller = new AbortController();
    await options.beforeComplete?.();
    const completion = await invoke('turn.complete', { agentId, turnId: `turn-${number}`,
      answer: aborted ? '' : result.answer, durationMs: 1, isAborted: aborted, reason: aborted ? 'aborted' : 'answer' }, async e => ({ text: e.answer }));
    if (!aborted) assert.equal(completion.text, result.answer);
    assert.equal(modelCalls, 0);
    return JSON.parse(result.answer);
  }
  function save() {
    capture.store = readStore();
    // The engine replay has no host HOME. Availability helper calls are tested
    // directly below; retain only the companion calls that replay can make.
    const replayed = process => !process.request.argv[1]?.endsWith('/scripts/lib/setup-config.mjs');
    const replay = { ...capture, processes: capture.processes.filter(replayed), events: capture.events.map(event =>
      event.processCount === undefined ? event : { ...event, processCount: capture.processes.slice(0, event.processCount).filter(replayed).length }) };
    // Only fixture paths are replaced; every report/chunk originated in a child.
    const clean = JSON.stringify(replay).replaceAll(process.execPath, '/host/node').replaceAll(plugin, '/plugin').replaceAll(root, '/private/tmp/duet14-g-fixture');
    captures.push(JSON.parse(clean));
  }
  async function advance(ms) {
    const record = capture.processes.find(p => p.kind === 'spawn' && !p.exit && ['task', 'wait', 'answer'].includes(p.request.argv[2]));
    assert.ok(record, 'Heartbeat must occur while process I/O is pending');
    record.timeline ||= record.chunks.map(chunk => ({ chunk }));
    record.timeline.push({ advance: ms });
    const end = now + ms;
    for (;;) {
      const timer = [...timers].filter(t => t.due <= end).sort((a, b) => a.due - b.due)[0];
      if (!timer) break;
      now = timer.due; timer.due += timer.ms; if (timer.once) timers.delete(timer); await timer.fn();
      await delay(0);
    }
    now = end;
    await delay(0);
  }
  return { abort: () => controller.abort(), root, $, turn, reload, readStore, save, invoke, env, capture, jobs, advance, timers,
    withUsage: usage => { syntheticUsage = usage; },
    setStore,
    codexState: () => JSON.parse(fs.readFileSync(`${root}/bin/fake-codex-state.json`, 'utf8')),
    // Stop as a person would: after the early handle lookup has run.
    stopOnWait: (beforeStop = async () => {}) => { onWait = async () => { await advance(1500); await beforeStop(); controller.abort(); }; },
  };
}

function steeringInbox(f, job) {
  const marker = JSON.parse(fs.readFileSync(`${f.root}/isolated/duet/sessions/native-session/${job.id}.json`, 'utf8'));
  return JSON.parse(fs.readFileSync(marker.jobFile.replace(/\.json$/, '.steering.json'), 'utf8'));
}
function steer(f, job, deliveryId, text) {
  const result = spawnSync(process.execPath, [plugin + '/bin/fugato', 'steer', job.id,
    '--delivery-id', deliveryId, '--cwd', `${f.root}/repo`, '--session', 'native-session'],
  { env: f.env, input: text, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function nativeRoom(f, personas = ['critic']) {
  const env = { ...f.env, CODEX_COMPANION_SESSION_ID: 'native-session' };
  const room = createRoom({ sessionId: 'native-session', workspaceRoot: `${f.root}/repo`, goal: 'Reach a checked shared result',
    members: personas.map(persona => ({ name: persona, persona, model: 'gpt-6-astra', effort: 'high' })) }, env);
  return { room, env, header: `DUET: --roundtable ${room.roomId} --persona critic\n`,
    post: (kind, mentions = [], title = 'Check the candidate') => postEvent(room.roomId, { kind: 'chair', name: 'chair' },
      { kind, mentions, title, body: 'Fixture forum update' }, env) };
}
async function notifierTick(f) {
  await f.invoke('session.start', {}, async () => ({}));
  const ticks = [...f.timers].filter(timer => timer.ms === 10000);
  assert.equal(ticks.length, 1, 'One notifier per session, including repeated registration/start');
  f.wakes ||= [];
  f.$.session.send = async input => { f.wakes.push(clone(input)); return { isDelivered: true }; };
  return async () => {
    const before = f.wakes.length;
    await ticks[0].fn();
    assert.equal(f.wakes.length, before, 'Timer-origin sends would skip every native hook');
  };
}
const roundtableWakes = f => f.wakes || [];
const wakePass = (f, input = {}, bottom = async () => ({ result: { text: 'Tool result' } })) =>
  f.invoke('tool.call', { tool: 'Bash', command: 'fugato roundtable status', tool_use_id: 'roundtable-tool', ...input }, bottom);
async function receiveNotice(f, notice, number) {
  // A tool-hook-origin send excludes only that tool frame; the member's
  // native turn hooks still run. Timer-origin sends must never reach here.
  return f.turn('The coordinator sent a message while you were working:\n' + notice.text +
    '\n\nAddress this before completing your current task.', number, false, { wake: true });
}

test('native roundtable header preserves caller identity and same-thread binding', async () => {
  const f = fixture('review-ok', 'critic'), rt = nativeRoom(f);
  await f.turn(rt.header + 'Give an independent first result.', 1);
  const first = f.jobs()[0];
  assert.equal(first.agentName, 'critic');
  assert.deepEqual(first.request.roundtable, { roomId: rt.room.roomId, persona: 'critic' });
  assert.deepEqual(f.readStore()['native:v2:native-session:native-agent'].roundtable, first.request.roundtable);
  await f.turn(rt.header + 'Continue the same roundtable.', 2);
  const second = f.jobs().find(job => job.id !== first.id);
  assert.equal(second.threadId, first.threadId);
  assert.deepEqual(second.request.roundtable, first.request.roundtable);
  const tasks = f.capture.processes.filter(call => call.kind === 'spawn' && call.request.argv[2] === 'task');
  assert.ok(tasks[0].request.argv.includes('--roundtable'));
  assert.ok(tasks[0].request.argv.includes('--persona'));
  assert.equal(tasks[1].request.argv.includes('--roundtable'), false);
  assert.equal(tasks[1].request.argv.includes('--persona'), false);
  const invalid = fixture('review-ok', 'critic');
  assert.equal((await invalid.turn('DUET: --roundtable rt-test-room\nMissing persona.', 1)).status, 'blocked');
  assert.equal((await invalid.turn('DUET: --roundtable rt-test-room --persona unknown\nUnknown persona.', 2)).status, 'blocked');
  assert.equal(invalid.jobs().length, 0);
});

test('roundtable notifier steers a running member once through the durable inbox', async () => {
  const f = fixture('steer-applied', 'critic'), rt = nativeRoom(f);
  const pending = f.turn(rt.header + 'Work until the forum notice arrives.', 1);
  try {
    await until(() => f.jobs().find(job => job.turnId));
    await f.advance(1500);
    const event = rt.post('decision');
    const tick = await notifierTick(f);
    // Lose the steering receipt and then the ack; neither may replay the seq.
    const run = f.$.process.run;
    let ackFailed = false, receiptLost = false, release, entered;
    const gate = new Promise(resolve => { release = resolve; });
    const waiting = new Promise(resolve => { entered = resolve; });
    f.$.process.run = async (argv, init) => {
      if (argv[2] === 'forum' && argv[3] === 'pending' && !entered.done) {
        entered.done = true; entered(); await gate;
      }
      if (argv[2] === 'forum' && argv[3] === 'ack' && !ackFailed) { ackFailed = true; throw new Error('Lost ack'); }
      const result = await run(argv, init);
      if (argv[2] === 'steer' && !receiptLost) { receiptLost = true; throw new Error('Lost steering receipt'); }
      return result;
    };
    const firstTick = tick();
    await waiting;
    await tick(); await wakePass(f); // Both paths share the in-flight lease.
    release(); await firstTick;
    assert.equal((await pending).status, 'completed');
    await tick(); await tick();
    assert.equal(f.codexState().steers.length, 1);
    assert.match(f.codexState().steers[0].input[0].text, /Call forum_read/);
    assert.equal(readRoom(rt.room.roomId, rt.env).members[0].notifiedSeq, event.seq);
    assert.equal(f.jobs().length, 1);
    assert.deepEqual(roundtableWakes(f), [], 'Running members receive steering directly');
    assert.ok(f.capture.processes.filter(call => call.kind === 'run' && call.request.argv[2] === 'steer')
      .every(call => call.request.init.timeoutMs <= 12000));
  } finally { f.abort(); await pending.catch(() => {}); }
});

test('roundtable notifier settles one wake across ack failure and reload', async () => {
  const f = fixture('review-ok', 'critic'), rt = nativeRoom(f);
  await f.turn(rt.header + 'Finish the first contribution.', 1);
  const initial = postEvent(rt.room.roomId, 'critic', { kind: 'idea', body: 'Independent record' }, rt.env);
  const event = rt.post('request', ['critic']);
  const agent = (await f.$.agent.list())[0]; agent.status = 'completed';
  const run = f.$.process.run; let rejectAck = true, staleActive = true, deferredLost = false;
  f.$.process.run = async (argv, init) => {
    if (rejectAck && argv[2] === 'forum' && argv[3] === 'ack') throw new Error('Ack temporarily unavailable');
    const result = await run(argv, init);
    if (argv[2] === 'steer' && !deferredLost) { deferredLost = true; throw new Error('Deferred receipt lost'); }
    if (staleActive && argv[2] === 'status') {
      const snapshot = JSON.parse(result.stdout);
      if (snapshot.job) { snapshot.job.status = 'running'; staleActive = false; return { ...result, stdout: JSON.stringify(snapshot) }; }
    }
    return result;
  };
  let tick = await notifierTick(f);
  await tick(); await tick(); await wakePass(f);
  assert.equal(roundtableWakes(f).length, 1); assert.equal(roundtableWakes(f)[0].to, agent.id);
  assert.equal(JSON.parse(f.capture.processes.find(call => call.request.argv[2] === 'steer').value.stdout).status, 'deferred');
  assert.match(roundtableWakes(f)[0].text, /Read the forum, answer what is addressed to you/);
  await receiveNotice(f, roundtableWakes(f)[0], 2); await tick();
  assert.equal(readRoom(rt.room.roomId, rt.env).members[0].notifiedSeq, 0);
  const reply = postEvent(rt.room.roomId, 'chair', { kind: 'finding', body: 'Reply without a mention', replyTo: initial.seq }, rt.env);
  const log = `${f.root}/isolated/duet/roundtables/${rt.room.roomId}/events.jsonl`;
  fs.writeFileSync(log, fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.stringify({ ...JSON.parse(line), at: '2020-01-01T00:00:00.000Z' })).join('\n') + '\n');
  await tick(); f.reload(); rejectAck = false;
  tick = await notifierTick(f); await tick();
  assert.equal(readRoom(rt.room.roomId, rt.env).members[0].notifiedSeq, event.seq);
  await tick();
  assert.equal(roundtableWakes(f).length, 1);
  assert.equal(readRoom(rt.room.roomId, rt.env).members[0].notifiedSeq, reply.seq);
  rt.post('decision', [], 'A later notice with an uncertain send receipt');
  const send = f.$.session.send;
  f.$.session.send = async input => { await send(input); throw new Error('Send receipt lost'); };
  const now = await f.$.clock.now(); f.$.clock.now = async () => now + 5001;
  const result = { result: { text: 'Unchanged despite notification failure' } };
  assert.equal(await wakePass(f, {}, async () => result), result);
  await tick(); await wakePass(f);
  assert.equal(roundtableWakes(f).length, 2, 'An ambiguous send must not repeat before the grace period');
  assert.equal(readRoom(rt.room.roomId, rt.env).members[0].notifiedSeq, reply.seq, 'Sending without a member receipt remains unacked');
});

test('roundtable notifier never wakes stopped, closed, paused, ambiguous or unrelated agents', async () => {
  const f = fixture('review-ok', 'critic'), rt = nativeRoom(f);
  await f.turn(rt.header + 'Finish the first contribution.', 1);
  rt.post('decision');
  const agent = (await f.$.agent.list())[0]; agent.status = 'completed';
  const tick = await notifierTick(f), original = f.$.agent.list;
  await tick(); // Prepare a wake before safety conditions change.
  let now = await f.$.clock.now(); f.$.clock.now = async () => now;
  const check = async () => { now += 5001; await tick(); await wakePass(f); };
  const key = 'native:v2:native-session:native-agent', state = f.readStore()[key];
  await f.$.store.set('native:v2:native-session:duplicate', { ...state, agentId: 'duplicate' });
  f.$.agent.list = async () => [agent, { ...agent, id: 'duplicate' }];
  await check();
  assert.equal(readRoom(rt.room.roomId, rt.env).members[0].notifiedSeq, 0);
  f.$.agent.list = original; await f.$.store.delete('native:v2:native-session:duplicate');
  await f.$.store.set(key, { ...state, roundtable: { roomId: 'rt-other-room', persona: 'critic' } });
  await check(); await f.$.store.set(key, state);
  const run = f.$.process.run;
  const stale = await run([process.execPath, `${plugin}/bin/fugato`, 'forum', 'pending', '--session', 'native-session', '--json'],
    { cwd: `${f.root}/repo`, timeoutMs: 5000 });
  f.$.process.run = async (argv, init) => argv[2] === 'forum' && argv[3] === 'pending' ? stale : run(argv, init);
  setStatus(rt.room.roomId, 'paused', rt.env); await check();
  assert.equal(readRoom(rt.room.roomId, rt.env).members[0].notifiedSeq, 0);
  f.$.process.run = run;
  setStatus(rt.room.roomId, 'open', rt.env);
  // The stop hook persists the member even after the Codex job completed.
  await f.invoke('turn.complete', { agentId: agent.id, turnId: state.turnId, isAborted: true }, async () => ({}));
  assert.equal(readRoom(rt.room.roomId, rt.env).members[0].status, 'stopped');
  await check();
  const killed = nativeRoom(f);
  updateMember(killed.room.roomId, 'critic', { status: 'active', jobIds: [state.jobId], threadId: state.threadId }, killed.env);
  await f.$.store.set(key, { ...state, roundtable: { roomId: killed.room.roomId, persona: 'critic' } });
  agent.status = 'killed'; killed.post('decision'); await check();
  assert.equal(readRoom(killed.room.roomId, killed.env).members[0].status, 'stopped');
  setStatus(rt.room.roomId, 'closed', rt.env);
  f.$.process.run = async (argv, init) => argv[2] === 'forum' && argv[3] === 'pending' ? stale : run(argv, init);
  await f.$.store.set(key, state); agent.status = 'completed'; await check();
  assert.equal(readRoom(rt.room.roomId, rt.env).members[0].notifiedSeq, 0);
  assert.deepEqual(roundtableWakes(f), []);
});

test('roundtable notifier coalesces chair mentions and open requests into one notice per seq', async () => {
  const f = fixture('review-ok', 'critic'), rt = nativeRoom(f);
  postEvent(rt.room.roomId, 'critic', { kind: 'finding', title: 'Chair evidence', body: 'Observed', mentions: ['chair'] }, rt.env);
  postEvent(rt.room.roomId, 'critic', { kind: 'question', title: 'Choose the constraint', body: 'Open request' }, rt.env);
  const tick = await notifierTick(f); await tick(); await tick();
  const notices = f.capture.notices.filter(notice => notice.message.content[0].text.includes('chair updates'));
  assert.equal(notices.length, 1);
  assert.equal(notices[0].agentId, undefined);
  assert.equal(notices[0].message.type, 'user');
  assert.match(notices[0].message.content[0].text, /#1 finding "Chair evidence"; #2 question "Choose the constraint"/);
  assert.equal(readRoom(rt.room.roomId, rt.env).members[0].indexCursor, 0);
});

test('roundtable deferred notices cannot answer a question that appears during steering', async () => {
  const f = fixture('parent-question-sequence', 'critic'), rt = nativeRoom(f);
  const asked = await f.turn(rt.header + 'Ask before proceeding.', 1);
  const key = 'native:v2:native-session:native-agent', state = f.readStore()[key];
  rt.post('decision');
  // Model the exact race: discovery sees running/no question, steer sees the
  // newly parked question, and its fallback must perform a fresh job lookup.
  await f.$.store.set(key, { ...state, status: 'running', answer: undefined });
  const run = f.$.process.run; let first = true, notice;
  f.$.process.run = async (argv, init) => {
    const result = await run(argv, init);
    if (argv[2] === 'status' && first) {
      first = false;
      const value = JSON.parse(result.stdout); delete value.job.pendingQuestion;
      return { ...result, stdout: JSON.stringify(value) };
    }
    if (argv[2] === 'steer') notice = init.stdin;
    return result;
  };
  await (await notifierTick(f))(); await wakePass(f);
  assert.deepEqual(roundtableWakes(f), []);
  assert.match(notice, /^\[Fugato roundtable notice /);
  // Also model a tool-hook wake reaching a member after its question appeared.
  await f.$.store.set(key, state);
  const report = await receiveNotice(f, { to: 'critic', text: notice }, 2);
  assert.deepEqual(report, asked);
  assert.deepEqual(await receiveNotice(f, { to: 'critic', text: notice.replace('[Fugato roundtable notice ', '[Duet roundtable notice ') }, 3), asked,
    'A legacy notice remains a notice-only turn and cannot answer the pending question');
  assert.equal(f.readStore()[`native:roundtable:v1:native-session:${rt.room.roomId}:critic`].receipt.status, 'deferred');
  assert.equal(f.jobs()[0].pendingQuestion.answer, undefined);
  assert.equal(f.capture.processes.filter(call => call.request.argv[2] === 'answer').length, 0);
  assert.equal(readRoom(rt.room.roomId, rt.env).members[0].notifiedSeq, 0);
});

test('roundtable wake claims reconcile receipts or retry once on the same idle job', async () => {
  const f = fixture('review-ok', 'critic'), rt = nativeRoom(f);
  await f.turn(rt.header + 'Finish first.', 1);
  (await f.$.agent.list())[0].status = 'completed';
  const event = rt.post('decision');
  let tick = await notifierTick(f); await tick(); await wakePass(f);
  assert.equal(roundtableWakes(f).length, 1);
  assert.equal(readRoom(rt.room.roomId, rt.env).members[0].notifiedSeq, 0, 'A queued send is not a member receipt');
  const key = `native:roundtable:v1:native-session:${rt.room.roomId}:critic`, claimed = f.readStore()[key];
  await f.$.store.set(key, { ...claimed, receipt: { deliveryId: claimed.attempt.deliveryId, turnId: 'never-launched', status: 'received' } });
  f.reload(); tick = await notifierTick(f);
  let now = await f.$.clock.now(); f.$.clock.now = async () => now;
  await tick(); await wakePass(f); assert.equal(roundtableWakes(f).length, 1);
  assert.equal(readRoom(rt.room.roomId, rt.env).members[0].notifiedSeq, 0, 'A received notice that never launched stays unacked');
  now += 120001;
  const run = f.$.process.run;
  f.$.process.run = async (argv, init) => {
    const result = await run(argv, init);
    if (argv[2] === 'status') { const value = JSON.parse(result.stdout);
      value.job.status = 'running'; return { ...result, stdout: JSON.stringify(value) }; }
    return result;
  };
  await tick(); await wakePass(f); assert.equal(roundtableWakes(f).length, 1, 'Never retry an active job');
  f.$.process.run = run; now += 5001;
  await tick(); await wakePass(f); await tick();
  assert.equal(roundtableWakes(f).length, 2);
  assert.deepEqual(roundtableWakes(f)[0], roundtableWakes(f)[1], 'The single retry retains the exact delivery id and text');
  now += 120001; f.reload(); tick = await notifierTick(f);
  await tick(); await wakePass(f); await tick();
  assert.equal(roundtableWakes(f).length, 2, 'No third send even after another grace period and reload');
  await receiveNotice(f, roundtableWakes(f)[1], 2);
  const claim = f.readStore()[`native:roundtable:v1:native-session:${rt.room.roomId}:critic`];
  assert.equal(claim.receipt.deliveryId, claim.attempt.deliveryId);
  assert.equal(claim.receipt.status, 'accepted');
  await tick();
  assert.equal(readRoom(rt.room.roomId, rt.env).members[0].notifiedSeq, event.seq);
  await receiveNotice(f, roundtableWakes(f)[0], 3);
  assert.equal(f.jobs().length, 2, 'A duplicate host delivery cannot dispatch twice');
});

test('a stalled wake send releases the chair tool result and later notifier passes', async () => {
  const f = fixture('review-ok', 'critic'), rt = nativeRoom(f);
  await f.turn(rt.header + 'Finish first.', 1);
  (await f.$.agent.list())[0].status = 'completed';
  rt.post('decision');
  const tick = await notifierTick(f); await tick();
  const send = f.$.session.send;
  let release, entered;
  const sending = new Promise(resolve => { entered = resolve; });
  f.$.session.send = async input => { entered(); await new Promise(resolve => { release = resolve; }); return send(input); };
  const result = { result: { text: 'Tool result' } }, pass = wakePass(f, {}, async () => result);
  await sending;
  const bound = [...f.timers].find(timer => timer.once && timer.ms === 12000);
  f.timers.delete(bound); await bound.fn();
  assert.equal(await pass, result, 'A stalled host send cannot hold the chair tool result');
  const processes = f.capture.processes.length;
  await tick();
  assert.ok(f.capture.processes.length > processes, 'The abandoned pass no longer keeps later passes out');
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(roundtableWakes(f).length, 1);
  assert.equal(readRoom(rt.room.roomId, rt.env).members[0].notifiedSeq, 0, 'The fenced pass stays unacknowledged');
});

test('roundtable callbacks cannot send or write after session end or session change', async () => {
  const f = fixture('review-ok', 'critic'), rt = nativeRoom(f);
  await f.turn(rt.header + 'Finish first.', 1); rt.post('decision');
  const run = f.$.process.run;
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  f.$.process.run = async (argv, init) => {
    const result = await run(argv, init);
    if (argv[2] === 'forum' && argv[3] === 'pending') { entered(); await gate; }
    return result;
  };
  const tick = await notifierTick(f), pending = tick(); await waiting;
  await f.invoke('session.end', {}, async () => ({}));
  const store = f.readStore(), processes = f.capture.processes.length;
  release(); await pending; await tick();
  assert.deepEqual(f.readStore(), store); assert.equal(f.capture.processes.length, processes);
  // A changed scope also invalidates an in-flight callback without session.end.
  f.$.process.run = run;
  await wakePass(f, {}, async () => { await f.invoke('session.end', {}, async () => ({})); return {}; });
  assert.deepEqual(f.readStore(), store);
  assert.equal(f.capture.processes.length, processes);
  const second = await notifierTick(f);
  f.$.agent.list = async () => { f.$.session.id = async () => 'replacement-session'; return []; };
  await second();
  assert.deepEqual(f.readStore(), store);
  assert.deepEqual(roundtableWakes(f), []);
});

test('roundtable chair work rotates with bounded ticks and reserves member delivery', async () => {
  const f = fixture('review-ok', 'critic'), member = nativeRoom(f);
  await f.turn(member.header + 'Finish first.', 1); member.post('decision');
  (await f.$.agent.list())[0].status = 'completed';
  const rooms = Array.from({ length: 5 }, () => nativeRoom(f));
  for (const rt of rooms) postEvent(rt.room.roomId, 'critic', { kind: 'question', body: 'Chair must choose' }, rt.env);
  const tick = await notifierTick(f);
  await tick();
  const notices = () => f.capture.notices.filter(notice => notice.message.content[0].text.includes('chair updates'));
  assert.equal(notices().length, 2);
  assert.equal(f.readStore()[`native:roundtable:v1:native-session:${member.room.roomId}:critic`].attempt.phase, 'ready');
  await wakePass(f); assert.equal(roundtableWakes(f).length, 1);
  await receiveNotice(f, roundtableWakes(f)[0], 2);
  // Exhaust the chair budget after one room, without delaying the test. The
  // next cursor must refer to the unattempted room, not skip past it forever.
  const run = f.$.process.run; let now = await f.$.clock.now();
  f.$.clock.now = async () => now;
  f.$.process.run = async (argv, init) => {
    const result = await run(argv, init);
    if (argv[2] === 'roundtable' && rooms.some(rt => rt.room.roomId === argv[4])) now += 10000;
    return result;
  };
  await tick(); await tick(); await tick();
  assert.equal(notices().length, 5);
  for (const rt of rooms) assert.equal(notices().filter(notice => notice.message.content[0].text.includes(rt.room.roomId)).length, 1);
});

test('roundtable notifier records share a bounded budget and prune closed rooms and ended sessions', async () => {
  const f = fixture('review-ok', 'critic', { hostOnly: true, memoryStore: true }), rt = nativeRoom(f);
  const prefix = 'native:roundtable:v1:native-session:', stopped = 'native:roundtable-stopped:v1:native-session:critic';
  await f.$.store.set(prefix + rt.room.roomId + ':critic', { upto: 1, receipt: { deliveryId: 'old', status: 'accepted' } });
  await f.$.store.set(prefix + rt.room.roomId + ':chair', { upto: 1 });
  await f.$.store.set(stopped, { session: 'native-session', roomId: rt.room.roomId, persona: 'critic', synced: true });
  setStatus(rt.room.roomId, 'closed', rt.env);
  const tick = await notifierTick(f); await tick();
  assert.equal(Object.keys(f.readStore()).filter(key => key.startsWith('native:roundtable')).length, 0);
  const open = nativeRoom(f);
  postEvent(open.room.roomId, 'critic', { kind: 'question', body: 'Needs room in the store' }, open.env);
  // Protected claims are retained; capacity refuses additional notices safely.
  for (let i = 0; i < 256; i++) await f.$.store.set(prefix + `rt-retained-${i}:critic`, { attempt: { deliveryId: `pending-${i}` } });
  await tick();
  assert.equal(Object.keys(f.readStore()).filter(key => key.startsWith(prefix)).length, 256);
  assert.equal(f.capture.notices.filter(notice => notice.message.content[0].text.includes('chair updates')).length, 0);
  await f.invoke('session.end', {}, async () => ({}));
  assert.equal(Object.keys(f.readStore()).filter(key => key.startsWith('native:roundtable')).length, 0);
  await f.$.store.set('unrelated:large', 'x'.repeat(800 * 1024));
  const restarted = await notifierTick(f); await restarted();
  assert.equal(f.capture.notices.filter(notice => notice.message.content[0].text.includes('chair updates')).length, 0);
  await f.$.store.delete('unrelated:large'); await restarted();
  assert.equal(f.capture.notices.filter(notice => notice.message.content[0].text.includes('chair updates')).length, 1);
});

test('roundtable chair cursor is restored after a definite append refusal', async () => {
  const f = fixture('review-ok', 'critic'), rt = nativeRoom(f);
  postEvent(rt.room.roomId, 'critic', { kind: 'question', body: 'Please choose' }, rt.env);
  const append = f.$.session.append; let refused = true;
  f.$.session.append = async input => refused ? { deny: 'Temporarily refused' } : append(input);
  const tick = await notifierTick(f); await tick();
  const key = `native:roundtable:v1:native-session:${rt.room.roomId}:chair`;
  assert.equal(f.readStore()[key].upto, undefined);
  refused = false; await tick(); await tick();
  assert.equal(f.readStore()[key].upto, 1);
  assert.equal(f.capture.notices.filter(notice => notice.message.content[0].text.includes('chair updates')).length, 1);
});

test('roundtable timer records a ready idle wake without sending or spawning', async () => {
  const f = fixture('review-ok', 'critic'), rt = nativeRoom(f);
  await f.turn(rt.header + 'Finish first.', 1); rt.post('decision');
  const notices = f.capture.notices.length;
  const spawns = []; f.$.agent.spawn = async input => { spawns.push(input); return { agentId: 'unexpected' }; };
  const tick = await notifierTick(f); await tick(); await tick();
  const claim = f.readStore()[`native:roundtable:v1:native-session:${rt.room.roomId}:critic`].attempt;
  assert.equal(claim.phase, 'ready'); assert.ok(Number.isFinite(claim.readyAt));
  assert.match(claim.text, /^\[Fugato roundtable notice roundtable:/);
  assert.match(claim.text, /continue toward the roundtable goal\.$/);
  assert.deepEqual(roundtableWakes(f), []); assert.deepEqual(spawns, []);
  assert.equal(f.jobs().length, 1); assert.equal(f.capture.notices.length, notices);
});

test('roundtable main-loop tool hook delivers once to the bound id and continues its thread', async () => {
  const f = fixture('review-ok', 'critic'), rt = nativeRoom(f);
  await f.turn(rt.header + 'Finish first.', 1);
  const first = f.jobs()[0], agent = (await f.$.agent.list())[0]; agent.status = 'completed';
  postEvent(rt.room.roomId, 'critic', { kind: 'idea', body: 'Independent record' }, rt.env);
  // Ended agents disappear from the host list; the durable binding owns the id.
  f.$.agent.list = async () => [];
  const run = f.$.process.run;
  f.$.process.run = async (argv, init) => {
    const result = await run(argv, init);
    if (argv[2] === 'forum' && argv[3] === 'pending') {
      const entries = JSON.parse(result.stdout);
      for (const entry of entries) if (entry.name === 'critic') entry.text = 'Long forum summary. '.repeat(1000);
      return { ...result, stdout: JSON.stringify(entries) };
    }
    return result;
  };
  const tick = await notifierTick(f);
  await wakePass(f, { agentId: 'subagent' }, async () => { rt.post('request', ['critic']); return {}; });
  assert.deepEqual(roundtableWakes(f), [], 'Subagent tool calls cannot deliver idle wakes');
  const result = { result: { text: 'Chair post completed' } };
  assert.equal(await wakePass(f, {}, async () => {
    assert.deepEqual(roundtableWakes(f), [], 'Delivery runs after the tool completes');
    rt.post('request', ['critic']); return result;
  }), result);
  const [notice] = roundtableWakes(f);
  assert.equal(notice.to, agent.id); assert.equal(notice.text.length, 8192);
  assert.match(notice.text, /^\[Fugato roundtable notice roundtable:/);
  assert.match(notice.text, /…\n\nRead the forum, answer what is addressed to you, and continue toward the roundtable goal\.$/);
  const processes = f.capture.processes.length;
  await wakePass(f); assert.equal(f.capture.processes.length, processes, 'Main-loop passes are throttled');
  await receiveNotice(f, notice, 2); await tick();
  assert.equal(f.jobs().length, 2);
  const followup = f.jobs().find(job => job.id !== first.id);
  assert.equal(followup.threadId, first.threadId);
  assert.deepEqual(followup.request.roundtable, first.request.roundtable);
  const task = f.capture.processes.filter(call => call.kind === 'spawn' && call.request.argv[2] === 'task').at(-1);
  assert.equal(task.request.input, notice.text);
  assert.equal(roundtableWakes(f).length, 1);
});

test('roundtable chair mentions bypass coalescing while member mentions wait', () => {
  const f = fixture('review-ok', 'critic', { hostOnly: true, memoryStore: true }), rt = nativeRoom(f, ['critic', 'improver']);
  postEvent(rt.room.roomId, 'critic', { kind: 'idea', body: 'Independent critic record' }, rt.env);
  postEvent(rt.room.roomId, 'improver', { kind: 'idea', body: 'Independent improver record' }, rt.env);
  const peer = postEvent(rt.room.roomId, 'improver', { kind: 'request', body: 'Peer request', mentions: ['critic'] }, rt.env);
  assert.deepEqual(forumPending(rt.room.roomId, { now: Date.parse(peer.at) + 29999 }, rt.env), []);
  const chair = rt.post('request', ['improver']);
  const immediate = forumPending(rt.room.roomId, { now: Date.parse(chair.at) }, rt.env);
  assert.deepEqual(immediate.map(entry => entry.name), ['improver']);
  assert.equal(immediate[0].wake, true);
  assert.deepEqual(forumPending(rt.room.roomId, { now: Date.parse(peer.at) + 30000 }, rt.env).map(entry => entry.name), ['critic', 'improver']);
});

test('roundtable undelivered ready wake prompts the chair once after the grace period', async () => {
  const f = fixture('review-ok', 'critic'), rt = nativeRoom(f);
  await f.turn(rt.header + 'Finish first.', 1); rt.post('decision');
  const notices = () => f.capture.notices.filter(notice => notice.message.content[0].text.includes('have updates waiting'));
  let tick = await notifierTick(f); await tick();
  let now = await f.$.clock.now(); f.$.clock.now = async () => now;
  now += 119999; await tick(); assert.equal(notices().length, 0);
  now += 2; await tick();
  assert.equal(notices().length, 1);
  const notice = notices()[0];
  assert.equal(notice.agentId, undefined); assert.equal(notice.message.type, 'user');
  assert.equal(notice.message.content[0].text, `Roundtable ${rt.room.roomId}: critic have updates waiting; run \`fugato roundtable status ${rt.room.roomId}\` to deliver them.`);
  now += 120001; f.reload(); tick = await notifierTick(f); await tick(); await tick();
  assert.equal(notices().length, 1); assert.deepEqual(roundtableWakes(f), []);
  await wakePass(f); assert.equal(roundtableWakes(f).length, 1);
});

test('roundtable wake reports a removed member workspace once to the chair', async () => {
  const f = fixture('review-ok', 'critic'), rt = nativeRoom(f);
  await f.turn(rt.header + 'Finish first.', 1); rt.post('decision');
  const key = 'native:v2:native-session:native-agent';
  await f.$.store.set(key, { ...f.readStore()[key], cwd: `${f.root}/removed-worktree` });
  const tick = await notifierTick(f); await tick(); await tick(); await wakePass(f);
  const notices = f.capture.notices.filter(notice => notice.message.content[0].text.includes('workspace was removed'));
  assert.equal(notices.length, 1); assert.match(notices[0].message.content[0].text, /critic cannot continue/);
  assert.equal(f.jobs().length, 1);
  assert.deepEqual(roundtableWakes(f), []);
});

test('native steering applies to the running turn without a continuation', async () => {
  const f = fixture('steer-applied');
  const pending = f.turn('Work until steered.', 1);
  try {
    const job = await until(() => f.jobs().find(job => job.turnId));
    await f.advance(1500);
    const peer = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { CodexAppServerClient } from ${JSON.stringify(new URL('../scripts/lib/app-server.mjs', import.meta.url).href)};
      const client = await CodexAppServerClient.connect(process.cwd(), { reuseExistingBroker: true });
      try {
        assert.equal(client.transport, 'broker');
        await assert.rejects(client.request('turn/steer', ${JSON.stringify({ threadId: job.threadId, expectedTurnId: job.turnId, input: [{ type: 'text', text: 'Foreign steer.', text_elements: [] }] })}),
          error => error.rpcCode === -32001);
      } finally { await client.close(); }
    `], { cwd: `${f.root}/repo`, env: f.env, encoding: 'utf8' });
    assert.equal(peer.status, 0, peer.stderr);
    let queued = 0;
    const receipt = await f.invoke('session.send', { to: 'native-agent', text: 'Use the revised requirement.', origin: { kind: 'model' } },
      async () => { queued++; return { isDelivered: true }; });
    assert.equal(queued, 0);
    assert.equal(receipt.isDelivered, true);
    const result = await pending;
    assert.match(result.summary, /Applied steering: Use the revised requirement\./);
    assert.equal(f.jobs().length, 1);
    assert.equal(f.codexState().nextTurnId, 2);
    assert.equal(f.codexState().steers.length, 1);
    assert.equal(f.codexState().steers[0].expectedTurnId, f.jobs()[0].turnId);
    assert.equal(f.jobs()[0].turnSubmission.transport, 'broker');
    const delivery = steeringInbox(f, f.jobs()[0]).deliveries[0];
    assert.equal(delivery.text, undefined);
    assert.equal(delivery.textHash, createHash('sha256').update('Use the revised requirement.').digest('hex'));
    assert.equal(steer(f, f.jobs()[0], delivery.deliveryId, 'Use the revised requirement.').status, 'applied');
    assert.equal(f.codexState().steers.length, 1);
  } finally { f.abort(); await pending; }
});

test('native steering rejection queues one ordinary continuation on the same thread', async () => {
  const f = fixture('steer-reject');
  const pending = f.turn('Work until steered.', 1);
  try {
    await until(() => f.jobs().find(job => job.turnId));
    await f.advance(1500);
    const queued = [];
    await f.invoke('session.send', { to: 'native-agent', text: 'Continue with the revised requirement.', origin: { kind: 'model' } },
      async e => { queued.push(e.text); return { isDelivered: true }; });
    assert.deepEqual(queued, ['Continue with the revised requirement.']);
    const first = await pending;
    const continued = await f.turn(queued.shift(), 2);
    assert.equal(continued.status, 'completed');
    assert.equal(f.jobs().length, 2);
    assert.equal(new Set(f.jobs().map(job => job.threadId)).size, 1);
    assert.notEqual(first.jobId, continued.jobId);
    assert.equal(f.codexState().nextTurnId, 3);
    assert.equal(f.codexState().steers.length, 1);
    const job = f.jobs().find(job => job.id === first.jobId), delivery = steeringInbox(f, job).deliveries[0];
    assert.equal(delivery.reason, 'turn_rejected');
    assert.equal(steer(f, job, delivery.deliveryId, 'Continue with the revised requirement.').fallback, false);
  } finally { f.abort(); await pending; }
});

test('native steering delivery IDs are idempotent, including lost acknowledgements', async () => {
  const f = fixture('steer-unknown');
  // A missing explicitly supplied socket takes the supported direct path.
  f.env.CODEX_COMPANION_APP_SERVER_ENDPOINT = `unix:${f.root}/absent.sock`;
  const pending = f.turn('Work until steered.', 1, true);
  try {
    const job = await until(() => f.jobs().find(job => job.turnId));
    await f.advance(1500);
    let queued = 0;
    const receipt = await f.invoke('session.send', { to: 'native-agent', text: 'Apply this once.', origin: { kind: 'model' } },
      async () => { queued++; return { isDelivered: true }; });
    assert.equal(queued, 0);
    assert.equal(receipt.isDelivered, false);
    assert.equal(receipt.reason, 'Codex steering outcome unknown; the message may or may not have reached the running turn and will not be resent automatically. Inspect the Fugato job before resending.');
    assert.ok(f.capture.notices.some(notice => notice.message.content.some(item => item.text?.includes('Codex steering unknown'))));
    const inbox = steeringInbox(f, job);
    assert.equal(inbox.deliveries.length, 1);
    assert.equal(inbox.deliveries[0].status, 'unknown');
    assert.equal(inbox.deliveries[0].text, undefined);
    assert.equal(steer(f, job, inbox.deliveries[0].deliveryId, 'Apply this once.').status, 'unknown');
    assert.equal(job.turnSubmission.transport, 'direct');
    assert.equal(f.codexState().steers.length, 1);
    assert.equal(f.codexState().nextTurnId, 2);
    assert.equal(f.jobs().length, 1);
  } finally { f.abort(); await pending; }
});

test('native steering never queues a failed delivery, even with a stale fallback flag', async () => {
  const f = fixture('steer-failed');
  const pending = f.turn('Work until steered.', 1, true);
  try {
    const job = await until(() => f.jobs().find(job => job.turnId));
    await f.advance(1500);
    const run = f.$.process.run;
    f.$.process.run = async (...args) => {
      const result = await run(...args);
      if (args[0][2] === 'steer') {
        const receipt = JSON.parse(result.stdout);
        assert.equal(receipt.status, 'failed');
        assert.equal(receipt.fallback, false);
        return { ...result, stdout: JSON.stringify({ ...receipt, fallback: true }) };
      }
      return result;
    };
    const receipt = await f.invoke('session.send', { to: 'native-agent', text: 'Failed steering.', origin: { kind: 'model' } },
      async () => assert.fail('Failed steering must never enter the host queue'));
    assert.equal(receipt.isDelivered, false);
    assert.match(receipt.reason, /steer_rejected.*Inspect the Fugato job before resending/);
    assert.equal(steeringInbox(f, job).deliveries[0].text, undefined);
    assert.equal(f.codexState().steers.length, 1);
  } finally { f.abort(); await pending; }
});

test('native steering treats a broker-wrapped malformed acknowledgement as unknown without replay', async () => {
  const f = fixture('steer-malformed');
  const pending = f.turn('Work until steered.', 1, true);
  try {
    const job = await until(() => f.jobs().find(job => job.turnId));
    await f.advance(1500);
    const receipt = await f.invoke('session.send', { to: 'native-agent', text: 'Applied before malformed acknowledgement.', origin: { kind: 'model' } },
      async () => assert.fail('A parser error cannot prove rejection'));
    assert.equal(receipt.isDelivered, false);
    assert.match(receipt.reason, /outcome unknown/);
    const delivery = steeringInbox(f, job).deliveries[0];
    assert.equal(delivery.status, 'unknown');
    assert.equal(delivery.reason, 'acknowledgement_missing');
    assert.equal(steer(f, job, delivery.deliveryId, 'Applied before malformed acknowledgement.').fallback, false);
    assert.equal(job.turnSubmission.transport, 'broker');
    assert.equal(f.codexState().steers.length, 1);
    assert.equal(f.codexState().nextTurnId, 2);
    assert.equal(f.jobs().length, 1);
  } finally { f.abort(); await pending; }
});

test('native steering delivery IDs survive same-clock sends and hook reloads without store writes', async () => {
  const f = fixture('unused', 'steering-ids', { hostOnly: true, memoryStore: true });
  f.$.agent.list = async () => [{ id: 'native-agent', name: 'steering-ids', type: AGENT_TYPE, status: 'running' }];
  f.setStore({ 'native:v2:native-session:native-agent': { session: 'native-session', cwd: `${f.root}/repo`, jobId: 'job', ownerId: 'owner' } });
  const before = f.readStore(), ids = [];
  f.$.process.run = async argv => {
    const id = argv[argv.indexOf('--delivery-id') + 1]; ids.push(id);
    return { exitCode: 0, stdout: JSON.stringify({ jobId: 'job', deliveryId: id, status: 'applied', fallback: false }) };
  };
  const send = () => f.invoke('session.send', { to: 'native-agent', text: 'Same clock.', origin: { kind: 'model' } },
    async () => assert.fail('Expected steering'));
  await Promise.all([send(), send()]);
  f.reload(); await send();
  assert.equal(new Set(ids).size, 3);
  assert.ok(ids.every(id => /^native-session:native-agent:1800000000000:[a-z0-9]+$/.test(id)));
  assert.deepEqual(f.readStore(), before);
});

test('native steering inbox retains hashed receipts and refuses new deliveries beyond 256', () => {
  const f = fixture('unused', 'steering-cap', { hostOnly: true });
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { writeJobFile } from ${JSON.stringify(new URL('../scripts/lib/state.mjs', import.meta.url).href)};
    import { handoffSteering } from ${JSON.stringify(new URL('../scripts/lib/steering.mjs', import.meta.url).href)};
    const cwd = process.cwd(), jobId = 'capped', sessionId = 'native-session';
    const file = writeJobFile(cwd, jobId, { id: jobId, status: 'completed', sessionId, ownerId: 'owner' }).replace(/\\.json$/, '.steering.json');
    const send = (deliveryId, text = 'Private steering text') => handoffSteering(cwd, jobId, { deliveryId, text, sessionId });
    // An old terminal row is compacted on read, preserving its idempotency key.
    fs.writeFileSync(file, JSON.stringify({ version: 1, deliveries: [{ deliveryId: '0', text: 'Private steering text', status: 'applied' }] }));
    for (let i = 1; i < 256; i++) assert.equal((await send(String(i))).status, 'deferred');
    const before = fs.readFileSync(file, 'utf8'), inbox = JSON.parse(before);
    assert.equal(inbox.deliveries.length, 256);
    assert.ok(inbox.deliveries.every(row => row.text === undefined && /^[a-f0-9]{64}$/.test(row.textHash)));
    assert.ok(!before.includes('Private steering text'));
    assert.equal((await send('0')).status, 'applied');
    await assert.rejects(send('0', 'Different text'), /different text/);
    const refused = await send('overflow');
    assert.deepEqual(refused, { jobId, deliveryId: 'overflow', status: 'failed', fallback: false, reason: 'inbox_full' });
    assert.deepEqual(await send('overflow'), refused);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  `], { cwd: `${f.root}/repo`, env: f.env, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
});

test('native steering defers permission-mapped jobs once and re-derives permissions on continuation', async () => {
  const f = fixture('steer-applied');
  const setup = spawnSync(process.execPath, [plugin + '/bin/fugato', 'setup', '--permission-mapping', 'claude', '--json'],
    { cwd: `${f.root}/repo`, env: f.env, encoding: 'utf8' });
  assert.equal(setup.status, 0, setup.stderr);
  const pending = f.turn('Work until interrupted.', 1, true);
  try {
    const job = await until(() => f.jobs().find(job => job.turnId));
    assert.ok(job.request.permissionPolicy);
    await f.advance(1500);
    const queued = [];
    await f.invoke('session.send', { to: 'native-agent', text: 'Continue planning.', origin: { kind: 'model' } },
      async e => { queued.push(e.text); return { isDelivered: true }; });
    assert.deepEqual(queued, ['Continue planning.']);
    const delivery = steeringInbox(f, job).deliveries[0];
    assert.equal(delivery.status, 'deferred');
    assert.equal(delivery.reason, 'permission_mapping');
    assert.equal(steer(f, job, delivery.deliveryId, queued[0]).fallback, false);
    assert.equal(f.codexState().steers, undefined);
    f.abort(); await pending;
    const continued = await f.turn(queued.shift(), 2, false, { permissionMode: 'plan' });
    assert.equal(continued.status, 'completed');
    assert.equal(new Set(f.jobs().map(job => job.threadId)).size, 1);
    assert.equal(f.codexState().lastTurnStart.sandboxPolicy.type, 'readOnly');
    assert.equal(f.codexState().steers, undefined);
  } finally { f.abort(); await pending; }
});

test('native steering drain cancels a late always-approval after turn completion', () => {
  const f = fixture('steer-applied');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { writeJobFile } from ${JSON.stringify(new URL('../scripts/lib/state.mjs', import.meta.url).href)};
    import { CodexAppServerClient } from ${JSON.stringify(new URL('../scripts/lib/app-server.mjs', import.meta.url).href)};
    import { runAppServerTurn } from ${JSON.stringify(new URL('../scripts/lib/codex.mjs', import.meta.url).href)};
    const cwd = process.cwd(), jobId = 'late-approval', sessionId = 'native-session';
    const file = writeJobFile(cwd, jobId, { id: jobId, status: 'running', sessionId, ownerId: 'owner' });
    fs.writeFileSync(file.replace(/\\.json$/, '.steering.json'), JSON.stringify({ version: 1,
      deliveries: [{ deliveryId: 'steer', text: 'Finish the turn.', status: 'queued', sessionId, ownerId: 'owner' }] }));
    let answer, releaseSteer, approval, decision;
    const choice = new Promise(resolve => { answer = resolve; });
    const drainGate = new Promise(resolve => { releaseSteer = resolve; });
    const connect = CodexAppServerClient.connect;
    CodexAppServerClient.connect = async (...args) => {
      const client = await connect(...args), request = client.request.bind(client), context = client.setServerRequestContext.bind(client);
      client.request = async (method, ...params) => {
        if (method !== 'turn/steer') return request(method, ...params);
        approval = client.options.onApprovalRequest({ kind: 'computer-use-app', app: 'com.example.Late', threadId: params[0].threadId });
        const response = await request(method, ...params);
        await drainGate;
        return response;
      };
      client.setServerRequestContext = (threadId, turnId) => {
        context(threadId, turnId);
        if (threadId !== null || turnId !== null || !approval) return;
        // The next event-loop turn runs after runAppServerTurn enters its
        // finally and waits on the outstanding steering acknowledgement.
        setImmediate(async () => { answer('always'); decision = await approval; releaseSteer(); });
      };
      return client;
    };
    const result = await runAppServerTurn(cwd, { jobId, prompt: 'Work until steered.', sandbox: 'read-only',
      persistThread: true, onApprovalRequest: () => choice });
    assert.equal(result.turnEnded, true);
    assert.deepEqual(decision, { action: 'cancel', reason: 'turn-ended' });
    const config = process.env.CODEX_COMPANION_HOME + '/computer-use/config.toml';
    assert.ok(!fs.existsSync(config) || !fs.readFileSync(config, 'utf8').includes('com.example.Late'));
  `], { cwd: `${f.root}/repo`, env: f.env, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
});

test('native teammate identity survives named classic events, SendMessage wakes and stop', async () => {
  const f = fixture('review-ok', 'identity-scout');
  f.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1';
  const classic = () => f.invoke('classic.SubagentStart', { session_id: 'native-session', agent_id: 'native-agent',
    agent_type: 'identity-scout' }, async () => ({}));
  const first = await f.turn('Investigate through an in-process teammate.', 1, false, { teammate: true, afterSpawn: classic });
  assert.equal(first.status, 'completed');
  f.reload();
  f.$.agent.list = async () => { throw new Error('Fixture discovery outage'); };
  const second = await f.turn('The coordinator sent a message while you were working:\nContinue the investigation.\n\nAddress this before completing your current task.',
    2, false, { wake: true, afterSpawn: classic });
  assert.equal(second.status, 'completed');
  assert.equal(f.jobs().find(job => job.id === first.jobId).threadId, f.jobs().find(job => job.id === second.jobId).threadId);
  const stopped = fixture('interruptible-slow-task', 'identity-stopped');
  stopped.stopOnWait();
  const report = await stopped.turn('Wait for the owner stop.', 1, true, { teammate: true, afterSpawn: () =>
    stopped.invoke('classic.SubagentStart', { session_id: 'native-session', agent_id: 'native-agent', agent_type: 'identity-stopped' }, async () => ({})) });
  assert.ok(['interrupted', 'cancelled', 'owner_stopped'].includes(report.status));
  assert.equal(stopped.jobs()[0].result.interruptionConfirmed, true);
});

test('reused host ids pass non-native spawns and classic starts through during discovery outages', async () => {
  const f = fixture('review-ok', 'reused-worker');
  await f.turn('Finish the native assignment.', 1);
  f.$.agent.list = async () => { throw new Error('Fixture discovery outage'); };
  const original = f.readStore()['native:v2:native-session:native-agent'];
  const explore = { session_id: 'native-session', agent_id: 'native-agent', agent_type: 'Explore' };
  await f.invoke('classic.SubagentStart', explore, async () => ({ additionalContext: ['Explore context'] }));
  const start = { agentId: 'native-agent', turnId: 'explore-turn', text: 'Explore without Codex.' };
  await f.invoke('turn.start', start, async e => ({ turnId: e.turnId }));
  assert.deepEqual(f.readStore()['native:v2:native-session:native-agent'], original);
  // The next spawn's actual type must also fence the old binding before a
  // classic start arrives, even when that cached start still says native.
  await f.invoke('classic.SubagentStart', { ...explore, agent_type: AGENT_TYPE }, async () => ({}));
  await f.invoke('agent.spawn', { subagentType: 'Explore', tool_use_id: 'explore-spawn' },
    async () => ({ model: 'haiku', agentId: 'native-agent' }));
  await f.invoke('turn.start', start, async e => ({ turnId: e.turnId }));
  const answer = 'Explore handled the assignment.';
  assert.equal((await f.invoke('turn.step', { ...start, index: 0 }, async function* () {
    yield { kind: 'text', index: 0, text: answer };
    yield { kind: 'stop', stopReason: 'end_turn', usage: null };
    return { answer, usage: null };
  })).answer, answer);
  assert.deepEqual(f.readStore()['native:v2:native-session:native-agent'], original);
  assert.equal(f.readStore()['native:lifecycle:v1:native-session:native-agent'], undefined);
  assert.equal(f.jobs().length, 1);
});

test('native teammate suffix from the spawn address survives discovery outages', async () => {
  const f = fixture('review-ok', 'scout');
  const report = await f.turn('Use the host-assigned teammate address.', 1, false, {
    teammate: true, teammateId: 'scout-2@fixture', afterSpawn: async () => {
      f.$.agent.list = async () => { throw new Error('Fixture discovery outage'); };
      await f.invoke('classic.SubagentStart', { session_id: 'native-session', agent_id: 'native-agent', agent_type: 'scout-2' }, async () => ({}));
    }
  });
  assert.equal(report.worker, 'scout-2');
  assert.equal(f.readStore()['native:v2:native-session:native-agent'].name, 'scout-2');
  const task = f.capture.processes.find(p => p.kind === 'spawn' && p.request.argv[2] === 'task');
  assert.equal(task.request.argv[task.request.argv.indexOf('--agent-name') + 1], 'scout-2');
});

test('Agent worktree isolation reaches custom host paths and durable permission mapping', async () => {
  const f = fixture('review-ok', 'worktree-worker');
  const custom = `${f.root}/custom-worktree`;
  fs.mkdirSync(custom); initGitRepo(custom);
  const setup = spawnSync(process.execPath, [plugin + '/bin/fugato', 'setup', '--permission-mapping', 'claude'],
    { env: f.env, cwd: `${f.root}/repo`, encoding: 'utf8' });
  assert.equal(setup.status, 0, setup.stderr);
  f.$.session.cwd = async () => custom;
  const first = await f.turn('Stay in the custom worktree.', 1, false, { isolation: 'worktree' });
  assert.equal(first.status, 'completed');
  const request = f.jobs().find(job => job.id === first.jobId).request;
  assert.equal(request.permissionPolicy.worktree, custom);
  assert.deepEqual(request.permissionPolicy.writableRoots, [custom]);
  assert.equal(f.readStore()['native:v2:native-session:native-agent'].isolation, 'worktree');
  const task = f.capture.processes.find(p => p.kind === 'spawn' && p.request.argv[2] === 'task');
  assert.equal(task.request.argv[task.request.argv.indexOf('--native-isolation') + 1], 'worktree');
  f.reload();
  const escape = await f.turn(`DUET: --cwd ${f.root}/repo\nRefuse the main checkout.`, 2, false, { wake: true });
  assert.equal(escape.status, 'blocked');
  assert.equal(f.jobs().length, 1);
});

test('native remote isolation refuses before names, jobs or host spawn', async () => {
  const f = fixture('review-ok', 'remote-worker', { hostOnly: true });
  const response = await f.invoke('tool.call', { tool: 'Agent', tool_use_id: 'remote-call', subagent_type: AGENT_TYPE,
    name: 'remote-worker', prompt: 'Never start remotely.', isolation: 'remote' }, () => { throw new Error('Remote host spawn reached'); });
  const report = JSON.parse(response.deny);
  assert.equal(report.status, 'blocked');
  assert.equal(report.blockers[0].code, 'native_remote_isolation');
  assert.match(report.summary, /local runtime/i);
  assert.equal(report.next, 'Start a local native agent, optionally with isolation: "worktree".');
  assert.equal(f.capture.processes.length, 0);
  assert.equal(f.jobs().length, 0);
  assert.deepEqual(f.readStore(), {});
});

test('native teammate mailbox guard rejects peers and unverified deliveries, preserving coordinator and other loops', async () => {
  const f = fixture('review-ok', 'mailbox-worker', { hostOnly: true });
  f.$.agent.list = async () => [{ id: 'native-agent', type: AGENT_TYPE, name: 'mailbox-worker', teammateId: 'mailbox-worker@fixture' },
    { id: 'other-agent', type: 'Explore' }];
  const input = { agentId: 'native-agent', text: 'Bounded mailbox assignment.', origin: { kind: 'coordinator', teammate: 'team-lead', isVerified: true } };
  let queued = 0;
  const receive = (value = input) => f.invoke('session.receive', value, async e => {
    queued++; assert.deepEqual(e, value); return { text: e.text };
  });
  assert.deepEqual(await receive(), { text: input.text });
  const peer = await receive({ ...input, origin: { kind: 'peer', teammate: 'peer-worker', isVerified: true } });
  assert.equal(JSON.parse(peer.consumed).blockers[0].code, 'native_teammate_unsupported');
  const unverified = await receive({ ...input, origin: { ...input.origin, isVerified: false } });
  assert.equal(JSON.parse(unverified.consumed).status, 'blocked');
  assert.deepEqual(await receive({ ...input, agentId: 'other-agent', origin: { kind: 'peer', teammate: 'peer-worker', isVerified: true } }), { text: input.text });
  f.$.session.id = async () => { throw new Error('Mailbox identity unavailable'); };
  const unavailable = await receive({ ...input, origin: { kind: 'peer', teammate: 'peer-worker', isVerified: true } });
  assert.equal(JSON.parse(unavailable.consumed).blockers[0].code, 'native_teammate_unsupported');
  assert.equal(queued, 2);
  assert.equal(f.capture.processes.length, 0);
});

test('native pane teammates refuse explicitly and auto panes return a teams-specific blocked report', async () => {
  const f = fixture('review-ok', 'pane-worker', { hostOnly: true });
  f.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1';
  f.$.settings = { read: async () => ({ teammateMode: 'tmux' }) };
  const input = { tool: 'Agent', tool_use_id: 'pane-call', subagent_type: AGENT_TYPE, name: 'pane-worker', prompt: 'Never use panes.' };
  const refused = await f.invoke('tool.call', input, () => { throw new Error('Pane host spawn reached'); });
  assert.equal(JSON.parse(refused.deny).blockers[0].code, 'native_teammate_unsupported');
  assert.match(JSON.parse(refused.deny).next, /in-process teammate mode/);
  assert.equal(f.capture.processes.length, 0);
  f.$.settings.read = async () => ({ teammateMode: 'auto' });
  f.$.process.run = async argv => argv[0] === 'node' ? { exitCode: 0, stdout: process.execPath }
    : { exitCode: 0, stdout: '{"name":"pane-worker"}' };
  const automatic = await f.invoke('tool.call', input, async e => {
    const address = `${e.name}@fixture`;
    await f.invoke('agent.spawn', { subagentType: AGENT_TYPE, tool_use_id: input.tool_use_id, isTeammate: true,
      name: e.name, prompt: e.prompt }, async () => ({ model: 'haiku', agentId: address, teammateId: address }));
    return { result: { status: 'teammate_spawned', agentId: address, agent_id: address, teammate_id: address, name: e.name, prompt: e.prompt } };
  });
  assert.equal(JSON.parse(automatic.deny).blockers[0].code, 'native_teammate_unsupported');
  assert.match(JSON.parse(automatic.deny).next, /stop any pane teammate/);
  assert.deepEqual(f.readStore(), {});
  assert.equal(f.jobs().length, 0);
  assert.equal(fs.existsSync(`${f.root}/isolated/duet/native-unavailable.json`), false);
  const missing = fixture('review-ok', 'missing-loop', { hostOnly: true });
  await missing.invoke('agent.spawn', { subagentType: AGENT_TYPE, tool_use_id: 'missing-loop-call', isTeammate: true,
    name: 'missing-loop', prompt: 'No local start.' }, async () => ({ model: 'haiku', agentId: 'missing-loop' }));
  missing.reload();
  const noStart = await missing.invoke('turn.step', { agentId: 'missing-loop', turnId: 'missing-loop-turn', index: 0 },
    async function* () { throw new Error('Missing teammate loop reached Claude'); });
  assert.equal(JSON.parse(noStart.answer).blockers[0].code, 'native_teammate_unsupported');
  assert.equal(missing.capture.processes.length, 0);
  assert.equal(fs.existsSync(`${missing.root}/isolated/duet/native-unavailable.json`), false);
});

test('native caller names survive reservation, case collisions and resume', async () => {
  const f = fixture('review-ok', 'identity-review');
  const original = { result: {}, context: ['Original context'] };
  const first = await f.turn('Keep the caller label.', 1, false, { toolCall: true, toolResult: original });
  assert.equal(first.worker, 'identity-review');
  assert.deepEqual(f.capture.events.find(event => event.event === 'tool.call').result, original);
  const second = await f.turn('Avoid the same name.', 1, false, { toolCall: true, agentId: 'second-review', name: 'IDENTITY-REVIEW' });
  assert.notEqual(second.worker.toLowerCase(), first.worker.toLowerCase());
  assert.match(f.capture.events.filter(event => event.event === 'tool.call').at(-1).result.context[0], /requested "IDENTITY-REVIEW"/);
  f.reload();
  const resumed = await f.turn('Keep the existing name on resume.', 2, false, { toolCall: true });
  assert.equal(resumed.worker, first.worker);
  assert.equal(f.capture.processes.filter(p => p.request.argv[2] === 'reserve-name').length, 2);
  const reserved = fixture('review-ok', 'TaSk-review');
  const named = await reserved.turn('Assign an admissible name before spawn.', 1, false, { toolCall: true });
  const reserve = reserved.capture.processes.find(p => p.request.argv[2] === 'reserve-name');
  assert.equal(reserve.request.argv.includes('--preferred'), false);
  const spawned = reserved.capture.events.find(e => e.event === 'agent.spawn').input.name;
  assert.ok(AGENT_NAMES.includes(spawned));
  assert.equal(named.worker, spawned);
  assert.equal(reserved.readStore()['native:v2:native-session:native-agent'].name, spawned);
});

test('native role presets dispatch and persist roles, sandbox ceilings and saved defaults', async () => {
  for (const [role, sandbox] of [['reviewer', 'read-only'], ['implementer', 'workspace-write'], ['investigator', 'read-only']]) {
    const type = `fugato:codex-${role}`, f = fixture('review-ok', `preset-${role}`);
    const first = await f.turn('DUET: --model fixture-model --effort high --fast\nFirst role assignment.', 1, false, { agentType: type });
    assert.equal(first.status, 'completed');
    const initial = f.jobs().find(job => job.id === first.jobId);
    assert.equal(initial.request.sandbox, sandbox);
    assert.equal(initial.request.agentType, type);
    assert.equal(initial.request.model, 'fixture-model');
    assert.equal(initial.request.effort, 'high');
    assert.equal(initial.request.serviceTier, 'priority');
    assert.match(initial.request.prompt, new RegExp(`Codex ${role} role`));
    f.reload();
    const second = await f.turn('Continue the role assignment.', 2, false, { wake: true });
    const followup = f.jobs().find(job => job.id === second.jobId);
    assert.equal(followup.threadId, initial.threadId);
    assert.equal(followup.request.sandbox, sandbox);
    assert.equal(followup.request.agentType, type);
    assert.equal(followup.request.model, initial.request.model);
    assert.equal(followup.request.effort, initial.request.effort);
    assert.equal(followup.request.serviceTier, initial.request.serviceTier);
    assert.match(followup.request.prompt, new RegExp(`Codex ${role} role`));
    const conflict = await f.turn('DUET: --sandbox danger-full-access\nRefuse the sandbox override.', 3, false, { wake: true });
    assert.equal(conflict.blockers[0].code, 'native_preset_sandbox');
    assert.equal(f.jobs().length, 2);
    const planned = await f.turn('Continue read-only planning.', 4, false, { agentType: type, permissionMode: 'plan' });
    assert.equal(planned.status, 'completed');
    assert.equal(f.jobs().find(job => job.id === planned.jobId).request.sandbox, 'read-only');
  }
});

test('real companion: dispatch, completion and reload follow-up reuse the Codex thread/cwd without a model', async () => {
  const f = fixture('slow-recovery-task', 'f7-x');
  f.env.CODEX_FIXTURE_TURN_GATE = `${f.root}/finish-turn`;
  f.env.CODEX_COMPANION_LEASE_SEC = '1'; // Observe a real owner renewal before releasing the turn.
  const pending = f.turn('Perform the first fake assignment.', 1);
  // Gate completion on observed renewals, not a wall-clock sleep. Throughout
  // the quiet stream, the original task must remain the sole attached owner.
  const attached = await until(() => f.jobs().find(job => job.ownerAttached && job.turnId));
  assert.equal(attached.agentName, 'f7-x');
  const renewed = await until(() => f.jobs().find(job => job.leaseRenewedAt > attached.leaseRenewedAt));
  assert.equal(renewed.ownerWaitPid, attached.ownerWaitPid);
  assert.equal(renewed.ownerWaitToken, attached.ownerWaitToken);
  assert.equal(renewed.ownerAttachedAt, attached.ownerAttachedAt);
  assert.equal(renewed.ownerAttached, true);
  assert.equal(renewed.ownerDetachedAt, null);
  assert.equal(renewed.status, 'running');
  const ownerCalls = f.capture.processes.filter(p => p.kind === 'spawn' && ['task', 'wait'].includes(p.request.argv[2]));
  assert.equal(ownerCalls.length, 1);
  assert.equal(ownerCalls[0].request.argv[2], 'task');
  assert.equal(ownerCalls[0].request.argv[ownerCalls[0].request.argv.indexOf('--timeout-sec') + 1], '3600');
  assert.equal(ownerCalls[0].exit, undefined);
  assert.deepEqual(ownerCalls[0].chunks, []);
  // Twelve silent minutes exceed the live 600 s watchdog. Each default 30 s
  // heartbeat must arrive before completion while the sole owner stays live.
  for (let minute = 0; minute < 12; minute++) await f.advance(60000);
  const live = f.capture.events.find(e => e.event === 'turn.step').chunks;
  assert.equal(live.length, 25);
  assert.deepEqual(live[0], { kind: 'thinking', index: 0, text: f.capture.notices[0].message.content[0].text + '\n' });
  assert.ok(live.slice(1).every(c => c.kind === 'thinking' && /^Codex worker .+ running · /.test(c.text)));
  assert.ok(live.at(-1).text.trimEnd().endsWith(' running · 12m 0s'));
  assert.equal(ownerCalls[0].exit, undefined);
  const intent = Object.values(f.readStore())[0].intent;
  assert.equal(attached.dispatchNonce, intent.nonce);
  fs.writeFileSync(f.env.CODEX_FIXTURE_TURN_GATE, 'finish');
  const first = await pending;
  assert.equal(first.status, 'completed'); assert.ok(first.summary);
  assert.equal(first.worker, attached.agentName);
  const status = spawnSync(process.execPath, [plugin + '/bin/fugato', 'status', first.worker,
    '--cwd', `${f.root}/repo`, '--session', 'native-session', '--json'], { env: f.env, encoding: 'utf8' });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).job.agentName, first.worker);
  assert.equal(f.timers.size, 0);
  const step = f.capture.events.find(e => e.event === 'turn.step');
  const thinking = step.chunks.filter(c => c.kind === 'thinking');
  assert.ok(thinking.length <= 200);
  assert.ok(thinking.every(c => c.index === 0 && c.text.trimEnd().length <= 200));
  assert.deepEqual(step.chunks.slice(0, -2), thinking);
  assert.equal(step.chunks.at(-2).index, 1);
  const companionReport = JSON.parse(ownerCalls[0].chunks.filter(c => c.stream === 'stdout').map(c => c.text).join('').trimEnd().split('\n').at(-1));
  assert.equal(step.result.answer, JSON.stringify({ ...companionReport, next: first.next }));
  assert.ok(!step.result.answer.includes('running ·'));
  assert.ok(step.chunks.some(c => c.kind === 'thinking' && !c.text.includes('running ·')));
  assert.ok(f.capture.notices[0].message.content[0].text.startsWith(`Codex worker ${first.worker} started · job ${first.jobId} · gpt-6-astra / xhigh /`));
  assert.ok(f.capture.notices.every(n => n.agentId === 'native-agent' && n.message.type === 'system' && n.message.content.length === 1));
  const recorded = f.jobs()[0], saved = Object.values(f.readStore())[0];
  for (const key of ['ownerId', 'threadId']) assert.equal(saved[key], recorded[key]);
  assert.equal(saved.jobId, recorded.id);
  assert.equal(recorded.ownerDetachReason, 'returned');
  assert.equal(recorded.result.interruptionReason, null);
  const initial = f.codexState();
  assert.equal(initial.threads[0].cwd, `${f.root}/repo`);
  f.reload(); // registrations discarded; only the disk store remains
  // Even if the current context moves, the stored worker cwd is authoritative.
  f.$.session.cwd = async () => `${f.root}/different-context`;
  const second = await f.turn('Continue the same fake assignment.', 2);
  assert.equal(second.status, 'completed');
  assert.equal(second.worker, first.worker);
  const final = f.codexState();
  assert.equal(final.threads.length, 1);
  assert.equal(final.lastTurnStart.threadId, initial.lastTurnStart.threadId);
  assert.equal(final.threads[0].cwd, `${f.root}/repo`);
  assert.equal(Object.values(f.readStore())[0].cwd, `${f.root}/repo`);
  assert.equal(final.nextTurnId, 3);
  assert.equal(f.capture.processes.filter(p => p.kind === 'spawn' && p.request.argv[2] === 'wait').length, 0);
  assert.notEqual(second.jobId, first.jobId);
  assert.equal(first.details, `fugato result '${first.jobId}' --details`);
  assert.deepEqual(Object.keys(first).slice(0, 4), ['status', 'worker', 'jobId', 'summary']);
  const state = Object.values(f.readStore())[0];
  assert.equal(state.incoming, undefined);
  assert.equal(state.session, 'native-session');
  assert.ok(state.intent.nonce);
  for (const child of f.capture.processes.filter(p => p.kind === 'spawn')) {
    assert.equal(child.request.argv[1], plugin + '/bin/fugato');
    assert.ok(child.request.argv.includes('--session'));
    if (child.request.argv[2] === 'task') assert.equal(child.request.argv[child.request.argv.indexOf('--session-cwd') + 1], `${f.root}/repo`);
    if (child.request.argv[2] === 'task') {
      if (child.request.argv.includes('--fresh')) assert.equal(child.request.argv[child.request.argv.indexOf('--agent-name') + 1], first.worker);
      else assert.equal(child.request.argv.includes('--agent-name'), false);
    }
    assert.ok(!child.request.argv.includes('--quiet'));
    assert.ok(!child.request.argv.includes(child.request.input) || !child.request.input);
  }
  f.save();

  // Naming shares the real companion's reservation pool and survives reload.
  const auto = fixture('review-ok', null);
  const original = { result: { status: 'completed', content: 'Fixture report' }, context: ['Fixture context'] };
  const firstAuto = await auto.turn('Choose a native name.', 1, false, { toolResult: original });
  const named = auto.capture.events.find(e => e.event === 'tool.call').result;
  assert.deepEqual(named.result, original.result);
  assert.equal(named.context.length, 2);
  assert.ok(AGENT_NAMES.includes(firstAuto.worker));
  assert.equal((await auto.$.agent.list())[0].name, firstAuto.worker);
  const bash = spawnSync(process.execPath, [plugin + '/bin/fugato', 'task', '--fresh', '--session', 'native-session'],
    { cwd: `${auto.root}/repo`, env: auto.env, input: 'Reserve a Bash worker.', encoding: 'utf8' });
  assert.equal(bash.status, 0, bash.stderr);
  const bashName = JSON.parse(bash.stdout.trimEnd().split('\n').at(-1)).worker;
  const secondNamed = await auto.turn('Choose another native name.', 1, false, { agentId: 'native-second' });
  assert.equal(new Set([firstAuto.worker, secondNamed.worker, bashName]).size, 3);
  auto.reload();
  const continued = await auto.turn('Continue the named worker.', 2, false, { toolCall: true, toolResult: original });
  assert.equal(continued.worker, firstAuto.worker);
  assert.equal(auto.jobs().find(job => job.id === continued.jobId).threadId,
    auto.jobs().find(job => job.id === firstAuto.jobId).threadId);
  assert.deepEqual(auto.capture.events.filter(e => e.event === 'tool.call').at(-1).result, original);
  assert.equal(auto.capture.processes.filter(p => p.request.argv[2] === 'reserve-name').length, 2);

  const beforeOther = auto.capture.processes.length;
  for (const fields of [{ subagent_type: 'Explore' }, { resume: 'native-agent' }]) {
    const input = { tool: 'Agent', subagent_type: AGENT_TYPE, name: 'Fixture label', prompt: 'Fixture.', ...fields };
    assert.equal(await auto.invoke('tool.call', input, async e => { assert.deepEqual(e, input); return original; }), original);
  }
  assert.equal(auto.capture.processes.length, beforeOther);

  // Host-side reservation failures preserve the call and never retry it.
  const fallback = fixture('review-ok', null, { hostOnly: true });
  for (const failure of ['exit', 'timeout', 'malformed', 'truncated']) {
    let attempts = 0, forwarded;
    fallback.$.process.run = async argv => {
      if (argv[0] === 'node') return { exitCode: 0, stdout: process.execPath };
      attempts++;
      if (failure === 'timeout') throw Object.assign(new Error('Fixture timeout'), { code: 'ETIMEDOUT' });
      return { exitCode: failure === 'exit' ? 1 : 0, stdout: failure === 'malformed' ? '{' : '{"name":"Ada"}',
        isStdoutTruncated: failure === 'truncated' };
    };
    const input = { tool: 'Agent', tool_use_id: `reservation-${failure}`, subagent_type: AGENT_TYPE,
      name: 'Fixture label', prompt: 'Fixture.' };
    assert.equal(await fallback.invoke('tool.call', input, async e => { forwarded = e; return original; }), original);
    assert.deepEqual(forwarded, input);
    assert.equal(attempts, 1);
  }

  // A failed reservation still receives a companion name, never the host id.
  const unnamed = fixture('review-ok', null), agentId = 'a1b2c3d4e5f60718', run = unnamed.$.process.run;
  unnamed.$.process.run = async (argv, init) => argv[2] === 'reserve-name'
    ? { exitCode: 1, stdout: '' } : run(argv, init);
  const unnamedReport = await unnamed.turn('Recover without a reserved name.', 1, false, { agentId,
    afterSpawn: () => { unnamed.$.agent.list = async () => [{ id: agentId, name: agentId, type: AGENT_TYPE }]; } });
  assert.equal(unnamedReport.status, 'completed');
  assert.ok(AGENT_NAMES.includes(unnamedReport.worker));
  assert.notEqual(unnamedReport.worker, agentId);
  assert.equal(unnamed.jobs()[0].agentName, unnamedReport.worker);

  const sharedProbe = fixture('review-ok'), deadlines = [];
  let probes = 0, reservations = 0, forwarded = 0;
  sharedProbe.$.clock.after = (ms, fn) => { deadlines.push(fn); return { cancel() {} }; };
  sharedProbe.$.process.run = argv => {
    if (argv[2] === 'reserve-name') { reservations++; throw new Error('Unexpected reservation'); }
    probes++;
    return new Promise(() => {});
  };
  const probeWaiters = [0, 1].map(index => {
    const input = { tool: 'Agent', tool_use_id: `shared-probe-${index}`, subagent_type: AGENT_TYPE, name: 'f7-view', prompt: 'Fixture.' };
    return sharedProbe.invoke('tool.call', input, async e => { forwarded++; assert.deepEqual(e, input); return original; });
  });
  await until(() => probes === 1 && deadlines.length === 2);
  deadlines.forEach(expire => expire());
  assert.deepEqual(await Promise.all(probeWaiters), [original, original]);
  assert.equal(forwarded, 2);
  assert.equal(reservations, 0);

  const scoped = fixture('review-ok');
  const sub = `${scoped.root}/repo/packages/web`;
  fs.mkdirSync(sub, { recursive: true });
  const started = await scoped.turn(`DUET: --cwd "${sub}"\nInspect the fixture.`, 1);
  assert.equal(started.status, 'completed');
  assert.equal(scoped.jobs()[0].request.cwd, sub);
  assert.equal(scoped.jobs()[0].workspaceRoot, `${scoped.root}/repo`);
  assert.equal(scoped.codexState().lastThreadStart.cwd, sub);
  const threadId = scoped.jobs()[0].threadId;
  scoped.reload();
  scoped.$.session.cwd = async () => `${scoped.root}/different-context`;
  const followed = await scoped.turn('Continue the fixture.', 2);
  const followup = scoped.jobs().find(job => job.id === followed.jobId);
  assert.equal(followed.status, 'completed');
  assert.equal(followup.request.cwd, sub);
  assert.equal(followup.workspaceRoot, `${scoped.root}/repo`);
  assert.equal(followup.threadId, threadId);
  assert.equal(scoped.codexState().lastThreadResume.cwd, sub);
  assert.equal(Object.values(scoped.readStore())[0].cwd, sub);
});

test('SubagentStart context is bounded, injected after header parsing once, and late context waits for a follow-up', async () => {
  const f = fixture('review-ok');
  const start = { session_id: 'native-session', agent_id: 'native-agent', agent_type: AGENT_TYPE };
  const early = { additionalContext: ['Use the fixture conventions.', 'Use the fixture conventions.'] };
  assert.deepEqual(await f.invoke('classic.SubagentStart', start, async () => early), early);
  f.reload();
  let release, late;
  const oversized = 'Late fixture guidance. ' + 'x'.repeat(20000);
  await f.turn('DUET: --model fixture-model --effort high --fast\nFirst assignment.', 1, false, {
    afterSpawn: () => { late = f.invoke('classic.SubagentStart', start, () => new Promise(resolve => { release = resolve; })); },
    beforeComplete: async () => { release({ additionalContext: [oversized] }); await late; },
  });
  const tasks = () => f.capture.processes.filter(p => p.kind === 'spawn' && p.request.argv[2] === 'task');
  assert.equal(tasks()[0].request.input, 'Context from SubagentStart hooks:\nUse the fixture conventions.\n\nFirst assignment.');
  assert.ok(tasks()[0].request.argv.includes('fixture-model'));
  assert.ok(tasks()[0].request.argv.includes('--fast'));
  f.reload();
  await f.invoke('classic.SubagentStart', start, async () => ({ additionalContext: [...early.additionalContext, oversized] }));
  await f.turn('Second assignment.', 2);
  assert.match(tasks()[1].request.input, /^Context from SubagentStart hooks:\nLate fixture guidance\./);
  assert.ok(tasks()[1].request.input.length < 17000);
  assert.ok(!tasks()[1].request.input.includes('Use the fixture conventions.'));
  assert.ok(tasks()[1].request.input.endsWith('\n\nSecond assignment.'));
  f.reload();
  await f.invoke('classic.SubagentStart', start, async () => ({ additionalContext: [oversized] }));
  await f.turn('Third assignment.', 3);
  assert.equal(tasks()[2].request.input, 'Third assignment.');
});

test('refused starts release lifecycle context and abandoned sidecars expire after ten minutes', async () => {
  const f = fixture('review-ok', 'refused-context', { hostOnly: true });
  f.$.agent.list = async () => [{ id: 'refused', type: AGENT_TYPE }];
  f.setStore({ 'native:v2:foreign:active': { v: 2, session: 'foreign', agentId: 'active', type: AGENT_TYPE,
    incoming: { turnId: 'held', text: 'x'.repeat(524288) } } });
  await f.invoke('agent.spawn', { subagentType: AGENT_TYPE, tool_use_id: 'refused-spawn', name: 'refused-context' },
    async () => ({ model: 'haiku', agentId: 'refused' }));
  const start = { session_id: 'native-session', agent_id: 'refused', agent_type: AGENT_TYPE };
  const sidecar = 'native:lifecycle:v1:native-session:refused';
  await f.invoke('classic.SubagentStart', start, async () => ({ additionalContext: ['x'.repeat(16384)] }));
  await f.invoke('turn.start', { agentId: 'refused', turnId: 'full', text: 'No room.' }, async e => ({ turnId: e.turnId }));
  assert.equal(f.readStore()[sidecar], undefined);
  assert.equal(JSON.parse((await f.invoke('turn.step', { agentId: 'refused', turnId: 'full', index: 0 },
    async function* () { throw new Error('Refused start reached Claude'); })).answer).blockers[0].code, 'native_capacity');
  f.setStore({}); f.reload();
  await f.invoke('agent.spawn', { subagentType: AGENT_TYPE, tool_use_id: 'resume-missing', resume: { agentId: 'refused' } },
    async () => ({ model: 'haiku', agentId: 'refused' }));
  await f.invoke('classic.SubagentStart', start, async () => ({ additionalContext: ['x'.repeat(16384)] }));
  await f.invoke('turn.start', { agentId: 'refused', turnId: 'missing', text: 'No binding.' }, async e => ({ turnId: e.turnId }));
  assert.equal(f.readStore()[sidecar], undefined);
  assert.equal(JSON.parse((await f.invoke('turn.step', { agentId: 'refused', turnId: 'missing', index: 0 },
    async function* () { throw new Error('Missing binding reached Claude'); })).answer).blockers[0].code, 'native_binding_gone');
  const now = await f.$.clock.now(), prefix = 'native:lifecycle:v1:native-session:';
  f.setStore({ [prefix + 'orphan']: { at: now - 600000, contexts: [{ text: 'Expired' }] },
    [prefix + 'pending']: { at: now - 600000, contexts: [{ text: 'Pending' }] },
    [prefix + 'bound']: { at: now - 600000, contexts: [{ text: 'Bound' }] },
    'native:v2:native-session:bound': { type: AGENT_TYPE },
    [prefix + 'recent']: { at: now - 599999, contexts: [{ text: 'Recent' }] } });
  await lifecycleStoreSize(f.$, { keys: Object.keys(f.readStore()), now,
    pending: key => key === 'native:v2:native-session:pending' });
  assert.equal(f.readStore()[prefix + 'orphan'], undefined);
  assert.ok(f.readStore()[prefix + 'pending']);
  assert.ok(f.readStore()[prefix + 'bound']);
  assert.ok(f.readStore()[prefix + 'recent']);
});

test('SubagentStop feedback gets one durable Codex attempt per job, on the same thread, up to the cap', async () => {
  const f = fixture('review-ok');
  f.withUsage({ inputTokens: 150, cachedInputTokens: 40, outputTokens: 30, totalTokens: 180 });
  const journal = spawnSync(process.execPath, [plugin + '/bin/fugato', 'journal', 'start', '--session', 'native-session',
    '--cwd', `${f.root}/repo`, '--json'], { env: f.env, input: JSON.stringify({ goal: 'Lifecycle fixture', criteria: [] }), encoding: 'utf8' });
  assert.equal(journal.status, 0, journal.stderr);
  let report = await f.turn('Initial assignment.', 1);
  const reports = [report], feedback = { block: 'Verify the fixture again.', additionalContext: ['Preserve this host field.'] };
  const alreadyActive = await f.invoke('classic.SubagentStop', { session_id: 'native-session', agent_id: 'native-agent', agent_type: AGENT_TYPE,
    stop_hook_active: true, last_assistant_message: JSON.stringify(report) }, async () => feedback);
  assert.deepEqual(alreadyActive, { additionalContext: feedback.additionalContext });
  const step = index => f.invoke('turn.step', { agentId: 'native-agent', turnId: 'turn-1', index, model: 'haiku', messageCount: index + 1 },
    async function* () { throw new Error('Unexpected Claude request'); });
  for (let index = 1; index <= 3; index++) {
    const event = { session_id: 'native-session', agent_id: 'native-agent', agent_type: AGENT_TYPE,
      stop_hook_active: index > 1, last_assistant_message: JSON.stringify(report) };
    assert.deepEqual(await f.invoke('classic.SubagentStop', event, async () => feedback), feedback);
    f.reload();
    assert.deepEqual(await f.invoke('classic.SubagentStop', event, async () => feedback), feedback);
    const simultaneous = await Promise.all([step(index), step(index)]);
    assert.deepEqual(simultaneous[0], simultaneous[1]);
    report = JSON.parse(simultaneous[0].answer);
    assert.equal(report.status, 'completed');
    reports.push(report);
    const notices = f.capture.notices.map(n => n.message.content[0].text);
    assert.equal(notices.filter(text => text.startsWith('Codex worker ')).length, reports.length);
    assert.equal(notices.filter(text => text.startsWith('Codex tokens (provider:')).length, reports.length);
    f.reload();
    assert.deepEqual(JSON.parse((await step(index)).answer), report);
    assert.equal(f.codexState().nextTurnId, index + 2);
    const task = f.capture.processes.filter(p => p.kind === 'spawn' && p.request.argv[2] === 'task').at(-1);
    assert.equal(task.request.input, 'Feedback from SubagentStop hooks:\nVerify the fixture again.');
  }
  const capped = await f.invoke('classic.SubagentStop', { session_id: 'native-session', agent_id: 'native-agent', agent_type: AGENT_TYPE,
    stop_hook_active: true, last_assistant_message: JSON.stringify(report) }, async () => feedback);
  assert.deepEqual(capped, { additionalContext: feedback.additionalContext });
  assert.ok(f.capture.notices.some(n => /SubagentStop.*cap reached/.test(n.message.content[0].text)));
  assert.deepEqual(JSON.parse((await step(4)).answer), report);
  const jobs = f.jobs();
  assert.equal(jobs.length, 4);
  assert.equal(new Set(jobs.map(job => job.threadId)).size, 1);
  assert.equal(new Set(jobs.map(job => job.dispatchNonce)).size, 4);
  assert.equal(new Set(reports.map(result => result.jobId)).size, 4);
  const run = jobs[0];
  const entries = fs.readFileSync(path.join(run.runStateDir, 'runs', run.runId, 'journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(entries.filter(entry => entry.type === 'job_finished').map(entry => entry.jobId).sort(), reports.map(result => result.jobId).sort());
});

test('SubagentStop cannot answer a pending question or continue an unresolved Codex turn', async () => {
  const f = fixture('parent-question-sequence');
  const report = await f.turn('Ask the fixture parent.', 1);
  assert.equal(report.status, 'needs_answer');
  const feedback = { block: 'Keep working without an answer.', additionalContext: ['Preserve host context.'] };
  const event = { session_id: 'native-session', agent_id: 'native-agent', agent_type: AGENT_TYPE,
    stop_hook_active: false, last_assistant_message: JSON.stringify(report) };
  assert.deepEqual(await f.invoke('classic.SubagentStop', event, async () => feedback), { additionalContext: feedback.additionalContext });
  assert.ok(f.capture.notices.some(n => /SubagentStop.*question pending/.test(n.message.content[0].text)));
  f.reload();
  const step = await f.invoke('turn.step', { agentId: 'native-agent', turnId: 'turn-1', index: 1, model: 'haiku', messageCount: 2 },
    async function* () { throw new Error('Unexpected Claude request'); });
  assert.deepEqual(JSON.parse(step.answer), report);
  assert.equal(f.codexState().nextTurnId, 2);
  assert.equal(f.capture.processes.filter(p => p.request.argv[2] === 'answer').length, 0);
  const state = f.readStore();
  const binding = state['native:v2:native-session:native-agent'];
  binding.status = 'unknown'; delete binding.answeredTurn;
  binding.answer = { status: 'blocked', jobId: report.jobId, blockers: [{ code: 'thread_busy' }] };
  f.setStore(state);
  assert.deepEqual(await f.invoke('classic.SubagentStop', { ...event, last_assistant_message: JSON.stringify(binding.answer) }, async () => feedback),
    { additionalContext: feedback.additionalContext });
  assert.ok(f.capture.notices.some(n => /SubagentStop.*unresolved turn/.test(n.message.content[0].text)));
  assert.equal(f.jobs().length, 1);
  assert.equal(f.codexState().nextTurnId, 2);
});

test('real companion: question/answer stays on the job; abort interrupts fake Codex and persists cancellation', async t => {
  const question = fixture('parent-question-sequence');
  const asked = await question.turn('Ask the fake parent a question.', 1);
  assert.equal(asked.status, 'needs_answer'); assert.ok(asked.question.id);
  const deferred = steer(question, question.jobs()[0], 'question-answer', 'Small');
  assert.equal(deferred.status, 'deferred'); assert.equal(deferred.reason, 'pending_question');
  assert.equal(deferred.fallback, true);
  assert.equal(question.codexState().steers, undefined);
  assert.ok(question.capture.notices.some(n => n.message.content[0].text === `? Waiting for Claude: ${asked.question.text}`));
  question.reload();
  // Entering plan mode cannot answer into a previously writable live turn.
  const inPlan = await question.turn('Do not resume writes from plan mode.', 2, false, { permissionMode: 'plan' });
  assert.equal(inPlan.blockers[0].code, 'native_plan_mode_read_only');
  assert.equal(question.capture.processes.filter(p => p.request.argv[2] === 'answer').length, 0);
  // Another owner path answers Q1 and the same job parks at Q2 before Claude's
  // delayed Q1 answer arrives. Never retarget that text to the new question.
  const jobBeforeAnswer = question.jobs()[0];
  const external = spawnSync(process.execPath, [plugin + '/bin/fugato', 'answer', asked.jobId,
    '--question', asked.question.id, '--owner', jobBeforeAnswer.ownerId, '--timeout-sec', '5',
    '--cwd', `${question.root}/repo`, '--session', 'native-session'], { env: question.env, input: 'Small', encoding: 'utf8' });
  assert.equal(external.status, 0, external.stderr);
  const current = await until(() => question.jobs().find(job => job.pendingQuestion?.id !== asked.question.id)?.pendingQuestion);
  const stale = await question.turn('Late Q1 answer', 3);
  assert.equal(stale.status, 'needs_answer');
  assert.equal(stale.question.id, current.id);
  assert.equal(stale.question.text, current.text);
  assert.deepEqual(stale.question.options, current.options);
  assert.equal(question.capture.processes.filter(p => p.request.argv[2] === 'answer').length, 0);
  assert.equal(question.codexState().serverRequestReplies.length, 1);
  const answered = await question.turn('Small', 4);
  assert.equal(answered.status, 'completed'); assert.equal(answered.jobId, asked.jobId);
  assert.equal(question.codexState().nextTurnId, 2);
  assert.ok(JSON.stringify(question.codexState().serverRequestReplies).includes('Small'));
  question.save();

  const late = fixture('parent-question-sequence');
  const displayed = await late.turn('Ask before an external answer.', 1);
  const original = late.jobs()[0];
  const externalAnswer = pending => {
    const response = spawnSync(process.execPath, [plugin + '/scripts/codex-companion.mjs', 'answer', original.id,
      '--question', pending.id, '--owner', original.ownerId, '--json', '--session', 'native-session'],
    { cwd: original.workspaceRoot, env: late.env, input: 'Small', encoding: 'utf8' });
    assert.equal(response.status, 0, response.stderr);
  };
  externalAnswer(displayed.question);
  // A late answer while Codex keeps working stays attached as the owner wait
  // and returns the next real state, never a running snapshot.
  const waited = await late.turn('Late Q1 answer', 2);
  assert.equal(waited.jobId, original.id); assert.equal(waited.status, 'needs_answer');
  assert.notEqual(waited.question.id, displayed.question.id);
  assert.equal(late.capture.processes.filter(p => p.request.argv[2] === 'answer').length, 0);
  externalAnswer(waited.question);
  await until(() => late.jobs().find(job => job.id === original.id)?.status === 'completed');
  late.reload();
  const resolvedAnswer = await late.turn('Late Q2 answer', 3);
  assert.equal(resolvedAnswer.jobId, original.id); assert.equal(resolvedAnswer.status, 'completed');
  assert.equal(late.codexState().nextTurnId, 2);
  assert.equal(late.capture.processes.filter(p => p.kind === 'spawn' && p.request.argv[2] === 'task').length, 1);
  late.reload();
  const continuation = await late.turn('Start the next assignment.', 4);
  assert.notEqual(continuation.jobId, original.id);
  assert.equal(late.jobs().find(job => job.id === continuation.jobId).threadId, original.threadId);
  assert.equal(late.codexState().nextTurnId, 3);

  // Plan mode never reattaches to a writable job, even only to wait.
  const planLate = fixture('parent-question-sequence');
  const planShown = await planLate.turn('Ask before a plan-mode late answer.', 1), planJob = planLate.jobs()[0];
  const planAnswer = spawnSync(process.execPath, [plugin + '/scripts/codex-companion.mjs', 'answer', planJob.id,
    '--question', planShown.question.id, '--owner', planJob.ownerId, '--json', '--session', 'native-session'],
  { cwd: planJob.workspaceRoot, env: planLate.env, input: 'Small', encoding: 'utf8' });
  assert.equal(planAnswer.status, 0, planAnswer.stderr);
  const planned = await planLate.turn('Late answer from plan mode', 2, false, { permissionMode: 'plan' });
  assert.equal(planned.blockers[0].code, 'native_plan_mode_read_only');
  assert.equal(planLate.capture.processes.filter(p => ['wait', 'answer'].includes(p.request.argv[2])).length, 0);

  const approvals = fixture('server-requests');
  const denied = await approvals.turn('Run fixture approval requests.', 1);
  assert.equal(denied.status, 'blocked');
  const blockers = approvals.jobs()[0].result.blockers;
  assert.equal(blockers.length, 8);
  assert.equal(blockers.filter(blocker => blocker.code === 'approval_denied').length, 1);
  assert.equal(blockers.filter(blocker => blocker.code === 'approval_unsupported').length, 7);
  const elicitation = blockers.find(blocker => blocker.code === 'approval_denied');
  assert.equal(elicitation.method, 'mcpServer/elicitation/request'); assert.equal(elicitation.kind, 'elicitation-form');
  assert.equal(elicitation.server, 'cua_repl'); assert.equal(elicitation.origin, 'https://example.com');
  assert.ok(blockers.every(blocker => Object.keys(blocker).every(key => ['code', 'message', 'method', 'kind', 'requestId', 'app', 'server', 'origin'].includes(key))));
  assert.doesNotMatch(JSON.stringify(blockers), /DO_NOT_LOG_FIXTURE|access_browser_origin|requestedSchema/);

  const questionSave = fixture('parent-question-sequence'), questionSet = questionSave.$.store.set;
  let finalFailed = false;
  questionSave.$.store.set = async (key, value) => {
    if (!finalFailed && value.answer?.status === 'needs_answer') {
      finalFailed = true;
      throw new Error('Final question write failed before commit');
    }
    return questionSet(key, value);
  };
  const shown = await questionSave.turn('Ask a question whose final write fails.', 1);
  assert.equal(finalFailed, true);
  assert.equal(shown.status, 'needs_answer');
  questionSave.reload();
  assert.equal((await questionSave.turn('Small', 2)).status, 'needs_answer');
  const submitted = questionSave.capture.processes.find(p => p.request.argv[2] === 'answer');
  assert.equal(submitted.request.argv[submitted.request.argv.indexOf('--question') + 1], shown.question.id);

  // A failure before returning Q2 must not record it as shown. Also cover a
  // finalisation write which commits and then throws: Q2 must still be returned.
  for (const finalWrite of [false, true]) {
    const failure = fixture('parent-question-sequence');
    const q1 = await failure.turn('Ask Q1 before injecting a store failure.', 1);
    const job = failure.jobs()[0];
    const external = spawnSync(process.execPath, [plugin + '/bin/fugato', 'answer', q1.jobId,
      '--question', q1.question.id, '--owner', job.ownerId, '--timeout-sec', '5',
      '--cwd', `${failure.root}/repo`, '--session', 'native-session'], { env: failure.env, input: 'Small', encoding: 'utf8' });
    assert.equal(external.status, 0, external.stderr);
    const q2 = await until(() => failure.jobs().find(job => job.pendingQuestion?.id !== q1.question.id)?.pendingQuestion);
    const set = failure.$.store.set;
    let writes = 0, injected = false;
    failure.$.store.set = async (key, value) => {
      if (key.startsWith('native:v2:') && value.intent?.turnId === 'turn-2' && value.status === 'needs_answer') {
        if (finalWrite ? value.answer?.status === 'needs_answer' : ++writes === 2) {
          injected = true;
          if (finalWrite) await set(key, value);
          throw new Error('Injected question report save failure');
        }
      }
      return set(key, value);
    };
    const failed = await failure.turn('Late Q1 answer', 2);
    assert.equal(injected, true);
    const saved = Object.values(failure.readStore()).find(s => s.agentId === 'native-agent');
    if (finalWrite) {
      assert.equal(failed.status, 'needs_answer');
      assert.equal(failed.question.id, q2.id);
      assert.equal(saved.questionId, q2.id);
    } else {
      assert.equal(failed.status, 'blocked');
      assert.equal(saved.questionId, q1.question.id);
      failure.reload();
      const retried = await failure.turn('Retry the late Q1 answer', 3);
      assert.equal(retried.status, 'needs_answer');
      assert.equal(retried.question.id, q2.id);
      assert.equal(retried.question.text, q2.text);
      assert.deepEqual(retried.question.options, q2.options);
    }
    assert.equal(failure.capture.processes.filter(p => p.request.argv[2] === 'answer').length, 0);
    assert.equal(failure.codexState().serverRequestReplies.length, 1);
  }

  const cancellation = fixture('interruptible-slow-task');
  cancellation.stopOnWait();
  const stopped = await cancellation.turn('Run until stopped.', 1, true);
  const job = cancellation.jobs()[0];
  assert.ok(isC2Report(stopped));
  assert.equal(job.status, 'interrupted');
  assert.equal(job.result.interruptionReason, 'owner_stopped');
  // The stopped dispatch cannot run processes: it reports from recorded handles
  // and turn.complete records the confirmation.
  assert.equal(stopped.status, 'interrupted');
  assert.equal(stopped.worker, job.agentName);
  assert.equal(stopped.jobId, job.id);
  assert.equal(stopped.details, `fugato result '${job.id}' --details`);
  assert.ok(!stopped.blockers?.some(blocker => blocker.code === 'native_adapter_error'));
  assert.equal(job.ownerAttached, false);
  assert.equal(job.dispatchNonce, 'native-session:native-agent:turn-1');
  assert.ok(cancellation.codexState().lastInterrupt);
  const state = Object.values(cancellation.readStore())[0];
  assert.deepEqual(state.answer, stopped);
  assert.equal(state.jobId, job.id);
  assert.equal(state.worker, job.agentName);
  assert.equal(state.cancellation.confirmation, 'confirmed');
  assert.equal(state.cancellation.reason, 'owner_stopped');
  assert.equal(state.status, job.status);
  const endingNotices = async (f, job) => {
    const keys = ['HOME', 'USERPROFILE', 'CODEX_COMPANION_HOME', 'CODEX_COMPANION_TEST_MODE',
      'CODEX_COMPANION_TEST_ROOT', 'CODEX_HOME', 'CODEX_SQLITE_HOME', 'CLAUDE_PLUGIN_DATA'];
    const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    try {
      for (const key of keys) process.env[key] = f.env[key];
      updateJob(`${f.root}/repo`, job.id, () => ({ completedAt: new Date(Date.now() - 30000).toISOString() }));
    } finally {
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
      }
    }
    const hooks = new Map();
    reportHooks((event, fn) => { hooks.set(event, fn); return { catch() {} }; });
    const submit = () => hooks.get('prompt.submit')(f.$, { text: 'Status', origin: { kind: 'composer' }, context: [] }, async e => e);
    return [(await submit()).context.length, (await submit()).context.length];
  };
  assert.ok(job.reportEmittedAt);
  assert.equal(cancellation.capture.processes.filter(p => p.kind === 'run' && p.request.argv.includes('--mark-emitted')).length, 1);
  // The closure marker, not the overwritable state record, admits the next SendMessage.
  assert.ok(Object.entries(cancellation.readStore()).some(([key, value]) => key.startsWith('native:closed:v1:') && value.turnId === 'turn-1'));
  cancellation.save();
  assert.deepEqual(await endingNotices(cancellation, job), [0, 0]);

  // Gate thread creation before the adapter learns any handles. The host
  // rejects this aborted stream even though the signal handler wrote a line.
  const startup = fixture('review-ok', 'native-worker', { mutable: true }), binary = startup.env.CODEX_COMPANION_BIN;
  const starting = `${startup.root}/starting`, release = `${startup.root}/release`;
  const source = fs.readFileSync(binary, 'utf8');
  const gated = source.replace('case "thread/start": {', `case "thread/start": {
    fs.writeFileSync(${JSON.stringify(starting)}, 'ready');
    while (!fs.existsSync(${JSON.stringify(release)})) await new Promise(resolve => setTimeout(resolve, 25));`);
  assert.notEqual(gated, source);
  fs.writeFileSync(binary, gated);
  const pending = startup.turn('Stop before startup completes.', 1, true);
  await until(() => fs.existsSync(starting));
  assert.equal(startup.jobs().length, 1);
  assert.equal(startup.jobs()[0].dispatchNonce, 'native-session:native-agent:turn-1');
  assert.equal(Object.values(startup.readStore()).some(state => !!state.jobId), false);
  startup.abort();
  await until(() => startup.jobs().some(job => job.ownerAttached === false));
  fs.writeFileSync(release, 'continue');
  const unconfirmed = await pending;
  const startupJob = await until(() => startup.jobs().find(job => !['queued', 'running'].includes(job.status)));
  assert.equal(unconfirmed.jobId, null);
  assert.equal(unconfirmed.status, 'blocked');
  assert.equal(startupJob.status, 'interrupted');
  assert.equal(startup.codexState().nextTurnId, 1);
  assert.equal(startupJob.reportEmittedAt, undefined);
  assert.equal(startup.capture.processes.filter(p => p.kind === 'run' && p.request.argv.includes('--mark-emitted')).length, 0);
  assert.deepEqual(await endingNotices(startup, startupJob), [1, 0]);

  // A dead wrapper cannot observe its owner's stop. The adapter must retain
  // fugato cancel's app-server recovery path to interrupt the unresolved turn.
  const dead = fixture('lost-turn:owner-stop');
  dead.stopOnWait(() => process.kill(dead.jobs()[0].pid, 'SIGSTOP'));
  await dead.turn('Run until stopped after the wrapper exits.', 1, true, { beforeComplete: async () => {
    // Also lose the broker connection, keeping the fake server's persisted
    // turn in progress. No surviving wrapper/broker can stop it for the adapter.
    const records = fs.readdirSync(`${dead.root}/processes`).map(name => JSON.parse(fs.readFileSync(`${dead.root}/processes/${name}`, 'utf8')));
    const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
    for (const record of records.filter(record => !record.exited && alive(record.pid))) process.kill(record.pid, 'SIGKILL');
    await until(() => records.every(record => record.exited || !alive(record.pid)));
  } });
  const deadJob = dead.jobs()[0], deadState = Object.values(dead.readStore()).find(value => value.v === 2);
  const fallback = dead.capture.processes.filter(call => call.kind === 'run' && call.request.argv[2] === 'cancel');
  const waitIndex = dead.capture.processes.findIndex(call => call.kind === 'run' && call.request.argv.includes('--wait'));
  const cancelIndex = dead.capture.processes.findIndex(call => call.kind === 'run' && call.request.argv[2] === 'cancel');
  t.diagnostic(JSON.stringify({ scenario: 'native-stop-dead-wrapper', cancelCalls: fallback.length,
    status: deadJob.status, interruptionConfirmed: deadJob.result?.interruptionConfirmed === true,
    confirmation: deadState.cancellation?.confirmation, lastInterrupt: dead.codexState().lastInterrupt,
    ownerDetachReason: deadJob.ownerDetachReason }));
  assert.equal(fallback.length, 1, 'A stopped dead wrapper requires the fugato cancel safety net');
  assert.ok(waitIndex >= 0 && waitIndex < cancelIndex, 'Read-only owner-stop confirmation precedes the fallback cancel');
  assert.ok(['interrupted', 'cancelled'].includes(deadJob.status));
  assert.equal(deadJob.result.interruptionConfirmed, true);
  assert.deepEqual(dead.codexState().lastInterrupt, { threadId: deadJob.threadId, turnId: deadJob.turnId });
  assert.equal(deadState.cancellation.confirmation, 'confirmed');
  assert.equal(deadState.status, deadJob.status);
});

// Job reads are independent test assertions, outside the captured hook boundary.
function inspect(f, id) {
  const result = spawnSync(process.execPath, [plugin + '/bin/fugato', 'status', ...(id ? [id] : []), '--all', '--json',
    '--cwd', `${f.root}/repo`, '--session', 'native-session'], { env: f.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('dispatch intent survives the response/persistence gap and nonce retries reserve only one job', async () => {
  const f = fixture('review-ok');
  const first = await f.turn('Dispatch exactly once.', 1);
  assert.equal(first.status, 'completed');
  const before = inspect(f, first.jobId).job;
  assert.equal(before.sessionId, 'native-session');
  const marker = JSON.parse(fs.readFileSync(`${f.root}/isolated/duet/sessions/native-session/${first.jobId}.json`, 'utf8'));
  assert.equal(marker.jobId, first.jobId);
  assert.equal(JSON.parse(fs.readFileSync(marker.jobFile, 'utf8')).dispatchNonce, before.dispatchNonce);
  assert.equal(before.dispatchNonce, 'native-session:native-agent:turn-1');
  assert.equal(before.request.model, 'gpt-6-astra');
  assert.equal(before.request.effort, 'xhigh');
  assert.equal(f.capture.processes.find(p => p.request.argv[2] === 'task').request.argv.includes('--effort'), false);
  assert.equal(before.request.serviceTier, null);
  // Lose the first response and all handles, preserving only the pre-spawn intent.
  const data = f.readStore(), state = Object.values(data)[0];
  for (const key of ['answer', 'answeredTurn', 'jobId', 'threadId', 'ownerId', 'worker', 'status', 'questionId', 'finishedAt']) delete state[key];
  f.setStore(data); f.reload();
  const repeated = await f.turn('Dispatch exactly once.', 1);
  assert.equal(repeated.jobId, first.jobId);
  assert.equal(repeated.status, 'completed');
  assert.equal(f.codexState().nextTurnId, 2);
  // A second CLI process with the same hidden nonce also reattaches atomically.
  const retry = spawnSync(process.execPath, [plugin + '/bin/fugato', 'task', '--fresh', '--dispatch-nonce', before.dispatchNonce,
    '--quiet', '--timeout-sec', '1', '--cwd', `${f.root}/repo`, '--session', 'native-session'],
    { env: f.env, input: 'Dispatch exactly once.', encoding: 'utf8' });
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal(JSON.parse(retry.stdout.trim()).jobId, first.jobId);
  assert.equal(f.codexState().nextTurnId, 2);
  const listed = inspect(f);
  assert.equal([...(listed.running || []), listed.latestFinished, ...(listed.recent || [])].filter(Boolean).length, 1);
  f.save();
});

const renderLeaves = node => typeof node === 'string' ? [node] : node && typeof node === 'object'
  ? [...(typeof node.props?.text === 'string' ? [node.props.text] : []), ...(node.children ?? []).flatMap(renderLeaves)] : [];
const renderNativePrompt = (f, text, columns = 80) => f.invoke('ui.render', {
  component: 'UserMessage', requestId: 'render-row', props: { text }, viewport: { columns },
}, async e => ({ type: 'Engine', props: { text: e.props.text } }));
const appendRenderPrompt = (f, text) => ({ afterSpawn: () => f.invoke('session.append', {
  agentId: 'native-agent', door: 'prompt', uuid: 'render-row', message: { type: 'user' },
}, async () => ({ message: { content: text } })) });

test('native question and blocker displays neutralize controls without changing the worker payload', async () => {
  const f = fixture('parent-question-sequence', 'native-worker', { mutable: true });
  const raw = 'MARK\x1b[2K\x1b]marker\x07\x85\u202e\r\n\tTAIL';
  const file = `${f.root}/bin/codex`, source = fs.readFileSync(file, 'utf8');
  const changed = source.replace('"Which fixture fallback?"', JSON.stringify(raw));
  assert.notEqual(changed, source);
  fs.writeFileSync(file, changed);
  const renderQuestion = async () => renderLeaves(await f.invoke('ui.render', { component: 'ToolUse', viewport: { columns: 120 },
    props: { tool: 'Agent', tool_use_id: 'spawn-1', input: { subagent_type: AGENT_TYPE } } }, async () => ({ type: 'Engine' }))).join('');
  const frames = [];
  f.$.ui = { invalidate() { frames.push(renderQuestion()); } };
  const asked = await f.turn('Ask for the harmless marker.', 1);
  assert.equal(asked.status, 'needs_answer');
  const questions = (await Promise.all(frames)).filter(text => text.includes('? asks Claude · MARK'));
  assert.ok(questions.length > 0);
  assert.ok(questions.every(text => !/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(text)));
  const question = await renderQuestion();
  assert.ok(question.includes('? asks Claude · MARK ]marker TAIL'), JSON.stringify(question));
  assert.equal(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(question), false);
  assert.equal(f.jobs()[0].pendingQuestion.text, raw);
  const report = { status: 'blocked', worker: 'native-worker', jobId: asked.jobId, summary: raw,
    changedFiles: ['src/shared.mjs'], changedFilesShared: true, changedFilesNote: "changedFiles may include other workers' edits.",
    blockers: [{ code: raw, message: raw }], next: null, details: null };
  const serialized = JSON.stringify(report);
  const markdown = renderLeaves(await f.invoke('ui.render', { component: 'AssistantMessage', props: { text: serialized } },
    async e => ({ type: 'Engine', props: { text: e.props.text } }))).join('');
  assert.ok(markdown.includes('  changed   src/shared.mjs'));
  assert.ok(markdown.includes('  blocker   MARK ]marker TAIL: MARK ]marker TAIL'));
  assert.ok(!markdown.includes(report.changedFilesNote));
  assert.equal(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(markdown), false);
  assert.equal(report.blockers[0].code, raw);
  assert.equal(JSON.parse(serialized).summary, raw);
  const full = { ...report, summary: Array(12).fill('summary').join('\n'),
    checks: { ran: Array(10).fill('check') }, changedFiles: Array.from({ length: 10 }, (_, i) => `file-${i}`),
    keyFindings: Array(10).fill('finding'), blockers: [{ code: 'runtime_refusal', message: 'Retain this blocker.' }],
    question: { text: 'Continue?', options: Array(10).fill('option') } };
  const fullBlock = await f.invoke('ui.render', { component: 'AssistantMessage', props: { text: JSON.stringify(full) } },
    async e => ({ type: 'Engine', props: { text: e.props.text } }));
  const rendered = fullBlock.children.map(row => renderLeaves(row).join('')).join('\n');
  assert.deepEqual({ blocker: rendered.includes('runtime_refusal'),
    ordered: rendered.indexOf('  changed') < rendered.indexOf('  question'),
    files: (rendered.match(/file-\d+/g) ?? []).length, omitted: rendered.includes('+5 more'),
    bounded: fullBlock.children.length <= 60 }, { blocker: true, ordered: true, files: 5, omitted: true, bounded: true });
  const outlined = await f.invoke('ui.render', { component: 'AssistantMessage', viewport: { columns: 60 },
    props: { text: JSON.stringify({ ...report, summary: 'First paragraph.\n\nSecond paragraph.\n- Kept list marker.\n' + Array(80).fill('More summary.').join('\n') }) } },
    async e => ({ type: 'Engine', props: { text: e.props.text } }));
  const summaryRows = outlined.children.map(row => renderLeaves(row).join('')).filter(row => row.startsWith('▏'));
  assert.deepEqual({ first: summaryRows.slice(0, 4), moreThanTwelve: summaryRows.length > 12,
    bounded: outlined.children.length <= 60,
    overflow: summaryRows.at(-1).endsWith('…') },
  { first: ['▏First paragraph.', '▏', '▏Second paragraph.', '▏- Kept list marker.'], moreThanTwelve: true, bounded: true, overflow: true });
  assert.equal((await f.turn('Small', 2)).status, 'needs_answer');
  assert.equal((await f.turn('Small', 3)).status, 'completed');
});

test('native middle truncation preserves regional-indicator suffix order', async () => {
  const f = fixture('review-ok', 'native-worker', { mutable: true });
  const text = 'Review command output.', command = 'node ' + 'x'.repeat(45) + '🇺🇸🇨';
  const file = `${f.root}/bin/codex`, source = fs.readFileSync(file, 'utf8');
  const needle = 'if (BEHAVIOR.startsWith("lost-turn:") && turnId === "turn_1")';
  assert.ok(source.includes(needle));
  const item = { type: 'commandExecution', id: 'unicode-command', command, status: 'completed', exitCode: 0 };
  fs.writeFileSync(file, source.replace(needle, `items.unshift({completed:${JSON.stringify(item)}});\n${needle}`));
  assert.equal((await f.turn(text, 1, false, appendRenderPrompt(f, text))).status, 'completed');
  const leaves = renderLeaves(await renderNativePrompt(f, text, 100));
  const label = leaves.find(value => value.includes('…') && value.endsWith("🇺🇸🇨'"));
  assert.ok(label.includes('…'), label);
  assert.ok(label.endsWith("🇺🇸🇨'"), label);
  assert.equal(f.jobs()[0].activity.find(event => event.type === 'commandExecution').command, command);
});

test('durable activity keeps failed exit codes and file summaries within its display bound', async () => {
  const f = fixture('review-ok', 'native-worker', { mutable: true });
  f.$.command = { list: async () => [{ name: 'fugato-live' }] };
  const file = `${f.root}/bin/codex`, source = fs.readFileSync(file, 'utf8');
  const needle = 'if (BEHAVIOR.startsWith("lost-turn:") && turnId === "turn_1")';
  const items = [{ completed: { type: 'commandExecution', id: 'failed', command: 'node ' + 'x'.repeat(300), status: 'failed', exitCode: 7 } },
    { completed: { type: 'fileChange', id: 'changed', status: 'completed', changes: [
      { path: '/workspace/' + 'long-path/'.repeat(22) + 'file.mjs', kind: 'update', diff: '@@ -1,2 +1,3 @@\n-old\n-old\n+new\n+new\n+new\n' },
    ] } }];
  assert.ok(source.includes(needle));
  fs.writeFileSync(file, source.replace(needle, `items.unshift(...${JSON.stringify(items)});\n${needle}`));
  const report = await f.turn('Capture bounded activity.', 1);
  assert.equal(report.status, 'completed');
  const texts = f.capture.notices.map(notice => notice.message.content[0].text);
  assert.ok(texts.some(text => text.includes('Bash(') && text.endsWith('Error: exit 7') && text.length <= 200));
  assert.ok(texts.some(text => text.includes('Update(') && text.endsWith('+3 −2') && text.length <= 200));
  assert.ok(texts.some(text => text.includes('Open Codex activity: /fugato-live native-worker')));
  const markdown = renderLeaves(await f.invoke('ui.render', { component: 'AssistantMessage', props: { text: JSON.stringify(report) } },
    async e => ({ type: 'Engine', props: { text: e.props.text } }))).join('');
  assert.match(markdown, /done · .* · 180 tokens · \/fugato-live native-worker/);
  assert.ok(!markdown.includes('provider:'));
});

test('native run logs settle unmatched starts after confirmed cancellation', async () => {
  const f = fixture('interruptible-slow-task', 'native-worker', { mutable: true }), text = 'Run until stopped.';
  const file = `${f.root}/bin/codex`, source = fs.readFileSync(file, 'utf8');
  const start = source.indexOf('if (BEHAVIOR === "interruptible-slow-task"');
  const at = source.indexOf('interruptibleTurns.set(turnId', start);
  assert.ok(start > 0 && at > start);
  const command = (id, status) => ({ type: 'commandExecution', id, command: 'npm test', status });
  const events = [
    ['item/started', command('finished-command', 'inProgress')],
    ['item/completed', { ...command('finished-command', 'completed'), exitCode: 0 }],
    ['item/started', command('pending-command', 'inProgress')],
  ].map(([method, item]) => `send({method:${JSON.stringify(method)},params:{threadId:thread.id,turnId,item:${JSON.stringify(item)}}});\n`).join('');
  fs.writeFileSync(file, source.slice(0, at) + events + source.slice(at));
  f.stopOnWait(async () => {
    await until(async () => renderLeaves(await renderNativePrompt(f, text)).some(value => value.includes('running 0s')));
    const cancelled = spawnSync(process.execPath, [plugin + '/bin/fugato', 'cancel', f.jobs()[0].id,
      '--json', '--cwd', `${f.root}/repo`, '--session', 'native-session'], { env: f.env, encoding: 'utf8' });
    assert.equal(cancelled.status, 0, cancelled.stderr);
    assert.equal(JSON.parse(cancelled.stdout).confirmation, 'confirmed');
  });
  const report = await f.turn(text, 1, true, { ...appendRenderPrompt(f, text),
    beforeComplete: () => until(() => f.jobs().every(job => !['queued', 'running'].includes(job.status))),
  });
  assert.ok(['interrupted', 'cancelled'].includes(report.status));
  const job = f.jobs()[0], state = Object.values(f.readStore()).find(value => value.intent);
  assert.equal(job.status, 'cancelled');
  assert.equal(job.result.interruptionReason, 'cancelled_by_user');
  assert.equal(state.cancellation.reason, job.result.interruptionReason);
  assert.equal(state.cancellation.confirmation, 'confirmed');
  const leaves = renderLeaves(await renderNativePrompt(f, text));
  assert.ok(leaves.includes(' · ' + job.status), JSON.stringify(leaves));
  assert.equal(leaves.filter(value => value === report.status).length, 1, 'One final status follows the interrupted feed');
  assert.ok(!leaves.some(value => value.startsWith('running ')));
  assert.ok(leaves.some(value => /^✓/.test(value)), 'Completed command keeps its successful outcome');
});

test('native headers project flags, preserve ordinary briefs and reject malformed input before dispatch', async () => {
  const f = fixture('review-ok');
  const frame = body => `The coordinator sent a message while you were working:\n${body}\n\nAddress this before completing your current task.`;
  const brief = '  Inspect only.\nDUET: this later line remains brief text.\n';
  const literal = fixture('review-ok');
  const initial = frame(`DUET: --sandbox read-only --effort low\n${brief}`);
  assert.equal((await literal.turn(initial, 1, false, appendRenderPrompt(literal, initial))).status, 'completed');
  assert.equal(literal.jobs()[0].request.prompt, initial);
  const initialTask = literal.capture.processes.find(p => p.kind === 'spawn' && p.request.argv[2] === 'task');
  assert.equal(initialTask.request.input, initial);
  assert.equal(initialTask.request.argv.includes('--sandbox'), false);
  assert.equal(initialTask.request.argv.includes('--effort'), false);
  assert.ok(renderLeaves(await renderNativePrompt(literal, initial)).includes('DUET: --sandbox read-only --effort low'));
  const text = ` \tDUET:\t--sandbox danger-full-access --effort xhigh --model gpt-6-sol --fast --max-minutes 5 --max-tokens=1000\r\n${brief}`;
  assert.equal((await f.turn(text, 1, false, appendRenderPrompt(f, text))).status, 'completed');
  const first = f.jobs()[0];
  assert.equal(first.budget.maxMinutes, 5);
  assert.equal(first.budget.maxTokens, 1000);
  assert.deepEqual(Object.fromEntries(['sandbox', 'effort', 'model', 'serviceTier', 'prompt'].map(key => [key, first.request[key]])),
    { sandbox: 'danger-full-access', effort: 'xhigh', model: 'gpt-6-sol', serviceTier: 'priority', prompt: brief });
  assert.ok(renderLeaves(await renderNativePrompt(f, text)).includes('Inspect only.'));
  const followup = await f.turn(frame(`DUET: --sandbox read-only --effort low\n${brief}`), 2);
  assert.equal(followup.status, 'completed');
  const continued = f.jobs().find(job => job.id === followup.jobId);
  assert.equal(continued.threadId, first.threadId);
  assert.deepEqual(Object.fromEntries(['sandbox', 'effort', 'prompt'].map(key => [key, continued.request[key]])),
    { sandbox: 'read-only', effort: 'low', prompt: brief });
  assert.equal(f.capture.processes.filter(p => p.kind === 'spawn' && p.request.argv[2] === 'task').at(-1).request.input, brief);
  const ordinary = "Fugato's native adapter needs review.\nDUET:--sandbox read-only\n";
  assert.equal((await f.turn(ordinary, 3)).status, 'completed');
  assert.equal(f.jobs().find(job => job.request.prompt === ordinary).request.prompt, ordinary);
  // Neither half of the known framing is sufficient to strip user text.
  const prefixOnly = frame(brief).slice(0, -1);
  const suffixOnly = frame(brief).slice(1);
  const partialPrefix = await f.turn(prefixOnly, 4);
  const partialSuffix = await f.turn(suffixOnly, 5);
  assert.equal(f.jobs().find(job => job.id === partialPrefix.jobId).request.prompt, prefixOnly);
  assert.equal(f.jobs().find(job => job.id === partialSuffix.jobId).request.prompt, suffixOnly);

  const approval = fixture('computer-use-requests');
  const asked = await approval.turn('Ask for the fixture app approval.', 1);
  assert.equal(asked.status, 'needs_answer');
  assert.ok(asked.question.options.includes('Allow this call'));
  const answered = await approval.turn(frame('Allow this call'), 2);
  assert.equal(answered.status, 'completed');
  assert.equal(answered.jobId, asked.jobId);
  const submitted = approval.capture.processes.find(p => p.request.argv[2] === 'answer');
  assert.equal(submitted.request.input, 'Allow this call');
  assert.equal(approval.codexState().serverRequestReplies[0].result.action, 'accept');

  const invalid = fixture('review-ok', 'native-worker', { hostOnly: true });
  for (const [index, header] of ['DUET:--sandbox read-only', 'duet: --fast', 'DUET :',
    'DUET: "unterminated', 'DUET: --source /tmp/session.jsonl'].entries()) {
    assert.equal((await invalid.turn(`${header}\nNever dispatch.`, index + 1)).status, 'blocked');
    assert.equal(invalid.jobs().length, 0);
    assert.equal(invalid.capture.processes.filter(p => p.request.argv[2] === 'task').length, 0);
  }
});

test('a missing fork transcript can recover through SessionStart', async () => {
  const f = fixture('review-ok');
  assert.equal((await f.turn('DUET: --fork\nUse the current conversation.', 1)).status, 'blocked');
  assert.equal(f.jobs().length, 0);
  const source = `${f.root}/home/.claude/projects/-repo/native-session.jsonl`;
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, JSON.stringify({ type: 'user', message: { content: 'Fixture context.' } }) + '\n');
  const started = spawnSync(process.execPath, [plugin + '/scripts/session-lifecycle-hook.mjs', 'SessionStart'], {
    cwd: `${f.root}/repo`, env: f.env, encoding: 'utf8',
    input: JSON.stringify({ session_id: 'native-session', transcript_path: source, cwd: `${f.root}/repo`, source: 'startup' }),
  });
  assert.equal(started.status, 0, started.stderr);
  assert.equal((await f.turn('DUET: --fork\nUse the available context.', 2)).status, 'completed');
  assert.equal(f.jobs()[0].request.forked, true);
});

test('native DUET fork tail-caps a compacted SessionStart transcript without a transcript environment variable', async t => {
  const f = fixture('review-ok'), budgetBytes = 4096;
  f.env.CODEX_COMPANION_FORK_BUDGET_BYTES = String(budgetBytes);
  const source = `${f.root}/home/.claude/projects/-repo/native-session.jsonl`;
  fs.mkdirSync(path.dirname(source), { recursive: true });
  const row = (type, uuid, parentUuid, extra = {}) => ({ type, uuid, parentUuid,
    sessionId: 'native-session', cwd: `${f.root}/repo`, ...extra });
  const entries = [row('user', 'before', null, { message: { content: 'PRE_BOUNDARY_NATIVE_TEXT' } }),
    row('system', 'boundary', null, { subtype: 'compact_boundary', logicalParentUuid: 'before' }),
    row('attachment', 'attachment', 'boundary'),
    row('user', 'summary', 'attachment', { isCompactSummary: true, message: { content: 'Native compact summary' } })];
  for (let index = 0; index < 60; index++) entries.push(row('user', `turn-${index}`, index ? `turn-${index - 1}` : 'summary',
    { message: { content: `Older turn ${index}: ${'x'.repeat(512)}` } }));
  entries.push(row('user', 'newest', 'turn-59', { message: { content: 'NEWEST_NATIVE_FACT' } }));
  const contents = entries.map(entry => JSON.stringify(entry)).join('\n') + '\n';
  fs.writeFileSync(source, contents);
  const started = spawnSync(process.execPath, [plugin + '/scripts/session-lifecycle-hook.mjs', 'SessionStart'], {
    cwd: `${f.root}/repo`, env: { ...f.env, CLAUDE_ENV_FILE: `${f.root}/claude-env` }, encoding: 'utf8',
    input: JSON.stringify({ session_id: 'native-session', transcript_path: source, cwd: `${f.root}/repo`, source: 'startup' }),
  });
  assert.equal(started.status, 0, started.stderr);
  assert.equal(f.env.CODEX_COMPANION_TRANSCRIPT_PATH, undefined);
  const result = await f.turn('DUET: --fork\nUse the newest fact from the compacted conversation.', 1);
  assert.equal(result.status, 'completed', result.summary);
  const job = f.jobs().find(job => job.id === result.jobId), meta = job.request.forkSlice;
  assert.equal(meta.fromCompactBoundary, true);
  assert.equal(meta.tailCapped, true);
  assert.ok(meta.slicedBytes <= budgetBytes);
  assert.equal(meta.sourceBytes, Buffer.byteLength(contents));
  assert.equal(job.request.forkSourceSha256, createHash('sha256').update(contents).digest('hex'));
  const messages = f.codexState().lastExternalAgentImport.messages.map(message => message.text);
  assert.equal(messages[0], 'Native compact summary');
  assert.equal(messages.at(-1), 'NEWEST_NATIVE_FACT');
  assert.ok(!messages.includes('PRE_BOUNDARY_NATIVE_TEXT'));
  assert.equal(f.env.CODEX_COMPANION_TRANSCRIPT_PATH, undefined);
  t.diagnostic(JSON.stringify(meta));
  // This additional integration assertion does not add a replay scenario;
  // keep the existing eight-capture hook replay suite intact.
});

test('DUET first-line flags and fork carry captured instructions to the imported thread; invalid flags dispatch nothing', async t => {
  const f = fixture('review-ok');
  const cwd = `${f.root}/work tree`;
  fs.mkdirSync(cwd); initGitRepo(cwd);
  const source = `${f.root}/home/.claude/projects/-repo/native-session.jsonl`;
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, JSON.stringify({ type: 'user', message: { content: 'Synthetic prior request.' } }) + '\n');
  // SessionStart writes Bash's env file, but the native host keeps its original
  // environment. Do not source that file into the adapter or its companion.
  const envFile = `${f.root}/claude-env`;
  const started = spawnSync(process.execPath, [plugin + '/scripts/session-lifecycle-hook.mjs', 'SessionStart'], {
    cwd: `${f.root}/repo`, env: { ...f.env, CLAUDE_ENV_FILE: envFile }, encoding: 'utf8',
    input: JSON.stringify({ session_id: 'native-session', transcript_path: source, cwd: `${f.root}/repo`, source: 'startup' }),
  });
  assert.equal(started.status, 0, started.stderr);
  assert.ok(fs.readFileSync(envFile, 'utf8').includes('CODEX_COMPANION_TRANSCRIPT_PATH'));
  assert.equal(f.env.CODEX_COMPANION_TRANSCRIPT_PATH, undefined);
  const files = [{ path: '/captured/CLAUDE.md', kind: 'project', content: 'FORK_RULE_SENTINEL' }];
  const snapshot = writeClaudeSnapshot({ sessionId: 'native-session', cwd: `${f.root}/repo`, ...instructionInventory(files) }, f.env);
  const brief = '  Preserve leading space.\nDUET: this second line is brief text.\n';
  const result = await f.turn(`DUET: --fork --model gpt-6-sol --effort high --sandbox read-only --fast --cwd "${cwd}"\n${brief}`, 1);
  assert.equal(result.status, 'completed', result.summary);
  assert.equal(f.codexState().threads[0].cwd, cwd);
  const dispatch = f.capture.processes.find(p => p.kind === 'spawn' && p.request.argv[2] === 'task').request;
  assert.equal(dispatch.input, brief);
  assert.equal(dispatch.argv[dispatch.argv.indexOf('--session-cwd') + 1], `${f.root}/repo`);
  assert.equal(dispatch.argv[dispatch.argv.indexOf('--cwd') + 1], cwd);
  const job = JSON.parse(spawnSync(process.execPath, [plugin + '/bin/fugato', 'status', result.jobId, '--json', '--cwd', cwd,
    '--session', 'native-session'], { env: f.env, encoding: 'utf8' }).stdout).job;
  assert.equal(job.request.model, 'gpt-6-sol'); assert.equal(job.request.effort, 'high');
  assert.equal(job.request.sandbox, 'read-only'); assert.equal(job.request.serviceTier, 'priority');
  assert.equal(job.request.prompt, brief);
  const runtime = f.codexState(), imported = runtime.lastExternalAgentImport;
  assert.deepEqual(runtime.threads[0].visibleMessages.map(message => message.text), ['Synthetic prior request.']);
  const instructions = EXECUTOR_FRAMING + '\n\n### /captured/CLAUDE.md\nFORK_RULE_SENTINEL';
  assert.equal(job.request.forked, true);
  assert.equal(job.request.forkSlice.fromCompactBoundary, false);
  assert.equal(job.request.forkSlice.sourceBytes, fs.statSync(source).size);
  assert.ok(job.request.forkSlice.slicedBytes <= 2 * 1024 * 1024);
  assert.equal(job.request.forkImportId, imported.importId);
  assert.equal(job.request.threadId, imported.threadId);
  assert.equal(runtime.lastThreadResume.threadId, imported.threadId);
  assert.equal(runtime.lastTurnStart.threadId, imported.threadId);
  assert.equal(job.request.claudeMd.snapshotHash, snapshot.hash);
  assert.equal(job.request.claudeMd.sessionCwd, `${f.root}/repo`);
  assert.equal(job.request.developerInstructions, instructions);
  assert.equal(runtime.lastThreadResume.developerInstructions, instructions);
  assert.ok(!runtime.lastTurnStart.prompt.includes('FORK_RULE_SENTINEL'));
  const final = f.capture.processes.filter(p => p.kind === 'spawn' && ['task', 'wait'].includes(p.request.argv[2])).at(-1);
  const report = JSON.parse(final.chunks.filter(c => c.stream === 'stdout').map(c => c.text).join('').trim().split('\n').at(-1));
  assert.ok(isC2Report(report)); assert.ok(isC2Report(result));
  assert.deepEqual(result, { ...report, next: 'SendMessage to native-worker to continue' });
  t.diagnostic(JSON.stringify({ header: 'DUET: --fork', command: 'fugato task --fork', status: result.status,
    importId: imported.importId, importedThread: imported.threadId, resumedThread: runtime.lastThreadResume.threadId,
    turnThread: runtime.lastTurnStart.threadId, claudeMdSource: job.request.claudeMd.source,
    developerInstructions: runtime.lastThreadResume.developerInstructions, nativeReportMatchesC2: true }));
  f.save();

  const invalid = fixture('review-ok');
  const rejected = await invalid.turn('DUET: --approve-browser-origin https://example.test\nNever dispatch.', 1, false, { effort: 'high' });
  assert.equal(rejected.status, 'blocked');
  assert.deepEqual(invalid.capture.processes.map(p => p.request.argv[2]), ['process.execPath', 'reserve-name']);

  const tasks = () => invalid.capture.processes.filter(p => p.kind === 'spawn' && p.request.argv[2] === 'task');
  const setting = (request, flag) => request.argv[request.argv.indexOf(flag) + 1];
  const badSandbox = await invalid.turn('DUET: --sandbox invalid\nReject before reserving a job.', 2);
  assert.equal(badSandbox.status, 'blocked');
  assert.equal(invalid.jobs().length, 0);
  invalid.reload();
  const corrected = await invalid.turn('Corrected foreground plan.', 3, false, { background: false, permissionMode: 'plan' });
  assert.equal(corrected.status, 'completed');
  assert.equal(setting(tasks().at(-1).request, '--sandbox'), 'read-only');
  assert.equal(setting(tasks().at(-1).request, '--effort'), 'high');
  assert.equal(invalid.jobs()[0].request.effort, 'high');
  const foreground = invalid.capture.events.filter(e => e.event === 'turn.step').at(-1);
  assert.ok(foreground.chunks.some(c => c.kind === 'thinking'));
  assert.deepEqual(JSON.parse(foreground.result.answer), corrected);
  assert.equal(/^background:\s*true$/m.test(fs.readFileSync(plugin + '/agents/codex-native.md', 'utf8')), false);

  assert.equal((await invalid.turn('DUET: --fork\nReject a fork continuation.', 4)).status, 'blocked');
  assert.equal(invalid.jobs().length, 1);
  invalid.reload();
  const continued = await invalid.turn('DUET: --sandbox workspace-write\nContinue outside plan mode.', 5);
  assert.equal(continued.status, 'completed');
  const continuedJob = invalid.jobs().find(job => job.id === continued.jobId);
  assert.equal(continuedJob.request.threadId, invalid.jobs().find(job => job.id === corrected.jobId).threadId);
  assert.equal(continuedJob.request.sandbox, 'workspace-write');
  assert.equal(continuedJob.request.effort, 'high');
  assert.equal(tasks().at(-1).request.argv.includes('--effort'), false);
  for (const [number, sandbox] of [[6, 'danger-full-access'], [7, 'workspace-write']]) {
    const count = tasks().length;
    const refused = await invalid.turn(`DUET: --sandbox ${sandbox}\nPlan cannot write.`, number, false, { permissionMode: 'plan' });
    assert.equal(refused.status, 'blocked');
    assert.equal(refused.blockers[0].code, 'native_plan_mode_read_only');
    assert.equal(tasks().length, count);
    assert.equal(invalid.jobs().length, 2);
  }
  const usage = { inputTokens: 12345, cachedInputTokens: 8000, outputTokens: 678, reasoningOutputTokens: 12, totalTokens: 13023 };
  invalid.withUsage(usage);
  const noticeCount = invalid.capture.notices.length;
  const planned = await invalid.turn('DUET: --effort low\nContinue planning.', 8, false, { permissionMode: 'plan', effort: 'high' });
  assert.equal(planned.status, 'completed');
  assert.equal(setting(tasks().at(-1).request, '--sandbox'), 'read-only');
  assert.equal(setting(tasks().at(-1).request, '--effort'), 'low');
  assert.equal(invalid.jobs().find(job => job.id === planned.jobId).request.effort, 'low');
  assert.deepEqual(planned.usage, usage);
  const notices = invalid.capture.notices.slice(noticeCount).filter(n => n.message.content[0].text.includes('12,345'));
  assert.equal(notices.length, 1);
  assert.ok(notices[0].message.content[0].text.includes('8,000'));
  assert.ok(notices[0].message.content[0].text.includes('678'));
  assert.ok(notices[0].message.content[0].text.includes('13,023 total'));
  assert.ok(notices[0].message.content[0].text.startsWith('Codex tokens (provider: OpenAI Codex, model gpt-6-astra)'));
  const { value: activity } = await invalid.$.state.get({ plugin: 'fugato', key: 'nativeAgents' });
  assert.equal(activity['native-agent'].jobId, planned.jobId);
  assert.equal(activity['native-agent'].threadId, continuedJob.threadId);
  assert.equal(activity['native-agent'].workspace, `${invalid.root}/repo`);

  // Availability failure is a structured pre-reservation rejection too; its
  // wording is deliberately unrelated to invalid DUET flags.
  invalid.withUsage(undefined);
  const executable = invalid.env.CODEX_COMPANION_BIN, jobCount = invalid.jobs().length;
  invalid.env.CODEX_COMPANION_BIN = `${invalid.root}/bin/unavailable-codex`;
  const unavailable = await invalid.turn('Dispatch with the fixture binary unavailable.', 9);
  assert.equal(unavailable.status, 'blocked');
  assert.equal(invalid.jobs().length, jobCount);
  const failed = tasks().at(-1);
  assert.ok(Number.isInteger(failed.exit.code) && failed.exit.code !== 0);
  const failure = JSON.parse(failed.chunks.filter(c => c.stream === 'stdout').map(c => c.text).join('').trim().split('\n').at(-1));
  assert.equal(failure.status, 'error');
  assert.equal(failure.jobId, null);
  invalid.env.CODEX_COMPANION_BIN = executable;
  invalid.reload();
  assert.equal((await invalid.turn('Retry after restoring the fixture binary.', 10)).status, 'completed');
  assert.equal(invalid.jobs().length, jobCount + 1);
  invalid.save();

  // Explicit effort is separate from the shell's effective low. Headers win;
  // max passes through; absence leaves the companion's default untouched.
  for (const [effort, header, expected] of [['max', '', 'max']]) {
    const effortFixture = fixture('review-ok');
    const completed = await effortFixture.turn(header + 'Check effort precedence.', 1, false, { effort, background: false });
    assert.equal(completed.status, 'completed');
    assert.equal(effortFixture.jobs()[0].request.effort, expected);
    const request = effortFixture.capture.processes.find(p => p.request.argv[2] === 'task').request;
    if (!effort) assert.equal(request.argv.includes('--effort'), false);
    else assert.equal(setting(request, '--effort'), expected);
  }
  const symlinked = fixture('review-ok');
  fs.symlinkSync(`${symlinked.root}/repo`, `${symlinked.root}/linked`);
  symlinked.$.session.cwd = async () => `${symlinked.root}/linked`;
  assert.equal((await symlinked.turn('Start in a symlinked workspace.', 1)).status, 'completed');
  symlinked.reload();
  assert.equal((await symlinked.turn('DUET: --cwd .\nContinue in the same workspace.', 2)).status, 'completed');
  assert.equal(Object.values(symlinked.readStore()).find(s => s.agentId === 'native-agent').cwd, `${symlinked.root}/repo`);
  assert.equal(symlinked.codexState().threads.length, 1);

  const planFirst = fixture('review-ok');
  const planBlocked = await planFirst.turn('DUET: --sandbox danger-full-access\nReject writable first launch.', 1, false, { permissionMode: 'plan' });
  assert.equal(planBlocked.blockers[0].code, 'native_plan_mode_read_only');
  assert.equal(planFirst.jobs().length, 0);
  assert.equal(planFirst.capture.processes.length, 0);
  planFirst.reload();
  assert.equal((await planFirst.turn('Corrected first plan.', 2, false, { permissionMode: 'plan' })).status, 'completed');
  assert.equal(planFirst.jobs()[0].request.sandbox, 'read-only');

  // Opt-in permission mapping captures host context before parsing --cwd,
  // reapplies on resume, and refuses an already-live turn under a new mode.
  const enableMapping = f => {
    const setup = spawnSync(process.execPath, [plugin + '/scripts/codex-companion.mjs', 'setup', '--permission-mapping', 'claude', '--json'],
      { cwd: `${f.root}/repo`, env: f.env, encoding: 'utf8' });
    assert.equal(setup.status, 0, setup.stderr);
  };
  const mapped = fixture('review-ok'); enableMapping(mapped);
  assert.equal((await mapped.turn('DUET: --sandbox danger-full-access\nMapped default.', 1)).status, 'completed');
  assert.equal(mapped.codexState().lastTurnStart.sandboxPolicy.type, 'workspaceWrite');
  assert.equal(mapped.codexState().lastTurnStart.approvalPolicy, 'untrusted');
  mapped.reload();
  assert.equal((await mapped.turn('Resume with read-only permissions.', 2, false, { permissionMode: 'plan' })).status, 'completed');
  assert.equal(mapped.codexState().lastTurnStart.sandboxPolicy.type, 'readOnly');
  assert.equal(mapped.codexState().lastTurnStart.approvalPolicy, 'never');
  const confined = fixture('review-ok'); enableMapping(confined);
  const isolated = `${confined.root}/repo/.claude/worktrees/fixture`;
  fs.mkdirSync(isolated, { recursive: true }); confined.$.session.cwd = async () => isolated;
  const outside = await confined.turn(`DUET: --cwd "${confined.root}/repo"\nCannot leave the worktree.`, 1);
  assert.equal(outside.status, 'blocked');
  assert.equal(confined.jobs().length, 0);
  const liveMapped = fixture('parent-question-sequence'); enableMapping(liveMapped);
  assert.equal((await liveMapped.turn('Park at a parent question.', 1)).status, 'needs_answer');
  liveMapped.reload();
  const tightened = await liveMapped.turn('Do not answer under a wider live policy.', 2, false, { permissionMode: 'auto' });
  assert.equal(tightened.blockers[0].code, 'native_permission_mode_changed');
  assert.equal(liveMapped.capture.processes.filter(p => p.request.argv[2] === 'answer').length, 0);
  assert.ok(liveMapped.jobs()[0].cancelRequested);

  // The host can continue a spawned agent after the hook's binding write fails.
  // Memory recovers mode/effort; a reload with only the failure guard blocks.
  for (const [header, resume, reload] of [
    ['DUET: --sandbox workspace-write\n', false, false], ['', false, false],
    ['DUET: --sandbox workspace-write\n', true, false], ['', true, true],
  ]) {
    const binding = fixture('review-ok');
    if (resume) assert.equal((await binding.turn('First run outside plan mode.', 1)).status, 'completed');
    const count = binding.jobs().length, set = binding.$.store.set;
    let injected = false;
    binding.$.store.set = async (key, value) => {
      if (!injected && key.startsWith('native:v2:') && value.permissionMode === 'plan') {
        injected = true;
        throw new Error('Injected plan binding failure');
      }
      return set(key, value);
    };
    const report = await binding.turn(header + 'Recover the plan binding.', resume ? 2 : 1, false, {
      permissionMode: 'plan', effort: 'high',
      afterSpawn: reload ? () => binding.reload() : undefined,
    });
    // agent.spawn no longer writes the plan binding; a reload before turn.start
    // leaves only the guard, so no plan-state write happens to fail.
    assert.equal(injected, !reload);
    if (header || reload) {
      assert.equal(report.status, 'blocked');
      assert.equal(report.blockers[0].code, reload ? 'native_binding_unavailable' : 'native_plan_mode_read_only');
      assert.equal(binding.jobs().length, count);
      assert.equal(binding.capture.processes.filter(p => p.request.argv[2] === 'task').length, count);
    } else {
      assert.equal(report.status, 'completed');
      const job = binding.jobs().find(job => job.id === report.jobId);
      assert.equal(job.request.sandbox, 'read-only');
      assert.equal(job.request.effort, 'high');
    }
  }

  // A reload can lose discovery and every in-memory binding before start.
  const guardOnly = fixture('review-ok'), storeCalls = [];
  let hostReturned = false, guardModelCalls = 0;
  for (const method of ['get', 'set', 'keys', 'delete']) {
    const original = guardOnly.$.store[method];
    guardOnly.$.store[method] = async (...args) => {
      storeCalls.push({ method, afterHost: hostReturned });
      return original(...args);
    };
  }
  await guardOnly.invoke('agent.spawn', { subagentType: AGENT_TYPE, tool_use_id: 'guard-only',
    name: 'guard-only', permissionMode: 'plan', prompt: 'Never reach a model.' }, async () => {
    hostReturned = true; return { agentId: 'native-agent' };
  });
  assert.deepEqual(storeCalls, [{ method: 'set', afterHost: true }]);
  const guard = guardOnly.readStore()['native:binding-failed:v1:native-session:native-agent'];
  guardOnly.reload();
  guardOnly.$.agent.list = async () => { throw new Error('Discovery unavailable'); };
  const guarded = await guardOnly.invoke('turn.step', { agentId: 'native-agent', turnId: 'guard-only', index: 0 }, async function* () {
    guardModelCalls++;
    const answer = JSON.stringify({ status: 'completed' });
    yield { kind: 'text', index: 0, text: answer };
    yield { kind: 'stop', stopReason: 'end_turn', usage: null };
    return { answer, usage: null };
  });
  const guardEvidence = { code: JSON.parse(guarded.answer).blockers?.[0]?.code ?? null,
    modelCalls: guardModelCalls, processCalls: guardOnly.capture.processes.length, timestamp: typeof guard.at };
  t.diagnostic(JSON.stringify({ finding3: guardEvidence }));
  assert.deepEqual(guardEvidence, { code: 'native_binding_unavailable', modelCalls: 0, processCalls: 0, timestamp: 'number' });

  // Every native-state binding write can fail. A separate guard protects an
  // existing writable question after reload; missing new state also blocks.
  for (const resumed of [false, true]) {
    const lost = fixture('parent-question-sequence');
    if (resumed) assert.equal((await lost.turn('Ask outside plan mode.', 1)).status, 'needs_answer');
    const set = lost.$.store.set, count = lost.jobs().length;
    lost.$.store.set = async (key, value) => {
      if (key.startsWith('native:v2:')) throw new Error('Binding writes unavailable');
      return set(key, value);
    };
    const report = await lost.turn('Small', resumed ? 2 : 1, false, { permissionMode: 'plan',
      afterSpawn: () => { lost.$.store.set = set; lost.reload(); } });
    assert.equal(report.blockers[0].code, 'native_binding_unavailable');
    assert.equal(lost.jobs().length, count);
    assert.equal(lost.capture.processes.filter(p => p.request.argv[2] === 'answer').length, 0);
  }

  for (const fault of ['node', 'spawn', 'intent']) {
    const rejected = fixture('review-ok'), run = rejected.$.process.run, spawn = rejected.$.process.spawn, set = rejected.$.store.set;
    let injected = false;
    const fail = () => { injected = true; throw new Error('Definitive pre-launch failure'); };
    if (fault === 'node') rejected.$.process.run = async (argv, init) => !injected && argv[1] === '-p' ? fail() : run(argv, init);
    if (fault === 'spawn') rejected.$.process.spawn = request => !injected && request.argv[2] === 'task' ? fail() : spawn(request);
    if (fault === 'intent') rejected.$.store.set = async (key, value) => !injected && value.intent ? fail() : set(key, value);
    assert.equal((await rejected.turn('Fail before launching.', 1)).status, 'blocked');
    assert.equal(injected, true);
    assert.equal(rejected.jobs().length, 0);
    rejected.reload();
    assert.equal((await rejected.turn('Corrected assignment.', 2)).status, 'completed');
    assert.equal(rejected.jobs().length, 1);
  }

  const terminal = fixture('lost-turn:failed'), terminalSet = terminal.$.store.set;
  let terminalFailed = false;
  terminal.$.store.set = async (key, value) => {
    if (!terminalFailed && value.answer) { terminalFailed = true; throw new Error('Failed terminal final save'); }
    return terminalSet(key, value);
  };
  const failedReport = await terminal.turn('Fail the exact fake turn.', 1);
  const terminalTask = terminal.capture.processes.find(p => p.kind === 'spawn' && p.request.argv[2] === 'task');
  const companionReport = JSON.parse(terminalTask.chunks.filter(c => c.stream === 'stdout').map(c => c.text).join('').trim().split('\n').at(-1));
  assert.deepEqual(failedReport, { ...companionReport, next: `SendMessage to ${companionReport.worker} to continue` });
  assert.equal(terminalFailed, true);
  terminal.reload();
  assert.equal((await terminal.turn('Continue after the confirmed failure.', 2)).status, 'completed');

  const completed = fixture('review-ok'), completedSet = completed.$.store.set;
  let completedFailed = false;
  completed.$.store.set = async (key, value) => {
    if (value.answer?.status === 'completed') {
      completedFailed = true;
      throw new Error('Completed report cache unavailable');
    }
    return completedSet(key, value);
  };
  const completedReport = await completed.turn('Complete despite a failed final cache write.', 1);
  assert.equal(completedFailed, true);
  assert.equal(completedReport.status, 'completed');
  assert.equal(completedReport.worker, completed.jobs()[0].agentName);
  assert.equal(completedReport.jobId, completed.jobs()[0].id);

  const handleCache = fixture('review-ok'), handleSet = handleCache.$.store.set;
  let handleFailed = false;
  handleCache.$.store.set = async (key, value) => {
    const emitted = handleCache.capture.processes.some(p => p.kind === 'spawn' && p.request.argv[2] === 'task' && p.exit
      && p.chunks.some(c => c.stream === 'stdout' && c.text.includes('"status":"completed"')));
    if (emitted && key.startsWith('native:v2:') && value.status === 'completed' && !value.answer) {
      handleFailed = true;
      throw new Error('Completed handle cache unavailable');
    }
    return handleSet(key, value);
  };
  const handleReport = await handleCache.turn('Complete despite a failed handle-cache write.', 1);
  const handleJob = handleCache.jobs()[0];
  assert.equal(handleFailed, true);
  assert.equal(handleJob.status, 'completed');
  assert.ok(handleJob.reportEmittedAt);
  assert.equal(handleReport.status, 'completed');
  assert.equal(handleReport.worker, handleJob.agentName);
  assert.equal(handleReport.jobId, handleJob.id);

  const overlap = fixture('review-ok'), now = overlap.$.clock.now;
  let release, entered, paused = false;
  const gate = new Promise(resolve => { release = resolve; });
  const atGate = new Promise(resolve => { entered = resolve; });
  overlap.$.clock.now = async () => {
    if (!paused && overlap.capture.events.at(-1)?.event === 'turn.step') {
      paused = true; entered(); await gate;
    }
    return now();
  };
  const firstTurn = overlap.turn('First overlapping assignment.', 1);
  await atGate;
  try { assert.equal((await overlap.turn('Second overlapping assignment.', 2)).status, 'blocked'); }
  finally { release(); }
  assert.equal((await firstTurn).status, 'completed');
  assert.equal(overlap.jobs().length, 1);
  assert.equal(overlap.codexState().threads.length, 1);

  // Model the companion's full-index nonce API, with an empty visible history.
  // Existing real-companion cases exercise the older CLI's flag fallback.
  const history = fixture('review-ok');
  const historical = await history.turn('Create the retained native job.', 1);
  const data = history.readStore(), oldState = Object.values(data).find(s => s.agentId === 'native-agent');
  for (const key of ['answer', 'answeredTurn', 'jobId', 'threadId', 'ownerId', 'worker', 'status', 'questionId', 'finishedAt']) delete oldState[key];
  history.setStore(data); history.reload();
  const indexedJobs = [history.jobs()[0], ...Array.from({ length: 50 }, (_, i) => ({
    ...history.jobs()[0], id: `newer-${i}`, dispatchNonce: null,
  }))];
  assert.equal(indexedJobs.length, 51);
  assert.equal(indexedJobs.slice(-50).some(job => job.id === historical.jobId), false);
  const lookupRun = history.$.process.run;
  let fullLookup = false;
  history.$.process.run = async (argv, init) => {
    if (argv[2] !== 'status' || !argv.includes('--all')) return lookupRun(argv, init);
    const nonce = argv[argv.indexOf('--dispatch-nonce') + 1];
    fullLookup = argv.includes('--dispatch-nonce');
    // Status now uses the bounded run path for the new dispatch too. Keep
    // those new jobs in the simulated full index, beyond its retained history.
    const jobs = [...indexedJobs, ...history.jobs().filter(job => !indexedJobs.some(indexed => indexed.id === job.id))];
    return { exitCode: 0, stdout: JSON.stringify({ running: [], latestFinished: null,
      recent: fullLookup ? jobs.filter(job => job.dispatchNonce === nonce) : indexedJobs.slice(-50) }), isStdoutTruncated: false };
  };
  const recovered = await history.turn('Continue beyond visible history.', 2);
  assert.equal(fullLookup, true);
  assert.equal(recovered.status, 'completed');
  assert.equal(history.jobs().find(job => job.id === recovered.jobId).threadId,
    history.jobs().find(job => job.id === historical.jobId).threadId);

  const outage = fixture('review-ok');
  await outage.invoke('classic.SubagentStart', { session_id: 'native-session', agent_id: 'native-agent', agent_type: AGENT_TYPE }, async () => ({}));
  outage.reload();
  outage.$.agent.list = async () => { throw new Error('Discovery unavailable'); };
  outage.$.store.get = async () => { throw new Error('Store unavailable'); };
  const stopped = await outage.invoke('turn.step', { agentId: 'native-agent', turnId: 'outage', index: 0 }, async function* () {
    assert.fail('An unavailable native guard must not reach the model');
  });
  assert.equal(JSON.parse(stopped.answer).status, 'blocked');
  assert.equal(outage.capture.processes.length, 0);

  // A complete-looking empty response establishes absence only on exit 0.
  for (const exitCode of [1, null, 0]) {
    const lookup = fixture('review-ok'), run = lookup.$.process.run;
    lookup.$.process.run = async (argv, init) => argv[2] === 'status' && !lookup.jobs().length
      ? { exitCode, stdout: JSON.stringify({ running: [], recent: [], latestFinished: null }), isStdoutTruncated: false }
      : run(argv, init);
    assert.equal((await lookup.turn('DUET: --sandbox invalid\nReject before reservation.', 1)).status, 'blocked');
    const state = Object.values(lookup.readStore()).find(s => s.agentId === 'native-agent');
    assert.equal(state.answeredTurn === 'turn-1', exitCode === 0);
    const retry = await lookup.turn('Corrected assignment after lookup.', 2);
    assert.equal(retry.status, exitCode === 0 ? 'completed' : 'blocked');
    assert.equal(lookup.capture.processes.filter(p => p.request.argv[2] === 'task').length, exitCode === 0 ? 2 : 1);
    assert.equal(lookup.jobs().length, exitCode === 0 ? 1 : 0);
  }

  // A validation error is insufficient when nonce reconciliation is unavailable
  // or says a matching job may exist. Neither case can admit a replacement.
  for (const ambiguous of [false, true]) {
    const uncertain = fixture('review-ok'), run = uncertain.$.process.run;
    uncertain.$.process.run = async (argv, init) => {
      if (argv[2] !== 'status') return run(argv, init);
      if (!ambiguous) throw new Error('Fixture reconciliation unavailable');
      const state = Object.values(uncertain.readStore()).find(s => s.agentId === 'native-agent');
      const job = { id: 'ambiguous', sessionId: state.session, dispatchNonce: state.intent.nonce };
      return { exitCode: 0, stdout: JSON.stringify({ running: [job, { ...job, id: 'also-ambiguous' }], latestFinished: null, recent: [] }) };
    };
    assert.equal((await uncertain.turn('DUET: --sandbox invalid\nRejected but lookup unavailable.', 1)).status, 'blocked');
    assert.equal((await uncertain.turn('Do not redispatch an uncertain intent.', 2)).status, 'blocked');
    assert.equal(uncertain.capture.processes.filter(p => p.request.argv[2] === 'task').length, 1);
  }
});

// Deterministic host interleavings: no wall-clock timing or model/runtime turns.
// Keep these beside the retention contract so its before/after evidence covers
// both late binding writers and the shared admission inventory.
async function nativeStability() {
  const key = 'native:v2:native-session:native-agent';
  const guard = id => `native:binding-failed:v1:native-session:${id}`;
  const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
  const start = (f, id, text = 'Retain the binding.', turnId = `turn-${id}`) => f.invoke('turn.start',
    { agentId: id, turnId, text }, async e => ({ turnId: e.turnId }));
  const step = (f, id, turnId) => f.invoke('turn.step', { agentId: id, turnId, index: 0 }, async function* () {
    assert.fail('Native stability probe reached the model');
  }).then(value => JSON.parse(value.answer));
  const spawnAgent = (f, id) => f.invoke('agent.spawn', { subagentType: AGENT_TYPE,
    tool_use_id: `spawn-${id}`, permissionMode: 'default', name: id }, async () => ({ agentId: id }));
  const host = () => {
    const f = fixture('review-ok', 'native-worker', { memoryStore: true, hostOnly: true }), owner = deferred();
    let job, launches = 0, consumed = 0, closed = 0;
    f.$.agent.list = async () => [{ id: 'native-agent', type: AGENT_TYPE }];
    f.$.ui = { invalidate() {}, log() {} };
    f.setStore({ [key]: { v: 2, type: AGENT_TYPE, session: 'native-session', agentId: 'native-agent',
      cwd: `${f.root}/repo`, incoming: { turnId: 'turn-1', text: 'First brief.' },
      notices: { turnId: 'turn-1', count: 0, started: true } } });
    f.$.process.run = async argv => argv[0] === 'node' ? { exitCode: 0, stdout: process.execPath }
      : { exitCode: 0, stdout: JSON.stringify(argv[2] === 'result' ? { status: job.status, jobId: job.id } : argv[3] === '--all'
        ? { running: [], recent: [], latestFinished: job } : { job }) };
    f.$.process.spawn = request => {
      const command = request.argv[2];
      const stream = (async function* () {
        if (command === 'task') {
          launches++;
          job = { id: `task-${launches}`, sessionId: 'native-session', status: 'running', ownerId: 'owner',
            threadId: 'thread', dispatchNonce: request.argv[request.argv.indexOf('--dispatch-nonce') + 1] };
          let ended = false;
          try {
            if (f.progressLine) yield { stream: 'stdout', text: '[0] Fixture progress\n' };
            if (launches === 1) await owner.promise;
            job.status = 'completed';
            yield { stream: 'stdout', text: JSON.stringify({ status: 'completed', jobId: job.id }) + '\n' };
            consumed++; ended = true;
          } finally { if (!ended) closed++; }
        } else yield { stream: 'stdout', text: JSON.stringify(request.argv[3] === '--all'
          ? { running: [], recent: [], latestFinished: job } : { job }) + '\n' };
      })();
      return Object.assign(stream, { result: Promise.resolve({ code: 0 }) });
    };
    return { f, owner, evidence: () => ({ launches, consumed, closed }) };
  };
  const races = [];
  for (const mode of ['append', 'append-reload', 'cancel', 'cancel-reload', 'cancel-admitted']) {
    const { f, owner, evidence } = host(), held = deferred(), entered = deferred();
    let pending;
    if (!mode.startsWith('cancel')) {
      f.$.session.append = async () => { entered.resolve(); await held.promise; return {}; };
      pending = step(f, 'native-agent', 'turn-1');
      await until(() => evidence().launches === 1);
      f.$.clock.now = async () => 1800000030000;
      await [...f.timers].find(timer => timer.ms === 30000).fn();
      await entered.promise;
    } else pending = step(f, 'native-agent', 'turn-1');
    owner.resolve();
    const first = await pending;
    let cancellation;
    if (mode === 'cancel-admitted') await start(f, 'native-agent', 'Follow-up survives.', 'turn-2');
    if (mode.startsWith('cancel')) {
      const run = f.$.process.run;
      f.$.process.run = async argv => {
        const result = await run(argv);
        if (argv.includes('--wait')) { entered.resolve(); await held.promise; }
        return result;
      };
      cancellation = f.invoke('turn.complete', { agentId: 'native-agent', turnId: 'turn-1', isAborted: true }, async () => ({}));
      await entered.promise;
    }
    // A fresh module has independent queues; durable turn identity must still
    // reject an old module's callback after the new admission has committed.
    if (mode.endsWith('-reload')) f.reload(true, (await import(`../hooks/native-agent.mjs?stability=${mode}`)).register);
    if (mode !== 'cancel-admitted') await start(f, 'native-agent', 'Follow-up survives.', 'turn-2');
    const admitted = f.readStore()[key]?.incoming?.text === 'Follow-up survives.';
    const launched = mode === 'cancel-admitted' ? await step(f, 'native-agent', 'turn-2') : null;
    held.resolve();
    if (cancellation) await cancellation;
    await delay(0);
    const incoming = mode === 'cancel-admitted' ? admitted : f.readStore()[key]?.incoming?.text === 'Follow-up survives.';
    const second = launched || await step(f, 'native-agent', 'turn-2');
    races.push({ mode, first: first.status, second: second.status, incoming, launches: evidence().launches,
      currentJob: f.readStore()[key].jobId === second.jobId });
  }
  const failures = [];
  for (const mode of ['deny', 'throw', 'save']) {
    const { f, owner, evidence } = host();
    f.progressLine = true;
    let injected = false, logs = 0;
    f.$.ui.log = () => { logs++; };
    if (mode === 'save') {
      const set = f.$.store.set;
      f.$.store.set = async (key, value) => {
        if (!injected && value.notices?.count === 1) { injected = true; throw new Error('Fixture progress save failure'); }
        return set(key, value);
      };
    } else f.$.session.append = async () => {
      if (injected) return {};
      injected = true;
      if (mode === 'throw') throw new Error('Fixture append failure');
      return { deny: 'Fixture append refusal' };
    };
    owner.resolve();
    const report = await step(f, 'native-agent', 'turn-1');
    failures.push({ mode, status: report.status, injected, logged: logs > 0, ...evidence() });
  }
  const parallel = fixture('review-ok', 'native-worker', { memoryStore: true, hostOnly: true });
  parallel.setStore(Object.fromEntries(Array.from({ length: 127 }, (_, i) => [
    `native:v2:active:${i}`, { v: 2, type: AGENT_TYPE, status: 'running' } ])));
  await Promise.all(['a', 'b'].map(id => spawnAgent(parallel, id)));
  await Promise.all(['a', 'b'].map(id => start(parallel, id)));
  const count = Object.keys(parallel.readStore()).filter(key => key.startsWith('native:v2:')).length;
  const refusedId = ['a', 'b'].find(id => !parallel.readStore()[`native:v2:native-session:${id}`]);
  const refusal = refusedId ? (await step(parallel, refusedId, `turn-${refusedId}`)).blockers[0].code : null;
  // A completed job's slot belongs to its admitted follow-up before step runs.
  {
    const { f, owner } = host(); owner.resolve();
    await step(f, 'native-agent', 'turn-1');
    f.setStore({ ...f.readStore(), ...Object.fromEntries(Array.from({ length: 127 }, (_, i) => [
      `native:v2:active:${i}`, { v: 2, type: AGENT_TYPE, status: 'running' } ])) });
    await start(f, 'native-agent', 'Continue the completed worker.', 'turn-2');
    await spawnAgent(f, 'contender'); await start(f, 'contender');
    const incoming = f.readStore()[key]?.incoming?.turnId;
    const contender = await step(f, 'contender', 'turn-contender');
    const followup = await step(f, 'native-agent', 'turn-2');
    assert.deepEqual([incoming, contender.blockers?.[0]?.code, followup.status],
      ['turn-2', 'native_capacity', 'completed']);
  }
  const sized = fixture('review-ok', 'native-worker', { memoryStore: true, hostOnly: true }), set = sized.$.store.set;
  let failedWrites = 0;
  sized.$.store.set = async (key, value) => {
    if (Buffer.byteLength(JSON.stringify({ ...sized.readStore(), [key]: value })) > 4 * 1024 * 1024) {
      failedWrites++; throw new Error('Fixture host store capacity');
    }
    return set(key, value);
  };
  const ids = Array.from({ length: 65 }, (_, i) => `large-${i}`);
  await Promise.all(ids.map(id => spawnAgent(sized, id)));
  await Promise.all(ids.map(id => start(sized, id, 'x'.repeat(65536))));
  const size = Object.entries(sized.readStore()).filter(([key]) => key.startsWith('native:'))
    .reduce((sum, [, value]) => sum + JSON.stringify(value).length * 4, 0);
  const admitted = ids.filter(id => sized.readStore()[`native:v2:native-session:${id}`]);
  const capacityRefusals = (await Promise.all(ids.filter(id => !admitted.includes(id))
    .map(id => step(sized, id, `turn-${id}`)))).filter(report => report.blockers?.[0]?.code === 'native_capacity').length;
  const orphans = fixture('review-ok', 'native-worker', { memoryStore: true, hostOnly: true }), now = await orphans.$.clock.now();
  orphans.setStore({ ...Object.fromEntries(Array.from({ length: 512 }, (_, i) => [guard(`old-${i}`), { at: now - 8 * 86400000 }])),
    [guard('fresh')]: { at: now }, [guard('bound')]: { at: 1 },
    'native:v2:native-session:bound': { v: 2, status: 'running' } });
  await spawnAgent(orphans, 'pending');
  const data = orphans.readStore(); data[guard('pending')].at = 1; orphans.setStore(data);
  await spawnAgent(orphans, 'new'); await start(orphans, 'new');
  const orphanEvidence = { old: Object.keys(orphans.readStore()).filter(key => key.startsWith(guard('old-'))).length,
    fresh: !!orphans.readStore()[guard('fresh')], bound: !!orphans.readStore()[guard('bound')], pending: !!orphans.readStore()[guard('pending')] };
  const live = host();
  const liveStep = step(live.f, 'native-agent', 'turn-1');
  await until(() => live.evidence().launches === 1);
  live.f.setStore({ [guard('native-agent')]: { at: 1 } });
  await spawnAgent(live.f, 'new'); await start(live.f, 'new');
  orphanEvidence.live = !!live.f.readStore()[guard('native-agent')];
  live.owner.resolve(); await liveStep;
  const guardSize = fixture('review-ok', 'native-worker', { memoryStore: true, hostOnly: true });
  guardSize.setStore({ [guard('fresh')]: { at: now, padding: 'x'.repeat(524288) } });
  await spawnAgent(guardSize, 'new'); await start(guardSize, 'new');
  const guardBudget = !guardSize.readStore()['native:v2:native-session:new']
    && (await step(guardSize, 'new', 'turn-new')).blockers[0].code === 'native_capacity';
  // native-1: a stopped predecessor cannot pin its completed continuation.
  {
    const { f, owner } = host(); owner.resolve();
    const first = await step(f, 'native-agent', 'turn-1');
    const marker = { turnId: 'turn-1', at: now }, closed = 'native:closed:v1:native-session:native-agent';
    const state = f.readStore()[key];
    state.cancellation = { jobId: first.jobId, status: 'interrupted', confirmation: 'confirmed' };
    f.setStore({ [key]: state, [closed]: marker });
    await start(f, 'native-agent', 'Continue the stopped worker.', 'turn-2');
    assert.equal((await step(f, 'native-agent', 'turn-2')).status, 'completed');
    assert.equal(f.readStore()[key].cancellation, undefined);
    assert.deepEqual(f.readStore()[closed], marker);
    f.setStore({ ...f.readStore(), ...Object.fromEntries(Array.from({ length: 127 }, (_, i) => [
      `native:v2:protected:${i}`, { v: 2, status: 'running' } ])) });
    await spawnAgent(f, 'replacement'); await start(f, 'replacement');
    assert.equal(f.readStore()[key], undefined);
    assert.equal(f.readStore()['native:v2:native-session:replacement'].incoming.turnId, 'turn-replacement');
  }
  // native-2: the host expires an otherwise never-ending lookup, both while
  // draining owner progress and while delivering its already-completed report.
  for (const progressLine of [false, true]) {
    const { f, owner, evidence } = host(), entered = deferred(), run = f.$.process.run;
    const state = f.readStore()[key]; delete state.notices; f.setStore({ [key]: state });
    f.progressLine = progressLine;
    let held = false, activeLookups = 0, expired;
    f.$.process.run = async (argv, init) => {
      if (argv[2] === 'status') {
        assert.ok(Number.isInteger(init.timeoutMs) && init.timeoutMs > 0 && init.timeoutMs <= 15000);
        if (!held) {
          held = true; activeLookups++;
          return new Promise((resolve, reject) => {
            expired = f.$.clock.after(init.timeoutMs, () => {
              expired.cancel(); activeLookups--; reject(new Error('Fixture status lookup timed out'));
            });
            entered.resolve();
          });
        }
      }
      return run(argv, init);
    };
    const pending = step(f, 'native-agent', 'turn-1');
    await until(() => evidence().launches === 1);
    if (!progressLine) {
      const early = [...f.timers].find(timer => timer.once && timer.ms === 1500);
      f.timers.delete(early); void early.fn();
    }
    await entered.promise; owner.resolve();
    if (!progressLine) await until(() => evidence().consumed === 1);
    const deadline = [...f.timers].find(timer => timer.once && timer.ms === 15000);
    assert.ok(deadline);
    f.timers.delete(deadline); await deadline.fn();
    assert.equal((await pending).status, 'completed');
    assert.deepEqual({ activeLookups, timers: f.timers.size, ...evidence() },
      { activeLookups: 0, timers: 0, launches: 1, consumed: 1, closed: 0 });
  }
  // D1: buffered progress shares one enrichment attempt for the entire flight,
  // even when it fails before spending its budget. Required reads still run.
  for (const timeout of [false, true]) {
    const { f, owner, evidence } = host(), spawn = f.$.process.spawn, run = f.$.process.run;
    const state = f.readStore()[key]; delete state.notices; f.setStore({ [key]: state });
    let now = await f.$.clock.now(), draining = false, enrichmentCalls = 0, requiredCalls = 0;
    f.$.clock.now = async () => now;
    f.$.process.run = async (argv, init) => {
      if (argv[2] === 'status') {
        if (draining) {
          enrichmentCalls++;
          assert.ok(init.timeoutMs > 0 && init.timeoutMs <= 15000);
          if (timeout) now += init.timeoutMs;
          throw new Error('Fixture enrichment failure');
        }
        requiredCalls++;
      }
      return run(argv, init);
    };
    f.$.process.spawn = request => {
      const child = spawn(request);
      if (request.argv[2] !== 'task') return child;
      const stream = (async function* () {
        const output = []; for await (const chunk of child) output.push(chunk);
        draining = true;
        for (let i = 0; i < 5; i++) yield { stream: 'stdout', text: `[0] Buffered progress ${i}\n` };
        for (const chunk of output) yield chunk;
        draining = false;
      })();
      return Object.assign(stream, { result: child.result });
    };
    owner.resolve();
    assert.equal((await step(f, 'native-agent', 'turn-1')).status, 'completed');
    assert.deepEqual({ enrichmentCalls, requiredCalls, timers: f.timers.size, ...evidence() },
      { enrichmentCalls: 1, requiredCalls: 2, timers: 0, launches: 1, consumed: 1, closed: 0 });
  }
  // native-3: cancellation can commit during prune. Rebase and capacity must
  // use that commit, and a final capacity refusal must clear the spawn guard.
  for (const full of [false, true]) {
    const { f, owner } = host(); owner.resolve();
    await step(f, 'native-agent', 'turn-1');
    const state = f.readStore()[key]; state.cancellation = { status: 'unconfirmed' }; f.setStore({ [key]: state });
    const entered = deferred(), release = deferred(), keys = f.$.store.keys, get = f.$.store.get, run = f.$.process.run;
    let pruning = false, held = false;
    f.$.store.keys = async () => { pruning = true; return keys(); };
    f.$.store.get = async name => {
      const value = await get(name);
      if (pruning && !held && name === key) {
        held = true; entered.resolve(); await release.promise;
      }
      return value;
    };
    f.$.process.run = async (argv, init) => {
      const result = await run(argv, init);
      if (argv[2] !== 'status') return result;
      const value = JSON.parse(result.stdout);
      if (value.job) Object.assign(value.job, { status: 'interrupted', interruptionConfirmed: true,
        interruptionReason: full ? 'x'.repeat(524288) : 'owner_stopped' });
      return { ...result, stdout: JSON.stringify(value) };
    };
    await spawnAgent(f, 'native-agent');
    const admission = start(f, 'native-agent', 'Keep the cancellation.', 'turn-2');
    await entered.promise;
    await f.invoke('turn.complete', { agentId: 'native-agent', turnId: 'turn-1', isAborted: true }, async () => ({}));
    const confirmed = f.readStore()[key].cancellation;
    assert.equal(confirmed.confirmation, 'confirmed');
    release.resolve(); await admission;
    assert.deepEqual(f.readStore()[key].cancellation, confirmed);
    assert.equal(f.readStore()[guard('native-agent')], undefined);
    if (full) assert.equal((await step(f, 'native-agent', 'turn-2')).blockers[0].code, 'native_capacity');
    else assert.equal(f.readStore()[key].incoming.turnId, 'turn-2');
  }
  // native-4: a completed spawn observation expires in this same module.
  {
    const f = fixture('review-ok', 'native-worker', { memoryStore: true, hostOnly: true });
    await spawnAgent(f, 'orphan');
    f.$.clock.now = async () => now + 2 * 86400000;
    await spawnAgent(f, 'fresh'); await start(f, 'fresh');
    assert.equal(f.readStore()[guard('orphan')], undefined);
    assert.equal(f.readStore()['native:v2:native-session:orphan'], undefined);
    assert.ok(f.readStore()['native:v2:native-session:fresh']);
  }
  // native-5: parseable JSON without an allowed status never answers the turn.
  for (const status of [undefined, 'not-a-status']) {
    const { f, owner } = host(), spawn = f.$.process.spawn;
    f.$.process.spawn = request => {
      const child = spawn(request);
      if (request.argv[2] !== 'task') return child;
      const stream = (async function* () {
        for await (const chunk of child) yield { ...chunk, text: JSON.stringify({ ...JSON.parse(chunk.text), status }) + '\n' };
      })();
      return Object.assign(stream, { result: child.result });
    };
    owner.resolve();
    const report = await step(f, 'native-agent', 'turn-1');
    assert.equal(report.status, 'blocked');
    assert.equal(report.blockers[0].code, 'native_adapter_error');
    assert.equal(f.readStore()[key].answeredTurn, undefined);
    assert.equal(f.readStore()[key].finishedAt, undefined);
    assert.equal(f.timers.size, 0);
  }
  // D3: known recovery statuses preserve the companion's guidance while the
  // native turn remains unanswered, both on owner output and a late answer.
  for (const status of ['unknown', 'unreachable']) for (const lateAnswer of [false, true]) {
    const { f, owner } = host(); owner.resolve();
    let turnId = 'turn-1', answeredTurn;
    if (lateAnswer) {
      await step(f, 'native-agent', turnId);
      const state = f.readStore()[key]; answeredTurn = state.answeredTurn;
      Object.assign(state, { status: 'needs_answer', questionId: 'question-old',
        answer: { status: 'needs_answer', jobId: state.jobId, question: { id: 'question-old' } } });
      f.setStore({ [key]: state });
      const run = f.$.process.run;
      f.$.process.run = async (argv, init) => {
        const result = await run(argv, init);
        if (argv[2] !== 'status') return result;
        const value = JSON.parse(result.stdout);
        if (value.job) value.job.status = 'interrupted';
        return { ...result, stdout: JSON.stringify(value) };
      };
      turnId = 'turn-2'; await start(f, 'native-agent', 'Late answer.', turnId);
    }
    const recovery = { status, jobId: 'task-1', summary: 'Fixture recovery',
      blockers: [{ code: 'thread_busy', message: 'Fixture unresolved turn' }],
      next: 'fugato result task-1 --report', details: 'fugato result task-1 --details' };
    const spawn = f.$.process.spawn;
    f.$.process.spawn = request => {
      if (request.argv[2] === 'result') return Object.assign((async function* () {
        yield { stream: 'stdout', text: JSON.stringify(recovery) + '\n' };
      })(), { result: Promise.resolve({ code: 2 }) });
      const child = spawn(request);
      if (request.argv[2] !== 'task') return child;
      return Object.assign((async function* () {
        for await (const chunk of child) yield { ...chunk, text: JSON.stringify(recovery) + '\n' };
      })(), { result: child.result });
    };
    assert.deepEqual(await step(f, 'native-agent', turnId), { ...recovery, status: 'blocked' });
    assert.equal(f.readStore()[key].answeredTurn, answeredTurn);
    assert.equal(f.readStore()[key].finishedAt, undefined);
    assert.equal(f.readStore()[key].status, status);
    assert.equal(f.timers.size, 0);
  }
  // delta-2: an exception after a same-turn lookup found an unresolved
  // inferred completion must not mark the turn answered or finished.
  {
    const { f, owner } = host(); owner.resolve();
    await step(f, 'native-agent', 'turn-1');
    const state = f.readStore()[key];
    for (const name of ['answeredTurn', 'answer', 'finishedAt']) delete state[name];
    f.setStore({ [key]: { ...state, status: 'running' } });
    const run = f.$.process.run;
    f.$.process.run = async (argv, init) => {
      const result = await run(argv, init);
      if (argv[2] !== 'status') return result;
      const value = JSON.parse(result.stdout);
      if (value.job) Object.assign(value, { recovery: { status: 'unknown' },
        job: { ...value.job, status: 'completed', result: { inferredCompletion: true, turnEnded: false } } });
      return { ...result, stdout: JSON.stringify(value) };
    };
    f.$.process.spawn = () => { throw new Error('Fixture host process unavailable'); };
    assert.equal((await step(f, 'native-agent', 'turn-1')).status, 'blocked');
    const saved = f.readStore()[key];
    assert.deepEqual([saved.status, saved.answeredTurn, saved.finishedAt], ['unknown', undefined, undefined]);
    assert.equal(f.readStore()['native:closed:v1:native-session:native-agent'], undefined);
  }
  // delta-2: an owner stop must establish recovery before writing closure or
  // completion evidence, even when only result --report reveals uncertainty.
  for (const status of ['unknown', 'unreachable']) for (const source of ['envelope', 'inferred', 'report']) {
    const { f, owner } = host(), run = f.$.process.run, spawn = f.$.process.spawn;
    const closed = 'native:closed:v1:native-session:native-agent';
    const recovery = { status, jobId: 'task-1', blockers: [{ code: 'thread_busy' }], next: 'fugato result task-1 --report' };
    let confirmed = false;
    f.$.process.run = async (argv, init) => {
      if (argv[2] === 'result') return { exitCode: 2, stdout: JSON.stringify(recovery) };
      if (argv[2] === 'cancel') return { exitCode: 2, stdout: JSON.stringify({ jobId: 'task-1',
        status: 'interrupt_unconfirmed', confirmation: 'unconfirmed', turnInterrupted: false }) };
      const result = await run(argv, init);
      if (argv[2] !== 'status') return result;
      const value = JSON.parse(result.stdout);
      if (value.job) {
        if (confirmed) Object.assign(value.job, { status: 'interrupted', interruptionConfirmed: true });
        else if (source === 'envelope') value.recovery = { status };
        else if (source === 'inferred') value.job.result = { inferredCompletion: true, turnEnded: false };
      }
      return { ...result, stdout: JSON.stringify(value) };
    };
    f.$.process.spawn = request => {
      const child = spawn(request);
      if (request.argv[2] !== 'task') return child;
      return Object.assign((async function* () {
        for await (const chunk of child) yield { ...chunk, text: JSON.stringify({ status: 'owner_stopped', jobId: 'task-1' }) + '\n' };
      })(), { result: child.result });
    };
    const set = f.$.store.set;
    f.$.store.set = async (name, value) => {
      if (!confirmed) {
        assert.notEqual(name, closed);
        if (name === key) assert.equal(value.finishedAt, undefined);
      }
      return set(name, value);
    };
    owner.resolve();
    assert.deepEqual(await step(f, 'native-agent', 'turn-1'), { ...recovery, status: 'blocked' });
    // The separate aborted-dispatch callback uses the same ending gate.
    await f.invoke('turn.complete', { agentId: 'native-agent', turnId: 'turn-1', isAborted: true }, async () => ({}));
    const saved = f.readStore()[key];
    assert.equal(saved.status, status);
    assert.equal(saved.finishedAt, undefined);
    assert.equal(saved.answeredTurn, undefined);
    assert.equal(saved.cancellation.confirmation, 'unconfirmed');
    assert.equal(f.readStore()[closed], undefined);
    assert.equal(f.timers.size, 0);
    f.setStore({ ...f.readStore(), ...Object.fromEntries(Array.from({ length: 127 }, (_, i) => [
      `native:v2:protected:${i}`, { v: 2, status: 'running' } ])) });
    await spawnAgent(f, 'contender'); await start(f, 'contender');
    assert.deepEqual(f.readStore()[key], saved);
    assert.equal(f.readStore()['native:v2:native-session:contender'], undefined);
    confirmed = true;
    await f.invoke('turn.complete', { agentId: 'native-agent', turnId: 'turn-1', isAborted: true }, async () => ({}));
    assert.equal(f.readStore()[key].cancellation.confirmation, 'confirmed');
    assert.equal(f.readStore()[key].status, 'interrupted');
    assert.equal(typeof f.readStore()[key].finishedAt, 'number');
    assert.equal(f.readStore()[closed].turnId, 'turn-1');
    await spawnAgent(f, 'replacement'); await start(f, 'replacement');
    assert.equal(f.readStore()[key], undefined);
    assert.ok(f.readStore()['native:v2:native-session:replacement']);
  }
  return { races, failures, admission: { count, refusal }, size: { withinBudget: size <= 2 * 1024 * 1024, bytes: size,
    records: admitted.length, capacityRefusals, failedWrites },
    orphans: orphanEvidence, guardBudget };
}

test('expired parked bindings from an ended session yield capacity while live questions stay bound', async () => {
  const f = fixture('review-ok', 'native-worker', { memoryStore: true });
  f.setStore(Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`native:v2:native-session:running-${i}`, {
    v: 2, type: AGENT_TYPE, session: 'native-session', agentId: `running-${i}`,
    cwd: `${f.root}/repo`, jobId: `running-${i}`, status: 'running',
  }])));
  const completed = await f.turn('Create an ended job whose binding was left parked.', 1);
  assert.equal(completed.status, 'completed');
  const launch = f.capture.processes.findIndex(p => p.kind === 'spawn' && p.request.argv[2] === 'task');
  assert.equal(f.capture.processes.slice(0, launch).filter(p => p.request.argv[2] === 'status'
    && p.request.argv.includes('--all')).length, 0);
  const now = await f.$.clock.now(), prefix = 'native:v2:native-session:';
  const parked = (id, expiresAt) => ({ v: 2, type: AGENT_TYPE, session: 'native-session', agentId: id,
    cwd: `${f.root}/repo`, jobId: id, status: 'needs_answer', questionId: `question-${id}`,
    answer: { status: 'needs_answer', question: { id: `question-${id}`, expiresAt } } });
  const protectedStates = {
    [`${prefix}answerable`]: parked('answerable', now + 900000),
    [`${prefix}active`]: parked('active', now - 1800000),
  };
  f.setStore({ ...protectedStates, ...Object.fromEntries(Array.from({ length: 128 }, (_, i) => [
    `${prefix}expired-${i}`, { ...parked(`expired-${i}`, now - 1800000), jobId: i === 0 ? completed.jobId : `expired-${i}` },
  ])) });
  f.$.session.id = async () => 'new-session';
  const run = f.$.process.run;
  f.$.process.run = async (argv, init) => {
    if (argv[2] !== 'status' || !argv.includes('native-session')) return run(argv, init);
    if (argv.includes('--all')) return { exitCode: 0, stdout: JSON.stringify({
      running: ['answerable', 'active'].map(id => ({ id, sessionId: 'native-session', status: 'running',
        pendingQuestion: { id: `question-${id}`, expiresAt: protectedStates[`${prefix}${id}`].answer.question.expiresAt } })),
      recent: [], latestFinished: null,
    }) };
    return run(argv, init);
  };
  assert.equal((await f.turn('Dispatch despite expired questions from an ended session.', 1)).status, 'completed');
  assert.equal(f.capture.processes.filter(p => p.kind === 'spawn' && p.request.argv[2] === 'task').length, 2);
  assert.equal(Object.keys(f.readStore()).filter(key => key.startsWith('native:v2:')).length, 128);
  assert.equal(f.readStore()[`${prefix}expired-0`], undefined);
  for (const [key, state] of Object.entries(protectedStates)) assert.deepEqual(f.readStore()[key], state);
});

test('pruning bounds companion lookups and shares one inventory across bindings', async () => {
  const evidence = [];
  for (const mode of ['missing', 'timeout', 'sessions', 'workspaces']) {
    const f = fixture('review-ok', 'native-worker', { hostOnly: true, memoryStore: true });
    let now = await f.$.clock.now(), inventories = 0, lookups = 0;
    f.$.clock.now = async () => now;
    f.setStore(Object.fromEntries(Array.from({ length: 128 }, (_, i) => [`native:v2:session-${i}:${i}`, {
      v: 2, type: AGENT_TYPE, session: `session-${i}`, agentId: String(i),
      cwd: `${f.root}/repo${mode === 'workspaces' ? `/${i}` : ''}`,
      jobId: `task-missing-${i}`, status: 'unknown',
    }])));
    const running = ['sessions', 'workspaces'].includes(mode) ? Object.values(f.readStore())
      .map(state => ({ id: state.jobId, sessionId: state.session, status: 'running' })) : [];
    f.$.process.run = async (argv, init) => {
      if (argv[0] === 'node') return { exitCode: 0, stdout: process.execPath };
      if (argv.includes('--all')) {
        inventories++; return { exitCode: 0, stdout: JSON.stringify({ running, recent: [], latestFinished: null }) };
      }
      lookups++;
      if (mode === 'timeout') { now += init.timeoutMs; throw new Error('Fixture lookup timeout'); }
      return { exitCode: 1, stdout: '', stderr: `No job found for "${argv[3]}". Run /fugato:status to list known jobs.` };
    };
    const report = await f.turn('Keep unresolved bindings when pruning runs out of budget.', 1);
    evidence.push({ inventories, lookups, code: report.blockers[0].code });
  }
  assert.deepEqual(evidence, [{ inventories: 1, lookups: 7, code: 'native_capacity' },
    { inventories: 1, lookups: 1, code: 'native_capacity' },
    { inventories: 1, lookups: 0, code: 'native_capacity' },
    { inventories: 8, lookups: 0, code: 'native_capacity' }]);

  const f = fixture('review-ok', 'native-worker', { hostOnly: true, memoryStore: true });
  const states = Object.fromEntries(Array.from({ length: 128 }, (_, i) => [`native:v2:rotate:${i}`, {
    v: 2, type: AGENT_TYPE, session: 'rotate', agentId: String(i),
    cwd: `${f.root}/repo/${i}`, jobId: `task-${i}`, status: 'unknown',
  }]));
  f.setStore(states);
  let calls = 0, reclaimable;
  const attempts = [];
  f.$.process.run = async argv => {
    if (argv[0] === 'node') return { exitCode: 0, stdout: process.execPath };
    calls++;
    const index = Number(argv[argv.indexOf('--cwd') + 1].split('/').at(-1));
    // Place the reclaimable binding just past the first prune's budget,
    // independent of where earlier tests left the module's rotating cursor.
    reclaimable ??= (index + 8) % 128;
    const state = states[`native:v2:rotate:${index}`];
    const job = { id: state.jobId, sessionId: state.session,
      status: index === reclaimable ? 'completed' : 'running' };
    return { exitCode: 0, stdout: JSON.stringify(argv.includes('--all')
      ? { running: job.status === 'running' ? [job] : [], recent: [], latestFinished: null }
      : argv[2] === 'status' ? { job } : { jobId: job.id, status: job.status }) };
  };
  for (let i = 0; i < 2; i++) {
    const id = `rotating-${i}`;
    calls = 0;
    await f.invoke('agent.spawn', { subagentType: AGENT_TYPE, tool_use_id: `spawn-${id}`,
      name: id, permissionMode: 'default', prompt: 'Probe.' }, async () => ({ agentId: id }));
    await f.invoke('turn.start', { agentId: id, turnId: `turn-${id}`, text: 'Probe.' }, async e => e);
    attempts.push({ admitted: !!f.readStore()[`native:v2:native-session:${id}`], calls });
  }
  assert.deepEqual(attempts, [{ admitted: false, calls: 8 }, { admitted: true, calls: 3 }]);

  const duplicate = fixture('review-ok', 'native-worker', { hostOnly: true, memoryStore: true });
  duplicate.setStore(Object.fromEntries(Array.from({ length: 128 }, (_, i) => [`native:v2:duplicate:${i}`, {
    v: 2, type: AGENT_TYPE, session: 'duplicate', agentId: String(i),
    cwd: `${duplicate.root}/repo`, jobId: `task-${i === 127 ? 0 : i}`, status: 'unknown',
  }])));
  const duplicateAttempts = [];
  duplicate.$.process.run = async argv => {
    if (argv[0] === 'node') return { exitCode: 0, stdout: process.execPath };
    calls++;
    if (argv.includes('--all')) return { exitCode: 0, stdout: JSON.stringify({ running: [], recent: [], latestFinished: null }) };
    const index = Number(argv[3].slice(5));
    const job = { id: argv[3], sessionId: 'duplicate', status: index === 4 ? 'completed' : 'unknown' };
    return { exitCode: 0, stdout: JSON.stringify(argv[2] === 'status' ? { job }
      : { jobId: job.id, status: index === 4 ? 'completed' : 'blocked',
        ...(index === 4 ? {} : { recovery: { status: 'unknown' } }) }) };
  };
  for (let i = 0; i < 2; i++) {
    const id = `duplicate-${i}`;
    calls = 0;
    await duplicate.invoke('agent.spawn', { subagentType: AGENT_TYPE, tool_use_id: `spawn-${id}`,
      name: id, permissionMode: 'default', prompt: 'Probe.' }, async () => ({ agentId: id }));
    await duplicate.invoke('turn.start', { agentId: id, turnId: `turn-${id}`, text: 'Probe.' }, async e => e);
    duplicateAttempts.push({ admitted: !!duplicate.readStore()[`native:v2:native-session:${id}`], calls });
  }
  assert.deepEqual(duplicateAttempts, [{ admitted: false, calls: 8 }, { admitted: true, calls: 3 }]);
  assert.equal(duplicate.readStore()['native:v2:duplicate:4'], undefined);
});

test('malformed successful job lookups never prove a binding is missing', async () => {
  const f = fixture('review-ok', 'native-worker', { hostOnly: true, memoryStore: true });
  const key = 'native:v2:native-session:old';
  let now = await f.$.clock.now();
  f.$.clock.now = async () => now;
  f.setStore({ ...Object.fromEntries(Array.from({ length: 127 }, (_, i) => [`native:v2:protected:${i}`, { v: 2, status: 'running' }])),
    [key]: { v: 2, type: AGENT_TYPE, session: 'native-session', agentId: 'old', cwd: `${f.root}/repo`,
      jobId: 'task-live', status: 'unknown', turnId: 'old-turn', intent: { kind: 'task', turnId: 'old-turn', nonce: 'nonce' } } });
  f.$.process.run = async argv => ({ exitCode: 0, stdout: argv[0] === 'node' ? process.execPath
    : argv.includes('--all') ? JSON.stringify({ running: [], recent: [], latestFinished: null }) : '{}' });
  await f.turn('First missing-job observation.', 1, false, { agentId: 'first' });
  now += 600001;
  await f.turn('Second missing-job observation.', 1, false, { agentId: 'second' });
  assert.deepEqual({ retained: !!f.readStore()[key], admitted: !!f.readStore()['native:v2:native-session:second'] },
    { retained: true, admitted: false });
});

test('a completed follow-up remains reclaimable when its final answer cache write fails', async () => {
  const f = fixture('review-ok', 'native-worker', { memoryStore: true });
  await f.turn('First assignment.', 1);
  const key = 'native:v2:native-session:native-agent', set = f.$.store.set;
  let failedWrites = 0;
  f.$.store.set = async (name, value) => {
    if (name === key && value.answer && value.answeredTurn === 'turn-2') {
      failedWrites++; throw new Error('Final answer cache unavailable');
    }
    return set(name, value);
  };
  const completed = await f.turn('Second assignment.', 2);
  f.$.store.set = set;
  const persisted = f.readStore()[key];
  f.setStore({ ...f.readStore(), ...Object.fromEntries(Array.from({ length: 127 }, (_, i) => [
    `native:v2:protected:${i}`, { v: 2, status: 'running' } ])) });
  f.reload();
  await f.invoke('agent.spawn', { subagentType: AGENT_TYPE, tool_use_id: 'spawn-replacement', name: 'replacement',
    permissionMode: 'default', prompt: 'New assignment.' }, async () => ({ agentId: 'replacement' }));
  await f.invoke('turn.start', { agentId: 'replacement', turnId: 'replacement-turn', text: 'New assignment.' }, async e => e);
  assert.deepEqual({ completed: completed.status, failed: failedWrites > 0, answeredTurn: persisted.answeredTurn,
    retained: !!f.readStore()[key], admitted: !!f.readStore()['native:v2:native-session:replacement'] },
  { completed: 'completed', failed: true, answeredTurn: 'turn-1', retained: false, admitted: true });
});

test('store retention removes old finished handles, preserves parked questions, and refuses excess records', async t => {
  const stability = await nativeStability();
  t.diagnostic('native-stability ' + JSON.stringify(stability));
  assert.deepEqual({ ...stability, size: { ...stability.size, bytes: undefined } }, {
    races: ['append', 'append-reload', 'cancel', 'cancel-reload', 'cancel-admitted'].map(mode => ({ mode, first: 'completed', second: 'completed', incoming: true, launches: 2, currentJob: true })),
    failures: ['deny', 'throw', 'save'].map(mode => ({ mode, status: 'completed', injected: true, logged: true, launches: 1, consumed: 1, closed: 0 })),
    admission: { count: 128, refusal: 'native_capacity' },
    size: { withinBudget: true, bytes: undefined, records: 7, capacityRefusals: 58, failedWrites: 0 },
    orphans: { old: 0, fresh: true, bound: true, pending: true, live: true }, guardBudget: true,
  });
  const f = fixture('review-ok');
  f.setStore({
    'native:v2:old:finished': { v: 2, type: AGENT_TYPE, session: 'old', agentId: 'finished', finishedAt: 1 },
    'native:closed:v1:old:finished': { at: 1 },
    'native:binding-failed:v1:old:finished': { bindingPending: true },
    'native:v2:old:parked': { v: 2, type: AGENT_TYPE, status: 'needs_answer', questionId: 'parked', finishedAt: 1 },
    'native:v2:old:incoming': { v: 2, type: AGENT_TYPE, finishedAt: 1, incoming: { turnId: 'pending', text: 'Continue.' } },
    'other-plugin-key': { untouched: true },
  });
  f.reload();
  assert.equal((await f.turn('DUET: --unsupported\nRejected before launch.', 1)).status, 'blocked');
  assert.equal(f.readStore()['native:v2:old:finished'], undefined);
  assert.equal(f.readStore()['native:closed:v1:old:finished'], undefined);
  assert.equal(f.readStore()['native:binding-failed:v1:old:finished'], undefined);
  assert.equal(f.readStore()['native:v2:old:parked'].questionId, 'parked');
  assert.equal(f.readStore()['native:v2:old:incoming'].incoming.turnId, 'pending');
  assert.equal(f.readStore()['other-plugin-key'].untouched, true);
  assert.equal(Object.values(f.readStore()).find(s => s.agentId === 'native-agent').incoming, undefined);
  f.setStore(Object.fromEntries(Array.from({ length: 128 }, (_, i) => [`native:v2:active:${i}`, { v: 2, type: AGENT_TYPE, status: 'running' }])));
  f.reload();
  const refused = await f.turn('Do not exceed the adapter store budget.', 1);
  assert.equal(refused.status, 'blocked');
  assert.equal(refused.blockers[0].code, 'native_capacity');
  assert.equal(Object.keys(f.readStore()).length, 128);
  assert.equal(f.capture.processes.length, 0);
  f.save();

  const records = f => Object.keys(f.readStore()).filter(key => key.startsWith('native:v2:'));
  const tasks = f => f.capture.processes.filter(p => p.kind === 'spawn' && p.request.argv[2] === 'task').length;
  const seed = (f, count, padding = '') => {
    const data = {};
    // Insertion order is newest-first; eviction must use finishedAt instead.
    for (let i = count - 1; i >= 0; i--) {
      data[`native:v2:history:${i}`] = { v: 2, type: AGENT_TYPE, session: 'history', agentId: String(i),
        status: 'completed', finishedAt: 1800000000000 - (count - i) * 1000, padding };
      data[`native:closed:v1:history:${i}`] = { at: 1800000000000 };
      data[`native:binding-failed:v1:history:${i}`] = { bindingPending: true };
    }
    f.setStore(data); f.reload();
    return data;
  };
  const history = fixture('review-ok', 'native-worker', { memoryStore: true });
  seed(history, 128);
  assert.equal((await history.turn('Admit a worker despite retained history.', 1)).status, 'completed');
  assert.equal(tasks(history), 1);
  assert.equal(records(history).length, 128);
  for (const prefix of ['native:v2:', 'native:closed:v1:', 'native:binding-failed:v1:']) {
    assert.equal(history.readStore()[`${prefix}history:0`], undefined);
    assert.ok(history.readStore()[`${prefix}history:1`]);
  }

  // Evict a real completed binding, then exercise SendMessage after reload.
  const retained = history.readStore(), nativeKey = 'native:v2:native-session:native-agent';
  retained[nativeKey].finishedAt = 1800000000000 - 200000;
  retained['native:closed:v1:native-session:native-agent'] = { at: 1800000000000 };
  retained['native:binding-failed:v1:native-session:native-agent'] = { bindingPending: true };
  history.setStore(retained);
  await history.invoke('agent.spawn', { subagentType: AGENT_TYPE, tool_use_id: 'evictor-spawn',
    name: 'evictor', permissionMode: 'default', prompt: 'Another worker.' }, async () => ({ agentId: 'evictor' }));
  // Admission and eviction run at turn.start; agent.spawn returns without store work.
  await history.invoke('turn.start', { agentId: 'evictor', turnId: 'evictor-turn', text: 'Another worker.' }, async e => ({ turnId: e.turnId }));
  assert.equal(history.readStore()[nativeKey], undefined);
  assert.equal(history.readStore()['native:closed:v1:native-session:native-agent'], undefined);
  assert.equal(history.readStore()['native:binding-failed:v1:native-session:native-agent'], undefined);
  history.reload();
  const before = history.capture.processes.length;
  const gone = await history.turn('Continue the evicted worker.', 2);
  assert.equal(gone.status, 'blocked');
  assert.equal(gone.blockers[0].code, 'native_binding_gone');
  assert.equal(history.capture.processes.length, before);
  assert.equal(history.readStore()[nativeKey], undefined);

  const sized = fixture('review-ok', 'native-worker', { memoryStore: true }), largeHistory = seed(sized, 3, 'x'.repeat(250000));
  const protectedStates = {
    'native:v2:protected:active': { v: 2, type: AGENT_TYPE, status: 'running' },
    'native:v2:protected:parked': { v: 2, type: AGENT_TYPE, status: 'needs_answer', questionId: 'parked', finishedAt: 1 },
    'native:v2:protected:displayed': { v: 2, type: AGENT_TYPE, answer: { status: 'needs_answer' }, finishedAt: 1 },
    'native:v2:protected:incoming': { v: 2, type: AGENT_TYPE, incoming: { turnId: 'pending', text: 'Continue.' }, finishedAt: 1 },
  };
  sized.setStore({ ...largeHistory, ...protectedStates });
  assert.equal((await sized.turn('Reclaim history under size pressure.', 1)).status, 'completed');
  assert.equal(tasks(sized), 1);
  for (const prefix of ['native:v2:', 'native:closed:v1:', 'native:binding-failed:v1:']) {
    assert.equal(sized.readStore()[`${prefix}history:0`], undefined);
    assert.ok(sized.readStore()[`${prefix}history:1`]);
  }
  for (const [key, state] of Object.entries(protectedStates)) assert.deepEqual(sized.readStore()[key], state);
  assert.ok(records(sized).reduce((size, key) => size + JSON.stringify(sized.readStore()[key]).length * 4, 0) <= 2 * 1024 * 1024);

  // Protected records count toward admission even with a stale finishedAt.
  const full = fixture('review-ok', 'native-worker', { memoryStore: true });
  full.setStore({ ...Object.fromEntries(Array.from({ length: 124 }, (_, i) => [
    `native:v2:active:${i}`, { v: 2, type: AGENT_TYPE, status: 'running' },
  ])), ...protectedStates });
  assert.equal((await full.turn('Keep every active slot.', 1)).blockers[0].code, 'native_capacity');
  assert.equal(records(full).length, 128);
  assert.equal(full.capture.processes.length, 0);
  for (const [key, state] of Object.entries(protectedStates)) assert.deepEqual(full.readStore()[key], state);

  // A legacy spawn gets a full observation window, restarted by a reload.
  const unstarted = fixture('review-ok', 'native-worker', { memoryStore: true });
  unstarted.setStore({ ...Object.fromEntries(Array.from({ length: 127 }, (_, i) => [
    `native:v2:active:${i}`, { v: 2, type: AGENT_TYPE, status: 'running' },
  ])), 'native:v2:old:unstarted': { type: AGENT_TYPE, session: 'old', agentId: 'unstarted', permissionMode: 'default' } });
  let unstartedNow = await unstarted.$.clock.now();
  unstarted.$.clock.now = async () => unstartedNow;
  const unstartedEvidence = [];
  for (const [elapsed, reload] of [[0, false], [599999, false], [0, true], [599999, false], [1, false]]) {
    unstartedNow += elapsed;
    if (reload) unstarted.reload();
    const result = await unstarted.turn('Reclaim a never-started binding only after observing it.', 1);
    unstartedEvidence.push({ status: result.status, kept: !!unstarted.readStore()['native:v2:old:unstarted'] });
  }
  assert.equal(unstarted.readStore()['native:v2:old:unstarted'], undefined);
  assert.equal(records(unstarted).length, 128);

  const oversized = fixture('review-ok', 'native-worker', { memoryStore: true });
  oversized.setStore({ 'native:v2:active:large': { v: 2, type: AGENT_TYPE, status: 'running', padding: 'x'.repeat(524288) } });
  assert.equal((await oversized.turn('Refuse when protected data fills the size budget.', 1)).blockers[0].code, 'native_capacity');
  assert.equal(records(oversized).length, 1);
  assert.equal(oversized.capture.processes.length, 0);
  oversized.setStore({}); oversized.reload();
  assert.equal((await oversized.turn('x'.repeat(65537), 1)).blockers[0].code, 'native_message_too_large');
  assert.equal(records(oversized).length, 0);
  assert.equal(oversized.capture.processes.length, 0);

  const spawnAgent = (f, id, resume = false) => f.invoke('agent.spawn', {
    subagentType: AGENT_TYPE, tool_use_id: `spawn-${id}`, name: id, permissionMode: 'default',
    prompt: 'Retain the binding.', ...(resume ? { resume: { agentId: id } } : {}),
  }, async () => ({ agentId: id }));
  const startAgent = (f, id) => f.invoke('turn.start', { agentId: id, turnId: `turn-${id}`, text: 'Retain the binding.' },
    async e => ({ turnId: e.turnId }));
  const admit = async (f, id) => { await spawnAgent(f, id); await startAgent(f, id); };
  const activeRecords = count => Object.fromEntries(Array.from({ length: count }, (_, i) => [
    `native:v2:active:${i}`, { v: 2, type: AGENT_TYPE, status: 'running' },
  ]));

  // Exercise the actual cancel hook with an unconfirmed interrupt response.
  const cancelled = fixture('review-ok', 'native-worker', { memoryStore: true }), cancelledKey = 'native:v2:native-session:stopped';
  const runningJob = { id: 'unresolved-job', sessionId: 'native-session', status: 'running',
    dispatchNonce: 'unresolved-nonce', threadId: 'unresolved-thread', ownerId: 'owner', agentName: 'stopped' };
  cancelled.setStore({ ...activeRecords(127), [cancelledKey]: { v: 2, type: AGENT_TYPE,
    session: 'native-session', agentId: 'stopped', cwd: `${cancelled.root}/repo`, status: 'running', jobId: runningJob.id,
    intent: { kind: 'task', turnId: 'unresolved-turn', nonce: runningJob.dispatchNonce } } });
  cancelled.$.agent.list = async () => [{ id: 'stopped', type: AGENT_TYPE }];
  let cancelCalls = 0;
  cancelled.$.process.run = async argv => {
    if (argv[0] === 'node') return { exitCode: 0, stdout: process.execPath };
    if (argv[2] === 'cancel') cancelCalls++;
    return { exitCode: 0, stdout: JSON.stringify(argv[2] === 'cancel'
      ? { jobId: runningJob.id, status: 'unconfirmed', confirmation: 'unconfirmed' } : { job: runningJob }) };
  };
  await cancelled.invoke('turn.complete', { agentId: 'stopped', turnId: 'unresolved-turn', isAborted: true }, async () => ({}));
  const unresolved = cancelled.readStore()[cancelledKey];
  assert.equal(cancelCalls, 1);
  assert.equal(unresolved.cancellation.confirmation, 'unconfirmed');
  cancelled.reload();
  await admit(cancelled, 'contender');
  const cancellationEvidence = { kept: !!cancelled.readStore()[cancelledKey],
    admitted: !!cancelled.readStore()['native:v2:native-session:contender'], records: records(cancelled).length };
  // Age expiry, closure and confirmed cancellation still permit reclamation.
  // A terminal-looking label alone cannot override an unconfirmed cancellation.
  const endedEvidence = [];
  for (const evidence of ['closed', 'confirmed', 'completed', 'needs_input', 'blocked', 'expired']) {
    const settled = fixture('review-ok', 'native-worker', { memoryStore: true }), state = clone(unresolved);
    state.finishedAt = 1800000000000 - (evidence === 'expired' ? 7 * 24 * 60 * 60 * 1000 + 1 : 1000);
    if (evidence === 'confirmed') state.cancellation.confirmation = 'confirmed';
    if (['completed', 'needs_input', 'blocked'].includes(evidence)) state.status = evidence;
    settled.setStore({ ...activeRecords(127), [cancelledKey]: state,
      ...(evidence === 'closed' ? { 'native:closed:v1:native-session:stopped': { turnId: state.intent.turnId, at: 1800000000000 } } : {}) });
    await admit(settled, 'contender');
    endedEvidence.push(!settled.readStore()[cancelledKey]);
  }

  // A certain worker failure has finishedAt without a cancellation record or
  // closeTurn marker; it must still yield its history slot under pressure.
  const failed = fixture('review-ok', 'native-worker', { memoryStore: true }), failedState = { ...unresolved, status: 'failed', finishedAt: 1800000000000 - 1000 };
  delete failedState.cancellation;
  failed.setStore({ ...activeRecords(127), [cancelledKey]: failedState });
  await admit(failed, 'contender');
  const failedEvidence = { kept: !!failed.readStore()[cancelledKey],
    admitted: !!failed.readStore()['native:v2:native-session:contender'], records: records(failed).length };

  const pendingEvidence = [];
  for (const protection of ['memory', 'guard', 'expired-guard']) {
    const pending = fixture('review-ok', 'native-worker', { memoryStore: true });
    seed(pending, 128);
    pending.$.session.id = async () => 'history';
    const set = pending.$.store.set;
    if (protection === 'memory') pending.$.store.set = async () => { throw new Error('Guard unavailable'); };
    await spawnAgent(pending, '0', true);
    pending.$.store.set = set;
    if (protection !== 'memory') pending.reload();
    pending.$.clock.now = async () => 1800000000000 + (protection === 'guard' ? 599999 : 600000);
    pending.$.session.id = async () => 'native-session';
    await admit(pending, 'contender');
    pendingEvidence.push({ oldestKept: !!pending.readStore()['native:v2:history:0'],
      secondKept: !!pending.readStore()['native:v2:history:1'], records: records(pending).length });
  }

  const rejectedHistory = fixture('review-ok', 'native-worker', { memoryStore: true });
  seed(rejectedHistory, 128);
  const largeReport = await rejectedHistory.turn('x'.repeat(65537), 1);
  const oversizedEvidence = { code: largeReport.blockers[0].code, oldestKept: !!rejectedHistory.readStore()['native:v2:history:0'],
    records: records(rejectedHistory).length, processCalls: rejectedHistory.capture.processes.length };

  const refusalEvidence = [];
  for (const code of ['native_message_too_large', 'native_capacity']) {
    const healthy = fixture('review-ok', 'native-worker', { memoryStore: true }), guardKey = 'native:binding-failed:v1:native-session:native-agent';
    const state = { v: 2, type: AGENT_TYPE, session: 'native-session', agentId: 'native-agent',
      cwd: `${healthy.root}/repo`, permissionMode: 'default', status: 'completed', finishedAt: 1800000000000,
      intent: { turnId: 'turn-1' }, answeredTurn: 'turn-1', answer: { status: 'completed' } };
    healthy.setStore({ [nativeKey]: state, ...(code === 'native_capacity' ? {
      'native:v2:active:large': { v: 2, type: AGENT_TYPE, status: 'running', padding: 'x'.repeat(524288) },
    } : {}) });
    const result = await healthy.turn(code === 'native_message_too_large' ? 'x'.repeat(65537) : 'Refuse excess storage.', 2);
    const guardRemoved = !healthy.readStore()[guardKey], bindingKept = !!healthy.readStore()[nativeKey];
    healthy.reload();
    const replay = await healthy.invoke('turn.step', { agentId: 'native-agent', turnId: 'turn-1', index: 0 }, async function* () {
      assert.fail('A healthy native binding must not reach the model');
    });
    refusalEvidence.push({ code: result.blockers[0].code, guardRemoved, bindingKept,
      replay: JSON.parse(replay.answer).status, processCalls: healthy.capture.processes.length });
  }
  const evidence = { finding1: cancellationEvidence, failedEvidence, endedEvidence, finding2a: pendingEvidence,
    finding2b: unstartedEvidence, finding4: oversizedEvidence, finding5: refusalEvidence };
  t.diagnostic(JSON.stringify(evidence));
  assert.deepEqual(evidence, {
    finding1: { kept: true, admitted: false, records: 128 }, endedEvidence: [true, true, false, false, false, true],
    failedEvidence: { kept: false, admitted: true, records: 128 },
    finding2a: [
      { oldestKept: true, secondKept: false, records: 128 },
      { oldestKept: true, secondKept: false, records: 128 },
      { oldestKept: false, secondKept: true, records: 128 },
    ],
    finding2b: [
      { status: 'blocked', kept: true }, { status: 'blocked', kept: true },
      { status: 'blocked', kept: true }, { status: 'blocked', kept: true }, { status: 'completed', kept: false },
    ],
    finding4: { code: 'native_message_too_large', oldestKept: true, records: 128, processCalls: 0 },
    finding5: ['native_message_too_large', 'native_capacity'].map(code => ({
      code, guardRemoved: true, bindingKept: true, replay: 'completed', processCalls: 0,
    })),
  });
});

test('readiness attaches once to a user prompt per session; classic startup exports the session cwd without flags', async () => {
  const f = fixture('review-ok');
  const event = { session_id: 'native-session', cwd: `${f.root}/repo`, source: 'startup' };
  f.env.CLAUDE_ENV_FILE = `${f.root}/claude-env`;
  const child = spawnSync(process.execPath, [plugin + '/scripts/session-lifecycle-hook.mjs', 'SessionStart'],
    { env: f.env, cwd: event.cwd, input: JSON.stringify(event), encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.ok(JSON.parse(child.stdout).hookSpecificOutput.additionalContext.split('\n')[0].includes('fugato:codex-native'));
  assert.ok(fs.readFileSync(f.env.CLAUDE_ENV_FILE, 'utf8').includes(`export CODEX_COMPANION_SESSION_CWD='${event.cwd}'`));
  assert.ok(!fs.existsSync(`${f.root}/data/native-ready`));
  // The function sandbox cannot see CLAUDE_PLUGIN_DATA; readiness needs no env.
  f.$.env.get = async () => undefined;
  // Dispatch guidance lives in the per-request system prompt, so compaction
  // cannot remove it; requests without the Agent tool do not get it.
  const compose = tools => f.invoke('prompt.compose', { model: 'm', promptModel: 'm', surfaces: [], tools, outputStyle: null, traits: [] },
    async () => ({ sections: [{ id: 'intro', text: 'Intro', scope: 'shared' }] }));
  const guided = await compose(['Agent', 'Bash']);
  assert.deepEqual(guided.sections.map(section => [section.id, section.scope]), [['intro', 'shared'], ['fugato:native-dispatch', 'session']]);
  assert.ok(guided.sections[1].text.includes('fugato:codex-native'));
  assert.deepEqual((await compose(['Bash'])).sections.map(section => section.id), ['intro']);
  const submit = origin => f.invoke('prompt.submit', { text: 'Hello', wait: false, origin: { kind: origin }, context: ['Existing context'] },
    async e => ({ text: e.text, context: e.context, origin: e.origin }));
  assert.deepEqual((await submit('plugin')).context, ['Existing context']);
  const command = await f.invoke('prompt.submit', { text: '/reload-plugins', command: { name: 'reload-plugins' }, wait: false, origin: { kind: 'composer' } },
    async e => ({ text: e.text, context: e.context, origin: e.origin }));
  assert.equal(command.context, undefined);
  const first = await submit('composer');
  assert.equal(first.context.length, 2);
  assert.deepEqual((await submit('composer')).context, ['Existing context']);
  f.reload();
  assert.deepEqual((await submit('composer')).context, ['Existing context']);
  f.save();
  f.$.session.id = async () => 'second-session';
  assert.equal((await submit('composer')).context.length, 2);
  f.$.session.id = async () => 'concurrent-session';
  const together = await Promise.all([submit('composer'), submit('composer')]);
  assert.equal(together.filter(result => result.context.length === 2).length, 1);
  // Failure before the last registration must leave no readiness hook.
  const failedHooks = new Map();
  register((event, matcher, fn) => {
    if (typeof matcher === 'function') fn = matcher;
    if (event === 'turn.step') throw new Error('Injected registration failure');
    failedHooks.set(event, fn);
    return { catch() {} };
  });
  assert.ok(failedHooks.has('prompt.context'));
  const unavailable = await failedHooks.get('prompt.submit')(f.$, { text: 'Hello', origin: { kind: 'composer' } }, async e => e);
  assert.equal(unavailable.context, undefined);
});

test('saved Bash routing suppresses native guidance and resetting restores it', async () => {
  const f = fixture('review-ok', 'native-worker', { memoryStore: true, hostOnly: true });
  let now = await f.$.clock.now();
  f.$.clock.now = async () => now;
  const setup = route => {
    const result = spawnSync(process.execPath, [plugin + '/scripts/codex-companion.mjs', 'setup', '--dispatch', route, '--json'],
      { env: f.env, cwd: `${f.root}/repo`, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  const compose = () => f.invoke('prompt.compose', { tools: ['Agent', 'Bash'] }, async () => ({ sections: [] }));
  const submit = () => f.invoke('prompt.submit', { text: 'Task', origin: { kind: 'composer' } }, async e => e);
  const reads = () => f.capture.processes.filter(process => process.request.argv[2] === 'dispatch-status').length;
  setup('bash');
  const [guidance, prompt] = await Promise.all([compose(), submit()]);
  assert.deepEqual(guidance.sections, []);
  assert.equal(prompt.context, undefined);
  assert.equal(reads(), 1);
  assert.deepEqual((await compose()).sections, []);
  assert.equal(reads(), 1);
  setup('default');
  assert.deepEqual((await compose()).sections.map(section => section.id), ['fugato:native-dispatch']);
  assert.equal((await submit()).context.length, 1);
  assert.equal(reads(), 2);
  fs.writeFileSync(`${f.root}/isolated/duet/native-unavailable.json`,
    JSON.stringify({ at: new Date().toISOString(), reason: 'missing_turn_start' }));
  const unavailable = await compose();
  setup('native');
  assert.deepEqual([unavailable.sections.length, (await compose()).sections.map(section => section.id)],
    [0, ['fugato:native-dispatch']]);
  setup('bash');
  now += 60001;
  f.$.process.run = async () => { throw new Error('Guidance read unavailable'); };
  assert.deepEqual((await compose()).sections.map(section => section.id), ['fugato:native-dispatch']);
});

test('first native turn stays model-free when discovery or the host turn start is unavailable', async () => {
  for (const missing of [true, false]) {
    const f = fixture('review-ok');
    if (missing) delete f.$.agent.list;
    else f.$.agent.list = async () => { throw new Error('Discovery unavailable'); };
    await f.invoke('classic.SubagentStart', { session_id: 'native-session', agent_id: 'native-agent', agent_type: AGENT_TYPE }, async () => ({}));
    assert.deepEqual(f.readStore(), {});
    const report = await f.turn('DUET: --unsupported\nDo not dispatch.', 1);
    assert.equal(report.status, 'blocked');
    assert.equal(f.capture.processes.length, 0);
  }

  // Older hosts may deliver spawn and step without ever delivering start.
  const partial = fixture('review-ok', 'native-worker', { memoryStore: true, hostOnly: true });
  partial.$.clock.now = async () => Date.now();
  const key = 'native:v2:native-session:native-agent';
  await partial.invoke('agent.spawn', { subagentType: AGENT_TYPE, tool_use_id: 'partial-spawn',
    name: 'native-worker', permissionMode: 'default', prompt: 'Never dispatch without a turn start.' },
  async () => ({ agentId: 'native-agent' }));
  assert.equal(partial.readStore()[key], undefined);
  const step = () => partial.invoke('turn.step', { agentId: 'native-agent', turnId: 'partial-turn', index: 0 }, async function* () {
    assert.fail('A missing native turn start must not reach the model');
  }).then(result => JSON.parse(result.answer));
  assert.deepEqual((await partial.invoke('prompt.compose', { tools: ['Agent'] }, async () => ({ sections: [] }))).sections.map(section => section.id),
    ['fugato:native-dispatch']);
  const unavailable = await step();
  assert.equal(unavailable.status, 'blocked');
  assert.equal(unavailable.blockers[0].code, 'native_adapter_unavailable');
  assert.match(unavailable.next, /fugato status.*background Bash.*fugato task.*fugato:native-fallback/);
  const markerFile = `${partial.root}/isolated/duet/native-unavailable.json`;
  const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
  assert.equal(marker.reason, 'missing_turn_start');
  assert.ok(Number.isFinite(Date.parse(marker.at)));
  const start = spawnSync(process.execPath, [plugin + '/scripts/session-lifecycle-hook.mjs', 'SessionStart'], {
    env: { ...partial.env, CODEX_COMPANION_BIN: 'fixture-disabled' }, cwd: `${partial.root}/repo`, encoding: 'utf8',
    input: JSON.stringify({ session_id: 'native-session', cwd: `${partial.root}/repo`, source: 'startup' })
  });
  assert.equal(start.status, 0, start.stderr);
  const context = JSON.parse(start.stdout).hookSpecificOutput.additionalContext;
  assert.ok(context.includes(marker.at));
  assert.match(context, /prefer.*background Bash.*fugato task/);
  const guide = await partial.invoke('prompt.compose', { tools: ['Agent'] }, async () => ({ sections: [] }));
  assert.deepEqual(guide.sections, []);
  assert.equal(partial.jobs().length, 0);

  // A retained context for another turn is an adapter error, not a fallback.
  const state = { v: 2, type: AGENT_TYPE, session: 'native-session', agentId: 'native-agent',
    turnId: 'active-turn', incoming: { turnId: 'active-turn', text: 'Still active.' } };
  await partial.$.store.set(key, state);
  assert.equal((await step()).blockers[0].code, 'native_adapter_error');
  await partial.$.store.set(key, { ...state, v: undefined, incoming: undefined });
  assert.equal((await step()).blockers[0].code, 'native_adapter_error');
  assert.ok(partial.capture.processes.every(process => process.kind === 'run' && process.request.argv[1].endsWith('/setup-config.mjs')));
  await partial.invoke('turn.start', { agentId: 'native-agent', turnId: 'recovered-turn', text: 'The host now delivers turn.start.' },
    async e => ({ turnId: e.turnId }));
  assert.deepEqual(JSON.parse(fs.readFileSync(markerFile, 'utf8')), marker);
  assert.deepEqual((await partial.invoke('prompt.compose', { tools: ['Agent'] }, async () => ({ sections: [] }))).sections.map(section => section.id),
    []);
});

test('native starts leave a delayed unavailable observation intact without helper processes', async () => {
  const f = fixture('review-ok', 'native-worker', { memoryStore: true, hostOnly: true });
  let now = Date.now(), enter, release;
  f.$.clock.now = async () => now;
  const entered = new Promise(resolve => { enter = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const run = f.$.process.run;
  f.$.process.run = async (argv, init) => {
    if (argv[2] === 'native-unavailable') { enter(); await gate; }
    return run(argv, init);
  };
  const spawnAgent = id => f.invoke('agent.spawn', { subagentType: AGENT_TYPE, tool_use_id: `spawn-${id}`,
    name: id, permissionMode: 'default', prompt: 'Probe.' }, async () => ({ agentId: id }));
  const start = id => f.invoke('turn.start', { agentId: id, turnId: `turn-${id}`, text: 'Probe.' }, async e => e);
  await spawnAgent('missing');
  const pending = f.invoke('turn.step', { agentId: 'missing', turnId: 'turn-missing', index: 0 }, async function* () {
    assert.fail('A missing turn start must not reach the model');
  });
  await entered;
  const observedAt = now;
  now++;
  await spawnAgent('good'); await start('good');
  release(); await pending;
  const guidance = await f.invoke('prompt.compose', { tools: ['Agent'] }, async () => ({ sections: [] }));
  now++;
  await spawnAgent('another'); await start('another');
  const marker = JSON.parse(fs.readFileSync(`${f.root}/isolated/duet/native-unavailable.json`, 'utf8'));
  assert.deepEqual({ guidance: guidance.sections.map(section => section.id), marker,
    helpers: f.capture.processes.filter(p => p.request.argv[1]?.endsWith('/setup-config.mjs')).map(p => p.request.argv[2]) },
  { guidance: [], marker: { at: new Date(observedAt).toISOString(), reason: 'missing_turn_start' },
    helpers: ['native-unavailable', 'dispatch-status'] });
});

function replayCaptures() {
  if (captures.length === 8) {
    const source = '// Generated by native-integration.mjs from the real companion + fake Codex. Do not hand-edit.\n' +
      `export const captures = ${JSON.stringify(captures, null, 2)};\n`;
    const root = fs.mkdtempSync('/private/tmp/duet14-native-replay-');
    try {
      const copy = `${root}/plugins/codex`;
      fs.mkdirSync(`${copy}/.claude-plugin`, { recursive: true });
      fs.mkdirSync(`${copy}/tests`);
      fs.copyFileSync(`${plugin}/.claude-plugin/plugin.json`, `${copy}/.claude-plugin/plugin.json`);
      fs.cpSync(`${plugin}/types`, `${copy}/types`, { recursive: true });
      fs.cpSync(`${plugin}/hooks`, `${copy}/hooks`, { recursive: true });
      fs.mkdirSync(`${copy}/scripts/lib`, { recursive: true });
      fs.copyFileSync(`${plugin}/scripts/lib/agent-name-pool.mjs`, `${copy}/scripts/lib/agent-name-pool.mjs`);
      fs.copyFileSync(`${plugin}/scripts/lib/display-text.mjs`, `${copy}/scripts/lib/display-text.mjs`);
      fs.copyFileSync(`${plugin}/scripts/lib/roundtable-personas.mjs`, `${copy}/scripts/lib/roundtable-personas.mjs`);
      fs.copyFileSync(`${plugin}/tests/native-agent.test.ts`, `${copy}/tests/native-agent.test.ts`);
      fs.writeFileSync(`${copy}/tests/native-captures.mjs`, source);
      // Captures contain varying job ids, timings and process chunk boundaries.
      // Replay the actual fresh evidence through Claude's hook engine instead
      // of weakening a snapshot comparison by removing those fields.
      const replay = spawnSync('claude', ['plugin', 'test', copy], { encoding: 'utf8', timeout: 60000 });
      assert.equal(replay.status, 0, replay.error?.message || `${replay.stdout}\n${replay.stderr}`);
      if (process.env.UPDATE_NATIVE_CAPTURES === '1') {
        fs.writeFileSync(new URL('./native-captures.mjs', import.meta.url), source);
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
}

async function cleanupFixtures() {
  // Only processes registered by our isolated runtimes; never user jobs.
  for (const root of roots) {
    const directory = `${root}/processes`;
    const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; } };
    const survivors = () => (fs.existsSync(directory) ? fs.readdirSync(directory) : [])
      .map(name => JSON.parse(fs.readFileSync(`${directory}/${name}`, 'utf8'))).filter(record => !record.exited && alive(record.pid));
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      const deadline = Date.now() + 1000;
      do {
        const pending = survivors();
        if (!pending.length) break;
        for (const record of pending) {
          try { process.kill(record.pid, signal); } catch (e) { if (e.code !== 'ESRCH') throw e; }
        }
        await delay(25);
      } while (Date.now() < deadline);
    }
    assert.deepEqual(survivors().map(record => record.pid), [], 'No fixture-owned process may survive teardown');
  }
}

after(async () => {
  try { replayCaptures(); }
  finally {
    try { await cleanupFixtures(); }
    finally { fs.rmSync(cacheRoot, { recursive: true, force: true }); }
  }
});
