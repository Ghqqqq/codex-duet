// Native adapter for the early-access Claude Code 2.1.302 function-hook API.
// No Node globals/imports in this sandbox; all host work goes through $.
export const AGENT_TYPE = 'codex:codex-native';
const PREFIX = 'native:v2:';
const ACTIVE = ['queued', 'running'];
const WAIT_TIMEOUT_SEC = '3600';
const HEARTBEAT_MS = 30000;
const EARLY_HANDLES_MS = 1500;
const READY = 'Native Codex workers ready: Agent(subagent_type: "codex:codex-native", prompt) — optional first line "DUET: <flags>"; SendMessage to continue or answer; stop from /tasks; live progress shows inside the agent and in codex-live.';
const PERSON_ORIGINS = ['composer', 'bridge', 'sdk'];
// Final statuses whose Codex turn is known to have ended. Interrupted,
// cancelled and failed jobs need a confirmed cancellation instead.
const ENDED = ['completed', 'needs_input', 'blocked'];
const CLOSED = 'native:closed:v1:';
const BINDING_FAILED = 'native:binding-failed:v1:';
// Mirror state.mjs unresolvedTask's failed-result rule. A failed transport
// without a confirmed end may still own its turn; a worker failure has ended.
const failedEnded = job => job.status === 'failed' && (job.recovered || (job.result
  && (job.result.turnEnded || job.result.structured || (job.result.failureSource !== 'transport'
    && (job.result.workerStatus || (job.result.errorCode !== 'BROKER_CONNECTION_CLOSED'
      && !/^(Codex broker connection closed during startup\.|Connection to Codex closed while the turn was running\.|Codex connection closed before turn completion; recover the recorded job\.)$/i.test(job.result.error ?? job.errorMessage ?? '')))))));
const ended = (job, state) => ENDED.includes(job.status)
  || failedEnded(job)
  || (['interrupted', 'cancelled'].includes(job.status) && job.interruptionConfirmed === true)
  || (state.cancellation?.confirmation === 'confirmed' && state.cancellation.jobId === job.id);
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const ALLOWED = '--model, --effort, --sandbox, --fast/--normal, --cwd, --fork';
const startedTypes = new Map();
const knownTypes = new Map();
const keyFor = (session, id) => `${PREFIX}${session}:${id}`;
const closedKey = (session, id) => `${CLOSED}${session}:${id}`;
const bindingFailedKey = (session, id) => `${BINDING_FAILED}${session}:${id}`;
const nonceFor = (session, agent, turn) => [session, agent, turn].map(encodeURIComponent).join(':');
const nativeNext = (state, status) => `SendMessage to ${state.name || state.agentId} ${status === 'needs_answer' ? 'with the answer' : 'to continue'}`;
// Catch next is replay-safe (d.ts 1211-1213), even after a successful spawn.
function passthrough($, e, next) { return next(e); }
// Count the UTF-8 bytes of JSON string content, including escaped controls and
// lone surrogates. Iterate code points so truncation never splits a pair.
function boundedText(value, budget) {
  let text = '', bytes = 0;
  for (const char of String(value)) {
    const encoded = JSON.stringify(char).slice(1, -1);
    let size = 0;
    for (const point of encoded) { const n = point.codePointAt(0); size += n < 128 ? 1 : n < 2048 ? 2 : n < 65536 ? 3 : 4; }
    if (bytes + size > budget) break;
    text += char; bytes += size;
  }
  return text;
}
// Details name the exact job: a worker name moves to its newest job after a follow-up.
const nativeDetails = state => state.jobId ? `duet result '${state.jobId}' --details` : state.worker ? `duet result ${state.worker} --details` : null;
function blocked(message, state = {}, code = 'native_adapter_error') {
  const summary = boundedText(message, 1200);
  return { status: 'blocked', worker: state.worker || null, jobId: state.jobId || null, summary,
    blockers: [{ code, message: summary }], next: nativeNext(state, 'blocked'),
    details: nativeDetails(state) };
}

async function ours($, id) {
  if (!id) return null;
  const key = keyFor(await $.session.id(), id);
  const startedType = startedTypes.get(key);
  if (startedType && startedType !== AGENT_TYPE) return null;
  let row;
  try { row = (await $.agent.list()).find(agent => agent.id === id); }
  catch { /* SubagentStart identifies even a first turn during list outages. */ }
  if (row) { knownTypes.set(id, row.type); return row.type === AGENT_TYPE ? row : null; }
  if (startedType === AGENT_TYPE) return { id };
  const state = await $.store.get(key);
  return state?.type === AGENT_TYPE ? { id, name: state.name } : null;
}

// A small argv tokenizer, never a shell. Quotes/backslashes allow cwd with spaces;
// command substitution, expansions and shell operators have no special meaning.
function parsePrompt(text) {
  if (!text.startsWith('DUET: ')) return { brief: text, flags: [] };
  const newline = text.indexOf('\n');
  const header = text.slice(6, newline < 0 ? undefined : newline).replace(/\r$/, '');
  const tokens = []; let token = '', quote = '', escaped = false, present = false;
  for (const char of header) {
    if (escaped) { token += char; escaped = false; present = true; }
    else if (char === '\\' && quote !== "'") { escaped = true; present = true; }
    else if (quote) { if (char === quote) quote = ''; else token += char; }
    else if (char === '"' || char === "'") { quote = char; present = true; }
    else if (/\s/.test(char)) { if (present) tokens.push(token); token = ''; present = false; }
    else { token += char; present = true; }
  }
  const invalid = () => { throw new Error(`Invalid DUET header. Allowed flags: ${ALLOWED}.`); };
  if (quote || escaped) invalid();
  if (present) tokens.push(token);
  const flags = [], seen = new Set(); let cwd;
  for (let i = 0; i < tokens.length; i++) {
    const match = /^(--[a-z]+)(?:=(.*))?$/.exec(tokens[i]);
    if (!match) invalid();
    const [, flag, inline] = match;
    if (seen.has(flag)) invalid();
    seen.add(flag);
    if (['--fast', '--normal', '--fork'].includes(flag)) {
      if (inline !== undefined || (seen.has('--fast') && seen.has('--normal'))) invalid();
      flags.push(flag); continue;
    }
    if (!['--model', '--effort', '--sandbox', '--cwd'].includes(flag)) invalid();
    const value = inline ?? tokens[++i];
    if (!value || value.startsWith('--') || value.includes('\0')) invalid();
    if (flag === '--cwd') cwd = value;
    else flags.push(flag, value);
  }
  return { brief: newline < 0 ? '' : text.slice(newline + 1), flags, cwd };
}

async function prune($) {
  const now = await $.clock.now(), keys = await $.store.keys(), kept = new Set(); let count = 0, size = 0;
  for (const key of keys) {
    if (!key.startsWith(PREFIX)) continue;
    const state = await $.store.get(key);
    const marker = state?.agentId ? closedKey(state.session, state.agentId) : null;
    const expired = value => value?.finishedAt && now - value.finishedAt > RETENTION_MS && !value.incoming;
    // Decide again on a fresh read: turn.start may have admitted a message and
    // a later turn may have finished since the first read.
    if (expired(state) && expired(await $.store.get(key))) {
      await $.store.delete(key);
      if (marker) await $.store.delete(marker);
      if (state?.agentId) await $.store.delete(bindingFailedKey(state.session, state.agentId));
      continue;
    }
    if (marker) kept.add(marker);
    count++; size += JSON.stringify(state ?? null).length * 4;
  }
  // A marker never expires before its state record; drop only old orphans.
  for (const key of keys) if (key.startsWith(CLOSED) && !kept.has(key)) {
    if (now - ((await $.store.get(key))?.at ?? 0) > RETENTION_MS) await $.store.delete(key);
  }
  return { count, size };
}

// Module-local promises serialize overlapping steps; persisted intents cover
// reloads. The companion's locked nonce reservation also covers other copies.
const flights = new Map(), nodes = new Map(), dispatching = new Map();
async function node($, timeoutMs = 10000) {
  const session = await $.session.id();
  if (!nodes.has(session)) nodes.set(session, (async () => {
    // This API does not expose Claude's execPath (Claude may be bundled Bun).
    // Pin the same host PATH Node that the classic hooks and Bash path use.
    const result = await $.process.run(['node', '-p', 'process.execPath'], { timeoutMs });
    const executable = result.stdout.trim();
    if (result.exitCode !== 0 || !/^(\/|[A-Za-z]:[\\/])/.test(executable) || /[\r\n]/.test(executable)) throw new Error('Node.js is required for native Codex workers; no host Node executable was found.');
    return executable;
  })());
  try { return await nodes.get(session); }
  catch { nodes.delete(session); throw new Error('Node.js is required for native Codex workers; no host Node executable was found.'); }
}
async function processBudget($, { deadline, timeoutMs = 15000, reserveMs = 0 } = {}) {
  const remaining = deadline === undefined ? timeoutMs : Math.min(timeoutMs, deadline - await $.clock.now() - reserveMs);
  if (remaining < 1) throw new Error('Native stop confirmation deadline expired; inspect duet status.');
  return Math.floor(remaining);
}
async function command($, state, args, input = '', timing = {}) {
  // ProcessSpawnRequest.input writes the whole string and closes stdin (also
  // for an empty string). Do not use process.run's differently named stdin.
  return { argv: [await node($, timing.deadline === undefined ? 10000 : await processBudget($, { ...timing, timeoutMs: 500 })), `${$.plugin.root}/bin/duet`, ...args, '--cwd', state.cwd, '--session', state.session,
    ...(args[0] === 'task' ? ['--session-cwd', await $.session.root()] : [])], cwd: state.cwd, input };
}
async function companion($, state, args, input = '', progress) {
  let child;
  try { child = $.process.spawn(await command($, state, args, input)); }
  catch (error) {
    // No stream was obtained: Node resolution or the synchronous spawn failed
    // before the companion could run. Stream/pull failures remain ambiguous.
    error.launchNotStarted = true;
    throw error;
  }
  let stdout = '', stderr = '', line = '', overflow = false;
  // Pull BOTH pipes until EOF; result only settles after the final pull. Keep
  // one bounded partial line, plus the bounded report tail. Never show JSON or
  // stderr as progress. A slow consumer backpressures the host's bounded pipe.
  for await (const chunk of child) {
    if (chunk.stream === 'stderr') { stderr = (stderr + chunk.text).slice(-4096); continue; }
    if (chunk.stream === 'stdout') {
      stdout = (stdout + chunk.text).slice(-4 * 1024 * 1024);
      if (!progress) continue;
      for (const part of chunk.text.split(/(?<=\n)/)) {
        const end = part.endsWith('\n');
        if (!overflow) {
          line += part;
          if (line.length > 2048) { line = ''; overflow = true; }
        }
        if (end) {
          const text = line.trimEnd();
          if (!overflow && (/^\[\d+\] /.test(text) || /^… \d+ progress lines omitted$/.test(text))) {
            await progress.line(text.replace(/^\[\d+\] /, '').slice(0, 200));
          }
          line = ''; overflow = false;
        }
      }
    }
  }
  const exit = await child.result;
  return parseReport(stdout, exit.code, stderr);
}
function parseReport(stdout, code, stderr = '') {
  const flagRejected = text => Number.isInteger(code) && code !== 0
    && /(?:unknown|unsupported|unexpected|unrecognized|invalid).*--dispatch-nonce|--dispatch-nonce.*(?:unknown|unsupported|unexpected|unrecognized|not supported)/i.test(text);
  const line = stdout.trimEnd().split('\n').filter(line => line.startsWith('{')).at(-1);
  if (!line) {
    const error = new Error(`Duet returned no JSON report (exit ${code}); inspect the job with duet status.`);
    error.nonceFlagRejected = flagRejected(stdout + '\n' + stderr);
    throw error;
  }
  let report;
  try { report = JSON.parse(stdout.trim()); }
  catch { report = JSON.parse(line); }
  if (report.status === 'error') {
    const error = new Error(report.summary || report.error || 'Duet failed.');
    // The companion has exited unsuccessfully with a structured, jobless
    // error. Only an authoritative empty nonce lookup can prove no launch;
    // a lost pipe, absent JSON or signal without an exit code is insufficient.
    error.launchRejected = Number.isInteger(code) && code !== 0 && !report.jobId;
    error.nonceFlagRejected = !report.jobId && flagRejected(error.message);
    throw error;
  }
  return report;
}
// Recovery must not open another stream tied to the aborted turn's signal.
async function snapshot($, state, args, { requireSuccess = false, ...timing } = {}) {
  const request = await command($, state, args, '', timing);
  const result = await $.process.run(request.argv, { cwd: request.cwd, timeoutMs: await processBudget($, timing) });
  if (result.isStdoutTruncated) throw new Error('Duet recovery response was truncated; inspect duet status.');
  const report = parseReport(result.stdout, result.exitCode, result.stderr);
  // Only an absence claim needs a successful lookup; terminal reports such as
  // an interrupted job's `result --report` legitimately exit nonzero.
  if (requireSuccess && result.exitCode !== 0) throw new Error('Duet recovery lookup did not exit successfully; inspect duet status before retrying.');
  return report;
}
const save = ($, state) => $.store.set(keyFor(state.session, state.agentId), state);
async function handles($, state, jobId, recovery = false, persist = true, { waitMs = 0, ...timing } = {}) {
  const args = ['status', jobId, '--json', ...(waitMs ? ['--wait', '--timeout-ms', String(waitMs), '--poll-interval-ms', '250'] : [])];
  const { job } = recovery ? await snapshot($, state, args, timing) : await companion($, state, args);
  if (!job || job.sessionId !== state.session) throw new Error('Duet job is missing or belongs to another session.');
  if (state.intent?.kind === 'task' && job.dispatchNonce !== state.intent.nonce) throw new Error('Duet dispatch nonce does not match the native launch intent.');
  if (state.jobId === job.id && state.ownerId && state.ownerId !== job.ownerId) throw new Error('Duet job ownership changed; refusing to adopt another owner implicitly.');
  Object.assign(state, { jobId: job.id, ownerId: job.ownerId, threadId: job.threadId, worker: job.agentName,
    status: job.status });
  if (persist) await save($, state);
  return job;
}
async function reconcile($, state, recovery = false, allowAbsent = false, timing = {}) {
  const args = ['status', '--all', '--json'];
  const lookup = flags => recovery ? snapshot($, state, flags, { ...timing, requireSuccess: allowAbsent }) : companion($, state, flags);
  let status;
  try { status = await lookup([...args, '--dispatch-nonce', state.intent.nonce]); }
  catch (error) {
    if (!error.nonceFlagRejected) throw error;
    status = await lookup(args); // Compatibility with an older companion.
  }
  if (!Array.isArray(status.running) || !Array.isArray(status.recent) || !Object.hasOwn(status, 'latestFinished')) throw new Error('Incomplete Duet nonce reconciliation.');
  const jobs = [...(status.running || []), status.latestFinished, ...(status.recent || [])].filter(Boolean);
  const matches = jobs.filter(job => job.sessionId === state.session && job.dispatchNonce === state.intent.nonce);
  if (allowAbsent && matches.length === 0) return null;
  if (matches.length !== 1) throw new Error('Native launch intent has no unique recorded job. Refusing to redispatch; inspect duet status before retrying.');
  return handles($, state, matches[0].id, recovery, true, timing);
}
async function drive($, e, state, progress) {
  // Block only a binding known to have failed: permissionMode is optional in
  // the host API, and agents from earlier versions have none.
  if (state.bindingPending) return blocked('Native permission binding is unavailable; nothing was launched. Start a new agent.', state, 'native_binding_unavailable');
  if (state.v === undefined) return blocked('Native dispatch context unavailable (store full, oversized message, or failed turn.start); nothing was launched.', state);
  if (state.v !== 2) return blocked('Unsupported native adapter state version; nothing was dispatched.', state);
  if (state.answeredTurn === e.turnId) return state.answer;
  const durable = await $.store.get(keyFor(state.session, state.agentId));
  if (durable?.intent?.turnId !== state.intent?.turnId
    || (durable?.incoming?.turnId !== e.turnId && durable?.intent?.turnId !== e.turnId)) {
    return blocked('Native dispatch context changed before launch; retry after the active turn finishes.', state);
  }
  if (state.incoming?.turnId !== e.turnId && state.intent?.turnId !== e.turnId) return blocked('Native agent has no durable context for this turn, or another turn is still active.', state);
  let report;
  if (state.intent?.turnId === e.turnId) {
    if (state.intent.kind === 'task') await reconcile($, state);
    // Re-entry after an answer never resubmits it. If the old question is still
    // pending, leave it parked; a new SendMessage can explicitly answer again.
    report = await companion($, state, ['wait', state.jobId, '--owner', state.ownerId, '--timeout-sec', WAIT_TIMEOUT_SEC], '', progress);
    await handles($, state, state.jobId);
  } else {
    let input = state.incoming.text, args, questionChanged = false;
    if (!input.trim()) return blocked('Empty native-agent message; nothing was dispatched.', state);
    // Overlapping stop handlers may have saved a stale status; the job record
    // decides before a new message is routed as a dispatch or an answer.
    if (state.jobId && (ACTIVE.includes(state.status) || state.status === 'needs_answer')) {
      // Read only: the save below persists it together with the new intent.
      const job = await handles($, state, state.jobId, false, false);
      // questionId is the question last returned to Claude, never merely the
      // latest one read by a heartbeat, recovery or this pre-answer refresh.
      questionChanged = job.pendingQuestion?.id !== state.questionId;
      // A pending question keeps the job running; its report says needs_answer.
      if (ACTIVE.includes(job.status) && job.pendingQuestion) state.status = 'needs_answer';
      if (state.status === 'needs_answer' && state.permissionMode === 'plan' && job.request?.sandbox !== 'read-only') {
        return blocked('Plan mode cannot resume a writable Codex turn; answer outside plan mode or start a read-only agent.', state, 'native_plan_mode_read_only');
      }
    }
    if (ACTIVE.includes(state.status)) return blocked('A Codex job is already running. Wait for completion before sending another assignment.', state);
    if (state.status === 'needs_answer') {
      // Headers are task settings only. A question answer is always verbatim.
      state.intent = { session: state.session, agentId: e.agentId, turnId: e.turnId, kind: 'answer', nonce: nonceFor(state.session, e.agentId, e.turnId) };
      args = questionChanged
        ? ['wait', state.jobId, '--owner', state.ownerId, '--timeout-sec', WAIT_TIMEOUT_SEC]
        : ['answer', state.jobId, '--question', state.questionId, '--owner', state.ownerId, '--timeout-sec', WAIT_TIMEOUT_SEC];
      if (questionChanged) input = '';
    } else {
      const parsed = parsePrompt(input);
      if (state.permissionMode === 'plan') {
        const sandboxAt = parsed.flags.indexOf('--sandbox');
        if (sandboxAt >= 0 && ['workspace-write', 'danger-full-access'].includes(parsed.flags[sandboxAt + 1])) {
          return blocked('Plan mode permits only the read-only Codex sandbox.', state, 'native_plan_mode_read_only');
        }
        if (sandboxAt < 0) parsed.flags.push('--sandbox', 'read-only');
      }
      if (!state.threadId && state.effort && !parsed.flags.includes('--effort')) parsed.flags.push('--effort', state.effort);
      input = parsed.brief;
      if (!input.trim()) return blocked('Empty native-agent brief after DUET header; nothing was dispatched.', state);
      if (state.jobId && !state.threadId) return blocked('Previous job has no Codex thread handle; refusing a replacement thread.', state);
      if (parsed.cwd) {
        const absolute = /^(\/|[A-Za-z]:[\\/])/.test(parsed.cwd) ? parsed.cwd : `${state.cwd}/${parsed.cwd}`;
        const directory = await $.fs.stat(absolute, { resolve: true });
        if (directory.kind !== 'dir' || !directory.realPath) throw new Error('--cwd must resolve to an existing directory.');
        if (state.threadId && directory.realPath !== state.cwd) throw new Error('A native worker continuation must keep its original cwd. Use a new native agent for another workspace.');
        state.cwd = directory.realPath;
      }
      state.intent = { session: state.session, agentId: e.agentId, turnId: e.turnId, kind: 'task', nonce: nonceFor(state.session, e.agentId, e.turnId) };
      args = ['task', ...(state.threadId ? ['--thread', state.threadId] : ['--fresh']), ...parsed.flags,
        '--dispatch-nonce', state.intent.nonce, '--timeout-sec', WAIT_TIMEOUT_SEC];
      delete state.jobId; delete state.ownerId; delete state.questionId; delete state.status;
    }
    // Persist intent BEFORE any spawn; retain no brief/answer in adapter state.
    delete state.incoming; delete state.answer; delete state.finishedAt;
    try {
      try { await save($, state); }
      catch (error) { error.launchNotStarted = true; throw error; }
      report = await companion($, state, args, input, progress);
    }
    catch (error) {
      if (error.launchNotStarted || (state.intent.kind === 'task' && error.launchRejected
        && await reconcile($, state, true, true) === null)) {
        // An exited companion's error AND an authoritative empty nonce lookup close
        // only this rejected turn. Failed/ambiguous lookups still fail closed.
        await closeTurn($, state);
        return blocked(error.message, state);
      }
      throw error;
    }
    // The task process stays attached throughout the wait. Resolve handles
    // from its durable nonce reservation, never a short dispatch response.
    // If aborted before returning, cancel() resolves that same intent.
    if (state.intent.kind === 'task') await reconcile($, state);
    else await handles($, state, state.jobId);
  }
  await progress.start();
  for (;;) {
    if (!report.jobId || report.jobId !== state.jobId) throw new Error('Duet report does not match the recorded job handle.');
    state.status = report.status;
    await save($, state);
    if (!ACTIVE.includes(report.status)) break;
    // Only a full wait timeout returns active; questions and terminal reports
    // exit above. Await process I/O so waiting does not spend hook budget.
    report = await companion($, state, ['wait', state.jobId, '--owner', state.ownerId, '--timeout-sec', WAIT_TIMEOUT_SEC], '', progress);
    await handles($, state, state.jobId);
  }
  if (report.status === 'needs_answer') await progress.line(`? Waiting for Claude: ${report.question?.text || report.summary}`);
  return { ...report, next: nativeNext(state, report.status) };
}
async function cancel($, state, deadline) {
  let job;
  delete state.cancellation;
  const lookup = { deadline, timeoutMs: 500, reserveMs: 2000 };
  try {
    if (state.intent?.kind === 'task' && !state.jobId) await reconcile($, state, true, false, lookup);
    if (!state.jobId) return;
    // Both callers are stopping a native owner. Give its worker one bounded,
    // read-only chance to confirm owner_stopped before the cancel safety net.
    // Terminal records return immediately; an unavailable lookup still falls
    // through to cancel using the already-recorded job handle.
    const timing = { deadline, timeoutMs: 2000, reserveMs: 2000 };
    try {
      const waitMs = Math.max(1, await processBudget($, timing) - 150);
      job = await handles($, state, state.jobId, true, false, { ...timing, waitMs });
    } catch { /* A failed/timed-out observation must not suppress cancellation. */ }
    if (job?.interruptionConfirmed !== true) {
      const timing = { deadline, timeoutMs: 1500, reserveMs: 500 };
      const request = await command($, state, ['cancel', state.jobId, '--json'], '', timing);
      let result, failure;
      try {
        result = await $.process.run(request.argv, { cwd: request.cwd, timeoutMs: await processBudget($, timing) });
      } catch (error) { failure = error; }
      // The CLI may have sent its interrupt before timing out. Always use the
      // reserved final read to look for durable confirmation, even on rejection.
      try { job = await handles($, state, state.jobId, true, false, { deadline, timeoutMs: 500 }); }
      catch (error) { failure ||= error; }
      if (job?.interruptionConfirmed !== true) {
        if (!result) throw failure;
        state.cancellation = JSON.parse(result.stdout);
      }
    }
    if (['interrupted', 'cancelled'].includes(job?.status) && job.interruptionConfirmed === true) {
      state.cancellation = { jobId: job.id, status: job.status, confirmation: 'confirmed', turnInterrupted: true, reason: job.interruptionReason };
    }
    state.status = state.cancellation?.status || 'blocked';
    state.finishedAt = await $.clock.now();
  } catch (error) {
    state.cancellation = { status: 'unconfirmed', message: 'Cancellation unconfirmed; inspect duet status. Owner-loss and question timeout remain the fallback.',
      error: String(error?.message || error).slice(0, 200) };
  }
  await save($, state);
  return job;
}
// Closure is its own key: a stale snapshot saved by an overlapping handler can
// rewrite the state record but never reopen a turn proven to have ended.
const closeTurn = async ($, state) => $.store.set(closedKey(state.session, state.agentId), { turnId: state.intent.turnId, at: await $.clock.now() });
const isClosed = async ($, state) => !!state.intent && (await $.store.get(closedKey(state.session, state.agentId)))?.turnId === state.intent.turnId;
// Cancel the recorded job; close its turn only with evidence that it ended.
async function stopJob($, state, deadline) {
  // Leave 500 ms of the host's 5 s abort linger for store/dispatch overhead.
  deadline ??= await $.clock.now() + 4500;
  const job = await cancel($, state, deadline);
  if (!job) return null;
  const confirmed = state.cancellation?.confirmation === 'confirmed' && state.cancellation.jobId === job.id;
  // Just after a confirmed cancel the job record can still read running.
  state.status = confirmed && ACTIVE.includes(job.status) ? state.cancellation.status : job.status;
  if (!ended(job, state)) return null;
  await closeTurn($, state);
  await save($, state);
  return job;
}
// An open turn whose stop could not be confirmed may have ended since (for
// example through duet cancel); the job record decides.
async function recheck($, state) {
  const job = state.jobId ? await handles($, state, state.jobId, true)
    : state.intent?.kind === 'task' ? await reconcile($, state, true) : null;
  if (job?.pendingQuestion && ACTIVE.includes(job.status)) {
    // A displayed question's final save may have been lost. Admit a message
    // only to re-show the current question, never guess which one was shown.
    state.status = 'needs_answer'; state.questionId = null;
    await save($, state);
    return true;
  }
  if (!job || !ended(job, state)) return false;
  await closeTurn($, state);
  return true;
}
const cancelledReport = (state, status) => ({ status, worker: state.worker || null, jobId: state.jobId,
  summary: 'Stopped from /tasks; the Codex turn was cancelled.', next: nativeNext(state, status),
  details: nativeDetails(state) });
// Claude Code refuses host process calls in a dispatch aborted from /tasks, so
// the step cannot confirm its own stop. The host has killed the owner wait,
// which makes the worker interrupt; turn.complete records the confirmation.
const stoppingReport = state => ({ status: 'interrupted', worker: state.worker || null, jobId: state.jobId,
  summary: `Stopped from /tasks. The owner wait was stopped, so the worker interrupts the Codex turn and ends the commands it started; duet status ${state.worker || state.jobId} shows the recorded confirmation.`,
  next: nativeNext(state, 'interrupted'), details: nativeDetails(state) });
async function stoppedReport($, state) {
  const deadline = await $.clock.now() + 4500;
  const job = await stopJob($, state, deadline);
  if (!job) return null;
  if (ACTIVE.includes(job.status)) return cancelledReport(state, state.status);
  const report = await snapshot($, state, ['result', job.id, '--report'], { deadline, timeoutMs: 500 });
  if (report.jobId !== job.id) throw new Error('Duet report does not match the recorded job handle.');
  return { ...report, status: job.status, worker: job.agentName || null, jobId: job.id, next: nativeNext(state, job.status) };
}

// Each observer has at most 200 pending lines. The producer waits for space,
// keeping progress bounded even if Claude stops pulling the turn stream.
function observer() {
  const queue = [], spaces = new Set(); let wake, closed = false;
  const release = () => { for (const resolve of spaces) resolve(); spaces.clear(); };
  return {
    async push(text) {
      while (!closed && queue.length >= 200) await new Promise(resolve => { spaces.add(resolve); });
      if (!closed) { queue.push(text); wake?.(); wake = null; }
    },
    close() { closed = true; wake?.(); release(); },
    async *read(flight) {
      while (!flight.done || queue.length) {
        if (!queue.length) { await new Promise(resolve => { wake = resolve; }); continue; }
        const text = queue.shift(); release();
        yield { kind: 'thinking', index: 0, text };
      }
    }
  };
}
function progressFor($, e, state, publish) {
  let starting, busy = false, lastAt, startedAt;
  const notices = state.notices?.turnId === e.turnId ? state.notices : { turnId: e.turnId, count: 0 };
  state.notices = notices;
  const notice = async (text, final = false) => {
    if ((!final && notices.count >= 200) || notices.last === text) return;
    const result = await $.session.append({ agentId: state.agentId,
      message: { type: 'system', content: [{ type: 'text', text }] } });
    if (result?.deny) throw new Error(`Native progress notice refused: ${result.deny}`);
    notices.count++; notices.last = text;
    await save($, state);
  };
  const start = async () => {
    if (notices.started || !state.intent) return;
    if (!starting) starting = (async () => {
      // The CLI does not print a launch receipt. Resolve the durable nonce at
      // the first activity/heartbeat; never invent a handle or redispatch.
      const job = state.jobId ? await handles($, state, state.jobId) : await reconcile($, state);
      await notice(`Codex worker ${job.agentName || state.name} started · job ${job.id} · ${job.request?.model} / ${job.request?.effort} / ${job.request?.sandbox}`);
      notices.started = true;
      await save($, state);
    })().finally(() => { starting = null; });
    await starting;
  };
  return {
    start,
    async usage(value) {
      if (!value || notices.usage || !['inputTokens', 'cachedInputTokens', 'outputTokens'].every(key => Number.isSafeInteger(value[key]) && value[key] >= 0)) return;
      const count = number => String(number).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
      await notice(`Codex usage · ${count(value.inputTokens)} input (${count(value.cachedInputTokens)} cached) · ${count(value.outputTokens)} output tokens`, true);
      notices.usage = true;
      await save($, state);
    },
    async line(text) {
      lastAt = await $.clock.now();
      await start();
      await publish(text);
      await notice(text);
    },
    async begin() { startedAt = lastAt = await $.clock.now(); },
    async heartbeat() {
      if (busy) return;
      busy = true;
      try {
        const now = await $.clock.now();
        if (now - lastAt < HEARTBEAT_MS) return;
        lastAt = now;
        const seconds = Math.floor((now - startedAt) / 1000);
        const elapsed = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
        await publish(`Codex worker ${state.worker || state.name || state.agentId} running · ${elapsed}`);
        await start();
      } finally { busy = false; }
    }
  };
}

export function register(on) {
  let registered = false;
  const announcing = new Map(), announced = new Set();
  const efforts = new Map(), spawning = new Map(), observedBindings = new Map();
  const restoreBinding = (key, state) => {
    const binding = observedBindings.get(key);
    if (binding) delete state.bindingPending;
    if (binding?.permissionMode !== undefined) {
      // A resumed spawn's observation wins over an older durable binding.
      state.permissionMode = binding.permissionMode;
      delete state.bindingPending;
    }
    if (binding?.effort !== undefined) state.effort = binding.effort;
  };
  nodes.clear(); flights.clear(); startedTypes.clear(); knownTypes.clear(); dispatching.clear();
  // 2.1.302 d.ts 13296-13304, 16715-16716: tool.call carries the flat Agent
  // arguments, including explicit effort; turn.step's effective effort also
  // includes the shell definition's low and cannot distinguish that default.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    if (e.tool === 'Agent' && e.subagent_type === AGENT_TYPE) {
      const key = keyFor(await $.session.id(), e.tool_use_id);
      efforts.delete(key);
      if (['low', 'medium', 'high', 'xhigh', 'max'].includes(e.effort)) efforts.set(key, e.effort);
      // Denied calls have no spawn to consume their entry.
      if (efforts.size > 128) efforts.delete(efforts.keys().next().value);
    }
    return next(e);
  });
  on('agent.spawn', { subagentType: AGENT_TYPE }, async ($, e, next) => {
    if (e.subagentType !== AGENT_TYPE) return next(e);
    const session = await $.session.id(), callKey = keyFor(session, e.tool_use_id);
    const effort = efforts.get(callKey);
    efforts.delete(callKey);
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const spawnBinding = { pending, agentId: e.resume?.agentId };
    const bindings = spawning.get(session) || new Set();
    spawning.set(session, bindings); bindings.add(spawnBinding);
    try {
      // AgentSpawnResult (d.ts 414-419) resolves at start, not completion.
      // A first turn waits below until settings are observed for its id.
      const result = await next(e);
      if (result.agentId) {
        spawnBinding.agentId = result.agentId;
        knownTypes.set(result.agentId, AGENT_TYPE);
        const key = keyFor(session, result.agentId);
        // Retain the observation before any store access can fail. start and
        // step run in separate dispatches, but share this module's bindings.
        observedBindings.set(key, { ...observedBindings.get(key),
          ...(e.permissionMode !== undefined ? { permissionMode: e.permissionMode } : {}),
          ...(!e.resume && effort ? { effort } : {}) });
        let state;
        try {
          state = await $.store.get(key);
          if (!state && (await prune($)).count >= 128) return result;
          state ||= { type: AGENT_TYPE, session, agentId: result.agentId, name: e.name || result.agentId };
          // Resumed SendMessage runs expose the current parent's mode here.
          // If it is absent, retain the previously observed mode conservatively.
          try {
            // Do not let a reload adopt stale writable settings if the following
            // binding write fails. Memory can recover this guard in this module.
            await save($, { ...state, bindingPending: true });
            restoreBinding(key, state);
            await save($, state);
            await $.store.delete(bindingFailedKey(session, result.agentId));
          } catch (error) {
            // Also record a failed guard write when the store recovers. If both
            // writes fail, the observed binding still protects this module.
            await save($, { ...state, bindingPending: true }).catch(() => {});
            throw error;
          }
        } catch {
          // A separate small guard survives a failed native-state write without
          // discarding a resumed agent's job/owner handles. If no state exists,
          // turn.start also detects the lost binding after a module reload.
          await $.store.set(bindingFailedKey(session, result.agentId), { bindingPending: true }).catch(() => {});
        }
      }
      return result;
    } finally { bindings.delete(spawnBinding); if (!bindings.size) spawning.delete(session); release(); }
  }).catch(passthrough);
  // 2.1.302 d.ts: SubagentStartHookInput (12829-12833) carries the exact
  // agent_id/type before its loop starts; TurnStartInput/TurnStepInput carry
  // only agentId (14060-14068, 14139-14147), not the agent's system prompt.
  // Keep this independent of discovery AND store availability. turn.start
  // persists the normal binding; the in-memory one also lets .catch fail closed.
  on('classic.SubagentStart', async ($, e, next) => {
    startedTypes.set(keyFor(e.session_id, e.agent_id), e.agent_type);
    knownTypes.set(e.agent_id, e.agent_type);
    return next(e);
  });
  on('turn.start', async ($, e, next) => {
    const agent = await ours($, e.agentId);
    if (!agent) return next(e);
    const session = await $.session.id(), key = keyFor(session, e.agentId);
    if (dispatching.has(key)) return next(e);
    const lock = {};
    dispatching.set(key, lock);
    try {
      let state = await $.store.get(key);
      // Established agents must not wait for unrelated session spawns: waiting
      // on their promises spends this dispatch's hook budget.
      if (!state && !observedBindings.has(key)) {
        await Promise.all([...(spawning.get(session) || [])].filter(binding => binding.agentId === e.agentId).map(binding => binding.pending));
        state = await $.store.get(key);
      }
      if (state) restoreBinding(key, state);
      if (state?.answeredTurn === e.turnId || state?.intent?.turnId === e.turnId || state?.incoming?.turnId === e.turnId) return next(e);
      if (state?.intent && state.intent.turnId !== state.answeredTurn && !await isClosed($, state)
        && !await recheck($, state).catch(() => false)) return next(e);
      const budget = await prune($);
      if ((!state && budget.count >= 128) || budget.size + e.text.length * 4 > 2 * 1024 * 1024 || e.text.length > 65536) return next(e);
      state ||= { type: AGENT_TYPE, session, agentId: e.agentId, name: agent.name || e.agentId,
        bindingPending: !observedBindings.has(key) };
      if (await $.store.get(bindingFailedKey(session, e.agentId))) state.bindingPending = true;
      restoreBinding(key, state);
      if (!state.v) {
        const directory = await $.fs.stat(await $.session.cwd(), { resolve: true });
        if (directory.kind !== 'dir' || !directory.realPath) throw new Error('Native workspace must resolve to an existing directory.');
        state.v = 2; state.cwd = directory.realPath;
      }
      state.incoming = { turnId: e.turnId, text: e.text };
      delete state.finishedAt;
      await save($, state);
      if (!state.bindingPending) await $.store.delete(bindingFailedKey(session, e.agentId));
      return next(e);
    } finally { if (dispatching.get(key) === lock) dispatching.delete(key); }
  }).catch(passthrough);
  on('turn.step', async function* ($, e, next) {
    const agent = await ours($, e.agentId);
    if (!agent) return yield* next(e);
    const session = await $.session.id(), key = keyFor(session, e.agentId);
    const flight = `${key}:${e.turnId}`;
    const listener = observer();
    let running = flights.get(flight);
    if (!running) {
      // Do not wait on another turn's stream (which spends this hook's budget).
      // One agent owns the dispatch lock; a concurrent turn is refused.
      if (dispatching.has(key)) return yield* finish(e, blocked('Another turn is active for this native agent; retry after it finishes.', { agentId: e.agentId }));
      running = { listeners: new Set(), done: false };
      dispatching.set(key, running);
      flights.set(flight, running);
      running.listeners.add(listener);
      running.result = (async () => {
        const state = await $.store.get(key) || { session, agentId: e.agentId, name: agent.name };
        if (await $.store.get(bindingFailedKey(session, e.agentId))) state.bindingPending = true;
        restoreBinding(key, state);
        const progress = progressFor($, e, state, text => Promise.all([...running.listeners].map(item => item.push(text))));
        await progress.begin();
        // Pending process I/O suspends the hook budget. Timer callbacks only
        // wake the generator; never poll with clock.sleep (which spends it).
        const timer = $.clock.every(HEARTBEAT_MS, () => progress.heartbeat().catch(() => {}));
        // Learn the job handles soon after dispatch, before any progress line:
        // a stop from /tasks can no longer run the lookup itself.
        const early = $.clock.after(EARLY_HANDLES_MS, () => progress.start().catch(() => {}));
        let report, uncertain = false, stopping = false;
        try {
          report = await drive($, e, state, progress);
          if (report.status === 'owner_stopped') {
            stopping = true;
            report = await stoppedReport($, state) || report;
          }
          await progress.usage(report.usage);
        } catch (error) {
          const aborted = state.intent?.turnId === e.turnId && (next.signal?.aborted || error?.name === 'AbortError' || /process\.spawn\(.*\) aborted$/.test(error?.message || ''));
          if (aborted) {
            // No process calls here: the host refuses them in a stopped dispatch.
            stopping = true;
            report = state.jobId ? stoppingReport(state)
              : blocked('Stopped from /tasks before Duet recorded the job; run duet status --all before retrying.', state, 'native_stop_unconfirmed');
          }
          report ||= blocked(error?.message || 'Native adapter failed.', state);
          uncertain = state.intent?.turnId === e.turnId && (!state.jobId || ACTIVE.includes(state.status));
        } finally { timer.cancel(); early.cancel(); }
        // A stopped turn closes only through closeTurn's evidence, and no turn
        // closes while its job still reads active.
        if (state.intent?.turnId === e.turnId && (ACTIVE.includes(state.status) || stopping)) {
          uncertain ||= ACTIVE.includes(state.status) || !await isClosed($, state).catch(() => false);
        }
        // Do not overwrite a different active turn's handles or saved answer.
        if (state.v === 2 && (state.incoming?.turnId === e.turnId || state.intent?.turnId === e.turnId)) {
          delete state.incoming;
          state.answer = report;
          // A turn that failed before recording its own intent leaves the
          // previous intent's closure as it was.
          if (!uncertain && (!state.intent || state.intent.turnId === e.turnId)) state.answeredTurn = e.turnId;
          if (!uncertain && report.status !== 'needs_answer' && !ACTIVE.includes(state.status)) state.finishedAt = await $.clock.now();
          // questionId means shown to Claude, not observed in the job. Earlier
          // saves can fail and turn the response into blocked; only this path
          // commits the question whose needs_answer report we actually return.
          if (report.status === 'needs_answer') state.questionId = report.question?.id ?? null;
          try { await save($, state); }
          catch (error) {
            // A store may commit and then throw. Still return that question,
            // never a blocked report that would leave an unseen id as shown.
            if (report.status !== 'needs_answer') throw error;
            // Retry a transient pre-commit failure too, so the displayed
            // question remains answerable. Persistent failure is repaired by
            // recheck re-showing the job's current question conservatively.
            await save($, state).catch(() => {});
          }
        }
        return report;
      })().finally(() => {
        running.done = true;
        for (const item of running.listeners) item.close();
        flights.delete(flight);
        if (dispatching.get(key) === running) dispatching.delete(key);
      });
      // A failing host/store call is rethrown after draining, not unhandled.
      running.result.catch(() => {});
    } else running.listeners.add(listener);
    try {
      yield* listener.read(running);
      return yield* finish(e, await running.result);
    } finally { running.listeners.delete(listener); listener.close(); }
  }).catch(async function* ($, e, next) {
    if (!e.agentId || (knownTypes.has(e.agentId) && knownTypes.get(e.agentId) !== AGENT_TYPE)) return yield* next(e);
    return yield* finish(e, blocked('Native adapter hook failed; inspect duet status before retrying.', { agentId: e.agentId }));
  });
  on('turn.complete', async ($, e, next) => {
    if (e.isAborted && await ours($, e.agentId)) {
      const state = await $.store.get(keyFor(await $.session.id(), e.agentId));
      // A cancelled wait may report owner_stopped before this callback. Still
      // cancel its recorded job; do not rely on the report's status label.
      // stopJob closes the turn (for a later SendMessage) only with evidence it
      // ended; a job that may still run keeps it open until duet cancel.
      if (state?.intent?.turnId === e.turnId) await stopJob($, state);
    }
    return next(e);
  }).catch(passthrough);
  // Register last: a partial native registration never advertises readiness.
  // Announce on the first prompt a person sends that reaches the model; a slash
  // command (such as /reload-plugins) may never ask the model.
  on('prompt.submit', { origin: { kind: PERSON_ORIGINS } }, async ($, e, next) => {
    if (!registered || e.command || !PERSON_ORIGINS.includes(e.origin?.kind)) return next(e);
    const session = await $.session.id(), key = `native:ready:v1:${session}`;
    // Claim synchronously after the last await, so concurrent prompts attach
    // once; persist only after the prompt entered, so a dropped one does not
    // consume the announcement.
    // A concurrent prompt waits for a pending claim, which may still drop.
    for (let pending; (pending = announcing.get(session));) await pending;
    if (announced.has(session) || await $.store.get(key)) { announced.add(session); return next(e); }
    for (let pending; (pending = announcing.get(session));) await pending;
    if (announced.has(session)) return next(e);
    let release;
    announcing.set(session, new Promise(resolve => { release = resolve; }));
    try {
      const result = await next({ ...e, context: [...(e.context || []), READY] });
      if (!result?.drop) { announced.add(session); await $.store.set(key, true); }
      return result;
    } finally { announcing.delete(session); release(); }
  }).catch(passthrough);
  registered = true;
}

async function* finish(e, report) {
  // 2.1.302 d.ts 14211-14214 calls usage "What the request cost as the API
  // reported it". Codex tokens belong in the report/notice, never this ledger.
  const text = JSON.stringify(report);
  yield { kind: 'text', index: 1, text };
  yield { kind: 'stop', stopReason: 'end_turn', usage: null };
  return { turnId: e.turnId, index: e.index, answer: text, toolUses: [], stopReason: 'end_turn', usage: null };
}
