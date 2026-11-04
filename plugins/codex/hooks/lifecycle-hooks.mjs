// Folded classic hook results only: never execute settings hooks ourselves.
// Host-facing code stays here; dispatch, ownership and recovery stay native.
const PREFIX = 'native:lifecycle:v1:';
const CONTEXT_LIMIT = 16384;
const CONTEXT_ENTRIES = 64;
const FEEDBACK_LIMIT = 8192;
const STOP_LIMIT = 3;
const lifecycleKey = (session, agentId) => `${PREFIX}${session}:${agentId}`;
const size = value => value ? JSON.stringify(value).length * 4 : 0;
const writes = new Map();
function serialized(key, action) {
  const pending = (writes.get(key) || Promise.resolve()).then(action);
  const settled = pending.catch(() => {}).finally(() => {
    if (writes.get(key) === settled) writes.delete(key);
  });
  writes.set(key, settled);
  return pending;
}
function bounded(text, limit) {
  if (text.length <= limit) return text;
  const suffix = '\n[Hook context truncated]';
  let head = text.slice(0, Math.max(0, limit - suffix.length));
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  return (head + suffix).slice(0, limit);
}

// Charge sidecars to native admission's existing store budget. A start whose
// loop never binds retains its bounded context for at most ten minutes.
export async function lifecycleStoreSize($, { keys, now, keepKey, pending }) {
  let total = 0;
  for (const key of keys) if (key.startsWith(PREFIX)) {
    total += await serialized(key, async () => {
      const value = await $.store.get(key), primary = 'native:v2:' + key.slice(PREFIX.length);
      if (value && primary !== keepKey && now - value.at >= 600000 && !pending(primary) && !await $.store.get(primary)) {
        await $.store.delete(key);
        return 0;
      }
      return size(value);
    });
  }
  return total;
}
export async function forgetLifecycle($, session, agentId) {
  const key = lifecycleKey(session, agentId);
  return serialized(key, async () => {
    const value = await $.store.get(key);
    if (value) await $.store.delete(key);
    return size(value);
  });
}
export async function pendingLifecycle($, state) {
  const stop = (await $.store.get(lifecycleKey(state.session, state.agentId)))?.stop;
  return !!stop && !stop.closed && stop.turnId === state.turnId && !!stop.pending
    && stop.pending.sourceJobId === state.jobId && state.intent?.attemptId !== stop.pending.id;
}

export async function captureStartContext($, e, result) {
  if (!Array.isArray(result?.additionalContext) || !result.additionalContext.length) return;
  const key = lifecycleKey(e.session_id, e.agent_id);
  await serialized(key, async () => {
    const value = await $.store.get(key) || {}, contexts = value.contexts || [];
    let room = CONTEXT_LIMIT - contexts.reduce((sum, entry) => sum + entry.text.length, 0), changed = false;
    for (const text of result.additionalContext.slice(0, CONTEXT_ENTRIES)) {
      if (typeof text !== 'string' || !text.trim() || contexts.some(entry => entry.text === text)) continue;
      if (room <= 0 || contexts.length >= CONTEXT_ENTRIES) break;
      const entry = { text: bounded(text, room) };
      contexts.push(entry); room -= entry.text.length; changed = true;
    }
    if (changed) await $.store.set(key, { at: await $.clock.now(), ...value, contexts });
  });
}

// Called after parsing the DUET header AND persisting the dispatch intent.
// Late context stays pending for the next task follow-up (never an answer to
// a parked question). Retained delivered entries deduplicate reload/resume.
export async function lifecycleBrief($, state, brief) {
  const key = lifecycleKey(state.session, state.agentId);
  return serialized(key, async () => {
    const value = await $.store.get(key);
    const pending = value?.contexts?.filter(entry => !entry.delivered) || [];
    if (!pending.length) return brief;
    for (const entry of pending) entry.delivered = true;
    await $.store.set(key, value);
    return `Context from SubagentStart hooks:\n${pending.map(entry => entry.text).join('\n\n')}\n\n${brief}`;
  });
}

const unresolved = state => !state?.jobId || !state.threadId || state.bindingPending
  || ['queued', 'running', 'unknown', 'unreachable'].includes(state.status)
  || state.answer?.blockers?.some(blocker => blocker.code === 'thread_busy')
  || state.answeredTurn !== state.turnId || state.intent?.turnId !== state.turnId;
const questionPending = state => state?.status === 'needs_answer' || state?.answer?.status === 'needs_answer';
const jobQuestion = job => job?.pendingQuestion && job.pendingQuestion.answer === undefined;

async function suppressStop($, e, result, value, key, reason, jobId) {
  const notice = `SubagentStop hook continuation request was not honoured: ${reason}.`;
  const noticeId = `${jobId || ''}:${reason}`;
  if (value.notice !== noticeId) {
    // Do not silently override the user's block if the host refuses the notice.
    const appended = await $.session.append({ agentId: e.agent_id,
      message: { type: 'system', content: [{ type: 'text', text: notice }] } });
    if (appended?.deny) throw new Error(appended.deny);
    await $.store.set(key, { at: await $.clock.now(), ...value, notice: noticeId });
  }
  const { block, ...rest } = result;
  return rest;
}

export async function observeStop($, e, result, { read, busy, inspect, ended }) {
  if (typeof result?.block !== 'string' || result.preventContinuation) return result;
  const key = lifecycleKey(e.session_id, e.agent_id);
  return serialized(key, async () => {
    const value = await $.store.get(key) || {}, state = await read();
    const suppress = reason => suppressStop($, e, result, value, key, reason, state?.jobId);
    // A parked Codex turn must never receive hook feedback as its answer.
    if (questionPending(state)) return suppress('question pending');
    if (busy() || unresolved(state)) return suppress('unresolved turn');
    // The typed event has no feedback id. Bind its final assistant report to
    // the job it stopped, refusing missing/ambiguous or stale provenance.
    let report;
    try { report = JSON.parse(e.last_assistant_message); } catch { /* Refuse below. */ }
    if (!report?.jobId || report.jobId !== state.jobId) return suppress('unidentified or stale stop feedback');
    if (!result.block.trim()) return suppress('empty stop feedback');
    const stop = value.stop?.turnId === state.turnId ? value.stop : { turnId: state.turnId, count: 0 };
    if (stop.closed) return suppress('agent turn was interrupted');
    if (stop.pending?.sourceJobId === state.jobId) return result;
    if (stop.count >= STOP_LIMIT) return suppress(`cap reached (${STOP_LIMIT} continuations per agent turn)`);
    // stop_hook_active means this is already a hook retry. Only a chain we
    // started may continue it; a reload retains that chain and its hard cap.
    if (typeof e.stop_hook_active !== 'boolean' || (e.stop_hook_active && !stop.count)) {
      return suppress('stop hook already active without a recorded continuation');
    }
    let job;
    try { job = await inspect(state); } catch { return suppress('unresolved turn'); }
    if (jobQuestion(job)) return suppress('question pending');
    if (!ended(job, state)) return suppress('unresolved turn');
    const count = stop.count + 1;
    const id = `duet:subagent-stop:${state.turnId}:${state.jobId}:${count}`;
    await $.store.set(key, { at: await $.clock.now(), ...value, stop: { turnId: state.turnId, count,
      pending: { id, sourceJobId: state.jobId, feedback: bounded(result.block, FEEDBACK_LIMIT) } } });
    return result;
  });
}

export async function prepareLifecycleStep($, e, state, { inspect, ended, save }) {
  const key = lifecycleKey(state.session, state.agentId);
  await serialized(key, async () => {
    const value = await $.store.get(key), stop = value?.stop, pending = stop?.pending;
    if (stop?.turnId !== e.turnId || stop.closed || !pending || state.intent?.attemptId === pending.id || state.incoming?.attemptId === pending.id) return;
    if (pending.sourceJobId !== state.jobId || questionPending(state) || unresolved(state)) return;
    // Revalidate immediately before turning feedback into an assignment. A
    // question or ambiguous ending discovered after the hook leaves it parked.
    const job = await inspect(state);
    if (jobQuestion(job) || !ended(job, state)) return;
    state.incoming = { turnId: e.turnId, attemptId: pending.id, text: `Feedback from SubagentStop hooks:\n${pending.feedback}` };
    delete state.intent; delete state.answeredTurn; delete state.answer; delete state.finishedAt; delete state.notices;
    // The same host turn now has a distinct Fugato attempt. Subsequent steps
    // recover its intent/cache normally; the nonce makes its job and journal
    // finish distinct without ever resubmitting an already reserved attempt.
    await save(state);
  });
}

export async function abandonLifecycleStop($, e) {
  const key = lifecycleKey(await $.session.id(), e.agentId);
  await serialized(key, async () => {
    const value = await $.store.get(key);
    if (value?.stop?.turnId !== e.turnId) return;
    delete value.stop.pending;
    value.stop.closed = true;
    await $.store.set(key, value);
  });
}
