import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { listSessionJobs, resolveStateRoot } from "./state.mjs";

// Historical (deceased) scientists, mathematicians and computing pioneers.
// ASCII names of at most 11 letters keep pane labels compact. Suffixes such as
// "-2" appear only after a session has used every name.
export const AGENT_NAMES = Object.freeze([
  "Ada", "Turing", "Hopper", "Curie", "Noether", "Euler", "Gauss", "Kepler",
  "Faraday", "Shannon", "Dijkstra", "Hamming", "Ramanujan", "Hypatia", "Fibonacci",
  "Newton", "Leibniz", "Pascal", "Babbage", "Boole", "Euclid", "Archimedes",
  "Galileo", "Copernicus", "Maxwell", "Planck", "Einstein", "Bohr", "Fermi", "Dirac",
  "Heisenberg", "Schrodinger", "Boltzmann", "Tesla", "Volta", "Ampere", "Ohm",
  "Joule", "Watt", "Kelvin", "Fourier", "Laplace", "Lagrange", "Cauchy", "Riemann",
  "Hilbert", "Cantor", "Poincare", "Galois", "Church", "Neumann", "Zuse",
  "Atanasoff", "Aiken", "Wilkes", "Backus", "McCarthy", "Minsky", "Engelbart",
  "Jacobi", "Pythagoras", "Thales", "Ptolemy", "Hipparchus", "Diophantus",
  "Aristarchus", "Democritus", "Aryabhata", "Brahmagupta", "Bhaskara", "Madhava",
  "Khwarizmi", "Alhazen", "Biruni", "Khayyam", "Seki", "Napier", "Descartes",
  "Fermat", "Bernoulli", "Agnesi", "Germain", "Legendre", "Abel", "Bolyai",
  "Lobachevsky", "Hamilton", "Sylvester", "Cayley", "Dedekind", "Kummer",
  "Weierstrass", "Liouville", "Mobius", "Grassmann", "Klein", "Peano", "Frege",
  "Zermelo", "Lebesgue", "Markov", "Lyapunov", "Kolmogorov", "Banach", "Ulam",
  "Erdos", "Godel", "Hardy", "Kleene", "Tutte", "Conway", "Nash", "Somerville",
  "Huygens", "Hooke", "Halley", "Herschel", "Brahe", "Coulomb", "Oersted",
  "Kirchhoff", "Helmholtz", "Hertz", "Doppler", "Heaviside", "Gibbs", "Rayleigh",
  "Lorentz", "Zeeman", "Roentgen", "Becquerel", "Rutherford", "Moseley", "Bragg",
  "Millikan", "Michelson", "Minkowski", "Sommerfeld", "Debye", "Pauli", "Meitner",
  "Chadwick", "Compton", "Bose", "Saha", "Raman", "Yukawa", "Majorana", "Landau",
  "Kapitsa", "Cherenkov", "Feynman", "Bethe", "Schwinger", "Lemaitre", "Hubble",
  "Leavitt", "Hawking", "Sagan", "Tsiolkovsky", "Korolev", "Lomonosov", "Boyle",
  "Cavendish", "Priestley", "Scheele", "Lavoisier", "Dalton", "Avogadro", "Davy",
  "Berzelius", "Wohler", "Liebig", "Bunsen", "Kekule", "Mendeleev", "Arrhenius",
  "Ostwald", "Nernst", "Hahn", "Pauling", "Hodgkin", "Franklin", "Hippocrates",
  "Galen", "Vesalius", "Harvey", "Linnaeus", "Jenner", "Lamarck", "Cuvier",
  "Humboldt", "Darwin", "Wallace", "Mendel", "Pasteur", "Lister", "Golgi", "Cajal",
  "Pavlov", "Fleming", "McClintock", "Crick", "Hutton", "Lyell", "Wegener", "Mohs",
  "Richter", "Schickard", "Jacquard", "Hollerith", "Nyquist", "Hartley", "Wiener",
  "Huffman", "Eckert", "Mauchly", "Bartik", "Holberton", "Sammet", "Hartree",
  "Welchman", "Rejewski", "Licklider", "Newell", "Rosenblatt", "McCulloch", "Pitts",
  "Perlis", "Iverson", "Kemeny", "Floyd", "Cocke", "Naur", "Wirth", "Ritchie",
  "Postel", "Baran", "Kilby", "Noyce"
]);

export function pickAgentName(usedNames, random = Math.random) {
  const used = new Set([...usedNames].map(name => name.toLowerCase()));
  const available = AGENT_NAMES.filter(name => !used.has(name.toLowerCase()));
  if (available.length) return available[Math.floor(random() * available.length)];
  const base = AGENT_NAMES[Math.floor(random() * AGENT_NAMES.length)];
  let suffix = 2;
  while (used.has(`${base}-${suffix}`.toLowerCase())) suffix++;
  return `${base}-${suffix}`;
}

// Keep session reservations outside the pruned workspace indexes. Exclusive
// creation reserves a name before its job is published, even across workspaces.
// Reservations have no age limit: a long-lived session must never recycle them.
export function reserveAgentName(usedNames, { cwd, sessionId, preferredName = null, threadId = null }, random = Math.random) {
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
    if (!used.has(preferredName.toLowerCase()) && reserve(preferredName)) return preferredName;
  }
  for (;;) {
    const name = pickAgentName(used, random);
    if (reserve(name)) return name;
    used.add(name.toLowerCase());
  }
}
