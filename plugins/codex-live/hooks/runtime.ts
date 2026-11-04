import { atom, update } from 'claude-code';
import type { EngineInterface } from 'claude-code';
import type { CodexLiveState, CodexNativeActivity } from '../types';
import { boundState, clean, validView } from './model';
import { limitChars } from './text';
// The host scanner requires atom declarations at their read/write call sites.
const view = atom({ plugin: 'fugato-live', key: 'view' } as const,
  { jobs: [], selectedId: null, nowMs: 0 } as CodexLiveState);
let failure = '';
export const updateFailure = () => failure;
// Only scroll/poll consume these measurements; render always uses its props.
export const viewports = new Map<string, { columns: number; bodyRows: number }>();
let repairLogged = false;
export function checkedView($: EngineInterface, value: unknown): CodexLiveState {
  if (validView(value)) { repairLogged = false; return value; }
  if (!repairLogged) {
    repairLogged = true;
    try { $.ui.log('fugato-live: Repaired malformed pane cache; rediscovering job records', { to: 'debug' }); }
    catch { /* Diagnostics cannot prevent cache repair. */ }
  }
  return { jobs: [], selectedId: null, nowMs: 0 };
}
export function reportFailure($: EngineInterface, error: unknown) {
  failure = limitChars(clean(error instanceof Error ? error.message : String(error)), 300);
  try { $.ui.log(`fugato-live: Pane update failed · ${failure}`, { to: 'debug' }); } catch { /* Logging cannot mask the original failure. */ }
  try { $.ui.invalidate('ui.render'); } catch { /* The next draw also reads failure. */ }
}
async function saveView($: EngineInterface, change: (state: CodexLiveState) => CodexLiveState, prepared = false): Promise<boolean> {
  try {
    await update($, view, state => prepared ? change(checkedView($, state)) : boundState(change(checkedView($, state))));
    const hadFailure = !!failure;
    failure = '';
    if (hadFailure) $.ui.invalidate('ui.render');
    return true;
  } catch (error) { reportFailure($, error); return false; }
}

export function writeView($: EngineInterface, change: (state: CodexLiveState) => CodexLiveState): Promise<boolean> {
  return saveView($, change);
}

// Only a person-run command calls this; reading another plugin's metadata does
// not grant permission to dispatch, resume or alter a Codex job.
export async function nativeActivity($: EngineInterface, target: string): Promise<CodexNativeActivity | undefined> {
  const agents = { plugin: 'fugato', key: 'nativeAgents' } as const;
  const { value } = await $.state.get(agents);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const matches = Object.entries(value).filter(([id, entry]) => entry && typeof entry === 'object' &&
    (id === target || entry.name === target) && typeof entry.jobId === 'string' && entry.jobId &&
    typeof entry.threadId === 'string' && typeof entry.workspace === 'string');
  return matches.length === 1 ? matches[0]![1] : undefined;
}

// Polling has already bounded and laid out this candidate. Reuse it during the
// CAS update. Conflicts recompose from the latest interaction state in this
// same update, so continuous scrolling cannot starve job/status publication.
export async function publishView($: EngineInterface, expected: string, candidate: CodexLiveState,
  compose: (latest: CodexLiveState) => CodexLiveState): Promise<CodexLiveState | undefined> {
  let published = candidate;
  const saved = await saveView($, latest => {
    published = JSON.stringify(latest) === expected ? candidate : compose(latest);
    return published;
  }, true);
  return saved ? published : undefined;
}
