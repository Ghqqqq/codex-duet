import { createHash, randomUUID } from "node:crypto";
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
// onReserved reports a new selection or native claim, never earlier jobs.
// A claim supplies its own rollback: keep the pre-spawn reservation pinned.
export function reserveAgentName(usedNames, { cwd, sessionId, preferredName = null, threadId = null,
  reserveForSpawn = false, claimOwner = null, onReserved = undefined }, random = Math.random) {
  const used = new Set([...usedNames].map(name => name.toLowerCase()));
  if (!sessionId) return preferredName && !used.has(preferredName.toLowerCase()) ? preferredName : pickAgentName(used, random);
  const hash = value => createHash("sha256").update(value).digest("hex");
  const directory = path.join(path.dirname(resolveStateRoot()), "agent-names", hash(sessionId));
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const reservationFile = name => path.join(directory, hash(name.toLowerCase()));
  const reserve = (name, forSpawn = false) => {
    try {
      fs.writeFileSync(reservationFile(name), forSpawn ? "native-spawn\n" : "", { flag: "wx", mode: 0o600 });
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
    if (!used.has(preferredName.toLowerCase())) {
      // Only a native dispatch may consume a pre-spawn reservation. A second
      // exclusive file makes the handoff atomic across workspace locks, and
      // the dispatch nonce makes a retry by the same owner idempotent.
      if (claimOwner) {
        const file = reservationFile(preferredName), claim = `${file}.claim`;
        let pending = false;
        try { pending = fs.readFileSync(file, "utf8") === "native-spawn\n"; }
        catch (error) { if (error.code !== "ENOENT") throw error; }
        if (pending) {
          let claimed = false;
          // Publish complete ownership atomically; a crash during the write
          // must not leave an empty claim that rejects the same nonce's retry.
          const temporary = `${claim}.${randomUUID()}.tmp`;
          fs.writeFileSync(temporary, claimOwner, { flag: "wx", mode: 0o600 });
          try { fs.linkSync(temporary, claim); claimed = true; }
          catch (error) { if (error.code !== "EEXIST") throw error; }
          finally { fs.unlinkSync(temporary); }
          if (claimed) {
            onReserved?.(preferredName, () => fs.unlinkSync(claim));
            return preferredName;
          }
          if (fs.readFileSync(claim, "utf8") === claimOwner) return preferredName;
        }
      }
      if (reserve(preferredName, reserveForSpawn)) {
        onReserved?.(preferredName);
        return preferredName;
      }
    }
  }
  for (;;) {
    const name = pickAgentName(used, random);
    if (reserve(name, reserveForSpawn)) {
      onReserved?.(name);
      return name;
    }
    used.add(name.toLowerCase());
  }
}

// Only release a name reported by onReserved for a dispatch that never launched.
// Reused names and reservations backfilled for earlier jobs belong to them.
// A native claim uses its supplied rollback instead, retaining the spawn's name.
export function releaseAgentName(sessionId, name) {
  if (!sessionId || !name) return false;
  const hash = value => createHash("sha256").update(value).digest("hex");
  const file = path.join(path.dirname(resolveStateRoot()), "agent-names", hash(sessionId), hash(name.toLowerCase()));
  try { fs.unlinkSync(file); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
