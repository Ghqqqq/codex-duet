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
