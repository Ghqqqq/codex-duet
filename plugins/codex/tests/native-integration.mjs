// Run: node --test plugins/codex/tests/native-integration.mjs
// Replays fresh real-companion captures from a temporary plugin copy.
// Set UPDATE_NATIVE_CAPTURES=1 to also replace the tracked replay fixtures.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { installFakeCodex } from '../../../tests/fake-codex-fixture.mjs';
import { register } from '../hooks/register.mjs';
import { AGENT_TYPE } from '../hooks/native-agent.mjs';
import { AGENT_NAMES } from '../scripts/lib/agent-names.mjs';
import { instructionInventory } from '../hooks/claude-memory.mjs';
import { EXECUTOR_FRAMING, writeClaudeSnapshot } from '../scripts/lib/claude-memory.mjs';
import { isC2Report } from '../scripts/lib/report-delivery.mjs';
import { updateJob } from '../scripts/lib/state.mjs';
import { register as reportHooks } from '../hooks/report-delivery.mjs';

const plugin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const captures = [];
const roots = [];
const clone = value => JSON.parse(JSON.stringify(value));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (const deadline = Date.now() + 20000; Date.now() < deadline; await delay(25)) {
    const value = check();
    if (value) return value;
  }
  throw new Error('Fixture did not reach the expected state');
}

function fixture(behavior, name = 'native-worker') {
  const root = fs.mkdtempSync('/private/tmp/duet14-g-');
  roots.push(root);
  for (const part of ['bin', 'repo', 'home', 'normal']) fs.mkdirSync(`${root}/${part}`);
  installFakeCodex(`${root}/bin`, behavior);
  spawnSync('git', ['init', '-q', `${root}/repo`]);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('CODEX_') || key.startsWith('CLAUDE_')) delete env[key];
  Object.assign(env, { HOME: `${root}/home`, USERPROFILE: `${root}/home`, CODEX_HOME: `${root}/normal`,
    CODEX_SQLITE_HOME: `${root}/normal`, CODEX_COMPANION_NORMAL_HOME: `${root}/normal`, CODEX_COMPANION_NORMAL_SQLITE_HOME: `${root}/normal`,
    CODEX_COMPANION_HOME: `${root}/isolated`, CODEX_COMPANION_BIN: `${root}/bin/codex`,
    CLAUDE_PLUGIN_DATA: `${root}/data`, CODEX_COMPANION_TEST_MODE: '1', CODEX_COMPANION_TEST_ROOT: root,
    CODEX_COMPANION_TEST_PROCESSES: `${root}/processes`, CODEX_COMPANION_BROKER_IDLE_SEC: '2' });
  const storeFile = `${root}/adapter-store.json`;
  fs.writeFileSync(storeFile, '{}');
  const readStore = () => JSON.parse(fs.readFileSync(storeFile, 'utf8'));
  const jobs = () => {
    const directory = `${root}/isolated/duet/sessions/native-session`;
    return fs.existsSync(directory) ? fs.readdirSync(directory).filter(name => name.endsWith('.json')).map(name => {
      const marker = JSON.parse(fs.readFileSync(`${directory}/${name}`, 'utf8'));
      return JSON.parse(fs.readFileSync(marker.jobFile, 'utf8'));
    }) : [];
  };
  const capture = { behavior, events: [], processes: [], notices: [] };
  let now = 1800000000000;
  const timers = new Set();
  let controller = new AbortController(), agents = [], hooks;
  let modelCalls = 0, onWait, syntheticUsage;
  const $ = {
    plugin: { name: 'codex', root: plugin },
    session: { id: async () => 'native-session', cwd: async () => `${root}/repo`, root: async () => `${root}/repo`,
      append: async notice => { capture.notices.push(clone(notice)); return { message: notice.message, uuid: String(capture.notices.length) }; } },
    agent: { list: async () => agents },
    env: { get: async name => env[name], set: async (name, value) => { env[name] = value; } },
    clock: { now: async () => now, every(ms, fn) {
      const timer = { ms, due: now + ms, fn }; timers.add(timer);
      return { cancel: () => timers.delete(timer) };
    }, after(ms, fn) {
      const timer = { ms, due: now + ms, fn, once: true }; timers.add(timer);
      return { cancel: () => timers.delete(timer) };
    } },
    fs: { stat: async file => ({ kind: fs.statSync(file).isDirectory() ? 'dir' : 'file', realPath: fs.realpathSync(file) }),
      write: async (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); } },
    store: {
      get: async key => readStore()[key],
      keys: async () => Object.keys(readStore()),
      delete: async key => { const data = readStore(); delete data[key]; fs.writeFileSync(storeFile, JSON.stringify(data)); },
      set: async (key, value) => fs.writeFileSync(storeFile, JSON.stringify({ ...readStore(), [key]: value })),
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
    hooks = new Map();
    install((event, matcher, fn) => {
      if (typeof matcher === 'function') fn = matcher;
      const entry = { fn }; hooks.set(event, entry);
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
    const hook = hooks.get(event);
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
    const toolUseId = options.agentId ? `spawn-${agentId}-${number}` : `spawn-${number}`;
    let agentName = number > 1 ? agents.find(agent => agent.id === agentId)?.name ?? name : name;
    if (options.toolCall || options.effort || agentName === null) await invoke('tool.call', { tool: 'Agent', tool_use_id: toolUseId,
      subagent_type: AGENT_TYPE, description: 'Native fake task', prompt: text, effort: options.effort,
      ...(agentName === null ? {} : { name: agentName }), ...(number > 1 ? { resume: agentId } : {}) },
    async e => { agentName = e.name; return options.toolResult ?? { result: {} }; });
    const spawnInput = { tool_use_id: toolUseId, prompt: text, description: 'Native fake task',
      subagentType: AGENT_TYPE, provider: { plugin: 'codex', tier: 'user' }, parentModel: 'haiku',
      background: options.background ?? true, permissionMode: options.permissionMode ?? 'default',
      fork: false, name: agentName, cwd: `${root}/repo`,
      ...(number > 1 ? { resume: { agentId } } : {}) };
    const spawning = invoke('agent.spawn', spawnInput, async e => {
      rewritten = e.prompt;
      agents = [...agents.filter(agent => agent.id !== agentId), { id: agentId, type: AGENT_TYPE, name: e.name, description: e.description, status: 'running' }];
      return { model: 'haiku', agentId };
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
    // Only fixture paths are replaced; every report/chunk originated in a child.
    const clean = JSON.stringify(capture).replaceAll(process.execPath, '/host/node').replaceAll(plugin, '/plugin').replaceAll(root, '/private/tmp/duet14-g-fixture');
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
    setStore: data => fs.writeFileSync(storeFile, JSON.stringify(data)),
    codexState: () => JSON.parse(fs.readFileSync(`${root}/bin/fake-codex-state.json`, 'utf8')),
    // Stop as a person would: after the early handle lookup has run.
    stopOnWait: (beforeStop = async () => {}) => { onWait = async () => { await advance(1500); await beforeStop(); controller.abort(); }; },
  };
}

test('real companion: dispatch, completion and reload follow-up reuse the Codex thread/cwd without a model', async () => {
  const f = fixture('slow-recovery-task', 'f7-x');
  f.env.CODEX_FIXTURE_TURN_GATE = `${f.root}/finish-turn`;
  const pending = f.turn('Perform the first fake assignment.', 1);
  // Gate completion on observed renewals, not a wall-clock sleep. Throughout
  // the quiet stream, the original task must remain the sole attached owner.
  const attached = await until(() => f.jobs().find(job => job.ownerAttached && job.turnId));
  assert.equal(attached.agentName, 'f7-x');
  let renewed = attached;
  for (let i = 0; i < 3; i++) {
    renewed = await until(() => f.jobs().find(job => job.leaseRenewedAt > renewed.leaseRenewedAt));
    assert.equal(renewed.ownerWaitPid, attached.ownerWaitPid);
    assert.equal(renewed.ownerWaitToken, attached.ownerWaitToken);
    assert.equal(renewed.ownerAttachedAt, attached.ownerAttachedAt);
    assert.equal(renewed.ownerAttached, true);
    assert.equal(renewed.ownerDetachedAt, null);
    assert.equal(renewed.status, 'running');
  }
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
  const status = spawnSync(process.execPath, [plugin + '/bin/duet', 'status', first.worker,
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
  assert.equal(first.next, 'SendMessage to f7-x to continue');
  assert.equal(first.details, `duet result '${first.jobId}' --details`);
  assert.deepEqual(Object.keys(first).slice(0, 4), ['status', 'worker', 'jobId', 'summary']);
  const state = Object.values(f.readStore())[0];
  assert.equal(state.incoming, undefined);
  assert.equal(state.session, 'native-session');
  assert.ok(state.intent.nonce);
  for (const child of f.capture.processes.filter(p => p.kind === 'spawn')) {
    assert.equal(child.request.argv[1], plugin + '/bin/duet');
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

  // Exercise the pre-spawn Agent-tool rewrite with the real companion. Keep
  // the existing explicit-name capture intact for its host replay contracts.
  const originalResult = { ref: 'fixture-result', text: 'Original mapped result', context: ['Fixture context'],
    isReadOnly: true, result: { status: 'completed', agentId: 'native-agent', totalTokens: 9,
      content: [{ type: 'text', text: 'Fixture report', citations: [] }, { type: 'text', text: 'Existing note' }] } };
  const assertNamingResult = (response, changed) => {
    if (!changed) return assert.equal(response, originalResult);
    // The naming note rides in context; the tool's own result is untouched.
    assert.deepEqual(response.result, originalResult.result);
    assert.equal(response.context.length, originalResult.context.length + 1);
    assert.deepEqual({ ...response, context: response.context.slice(0, -1) }, originalResult);
    assert.equal(typeof response.context.at(-1), 'string');
  };
  const auto = fixture('review-ok', null);
  const firstAuto = await auto.turn('Choose the first native name.', 1, false, { toolResult: originalResult });
  assertNamingResult(auto.capture.events.find(e => e.event === 'tool.call').result, true);
  const spawnedName = auto.capture.events.find(e => e.event === 'agent.spawn').input.name;
  assert.ok(AGENT_NAMES.includes(spawnedName));
  assert.equal((await auto.$.agent.list())[0].name, spawnedName);
  assert.equal(firstAuto.worker, spawnedName);
  assert.equal(auto.jobs()[0].agentName, spawnedName);
  const reservation = auto.capture.processes.filter(p => p.request.argv[2] === 'reserve-name');
  assert.equal(reservation.length, 1);
  assert.equal(reservation[0].request.init.timeoutMs, 2000);
  const freshTask = auto.capture.processes.find(p => p.request.argv[2] === 'task').request.argv;
  assert.equal(freshTask[freshTask.indexOf('--agent-name') + 1], spawnedName);
  const autoStatus = spawnSync(process.execPath, [plugin + '/bin/duet', 'status', spawnedName,
    '--cwd', `${auto.root}/repo`, '--session', 'native-session', '--json'], { env: auto.env, encoding: 'utf8' });
  assert.equal(autoStatus.status, 0, autoStatus.stderr);
  assert.equal(JSON.parse(autoStatus.stdout).job.agentName, spawnedName);
  const bash = spawnSync(process.execPath, [plugin + '/bin/duet', 'task', '--fresh', '--session', 'native-session'],
    { cwd: `${auto.root}/repo`, env: auto.env, input: 'Reserve an intervening Bash worker.', encoding: 'utf8' });
  assert.equal(bash.status, 0, bash.stderr);
  const bashName = JSON.parse(bash.stdout.trimEnd().split('\n').at(-1)).worker;
  const secondAuto = await auto.turn('Choose the second native name.', 1, false, { agentId: 'native-second', toolResult: originalResult });
  assert.ok(AGENT_NAMES.includes(secondAuto.worker));
  assert.equal(new Set([spawnedName, secondAuto.worker, bashName]).size, 3);
  assert.equal((await auto.$.agent.list()).find(agent => agent.id === 'native-second').name, secondAuto.worker);
  auto.reload();
  const autoFollowup = await auto.turn('Continue the first named native worker.', 2, false,
    { toolCall: true, toolResult: originalResult });
  assertNamingResult(auto.capture.events.filter(e => e.event === 'tool.call').at(-1).result, false);
  assert.equal(autoFollowup.worker, spawnedName);
  assert.equal(auto.jobs().find(job => job.id === autoFollowup.jobId).threadId,
    auto.jobs().find(job => job.id === firstAuto.jobId).threadId);
  assert.equal(auto.capture.processes.filter(p => p.request.argv[2] === 'reserve-name').length, 2);

  // Labels are replaced before spawn; the pinned name survives SendMessage's
  // resumed spawn and the companion's thread continuation.
  const labeled = fixture('review-ok', 'f7-view');
  const firstLabeled = await labeled.turn('Use the assigned scientist name.', 1, false,
    { toolCall: true, toolResult: originalResult });
  const labeledSpawn = labeled.capture.events.find(e => e.event === 'agent.spawn').input;
  assert.ok(AGENT_NAMES.includes(labeledSpawn.name));
  assert.equal(labeledSpawn.name, firstLabeled.worker);
  assert.equal(labeledSpawn.description, 'Native fake task');
  assertNamingResult(labeled.capture.events.find(e => e.event === 'tool.call').result, true);
  const labeledFollowup = await labeled.turn('Continue through the assigned address.', 2, false,
    { toolCall: true, toolResult: originalResult });
  assert.equal(labeledFollowup.worker, firstLabeled.worker);
  assert.equal(labeled.jobs().find(job => job.id === labeledFollowup.jobId).threadId,
    labeled.jobs().find(job => job.id === firstLabeled.jobId).threadId);
  assert.equal(labeled.capture.events.filter(e => e.event === 'agent.spawn').at(-1).input.name, firstLabeled.worker);
  assert.equal(labeled.capture.processes.filter(p => p.request.argv[2] === 'reserve-name').length, 1);
  assertNamingResult(labeled.capture.events.filter(e => e.event === 'tool.call').at(-1).result, false);

  const preferred = fixture('review-ok', 'Noether');
  const firstPreferred = await preferred.turn('Reserve the free pool name.', 1, false,
    { toolCall: true, toolResult: originalResult });
  assert.equal(firstPreferred.worker, 'Noether');
  assert.equal(preferred.capture.events.find(e => e.event === 'agent.spawn').input.name, 'Noether');
  assertNamingResult(preferred.capture.events.find(e => e.event === 'tool.call').result, false);
  const takenPreferred = await preferred.turn('Reserve the taken pool name.', 1, false,
    { toolCall: true, toolResult: originalResult, agentId: 'native-taken' });
  assert.ok(AGENT_NAMES.includes(takenPreferred.worker));
  assert.notEqual(takenPreferred.worker, firstPreferred.worker);
  assert.equal(preferred.capture.events.filter(e => e.event === 'agent.spawn').at(-1).input.name, takenPreferred.worker);
  assertNamingResult(preferred.capture.events.filter(e => e.event === 'tool.call').at(-1).result, true);
  for (const reservation of preferred.capture.processes.filter(p => p.request.argv[2] === 'reserve-name')) {
    assert.equal(reservation.request.argv[reservation.request.argv.indexOf('--preferred') + 1], 'Noether');
  }
  for (const [name, isPreferred, unchanged] of [['nOeThEr', true, false], ['nOeThEr-2', true, true],
    ['Ada-10', true, true], ['', false, false], ['Noether-1', false, false], ['Noether-02', false, false]]) {
    let forwarded;
    const response = await preferred.invoke('tool.call', { tool: 'Agent', tool_use_id: 'pool-form',
      subagent_type: AGENT_TYPE, name, description: 'Explicit description', prompt: 'Fixture.' },
    async e => { forwarded = e; return originalResult; });
    assert.equal(forwarded.description, 'Explicit description');
    if (unchanged) assert.equal(forwarded.name, name);
    else { assert.ok(AGENT_NAMES.includes(forwarded.name)); assert.notEqual(forwarded.name.toLowerCase(), name.toLowerCase()); }
    assert.equal(preferred.capture.processes.at(-1).request.argv.includes('--preferred'), isPreferred);
    assertNamingResult(response, !unchanged);
  }
  // A missing or denied host result is returned as is; any other shape,
  // including a background launch acknowledgement, keeps its result and
  // gains the naming note in context. Nothing retries.
  for (const response of [null, { deny: 'Fixture refusal' }, { result: {} },
    { result: { status: 'async_launched', agentId: 'native-background', outputFile: '/fixture/output' } },
    { result: { content: 'Unexpected content shape' } }]) {
    let calls = 0;
    const returned = await preferred.invoke('tool.call', { tool: 'Agent', tool_use_id: 'result-shape',
      subagent_type: AGENT_TYPE, name: 'f7-view', prompt: 'Fixture.' }, async () => { calls++; return response; });
    if (!response || response.deny !== undefined) assert.equal(returned, response);
    else {
      assert.deepEqual(returned.result, response.result);
      assert.equal(returned.context.length, 1);
      assert.equal(typeof returned.context[0], 'string');
    }
    assert.equal(calls, 1);
  }

  // Other Agent types and resumptions never reserve or rewrite.
  const count = auto.capture.processes.length;
  for (const fields of [{ subagent_type: 'Explore', name: 'f7-view' }, { subagent_type: 'Explore' },
    { subagent_type: 'codex:codex-worker', name: 'Noether' }, { resume: 'native-agent', name: 'f7-view' }]) {
    const input = { tool: 'Agent', tool_use_id: 'untouched', subagent_type: AGENT_TYPE, prompt: 'Fixture.', ...fields };
    let forwarded;
    const response = await auto.invoke('tool.call', input, async e => { forwarded = e; return originalResult; });
    assert.deepEqual(forwarded, input);
    assert.equal(response, originalResult);
  }
  assert.equal(auto.capture.processes.length, count);

  for (const failure of ['exit', 'timeout', 'malformed', 'truncated']) {
    const fallback = fixture('review-ok', null), agentId = 'a1b2c3d4e5f60718';
    const run = fallback.$.process.run;
    let attempts = 0;
    fallback.$.process.run = async (argv, init) => {
      if (argv[2] !== 'reserve-name') return run(argv, init);
      attempts++;
      assert.equal(init.timeoutMs, 2000);
      if (failure === 'timeout') throw Object.assign(new Error('Fixture process timeout'), { code: 'ETIMEDOUT' });
      return { exitCode: failure === 'exit' ? 1 : 0,
        stdout: failure === 'malformed' ? '{' : '{"name":"Ada"}', isStdoutTruncated: failure === 'truncated' };
    };
    const report = await fallback.turn('Proceed after reservation failure.', 1, false, { agentId,
      // A host discovery row may itself use the id as a fallback display name.
      afterSpawn: async () => {
        const list = fallback.$.agent.list;
        fallback.$.agent.list = async () => (await list()).map(agent => ({ ...agent, name: agent.id }));
      } });
    assert.equal(attempts, 1);
    assert.equal(fallback.capture.events.find(e => e.event === 'agent.spawn').input.name, undefined);
    assert.equal(report.status, 'completed');
    assert.ok(AGENT_NAMES.includes(report.worker));
    assert.notEqual(report.worker, agentId);
    assert.equal(fallback.jobs()[0].agentName, report.worker);
    assert.equal(fallback.capture.processes.find(p => p.request.argv[2] === 'task').request.argv.includes('--agent-name'), false);
    for (const name of ['f7-view', 'Noether']) {
      const input = { tool: 'Agent', tool_use_id: 'failed-reservation', subagent_type: AGENT_TYPE,
        name, description: 'Explicit description', prompt: 'Fixture.' };
      let forwarded, calls = 0;
      const response = await fallback.invoke('tool.call', input, async e => { forwarded = e; calls++; return originalResult; });
      assert.deepEqual(forwarded, input);
      assert.equal(response, originalResult);
      assert.equal(calls, 1);
    }
    assert.equal(attempts, 3);
  }

  // Discovery failures and an exhausted shared budget also preserve the call.
  for (const failure of ['exit', 'timeout', 'invalid', 'expired']) {
    const fallback = fixture('review-ok');
    let probes = 0, reservations = 0, forwarded;
    fallback.$.process.run = async argv => {
      if (argv[2] === 'reserve-name') { reservations++; throw new Error('Unexpected reservation'); }
      probes++;
      if (failure === 'timeout') throw Object.assign(new Error('Fixture probe timeout'), { code: 'ETIMEDOUT' });
      if (failure === 'expired') fallback.$.clock.now = async () => 1800000002001;
      return { exitCode: failure === 'exit' ? 1 : 0, stdout: failure === 'invalid' ? 'relative-node' : process.execPath };
    };
    const input = { tool: 'Agent', tool_use_id: 'probe-failure', subagent_type: AGENT_TYPE, name: 'f7-view', prompt: 'Fixture.' };
    assert.equal(await fallback.invoke('tool.call', input, async e => { forwarded = e; return originalResult; }), originalResult);
    assert.deepEqual(forwarded, input);
    assert.equal(probes, 1);
    assert.equal(reservations, 0);
  }
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
    return sharedProbe.invoke('tool.call', input, async e => { forwarded++; assert.deepEqual(e, input); return originalResult; });
  });
  await until(() => probes === 1 && deadlines.length === 2);
  deadlines.forEach(expire => expire());
  assert.deepEqual(await Promise.all(probeWaiters), [originalResult, originalResult]);
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

test('real companion: question/answer stays on the job; abort interrupts fake Codex and persists cancellation', async t => {
  const question = fixture('parent-question-sequence');
  const asked = await question.turn('Ask the fake parent a question.', 1);
  assert.equal(asked.status, 'needs_answer'); assert.ok(asked.question.id);
  assert.equal(asked.next, 'SendMessage to native-worker with the answer');
  assert.ok(question.capture.notices.some(n => n.message.content[0].text === `? Waiting for Claude: ${asked.question.text}`));
  question.reload();
  // Entering plan mode cannot answer into a previously writable live turn.
  const inPlan = await question.turn('Do not resume writes from plan mode.', 2, false, { permissionMode: 'plan' });
  assert.equal(inPlan.blockers[0].code, 'native_plan_mode_read_only');
  assert.equal(question.capture.processes.filter(p => p.request.argv[2] === 'answer').length, 0);
  // Another owner path answers Q1 and the same job parks at Q2 before Claude's
  // delayed Q1 answer arrives. Never retarget that text to the new question.
  const jobBeforeAnswer = question.jobs()[0];
  const external = spawnSync(process.execPath, [plugin + '/bin/duet', 'answer', asked.jobId,
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
  const laterQuestion = await until(() => late.jobs().find(job => job.id === original.id)?.pendingQuestion?.id !== displayed.question.id
    && late.jobs().find(job => job.id === original.id)?.pendingQuestion);
  externalAnswer(laterQuestion);
  await until(() => late.jobs().find(job => job.id === original.id)?.status === 'completed');
  late.reload();
  const resolvedAnswer = await late.turn('Late Q1 answer', 2);
  assert.equal(resolvedAnswer.jobId, original.id); assert.equal(resolvedAnswer.status, 'completed');
  assert.equal(late.codexState().nextTurnId, 2);
  assert.equal(late.capture.processes.filter(p => p.kind === 'spawn' && p.request.argv[2] === 'task').length, 1);
  late.reload();
  const continuation = await late.turn('Start the next assignment.', 3);
  assert.notEqual(continuation.jobId, original.id);
  assert.equal(late.jobs().find(job => job.id === continuation.jobId).threadId, original.threadId);
  assert.equal(late.codexState().nextTurnId, 3);

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
    const external = spawnSync(process.execPath, [plugin + '/bin/duet', 'answer', q1.jobId,
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
  assert.equal(stopped.next, 'SendMessage to native-worker to continue');
  assert.equal(stopped.details, `duet result '${job.id}' --details`);
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
  const startup = fixture('slow-task'), binary = startup.env.CODEX_COMPANION_BIN;
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

  // Exercise completion after the worker has already recorded its interrupt,
  // and a real duet cancel racing the native stop. User cancellation keeps its
  // own status/reason; /tasks alone always records owner_stopped.
  for (const userCancel of [false, true]) {
    const other = fixture('interruptible-slow-task');
    other.stopOnWait(async () => {
      if (!userCancel) return;
      const result = spawnSync(process.execPath, [plugin + '/bin/duet', 'cancel', other.jobs()[0].id, '--json',
        '--cwd', `${other.root}/repo`, '--session', 'native-session'], { env: other.env, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      const report = JSON.parse(result.stdout);
      assert.equal(report.status, 'cancelled');
      assert.equal(report.reason, 'cancelled_by_user');
      assert.equal(report.confirmation, 'confirmed');
    });
    await other.turn('Run until stopped.', 1, true, { beforeComplete: () => until(() =>
      other.jobs().every(job => !['queued', 'running'].includes(job.status))) });
    const job = other.jobs()[0], state = Object.values(other.readStore()).find(value => value.v === 2);
    assert.equal(job.status, userCancel ? 'cancelled' : 'interrupted');
    assert.equal(job.result.interruptionReason, userCancel ? 'cancelled_by_user' : 'owner_stopped');
    assert.equal(state.status, job.status);
    assert.equal(state.cancellation.reason, job.result.interruptionReason);
    assert.equal(state.cancellation.confirmation, 'confirmed');
  }

  // A dead wrapper cannot observe its owner's stop. The adapter must retain
  // duet cancel's app-server recovery path to interrupt the unresolved turn.
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
  assert.equal(fallback.length, 1, 'A stopped dead wrapper requires the duet cancel safety net');
  assert.ok(waitIndex >= 0 && waitIndex < cancelIndex, 'Read-only owner-stop confirmation precedes the fallback cancel');
  assert.ok(['interrupted', 'cancelled'].includes(deadJob.status));
  assert.equal(deadJob.result.interruptionConfirmed, true);
  assert.deepEqual(dead.codexState().lastInterrupt, { threadId: deadJob.threadId, turnId: deadJob.turnId });
  assert.equal(deadState.cancellation.confirmation, 'confirmed');
  assert.equal(deadState.status, deadJob.status);
});

// Job reads are independent test assertions, outside the captured hook boundary.
function inspect(f, id) {
  const result = spawnSync(process.execPath, [plugin + '/bin/duet', 'status', ...(id ? [id] : []), '--all', '--json',
    '--cwd', `${f.root}/repo`, '--session', 'native-session'], { env: f.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('dispatch intent survives the response/persistence gap and nonce retries reserve only one job', async () => {
  const f = fixture('slow-task');
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
  const retry = spawnSync(process.execPath, [plugin + '/bin/duet', 'task', '--fresh', '--dispatch-nonce', before.dispatchNonce,
    '--quiet', '--timeout-sec', '1', '--cwd', `${f.root}/repo`, '--session', 'native-session'],
    { env: f.env, input: 'Dispatch exactly once.', encoding: 'utf8' });
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal(JSON.parse(retry.stdout.trim()).jobId, first.jobId);
  assert.equal(f.codexState().nextTurnId, 2);
  const listed = inspect(f);
  assert.equal([...(listed.running || []), listed.latestFinished, ...(listed.recent || [])].filter(Boolean).length, 1);
  f.save();
});

test('DUET first-line flags and fork carry captured instructions to the imported thread; invalid flags dispatch nothing', async t => {
  const f = fixture('slow-task');
  const cwd = `${f.root}/work tree`;
  fs.mkdirSync(cwd); spawnSync('git', ['init', '-q', cwd]);
  const source = `${f.root}/home/.claude/projects/-repo/native-session.jsonl`;
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, JSON.stringify({ type: 'user', message: { content: 'Synthetic prior request.' } }) + '\n');
  f.env.CODEX_COMPANION_TRANSCRIPT_PATH = source;
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
  const job = JSON.parse(spawnSync(process.execPath, [plugin + '/bin/duet', 'status', result.jobId, '--json', '--cwd', cwd,
    '--session', 'native-session'], { env: f.env, encoding: 'utf8' }).stdout).job;
  assert.equal(job.request.model, 'gpt-6-sol'); assert.equal(job.request.effort, 'high');
  assert.equal(job.request.sandbox, 'read-only'); assert.equal(job.request.serviceTier, 'priority');
  assert.equal(job.request.prompt, brief);
  const runtime = f.codexState(), imported = runtime.lastExternalAgentImport;
  const instructions = EXECUTOR_FRAMING + '\n\n### /captured/CLAUDE.md\nFORK_RULE_SENTINEL';
  assert.equal(job.request.forked, true);
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
  t.diagnostic(JSON.stringify({ header: 'DUET: --fork', command: 'duet task --fork', status: result.status,
    importId: imported.importId, importedThread: imported.threadId, resumedThread: runtime.lastThreadResume.threadId,
    turnThread: runtime.lastTurnStart.threadId, claudeMdSource: job.request.claudeMd.source,
    developerInstructions: runtime.lastThreadResume.developerInstructions, nativeReportMatchesC2: true }));
  f.save();

  const invalid = fixture('slow-task');
  const rejected = await invalid.turn('DUET: --approve-browser-origin https://example.test\nNever dispatch.', 1, false, { effort: 'high' });
  assert.equal(rejected.status, 'blocked');
  assert.ok(rejected.summary.includes('--model'));
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
  const planned = await invalid.turn('DUET: --effort low\nContinue planning.', 8, false, { permissionMode: 'plan' });
  assert.equal(planned.status, 'completed');
  assert.equal(setting(tasks().at(-1).request, '--sandbox'), 'read-only');
  assert.equal(setting(tasks().at(-1).request, '--effort'), 'low');
  assert.deepEqual(planned.usage, usage);
  const notices = invalid.capture.notices.slice(noticeCount).filter(n => n.message.content[0].text.includes('12,345'));
  assert.equal(notices.length, 1);
  assert.ok(notices[0].message.content[0].text.includes('8,000'));
  assert.ok(notices[0].message.content[0].text.includes('678'));

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
  for (const [effort, header, expected] of [[undefined, '', 'xhigh'], ['high', 'DUET: --effort low\n', 'low'], ['max', '', 'max']]) {
    const effortFixture = fixture('slow-task');
    const completed = await effortFixture.turn(header + 'Check effort precedence.', 1, false, { effort, background: false });
    assert.equal(completed.status, 'completed');
    assert.equal(effortFixture.jobs()[0].request.effort, expected);
    const request = effortFixture.capture.processes.find(p => p.request.argv[2] === 'task').request;
    if (!effort) assert.equal(request.argv.includes('--effort'), false);
    else assert.equal(setting(request, '--effort'), expected);
  }
  const symlinked = fixture('slow-task');
  fs.symlinkSync(`${symlinked.root}/repo`, `${symlinked.root}/linked`);
  symlinked.$.session.cwd = async () => `${symlinked.root}/linked`;
  assert.equal((await symlinked.turn('Start in a symlinked workspace.', 1)).status, 'completed');
  symlinked.reload();
  assert.equal((await symlinked.turn('DUET: --cwd .\nContinue in the same workspace.', 2)).status, 'completed');
  assert.equal(Object.values(symlinked.readStore()).find(s => s.agentId === 'native-agent').cwd, `${symlinked.root}/repo`);
  assert.equal(symlinked.codexState().threads.length, 1);

  const planFirst = fixture('slow-task');
  const planBlocked = await planFirst.turn('DUET: --sandbox danger-full-access\nReject writable first launch.', 1, false, { permissionMode: 'plan' });
  assert.equal(planBlocked.blockers[0].code, 'native_plan_mode_read_only');
  assert.equal(planFirst.jobs().length, 0);
  assert.equal(planFirst.capture.processes.length, 0);
  planFirst.reload();
  assert.equal((await planFirst.turn('Corrected first plan.', 2, false, { permissionMode: 'plan' })).status, 'completed');
  assert.equal(planFirst.jobs()[0].request.sandbox, 'read-only');

  // The host can continue a spawned agent after the hook's binding write fails.
  // Memory recovers mode/effort; a reload with only the failure guard blocks.
  for (const [header, resume, reload] of [
    ['DUET: --sandbox workspace-write\n', false, false], ['', false, false],
    ['DUET: --sandbox workspace-write\n', true, false], ['', true, true],
  ]) {
    const binding = fixture('slow-task');
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
  const guardOnly = fixture('slow-task'), storeCalls = [];
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
    const rejected = fixture('slow-task'), run = rejected.$.process.run, spawn = rejected.$.process.spawn, set = rejected.$.store.set;
    let injected = false;
    const fail = () => { injected = true; throw new Error('Definitive pre-launch failure'); };
    if (fault === 'node') rejected.$.process.run = async (argv, init) => !injected && argv[0] === 'node' ? fail() : run(argv, init);
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
  assert.equal((await terminal.turn('Fail the exact fake turn.', 1)).status, 'blocked');
  assert.equal(terminalFailed, true);
  terminal.reload();
  assert.equal((await terminal.turn('Continue after the confirmed failure.', 2)).status, 'completed');

  const overlap = fixture('slow-task'), now = overlap.$.clock.now;
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
  const history = fixture('slow-task');
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
    return { exitCode: 0, stdout: JSON.stringify({ running: [], latestFinished: null,
      recent: fullLookup ? indexedJobs.filter(job => job.dispatchNonce === nonce) : indexedJobs.slice(-50) }), isStdoutTruncated: false };
  };
  const recovered = await history.turn('Continue beyond visible history.', 2);
  assert.equal(fullLookup, true);
  assert.equal(recovered.status, 'completed');
  assert.equal(history.jobs().find(job => job.id === recovered.jobId).threadId,
    history.jobs().find(job => job.id === historical.jobId).threadId);

  const outage = fixture('slow-task');
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
    const lookup = fixture('slow-task'), run = lookup.$.process.run;
    lookup.$.process.run = async (argv, init) => argv[2] === 'status'
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
    const uncertain = fixture('slow-task'), run = uncertain.$.process.run;
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
    const f = fixture('slow-task'), owner = deferred();
    let job, launches = 0, consumed = 0, closed = 0;
    f.$.agent.list = async () => [{ id: 'native-agent', type: AGENT_TYPE }];
    f.$.ui = { invalidate() {}, log() {} };
    f.setStore({ [key]: { v: 2, type: AGENT_TYPE, session: 'native-session', agentId: 'native-agent',
      cwd: `${f.root}/repo`, incoming: { turnId: 'turn-1', text: 'First brief.' },
      notices: { turnId: 'turn-1', count: 0, started: true } } });
    f.$.process.run = async argv => argv[0] === 'node' ? { exitCode: 0, stdout: process.execPath }
      : { exitCode: 0, stdout: JSON.stringify({ job }) };
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
  const parallel = fixture('slow-task');
  parallel.setStore(Object.fromEntries(Array.from({ length: 127 }, (_, i) => [
    `native:v2:active:${i}`, { v: 2, type: AGENT_TYPE, status: 'running' } ])));
  await Promise.all(['a', 'b'].map(id => spawnAgent(parallel, id)));
  await Promise.all(['a', 'b'].map(id => start(parallel, id)));
  const count = Object.keys(parallel.readStore()).filter(key => key.startsWith('native:v2:')).length;
  const refusedId = ['a', 'b'].find(id => !parallel.readStore()[`native:v2:native-session:${id}`]);
  const refusal = refusedId ? (await step(parallel, refusedId, `turn-${refusedId}`)).blockers[0].code : null;
  const sized = fixture('slow-task'), set = sized.$.store.set;
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
  const orphans = fixture('slow-task'), now = await orphans.$.clock.now();
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
  const guardSize = fixture('slow-task');
  guardSize.setStore({ [guard('fresh')]: { at: now, padding: 'x'.repeat(524288) } });
  await spawnAgent(guardSize, 'new'); await start(guardSize, 'new');
  const guardBudget = !guardSize.readStore()['native:v2:native-session:new']
    && (await step(guardSize, 'new', 'turn-new')).blockers[0].code === 'native_capacity';
  return { races, failures, admission: { count, refusal }, size: { withinBudget: size <= 2 * 1024 * 1024, bytes: size,
    records: admitted.length, capacityRefusals, failedWrites },
    orphans: orphanEvidence, guardBudget };
}

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
  const f = fixture('slow-task');
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
  const history = fixture('slow-task');
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

  const sized = fixture('slow-task'), largeHistory = seed(sized, 3, 'x'.repeat(250000));
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
  const full = fixture('slow-task');
  full.setStore({ ...Object.fromEntries(Array.from({ length: 124 }, (_, i) => [
    `native:v2:active:${i}`, { v: 2, type: AGENT_TYPE, status: 'running' },
  ])), ...protectedStates });
  assert.equal((await full.turn('Keep every active slot.', 1)).blockers[0].code, 'native_capacity');
  assert.equal(records(full).length, 128);
  assert.equal(full.capture.processes.length, 0);
  for (const [key, state] of Object.entries(protectedStates)) assert.deepEqual(full.readStore()[key], state);

  // A legacy spawn gets a full observation window, restarted by a reload.
  const unstarted = fixture('slow-task');
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

  const oversized = fixture('slow-task');
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
  const cancelled = fixture('slow-task'), cancelledKey = 'native:v2:native-session:stopped';
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
    const settled = fixture('slow-task'), state = clone(unresolved);
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
  const failed = fixture('slow-task'), failedState = { ...unresolved, status: 'failed', finishedAt: 1800000000000 - 1000 };
  delete failedState.cancellation;
  failed.setStore({ ...activeRecords(127), [cancelledKey]: failedState });
  await admit(failed, 'contender');
  const failedEvidence = { kept: !!failed.readStore()[cancelledKey],
    admitted: !!failed.readStore()['native:v2:native-session:contender'], records: records(failed).length };

  const pendingEvidence = [];
  for (const protection of ['memory', 'guard', 'expired-guard']) {
    const pending = fixture('slow-task');
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

  const rejectedHistory = fixture('slow-task');
  seed(rejectedHistory, 128);
  const largeReport = await rejectedHistory.turn('x'.repeat(65537), 1);
  const oversizedEvidence = { code: largeReport.blockers[0].code, oldestKept: !!rejectedHistory.readStore()['native:v2:history:0'],
    records: records(rejectedHistory).length, processCalls: rejectedHistory.capture.processes.length };

  const refusalEvidence = [];
  for (const code of ['native_message_too_large', 'native_capacity']) {
    const healthy = fixture('slow-task'), guardKey = 'native:binding-failed:v1:native-session:native-agent';
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
  const f = fixture('slow-task');
  const event = { session_id: 'native-session', cwd: `${f.root}/repo`, source: 'startup' };
  f.env.CLAUDE_ENV_FILE = `${f.root}/claude-env`;
  const child = spawnSync(process.execPath, [plugin + '/scripts/session-lifecycle-hook.mjs', 'SessionStart'],
    { env: f.env, cwd: event.cwd, input: JSON.stringify(event), encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.ok(JSON.parse(child.stdout).hookSpecificOutput.additionalContext.split('\n')[0].includes('codex:codex-native'));
  assert.ok(fs.readFileSync(f.env.CLAUDE_ENV_FILE, 'utf8').includes(`export CODEX_COMPANION_SESSION_CWD='${event.cwd}'`));
  assert.ok(!fs.existsSync(`${f.root}/data/native-ready`));
  // The function sandbox cannot see CLAUDE_PLUGIN_DATA; readiness needs no env.
  f.$.env.get = async () => undefined;
  // Dispatch guidance lives in the per-request system prompt, so compaction
  // cannot remove it; requests without the Agent tool do not get it.
  const compose = tools => f.invoke('prompt.compose', { model: 'm', promptModel: 'm', surfaces: [], tools, outputStyle: null, traits: [] },
    async () => ({ sections: [{ id: 'intro', text: 'Intro', scope: 'shared' }] }));
  const guided = await compose(['Agent', 'Bash']);
  assert.deepEqual(guided.sections.map(section => [section.id, section.scope]), [['intro', 'shared'], ['codex:native-dispatch', 'session']]);
  assert.ok(guided.sections[1].text.includes('codex:codex-native'));
  assert.deepEqual((await compose(['Bash'])).sections.map(section => section.id), ['intro']);
  const submit = origin => f.invoke('prompt.submit', { text: 'Hello', wait: false, origin: { kind: origin }, context: ['Existing context'] },
    async e => ({ text: e.text, context: e.context, origin: e.origin }));
  assert.deepEqual((await submit('plugin')).context, ['Existing context']);
  const command = await f.invoke('prompt.submit', { text: '/reload-plugins', command: { name: 'reload-plugins' }, wait: false, origin: { kind: 'composer' } },
    async e => ({ text: e.text, context: e.context, origin: e.origin }));
  assert.equal(command.context, undefined);
  const first = await submit('composer');
  assert.equal(first.context.length, 2);
  assert.equal(first.context[1], 'Native Codex workers ready: Agent(subagent_type: "codex:codex-native", prompt) — optional first line "DUET: <flags>"; SendMessage to continue or answer; stop from /tasks; live progress shows inside the agent and in codex-live.');
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

test('first native turn stays model-free when discovery is missing or rejects and there is no stored binding', async () => {
  for (const missing of [true, false]) {
    const f = fixture('slow-task');
    if (missing) delete f.$.agent.list;
    else f.$.agent.list = async () => { throw new Error('Discovery unavailable'); };
    await f.invoke('classic.SubagentStart', { session_id: 'native-session', agent_id: 'native-agent', agent_type: AGENT_TYPE }, async () => ({}));
    assert.deepEqual(f.readStore(), {});
    const report = await f.turn('DUET: --unsupported\nDo not dispatch.', 1);
    assert.equal(report.status, 'blocked');
    assert.equal(f.capture.processes.length, 0);
  }
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
      fs.cpSync(`${plugin}/hooks`, `${copy}/hooks`, { recursive: true });
      fs.mkdirSync(`${copy}/scripts/lib`, { recursive: true });
      fs.copyFileSync(`${plugin}/scripts/lib/agent-name-pool.mjs`, `${copy}/scripts/lib/agent-name-pool.mjs`);
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
  finally { await cleanupFixtures(); }
});
