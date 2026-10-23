import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { listSessionJobs, resolveStateRoot } from "./state.mjs";

// Historical scientists and computing pioneers; ASCII names keep pane labels compact.
export const AGENT_NAMES = Object.freeze([
  "Ada", "Turing", "Hopper", "Curie", "Noether", "Euler", "Gauss", "Kepler",
  "Faraday", "Shannon", "Dijkstra", "Hamming", "Ramanujan", "Hypatia", "Fibonacci",
  "Newton", "Leibniz", "Pascal", "Babbage", "Boole", "Euclid", "Archimedes",
  "Galileo", "Copernicus", "Maxwell", "Planck", "Einstein", "Bohr", "Fermi", "Dirac",
  "Heisenberg", "Schrodinger", "Boltzmann", "Tesla", "Volta", "Ampere", "Ohm",
  "Joule", "Watt", "Kelvin", "Fourier", "Laplace", "Lagrange", "Cauchy", "Riemann",
  "Hilbert", "Cantor", "Poincare", "Galois", "Church", "Neumann", "Zuse",
  "Atanasoff", "Aiken", "Wilkes", "Backus", "McCarthy", "Minsky", "Engelbart", "Jacobi"
]);

export function pickAgentName(usedNames, random = Math.random) {
  const used = new Set(usedNames);
  const available = AGENT_NAMES.filter(name => !used.has(name));
  if (available.length) return available[Math.floor(random() * available.length)];
  const base = AGENT_NAMES[Math.floor(random() * AGENT_NAMES.length)];
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) suffix++;
  return `${base}-${suffix}`;
}

// Keep session reservations outside the pruned workspace indexes. Exclusive
// creation reserves a name before its job is published, even across workspaces.
// Reservations have no age limit: a long-lived session must never recycle them.
export function reserveAgentName(usedNames, { cwd, sessionId }, random = Math.random) {
  if (!sessionId) return pickAgentName(usedNames, random);
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
  const used = new Set(usedNames);
  for (const job of listSessionJobs(cwd, sessionId)) {
    if (!job.agentName) continue;
    used.add(job.agentName);
    reserve(job.agentName);
  }
  for (;;) {
    const name = pickAgentName(used, random);
    if (reserve(name)) return name;
    used.add(name);
  }
}
