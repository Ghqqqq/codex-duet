import { nativeIdentity, isNativeType } from './presets.mjs';

export const PREFIX = 'native:v2:';
export const BINDING_FAILED = 'native:binding-failed:v1:';
export const keyFor = (session, id) => `${PREFIX}${session}:${id}`;
export const bindingFailedKey = (session, id) => `${BINDING_FAILED}${session}:${id}`;
export const startedTypes = new Map();
export const knownTypes = new Map();

export async function ours($, id) {
  if (!id) return null;
  const session = await $.session.id(), key = keyFor(session, id);
  const startedType = startedTypes.get(key);
  let row;
  try { row = (await $.agent.list()).find(agent => agent.id === id); }
  catch { /* Spawn identity and durable bindings also survive list outages. */ }
  if (row) { knownTypes.set(id, row.type); return nativeIdentity({ declaredType: row.type }) ? row : null; }
  // Spawn resolves before list discovery and before the first durable binding.
  const spawnType = knownTypes.get(id);
  if (spawnType !== undefined && !isNativeType(spawnType)) return null;
  const type = nativeIdentity({ spawnType, classicType: startedType });
  if (type) return { id, type };
  const state = await $.store.get(key);
  if (nativeIdentity({ spawnType, bindingType: state?.type, classicType: startedType, isTeammate: state?.isTeammate })) {
    return { id, type: state.type, name: state.name, isTeammate: state.isTeammate };
  }
  const guard = await $.store.get(bindingFailedKey(session, id));
  return guard && (!startedType || nativeIdentity({ spawnType, bindingType: guard.type, classicType: startedType, isTeammate: guard.isTeammate }))
    ? { id, type: guard.type, isTeammate: guard.isTeammate } : null;
}
