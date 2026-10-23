import { register as reportDelivery } from './report-delivery.mjs';
import { register as claudeMemory } from './claude-memory.mjs';
import { register as nativeAgent } from './native-agent.mjs';

export function register(on) {
  // Keep each registration independent; the hook sandbox requires direct calls.
  try { reportDelivery(on); } catch { /* The other modules can still register. */ }
  try { claudeMemory(on); } catch { /* Native registration can still proceed. */ }
  try { nativeAgent(on); } catch { /* Native readiness stays disabled. */ }
}
