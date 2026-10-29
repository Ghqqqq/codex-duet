import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { listSessionJobs, resolveStateRoot, withJournalLock } from "./state.mjs";
import { TIER_1_NAMES, TIER_2_NAMES, TIER_3_NAMES, NAME_TIER_WEIGHTS } from "./agent-name-pool.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const HASH = /^[a-f0-9]{64}$/;
const CLAIM_TEMP = /^[a-f0-9]{64}\.claim\.(?:(\d+)\.)?[a-f0-9-]{36}\.tmp$/;
function namesRoot(env = process.env, create = false) {
  const root = path.join(path.dirname(resolveStateRoot(env)), "agent-names");
  for (const dir of [path.dirname(path.dirname(root)), path.dirname(root), root]) {
    if (create) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!fs.lstatSync(dir).isDirectory()) throw new Error(`Unsafe name reservation directory: ${dir}`);
  }
  return root;
}
function livePid(pid) {
  if (!pid) return false;
  try { process.kill(Number(pid), 0); return true; }
  catch (error) { return error.code !== "ESRCH"; }
}

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
// Reservations survive job-count pruning; retention retires only expired,
// quiescent sessions. A rejected, unlaunched dispatch can release its own.
// onReserved reports a new selection or native claim, never earlier jobs.
// A claim supplies its own rollback: keep the pre-spawn reservation pinned.
export function reserveAgentName(usedNames, options, random = Math.random) {
  const { cwd, sessionId, preferredName = null } = options;
  const used = new Set([...usedNames].map(name => name.toLowerCase()));
  if (!sessionId) return preferredName && !used.has(preferredName.toLowerCase()) ? preferredName : pickAgentName(used, random);
  // Inventory may migrate workspace state. Do it before taking the names lock:
  // dispatch/adoption hold a workspace lock before entering this namespace.
  const jobs = listSessionJobs(cwd, sessionId), root = namesRoot(process.env, true);
  return withJournalLock(root, () => reserveSessionName(used, options, jobs, root, random));
}
function reserveSessionName(used, { sessionId, preferredName = null, threadId = null,
  reserveForSpawn = false, claimOwner = null, onReserved = undefined }, jobs, root, random) {
  const directory = path.join(root, hash(sessionId));
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(directory).isDirectory()) throw new Error("Unsafe name reservation directory.");
  // Claim retries and same-thread reuse also renew the namespace before the
  // workspace publishes its job, closing the reservation/publication window.
  const now = new Date(); fs.utimesSync(directory, now, now);
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
          const temporary = `${claim}.${process.pid}.${randomUUID()}.tmp`;
          fs.writeFileSync(temporary, claimOwner, { flag: "wx", mode: 0o600 });
          try { fs.linkSync(temporary, claim); claimed = true; }
          catch (error) { if (error.code !== "EEXIST") throw error; }
          finally { fs.unlinkSync(temporary); }
          if (claimed) {
            onReserved?.(preferredName, () => withJournalLock(root, () => fs.unlinkSync(claim)));
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
  try {
    const root = namesRoot();
    return withJournalLock(root, () => {
      const directory = path.join(root, hash(sessionId));
      if (!fs.lstatSync(directory).isDirectory()) throw new Error("Unsafe name reservation directory.");
      fs.unlinkSync(path.join(directory, hash(name.toLowerCase())));
      return true;
    });
  } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

function inspectNames(root, cutoff, sessions) {
  const protectedHashes = sessions && new Set([...sessions].map(hash));
  const report = { agentNameSessions: [], agentNameTemporaries: [], errors: [] };
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!HASH.test(entry.name)) continue;
    const directory = path.join(root, entry.name);
    try {
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory()) throw new Error("Unsafe name reservation directory; retaining it.");
      let newest = stat.mtimeMs, bytes = 0, liveWriter = false;
      const temporaries = [];
      for (const name of fs.readdirSync(directory)) {
        const temporary = CLAIM_TEMP.exec(name);
        if (!HASH.test(name) && !/^[a-f0-9]{64}\.claim$/.test(name) && !temporary) throw new Error("Unknown name reservation artifact; retaining session.");
        const file = path.join(directory, name), info = fs.lstatSync(file);
        if (!info.isFile()) throw new Error("Unsafe name reservation artifact; retaining session.");
        newest = Math.max(newest, info.mtimeMs); bytes += info.size;
        const live = temporary && livePid(temporary[1]);
        liveWriter ||= Boolean(live);
        if (temporary && !live && info.mtimeMs < cutoff) temporaries.push({ path: file, bytes: info.size });
      }
      if (protectedHashes && !protectedHashes.has(entry.name) && !liveWriter && newest < cutoff) {
        report.agentNameSessions.push({ path: directory, bytes });
      } else report.agentNameTemporaries.push(...temporaries);
    } catch (error) { report.errors.push({ path: directory, message: error.message }); }
  }
  return report;
}
/**
 * @param {number} cutoff
 * @param {{env?: NodeJS.ProcessEnv, inspectSessions?: () => Set<string> | null}} options
 */
export function planAgentNames(cutoff, { env = process.env, inspectSessions } = {}) {
  try {
    const root = namesRoot(env);
    return inspectNames(root, cutoff, inspectSessions());
  } catch (error) {
    return { agentNameSessions: [], agentNameTemporaries: [], errors: error.code === "ENOENT" ? [] : [{ scope: "agent-names", message: error.message }] };
  }
}
/**
 * @param {*} plan
 * @param {number} cutoff
 * @param {{env?: NodeJS.ProcessEnv, inspectSessions?: () => Set<string> | null}} options
 */
export function pruneAgentNames(plan, cutoff, { env = process.env, inspectSessions } = {}) {
  const report = { agentNameSessionsDeleted: 0, agentNameTemporariesDeleted: 0, bytesFreed: 0, errors: [] };
  if (!plan.agentNameSessions?.length && !plan.agentNameTemporaries?.length) return report;
  try {
    const root = namesRoot(env);
    // Never acquire workspace locks here: writers take workspace -> names.
    // An incomplete or locked workspace inventory protects every namespace.
    withJournalLock(root, () => {
      const current = inspectNames(root, cutoff, inspectSessions());
      report.errors.push(...current.errors);
      /** @type {Array<[string, string, boolean]>} */
      const groups = [["agentNameSessions", "agentNameSessionsDeleted", true], ["agentNameTemporaries", "agentNameTemporariesDeleted", false]];
      for (const [key, counter, directory] of groups) {
        const selected = new Set((plan[key] ?? []).map(item => item.path));
        for (const item of current[key]) {
          if (!selected.has(item.path)) continue;
          try {
            if (directory) fs.rmSync(item.path, { recursive: true });
            else fs.unlinkSync(item.path);
            report[counter] += 1; report.bytesFreed += item.bytes;
          } catch (error) { report.errors.push({ path: item.path, message: error.message }); }
        }
      }
    });
  } catch (error) { if (error.code !== "ENOENT") report.errors.push({ scope: "agent-names", message: error.message }); }
  return report;
}
