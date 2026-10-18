import { atom, update } from 'claude-code';
import type { EngineInterface } from 'claude-code';
import type { CodexLiveState } from '../types';
import { boundState, clean } from './model';
import { limitChars } from './text';
// The host scanner requires atom declarations at their read/write call sites.
const view = atom({ plugin: 'codex-live', key: 'view' } as const,
  { jobs: [], selectedId: null, nowMs: 0 } as CodexLiveState);
let failure = '';
export const updateFailure = () => failure;
export const viewports = new Map<string, { columns: number; bodyRows: number }>();
export function reportFailure($: EngineInterface, error: unknown) {
  failure = limitChars(clean(error instanceof Error ? error.message : String(error)), 300);
  try { $.ui.log(`codex-live: Pane update failed · ${failure}`, { to: 'debug' }); } catch { /* Logging cannot mask the original failure. */ }
  try { $.ui.invalidate('ui.render'); } catch { /* The next draw also reads failure. */ }
}
export async function writeView($: EngineInterface, change: (state: CodexLiveState) => CodexLiveState): Promise<boolean> {
  try {
    await update($, view, state => boundState(change(state)));
    const hadFailure = !!failure;
    failure = '';
    if (hadFailure) $.ui.invalidate('ui.render');
    return true;
  } catch (error) { reportFailure($, error); return false; }
}
