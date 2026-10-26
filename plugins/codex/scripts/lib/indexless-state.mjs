import fs from "node:fs";
import path from "node:path";
import { unresolvedTask } from "./state.mjs";

const safeId = id => typeof id === "string" && /^[A-Za-z0-9_-]+$/.test(id);
function integer(value) {
  if (!["string", "number"].includes(typeof value) || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
}
function realDirectory(directory) {
  if (!fs.lstatSync(directory).isDirectory() || fs.realpathSync(directory) !== directory) throw new Error(`Unsafe directory (symlink or not a directory): ${directory}`);
}
function regularStat(file) {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (stat && !stat.isFile()) throw new Error(`Not a regular file: ${file}`);
  return stat;
}

// Match workspaceKey's trimmed ASCII slug and 16 lowercase SHA-256 digits.
const workspaceKeyPattern = /^[A-Za-z0-9._](?:[A-Za-z0-9._-]*[A-Za-z0-9._])?-[a-f0-9]{16}$/;
const uuid = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const lockOwner = new RegExp(`^owner-[1-9][0-9]*-${uuid}$`);
const stateTemporary = new RegExp(`^\\.(?:state\\.json|\\.legacy-migration\\.json)\\.[1-9][0-9]*\\.${uuid}\\.tmp$`);
const jobTemporary = new RegExp(`^\\.[A-Za-z0-9_-]+\\.json\\.[1-9][0-9]*\\.${uuid}\\.tmp$`);
const journalTemporary = new RegExp(`\\.${uuid}\\.tmp$`);
const journalId = value => /^[A-Za-z0-9_.:-]{1,128}$/.test(value) && ![".", ".."].includes(value);
const journalArtifact = name => {
  const match = /^(.*)\.(?:brief\.md|report\.json)$/.exec(name);
  // Reports may add a status suffix to the journal's safe job id.
  return !!match && (journalId(match[1]) || /^(.*)\.(completed|failed|cancelled|interrupted)$/.test(match[1]) && journalId(match[1].replace(/\.[^.]+$/, "")));
};

// Check the whole shape before interpreting id-less/unparsable artifacts as
// inert. Temporary writes and lock candidates always prevent the exemption.
function indexlessProvenance(workspace) {
  const name = path.basename(workspace);
  if (!workspaceKeyPattern.test(name)) return { reason: "unknown-content" };
  let pending = false;
  function visit(directory, parts = []) {
    return fs.readdirSync(directory, { withFileTypes: true }).every(entry => {
      const name = entry.name, file = entry.isFile(), dir = entry.isDirectory();
      let owned = false;
      if (!parts.length) {
        owned = dir && ["jobs", "runs", ".state-lock"].includes(name) || file && [".legacy-migration.json", "state.json", "broker.json"].includes(name);
        if (dir && name.startsWith(".") && lockOwner.test(name.slice(1)) || file && stateTemporary.test(name)) { owned = true; pending = true; }
      } else if (parts.length === 1 && parts[0] === "jobs") {
        owned = file && /^[A-Za-z0-9_-]+\.(?:json|log|output\.txt|result\.json)$/.test(name);
        if (file && jobTemporary.test(name)) { owned = true; pending = true; }
      } else if (parts.length === 1 && (parts[0] === ".state-lock" || lockOwner.test(parts[0].slice(1)))) {
        owned = file && lockOwner.test(name);
      } else if (parts[0] === "runs") {
        if (parts.length === 1) owned = dir && journalId(name);
        else if (parts.length === 2) owned = file && name === "journal.jsonl" || dir && name === "jobs";
        else if (parts.length === 3 && parts[2] === "jobs") {
          owned = file && journalArtifact(name);
          if (file && journalTemporary.test(name) && journalArtifact(name.replace(journalTemporary, ""))) { owned = true; pending = true; }
        }
      }
      return owned && (!dir || visit(path.join(directory, name), [...parts, name]));
    });
  }
  const contents = fs.readdirSync(workspace).filter(name => ["jobs", ".legacy-migration.json", "runs"].includes(name));
  if (!contents.some(name => ["jobs", ".legacy-migration.json"].includes(name)) || !visit(workspace)) return { reason: "unknown-content" };
  return { reason: pending ? "pending-write" : null };
}

// Read-only: a null reason exempts proven old, inert leftovers from incomplete
// inventories. Callers can supply their policy cutoff or a minimum age.
export function inertIndexlessWorkspace(workspace, { minAgeMs = 86400000, cutoffMs = Date.now() - minAgeMs } = {}) {
  if (!Number.isFinite(cutoffMs)) throw new Error("Invalid inert workspace cutoff.");
  realDirectory(workspace);
  const provenance = indexlessProvenance(workspace);
  if (provenance.reason) return { reason: provenance.reason, bytes: 0 };
  const observed = new Map();
  const statOf = file => { const stat = fs.lstatSync(file); observed.set(file, stat); return stat; };
  let newest = statOf(workspace).mtimeMs, bytes = 0, reason = null;
  const keep = value => { reason ??= value; };
  const livePid = value => {
    if (!value || typeof value !== "object") return false;
    return Object.entries(value).some(([key, item]) => /pid$/i.test(key) && alive(integer(item)) || livePid(item));
  };
  if (fs.lstatSync(path.join(workspace, "state.json"), { throwIfNoEntry: false })) keep("index-present");
  if (fs.lstatSync(path.join(workspace, "broker.json"), { throwIfNoEntry: false })) keep("broker-pointer");
  function visit(directory, relative = "") {
    realDirectory(directory);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name), name = path.join(relative, entry.name);
      const stat = statOf(file);
      newest = Math.max(newest, stat.mtimeMs);
      const owner = /^owner-(\d+)-/.exec(entry.name);
      if (owner && alive(Number(owner[1]))) keep("pid-alive");
      if (stat.isDirectory()) { visit(file, name); continue; }
      if (!stat.isFile()) { keep("unsafe-path"); continue; }
      bytes += stat.size;
      const text = fs.readFileSync(file, "utf8");
      let value;
      try { value = JSON.parse(text); } catch { /* Unparsable job artifacts are inert. */ }
      if (livePid(value) || /(?:^|\.)pid$/.test(entry.name) && alive(integer(text))) keep("pid-alive");
      // A parsed file without a job id cannot describe a job; like unparsable
      // artifacts it is inert. Job-shaped records must be terminal and settled.
      if (name.startsWith(`jobs${path.sep}`) && safeId(value?.id)) {
        if (!["completed", "failed", "cancelled", "interrupted"].includes(value.status)) keep("nonterminal-or-unknown-job");
        else if (value.ownerAttached || unresolvedTask(value)) keep("unresolved-or-attached-job");
      }
      if (name === ".legacy-migration.json" && value?.pending?.length) keep("pending-legacy");
    }
  }
  visit(workspace);
  const runs = path.join(workspace, "runs");
  if (fs.lstatSync(runs, { throwIfNoEntry: false })) {
    realDirectory(runs);
    for (const entry of fs.readdirSync(runs, { withFileTypes: true })) {
      if (!entry.isDirectory()) { keep("unknown-journal"); continue; }
      try {
        realDirectory(path.join(runs, entry.name));
        const file = path.join(runs, entry.name, "journal.jsonl");
        if (!regularStat(file)) throw new Error("Missing journal");
        const rows = fs.readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
        if (rows[0]?.type !== "run_started" || !rows.some(row => row.type === "run_closed")) keep("open-or-unknown-journal");
      } catch { keep("open-or-unknown-journal"); }
    }
  }
  if (newest >= cutoffMs) keep("recent-activity");
  // Publication may run concurrently with these reads. Never exempt a tree
  // whose entries or file contents changed during the inspection.
  for (const [file, before] of observed) {
    const after = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!after || ["ino", "mode", "size", "mtimeMs", "ctimeMs"].some(key => before[key] !== after[key])) keep("changed-during-read");
  }
  return { reason, bytes };
}
