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

function fixture(behavior) {
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
  function reload(record = true) {
    if (record) capture.events.push({ event: 'reload', store: readStore() });
    hooks = new Map();
    register((event, matcher, fn) => {
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
    if (options.effort) await invoke('tool.call', { tool: 'Agent', tool_use_id: `spawn-${number}`,
      subagent_type: AGENT_TYPE, description: 'Native fake task', prompt: text, effort: options.effort }, async () => ({ result: {} }));
    const spawnInput = { tool_use_id: `spawn-${number}`, prompt: text, description: 'Native fake task',
      subagentType: AGENT_TYPE, provider: { plugin: 'codex', tier: 'user' }, parentModel: 'haiku',
      background: options.background ?? true, permissionMode: options.permissionMode ?? 'default',
      fork: false, name: 'native-worker', cwd: `${root}/repo`,
      ...(number > 1 ? { resume: { agentId: 'native-agent' } } : {}) };
    const spawning = invoke('agent.spawn', spawnInput, async e => {
      rewritten = e.prompt;
      agents = [{ id: 'native-agent', type: AGENT_TYPE, name: 'native-worker', description: e.description, status: 'running' }];
      return { model: 'haiku', agentId: 'native-agent' };
    });
    await spawning;
    await options.afterSpawn?.();
    await invoke('turn.start', { agentId: 'native-agent', turnId: `turn-${number}`, text: rewritten }, async e => ({ turnId: e.turnId }));
    const result = await invoke('turn.step', { agentId: 'native-agent', turnId: `turn-${number}`, index: 0, model: 'haiku', effort: 'low', messageCount: 1 }, async function* () {
      modelCalls++; throw new Error('Claude model bottom was reached');
    });
    if (aborted) controller = new AbortController();
    await options.beforeComplete?.();
    const completion = await invoke('turn.complete', { agentId: 'native-agent', turnId: `turn-${number}`,
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
  const f = fixture('slow-recovery-task');
  f.env.CODEX_FIXTURE_TURN_GATE = `${f.root}/finish-turn`;
  const pending = f.turn('Perform the first fake assignment.', 1);
  // Gate completion on observed renewals, not a wall-clock sleep. Throughout
  // the quiet stream, the original task must remain the sole attached owner.
  const attached = await until(() => f.jobs().find(job => job.ownerAttached && job.turnId));
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
  assert.equal(live.length, 24);
  assert.ok(live.every(c => c.kind === 'thinking' && /^Codex worker .+ running · /.test(c.text)));
  assert.ok(live.at(-1).text.endsWith(' running · 12m 0s'));
  assert.equal(ownerCalls[0].exit, undefined);
  const intent = Object.values(f.readStore())[0].intent;
  assert.equal(attached.dispatchNonce, intent.nonce);
  fs.writeFileSync(f.env.CODEX_FIXTURE_TURN_GATE, 'finish');
  const first = await pending;
  assert.equal(first.status, 'completed'); assert.ok(first.summary);
  assert.equal(f.timers.size, 0);
  const step = f.capture.events.find(e => e.event === 'turn.step');
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
  const final = f.codexState();
  assert.equal(final.threads.length, 1);
  assert.equal(final.lastTurnStart.threadId, initial.lastTurnStart.threadId);
  assert.equal(final.threads[0].cwd, `${f.root}/repo`);
  assert.equal(Object.values(f.readStore())[0].cwd, `${f.root}/repo`);
  assert.equal(final.nextTurnId, 3);
  assert.equal(f.capture.processes.filter(p => p.kind === 'spawn' && p.request.argv[2] === 'wait').length, 0);
  assert.notEqual(second.jobId, first.jobId);
  assert.equal(first.next, 'SendMessage to native-worker to continue');
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
    assert.ok(!child.request.argv.includes('--quiet'));
    assert.ok(!child.request.argv.includes(child.request.input) || !child.request.input);
  }
  f.save();
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
  assert.equal(invalid.capture.processes.length, 0);

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
    assert.equal(injected, true);
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

test('store retention removes old finished handles, preserves parked questions, and refuses excess records', async () => {
  const f = fixture('slow-task');
  f.setStore({
    'native:v2:old:finished': { v: 2, type: AGENT_TYPE, finishedAt: 1 },
    'native:v2:old:parked': { v: 2, type: AGENT_TYPE, status: 'needs_answer', questionId: 'parked' },
    'other-plugin-key': { untouched: true },
  });
  f.reload();
  assert.equal((await f.turn('DUET: --unsupported\nRejected before launch.', 1)).status, 'blocked');
  assert.equal(f.readStore()['native:v2:old:finished'], undefined);
  assert.equal(f.readStore()['native:v2:old:parked'].questionId, 'parked');
  assert.equal(f.readStore()['other-plugin-key'].untouched, true);
  assert.equal(Object.values(f.readStore()).find(s => s.agentId === 'native-agent').incoming, undefined);
  f.setStore(Object.fromEntries(Array.from({ length: 128 }, (_, i) => [`native:v2:active:${i}`, { v: 2, type: AGENT_TYPE, status: 'running' }])));
  f.reload();
  assert.equal((await f.turn('Do not exceed the adapter store budget.', 2)).status, 'blocked');
  assert.equal(Object.keys(f.readStore()).length, 128);
  assert.equal(f.capture.processes.length, 0);
  f.save();
});

test('readiness attaches once to a user prompt per session; classic startup exports the session cwd without flags', async () => {
  const f = fixture('slow-task');
  const event = { session_id: 'native-session', cwd: `${f.root}/repo`, source: 'startup' };
  f.env.CLAUDE_ENV_FILE = `${f.root}/claude-env`;
  const child = spawnSync(process.execPath, [plugin + '/scripts/session-lifecycle-hook.mjs', 'SessionStart'],
    { env: f.env, cwd: event.cwd, input: JSON.stringify(event), encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.ok(!JSON.parse(child.stdout).hookSpecificOutput.additionalContext.includes('codex:codex-native'));
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
