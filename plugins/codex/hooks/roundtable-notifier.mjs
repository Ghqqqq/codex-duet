// Chair notices are user rows: a system row is shown but never read by the
// model (d.ts SessionAppendArgs), and the chair must act on these.
// Host-facing scheduling only. Forum state and steering receipts stay in the
// companion; no filesystem or runtime calls bypass its ownership checks.
import { keyFor, bindingFailedKey, knownTypes } from './native-identity.mjs';
import { command, processBudget, ended } from './native-agent.mjs';
import { isNativeType } from './presets.mjs';
import { PERSONA_IDS } from '../scripts/lib/roundtable-personas.mjs';

const loops = new Map(), noticeTurns = new Map();
let writes = Promise.resolve();
const WAKE_GRACE_MS = 120000, DELIVERY_INTERVAL_MS = 5000, MAX_NOTICE_CHARS = 8192, MAX_RECORDS = 256, MAX_BYTES = 256 * 1024;
const owned = key => key.startsWith(PREFIX) || key.startsWith(STOPPED);
const memberKey = (session, room, name) => `${PREFIX}${session}:${room}:${name}`;
const size = value => JSON.stringify(value ?? null).length * 4;
const PREFIX = 'native:roundtable:v1:', STOPPED = 'native:roundtable-stopped:v1:';
const active = job => ['queued', 'running'].includes(job.status);
const stopped = state => state?.stopped || state?.owner_stopped || ['stopped', 'owner_stopped'].includes(state?.status)
  || state?.answer?.status === 'owner_stopped' || state?.cancellation?.reason === 'owner_stopped'
  || state?.interruptionReason === 'owner_stopped' || state?.result?.interruptionReason === 'owner_stopped';
const sameRoom = (binding, entry) => binding?.roomId === entry.roomId && binding?.persona === entry.name;
async function scope($) { return `${await $.session.id()}:${await $.session.root()}`; }
const stopKey = state => `${STOPPED}${state.session}:${state.agentId}`;

// Do not cache durable rows: the recipient and the notifier both update them.
async function read($, key, lease) { return await observed($, lease, () => $.store.get(key)) || {}; }
function change($, key, update, lease) {
  const pending = writes.then(async () => {
    const previous = await read($, key, lease), value = update(previous);
    let count = 0, bytes = 0, total = 0, existing = false;
    for (const other of await observed($, lease, () => $.store.keys())) {
      if (other === key) { existing = true; continue; }
      const charge = size(await observed($, lease, () => $.store.get(other))) + other.length * 4;
      total += charge;
      if (owned(other)) { count++; bytes += charge; }
    }
    const charge = size(value) + key.length * 4;
    // Reserve most of the shared 4 MiB store for native bindings and other hooks.
    // Never evict an unresolved claim merely to admit a newer notification.
    if ((!existing || size(value) > size(previous))
        && (count >= MAX_RECORDS || bytes + charge > MAX_BYTES || total + charge > 3 * 1024 * 1024)) {
      throw new Error('Roundtable notifier store budget exhausted.');
    }
    await observed($, lease, () => $.store.set(key, value));
    return value;
  });
  writes = pending.catch(() => {});
  return pending;
}
function write($, key, value, lease) { return change($, key, () => value, lease); }
function rememberNotice(id, deliveryId) {
  noticeTurns.set(id, deliveryId);
  if (noticeTurns.size > 256) noticeTurns.delete(noticeTurns.keys().next().value);
}
const noticeId = text => typeof text === 'string' && /^(?:The coordinator sent a message while you were working:\n)?\[Duet roundtable notice (roundtable:[a-zA-Z0-9:_-]{1,240})\](?:\n|$)/.exec(text)?.[1];
function wakeText(attempt) {
  const suffix = '\n\nRead the forum, answer what is addressed to you, and continue toward the roundtable goal.';
  const text = noticeId(attempt.text) ? attempt.text : `[Duet roundtable notice ${attempt.deliveryId}]\n${attempt.text}`;
  const available = MAX_NOTICE_CHARS - suffix.length;
  if (text.endsWith(suffix) && text.length <= MAX_NOTICE_CHARS) return text;
  return (text.length > available ? text.slice(0, available - 1) + '…' : text) + suffix;
}
async function waitingNotice($, entry, key, attempt, lease) {
  if (attempt.prompted || await observed($, lease, () => $.clock.now()) - attempt.readyAt < WAKE_GRACE_MS) return;
  await change($, key, current => ({ ...current, attempt: { ...current.attempt, prompted: true } }), lease);
  const result = await observed($, lease, () => $.session.append({ message: { type: 'user', content: [{ type: 'text',
    text: `Roundtable ${entry.roomId}: ${entry.name} have updates waiting; run \`duet roundtable status ${entry.roomId}\` to deliver them.` }] } }));
  if (result?.deny !== undefined) await change($, key, current => ({ ...current, attempt: { ...current.attempt, prompted: false } }), lease);
}

// The host may resume a named agent without its declared subagentType. A marked
// notice is routed by its durable native room binding, never by that shell row.
export async function roundtableNotice($, e, lease) {
  if (!e.agentId) return null;
  const direct = noticeId(e.text);
  // Remember before discovery/store I/O: even a failure must stay model-free.
  const session = await observed($, lease, () => $.session.id()), id = `${await scope($)}:${e.agentId}:${e.turnId}`;
  if (direct) rememberNotice(id, direct);
  const state = await observed($, lease, () => $.store.get(keyFor(session, e.agentId)));
  let hinted = direct || noticeTurns.get(id) || (state?.incoming?.turnId === e.turnId && noticeId(state.incoming.text));
  if (!hinted && state?.roundtable) {
    const record = await read($, memberKey(session, state.roundtable.roomId, state.roundtable.persona), lease);
    if (record.receipt?.turnId === e.turnId) hinted = record.receipt.deliveryId;
  }
  if (!hinted) return null;
  rememberNotice(id, hinted);
  if (!state || state.session !== session || state.agentId !== e.agentId || !isNativeType(state.type)
      || !state.roundtable || state.bindingPending) throw new Error('Roundtable notice has no native recipient binding.');
  const key = memberKey(session, state.roundtable.roomId, state.roundtable.persona);
  let duplicate;
  await change($, key, current => {
    const receipt = current.receipt;
    if (current.attempt?.deliveryId !== hinted && receipt?.deliveryId !== hinted) throw new Error('Roundtable notice has no delivery claim.');
    // Only an accepted notice launched work; a received one may be retried.
    duplicate = receipt?.deliveryId === hinted && receipt.turnId !== e.turnId && receipt.status === 'accepted';
    if (duplicate || receipt?.turnId === e.turnId) return current;
    return { ...current, receipt: { deliveryId: hinted, turnId: e.turnId,
      status: state.status === 'needs_answer' || state.answer?.status === 'needs_answer' ? 'deferred' : 'received' } };
  }, lease);
  knownTypes.set(e.agentId, state.type);
  return { agent: { id: e.agentId, type: state.type, name: state.name }, deliveryId: hinted, duplicate, key };
}
export async function isRoundtableNoticeTurn($, e) {
  return Boolean(noticeId(e.text) || noticeTurns.has(`${await scope($)}:${e.agentId}:${e.turnId}`));
}
export async function settleRoundtableNotice($, notice, status, lease) {
  await change($, notice.key, current => {
    if (current.receipt?.deliveryId !== notice.deliveryId) throw new Error('Roundtable receipt changed.');
    return { ...current, receipt: { ...current.receipt, status } };
  }, lease);
}

function invalidate(loop) {
  loop.generation++;
  loop.timer?.cancel();
  if (loops.get(loop.id) === loop) loops.delete(loop.id);
  for (const key of noticeTurns.keys()) if (key.startsWith(loop.id + ':')) noticeTurns.delete(key);
}
async function check($, lease) {
  if (!lease) return;
  const valid = () => {
    if (lease.loop.generation !== lease.generation || loops.get(lease.id) !== lease.loop) throw new Error('Roundtable notifier ended.');
  };
  valid(); const session = await $.session.id(); valid();
  const root = await $.session.root(); valid();
  if (`${session}:${root}` !== lease.id) { invalidate(lease.loop); throw new Error('Roundtable session changed.'); }
}
async function observed($, lease, action) {
  await check($, lease);
  try { return await action(); }
  finally { await check($, lease); }
}
async function run($, state, args, { input = '', timeoutMs = 5000, deadline, lease } = {}) {
  const timing = { timeoutMs, deadline };
  let request;
  if (lease) {
    if (!lease.loop.node) {
      const budget = Math.min(500, deadline - await observed($, lease, () => $.clock.now()));
      if (budget < 1) throw new Error('Roundtable lookup deadline expired.');
      const resolved = await observed($, lease, () => $.process.run(['node', '-p', 'process.execPath'], { timeoutMs: budget }));
      const executable = resolved.stdout.trim();
      if (resolved.exitCode !== 0 || !/^(\/|[A-Za-z]:[\\/])/.test(executable) || /[\r\n]/.test(executable)) throw new Error('Node executable unavailable.');
      lease.loop.node = executable;
    }
    request = { argv: [lease.loop.node, `${$.plugin.root}/bin/duet`, ...args, '--cwd', state.cwd, '--session', state.session], cwd: state.cwd, input };
  } else request = await command($, state, args, input, timing);
  // Room commands are session-scoped and deliberately reject --cwd. Keep the
  // helper's process cwd and Node resolution, omitting only its CLI cwd pair.
  if (['forum', 'roundtable'].includes(args[0])) {
    const index = request.argv.lastIndexOf('--cwd');
    if (index >= 0) request.argv.splice(index, 2);
  }
  const budget = await observed($, lease, () => processBudget($, timing));
  const result = await observed($, lease, () => $.process.run(request.argv, { cwd: request.cwd, stdin: request.input, timeoutMs: budget }));
  if (result.exitCode !== 0 || result.isStdoutTruncated) throw new Error('Roundtable companion receipt unavailable.');
  return JSON.parse(result.stdout);
}

export async function stopRoundtableMember($, state, lease) {
  if (!state?.roundtable || !PERSONA_IDS.includes(state.roundtable.persona)) return;
  const key = stopKey(state), record = { ...state.roundtable, session: state.session, cwd: state.cwd, agentId: state.agentId };
  await write($, key, record, lease);
  await syncStop($, record, lease?.deadline, lease);
}
async function syncStop($, record, deadline, lease) {
  if (record.synced) return;
  await run($, record, ['forum', 'member', record.roomId, '--member', record.persona, '--status', 'stopped', '--json'],
    { timeoutMs: 1000, deadline, lease });
  await write($, stopKey(record), { ...record, synced: true }, lease);
}

async function resolveMember($, entry, session, lease) {
  const candidates = [];
  for (const agent of await observed($, lease, () => $.agent.list())) {
    const state = await observed($, lease, () => $.store.get(keyFor(session, agent.id)));
    if (!state || state.session !== session || state.agentId !== agent.id || state.bindingPending || !state.cwd
        || await observed($, lease, () => $.store.get(bindingFailedKey(session, agent.id)))) continue;
    if (!isNativeType(agent.type) && !(isNativeType(state.type) && sameRoom(state.roundtable, entry))) continue;
    if (state.roundtable && !sameRoom(state.roundtable, entry)) continue;
    if ((state.jobId && entry.jobIds?.includes(state.jobId)) || (state.threadId && state.threadId === entry.threadId)
        || sameRoom(state.roundtable, entry) || agent.name === entry.name) candidates.push({ agent, state });
  }
  // The host stops listing an agent once its run ends, which is exactly when a
  // wake is needed. Fall back to this session's durable native bindings, which
  // carry the agent id and room binding; stop authority stays with those
  // bindings, the room's member status and the synced stop records.
  if (!candidates.length) {
    const prefix = keyFor(session, '');
    for (const key of await observed($, lease, () => $.store.keys())) {
      if (!key.startsWith(prefix)) continue;
      const state = await observed($, lease, () => $.store.get(key));
      if (!state || state.session !== session || !state.agentId || key !== keyFor(session, state.agentId)
          || state.bindingPending || !state.cwd || !isNativeType(state.type) || !sameRoom(state.roundtable, entry)
          || !entry.jobIds?.includes(state.jobId) || (entry.threadId && state.threadId !== entry.threadId)
          || await observed($, lease, () => $.store.get(bindingFailedKey(session, state.agentId)))) continue;
      candidates.push({ agent: { id: state.agentId, name: state.name, type: state.type }, state });
    }
  }
  // An exact id/thread and a second matching name are still ambiguous. Never
  // choose whichever entry $.agent.list happened to return first.
  return candidates.length === 1 ? candidates[0] : null;
}

async function workspaceAvailable($, state, entry, key, lease) {
  let directory;
  try { directory = await observed($, lease, () => $.fs.stat(state.cwd, { resolve: true })); }
  catch (error) {
    if (error?.code !== 'ENOENT' && !/ENOENT|no such file/i.test(error?.message || '')) throw error;
  }
  if (directory?.kind !== 'dir') {
    if (!(await read($, key, lease)).workspaceRemoved) {
      await change($, key, current => ({ ...current, workspaceRemoved: true }), lease);
      const result = await observed($, lease, () => $.session.append({ message: { type: 'user', content: [{ type: 'text',
        text: `Roundtable ${entry.roomId}: ${entry.name} cannot continue because its workspace was removed.` }] } }));
      if (result?.deny !== undefined) await change($, key, current => ({ ...current, workspaceRemoved: false }), lease);
    }
    return false;
  }
  return true;
}

async function deliverMember($, context, entry, deadline, lease, wake = false) {
  if (!PERSONA_IDS.includes(entry.name) || entry.persona !== entry.name || entry.roomStatus !== 'open') return;
  const key = `${PREFIX}${context.session}:${entry.roomId}:${entry.name}`;
  let record = await read($, key, lease);
  const maxSeq = Math.max(...entry.events.map(event => event.seq));
  if (!Number.isSafeInteger(maxSeq) || maxSeq < 1) return;
  const acknowledge = upto => run($, context, ['forum', 'ack', entry.roomId, '--member', entry.name, '--upto', String(upto), '--json'], { deadline, lease });
  const finish = async upto => {
    record = await change($, key, current => ({ ...current, attempt: undefined, upto: Math.max(current.upto || 0, upto) }), lease);
    await acknowledge(record.upto);
  };
  // Flush an unacknowledged prefix before interpreting a newer batch's wake
  // flag, which may refer only to that already delivered prefix.
  if (entry.events.some(event => event.seq <= (record.upto || 0))) { await acknowledge(record.upto); return; }
  const match = await resolveMember($, entry, context.session, lease);
  if (!match) return;
  const { agent, state } = match;
  const room = await run($, context, ['roundtable', 'status', entry.roomId, '--json'], { deadline, lease });
  const member = room.members?.find(member => member.name === entry.name && member.persona === entry.persona);
  if (room.sessionId !== context.session || room.status !== 'open' || !member) return;
  if (!sameRoom(state.roundtable, entry) && !member.jobIds?.includes(state.jobId)
      && !(state.threadId && state.threadId === member.threadId)) return;
  if (member.status === 'stopped') { await finish(maxSeq); return; }
  if (agent.status === 'killed' || stopped(state) || (await read($, stopKey(state), lease)).roomId) {
    await stopRoundtableMember($, { ...state, roundtable: { roomId: entry.roomId, persona: entry.persona } }, lease);
    await finish(maxSeq); return;
  }
  if (state.incoming || !state.jobId || !member.jobIds?.includes(state.jobId)) return;
  if (!await workspaceAvailable($, state, entry, key, lease)) return;
  const { job, recovery } = await run($, state, ['status', state.jobId, '--json'], { deadline, lease });
  if (job?.id !== state.jobId || job.sessionId !== context.session || !sameRoom(job.request?.roundtable, entry)
      || (state.ownerId && state.ownerId !== job.ownerId) || (member.threadId && member.threadId !== job.threadId)) return;
  if (recovery) job.recovery = recovery;
  if (stopped(job)) {
    await stopRoundtableMember($, { ...state, roundtable: job.request.roundtable }, lease);
    await finish(maxSeq); return;
  }
  // A question is not an idle assignment: a forum notice must never become
  // the answer to ask_parent or to an approval prompt.
  if (job.pendingQuestion && job.pendingQuestion.answer === undefined) return;
  if (state.status === 'needs_answer' || state.answer?.status === 'needs_answer') return;
  let attempt = record.attempt;
  // A newer job proves the member moved on (woken by this notice or continued
  // by hand), so an uncertain older notice is settled instead of blocking all
  // later ones. Otherwise reconcile a recipient receipt or retry the idle wake.
  if (attempt && attempt.jobId !== job.id) { await finish(attempt.maxSeq); return; }
  if (attempt && record.receipt?.deliveryId === attempt.deliveryId) {
    if (record.receipt.status === 'accepted') { await finish(attempt.maxSeq); return; }
    // Explicitly parked at a question: only a later terminal job may be woken.
    if (record.receipt.status === 'deferred' && (active(job) || !ended(job, state))) return;
    // Received but never accepted: the continuation did not launch, so the
    // single wake retry below still applies.
  }
  if (attempt?.phase === 'ready' && (active(job) || !ended(job, state))) return;
  if (attempt?.phase === 'wake') {
    // At most one retry, including a notice deferred at a question.
    // Honor older relay claims across upgrades.
    if (attempt.reminded || attempt.retried) return;
    if (!Number.isFinite(attempt.sentAt)) {
      // Older claims predate timestamps: start their grace period on observation.
      const sentAt = await observed($, lease, () => $.clock.now());
      await change($, key, current => ({ ...current, attempt: { ...attempt, sentAt } }), lease);
      return;
    }
    if (active(job) || !ended(job, state)
        || await observed($, lease, () => $.clock.now()) - attempt.sentAt < WAKE_GRACE_MS) return;
    attempt = { ...attempt, phase: 'idle', retried: true };
  }
  if (!attempt) {
    if (!active(job) && !ended(job, state)) return;
    if (!active(job) && !entry.wake) { await finish(maxSeq); return; }
    const text = entry.text;
    if (typeof text !== 'string' || !text.trim() || text.length > 65536) return;
    attempt = { maxSeq, text: `[Duet roundtable notice roundtable:${entry.roomId}:${entry.name}:${maxSeq}]\n${text}`, wake: entry.wake, jobId: job.id, phase: active(job) ? 'steer' : 'idle',
      deliveryId: `roundtable:${entry.roomId}:${entry.name}:${maxSeq}` };
    record = { ...record, attempt };
    await write($, key, { ...record, receipt: undefined }, lease);
  }
  if (attempt.phase === 'steer') {
    const receipt = await run($, state, ['steer', attempt.jobId, '--delivery-id', attempt.deliveryId, '--owner', job.ownerId],
      { input: attempt.text, timeoutMs: 12000, deadline, lease });
    if (receipt.jobId !== attempt.jobId || receipt.deliveryId !== attempt.deliveryId) return;
    if (['applied', 'queued'].includes(receipt.status)) { await finish(attempt.maxSeq); return; }
    if (receipt.status !== 'deferred') return;
    // This notifier owns the id and its write-ahead wake claim. Even if a lost
    // receipt already consumed the companion's fallback flag, phase=steer
    // proves we have not submitted an idle wake for this notice yet.
    attempt = { ...attempt, phase: 'idle' };
    record = await change($, key, current => ({ ...current, attempt }), lease);
  }
  if (!attempt.wake) { await finish(attempt.maxSeq); return; }
  if (attempt.phase !== 'ready') {
    const readyAt = await observed($, lease, () => $.clock.now());
    attempt = { ...attempt, phase: 'ready', readyAt, text: wakeText(attempt) };
    await change($, key, current => ({ ...current, attempt }), lease);
  }
  // A timer has plugin-level origin: downstream hooks would all be skipped.
  // Only a main-loop tool.call frame may send; its re-entry exclusion leaves
  // the adapter's agent/turn hooks active. The timer merely records readiness.
  if (!wake) { await waitingNotice($, entry, key, attempt, lease); return; }
  // Recheck after discovery/steering: stop, pause and questions can arrive
  // while awaiting I/O. The adapter also refuses concurrent assignments.
  const latest = await resolveMember($, entry, context.session, lease);
  const current = await run($, context, ['roundtable', 'status', entry.roomId, '--json'], { deadline, lease });
  const latestMember = current.members?.find(member => member.name === entry.name && member.persona === entry.persona);
  if (!latest || latest.agent.id !== agent.id || latest.agent.status === 'killed' || stopped(latest.state)
      || (await read($, stopKey(state), lease)).roomId || current.sessionId !== context.session || current.status !== 'open'
      || !latestMember || latestMember.status === 'stopped' || !latestMember.jobIds?.includes(attempt.jobId)) return;
  if (latest.state.incoming || latest.state.jobId !== attempt.jobId
      || !sameRoom(latest.state.roundtable, entry)
      || latest.state.status === 'needs_answer' || latest.state.answer?.status === 'needs_answer') return;
  if (!await workspaceAvailable($, latest.state, entry, key, lease)) return;
  const fresh = await run($, latest.state, ['status', attempt.jobId, '--json'], { deadline, lease });
  if (fresh.job?.id !== attempt.jobId || fresh.job.sessionId !== context.session
      || !sameRoom(fresh.job.request?.roundtable, entry) || fresh.job.ownerId !== job.ownerId
      || fresh.job.threadId !== job.threadId || (latestMember.threadId && latestMember.threadId !== fresh.job.threadId) || stopped(fresh.job)
      || (fresh.job.pendingQuestion && fresh.job.pendingQuestion.answer === undefined)
      || active(fresh.job) || !ended({ ...fresh.job, recovery: fresh.recovery }, latest.state)) return;
  const sentAt = await observed($, lease, () => $.clock.now());
  await change($, key, current => ({ ...current, attempt: { ...attempt, phase: 'wake', sentAt } }), lease);
  await observed($, lease, () => $.session.send({ to: latest.agent.id, text: attempt.text }));
  // Queuing alone is insufficient: only the recipient can accept the notice.
  record = await read($, key, lease);
  if (record.receipt?.deliveryId === attempt.deliveryId && record.receipt.status === 'accepted') await finish(attempt.maxSeq);
}

async function chairNotice($, context, entry, deadline, lease) {
  const key = memberKey(context.session, entry.roomId, 'chair'), record = await read($, key, lease);
  const events = entry.events.filter(event => Number.isSafeInteger(event.seq) && event.seq > (record.upto || 0));
  if (!events.length) return;
  const room = await run($, context, ['roundtable', 'status', entry.roomId, '--json'], { deadline, lease });
  if (room.status !== 'open' || room.sessionId !== context.session) return;
  const batch = events.slice(0, 20), upto = Math.max(...batch.map(event => event.seq));
  const text = `Roundtable ${entry.roomId}: ${batch.map(event => `#${event.seq} ${event.kind} ${JSON.stringify(event.title || event.delta || '')}`).join('; ')}. Read the forum to address these chair updates.`;
  await write($, key, { upto }, lease);
  // A lost receipt stays claimed; a definite refusal restores the exact cursor.
  const result = await observed($, lease, () => $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } }));
  if (result?.deny !== undefined) await write($, key, record, lease);
}
const entryKey = entry => entry && `${entry.roomId}:${entry.name || ''}`;
const rotate = (entries, cursor) => {
  const start = Math.max(0, entries.findIndex(entry => entryKey(entry) === cursor));
  return [...entries.slice(start), ...entries.slice(0, start)];
};
async function pruneRecords($, context, loop, deadline, lease) {
  const keys = (await observed($, lease, () => $.store.keys())).filter(key => owned(key) && key.startsWith(key.startsWith(PREFIX)
    ? `${PREFIX}${context.session}:` : `${STOPPED}${context.session}:`));
  const rooms = [];
  for (const key of keys) {
    const record = await read($, key, lease);
    const roomId = key.startsWith(PREFIX) ? key.slice(`${PREFIX}${context.session}:`.length).split(':')[0] : record.roomId;
    if (roomId && !rooms.some(room => room.roomId === roomId)) rooms.push({ roomId });
  }
  const ordered = rotate(rooms, loop.pruneCursor);
  // Maintenance has a separate small budget and cannot consume delivery time.
  for (const room of ordered.slice(0, 2)) {
    if (await observed($, lease, () => $.clock.now()) >= deadline) break;
    loop.pruneCursor = entryKey(rooms[(rooms.findIndex(value => value.roomId === room.roomId) + 1) % rooms.length]);
    const current = await run($, context, ['roundtable', 'status', room.roomId, '--json'], { timeoutMs: 1000, deadline, lease });
    if (current.sessionId !== context.session || current.status !== 'closed') continue;
    for (const key of keys) if (key.startsWith(memberKey(context.session, room.roomId, ''))
        || (key.startsWith(STOPPED) && (await read($, key, lease)).roomId === room.roomId)) await observed($, lease, () => $.store.delete(key));
  }
}

async function deliveryPass($, loop, wake = false, token) {
  const { id } = loop;
  if (loop.busy || loops.get(id) !== loop) return;
  const lease = { id, loop, generation: loop.generation, token };
  loop.busy = lease;
  try {
    const context = { session: await observed($, lease, () => $.session.id()), cwd: await observed($, lease, () => $.session.root()) };
    // No idle wake is possible without a native room binding. Ordinary tool
    // calls (including refused Agent calls) must not start companion processes.
    if (wake) {
      let bound = false;
      for (const key of await observed($, lease, () => $.store.keys())) {
        if (!key.startsWith(keyFor(context.session, ''))) continue;
        const state = await read($, key, lease);
        if (state.session === context.session && state.roundtable && isNativeType(state.type)) { bound = true; break; }
      }
      if (!bound) return;
    }
    const start = await observed($, lease, () => $.clock.now());
    if (wake && start - (loop.lastDeliveryAt ?? -Infinity) < DELIVERY_INTERVAL_MS) return;
    if (wake) loop.lastDeliveryAt = start;
    const deadline = start + (wake ? 10000 : 30000);
    lease.deadline = deadline - 2000;
    const entries = await run($, context, ['forum', 'pending', '--json'], { deadline: start + 5000, lease });
    if (!Array.isArray(entries)) return;
    const chairs = rotate(entries.filter(entry => entry.name === 'chair' && entry.roomStatus === 'open'), loop.chairCursor);
    // Commit each completed room immediately, rotate after every attempt,
    // and reserve at least 18 seconds for members even with slow chairs.
    for (const entry of (wake ? [] : chairs.slice(0, 2))) {
      if (await observed($, lease, () => $.clock.now()) >= start + 10000) break;
      loop.chairCursor = entryKey(chairs[(chairs.indexOf(entry) + 1) % chairs.length]);
      try { await chairNotice($, context, entry, start + 10000, lease); } catch { /* Next room/tick. */ }
    }
    const members = rotate(entries.filter(entry => entry.name !== 'chair'), loop.memberCursor);
    for (const entry of (wake ? members.slice(0, 6) : members)) {
      if (await observed($, lease, () => $.clock.now()) >= deadline - 2000) break;
      loop.memberCursor = entryKey(members[(members.indexOf(entry) + 1) % members.length]);
      try { await deliverMember($, context, entry, deadline - 2000, lease, wake); }
      catch { /* Uncertain outcomes retain their claims and remain unacked. */ }
    }
    if (wake) return;
    const stopKeys = (await observed($, lease, () => $.store.keys())).filter(key => key.startsWith(`${STOPPED}${context.session}:`));
    const offset = Math.max(0, stopKeys.indexOf(loop.stopCursor));
    let stops = 0;
    for (const key of [...stopKeys.slice(offset), ...stopKeys.slice(0, offset)]) {
      if (stops >= 2 || await observed($, lease, () => $.clock.now()) >= deadline) break;
      loop.stopCursor = stopKeys[(stopKeys.indexOf(key) + 1) % stopKeys.length];
      const record = await read($, key, lease);
      if (record.synced) continue;
      stops++;
      try { await syncStop($, record, deadline, lease); } catch { /* Retry next tick. */ }
    }
    await pruneRecords($, context, loop, deadline, lease);
  } catch { /* Discovery outages and invalidated callbacks never start replacement work. */ }
  finally { if (loop.busy === lease) loop.busy = false; }
}
// Host calls do not spend a hook's budget, so bound each pass on the clock
// (a little past its own deadline). A stalled host call then cannot hold the
// chair's finished tool result or keep later passes out: the abandoned pass
// is fenced, failing its next lease check, and its claims stay uncertain.
async function boundedPass($, loop, wake = false) {
  const token = {};
  let timer;
  try {
    const expired = new Promise(resolve => { timer = $.clock.after(wake ? 12000 : 32000, () => resolve(true)); });
    if (await Promise.race([deliveryPass($, loop, wake, token), expired]) === true && loop.busy?.token === token) {
      loop.generation++; loop.busy = false;
    }
  } finally { try { timer?.cancel(); } catch { /* Already fired. */ } }
}

export async function startRoundtableNotifier($) {
  const id = await scope($);
  if (!loops.has(id)) {
    const loop = { id, generation: 0, busy: false };
    loops.set(id, loop);
    loop.timer = $.clock.every(10000, () => boundedPass($, loop).catch(() => {}));
  }
  return loops.get(id);
}

export function registerRoundtableNotifier(on) {
  on('tool.call', async ($, e, next) => {
    let loop;
    if (!e.agentId) {
      try { loop = await startRoundtableNotifier($); } catch { /* Keep the tool available. */ }
    }
    const result = await next(e);
    if (loop) {
      try { await boundedPass($, loop, true); }
      catch { /* Notification outages never replace or fail the tool result. */ }
    }
    return result;
  });
  on('session.start', async ($, e, next) => {
    if (!e.agentId) await startRoundtableNotifier($).catch(() => {});
    return next(e);
  }).catch(($, e, next) => next(e));
  on('session.end', async ($, e, next) => {
    if (e.agentId) return next(e);
    if (e.sessionId) for (const loop of loops.values()) if (loop.id.startsWith(e.sessionId + ':')) invalidate(loop);
    const session = e.sessionId || await $.session.id();
    for (const loop of loops.values()) if (loop.id.startsWith(session + ':')) invalidate(loop);
    await writes;
    for (const key of await $.store.keys()) if (key.startsWith(`${PREFIX}${session}:`) || key.startsWith(`${STOPPED}${session}:`)) await $.store.delete(key);
    for (const key of noticeTurns.keys()) if (key.startsWith(session + ':')) noticeTurns.delete(key);
    return next(e);
  }).catch(($, e, next) => next(e));
}
