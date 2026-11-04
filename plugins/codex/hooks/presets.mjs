// Exact declared types, never a teammate's name from classic agent_type.
export const AGENT_TYPE = 'fugato:codex-native';
export const PRESETS = Object.freeze({
  [AGENT_TYPE]: Object.freeze({ rolePrompt: null, sandbox: null, speed: null }),
  'fugato:codex-reviewer': Object.freeze({
    rolePrompt: 'Codex reviewer role: Review the assigned changes without modifying files. Prioritize actionable correctness, regression and security findings; cite file locations and explain impact. Report checks actually run and any review limits.',
    sandbox: 'read-only', speed: null
  }),
  'fugato:codex-implementer': Object.freeze({
    rolePrompt: 'Codex implementer role: Implement the bounded assignment in the authorized workspace. Respect owned paths and existing changes, keep the solution focused, and run appropriate verification. Report the changes, observed checks and remaining limitations.',
    sandbox: 'workspace-write', speed: null
  }),
  'fugato:codex-investigator': Object.freeze({
    rolePrompt: 'Codex investigator role: Investigate the assigned question without modifying files. Trace the relevant code and evidence, distinguish observations from hypotheses, and report supported conclusions with file locations and remaining uncertainty.',
    sandbox: 'read-only', speed: null
  })
});
export const isNativeType = type => typeof type === 'string' && Object.hasOwn(PRESETS, type);

export function nativeIdentity({ declaredType, spawnType, bindingType, classicType, isTeammate }) {
  // A live roster row beats stale durable state, including a reused host id.
  if (declaredType !== undefined) return isNativeType(declaredType) ? declaredType : null;
  // Every observed spawn is authoritative for that host-id generation.
  if (spawnType !== undefined && !isNativeType(spawnType)) return null;
  if (classicType && !isNativeType(classicType) && !isTeammate) return null;
  if (isNativeType(spawnType)) return spawnType;
  if (isNativeType(classicType)) return classicType;
  // A non-native classic type identifies another agent unless the binding
  // pins it as a teammate (whose classic type is only its display name).
  if (isNativeType(bindingType) && (!classicType || isTeammate)) return bindingType;
  return null;
}

// Null model/effort/speed values leave the saved worker defaults or the thread
// settings alone. Presets constrain task flags, not the Claude shell model.
export function applyPreset(parsed, preset, permissionMode) {
  if (!preset) return parsed;
  const flags = [...parsed.flags], sandboxAt = flags.indexOf('--sandbox');
  if (sandboxAt >= 0 && preset.sandbox && flags[sandboxAt + 1] !== preset.sandbox) {
    const error = new Error(`This Codex role requires the ${preset.sandbox} sandbox; a conflicting DUET header was refused.`);
    error.code = 'native_preset_sandbox';
    throw error;
  }
  if (sandboxAt < 0 && preset.sandbox) flags.push('--sandbox', permissionMode === 'plan' ? 'read-only' : preset.sandbox);
  for (const flag of ['model', 'effort']) {
    if (preset[flag] && !flags.includes(`--${flag}`)) flags.push(`--${flag}`, preset[flag]);
  }
  if (preset.speed && !flags.includes('--fast') && !flags.includes('--normal')) flags.push(`--${preset.speed}`);
  return { ...parsed, flags, brief: preset.rolePrompt ? `${preset.rolePrompt}\n\n${parsed.brief}` : parsed.brief };
}
