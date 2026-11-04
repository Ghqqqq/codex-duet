import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolveIsolatedCodexHome } from "./codex-home.mjs";
import { withJournalLock, resolveStateDirForRoot, readJobFile } from "./state.mjs";
import { PERSONA_IDS, INTENSITIES } from "./roundtable-personas.mjs";
import { createMemberWorkspaces, rollbackMemberWorkspaces, memberWorkspaceStatus, candidateWorkspaceDiff } from "./roundtable-workspaces.mjs";

export const EVENT_KINDS = Object.freeze(["idea", "finding", "question", "request", "intent", "candidate", "decision"]);
const NOTIFICATION_WINDOW_MS = 30000;
const READ_EVENT_LIMIT = 25;
const READ_EVENT_BYTES = 128 * 1024;
const MEMBER_HISTORY_LIMIT = 10;
const roomIdPattern = /^rt-[a-z0-9]+-[a-z0-9-]+$/;
const identifier = value => typeof value === "string" && /^[A-Za-z0-9_.-]{1,128}$/.test(value);
const rootDir = env => path.join(resolveIsolatedCodexHome(env), "duet", "roundtables");
const iso = () => new Date().toISOString();
function roomPath(roomId, env) {
  if (typeof roomId !== "string" || roomId.length > 128 || !roomIdPattern.test(roomId)) throw new Error("Invalid roundtable roomId.");
  return path.join(rootDir(env), roomId);
}
function directory(target, env, create = false) {
  const home = resolveIsolatedCodexHome(env);
  if (create) fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  let current = home;
  for (const part of ["", ...path.relative(home, target).split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part);
    if (create && !fs.lstatSync(current, { throwIfNoEntry: false })) {
      try { fs.mkdirSync(current, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
    }
    if (!fs.lstatSync(current).isDirectory()) throw new Error(`Roundtable directory must not be a symlink: ${current}`);
    if (create && current !== home) fs.chmodSync(current, 0o700);
  }
  return target;
}
function regular(file, optional = false) {
  const stat = fs.lstatSync(file, { throwIfNoEntry: !optional });
  if (stat && !stat.isFile()) throw new Error(`Roundtable file must be regular, not a symlink: ${file}`);
}
function read(file) {
  regular(file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { return fs.readFileSync(fd, "utf8"); } finally { fs.closeSync(fd); }
}
function atomic(file, value) {
  regular(file, true);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}
function load(dir, roomId) {
  const room = JSON.parse(read(path.join(dir, "room.json")));
  if (room.version !== 1 || room.roomId !== roomId || !identifier(room.sessionId) || typeof room.goal !== "string" ||
      typeof room.workspaceRoot !== "string" || !path.isAbsolute(room.workspaceRoot) || !Object.hasOwn(INTENSITIES, room.intensity) ||
      !Number.isFinite(Date.parse(room.createdAt)) || (room.closedAt !== null && !Number.isFinite(Date.parse(room.closedAt))) ||
      (room.runId !== null && !identifier(room.runId)) || !["open", "paused", "closed"].includes(room.status) ||
      !Array.isArray(room.members) || !room.members.length || room.members.length > 6 ||
      new Set(room.members.map(member => member?.name)).size !== room.members.length || room.members.some(member =>
        !member || !PERSONA_IDS.includes(member.persona) || member.name !== member.persona || typeof member.model !== "string" || !member.model ||
        typeof member.effort !== "string" || !member.effort || !["seated", "active", "stopped"].includes(member.status) ||
        (member.workspace !== undefined && (!member.workspace || typeof member.workspace.path !== "string" || !path.isAbsolute(member.workspace.path) ||
          typeof member.workspace.shared !== "boolean" || (member.workspace.shared ? member.workspace.base !== null : !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(member.workspace.base)))) ||
        !Array.isArray(member.jobIds) || member.jobIds.some(id => !identifier(id)) || (member.threadId !== null && !identifier(member.threadId)) ||
        (member.initialSeq !== null && (!Number.isSafeInteger(member.initialSeq) || member.initialSeq < 1)) ||
        !Number.isSafeInteger(member.indexCursor) || member.indexCursor < 0 || !Number.isSafeInteger(member.notifiedSeq) || member.notifiedSeq < 0 ||
        (member.firstPendingAt !== null && !Number.isFinite(Date.parse(member.firstPendingAt))) ||
        !member.expanded || typeof member.expanded !== "object" || Array.isArray(member.expanded) ||
        Object.entries(member.expanded).some(([seq, max]) => !/^[1-9]\d*$/.test(seq) || !Number.isSafeInteger(max) || max < Number(seq)))) {
    throw new Error("Invalid roundtable room record.");
  }
  const text = read(path.join(dir, "events.jsonl"));
  // A newline commits an event. Repair an interrupted append before the next
  // post, and derive post metadata from the log after an interrupted room save.
  const committed = text.slice(0, text.lastIndexOf("\n") + 1);
  const events = committed ? committed.trimEnd().split("\n").map(JSON.parse) : [];
  for (const [index, event] of events.entries()) {
    if (event.seq !== index + 1 || !EVENT_KINDS.includes(event.kind) || !Number.isFinite(Date.parse(event.at)) ||
        !event.author || !["chair", "member"].includes(event.author.kind) ||
        (event.author.kind === "chair" ? event.author.name !== "chair" : !room.members.some(member => member.name === event.author.name && member.persona === event.author.persona)) ||
        (event.kind === "decision" && event.author.kind !== "chair") || typeof event.body !== "string" || event.body.length > 4000 ||
        (event.title !== null && (typeof event.title !== "string" || event.title.length > 160)) ||
        (event.label !== null && !["hypothesis", "draft", "observed"].includes(event.label)) || typeof event.initial !== "boolean" ||
        !Array.isArray(event.refs) || event.refs.length > 16 || event.refs.some(ref => typeof ref !== "string" || ref.length > 512) ||
        !Array.isArray(event.mentions) || event.mentions.length > 8 || event.mentions.some(name => name !== "chair" && !room.members.some(member => member.name === name)) ||
        (event.selects !== undefined && (event.kind !== "decision" || !Number.isSafeInteger(event.selects) || event.selects < 1 || event.selects >= event.seq || events[event.selects - 1]?.kind !== "candidate")) ||
        (event.unreviewed !== undefined && (event.selects === undefined || typeof event.unreviewed !== "string" || !event.unreviewed.trim() || event.unreviewed.length > 4000)) ||
        !Number.isSafeInteger(event.thread) || event.thread < 1 || event.thread > event.seq || events[event.thread - 1]?.thread !== event.thread ||
        (event.replyTo !== null && (!Number.isSafeInteger(event.replyTo) || event.replyTo < 1 || event.replyTo >= event.seq || events[event.replyTo - 1]?.thread !== event.thread))) {
      throw new Error("Invalid roundtable event log.");
    }
  }
  if (events.length > 5000) throw new Error("Invalid roundtable event count (maximum 5000).");
  room.nextSeq = events.length + 1;
  for (const member of room.members) {
    const initial = events.find(event => event.author.kind === "member" && event.author.name === member.name);
    if (initial && member.initialSeq === null) { member.initialSeq = initial.seq; member.indexCursor = 0; }
    if ((member.initialSeq !== null && member.initialSeq !== initial?.seq) || member.notifiedSeq > events.length) throw new Error("Invalid roundtable member cursors.");
  }
  return { room, events, bytes: Buffer.byteLength(committed) };
}
function locked(roomId, env, action) {
  const dir = directory(roomPath(roomId, env), env);
  const lock = fs.lstatSync(path.join(dir, ".state-lock"), { throwIfNoEntry: false });
  if (lock && !lock.isDirectory()) throw new Error("Roundtable lock must not be a symlink.");
  return withJournalLock(dir, () => action({ ...load(dir, roomId), dir }));
}
const save = (dir, room) => atomic(path.join(dir, "room.json"), room);
export function assertChair(room, sessionId = process.env.CODEX_COMPANION_SESSION_ID) {
  if (!sessionId || room.sessionId !== sessionId) throw new Error("Only the owning Claude session may act as roundtable chair.");
}
function identity(room, reader, env) {
  const actor = typeof reader === "string" ? { kind: reader === "chair" ? "chair" : "member", name: reader } : reader;
  if (actor?.kind === "chair" && actor.name === "chair") {
    assertChair(room, actor.sessionId ?? env.CODEX_COMPANION_SESSION_ID);
    return { actor: { kind: "chair", name: "chair" }, member: null };
  }
  const member = actor?.kind === "member" && room.members.find(value => value.name === actor.name);
  if (!member) throw new Error("Unknown roundtable member.");
  if (actor.persona !== undefined && actor.persona !== member.persona) throw new Error("Roundtable member persona does not match.");
  if (member.threadId && actor.threadId != null && actor.threadId !== member.threadId) throw new Error("This thread is not the roundtable member's bound thread.");
  const author = { kind: "member", name: member.name, persona: member.persona };
  for (const key of ["jobId", "threadId"]) if (actor[key] != null) {
    if (!identifier(actor[key])) throw new Error(`Invalid roundtable author ${key}.`);
    author[key] = actor[key];
  }
  return { actor: author, member };
}
const header = room => ({ roomId: room.roomId, runId: room.runId, goal: room.goal, intensity: room.intensity, status: room.status,
  members: room.members.map(({ name, persona }) => ({ name, persona })) });
const visible = (event, member) => !member || member.initialSeq !== null || event.kind === "decision" || event.author.name === member.name;
const wakes = (event, member) => event.kind === "decision" || event.mentions.includes(member.name);
function memberUpdates(events, member) {
  const threads = new Set(events.filter(event => event.author.name === member.name).map(event => event.thread));
  return events.filter(event => event.seq > member.notifiedSeq && event.author.name !== member.name && visible(event, member) &&
    (wakes(event, member) || (event.thread !== event.seq && threads.has(event.thread))));
}
const addressees = event => event.mentions;
function isOpen(event, events) {
  return ["question", "request"].includes(event.kind) && !events.some(reply => reply.replyTo === event.seq &&
    ((reply.author.kind === "chair" && reply.kind === "decision") ||
      (event.mentions.length ? event.mentions.includes(reply.author.name) : reply.author.name !== event.author.name)));
}
const open = events => events.filter(event => isOpen(event, events)).map(event => ({ ...event, addressees: addressees(event) }));
function integer(value, name, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  return value;
}
function textField(value, name, max, required = false) {
  if (value == null && !required) return null;
  if (typeof value !== "string" || (required && !value.trim()) || value.length > max) throw new Error(`${name} must be ${required ? "non-empty text" : "text"} of at most ${max} characters.`);
  return value;
}
const short = value => value.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ").slice(0, 160);
const delta = event => short(event.title || event.body);
const reviewed = (candidate, events) => events.some(event => event.seq > candidate.seq && event.thread === candidate.thread &&
  event.kind === "finding" && event.author.kind === "member" && event.author.name !== candidate.author.name);
function selection(events) {
  const decision = events.findLast(event => event.selects !== undefined);
  if (!decision) return null;
  const candidate = events[decision.selects - 1];
  return { seq: candidate.seq, resource: `candidate/${candidate.seq}`, decision: decision.seq,
    reviewed: reviewed(candidate, events.filter(event => event.seq < decision.seq)), unreviewed: decision.unreviewed ?? null };
}
function memberJobs(room, member, env, jobIds = member.jobIds) {
  return jobIds.map(jobId => {
    let job = null;
    for (const root of new Set([member.workspace?.path, room.workspaceRoot].filter(Boolean))) {
      try {
        const dir = directory(resolveStateDirForRoot(root, env), env), file = path.join(dir, "jobs", `${jobId}.json`);
        directory(path.dirname(file), env); regular(file);
        job = readJobFile(file);
        if (job.id !== jobId || job.sessionId !== room.sessionId) throw new Error("Job does not belong to this roundtable session.");
        break;
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    const report = job?.report ?? job?.result?.structured;
    const summary = report?.summary ?? job?.result?.structured?.summary ?? job?.summary ?? report?.keyFindings?.join(" ") ?? "";
    const status = (job?.pendingQuestion && job.pendingQuestion.answer === undefined) || job?.phase === "needs_answer" ? "needs_answer" : job?.status ?? "unknown";
    return { jobId, status, reportStatus: report?.status ?? null, summary: typeof summary === "string" ? summary.slice(0, 600) : "",
      details: `duet result ${jobId} --details` };
  });
}

// APIs accept an optional env argument for isolated callers/tests.
export function createRoom({ sessionId, workspaceRoot, goal, intensity = "standard", members, runId = null }, env = process.env) {
  if (!identifier(sessionId)) throw new Error("Roundtable needs CODEX_COMPANION_SESSION_ID.");
  if (typeof workspaceRoot !== "string" || !path.isAbsolute(workspaceRoot)) throw new Error("Roundtable needs an absolute workspaceRoot.");
  if (typeof goal !== "string" || !goal.trim()) throw new Error("Roundtable goal is required on stdin.");
  if (!Object.hasOwn(INTENSITIES, intensity)) throw new Error("Unknown roundtable intensity.");
  if (runId !== null && !identifier(runId)) throw new Error("Invalid roundtable runId.");
  if (!Array.isArray(members) || !members.length || members.length > 6 || new Set(members.map(member => member.persona)).size !== members.length) throw new Error("Roundtable needs 1–6 distinct personas.");
  const roster = members.map(({ persona, name = persona, model, effort }) => {
    if (!PERSONA_IDS.includes(persona) || name !== persona || typeof model !== "string" || !model || typeof effort !== "string" || !effort) throw new Error("Invalid roundtable roster member.");
    return { persona, name, model, effort, status: "seated", jobIds: [], threadId: null, initialSeq: null, indexCursor: 0, expanded: {}, notifiedSeq: 0, firstPendingAt: null };
  });
  const roomId = `rt-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const room = { version: 1, roomId, runId, sessionId, workspaceRoot, goal, intensity, status: "open", createdAt: iso(), closedAt: null, nextSeq: 1, members: roster };
  directory(rootDir(env), env, true);
  const dir = roomPath(roomId, env);
  fs.mkdirSync(dir, { mode: 0o700 }); // Refuse pre-existing rooms, including symlinks.
  let eventsCreated = false;
  try {
    createMemberWorkspaces(room, dir, env);
    withJournalLock(dir, () => {
      fs.writeFileSync(path.join(dir, "events.jsonl"), "", { flag: "wx", mode: 0o600 });
      eventsCreated = true;
      save(dir, room);
    });
  } catch (error) {
    try {
      rollbackMemberWorkspaces(room, env);
      if (eventsCreated) fs.unlinkSync(path.join(dir, "events.jsonl"));
      if (fs.lstatSync(path.join(dir, "worktrees"), { throwIfNoEntry: false })) fs.rmdirSync(path.join(dir, "worktrees"));
      fs.rmdirSync(dir);
    } catch (cleanup) { throw new Error(`${error.message}; ${cleanup.message}`); }
    throw error;
  }
  return room;
}
export function readRoom(roomId, env = process.env) { return locked(roomId, env, ({ room }) => room); }
export function listRooms(sessionId, env = process.env) {
  if (!identifier(sessionId)) throw new Error("Roundtable needs a valid session id.");
  let dir;
  try { dir = directory(rootDir(env), env); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  return fs.readdirSync(dir).filter(name => roomIdPattern.test(name)).map(name => readRoom(name, env))
    .filter(room => room.sessionId === sessionId).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.roomId.localeCompare(a.roomId));
}
export function postEvent(roomId, author, input, env = process.env) {
  return locked(roomId, env, ({ room, events, dir, bytes }) => {
    const { actor, member } = identity(room, author, env);
    if (member && (room.status === "closed" || member.status === "stopped")) throw new Error(`Cannot post: ${room.status === "closed" ? "roundtable is closed" : "member is stopped"}.`);
    if (!input || !EVENT_KINDS.includes(input.kind)) throw new Error(`Forum kind must be one of: ${EVENT_KINDS.join(", ")}.`);
    if (input.kind === "decision" && actor.kind !== "chair") throw new Error("Only the roundtable chair may post a decision.");
    let selects, unreviewed;
    if (input.selects !== undefined || input.unreviewed !== undefined) {
      if (input.kind !== "decision" || actor.kind !== "chair") throw new Error("Only a chair decision may select a candidate.");
      selects = integer(input.selects, "selects", 1);
      const candidate = events[selects - 1];
      if (candidate?.kind !== "candidate") throw new Error("Forum selects must name an existing candidate.");
      if (input.unreviewed !== undefined) unreviewed = textField(input.unreviewed, "Unreviewed reason", 4000, true);
      if (!reviewed(candidate, events) && !unreviewed) throw new Error(`Candidate #${selects} needs a non-author member finding in its thread; use --unreviewed <reason> to override.`);
    }
    if (events.length >= 5000) throw new Error("Roundtable has reached its 5000-event limit; start a new room.");
    const body = textField(input.body, "Forum body", 4000, true), title = textField(input.title, "Forum title", 160);
    const label = input.label ?? null;
    if (label !== null && !["hypothesis", "draft", "observed"].includes(label)) throw new Error("Invalid forum label.");
    const refs = input.refs ?? [], mentions = input.mentions ?? [];
    if (!Array.isArray(refs) || refs.length > 16 || refs.some(ref => typeof ref !== "string" || ref.length > 512)) throw new Error("Forum refs allow at most 16 strings of 512 characters each.");
    if (!Array.isArray(mentions) || mentions.length > 8 || mentions.some(name => name !== "chair" && !room.members.some(member => member.name === name))) throw new Error("Forum mentions allow at most 8 seated member names or chair.");
    const replyTo = input.replyTo ?? input.reply_to ?? null;
    const target = replyTo === null ? null : events.find(event => event.seq === integer(replyTo, "replyTo", 1));
    if (replyTo !== null && !target) throw new Error("Forum replyTo must name an existing event.");
    let thread = target?.thread ?? room.nextSeq;
    if (input.thread != null) {
      const root = events.find(event => event.seq === integer(input.thread, "thread", 1));
      if (!root || root.thread !== root.seq) throw new Error("Forum thread must name an existing root post.");
      if (target && target.thread !== root.seq) throw new Error("Forum thread does not match replyTo's thread.");
      thread = root.seq;
    }
    const event = { seq: room.nextSeq, at: iso(), author: actor, kind: input.kind, thread, replyTo, title, body, label, refs, mentions: [...new Set(mentions)], initial: Boolean(member && member.initialSeq === null),
      ...(selects !== undefined ? { selects, ...(unreviewed !== undefined ? { unreviewed } : {}) } : {}) };
    const file = path.join(dir, "events.jsonl");
    regular(file);
    const fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW);
    try {
      fs.fchmodSync(fd, 0o600);
      fs.ftruncateSync(fd, bytes);
      try { fs.writeFileSync(fd, `${JSON.stringify(event)}\n`); fs.fsyncSync(fd); }
      catch (error) { fs.ftruncateSync(fd, bytes); fs.fsyncSync(fd); throw error; }
    } finally { fs.closeSync(fd); }
    room.nextSeq++;
    // A decision may have advanced the sealed index past hidden peer posts.
    // Unsealing must reveal those earlier records on the next default read.
    if (event.initial) { member.initialSeq = event.seq; member.indexCursor = 0; }
    save(dir, room);
    return event;
  });
}
export function readIndex(roomId, reader, { after, limit = 50 } = {}, env = process.env) {
  return locked(roomId, env, ({ room, events, dir }) => {
    const { member, actor } = identity(room, reader, env);
    after = integer(after ?? member?.indexCursor ?? 0, "after");
    integer(limit, "limit", 1, 5000);
    const shown = events.filter(event => event.seq > after && visible(event, member)).slice(0, limit);
    const cursor = shown.at(-1)?.seq ?? after;
    if (member) { member.indexCursor = Math.max(member.indexCursor, cursor); save(dir, room); }
    return { room: header(room), sealed: Boolean(member && member.initialSeq === null),
      events: shown.map(({ seq, kind, thread, replyTo, author, title, label, refs, mentions, ...event }) => ({ seq, kind, thread, replyTo, author, title, delta: delta({ title, ...event }), label, refs, mentions, resource: `${kind === "candidate" ? "candidate" : "post"}/${seq}`, open: isOpen(events[seq - 1], events) })),
      openForYou: open(events).filter(event => visible(event, member) && (event.mentions.length ? event.mentions.includes(actor.name) : event.author.name !== actor.name)).map(event => event.seq), cursor };
  });
}
export function readThread(roomId, reader, threadSeq, env = process.env) {
  return readThreadPage(roomId, reader, threadSeq, {}, env);
}
function readThreadPage(roomId, reader, threadSeq, { after = 0, limit = READ_EVENT_LIMIT }, env) {
  return locked(roomId, env, ({ room, events, dir }) => {
    integer(threadSeq, "thread", 1);
    integer(after, "after"); integer(limit, "limit", 1, 5000);
    limit = Math.min(limit, READ_EVENT_LIMIT);
    if (!events.some(event => event.seq === threadSeq && event.thread === threadSeq)) throw new Error("Forum thread does not exist.");
    const { member } = identity(room, reader, env);
    const available = events.filter(event => event.thread === threadSeq && event.seq > after && visible(event, member));
    const shown = []; let bytes = 2;
    for (const event of available) {
      const size = Buffer.byteLength(JSON.stringify(event)) + (shown.length ? 1 : 0);
      if (shown.length >= limit || bytes + size > READ_EVENT_BYTES) break;
      shown.push(event); bytes += size;
    }
    const cursor = shown.at(-1)?.seq ?? after, remaining = available.length - shown.length;
    if (member && shown.length) { member.expanded[threadSeq] = Math.max(member.expanded[threadSeq] ?? 0, shown.at(-1).seq); save(dir, room); }
    return { room: header(room), sealed: Boolean(member && member.initialSeq === null), thread: threadSeq, events: shown, cursor, remaining,
      next: remaining ? { resource: `thread/${threadSeq}`, after: cursor, limit } : null };
  });
}
export function readResource(roomId, reader, resource, env = process.env, { after = 0, limit } = {}) {
  const match = typeof resource === "string" && /^(post|thread|member|candidate)\/([A-Za-z0-9_.-]+)$/.exec(resource);
  if (!match) throw new Error("Forum resource must be post/<seq>, thread/<seq>, member/<name> or candidate/<seq>.");
  const [, kind, id] = match;
  integer(after, "after"); integer(limit ?? (kind === "member" ? MEMBER_HISTORY_LIMIT : READ_EVENT_LIMIT), "limit", 1, 5000);
  limit = Math.min(limit ?? (kind === "member" ? MEMBER_HISTORY_LIMIT : READ_EVENT_LIMIT), READ_EVENT_LIMIT);
  if (kind !== "member" && !/^\d+$/.test(id)) throw new Error("Forum resource sequence must be a positive integer.");
  const seq = kind === "member" ? null : integer(Number(id), "resource sequence", 1);
  if (kind === "thread") return { resource, ...readThreadPage(roomId, reader, seq, { after, limit }, env) };
  // Snapshot identity and sealing under the lock; never hold it while Git runs.
  const snapshot = locked(roomId, env, ({ room, events }) => {
    const { member } = identity(room, reader, env);
    const view = { resource, room: header(room), sealed: Boolean(member && member.initialSeq === null), events: [] };
    if (kind === "member") {
      const target = room.members.find(value => value.name === id);
      if (!target) throw new Error("Forum member does not exist.");
      return { view, room, target: view.sealed && member.name !== id ? null : target };
    }
    const event = events[seq - 1];
    if (!event || (kind === "candidate" && event.kind !== "candidate")) throw new Error(`Forum ${kind} does not exist.`);
    if (visible(event, member)) view.events = [event];
    return { view, room, target: kind === "candidate" && view.events.length ? room.members.find(value => value.name === event.author.name) : null };
  });
  const { view, room, target } = snapshot;
  if (kind === "member" && target) {
    const jobs = target.jobIds.slice().reverse().slice(after, after + limit);
    const workspace = memberWorkspaceStatus(room, target, env, { commitAfter: after, commitLimit: limit });
    view.member = { name: target.name, persona: target.persona, status: target.status, threadId: target.threadId,
      jobs: memberJobs(room, target, env, jobs), jobCount: target.jobIds.length, jobsOmitted: target.jobIds.length - jobs.length, workspace };
    view.next = Math.max(target.jobIds.length, workspace.commitCount ?? 0) > after + limit ? { resource, after: after + limit, limit } : null;
  } else if (kind === "candidate" && target && target.workspace && !target.workspace.shared) {
    view.diff = candidateWorkspaceDiff(room, target, env);
  }
  return view;
}
export function openItems(roomId, env = process.env) { return locked(roomId, env, ({ events }) => open(events)); }
export function pending(roomId, { now = Date.now(), windowMs = NOTIFICATION_WINDOW_MS } = {}, env = process.env) {
  const time = now instanceof Date ? now.getTime() : typeof now === "string" ? Date.parse(now) : now;
  if (!Number.isFinite(time) || !Number.isFinite(windowMs) || windowMs < 0) throw new Error("Invalid forum notification time/window.");
  return locked(roomId, env, ({ room, events, dir }) => {
    if (room.status !== "open") return [];
    const notices = [];
    for (const member of room.members) {
      if (member.status === "stopped") continue;
      const relevant = memberUpdates(events, member);
      if (!relevant.length) { member.firstPendingAt = null; continue; }
      member.firstPendingAt = relevant[0].at;
      if (!relevant.some(event => event.author.kind === "chair" && wakes(event, member))
          && time - Date.parse(member.firstPendingAt) < windowMs) continue;
      const summaries = relevant.map(event => ({ seq: event.seq, kind: event.kind, author: event.author, ...(event.title ? { title: short(event.title) } : { delta: `${event.thread === event.seq ? event.kind : "reply"} in thread #${event.thread}` }) }));
      const preview = relevant.slice(0, 5).map(event => `#${event.seq} ${event.kind} from ${event.author.name}${event.title ? ` ${JSON.stringify(short(event.title))}` : ` in thread #${event.thread}`}`).join("; ");
      notices.push({ persona: member.persona, name: member.name, threadId: member.threadId, jobIds: member.jobIds, wake: relevant.some(event => wakes(event, member)), events: summaries,
        text: `Roundtable ${roomId}: ${relevant.length} updates for you — ${preview}${relevant.length > 5 ? "; …" : ""}. Call forum_read to see them.` });
    }
    save(dir, room);
    return notices;
  });
}
export function ack(roomId, name, uptoSeq, env = process.env) {
  return locked(roomId, env, ({ room, dir }) => {
    const { member } = identity(room, name, env);
    if (!member) throw new Error("Forum ack requires a member.");
    integer(uptoSeq, "uptoSeq", 0, room.nextSeq - 1);
    member.notifiedSeq = Math.max(member.notifiedSeq, uptoSeq);
    member.firstPendingAt = null;
    save(dir, room);
    return member;
  });
}
export function setStatus(roomId, status, env = process.env) {
  if (!["open", "paused", "closed"].includes(status)) throw new Error("Invalid roundtable status.");
  return locked(roomId, env, ({ room, dir }) => {
    assertChair(room, env.CODEX_COMPANION_SESSION_ID);
    if (room.status === "closed" && status !== "closed") throw new Error("A closed roundtable cannot be reopened.");
    room.status = status;
    if (status === "closed") room.closedAt ??= iso();
    save(dir, room);
    return room;
  });
}
export function updateMember(roomId, name, patch, env = process.env) {
  return locked(roomId, env, ({ room, dir }) => {
    const { member } = identity(room, name, env);
    if (!member || !patch || Object.keys(patch).some(key => !["status", "jobIds", "threadId", "claim"].includes(key))) throw new Error("Invalid roundtable member patch.");
    if (patch.claim) {
      // A fresh dispatch seats a member once, atomically; later work continues
      // its thread, so two launches can never act as the same member.
      if (member.threadId) throw new Error(`Roundtable member ${member.name} already has a thread; continue it with SendMessage.`);
      if (member.jobIds.length || member.claimedAt) throw new Error(`Roundtable member ${member.name} was already dispatched; continue it with SendMessage instead of a second fresh launch.`);
      member.claimedAt = new Date().toISOString();
    }
    if (patch.status !== undefined) {
      if (!["seated", "active", "stopped"].includes(patch.status)) throw new Error("Invalid roundtable member status.");
      if (member.status === "stopped" && patch.status !== "stopped") throw new Error("A stopped roundtable member cannot be restarted.");
      if (room.status === "closed" && patch.status !== "stopped") throw new Error("Roundtable is closed.");
      member.status = patch.status;
    }
    if (patch.jobIds !== undefined) {
      if (!Array.isArray(patch.jobIds) || patch.jobIds.some(id => !identifier(id))) throw new Error("Invalid roundtable jobIds.");
      member.jobIds = [...new Set([...member.jobIds, ...patch.jobIds])];
    }
    if (patch.threadId !== undefined) {
      if (patch.threadId !== null && !identifier(patch.threadId)) throw new Error("Invalid roundtable threadId.");
      if (member.threadId && patch.threadId !== member.threadId) throw new Error("Roundtable member already belongs to another thread; continue that thread.");
      member.threadId = patch.threadId;
    }
    save(dir, room);
    return member;
  });
}
export function roundtableStatus({ sessionId, roomId, now = Date.now(), windowMs = NOTIFICATION_WINDOW_MS } = {}, env = process.env) {
  const selected = roomId ?? listRooms(sessionId, env)[0]?.roomId;
  if (!selected) return null;
  const { room, events } = locked(selected, env, ({ room, events }) => {
    assertChair(room, sessionId);
    return { room, events };
  });
  const items = open(events), attention = [];
  const members = room.members.map(member => ({ ...member, jobs: memberJobs(room, member, env), workspace: memberWorkspaceStatus(room, member, env) }));
  for (const event of items) if (event.mentions.includes("chair") || (!event.mentions.length && now - Date.parse(event.at) >= windowMs)) {
    attention.push({ kind: "open_item", seq: event.seq, resource: `post/${event.seq}`, summary: `#${event.seq} ${event.kind} from ${event.author.name}: ${delta(event)}` });
  }
  for (const member of members) {
    const job = member.jobs.at(-1);
    if (room.status === "open" && member.status !== "stopped" && job && !["queued", "running", "unknown", "needs_answer"].includes(job.status)) {
      const relevant = memberUpdates(events, member), wake = relevant.filter(event => wakes(event, member));
      if (wake.length && (wake.some(event => event.author.kind === "chair") || now - Date.parse(relevant[0].at) >= windowMs)) {
        attention.push({ kind: "pending_relay", name: member.name, resource: `member/${member.name}`, posts: wake.map(event => `post/${event.seq}`),
          summary: `${member.name} has ${wake.length} wake update(s) not yet taken up; this status call delivers them. Still listed a minute later: SendMessage ${member.name} "Read your forum updates and continue."` });
      }
    }
    if (job && [job.status, job.reportStatus].some(status => ["blocked", "failed", "needs_answer", "needs_input"].includes(status))) {
      attention.push({ kind: "job", name: member.name, jobId: job.jobId, resource: `member/${member.name}`, details: job.details,
        summary: `${member.name}: ${job.status === "completed" ? job.reportStatus : job.status}${job.summary ? ` — ${job.summary}` : ""}` });
    }
    // Close removes clean worktrees on purpose; only an open room needs them.
    if (member.workspace.missing && room.status !== "closed") attention.push({ kind: "missing_workspace", name: member.name, resource: `member/${member.name}`, summary: `${member.name}: workspace missing (${member.workspace.path})` });
  }
  for (const event of events) if (event.kind === "candidate" && !reviewed(event, events)) {
    attention.push({ kind: "unreviewed_candidate", seq: event.seq, resource: `candidate/${event.seq}`, summary: `Candidate #${event.seq} from ${event.author.name} needs a non-author finding.` });
  }
  return { attention, ...room, members, selectedCandidate: selection(events), openItems: items,
    counts: { events: events.length, threads: events.filter(event => event.seq === event.thread).length, openItems: items.length } };
}
export function renderAttention(room) {
  return `${room.attention.length ? `Needs the chair (${room.attention.length}):\n${room.attention.map(item => `- ${item.summary} → ${item.resource}`).join("\n")}` : "Nothing needs the chair."}\n`;
}
export function renderRoundtableStatus(room) {
  return renderAttention(room) +
    `Roundtable ${room.roomId} (${room.status}, ${room.intensity})\n` +
    `Counts: ${room.counts.events} posts, ${room.counts.threads} threads, ${room.counts.openItems} open items\n` +
    room.members.map(member => `${member.name}: ${member.status}; jobs ${member.jobs.map(job => `${job.jobId}:${job.status}`).join(", ") || "none"}; workspace ${member.workspace.path}`).join("\n") + "\n";
}
export function validateMember(roomId, persona, sessionId, env = process.env) {
  const room = readRoom(roomId, env);
  assertChair(room, sessionId);
  if (room.status !== "open") throw new Error(`Roundtable is ${room.status}; dispatch requires an open room.`);
  const member = room.members.find(member => member.persona === persona);
  if (!member) throw new Error(`Persona ${persona} is not seated in this roundtable.`);
  if (member.status === "stopped") throw new Error(`Roundtable member ${persona} is stopped.`);
  return { room, member };
}
export function renderForum(view) {
  const lines = [`Roundtable ${view.room.roomId} (${view.room.status}, ${view.room.intensity})`, `Goal: ${view.room.goal}`,
    `Members: ${view.room.members.map(member => member.name).join(", ")}`];
  if (view.sealed) lines.push("Sealed first round: post your independent initial record to read other members.");
  if (view.resource) lines.push(`Resource: ${view.resource}`);
  if (view.member) {
    const member = view.member, workspace = member.workspace;
    lines.push(`${member.name} (${member.persona}): ${member.status}; thread ${member.threadId ?? "none"}`);
    for (const job of member.jobs) lines.push(`Job ${job.jobId}: ${job.status}${job.reportStatus ? ` (${job.reportStatus})` : ""}${job.summary ? ` — ${job.summary}` : ""}; details: ${job.details}`);
    if (member.jobsOmitted) lines.push(`${member.jobsOmitted} jobs omitted (${member.jobCount} total).`);
    lines.push(`Workspace: ${workspace.path}; base ${workspace.base ?? "none"}; head ${workspace.head ?? "unknown"}; commits since base: ${workspace.commits.join(", ") || "none"}; dirty files: ${workspace.dirtyFiles ?? "unknown"}${workspace.reason ? `; ${workspace.reason}` : ""}`);
    if (workspace.commitsOmitted) lines.push(`${workspace.commitsOmitted} commits omitted (${workspace.commitCount} total).`);
  }
  for (const event of view.events) {
    lines.push(`#${event.seq} ${event.kind} ${event.author.name}${event.mentions.length ? `→${event.mentions.join(",")}` : ""}${event.open ? " [open]" : ""} ${JSON.stringify(event.title || event.delta || short(event.body))} (thread #${event.thread}${event.replyTo ? `, reply #${event.replyTo}` : ""}; ${event.resource ?? `post/${event.seq}`}, thread/${event.thread})${event.label ? ` [${event.label}]` : ""}${event.refs.length ? ` refs: ${event.refs.map(short).join(", ")}` : ""}`);
    if (event.body !== undefined) lines.push(event.body);
    if (event.selects !== undefined) lines.push(`Selects: candidate/${event.selects}${event.unreviewed ? `; unreviewed override: ${event.unreviewed}` : ""}`);
  }
  if (view.diff) {
    lines.push(`Candidate diff: ${view.diff.stat || view.diff.reason || "No committed changes."}`);
    if (view.diff.statTruncated && view.diff.statCommand) lines.push(`Read full stat: ${view.diff.statCommand}`);
    if (view.diff.patch) lines.push(view.diff.patch);
    if (view.diff.command) lines.push(`Read full patch: ${view.diff.command}`);
  }
  if (!view.events.length && !view.member) lines.push("No new visible posts.");
  if (view.openForYou?.length) lines.push(`Open for you: ${view.openForYou.map(seq => `#${seq}`).join(", ")}`);
  if (view.next) lines.push(`Continue: forum_read(resource=${JSON.stringify(view.next.resource)}, after=${view.next.after}, limit=${view.next.limit}); duet forum read ${view.room.roomId} --resource ${view.next.resource} --after ${view.next.after} --limit ${view.next.limit}`);
  return `${lines.join("\n")}\n`;
}
