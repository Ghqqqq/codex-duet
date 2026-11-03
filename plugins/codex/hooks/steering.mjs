// session.send runs in the sender before the recipient's queue (host d.ts
// SessionSendInput/Result). session.receive runs inside the recipient's turn;
// it is not our interception point while turn.step owns that turn's wait.
import { isNativeType } from './presets.mjs';
const UNKNOWN_REASON = 'Codex steering outcome unknown; the message may or may not have reached the running turn and will not be resent automatically. Inspect the Duet job before resending.';
async function deliveryId($, session, agentId) {
  return `${session}:${agentId}:${await $.clock.now()}:${Math.random().toString(36).slice(2)}`;
}
function command($, state, args, input = '') {
  return { argv: ['node', `${$.plugin.root}/bin/duet`, ...args, '--cwd', state.cwd, '--session', state.session], cwd: state.cwd, input };
}
async function resolveJob($, state) {
  const request = command($, state, ['status', '--all', '--json', '--dispatch-nonce', state.intent.nonce]);
  const result = await $.process.run(request.argv, { cwd: request.cwd, timeoutMs: 5000 });
  if (result.exitCode !== 0 || result.isStdoutTruncated) return;
  const snapshot = JSON.parse(result.stdout);
  const jobs = [...(snapshot.running ?? []), snapshot.latestFinished, ...(snapshot.recent ?? [])].filter(Boolean);
  const matches = jobs.filter(job => job.sessionId === state.session && job.dispatchNonce === state.intent.nonce);
  if (matches.length === 1) Object.assign(state, { jobId: matches[0].id, ownerId: matches[0].ownerId });
}
export function registerSteering(on) {
  on('session.send', async ($, e, next) => {
    let attempted = false;
    try {
      // Only the main conversation steers. Subagent and teammate sends keep the
      // ordinary queue, where the teammate mailbox guard judges them.
      if (e.agentId || typeof e.text !== 'string' || !e.text.trim() || e.text.length > 65536) return next(e);
      const agents = await $.agent.list();
      const matches = agents.filter(agent => agent.id === e.to || agent.name?.toLowerCase() === e.to.toLowerCase());
      if (matches.length !== 1 || !isNativeType(matches[0].type) || matches[0].status !== 'running') return next(e);
      const session = await $.session.id();
      const state = await $.store.get(`native:v2:${session}:${matches[0].id}`);
      if (!state || state.session !== session || state.bindingPending || state.status === 'needs_answer' || state.answer?.status === 'needs_answer') return next(e);
      // An early send can precede the progress lookup that publishes jobId.
      // Resolve its durable launch nonce; never spawn or mutate its binding.
      if (!state.jobId && state.intent?.kind === 'task') await resolveJob($, state);
      if (!state.jobId || !state.ownerId) return next(e);
      const id = await deliveryId($, session, matches[0].id);
      const request = command($, state, ['steer', state.jobId, '--delivery-id', id, '--owner', state.ownerId], e.text);
      attempted = true;
      const result = await $.process.run(request.argv, { cwd: request.cwd, stdin: request.input, timeoutMs: 12000 });
      if (result.exitCode !== 0 || result.isStdoutTruncated) throw new Error('Steering receipt unavailable.');
      const receipt = JSON.parse(result.stdout);
      if (receipt.jobId !== state.jobId || receipt.deliveryId !== id || !['queued', 'applied', 'deferred', 'failed', 'unknown'].includes(receipt.status)) throw new Error('Invalid steering receipt.');
      if (receipt.status === 'deferred' && receipt.fallback === true) return next(e);
      const text = `Codex steering ${receipt.status}${receipt.status === 'unknown' ? '; acknowledgement missing, message will not be replayed' : ''}.`;
      try { await $.session.append({ message: { type: 'system', content: [{ type: 'text', text }] } }); }
      catch { /* A notice failure cannot replay a durable delivery. */ }
      if (receipt.status === 'unknown') return { isDelivered: false, reason: UNKNOWN_REASON };
      return receipt.status === 'failed' ? { isDelivered: false,
        reason: `Codex steering failed (${receipt.reason ?? 'steer_rejected'}); the message will not be resent automatically. Inspect the Duet job before resending.` } : { isDelivered: true };
    } catch {
      // After process launch a lost receipt is ambiguous. Never release that
      // text to the host queue, which could start a second Codex turn.
      return attempted ? { isDelivered: false, reason: UNKNOWN_REASON } : next(e);
    }
  }).catch(() => ({ isDelivered: false, reason: UNKNOWN_REASON }));
}
