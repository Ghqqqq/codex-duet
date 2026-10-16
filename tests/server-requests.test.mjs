import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../plugins/codex/scripts/lib/args.mjs";
import { normalizeBrowserOrigin, normalizeBrowserOrigins, decideServerRequest, ServerRequestRelay } from "../plugins/codex/scripts/lib/server-requests.mjs";
import { makeTempDir, initGitRepo, run, requireLocalSockets } from "./helpers.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";

const script = new URL("../plugins/codex/scripts/codex-companion.mjs", import.meta.url).pathname;
const policy = { threadId: "thread-1", turnId: "turn-1", approvedBrowserOrigins: ["https://example.com"] };
function request(patch = {}) {
  return { id: 7, method: "item/commandExecution/requestApproval", params: {
    threadId: "thread-1", turnId: "turn-1", itemId: "item-1", startedAtMs: 0,
    networkApprovalContext: { protocol: "https", host: "EXAMPLE.COM:443" },
    reason: "DO_NOT_LOG_FIXTURE", ...patch
  } };
}
function fixture() {
  const dir = makeTempDir(); installFakeCodex(dir, "server-requests");
  const repo = path.join(dir, "repo"); fs.mkdirSync(repo); initGitRepo(repo);
  const env = { ...buildEnv(dir), CLAUDE_PLUGIN_DATA: path.join(dir, "data") };
  const call = (...args) => run(process.execPath, [script, ...args], { cwd: repo, env });
  return { dir, repo, env, call, state: () => JSON.parse(fs.readFileSync(path.join(dir, "fake-codex-state.json"))) };
}

test("origin flags normalize case/default ports and repeat without dropping equals suffixes", () => {
  const options = parseArgs(["--approve-browser-origin", "HTTPS://EXAMPLE.COM:443", "--approve-browser-origin=http://example.com:80", "--approve-browser-origin=https://example.com:8443"], { repeatableOptions: ["approve-browser-origin"] }).options;
  assert.deepEqual(normalizeBrowserOrigins(options["approve-browser-origin"]), ["https://example.com", "http://example.com", "https://example.com:8443"]);
  assert.deepEqual(normalizeBrowserOrigins(["HTTPS://EXAMPLE.COM:443", "https://example.com"]), ["https://example.com"]);
  assert.equal(normalizeBrowserOrigin("https://[::1]:443"), "https://[::1]");
  assert.equal(parseArgs(["--approve-browser-origin=https://example.com?x=1"], { repeatableOptions: ["approve-browser-origin"] }).options["approve-browser-origin"][0], "https://example.com?x=1");
});

test("invalid origins fail without echoing supplied input", () => {
  for (const value of ["", " https://example.com", "https://example.com/", "https://example.com/path", "https://example.com?x=1", "https://example.com#x", "https://user@example.com", "https://*.example.com", "*", "example.com", "file://example.com", "https://example.com:", "https://example.com:65536", "https://-bad.example", "https://example..com", "https://127.1", "https://%65xample.com", "https://example.com\\other", "https://example.com\n", "https://example.com=sentinel", "https://[nope]"]) {
    assert.throws(() => normalizeBrowserOrigin(value), error => error.message.startsWith("--approve-browser-origin requires") && !error.message.includes("sentinel"));
  }
});

test("only an exact origin, current turn, network-only schema request receives accept", () => {
  const matched = decideServerRequest(request(), policy);
  assert.deepEqual(matched.reply, { id: 7, result: { decision: "accept" } });
  assert.equal(matched.summary.reason, "origin-match");
  assert.equal(matched.summary.origin, "https://example.com");
  for (const [p, override, reason] of [
    [{}, { approvedBrowserOrigins: [] }, "no-flag"],
    [{ networkApprovalContext: { protocol: "https", host: "example.com:8443" } }, {}, "origin-mismatch"],
    [{ networkApprovalContext: { protocol: "http", host: "example.com" } }, {}, "origin-mismatch"],
    [{ networkApprovalContext: { protocol: "https", host: "child.example.com" } }, {}, "origin-mismatch"],
    [{ threadId: "other-thread" }, {}, "turn-mismatch"],
    [{ turnId: "old-turn" }, {}, "turn-mismatch"],
    [{}, { turnId: null }, "turn-mismatch"],
    [{ command: "DO_NOT_LOG_FIXTURE" }, {}, "not-network-only"],
    [{ commandActions: [{}] }, {}, "not-network-only"],
    [{ cwd: "/fixture" }, {}, "not-network-only"],
    [{ kind: "writeStdin" }, {}, "not-network-only"],
    [{ proposedNetworkPolicyAmendments: [{ host: "example.com", action: "allow" }] }, {}, "not-network-only"],
    [{ proposedExecpolicyAmendment: ["fixture"] }, {}, "not-network-only"],
    [{ environmentId: "remote" }, {}, "not-network-only"],
    [{ networkApprovalContext: { protocol: "socks5Tcp", host: "example.com" } }, {}, "malformed-request"],
    [{ networkApprovalContext: { protocol: "https", host: "example.com/path" } }, {}, "malformed-request"],
    [{ networkApprovalContext: { protocol: "https", host: false } }, {}, "malformed-request"],
    [{ unexpectedGrant: true }, {}, "malformed-request"],
    [{ startedAtMs: undefined }, {}, "malformed-request"]
  ]) {
    const result = decideServerRequest(request(p), { ...policy, ...override });
    assert.equal(result.reply.error.code, -32601);
    assert.equal(result.summary.reason, reason);
    assert.doesNotMatch(JSON.stringify(result.summary), /DO_NOT_LOG_FIXTURE|unexpectedGrant/);
  }
});

test("opaque browser elicitations cancel without persistence; other requests stay unsupported", () => {
  for (const method of ["mcpServer/elicitation/request", "item/permissions/requestApproval", "item/fileChange/requestApproval", "item/tool/requestUserInput", "item/tool/call", "account/chatgptAuthTokens/refresh", "attestation/generate", "applyPatchApproval", "execCommandApproval"]) {
    const result = decideServerRequest({ id: "DO_NOT_LOG_FIXTURE", method, params: { mode: "form", message: "DO_NOT_LOG_FIXTURE", _meta: { origin: "https://EXAMPLE.COM:443", tool_name: "access_browser_origin" }, permissions: { network: { enabled: true } } } }, policy);
    if (method === "mcpServer/elicitation/request") {
      assert.deepEqual(result.reply.result, { action: "cancel" });
      assert.equal(result.summary.reason, "unsupported-elicitation-nonpersistent");
    } else {
      assert.equal(result.reply.error.code, -32601);
      assert.equal(result.summary.reason, "unsupported-method");
    }
    assert.equal(result.summary.method, method);
    assert.doesNotMatch(JSON.stringify(result.summary), /DO_NOT_LOG_FIXTURE|access_browser_origin|"permissions":/);
    if (method === "mcpServer/elicitation/request") {
      assert.equal(result.summary.origin, "https://example.com");
      assert.ok(result.summary.fields.includes("_meta.tool_name:string"));
    }
  }
  const unknown = decideServerRequest({ id: "DO_NOT_LOG_FIXTURE", method: "DO_NOT_LOG_FIXTURE", params: {} }, policy);
  assert.doesNotMatch(JSON.stringify(unknown.summary), /DO_NOT_LOG_FIXTURE/);
  for (const params of [null, [], {}, { networkApprovalContext: null }]) assert.equal(decideServerRequest({ ...request(), params }, policy).reply.error.code, -32601);
});

test("broker relay returns a schema-correct parent answer only from its owning client", () => {
  const sent = [], replies = [], owner = {}, stranger = {};
  const relay = new ServerRequestRelay({ send: (socket, message) => sent.push(message), respond: message => replies.push(message), log: () => {} });
  relay.request({ id: 27, method: "item/tool/call", params: { tool: "ask_parent" } }, owner);
  const result = { success: true, contentItems: [{ type: "inputText", text: "Small" }] };
  relay.response({ id: sent[0].id, result }, stranger);
  assert.equal(replies.length, 0);
  relay.response({ id: sent[0].id, result }, owner);
  assert.deepEqual(replies, [{ id: 27, result }]);
});

test("broker relay routes only to the owner, rejects other sockets and fails closed on disconnect", () => {
  const sent = [], replies = [], logs = [];
  const relay = new ServerRequestRelay({ send: (owner, message) => sent.push({ owner, message }), respond: message => replies.push(message), log: summary => logs.push(summary) });
  const owner = {}, stranger = {};
  relay.request(request(), owner);
  const routed = sent[0].message;
  assert.equal(routed.method, request().method);
  assert.equal(relay.response({ id: routed.id, result: { decision: "accept" } }, stranger), true);
  assert.equal(replies.length, 0);
  const decision = decideServerRequest(routed, policy);
  relay.response(decision.reply, owner);
  assert.deepEqual(replies[0], { id: 7, result: { decision: "accept" } });
  relay.request(request(), owner);
  relay.disconnect(owner);
  assert.equal(replies[1].error.code, -32601);
  assert.equal(logs[0].reason, "job-disconnected");
  assert.equal(relay.response({ id: sent[1].message.id, result: { decision: "accept" } }, owner), false);
  relay.request(request(), null);
  assert.equal(replies[2].error.code, -32601);
  assert.equal(logs[1].reason, "no-active-job");
});

test("task requests are logged, origin flags persist in task/status/result and reset on follow-up", () => {
  const f = fixture();
  const first = f.call("task", "--json", "--report", "--approve-browser-origin", "HTTPS://EXAMPLE.COM:443", "--approve-browser-origin", "https://second.example", "fixture");
  assert.equal(first.status, 0, first.stderr);
  const report = JSON.parse(first.stdout);
  assert.deepEqual(report.approvedBrowserOrigins, ["https://example.com", "https://second.example"]);
  const status = JSON.parse(f.call("status", report.jobId, "--json").stdout);
  assert.deepEqual(status.job.approvedBrowserOrigins, report.approvedBrowserOrigins);
  assert.deepEqual(JSON.parse(f.call("result", report.jobId, "--report", "--json").stdout).approvedBrowserOrigins, report.approvedBrowserOrigins);
  assert.deepEqual(f.state().serverRequestReplies[0].result, { decision: "accept" });
  assert.ok(f.state().serverRequestReplies.slice(1).every(r => r.error?.code === -32601 || r.result?.action === "cancel"));
  const log = fs.readFileSync(status.job.logFile, "utf8");
  assert.equal(log.split("Server request ").length - 1, 8);
  for (const reason of ["origin-match", "origin-mismatch", "not-network-only", "malformed-request", "unsupported-method"]) assert.ok(log.includes(reason), reason);
  assert.doesNotMatch(log + first.stderr, /DO_NOT_LOG_FIXTURE|access_browser_origin|networkApprovalContext/);
  assert.match(f.call("status", report.jobId).stdout, /Approved browser origins.*https:\/\/example.com/);
  assert.match(f.call("result", report.jobId).stdout, /Approved browser origins.*https:\/\/example.com/);
  const follow = f.call("task", "--json", "--thread", report.threadId, "fixture follow-up");
  assert.equal(follow.status, 0, follow.stderr);
  assert.deepEqual(JSON.parse(follow.stdout).approvedBrowserOrigins, []);
  assert.ok(f.state().serverRequestReplies.slice(8).every(r => r.error?.code === -32601 || r.result?.action === "cancel"));
  assert.match(follow.stderr, /no-flag/);
});

test("invalid repeated origin CLI flags fail before runtime startup", () => {
  const f = fixture();
  for (const args of [["--approve-browser-origin"], ["--approve-browser-origin", "--json"], ["--approve-browser-origin="], ["--approve-browser-origin=https://example.com=DO_NOT_LOG_FIXTURE"], ["--approve-browser-origin", "https://example.com", "--approve-browser-origin", "https://other.example/path"]]) {
    const r = f.call("task", ...args);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /approve-browser-origin/);
    assert.doesNotMatch(r.stderr, /DO_NOT_LOG_FIXTURE/);
  }
  assert.throws(f.state, /ENOENT/);
});

test("background jobs persist invocation origins and expose them after completion", async () => {
  const f = fixture();
  const launch = f.call("task", "--background", "--json", "--approve-browser-origin", "https://example.com", "fixture");
  assert.equal(launch.status, 0, launch.stderr);
  const queued = JSON.parse(launch.stdout);
  assert.deepEqual(queued.approvedBrowserOrigins, ["https://example.com"]);
  let status;
  for (const deadline = Date.now() + 15000; Date.now() < deadline;) {
    status = JSON.parse(f.call("status", queued.jobId, "--json").stdout);
    if (!["queued", "running"].includes(status.job.status)) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(status.job.status, "completed");
  const result = JSON.parse(f.call("result", queued.jobId, "--json").stdout);
  assert.deepEqual(result.storedJob.request.approvedBrowserOrigins, ["https://example.com"]);
  assert.deepEqual(result.storedJob.result.approvedBrowserOrigins, ["https://example.com"]);
});

test("shared broker delivers task server requests and origin approvals to the active client", async t => {
  if (!await requireLocalSockets(t)) return;
  const f = fixture();
  try {
    const r = f.call("task", "--report", "--json", "--approve-browser-origin", "https://example.com", "fixture");
    assert.equal(r.status, 0, r.stderr);
    const report = JSON.parse(r.stdout);
    const status = JSON.parse(f.call("status", report.jobId, "--json").stdout);
    const all = JSON.parse(f.call("status", "--json").stdout);
    assert.equal(all.sessionRuntime.mode, "shared");
    assert.deepEqual(f.state().serverRequestReplies[0].result, { decision: "accept" });
    assert.equal(fs.readFileSync(status.job.logFile, "utf8").split("Server request ").length - 1, 8);
  } finally {
    const hook = new URL("../plugins/codex/scripts/session-lifecycle-hook.mjs", import.meta.url).pathname;
    const cleanup = run(process.execPath, [hook, "SessionEnd"], { cwd: f.repo, env: f.env, input: JSON.stringify({ hook_event_name: "SessionEnd", cwd: f.repo }) });
    assert.equal(cleanup.status, 0, cleanup.stderr);
  }
});
