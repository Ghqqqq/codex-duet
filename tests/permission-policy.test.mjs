import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDir, initGitRepo, run } from "./helpers.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { mapPermissionPolicy, permissionWorktree, mappedSandboxPolicy, pathWithin, livePermissionMismatch } from "../plugins/codex/scripts/lib/permission-policy.mjs";
import { actionApprovalRequest, ServerRequestRelay } from "../plugins/codex/scripts/lib/server-requests.mjs";
import { CodexAppServerClient } from "../plugins/codex/scripts/lib/app-server.mjs";
import { JobRuntime, directReport, askParentQuestion, answerQuestion } from "../plugins/codex/scripts/lib/job-runtime.mjs";
import { writeJobFile, readJobFile, resolveJobFile, updateJob } from "../plugins/codex/scripts/lib/state.mjs";

const script = new URL("../plugins/codex/scripts/codex-companion.mjs", import.meta.url).pathname;
function fixture(behavior = "review-ok") {
  const dir = makeTempDir(); installFakeCodex(dir, behavior);
  const repo = path.join(dir, "repo"); fs.mkdirSync(repo); initGitRepo(repo);
  const env = { ...buildEnv(dir), CLAUDE_PLUGIN_DATA: path.join(dir, "data"), CODEX_COMPANION_HOME: path.join(dir, "isolated") };
  const call = (...args) => run(process.execPath, [script, ...args], { cwd: repo, env });
  const json = result => { assert.equal(result.status, 0, result.stderr + result.stdout); return JSON.parse(result.stdout); };
  return { dir, repo, env, call, json, state: () => JSON.parse(fs.readFileSync(path.join(dir, "fake-codex-state.json"))) };
}

test("Claude mode mapping fails closed and explicit sandbox flags only lower its ceiling", () => {
  const expected = [
    [undefined, "read-only", "never"], ["unknown-mode", "read-only", "never"], ["plan", "read-only", "never"],
    ["default", "workspace-write", "untrusted"], ["acceptEdits", "workspace-write", "on-request"],
    ["dontAsk", "workspace-write", "never"], ["auto", "workspace-write", "never"],
    ["bypassPermissions", "workspace-write", "on-request"]
  ];
  for (const [mode, sandbox, approvalPolicy] of expected) {
    const result = mapPermissionPolicy({ mode });
    assert.deepEqual([result.sandbox, result.approvalPolicy], [sandbox, approvalPolicy], String(mode));
  }
  assert.equal(mapPermissionPolicy({ mode: "default", explicitSandbox: "danger-full-access" }).sandbox, "workspace-write");
  assert.equal(mapPermissionPolicy({ mode: "plan", explicitSandbox: "danger-full-access" }).sandbox, "read-only");
  assert.equal(mapPermissionPolicy({ mode: "acceptEdits", explicitSandbox: "read-only" }).approvalPolicy, "never");
  assert.equal(mapPermissionPolicy({ mode: "bypassPermissions", configuredSandbox: "danger-full-access" }).sandbox, "danger-full-access");
  assert.equal(mapPermissionPolicy({ mode: "bypassPermissions", explicitSandbox: "danger-full-access", isolated: true }).sandbox, "workspace-write");
  assert.equal(mapPermissionPolicy({ mode: "bypassPermissions", configuredSandbox: "danger-full-access", explicitSandbox: "read-only" }).sandbox, "read-only");
  assert.ok(livePermissionMismatch(mapPermissionPolicy({ mode: "default" }), mapPermissionPolicy({ mode: "auto" })));
  assert.ok(livePermissionMismatch(mapPermissionPolicy({ mode: "default" }), mapPermissionPolicy({})));
});

test("mapped worktrees confine roots and cwd, preserve only linked git metadata, and tighten resumed turns", () => {
  const f = fixture(), wt = path.join(f.repo, ".claude/worktrees/worker");
  assert.equal(run("git", ["commit", "--allow-empty", "-m", "fixture"], { cwd: f.repo, env: f.env }).status, 0);
  assert.equal(run("git", ["worktree", "add", "-b", "worker", wt], { cwd: f.repo, env: f.env }).status, 0);
  fs.symlinkSync(f.repo, path.join(wt, "escape"));
  const confinement = permissionWorktree(wt), gitdir = fs.realpathSync(path.join(f.repo, ".git/worktrees/worker"));
  assert.deepEqual(confinement.writableRoots, [fs.realpathSync(wt), gitdir]);
  const policy = mappedSandboxPolicy({ ...mapPermissionPolicy({ mode: "default" }), ...confinement });
  assert.deepEqual([policy.excludeTmpdirEnvVar, policy.excludeSlashTmp, policy.networkAccess], [true, true, false]);
  assert.ok(!policy.writableRoots.some(root => pathWithin(root, f.repo) || pathWithin(root, path.join(f.repo, ".git/objects"))));
  assert.throws(() => permissionWorktree(f.repo, { hostCwd: wt }), /inside the isolation worktree/);
  assert.throws(() => permissionWorktree(path.join(wt, "escape"), { hostCwd: wt }), /inside the isolation worktree/);
  assert.throws(() => permissionWorktree(f.repo, { hostCwd: path.join(wt, "escape") }), /inside the isolation worktree/);
  fs.symlinkSync(wt, path.join(f.dir, "worktree-alias"));
  assert.throws(() => permissionWorktree(f.repo, { hostCwd: path.join(f.dir, "worktree-alias") }), /inside the isolation worktree/);
  assert.equal(permissionWorktree(wt, { hostCwd: wt, isolation: "worktree" }).worktree, fs.realpathSync(wt));
  const inner = path.join(wt, ".claude/worktrees/inner"); fs.mkdirSync(inner, { recursive: true });
  fs.symlinkSync(wt, path.join(inner, "escape"));
  assert.equal(permissionWorktree(inner, { hostCwd: inner, isolation: "worktree" }).worktree, fs.realpathSync(inner));
  assert.throws(() => permissionWorktree(wt, { hostCwd: inner, isolation: "worktree" }), /inside the isolation worktree/);
  assert.throws(() => permissionWorktree(path.join(inner, "escape"), { hostCwd: inner }), /inside the isolation worktree/);
  // An alias outside the nested marker still confines to the canonical inner worktree.
  const alias = path.join(wt, "inner-alias"); fs.symlinkSync(inner, alias);
  assert.deepEqual(permissionWorktree(alias, { hostCwd: alias, isolation: "worktree" }).writableRoots.slice(0, 1), [fs.realpathSync(inner)]);
  f.json(f.call("setup", "--permission-mapping", "claude", "--json"));
  const first = f.json(f.call("task", "--detached", "--json", "--cwd", wt, "--native-cwd", wt,
    "--claude-permission-mode", "default", "--sandbox", "danger-full-access", "inspect"));
  f.json(f.call("wait", first.jobId, "--cwd", wt, "--owner", first.ownerId, "--json"));
  assert.deepEqual(f.state().lastTurnStart.sandboxPolicy, policy);
  assert.equal(f.state().lastTurnStart.approvalPolicy, "untrusted");
  assert.deepEqual(f.state().lastThreadStart.config.sandbox_workspace_write.writable_roots, policy.writableRoots);
  const started = f.state().threads.length;
  const escape = f.call("task", "--json", "--cwd", f.repo, "--native-cwd", wt, "--claude-permission-mode", "default", "escape");
  assert.notEqual(escape.status, 0); assert.match(escape.stderr, /inside the isolation worktree/);
  assert.equal(f.state().threads.length, started);
  const next = f.json(f.call("task", "--detached", "--json", "--thread", f.state().lastTurnStart.threadId,
    "--cwd", wt, "--native-cwd", wt, "--claude-permission-mode", "plan", "inspect"));
  f.json(f.call("wait", next.jobId, "--cwd", wt, "--owner", next.ownerId, "--json"));
  assert.equal(f.state().lastThreadResume.sandbox, "read-only");
  assert.deepEqual(f.state().lastTurnStart.sandboxPolicy, { type: "readOnly", networkAccess: false });
  assert.equal(f.state().lastTurnStart.approvalPolicy, "never");
  fs.writeFileSync(path.join(gitdir, "gitdir"), path.join(f.repo, ".git"));
  assert.throws(() => permissionWorktree(wt), /back-pointer/);
});

test("action approvals queue with ask_parent and Computer Use, bind exact operations, and deny by default", async t => {
  const f = fixture("permission-requests");
  f.json(f.call("setup", "--permission-mapping", "claude", "--json"));
  const launch = f.json(f.call("task", "--detached", "--json", "--claude-permission-mode", "default", "inspect"));
  const seen = [];
  for (const answer of ["Allow once", "Allow once", "Use the small approach", "Deny"]) {
    const pending = f.json(f.call("wait", launch.jobId, "--owner", launch.ownerId, "--json"));
    assert.equal(pending.status, "needs_answer"); seen.push(pending.question);
    const result = run(process.execPath, [script, "answer", launch.jobId, "--owner", launch.ownerId,
      "--question", pending.question.id, "--json"], { cwd: f.repo, env: f.env, input: answer });
    f.json(result);
  }
  const done = f.call("wait", launch.jobId, "--owner", launch.ownerId, "--json");
  assert.ok([0, 2].includes(done.status), done.stderr + done.stdout);
  assert.deepEqual(seen.map(q => q.kind), ["action-approval", "action-approval", "question", "approval"]);
  assert.deepEqual(seen[0].options, ["Allow once", "Deny"]);
  assert.match(seen[0].text, /printf 'hello  world'/);
  assert.match(seen[1].text, /file.txt.*-before\\n\+after/);
  const replies = f.state().serverRequestReplies;
  assert.deepEqual(replies.map(r => r.result.decision ?? r.result.action ?? r.result.contentItems[0].text),
    ["accept", "accept", "Use the small approach", "cancel"]);
  const stored = f.json(f.call("status", launch.jobId, "--json")).job;
  assert.equal(stored.questionHistory[0].binding.jobId, launch.jobId);
  assert.equal(stored.questionHistory[0].binding.threadId, stored.threadId);
  assert.equal(stored.questionHistory[0].binding.turnId, stored.turnId);
  assert.match(stored.questionHistory[0].binding.requestId, /^broker-server-/);
  assert.equal(stored.questionQueue.length, 0);
  const denied = f.json(f.call("task", "--detached", "--json", "--claude-permission-mode", "dontAsk", "inspect"));
  const onlyQuestion = f.json(f.call("wait", denied.jobId, "--owner", denied.ownerId, "--json"));
  assert.equal(onlyQuestion.question.kind, "question");
  f.json(run(process.execPath, [script, "answer", denied.jobId, "--owner", denied.ownerId,
    "--question", onlyQuestion.question.id, "--json"], { cwd: f.repo, env: f.env, input: "Keep the small approach" }));
  assert.ok([0, 2].includes(f.call("wait", denied.jobId, "--owner", denied.ownerId, "--json").status));
  assert.deepEqual(f.state().serverRequestReplies.slice(-4).map(r => r.result.decision ?? r.result.action ?? r.result.contentItems[0].text),
    ["decline", "decline", "cancel", "Keep the small approach"]);

  const context = { threadId: "t", turnId: "u" }, policy = { ...mapPermissionPolicy({ mode: "default" }), cwd: f.repo };
  const request = { id: "req", method: "item/commandExecution/requestApproval", params: { ...context, itemId: "i", startedAtMs: 1, command: "printf 'a  b'\n#\u202e", cwd: f.repo, environmentId: null } };
  const forwarded = actionApprovalRequest(request, context, policy);
  assert.match(forwarded.request.question, /\\n#\\u202e/);
  const compact = directReport({ status: "needs_answer", question: { id: "q", kind: "action-approval", text: forwarded.request.question, options: ["Allow once", "Deny"] } }, { id: "job" });
  assert.equal(compact.question.text, forwarded.request.question);
  assert.deepEqual(actionApprovalRequest(request, { ...context, turnId: "other" }, policy).reply.result, { decision: "decline" });
  assert.equal(actionApprovalRequest({ ...request, params: { ...request.params, command: "x".repeat(1000) } }, context, policy).summary.reason, "operation-too-large-to-display-exactly");
  assert.equal(actionApprovalRequest(request, context, { ...policy, forwardActions: false }).request, null);
  const file = { ...request, method: "item/fileChange/requestApproval", params: { ...context, itemId: "i", startedAtMs: 1, grantRoot: f.repo } };
  assert.equal(actionApprovalRequest(file, context, policy).summary.reason, "unsupported-root-grant");
  delete file.params.grantRoot;
  assert.equal(actionApprovalRequest(file, context, policy).summary.reason, "missing-file-change-details");
  const sent = [], owner = {}, other = {}, relay = new ServerRequestRelay({ send: (_, m) => sent.push(m), respond: m => sent.push(m), log: () => {} });
  relay.request(file, owner);
  relay.response({ id: sent[0].id, result: { decision: "accept" } }, other);
  assert.equal(sent.length, 1);
  relay.response({ id: sent[0].id, result: { decision: "decline" } }, owner);
  assert.deepEqual(sent[1], { id: "req", result: { decision: "decline" } });

  const cwd = makeTempDir(), id = "approval-timeout";
  let now = Date.now(); t.mock.method(Date, "now", () => now);
  writeJobFile(cwd, id, { id, status: "running", ownerId: "owner", threadId: "t", turnId: "u", questionTimeoutSec: 1,
    request: { permissionPolicy: policy } });
  const runtime = new JobRuntime(cwd, id, { foreground: true });
  const read = () => readJobFile(resolveJobFile(cwd, id));
  try {
    const timedOut = runtime.approval(forwarded.request);
    assert.equal(read().pendingQuestion.kind, "action-approval");
    now = read().pendingQuestion.expiresAt;
    assert.equal(await timedOut, "deny");
    const ambiguous = runtime.approval(forwarded.request);
    answerQuestion(cwd, id, read().pendingQuestion.id, "yes", "owner");
    assert.equal(await ambiguous, "deny");
    updateJob(cwd, id, () => ({ pendingQuestion: { id: "orphan", kind: "question", callId: "retry-call", text: "Retry?", options: [],
      turnId: "u", caller: { pid: process.pid, nonce: "old" }, askedAt: new Date(now).toISOString(), expiresAt: now + 1000, answer: "Exact recovered answer" } }));
    const recovered = await askParentQuestion(cwd, id, { question: "Retry?", callId: "retry-call" },
      { turnId: "u", caller: { pid: process.pid, nonce: "replacement" } });
    assert.deepEqual(recovered, { text: "Exact recovered answer", resolution: "answered" });
    const held = runtime.approval(forwarded.request);
    const queued = askParentQuestion(cwd, id, { question: "Queued parent question?" });
    assert.equal(read().questionQueue.length, 2);
    runtime.stop("fixture_cancel");
    assert.equal(await held, "deny");
    assert.equal((await queued).resolution, "interrupted");
    assert.equal(read().questionQueue.length, 0);
  } finally { runtime.close(); }
});

test("permission mapping defaults off and explicit off preserves existing native task policies", () => {
  const f = fixture();
  const setup = f.json(f.call("setup", "--json"));
  assert.equal(setup.permissionMapping, "off");
  const runTask = () => {
    const job = f.json(f.call("task", "--detached", "--json", "--claude-permission-mode", "unknown", "inspect"));
    f.json(f.call("wait", job.jobId, "--owner", job.ownerId, "--json"));
    return [f.state().lastThreadStart.sandbox, f.state().lastTurnStart.sandboxPolicy, f.state().lastTurnStart.approvalPolicy];
  };
  const before = runTask();
  assert.equal(before[0], "danger-full-access");
  assert.deepEqual(before[1], { type: "dangerFullAccess" });
  assert.equal(before[2].granular.sandbox_approval, false);
  assert.equal(before[2].granular.mcp_elicitations, true);
  const preview = f.json(f.call("setup", "--permission-mapping", "claude", "--dry-run", "--json"));
  assert.equal(preview.permissionMapping, "claude");
  assert.equal(f.json(f.call("setup", "--json")).permissionMapping, "off");
  assert.match(preview.permissionMappingLimits, /PreToolUse/);
  f.json(f.call("setup", "--permission-mapping", "claude", "--json"));
  assert.equal(f.json(f.call("setup", "--json")).permissionMapping, "claude");
  f.json(f.call("setup", "--permission-mapping", "off", "--json"));
  assert.deepEqual(runTask(), before);
  assert.notEqual(f.call("setup", "--permission-mapping", "invalid", "--json").status, 0);
});

test("mapped follow-ups retain an explicit sandbox ceiling and cannot widen it", () => {
  const f = fixture();
  f.json(f.call("setup", "--permission-mapping", "claude", "--json"));
  let launch = f.json(f.call("task", "--detached", "--json", "--claude-permission-mode", "default", "--sandbox", "read-only", "inspect"));
  f.json(f.call("wait", launch.jobId, "--owner", launch.ownerId, "--json"));
  launch = f.json(f.call("task", "--to", launch.jobId, "--detached", "--json", "--claude-permission-mode", "default", "inspect again"));
  f.json(f.call("wait", launch.jobId, "--owner", launch.ownerId, "--json"));
  assert.equal(f.state().lastThreadResume.sandbox, "read-only");
  assert.deepEqual(f.state().lastTurnStart.sandboxPolicy, { type: "readOnly", networkAccess: false });
  assert.equal(f.json(f.call("status", launch.jobId, "--json")).job.request.permissionPolicy.explicitSandbox, "read-only");
  launch = f.json(f.call("task", "--to", launch.jobId, "--detached", "--json", "--claude-permission-mode", "default", "--sandbox", "workspace-write", "inspect once more"));
  f.json(f.call("wait", launch.jobId, "--owner", launch.ownerId, "--json"));
  assert.deepEqual(f.state().lastTurnStart.sandboxPolicy, { type: "readOnly", networkAccess: false });
});

test("mapped live wait and answer check the recorded grant under the current mode", () => {
  const f = fixture("permission-requests");
  f.json(f.call("setup", "--permission-mapping", "claude", "--json"));
  f.json(f.call("setup", "--default-sandbox", "read-only", "--json"));
  const launch = f.json(f.call("task", "--detached", "--json", "--claude-permission-mode", "bypassPermissions", "--sandbox", "danger-full-access", "inspect"));
  for (let i = 0; i < 4; i++) {
    const pending = f.json(f.call("wait", launch.jobId, "--owner", launch.ownerId, "--claude-permission-mode", "bypassPermissions", "--json"));
    assert.equal(pending.status, "needs_answer");
    f.json(run(process.execPath, [script, "answer", launch.jobId, "--owner", launch.ownerId, "--question", pending.question.id,
      "--claude-permission-mode", "bypassPermissions", "--json"], { cwd: f.repo, env: f.env, input: "Deny" }));
  }
  assert.ok([0, 2].includes(f.call("wait", launch.jobId, "--owner", launch.ownerId, "--claude-permission-mode", "bypassPermissions", "--json").status));
  const stored = f.json(f.call("status", launch.jobId, "--json")).job;
  assert.equal(stored.cancelRequested, undefined);
  assert.equal(stored.request.permissionPolicy.explicitSandbox, "danger-full-access");
  assert.deepEqual(f.state().lastTurnStart.sandboxPolicy, { type: "dangerFullAccess" });
  const active = f.json(f.call("task", "--detached", "--json", "--claude-permission-mode", "bypassPermissions", "--sandbox", "danger-full-access", "inspect"));
  f.json(f.call("wait", active.jobId, "--owner", active.ownerId, "--claude-permission-mode", "bypassPermissions", "--json"));
  const changed = f.call("wait", active.jobId, "--owner", active.ownerId, "--claude-permission-mode", "default", "--json");
  assert.notEqual(changed.status, 0); assert.match(changed.stderr, /permission mode changed/);
  const stopping = f.json(f.call("status", active.jobId, "--json")).job;
  assert.equal(stopping.request.permissionPolicy.mode, "bypassPermissions");
  assert.equal(stopping.cancelRequested.reason, "permission_mode_changed");
  f.json(f.call("cancel", active.jobId, "--json"));
});

const flushRequests = () => new Promise(resolve => setImmediate(resolve));
async function approvalClient(t) {
  const f = fixture();
  const policy = { ...mapPermissionPolicy({ mode: "default" }), cwd: f.repo };
  const client = await CodexAppServerClient.connect(f.repo, { env: f.env, disableBroker: true, permissionPolicy: policy, onServerRequestLog: () => {} });
  t.after(() => client.close());
  const replies = [];
  client.sendMessage = message => replies.push(message);
  client.setServerRequestContext("t", "u");
  return { client, replies, policy, feed: message => client.handleLine(JSON.stringify(message)) };
}
const fileItem = diff => ({ type: "fileChange", id: "file", status: "inProgress", changes: [{ path: "file.txt", kind: { type: "update" }, diff }] });
const fileApproval = (id = "approval", turnId = "u") => ({ id, method: "item/fileChange/requestApproval", params: { threadId: "t", turnId, itemId: "file", startedAtMs: 1 } });

test("file approvals show updated patches and decline a displayed operation that changes", async t => {
  const { client, replies, feed } = await approvalClient(t);
  const displayed = []; let answer;
  client.options.onApprovalRequest = request => { displayed.push(request); return new Promise(resolve => { answer = resolve; }); };
  feed({ method: "item/started", params: { threadId: "t", turnId: "u", item: fileItem("A") } });
  feed({ method: "item/fileChange/patchUpdated", params: { threadId: "t", turnId: "u", itemId: "file", changes: fileItem("B").changes } });
  feed(fileApproval()); await flushRequests();
  assert.match(displayed[0].question, /"diff":"B"/);
  feed({ method: "item/fileChange/patchUpdated", params: { threadId: "t", turnId: "u", itemId: "file", changes: fileItem("C").changes } });
  assert.equal(displayed[0].signal.aborted, true);
  answer({ action: "accept" }); await flushRequests();
  assert.deepEqual(replies, [{ id: "approval", result: { decision: "decline" } }]);
  feed({ method: "item/fileChange/patchUpdated", params: { threadId: "t", turnId: "u", itemId: "file", changes: fileItem("x".repeat(16000)).changes } });
  feed(fileApproval("oversized")); await flushRequests();
  assert.equal(displayed.length, 1);
  assert.deepEqual(replies.at(-1), { id: "oversized", result: { decision: "decline" } });
});

test("early file items survive turn acknowledgement and cannot authorize another turn", async t => {
  const { client, replies, feed } = await approvalClient(t);
  const displayed = [];
  client.options.onApprovalRequest = async request => { displayed.push(request); return { action: "accept" }; };
  const started = client.request("turn/start", { threadId: "t", input: [] });
  const startId = replies.pop().id;
  feed({ method: "item/started", params: { threadId: "t", turnId: "old", item: fileItem("stale") } });
  feed({ method: "item/started", params: { threadId: "t", turnId: "next", item: fileItem("current") } });
  feed({ id: startId, result: { turn: { id: "next" } } });
  await started;
  feed(fileApproval("current", "next")); await flushRequests();
  assert.match(displayed[0].question, /"diff":"current"/);
  assert.deepEqual(replies, [{ id: "current", result: { decision: "accept" } }]);
  client.setServerRequestContext("t", "later");
  feed(fileApproval("stale", "later")); await flushRequests();
  assert.equal(displayed.length, 1);
  assert.deepEqual(replies.at(-1), { id: "stale", result: { decision: "decline" } });
});

test("resolved and duplicate action approvals release the question slot and cannot reply twice", async t => {
  const { client, replies, policy, feed } = await approvalClient(t);
  const cwd = makeTempDir(), id = "resolved-approval";
  writeJobFile(cwd, id, { id, status: "running", ownerId: "owner", threadId: "t", turnId: "u", request: { permissionPolicy: policy } });
  const runtime = new JobRuntime(cwd, id, { foreground: true }); t.after(() => runtime.close());
  const read = () => readJobFile(resolveJobFile(cwd, id));
  const calls = []; let answer;
  client.options.onApprovalRequest = request => {
    calls.push(runtime.approval(request));
    return new Promise(resolve => { answer = resolve; });
  };
  const request = { id: "command", method: "item/commandExecution/requestApproval", params: {
    threadId: "t", turnId: "u", itemId: "command", startedAtMs: 1, command: "echo hello", cwd } };
  feed(request); feed(request); await flushRequests();
  assert.equal(calls.length, 1);
  const questionId = read().pendingQuestion.id;
  feed({ method: "serverRequest/resolved", params: { threadId: "other", requestId: "command" } });
  assert.equal(read().pendingQuestion.id, questionId);
  feed({ method: "serverRequest/resolved", params: { threadId: "t", requestId: "command" } });
  assert.equal(await calls[0], "deny");
  assert.equal(read().pendingQuestion, null); assert.equal(read().phase, "running");
  assert.deepEqual(read().questionQueue, []);
  assert.equal(read().questionHistory.at(-1).resolution, "cancelled");
  assert.throws(() => answerQuestion(cwd, id, questionId, "Allow once", "owner"), /no longer pending/);
  answer({ action: "accept" }); feed(request); await flushRequests();
  assert.equal(calls.length, 1); assert.deepEqual(replies, []);
  const next = askParentQuestion(cwd, id, { question: "Next question?" });
  answerQuestion(cwd, id, read().pendingQuestion.id, "Continue", "owner");
  assert.equal((await next).text, "Continue");
  const accepted = { ...request, id: "accepted" };
  client.options.onApprovalRequest = async () => ({ action: "accept" });
  feed(accepted); feed(accepted); await flushRequests(); feed(accepted); await flushRequests();
  assert.deepEqual(replies, [{ id: "accepted", result: { decision: "accept" } }]);
  feed({ ...request, id: "early" });
  feed({ method: "serverRequest/resolved", params: { threadId: "t", requestId: "early" } });
  await flushRequests(); assert.equal(replies.length, 1);

  const sent = [], forwarded = [], owner = {};
  const relay = new ServerRequestRelay({ send: (_, m) => sent.push(m), respond: m => forwarded.push(m), log: () => {} });
  relay.request(request, owner, { trackActions: true }); relay.request(request, owner, { trackActions: true });
  assert.equal(sent.length, 1);
  assert.equal(relay.resolved({ method: "serverRequest/resolved", params: { threadId: "t", requestId: request.id } }), true);
  assert.equal(sent[1].params.requestId, sent[0].id);
  relay.response({ id: sent[0].id, result: { decision: "accept" } }, owner); relay.disconnect(owner);
  assert.deepEqual(forwarded, []);

  const f = fixture("permission-resolved");
  f.json(f.call("setup", "--permission-mapping", "claude", "--json"));
  const launch = f.json(f.call("task", "--detached", "--json", "--claude-permission-mode", "default", "inspect"));
  const pending = f.json(f.call("wait", launch.jobId, "--owner", launch.ownerId, "--json"));
  assert.equal(pending.question.kind, "question");
  f.json(run(process.execPath, [script, "answer", launch.jobId, "--owner", launch.ownerId, "--question", pending.question.id, "--json"],
    { cwd: f.repo, env: f.env, input: "Continue" }));
  f.json(f.call("wait", launch.jobId, "--owner", launch.ownerId, "--json"));
  assert.equal(f.state().resolvedApprovalReplies, undefined);
  assert.equal(f.state().serverRequestReplies.length, 1);
});
