import { ours } from './native-identity.mjs';

// Host-facing team compatibility stays separate from identity and role flags.
export async function teammateUnsupported($, input) {
  let settings = {}, enabled;
  try {
    enabled = await $.env.get('CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS');
    settings = await $.settings.read();
    enabled ??= settings.env?.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
    const teammate = input.isTeammate || ['1', 'true'].includes(String(enabled).toLowerCase());
    if (!teammate) return null;
    const mode = await $.env.get('CLAUDE_CODE_TEAMMATE_MODE') || settings.teammateMode || 'auto';
    if (!['auto', 'in-process'].includes(mode)) {
      return 'Codex teammates require an in-process local loop; split-pane and unknown teammate modes are unsupported. Select in-process teammate mode or use a local subagent.';
    }
    if (input.planModeRequired || input.plan_mode_required) {
      return 'Codex teammates do not support team plan approval, task claiming or peer mailboxes. Give the worker a bounded assignment and use parent SendMessage follow-ups.';
    }
    return null;
  } catch {
    return input.isTeammate || ['1', 'true'].includes(String(enabled).toLowerCase())
      ? 'Codex teammate mode could not be verified; no local Codex dispatch was authorized.' : null;
  }
}

// Auto is allowed; pane agents have no local loop and use their address as id.
export const paneTeammate = result => Boolean(result?.teammateId && result.agentId === result.teammateId)
  || Boolean(result?.status === 'teammate_spawned' && result.teammate_id
    && (result.agentId ?? result.agent_id) === result.teammate_id);

// Pure so the steering boundary can share this guard without another mailbox.
export const unsupportedTeammateDelivery = origin => typeof origin?.teammate === 'string'
  && (origin.kind !== 'coordinator' || origin.isVerified !== true);

function refusedDelivery(agent = {}) {
  const summary = 'Codex teammates accept verified coordinator follow-ups only; peer and unverified team mailboxes, task claiming and plan approval are unsupported.';
  return { consumed: JSON.stringify({ status: 'blocked', worker: agent.name || null, jobId: null, summary,
    blockers: [{ code: 'native_teammate_unsupported', message: summary }],
    next: 'Send the bounded assignment from the parent with SendMessage.', details: null }) };
}

export function register(on) {
  // Must register before any other session.receive hook for native agents,
  // especially steering: unsupported team deliveries must never steer a turn.
  on('session.receive', async ($, e, next) => {
    if (!e.agentId || !unsupportedTeammateDelivery(e.origin)) return next(e);
    const agent = await ours($, e.agentId);
    if (!agent) return next(e);
    return refusedDelivery(agent);
  }).catch(($, e, next) => e.agentId && unsupportedTeammateDelivery(e.origin) ? refusedDelivery() : next(e));
}
