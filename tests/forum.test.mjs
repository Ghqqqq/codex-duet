import "./test-environment.mjs";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import childProcess, { spawn } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { createInterface } from "node:readline";
import { createRoom, postEvent, readRoom, readIndex, readThread, readResource, openItems, pending, ack, setStatus, updateMember, roundtableStatus, renderForum } from "../plugins/codex/scripts/lib/forum.mjs";
import { resolveStateDirForRoot } from "../plugins/codex/scripts/lib/state.mjs";
import { resolveRoster, personaInstructions, CHAIR_CARD } from "../plugins/codex/scripts/lib/roundtable-personas.mjs";
import { approveDuet } from "../plugins/codex/scripts/duet-permission-hook.mjs";
import { parentBridgeConfig } from "../plugins/codex/scripts/lib/codex.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { createMemberWorkspaces } from "../plugins/codex/scripts/lib/roundtable-workspaces.mjs";
import { lifecycleHarness } from "./fake-codex-fixture.mjs";

const script = new URL("../plugins/codex/scripts/codex-companion.mjs", import.meta.url).pathname;
function fixture({ git = false } = {}) {
  const dir = makeTempDir("forum-"), env = { ...process.env, CODEX_COMPANION_HOME: path.join(dir, "isolated"), CODEX_COMPANION_SESSION_ID: "chair-session" };
  if (git) {
    initGitRepo(dir);
    fs.writeFileSync(path.join(dir, "tracked.txt"), "Base\n"); fs.writeFileSync(path.join(dir, ".gitignore"), "isolated/\n");
    assert.equal(run("git", ["add", "tracked.txt", ".gitignore"], { cwd: dir }).status, 0);
    assert.equal(run("git", ["commit", "-m", "Initial workspace"], { cwd: dir }).status, 0);
  }
  const room = createRoom({ sessionId: env.CODEX_COMPANION_SESSION_ID, workspaceRoot: dir, goal: "Reproduce the race and deliver a fix.", members: resolveRoster() }, env);
  const post = (author, kind, body = "Independent evidence", extra = {}) => postEvent(room.roomId, author, { kind, body, ...extra }, env);
  return { dir, env, room, post, read: (reader, options) => readIndex(room.roomId, reader, options, env),
    thread: (reader, seq) => readThread(room.roomId, reader, seq, env), state: () => readRoom(room.roomId, env),
    call: (args, input, extra = {}) => run(process.execPath, [script, ...args], { cwd: dir, env: { ...env, ...extra }, input }) };
}
const json = result => { assert.equal(result.status, 0, result.stderr + result.stdout); return JSON.parse(result.stdout); };
function storeMemberJob(f, name, jobId, patch) {
  const directory = path.join(resolveStateDirForRoot(f.dir, f.env), "jobs");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `${jobId}.json`), JSON.stringify({ id: jobId, sessionId: f.room.sessionId, workspaceRoot: f.dir,
    threadId: `thread-${name}`, turnId: `turn-${jobId}`, status: "completed", ...patch }));
  updateMember(f.room.roomId, name, { status: "active", jobIds: [jobId], threadId: `thread-${name}` }, f.env);
}

test("candidate stats cap lines and bytes, preserve overflow prefixes and set Git execution timeouts", t => {
  const f = fixture({ git: true }), id = f.room.roomId;
  const candidate = f.post("critic", "candidate", "Large candidate");
  const original = childProcess.spawnSync, calls = [], statCalls = [];
  let overflow = false;
  const largeStat = Array(1000).fill(`${"界".repeat(90)} | 1 +`).join("\n");
  const mock = t.mock.method(childProcess, "spawnSync", (command, args, options) => {
    calls.push(options);
    if (command === "git" && args.includes("--stat")) {
      statCalls.push(options);
      return { stdout: overflow ? largeStat : "x\n".repeat(1000), stderr: "", status: overflow ? null : 0,
        ...(overflow ? { error: Object.assign(new Error("Output buffer full"), { code: "ENOBUFS" }) } : {}) };
    }
    return original(command, args, options);
  });
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  const first = readResource(id, "chair", `candidate/${candidate.seq}`, f.env);
  assert.equal(first.diff.statTruncated, true);
  assert.ok(Buffer.byteLength(first.diff.stat) <= 4000); assert.ok(first.diff.stat.split("\n").length <= 40);
  assert.match(first.diff.stat, /Stat truncated/);
  const member = f.room.members.find(member => member.name === "critic");
  assert.equal(first.diff.statCommand, `git --no-pager -C '${member.workspace.path}' diff --no-ext-diff --no-textconv --no-color ${member.workspace.base}..HEAD --stat --`);
  assert.match(renderForum(first), /Read full stat: git --no-pager/);
  overflow = true;
  const second = readResource(id, "chair", `candidate/${candidate.seq}`, f.env);
  assert.equal(second.diff.statTruncated, true); assert.match(second.diff.stat, /Stat truncated/);
  assert.ok(Buffer.byteLength(second.diff.stat) <= 4000); assert.ok(second.diff.stat.split("\n").length <= 40);
  assert.ok(calls.every(options => options.timeout === 10000 && options.killSignal === "SIGKILL"));
  assert.ok(statCalls.every(options => options.maxBuffer === 64 * 1024));
});

test("thread resources enforce event and byte budgets with sealed, cursor-safe continuation pages", () => {
  const f = fixture(), id = f.room.roomId, root = f.post("critic", "finding", "界".repeat(4000));
  const file = path.join(f.env.CODEX_COMPANION_HOME, "duet", "roundtables", id, "events.jsonl");
  const events = Array.from({ length: 1000 }, (_, index) => ({ ...root, seq: index + 1, thread: root.seq, replyTo: index ? root.seq : null, initial: index === 0 }));
  fs.writeFileSync(file, events.map(event => JSON.stringify(event)).join("\n") + "\n");
  const resource = `thread/${root.seq}`, sealed = readResource(id, "improver", resource, f.env);
  assert.deepEqual(sealed.events, []); assert.equal(sealed.next, null);
  assert.deepEqual(f.state().members.find(member => member.name === "improver").expanded, {});
  f.post("improver", "intent");
  const first = readResource(id, "improver", resource, f.env, { limit: 5000 });
  assert.ok(first.events.length > 0 && first.events.length < 25);
  assert.ok(Buffer.byteLength(JSON.stringify(first.events)) <= 128 * 1024);
  assert.equal(first.events[0].body.length, 4000);
  assert.deepEqual(first.next, { resource, after: first.events.at(-1).seq, limit: 25 });
  const member = f.state().members.find(member => member.name === "improver");
  assert.equal(member.expanded[root.seq], first.next.after); assert.equal(member.indexCursor, 0);
  const second = readResource(id, "improver", resource, f.env, { after: first.next.after, limit: 2 });
  assert.deepEqual(second.events.map(event => event.seq), [first.next.after + 1, first.next.after + 2]);
  assert.equal(f.state().members.find(member => member.name === "improver").expanded[root.seq], second.events.at(-1).seq);
  const cli = json(f.call(["forum", "read", id, "--resource", resource, "--after", String(first.next.after), "--limit", "2", "--json"]));
  assert.deepEqual(cli.events, second.events);
  assert.match(renderForum(first), new RegExp(`Continue: forum_read\\(resource="${resource}", after=${first.next.after}`));
  const last = readResource(id, "chair", resource, f.env, { after: 998 });
  assert.deepEqual(last.events.map(event => event.seq), [999, 1000]); assert.equal(last.next, null);
  const short = fs.readFileSync(file, "utf8").trim().split("\n").map(JSON.parse).map(event => ({ ...event, body: "Short evidence" }));
  fs.writeFileSync(file, short.map(event => JSON.stringify(event)).join("\n") + "\n");
  assert.equal(f.thread("chair", root.seq).events.length, 25);
});

test("member summaries show recent bounded history and page the remaining jobs and commits explicitly", () => {
  const f = fixture({ git: true }), id = f.room.roomId, member = f.room.members.find(member => member.name === "critic");
  const git = args => { const result = run("git", args, { cwd: member.workspace.path }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
  const tree = git(["rev-parse", "HEAD^{tree}"]), commits = [];
  let parent = member.workspace.base;
  for (let index = 0; index < 32; index++) {
    parent = git(["commit-tree", tree, "-p", parent, "-m", `History ${index}`]); commits.unshift(parent);
    storeMemberJob(f, "critic", `history-${index}`, { report: { status: "completed", summary: `Report ${index}` } });
  }
  git(["update-ref", "HEAD", parent]);
  const before = f.state(), resource = "member/critic", summary = readResource(id, "chair", resource, f.env);
  assert.equal(summary.member.jobCount, 32); assert.equal(summary.member.jobsOmitted, 22);
  assert.deepEqual(summary.member.jobs.map(job => job.jobId), Array.from({ length: 10 }, (_, index) => `history-${31 - index}`));
  assert.deepEqual(summary.member.workspace.commits, commits.slice(0, 10));
  assert.equal(summary.member.workspace.commitCount, 32); assert.equal(summary.member.workspace.commitsOmitted, 22);
  assert.deepEqual(summary.next, { resource, after: 10, limit: 10 });
  assert.match(renderForum(summary), /22 jobs omitted/); assert.match(renderForum(summary), /22 commits omitted/);
  const jobs = [], allCommits = [];
  let page = { resource, after: 0, limit: 5000 };
  while (page) {
    const view = readResource(id, "chair", page.resource, f.env, page);
    assert.ok(view.member.jobs.length <= 25); assert.ok(view.member.workspace.commits.length <= 25);
    jobs.push(...view.member.jobs.map(job => job.jobId)); allCommits.push(...view.member.workspace.commits); page = view.next;
  }
  assert.deepEqual(jobs, Array.from({ length: 32 }, (_, index) => `history-${31 - index}`)); assert.deepEqual(allCommits, commits);
  const cli = json(f.call(["forum", "read", id, "--resource", resource, "--after", "10", "--limit", "2", "--json"]));
  assert.deepEqual(cli.member.jobs.map(job => job.jobId), ["history-21", "history-20"]);
  assert.deepEqual(f.state(), before);
});

test("bare roundtable status prints the latest room attention details before mode information", () => {
  const f = fixture(), id = f.room.roomId;
  f.post("critic", "question", "Choose the next route", { title: "Chair judgment needed", mentions: ["chair"] });
  const candidate = f.post("critic", "candidate", "Review me");
  json(f.call(["roundtable", "on", "--json"]));
  const text = f.call(["roundtable", "status"]).stdout, mode = text.indexOf("Roundtable mode:");
  assert.match(text, /^Needs the chair \(2\):/);
  assert.ok(text.indexOf("Chair judgment needed") < mode && text.indexOf("post/1") < mode);
  assert.ok(text.indexOf(`candidate/${candidate.seq}`) < mode);
  const status = json(f.call(["roundtable", "status", "--json"]));
  assert.equal(status.mode, "on"); assert.equal(status.attentionCount, 2); assert.equal(status.latestRoom.attention.length, 2);
  json(f.call(["roundtable", "start", "--json"], "No chair action needed"));
  assert.match(f.call(["roundtable", "status"]).stdout, /^Nothing needs the chair\.\nRoundtable mode:/);
  assert.equal(json(f.call(["roundtable", "status", "--json"])).attentionCount, 0);
});

test("room status leads with only chair attention, resource pointers and a concise empty case", () => {
  const f = fixture({ git: true }), id = f.room.roomId;
  assert.deepEqual(roundtableStatus({ roomId: id, sessionId: f.room.sessionId }, f.env).attention, []);
  assert.match(f.call(["roundtable", "status", id]).stdout, /^Nothing needs the chair\.\nRoundtable/);
  const old = f.post("critic", "question", "Unaddressed old question");
  const addressed = f.post("critic", "request", "Need chair judgment", { mentions: ["chair"] });
  f.post("critic", "question", "Recent unaddressed question");
  f.post("conjecturer", "intent");
  const initial = f.post("improver", "intent");
  const notify = f.post("critic", "finding", "Older reply makes the wake batch ready", { replyTo: initial.seq });
  const wake = f.post("critic", "request", "Please resume", { mentions: ["improver"] });
  const candidate = f.post("critic", "candidate", "Unreviewed delivery");
  const reviewed = f.post("improver", "candidate", "Reviewed delivery");
  f.post("conjecturer", "finding", "Independently checked", { replyTo: reviewed.seq });
  const eventFile = path.join(f.env.CODEX_COMPANION_HOME, "duet", "roundtables", id, "events.jsonl");
  const events = fs.readFileSync(eventFile, "utf8").trim().split("\n").map(JSON.parse);
  for (const event of events) if ([old.seq, notify.seq].includes(event.seq)) event.at = new Date(Date.now() - 60000).toISOString();
  fs.writeFileSync(eventFile, events.map(event => JSON.stringify(event)).join("\n") + "\n");
  storeMemberJob(f, "critic", "failed-job", { status: "failed" });
  storeMemberJob(f, "conjecturer", "question-job", { status: "running", phase: "needs_answer" });
  storeMemberJob(f, "improver", "blocked-job", { report: { status: "blocked", summary: "Missing dependency" } });
  fs.rmSync(f.room.members.find(member => member.name === "critic").workspace.path, { recursive: true });
  const before = f.state().members.map(({ indexCursor, expanded, notifiedSeq, firstPendingAt }) => ({ indexCursor, expanded, notifiedSeq, firstPendingAt }));
  const status = json(f.call(["roundtable", "status", id, "--json"]));
  assert.equal(Object.keys(status)[0], "attention");
  assert.deepEqual(status.attention.filter(item => item.kind === "open_item").map(item => item.resource), [`post/${old.seq}`, `post/${addressed.seq}`]);
  assert.deepEqual(status.attention.filter(item => item.kind === "pending_relay").map(item => item.name), ["improver"]);
  assert.deepEqual(status.attention.filter(item => item.kind === "job").map(item => item.jobId), ["question-job", "failed-job", "blocked-job"]);
  assert.deepEqual(status.attention.filter(item => item.kind === "unreviewed_candidate").map(item => item.resource), [`candidate/${candidate.seq}`]);
  assert.deepEqual(status.attention.filter(item => item.kind === "missing_workspace").map(item => item.name), ["critic"]);
  assert.ok(status.attention.every(item => item.resource));
  assert.match(f.call(["roundtable", "status", id]).stdout, /^Needs the chair \(8\):/);
  assert.equal(json(f.call(["roundtable", "status", "--json"])).attentionCount, status.attention.length);
  assert.match(f.call(["roundtable", "status"]).stdout, /needs the chair: 8/);
  assert.deepEqual(f.state().members.map(({ indexCursor, expanded, notifiedSeq, firstPendingAt }) => ({ indexCursor, expanded, notifiedSeq, firstPendingAt })), before);
  ack(id, "improver", wake.seq, f.env);
  assert.equal(roundtableStatus({ roomId: id, sessionId: f.room.sessionId }, f.env).attention.some(item => item.kind === "pending_relay"), false);
  postEvent(id, { kind: "chair", name: "chair", sessionId: f.room.sessionId }, { kind: "request", body: "Check this now", mentions: ["improver"] }, f.env);
  assert.deepEqual(roundtableStatus({ roomId: id, sessionId: f.room.sessionId }, f.env).attention.filter(item => item.kind === "pending_relay").map(item => item.name), ["improver"],
    "A chair mention is ready at once, as in pending");
});

test("object resources summarize members and bound candidate diffs without bypassing sealing or changing read cursors", async t => {
  const f = fixture({ git: true }), id = f.room.roomId, author = f.room.members.find(member => member.name === "critic");
  const git = args => { const result = run("git", args, { cwd: author.workspace.path }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
  fs.writeFileSync(path.join(author.workspace.path, "tracked.txt"), "Candidate evidence line\n".repeat(10000));
  git(["add", "tracked.txt"]); git(["commit", "-m", "Candidate"]);
  const head = git(["rev-parse", "HEAD"]);
  fs.writeFileSync(path.join(author.workspace.path, "local.txt"), "Uncommitted evidence");
  storeMemberJob(f, "critic", "resource-job", { report: { status: "completed", summary: "Evidence ".repeat(100) }, result: { rawOutput: "PRIVATE TRANSCRIPT" } });
  const candidate = f.post("critic", "candidate", "Full candidate post", { title: "Candidate summary", refs: [head] });
  const decision = f.post("chair", "decision", "Public constraint");
  const read = (reader, resource) => readResource(id, reader, resource, f.env);
  for (const resource of [`post/${candidate.seq}`, `candidate/${candidate.seq}`, `thread/${candidate.seq}`, "member/critic"]) {
    const sealed = read("improver", resource);
    assert.equal(sealed.sealed, true); assert.deepEqual(sealed.events, []);
    assert.equal(sealed.member, undefined); assert.equal(sealed.diff, undefined);
    assert.doesNotMatch(renderForum(sealed), /Full candidate|Candidate summary|resource-job|PRIVATE TRANSCRIPT/);
  }
  assert.equal(read("improver", `post/${decision.seq}`).events[0].body, "Public constraint");
  f.post("improver", "intent");
  f.read("improver");
  const before = f.state();
  const member = read("improver", "member/critic").member;
  assert.equal(member.persona, "critic"); assert.equal(member.status, "active");
  assert.equal(member.jobs[0].status, "completed"); assert.equal(member.jobs[0].summary.length, 600);
  assert.equal(member.workspace.path, author.workspace.path); assert.equal(member.workspace.base, author.workspace.base);
  assert.equal(member.workspace.head, head); assert.deepEqual(member.workspace.commits, [head]); assert.equal(member.workspace.dirtyFiles, 1);
  assert.doesNotMatch(JSON.stringify(member), /PRIVATE TRANSCRIPT/);
  assert.equal(read("improver", `post/${candidate.seq}`).events[0].body, "Full candidate post");
  const view = read("improver", `candidate/${candidate.seq}`);
  assert.match(view.diff.stat, /tracked.txt/); assert.equal(view.diff.truncated, true); assert.equal(view.diff.patch.length, 8000);
  assert.match(view.diff.patch, /\[Patch truncated at 8000 characters\]$/);
  assert.equal(view.diff.command, `git --no-pager -C '${author.workspace.path}' diff --no-ext-diff --no-textconv --no-color ${author.workspace.base}..HEAD --`);
  assert.equal(view.events[0].body, "Full candidate post");
  assert.deepEqual(f.state(), before);
  assert.deepEqual(read("chair", `thread/${candidate.seq}`).events, f.thread("chair", candidate.seq).events);
  assert.deepEqual(json(f.call(["forum", "read", id, "--resource", "member/critic", "--json"])).member, member);
  const text = f.call(["forum", "read", id, "--resource", `candidate/${candidate.seq}`]).stdout;
  assert.ok(text.indexOf("Candidate summary") < text.indexOf("diff --git")); assert.match(text, /Read full patch: git --no-pager/);
  assert.equal(f.call(["forum", "read", id, "--resource", "member/critic", "--after", "0", "--limit", "1"]).status, 0);
  assert.equal(git(["rev-parse", "HEAD"]), head); assert.equal(git(["status", "--porcelain"]), "?? local.txt");
  storeMemberJob(f, "critic", "resource-job", { status: "running", request: { roundtable: { roomId: id, persona: "critic" } } });
  const bridge = spawn(process.execPath, [new URL("../plugins/codex/scripts/parent-bridge-mcp.mjs", import.meta.url).pathname], {
    cwd: f.dir, env: { ...f.env, CODEX_COMPANION_BRIDGE_CWD: f.dir, CODEX_COMPANION_BRIDGE_JOB: "resource-job" }, stdio: ["pipe", "pipe", "pipe"] });
  const closed = new Promise(resolve => bridge.once("close", resolve));
  const reader = createInterface({ input: bridge.stdout }), replies = reader[Symbol.asyncIterator]();
  t.after(async () => { reader.close(); bridge.kill(); await closed; });
  const request = async (seq, method, params) => {
    bridge.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: seq, method, params })}\n`);
    const next = await replies.next(); assert.equal(next.done, false);
    const response = JSON.parse(next.value); assert.equal(response.id, seq); return response.result;
  };
  const listing = await request(1, "tools/list");
  assert.deepEqual(listing.tools.find(tool => tool.name === "forum_read").inputSchema.properties.resource, { type: "string" });
  const expanded = await request(2, "tools/call", { name: "forum_read", arguments: { resource: `candidate/${candidate.seq}` } });
  assert.equal(expanded.isError, false); assert.match(expanded.content[0].text, /Patch truncated at 8000 characters/);
  const page = await request(3, "tools/call", { name: "forum_read", arguments: { resource: "member/critic", after: 0, limit: 1 } });
  assert.equal(page.isError, false);
  const invalid = await request(4, "tools/call", { name: "forum_read", arguments: { resource: "member/critic", thread: candidate.seq } });
  assert.equal(invalid.isError, true); assert.match(invalid.content[0].text, /Read a resource or a thread/);
  assert.deepEqual(f.state(), before);
});

test("candidate selection requires a later non-author finding or records the chair's explicit override", () => {
  const f = fixture(), id = f.room.roomId;
  const candidate = f.post("critic", "candidate");
  const select = extra => f.post("chair", "decision", "Accept candidate", { selects: candidate.seq, ...extra });
  assert.throws(() => select(), /non-author member finding/);
  assert.equal(f.call(["forum", "post", id, "--kind", "decision", "--selects", String(candidate.seq)], "Accept").status, 1);
  f.post("critic", "finding", "Author check", { replyTo: candidate.seq });
  f.post("chair", "finding", "Chair check", { replyTo: candidate.seq });
  f.post("improver", "finding", "Other thread");
  f.post("improver", "idea", "Not a finding", { replyTo: candidate.seq });
  assert.throws(() => select(), /non-author member finding/);
  const review = f.post("improver", "finding", "Reproduced candidate", { replyTo: candidate.seq });
  const accepted = json(f.call(["forum", "post", id, "--kind", "decision", "--selects", String(candidate.seq), "--json"], "Accept reviewed result"));
  assert.equal(accepted.selects, candidate.seq); assert.equal(accepted.unreviewed, undefined);
  assert.equal(roundtableStatus({ roomId: id, sessionId: f.room.sessionId }, f.env).selectedCandidate.reviewed, true);
  assert.throws(() => f.post("chair", "decision", "Not candidate", { selects: review.seq, unreviewed: "Urgent" }), /existing candidate/);
  const unreviewed = f.post("conjecturer", "candidate", "Alternative");
  assert.throws(() => f.post("chair", "decision", "Empty override", { selects: unreviewed.seq, unreviewed: " " }), /non-empty text/);
  assert.throws(() => f.post("critic", "idea", "Cannot select", { selects: unreviewed.seq }), /Only a chair decision/);
  const override = json(f.call(["forum", "post", id, "--kind", "decision", "--selects", String(unreviewed.seq), "--unreviewed", "Review unavailable; documented acceptance evidence", "--json"], "Accept with reason"));
  assert.equal(override.selects, unreviewed.seq); assert.equal(override.unreviewed, "Review unavailable; documented acceptance evidence");
  assert.deepEqual(readResource(id, "chair", `post/${override.seq}`, f.env).events[0], override);
  const closed = json(f.call(["roundtable", "close", id, "--json"]));
  assert.deepEqual(closed.selectedCandidate, { seq: unreviewed.seq, resource: `candidate/${unreviewed.seq}`, decision: override.seq, reviewed: false, unreviewed: override.unreviewed });
  assert.match(f.call(["roundtable", "close", id]).stdout, new RegExp(`^Selected candidate: #${unreviewed.seq} \\(unreviewed; override:`));
});

test("sealed initial records reveal peers only after posting, with independent index and expansion cursors", () => {
  const f = fixture();
  const peer = f.post("critic", "idea", "Peer-only body", { title: "Peer idea" });
  const decision = f.post("chair", "decision", "Shared constraint");
  const sealed = f.read("improver");
  assert.equal(sealed.sealed, true);
  assert.deepEqual(sealed.events.map(event => event.seq), [decision.seq]);
  assert.deepEqual(sealed.room.members.map(member => member.persona), ["conjecturer", "critic", "improver"]);
  assert.deepEqual(f.thread("improver", peer.seq).events, []);
  assert.equal(f.state().members.find(member => member.name === "improver").expanded[peer.seq], undefined);
  const initial = f.post("improver", "intent");
  assert.equal(initial.initial, true);
  assert.equal(f.state().members.find(member => member.name === "improver").initialSeq, initial.seq);
  assert.equal(f.post("improver", "finding").initial, false);
  const index = f.read("improver", { limit: 1 });
  assert.equal(index.sealed, false); assert.equal(index.events[0].seq, peer.seq);
  assert.equal(index.events[0].delta, "Peer idea"); assert.equal(index.events[0].body, undefined);
  assert.equal(f.thread("improver", peer.seq).events[0].body, "Peer-only body");
  const member = f.state().members.find(member => member.name === "improver");
  assert.equal(member.indexCursor, peer.seq); assert.equal(member.expanded[peer.seq], peer.seq);
  assert.equal(f.read("improver").events[0].seq, decision.seq);
  assert.equal(f.read("chair").events.length, 4);
});

test("open requests close only on a direct addressed reply, a non-author for an unaddressed item, or a chair decision", () => {
  const f = fixture(), addressed = f.post("critic", "request", "Reproduce", { mentions: ["improver"] });
  f.post("conjecturer", "finding", "Unaddressed member replies", { replyTo: addressed.seq });
  f.post("improver", "intent", "Joined thread without answering", { thread: addressed.seq });
  assert.deepEqual(openItems(f.room.roomId, f.env).map(event => event.addressees), [["improver"]]);
  assert.deepEqual(f.read("improver").openForYou, [addressed.seq]);
  const reply = f.post("improver", "finding", "Reproduced", { replyTo: addressed.seq });
  assert.equal(reply.thread, addressed.seq);
  assert.equal(openItems(f.room.roomId, f.env).length, 0);
  const free = f.post("critic", "question", "Any evidence?");
  f.post("critic", "idea", "Own followup", { replyTo: free.seq });
  assert.equal(openItems(f.room.roomId, f.env).length, 1);
  f.post("conjecturer", "finding", "Answer", { replyTo: free.seq });
  const chair = f.post("critic", "request", "Need decision", { mentions: ["chair"] });
  f.post("chair", "decision", "Resolved", { replyTo: chair.seq });
  assert.equal(openItems(f.room.roomId, f.env).length, 0);
  assert.throws(() => f.post("critic", "idea", "Bad target", { replyTo: 999 }), /existing event/);
  assert.throws(() => f.post("critic", "idea", "Wrong thread", { replyTo: reply.seq, thread: free.seq }), /does not match/);
});

test("notifications route mentions and participant replies, coalesce for 30 seconds, and let decisions bypass the window", () => {
  const f = fixture();
  f.post("improver", "intent"); f.post("critic", "idea"); f.post("conjecturer", "idea");
  const request = f.post("critic", "request", "PRIVATE BODY MUST NOT BE NOTIFIED", { mentions: ["improver"], title: "Check ordering" });
  const at = Date.parse(request.at);
  assert.deepEqual(pending(f.room.roomId, { now: at + 29999 }, f.env), []);
  const notices = pending(f.room.roomId, { now: at + 30000 }, f.env);
  assert.equal(notices.length, 1); assert.equal(notices[0].name, "improver"); assert.equal(notices[0].wake, true);
  assert.doesNotMatch(JSON.stringify(notices), /PRIVATE BODY/);
  assert.equal(f.state().members.find(member => member.name === "improver").firstPendingAt, request.at);
  ack(f.room.roomId, "improver", request.seq, f.env);
  assert.equal(f.state().members.find(member => member.name === "improver").firstPendingAt, null);
  assert.deepEqual(pending(f.room.roomId, { now: at + 60000 }, f.env), []);
  const reply = f.post("improver", "finding", "Answer", { replyTo: request.seq });
  const notify = pending(f.room.roomId, { now: Date.parse(reply.at) + 30000 }, f.env);
  assert.equal(notify.length, 1); assert.equal(notify[0].name, "critic"); assert.equal(notify[0].wake, false);
  const decision = f.post("chair", "decision", "CONTROL BODY");
  const immediate = pending(f.room.roomId, { now: Date.parse(decision.at) }, f.env);
  assert.equal(immediate.length, 3); assert.ok(immediate.every(notice => notice.wake));
  assert.doesNotMatch(JSON.stringify(immediate), /CONTROL BODY/);
  assert.throws(() => ack(f.room.roomId, "critic", decision.seq + 1, f.env), /uptoSeq/);
  ack(f.room.roomId, "critic", decision.seq, f.env); ack(f.room.roomId, "critic", 0, f.env);
  assert.equal(f.state().members.find(member => member.name === "critic").notifiedSeq, decision.seq);
});

test("paused and closed rooms and stopped members suppress notifications without cancelling jobs, and reads remain available", () => {
  const f = fixture();
  updateMember(f.room.roomId, "critic", { status: "active", jobIds: ["job-a"], threadId: "thread-a" }, f.env);
  updateMember(f.room.roomId, "critic", { jobIds: ["job-a", "job-b"] }, f.env);
  updateMember(f.room.roomId, "critic", { status: "stopped" }, f.env);
  f.post("chair", "decision", "Next milestone");
  assert.deepEqual(pending(f.room.roomId, {}, f.env).map(member => member.name), ["conjecturer", "improver"]);
  assert.throws(() => f.post("critic", "idea"), /stopped/);
  assert.throws(() => updateMember(f.room.roomId, "critic", { status: "active" }, f.env), /stopped/);
  setStatus(f.room.roomId, "paused", f.env); assert.deepEqual(pending(f.room.roomId, {}, f.env), []);
  setStatus(f.room.roomId, "open", f.env); assert.equal(pending(f.room.roomId, {}, f.env).length, 2);
  setStatus(f.room.roomId, "closed", f.env);
  assert.deepEqual(pending(f.room.roomId, {}, f.env), []);
  assert.throws(() => f.post("improver", "idea"), /closed/);
  assert.equal(f.read("critic").events.length, 1);
  assert.deepEqual(f.state().members.find(member => member.name === "critic").jobIds, ["job-a", "job-b"]);
  assert.ok(f.state().closedAt);
  assert.throws(() => setStatus(f.room.roomId, "open", f.env), /cannot be reopened/);
});

test("only the owning session is the chair and only the chair may issue decisions", () => {
  const f = fixture(), foreign = { ...f.env, CODEX_COMPANION_SESSION_ID: "another-session" };
  assert.throws(() => f.post("critic", "decision"), /Only.*chair/);
  assert.throws(() => postEvent(f.room.roomId, "chair", { kind: "decision", body: "Spoofed" }, foreign), /owning Claude session/);
  assert.throws(() => readIndex(f.room.roomId, "chair", {}, foreign), /owning Claude session/);
  assert.throws(() => setStatus(f.room.roomId, "closed", foreign), /owning Claude session/);
  assert.throws(() => postEvent(f.room.roomId, { kind: "member", name: "critic", persona: "improver" }, { kind: "idea", body: "Spoofed" }, f.env), /persona/);
  assert.equal(f.post("chair", "decision").author.name, "chair");
});

test("the store enforces post limits and private regular files and serializes concurrent posts with crash-tail recovery", async () => {
  const f = fixture(), location = path.join(f.env.CODEX_COMPANION_HOME, "duet", "roundtables", f.room.roomId);
  assert.equal(fs.statSync(location).mode & 0o777, 0o700);
  for (const name of ["room.json", "events.jsonl"]) assert.equal(fs.statSync(path.join(location, name)).mode & 0o777, 0o600);
  for (const extra of [{ body: "x".repeat(4001) }, { title: "x".repeat(161) }, { refs: Array(17).fill("r") }, { refs: ["x".repeat(513)] }, { mentions: Array(9).fill("critic") }, { mentions: ["outsider"] }, { label: "certain" }]) {
    assert.throws(() => postEvent(f.room.roomId, "critic", { kind: "idea", body: "Valid", ...extra }, f.env));
  }
  const module = new URL("../plugins/codex/scripts/lib/forum.mjs", import.meta.url).href;
  const children = Array.from({ length: 3 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", `import { postEvent } from ${JSON.stringify(module)}; for (let i = 0; i < 8; i++) postEvent(${JSON.stringify(f.room.roomId)}, "critic", { kind: "finding", body: "Concurrent evidence" });`], { env: f.env });
    let stderr = ""; child.stderr.on("data", chunk => { stderr += chunk; }); child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve() : reject(new Error(stderr)));
  }));
  await Promise.all(children);
  assert.deepEqual(f.read("chair").events.map(event => event.seq), Array.from({ length: 24 }, (_, i) => i + 1));
  fs.appendFileSync(path.join(location, "events.jsonl"), '{"seq":25');
  const stale = JSON.parse(fs.readFileSync(path.join(location, "room.json"))); stale.nextSeq = 1; stale.members.find(member => member.name === "critic").initialSeq = null;
  fs.writeFileSync(path.join(location, "room.json"), JSON.stringify(stale));
  assert.equal(f.post("critic", "finding").seq, 25); assert.equal(f.state().members.find(member => member.name === "critic").initialSeq, 1);
  const intact = fs.readFileSync(path.join(location, "room.json"), "utf8");
  const corrupt = JSON.parse(intact); delete corrupt.members[0].initialSeq;
  fs.writeFileSync(path.join(location, "room.json"), JSON.stringify(corrupt));
  assert.throws(() => f.read("conjecturer"), /Invalid roundtable room record/);
  fs.writeFileSync(path.join(location, "room.json"), intact);
  const events = f.thread("chair", 1).events, sample = events[0];
  fs.writeFileSync(path.join(location, "events.jsonl"), Array.from({ length: 5000 }, (_, i) => JSON.stringify({ ...sample, seq: i + 1, thread: i + 1, initial: i === 0 })).join("\n") + "\n");
  assert.throws(() => f.post("critic", "idea"), /5000-event limit/);
  fs.renameSync(path.join(location, "events.jsonl"), path.join(location, "saved.jsonl"));
  fs.symlinkSync(path.join(location, "saved.jsonl"), path.join(location, "events.jsonl"));
  assert.throws(() => f.read("chair"), /regular.*symlink/);
});

test("roundtable and forum CLI resolve the roster, print exact headers, scope the chair and expose status/pending/ack", () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.env.CODEX_COMPANION_HOME, "duet", "config.toml"), '[roundtable.personas.improver]\nmodel = "gpt-6.1-terra"\neffort = "high"\n');
  const run = json(f.call(["journal", "start", "--json"], JSON.stringify({ goal: "Accept the shared result", criteria: ["Evidence verified"] })));
  const started = json(f.call(["roundtable", "start", "--intensity", "light", "--persona-model", "critic=gpt-6-astra:max", "--json"], "A new shared goal"));
  assert.equal(started.runId, run.runId); assert.equal(started.chairCard, CHAIR_CARD);
  assert.equal(started.members[0].model, "gpt-6.1-terra"); assert.equal(started.members[0].effort, "high");
  assert.deepEqual(started.members.map(member => member.persona), ["improver", "critic"]);
  for (const member of started.members) {
    assert.deepEqual(member.workspace, { path: fs.realpathSync(f.dir), base: null, shared: true });
    assert.equal(member.header, `DUET: --model ${member.model} --effort ${member.effort} --normal --roundtable ${started.roomId} --persona ${member.persona} --cwd ${JSON.stringify(member.workspace.path)}`);
  }
  assert.equal(started.members[1].effort, "max");
  assert.equal(roundtableStatus({ sessionId: f.env.CODEX_COMPANION_SESSION_ID }, f.env).roomId, started.roomId);
  const decision = json(f.call(["forum", "post", started.roomId, "--kind", "decision", "--title", "Check", "--json"], "A constraint"));
  assert.equal(decision.author.kind, "chair");
  assert.equal(json(f.call(["forum", "read", started.roomId, "--json"])).events.length, 1);
  const notices = json(f.call(["forum", "pending", "--json"]));
  assert.equal(notices.length, 2); assert.equal(notices[0].roomId, started.roomId);
  json(f.call(["forum", "ack", started.roomId, "--member", "critic", "--upto", String(decision.seq), "--json"]));
  assert.equal(json(f.call(["forum", "pending", "--json"])).length, 1);
  const status = json(f.call(["roundtable", "status", started.roomId, "--json"]));
  assert.deepEqual(status.counts, { events: 1, threads: 1, openItems: 0 });
  assert.equal(f.call(["forum", "read", started.roomId, "--json"], undefined, { CODEX_COMPANION_SESSION_ID: "foreign" }).status, 1);
  for (const [action, status] of [["pause", "paused"], ["resume", "open"], ["close", "closed"]]) assert.equal(json(f.call(["roundtable", action, started.roomId, "--json"])).status, status);
  assert.equal(f.call(["roundtable", "start", "--json"], "").status, 1);
  assert.equal(f.call(["roundtable", "start", "--persona-model", "critic=gpt-6-astra:bogus", "--json"], "Goal").status, 1);
});

test("the Bash hook auto-approves only roundtable/forum read forms and the paired task binding", () => {
  const f = fixture(), launcher = new URL("../plugins/codex/bin/duet", import.meta.url).pathname;
  const env = { ...f.env, PATH: path.dirname(launcher) };
  const approved = command => approveDuet({ hook_event_name: "PreToolUse", tool_name: "Bash", permission_mode: "default", session_id: "chair-session", tool_use_id: "tool-a", cwd: f.dir, tool_input: { command } }, env).hookSpecificOutput?.permissionDecision === "allow";
  assert.equal(approved(`duet roundtable status ${f.room.roomId} --json`), true);
  assert.equal(approved(`duet forum read ${f.room.roomId} --after 0 --limit 2 --json`), true);
  assert.equal(approved(`duet forum read ${f.room.roomId} --resource candidate/1 --json`), true);
  assert.equal(approved("duet forum pending --json"), true);
  assert.equal(approved(`duet task --roundtable ${f.room.roomId} --persona critic`), true);
  for (const command of [`duet task --roundtable ${f.room.roomId}`, `duet task --persona critic`, "duet roundtable start", `duet roundtable close ${f.room.roomId}`, `duet forum post ${f.room.roomId} --kind decision --selects 1 --unreviewed 'Recorded reason'`, `duet forum ack ${f.room.roomId} --member critic --upto 1`, `duet forum read ${f.room.roomId} --kind decision`, "duet forum pending --session foreign"]) assert.equal(approved(command), false);
});

test("a roundtable task's fake Codex calls forum_post as its bound member and same-thread followups retain the frozen persona", async t => {
  const { fixture: runtimeFixture, job } = await lifecycleHarness();
  const f = runtimeFixture("roundtable-forum");
  assert.equal(run("git", ["commit", "--allow-empty", "-m", "Initial workspace"], { cwd: f.repo }).status, 0);
  const room = createRoom({ sessionId: f.env.CODEX_COMPANION_SESSION_ID, workspaceRoot: f.repo, goal: "Shared fixture goal", members: resolveRoster({ intensity: "light" }), intensity: "light" }, f.env);
  const invoke = args => f.call("task", "--follow", "--report", "--json", ...args, "Post your independent evidence.");
  const workspace = room.members.find(member => member.persona === "critic").workspace.path;
  const first = json(invoke(["--roundtable", room.roomId, "--persona", "critic", "--cwd", workspace])), saved = job(f, first.jobId);
  assert.deepEqual(saved.request.roundtable, { roomId: room.roomId, persona: "critic" });
  const member = readRoom(room.roomId, f.env).members.find(member => member.name === "critic");
  assert.deepEqual(member.jobIds, [first.jobId]); assert.equal(member.status, "active"); assert.equal(member.threadId, saved.threadId);
  assert.equal(f.state().lastTurnStart.model, member.model); assert.equal(f.state().lastTurnStart.effort, member.effort);
  assert.ok(saved.request.developerInstructions.includes(personaInstructions("critic", { roomId: room.roomId, goal: room.goal })));
  const bridge = f.state().lastThreadStart.config.mcp_servers.duet_parent;
  assert.deepEqual(bridge.enabled_tools, ["ask_parent", "forum_read", "forum_post"]);
  assert.equal(bridge.tools.forum_post.approval_mode, "approve");
  const calls = f.state().forumCalls[0];
  assert.deepEqual(calls.listing.result.tools.map(tool => tool.name), bridge.enabled_tools);
  assert.equal(calls.listing.result.tools[2].annotations.readOnlyHint, false);
  assert.equal(calls.listing.result.tools[1].annotations.readOnlyHint, true);
  assert.equal(calls.forged.result.isError, true); assert.equal(calls.posted.result.isError, false);
  assert.match(calls.before.result.content[0].text, /Sealed first round/);
  assert.match(calls.posted.result.content[0].text, /as critic/);
  assert.doesNotMatch(calls.after.result.content[0].text, /"events":/);
  const events = readThread(room.roomId, "critic", 1, f.env).events;
  assert.deepEqual(events[0].author, { kind: "member", name: "critic", persona: "critic", jobId: first.jobId, threadId: saved.threadId });
  const second = json(invoke(["--thread", saved.threadId, "--model", "gpt-6.1-sol", "--effort", "high"]));
  assert.deepEqual(job(f, second.jobId).request.roundtable, saved.request.roundtable);
  assert.equal(f.state().lastThreadResume.developerInstructions, saved.request.developerInstructions);
  assert.equal(f.state().lastTurnStart.model, "gpt-6.1-sol"); assert.equal(f.state().lastTurnStart.effort, "high");
  assert.deepEqual(readRoom(room.roomId, f.env).members.find(member => member.name === "critic").jobIds, [first.jobId, second.jobId]);
  assert.equal(invoke(["--roundtable", room.roomId]).status, 1);
  assert.equal(invoke(["--roundtable", room.roomId, "--persona", "calibrator"]).status, 1);
  assert.equal(invoke(["--thread", saved.threadId, "--roundtable", room.roomId, "--persona", "improver"]).status, 1);
  updateMember(room.roomId, "critic", { status: "stopped" }, f.env);
  assert.equal(invoke(["--thread", saved.threadId]).status, 1);
  const ordinary = parentBridgeConfig({ cwd: f.repo, jobId: "ordinary" }).mcp_servers.duet_parent;
  assert.deepEqual(ordinary.enabled_tools, ["ask_parent"]); assert.deepEqual(ordinary.tools, { ask_parent: { approval_mode: "approve" } });
});

test("roundtable task requires the member workspace before dispatch and followups keep that cwd", async () => {
  const { fixture: runtimeFixture, job } = await lifecycleHarness();
  const f = runtimeFixture("review-ok");
  assert.equal(run("git", ["commit", "--allow-empty", "-m", "Initial workspace"], { cwd: f.repo }).status, 0);
  const room = createRoom({ sessionId: f.env.CODEX_COMPANION_SESSION_ID, workspaceRoot: f.repo, goal: "Keep member cwd", members: resolveRoster({ intensity: "light" }) }, f.env);
  const workspace = room.members.find(member => member.persona === "critic").workspace.path;
  const invoke = args => f.call("task", "--follow", "--report", "--json", ...args, "Inspect the workspace.");
  const wrong = invoke(["--roundtable", room.roomId, "--persona", "critic"]);
  assert.equal(wrong.status, 1); assert.match(wrong.stderr, /must use its recorded workspace/);
  assert.equal(readRoom(room.roomId, f.env).members.find(member => member.persona === "critic").claimedAt, undefined);
  assert.equal(fs.existsSync(path.join(f.dir, "fake-codex-state.json")), false);
  const first = json(invoke(["--roundtable", room.roomId, "--persona", "critic", "--cwd", workspace]));
  const saved = job(f, first.jobId);
  assert.equal(saved.request.cwd, workspace);
  const next = json(invoke(["--to", first.jobId]));
  assert.equal(job(f, next.jobId).request.cwd, workspace);
  assert.equal(job(f, next.jobId).threadId, saved.threadId);
  const moved = invoke(["--thread", saved.threadId, "--cwd", f.repo]);
  assert.equal(moved.status, 1); assert.match(moved.stderr, /must use its recorded workspace/);
});

test("roundtable start owns detached member worktrees at HEAD, prints their cwd, and rolls back a failed room", t => {
  const f = fixture();
  initGitRepo(f.dir);
  assert.equal(run("git", ["commit", "--allow-empty", "-m", "Initial workspace"], { cwd: f.dir }).status, 0);
  const base = run("git", ["rev-parse", "HEAD"], { cwd: f.dir }).stdout.trim();
  const env = { ...f.env, CODEX_COMPANION_HOME: path.join(f.dir, "owned workspaces") };
  const started = json(f.call(["roundtable", "start", "--intensity", "light", "--json"], "Persistent seats", env));
  const stored = readRoom(started.roomId, env);
  for (const member of started.members) {
    const target = path.join(env.CODEX_COMPANION_HOME, "duet", "roundtables", started.roomId, "worktrees", member.persona);
    assert.deepEqual(member.workspace, { path: target, base, shared: false });
    assert.deepEqual(stored.members.find(value => value.persona === member.persona).workspace, member.workspace);
    assert.equal(member.header, `DUET: --model ${member.model} --effort ${member.effort} --normal --roundtable ${started.roomId} --persona ${member.persona} --cwd ${JSON.stringify(target)}`);
    assert.equal(run("git", ["rev-parse", "HEAD"], { cwd: target }).stdout.trim(), base);
    assert.equal(run("git", ["symbolic-ref", "--quiet", "HEAD"], { cwd: target }).status, 1);
    assert.equal(fs.statSync(target).mode & 0o777, 0o700);
  }
  const root = path.join(env.CODEX_COMPANION_HOME, "duet", "roundtables");
  const rooms = fs.readdirSync(root), before = run("git", ["worktree", "list", "--porcelain"], { cwd: f.dir }).stdout;
  const mkdir = fs.mkdirSync;
  const failure = t.mock.method(fs, "mkdirSync", function(target, ...args) {
    if (String(target).endsWith(`${path.sep}worktrees${path.sep}critic`)) throw new Error("Injected second member creation failure");
    return mkdir.call(this, target, ...args);
  });
  assert.throws(() => createRoom({ sessionId: env.CODEX_COMPANION_SESSION_ID, workspaceRoot: f.dir, goal: "Atomic room", members: resolveRoster({ intensity: "light" }) }, env), /second member creation failure/);
  failure.mock.restore();
  assert.deepEqual(fs.readdirSync(root), rooms);
  assert.equal(run("git", ["worktree", "list", "--porcelain"], { cwd: f.dir }).stdout, before);
  const existing = makeTempDir("roundtable-target-"), occupied = path.join(existing, "worktrees");
  fs.mkdirSync(occupied);
  const room = { ...stored, members: resolveRoster({ intensity: "light" }) };
  assert.throws(() => createMemberWorkspaces(room, existing, env), /EEXIST/);
  fs.rmdirSync(occupied); fs.symlinkSync(path.dirname(existing), occupied);
  assert.throws(() => createMemberWorkspaces(room, existing, env), /EEXIST/);
  assert.ok(fs.lstatSync(occupied).isSymbolicLink());
});

test("roundtable close removes only clean base worktrees and reports preserved commits and dirty files", () => {
  const f = fixture();
  initGitRepo(f.dir);
  fs.writeFileSync(path.join(f.dir, "tracked.txt"), "Base\n");
  fs.writeFileSync(path.join(f.dir, ".gitignore"), "ignored.log\nisolated/\n");
  assert.equal(run("git", ["add", "tracked.txt", ".gitignore"], { cwd: f.dir }).status, 0);
  assert.equal(run("git", ["commit", "-m", "Initial workspace"], { cwd: f.dir }).status, 0);
  const started = json(f.call(["roundtable", "start", "--roles", "critic,improver,steward,conjecturer", "--json"], "Preserve candidates"));
  const [committed, dirty, clean, ignored] = started.members;
  assert.equal(run("git", ["commit", "--allow-empty", "-m", "Candidate with unchanged tree"], { cwd: committed.workspace.path }).status, 0);
  const head = run("git", ["rev-parse", "HEAD"], { cwd: committed.workspace.path }).stdout.trim();
  fs.writeFileSync(path.join(dirty.workspace.path, "tracked.txt"), "Candidate\n");
  fs.writeFileSync(path.join(dirty.workspace.path, "new.txt"), "Untracked evidence\n");
  fs.writeFileSync(path.join(ignored.workspace.path, "ignored.log"), "Keep ignored evidence\n");
  const status = json(f.call(["roundtable", "status", started.roomId, "--json"]));
  assert.deepEqual(status.members.map(member => member.workspace.hasChanges), [true, true, false, true]);
  assert.deepEqual(status.members.map(member => member.workspace.dirtyFiles), [0, 2, 0, 1]);
  assert.equal(status.members[0].workspace.head, head); assert.equal(status.members[0].workspace.branch, null);
  assert.deepEqual(status.members[0].workspace.commits, [head]);
  assert.ok(f.call(["roundtable", "status"]).stdout.includes(dirty.workspace.path));
  const closed = json(f.call(["roundtable", "close", started.roomId, "--json"]));
  assert.equal(closed.status, "closed");
  assert.deepEqual(closed.workspaceCleanup.removed.map(workspace => workspace.path), [clean.workspace.path]);
  assert.deepEqual(closed.workspaceCleanup.kept.map(workspace => workspace.path), [committed.workspace.path, dirty.workspace.path, ignored.workspace.path]);
  assert.equal(closed.workspaceCleanup.kept[0].head, head);
  assert.deepEqual(closed.workspaceCleanup.kept[0].commits, [head]);
  assert.equal(closed.workspaceCleanup.kept[0].dirtyFiles, 0);
  assert.equal(closed.workspaceCleanup.kept[1].dirtyFiles, 2);
  assert.equal(fs.existsSync(clean.workspace.path), false);
  assert.equal(fs.readFileSync(path.join(dirty.workspace.path, "tracked.txt"), "utf8"), "Candidate\n");
  assert.equal(fs.readFileSync(path.join(dirty.workspace.path, "new.txt"), "utf8"), "Untracked evidence\n");
  assert.equal(fs.readFileSync(path.join(ignored.workspace.path, "ignored.log"), "utf8"), "Keep ignored evidence\n");
  assert.equal(run("git", ["rev-parse", "HEAD"], { cwd: committed.workspace.path }).stdout.trim(), head);
});

test("a member is seated by one fresh dispatch, posts only from its bound thread, and journals to the room's run", () => {
  const f = fixture();
  updateMember(f.room.roomId, "critic", { claim: true }, f.env);
  assert.throws(() => updateMember(f.room.roomId, "critic", { claim: true }, f.env), /already dispatched/);
  updateMember(f.room.roomId, "critic", { status: "active", jobIds: ["job-a"], threadId: "thread-a" }, f.env);
  assert.throws(() => updateMember(f.room.roomId, "critic", { claim: true }, f.env), /already has a thread/);
  assert.throws(() => f.post({ kind: "member", name: "critic", jobId: "job-x", threadId: "thread-b" }, "idea"), /bound thread/);
  assert.equal(f.post({ kind: "member", name: "critic", jobId: "job-a", threadId: "thread-a" }, "idea").author.threadId, "thread-a");
  // A room without a run keeps member activity out of whichever run the session selects later.
  const other = JSON.parse(f.call(["journal", "start"], JSON.stringify({ goal: "Other work", criteria: ["Done"] })).stdout).runId;
  const conflict = f.call(["task", "--roundtable", f.room.roomId, "--persona", "improver", "--run", other, "--json"], "Work.");
  assert.notEqual(conflict.status, 0);
  assert.match(conflict.stderr, /records its activity in run none/);
});

test("closing with a decision records it and closes the room without waking members", () => {
  const f = fixture();
  storeMemberJob(f, "critic", "job-critic");
  assert.equal(f.call(["roundtable", "close", f.room.roomId, "--unreviewed", "No review"], "").status, 1);
  assert.equal(f.state().status, "open", "A refused closing decision leaves the room open");
  const closed = json(f.call(["roundtable", "close", f.room.roomId, "--title", "Close: done", "--json"], "Finished; no candidate."));
  assert.equal(closed.status, "closed"); assert.equal(closed.closingDecision.title, "Close: done");
  assert.equal(json(f.call(["forum", "read", f.room.roomId, "--json"])).events.at(-1).kind, "decision");
  assert.deepEqual(json(f.call(["forum", "pending", "--json"])), []);
  assert.deepEqual(json(f.call(["roundtable", "status", f.room.roomId, "--json"])).attention, []);
});
