import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { listSessionJobs, resolveStateRoot } from "./state.mjs";
import { TIER_1_NAMES, TIER_2_NAMES, TIER_3_NAMES, NAME_TIER_WEIGHTS } from "./agent-name-pool.mjs";

const tiers = [TIER_1_NAMES, TIER_2_NAMES, TIER_3_NAMES];
export const AGENT_NAMES = Object.freeze(tiers.flat());
const weightedNames = tiers.flatMap((names, tier) =>
  names.map(name => ({ name, weight: NAME_TIER_WEIGHTS[tier] }))
);

export function pickAgentName(usedNames, random = Math.random) {
  const used = new Set([...usedNames].map(name => name.toLowerCase()));
  const available = weightedNames.filter(({ name }) => !used.has(name.toLowerCase()));
  const candidates = available.length ? available : weightedNames;
  let ticket = random() * candidates.reduce((sum, { weight }) => sum + weight, 0);
  // The last candidate also covers floating-point rounding at the upper edge.
  let base = candidates[candidates.length - 1].name;
  for (const { name, weight } of candidates) {
    if (ticket < weight) {
      base = name;
      break;
    }
    ticket -= weight;
  }
  if (available.length) return base;
  let suffix = 2;
  while (used.has(`${base}-${suffix}`.toLowerCase())) suffix++;
  return `${base}-${suffix}`;
}

// Keep session reservations outside the pruned workspace indexes. Exclusive
// creation reserves a name before its job is published, even across workspaces.
// Reservations have no age limit; a rejected, unlaunched dispatch can release its own.
// onReserved reports only a new selection, not backfills for earlier jobs.
export function reserveAgentName(usedNames, { cwd, sessionId, preferredName = null, threadId = null, onReserved = undefined }, random = Math.random) {
  const used = new Set([...usedNames].map(name => name.toLowerCase()));
  if (!sessionId) return preferredName && !used.has(preferredName.toLowerCase()) ? preferredName : pickAgentName(used, random);
  const hash = value => createHash("sha256").update(value).digest("hex");
  const directory = path.join(path.dirname(resolveStateRoot()), "agent-names", hash(sessionId));
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const reserve = name => {
    try {
      fs.writeFileSync(path.join(directory, hash(name.toLowerCase())), "", { flag: "wx", mode: 0o600 });
      return true;
    } catch (error) {
      if (error.code === "EEXIST") return false;
      throw error;
    }
  };
  const jobs = listSessionJobs(cwd, sessionId);
  for (const job of jobs) {
    if (!job.agentName) continue;
    used.add(job.agentName.toLowerCase());
    reserve(job.agentName);
  }
  if (preferredName) {
    const owners = jobs.filter(job => job.agentName?.toLowerCase() === preferredName.toLowerCase());
    if (threadId && owners.length && owners.every(job => job.threadId === threadId)) return preferredName;
    if (!used.has(preferredName.toLowerCase()) && reserve(preferredName)) {
      onReserved?.(preferredName);
      return preferredName;
    }
  }
  for (;;) {
    const name = pickAgentName(used, random);
    if (reserve(name)) {
      onReserved?.(name);
      return name;
    }
    used.add(name.toLowerCase());
  }
}

// Only release a name reported by onReserved for a dispatch that never launched.
// Reused names and reservations backfilled for earlier jobs belong to them.
export function releaseAgentName(sessionId, name) {
  if (!sessionId || !name) return false;
  const hash = value => createHash("sha256").update(value).digest("hex");
  const file = path.join(path.dirname(resolveStateRoot()), "agent-names", hash(sessionId), hash(name.toLowerCase()));
  try { fs.unlinkSync(file); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
