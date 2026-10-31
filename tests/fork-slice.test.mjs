import "./test-environment.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { makeTempDir } from "./helpers.mjs";
import { sliceClaudeTranscript, snapshotClaudeSession } from "../plugins/codex/scripts/lib/claude-session-transfer.mjs";

const row = (type, uuid, parentUuid, extra = {}) => ({ type, uuid, parentUuid,
  isSidechain: false, sessionId: "synthetic-session", cwd: "/synthetic/repo", ...extra });
const message = (type, uuid, parentUuid, content, extra = {}) => row(type, uuid, parentUuid,
  { message: { role: type, content }, ...extra });
const boundary = (uuid = "boundary") => row("system", uuid, null, { subtype: "compact_boundary",
  logicalParentUuid: "old-turn", compactMetadata: { trigger: "auto", preservedSegment: { headUuid: "old-turn" } } });
const summary = (parent = "boundary") => message("user", "summary", parent, "Synthetic compact summary.", { isCompactSummary: true });
const lines = entries => entries.map(entry => JSON.stringify(entry));
const bytes = output => Buffer.byteLength(output.length ? output.join("\n") + "\n" : "");
function inspect(result, budget = 2 * 1024 * 1024) {
  const parsed = result.lines.map(line => JSON.parse(line)), seen = new Set();
  assert.equal(result.meta.slicedBytes, bytes(result.lines));
  assert.ok(result.meta.slicedBytes <= budget);
  for (const [index, entry] of parsed.entries()) {
    if (index === 0) assert.equal(entry.parentUuid, null);
    else assert.ok(seen.has(entry.parentUuid), `${entry.uuid} has an unresolved parent`);
    seen.add(entry.uuid);
    assert.equal(entry.sessionId, "synthetic-session");
    assert.equal(entry.cwd, "/synthetic/repo");
  }
  return parsed;
}

test("slice starts at the last main compact boundary and links its summary through dropped attachments", () => {
  const source = lines([
    boundary("old-boundary"), message("user", "old-turn", "old-boundary", "Old context"),
    boundary(), row("attachment", "attachment-1", "boundary"), row("attachment", "attachment-2", "attachment-1"),
    row("attachment", "attachment-3", "attachment-2"), summary("attachment-3"),
    message("assistant", "answer", "summary", "Current answer"),
    { ...boundary("side-boundary"), isSidechain: true }
  ]);
  const before = [...source], result = sliceClaudeTranscript(source), parsed = inspect(result);
  assert.deepEqual(source, before, "pure function does not change its input");
  assert.deepEqual(parsed.map(entry => entry.uuid), ["boundary", "summary", "answer"]);
  assert.deepEqual(parsed[0], boundary(), "logical parent and compact metadata are preserved");
  assert.equal(parsed[1].parentUuid, "boundary");
  assert.equal(parsed[1].isCompactSummary, true);
  assert.equal(parsed[1].message.content, "Synthetic compact summary.");
  assert.deepEqual(result.meta, { fromCompactBoundary: true, sourceBytes: bytes(source), slicedBytes: bytes(result.lines),
    droppedEntries: 6, trimmedToolResults: 0, trimmedImages: 0, droppedUnpairedTools: 0, tailCapped: false });
});

test("filtering walks to the nearest kept ancestor, not the immediately preceding conversation entry", () => {
  const source = lines([
    message("user", "root", null, "Question"), message("assistant", "sibling", "root", "Sibling"),
    row("attachment", "attachment", "root"), row("api-request-blob", "blob", "attachment"),
    message("assistant", "sidechain", "blob", "Sidechain", { isSidechain: true }),
    row("system", "system", "sidechain", { subtype: "informational", content: "Status" }),
    row("custom-title", "title", "system"), row("file-history-snapshot", "files", "title"),
    message("user", "next", "files", "Next", { isMeta: true })
  ]);
  const result = sliceClaudeTranscript(source), parsed = inspect(result);
  assert.deepEqual(parsed.map(entry => entry.uuid), ["root", "sibling", "system", "next"]);
  assert.equal(parsed[2].parentUuid, "root");
  assert.equal(parsed[3].parentUuid, "system");
  assert.equal(parsed[3].isMeta, true, "meta conversation entries are not sidechains");
  assert.equal(result.meta.droppedEntries, 5);
});

test("parent caching preserves forward references and per-entry fallbacks for missing or cyclic ancestry", () => {
  const source = lines([
    message("user", "root", null, "Root"), row("attachment", "bridge", "future"),
    row("attachment", "orphan", "missing"), row("attachment", "cycle-a", "cycle-b"),
    row("attachment", "cycle-b", "cycle-a"), message("user", "early", "bridge", "Early"),
    message("assistant", "future", "root", "Future"), message("user", "late", "bridge", "Late"),
    message("user", "orphan-1", "orphan", "Orphan one"), message("user", "orphan-2", "orphan", "Orphan two"),
    message("user", "cycle-1", "cycle-a", "Cycle one"), message("user", "cycle-2", "cycle-a", "Cycle two")
  ]);
  const parsed = inspect(sliceClaudeTranscript(source));
  assert.deepEqual(parsed.map(entry => [entry.uuid, entry.parentUuid]), [
    ["root", null], ["early", "root"], ["future", "root"], ["late", "future"],
    ["orphan-1", "late"], ["orphan-2", "orphan-1"], ["cycle-1", "orphan-2"], ["cycle-2", "cycle-1"]
  ]);
});

test("shared discarded ancestry is compressed for thousands of siblings, including tail-cap selections", t => {
  const count = 4000, source = [boundary(), summary()];
  for (let i = 0; i < count; i++) source.push(row("attachment", `attachment-${i}`, i ? `attachment-${i - 1}` : "summary"));
  for (let i = 0; i < count; i++) source.push(message("user", `sibling-${i}`, `attachment-${count - 1}`, `Sibling ${i}`));
  const input = lines(source);
  let elapsedMs = 0, lookups = 0;
  const originalGet = Map.prototype.get;
  for (const budgetBytes of [2 * 1024 * 1024, 64 * 1024]) {
    const started = performance.now();
    let result;
    Map.prototype.get = function (key) { lookups++; return originalGet.call(this, key); };
    try { result = sliceClaudeTranscript(input, { budgetBytes }); }
    finally { Map.prototype.get = originalGet; }
    elapsedMs += performance.now() - started;
    const parsed = inspect(result, budgetBytes);
    assert.deepEqual(parsed.slice(0, 2), [boundary(), summary()]);
    assert.equal(parsed.at(-1).uuid, `sibling-${count - 1}`);
    assert.ok(parsed.slice(2).every(entry => entry.parentUuid === "summary"));
    assert.equal(result.meta.tailCapped, budgetBytes === 64 * 1024);
    assert.equal(result.meta.droppedEntries, source.length - parsed.length);
    if (!result.meta.tailCapped) assert.equal(parsed.length, count + 2);
  }
  assert.ok(lookups < source.length * 100, `Expected linear map work, saw ${lookups} lookups for ${source.length} source entries`);
  t.diagnostic(`Shared ancestry, uncapped and capped: ${lookups} map lookups, ${elapsedMs.toFixed(1)} ms`);
});

test("oversized tool payloads and images become placeholders without losing tool envelopes", () => {
  const output = "界".repeat(6000), image = { type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(18000) } };
  const source = lines([
    message("assistant", "tool", null, [{ type: "tool_use", id: "call", name: "Synthetic", input: {} }]),
    message("user", "result", "tool", [{ type: "tool_result", tool_use_id: "call", content: output, is_error: false }, image],
      { toolUseResult: { stdout: output, stderr: "" } })
  ]);
  const result = sliceClaudeTranscript(source), parsed = inspect(result);
  assert.deepEqual(parsed[1].message.content, [
    { type: "tool_result", tool_use_id: "call", content: "[Duet: tool output trimmed for fork import, 18000 bytes]", is_error: false },
    { type: "text", text: "[Duet: image omitted for fork import]" }
  ]);
  assert.match(parsed[1].toolUseResult, /^\[Duet: tool output trimmed for fork import, \d+ bytes\]$/);
  assert.equal(result.meta.trimmedToolResults, 2, "the auxiliary copy is also counted and trimmed");
  assert.equal(result.meta.trimmedImages, 1);
  assert.ok(!result.lines.join("\n").includes(output));
});

test("nested images are omitted, small results stay intact, and thinking-only entries disappear", () => {
  const image = { type: "image", source: { type: "base64", data: "A".repeat(500) } };
  const smallImage = { type: "image", source: { type: "base64", data: "a" } };
  const smallResult = { type: "tool_result", tool_use_id: "small", content: "x".repeat(128) };
  const calls = ["image", "small"].map(id => ({ type: "tool_use", id, name: "Synthetic", input: {} }));
  const source = lines([
    message("user", "root", null, "Question"),
    message("assistant", "thinking", "root", [{ type: "thinking", thinking: "private", signature: "signature" }]),
    message("assistant", "answer", "thinking", [{ type: "redacted_thinking", data: "private" }, { type: "text", text: "Answer" }, ...calls]),
    message("user", "result", "answer", [{ type: "tool_result", tool_use_id: "image", content: [image] }, smallResult, smallImage])
  ]);
  const result = sliceClaudeTranscript(source, { toolResultMaxBytes: 128 }), parsed = inspect(result);
  assert.deepEqual(parsed.map(entry => entry.uuid), ["root", "answer", "result"]);
  assert.deepEqual(parsed[1].message.content, [{ type: "text", text: "Answer" }, ...calls]);
  assert.deepEqual(parsed[2].message.content, [
    { type: "tool_result", tool_use_id: "image", content: [{ type: "text", text: "[Duet: image omitted for fork import]" }] }, smallResult, smallImage
  ]);
  assert.equal(result.meta.trimmedImages, 1);
  assert.equal(result.meta.trimmedToolResults, 0);
  assert.equal(result.meta.droppedEntries, 1);
});

test("a byte cap preserves the boundary, summary, and newest turns with repaired ancestry", () => {
  const source = [boundary(), summary()];
  for (let i = 0; i < 10; i++) source.push(message(i % 2 ? "assistant" : "user", `turn-${i}`, i ? `turn-${i - 1}` : "summary", "界".repeat(100)));
  const expected = [boundary(), summary(), { ...source.at(-2), parentUuid: "summary" }, source.at(-1)];
  const budgetBytes = bytes(lines(expected));
  const result = sliceClaudeTranscript(lines(source), { budgetBytes }), parsed = inspect(result, budgetBytes);
  assert.deepEqual(parsed, expected);
  assert.equal(result.meta.tailCapped, true);
  assert.equal(result.meta.droppedEntries, 8);
});

test("the default cap drops an oversized tool exchange together instead of retaining its orphan result", () => {
  const source = [boundary(), summary(),
    message("assistant", "write", "summary", [{ type: "tool_use", id: "write-call", name: "Write", input: { content: "x".repeat(2 * 1024 * 1024) } }]),
    message("user", "result", "write", [{ type: "tool_result", tool_use_id: "write-call", content: "Written" }]),
    message("assistant", "reply", "result", "Newest reply")];
  const result = sliceClaudeTranscript(lines(source)), parsed = inspect(result);
  assert.deepEqual(parsed.map(entry => entry.uuid), ["boundary", "summary", "reply"]);
  assert.equal(result.meta.tailCapped, true);
  assert.equal(result.meta.droppedEntries, 2);
  assert.equal(result.meta.droppedUnpairedTools, 0, "a complete omitted exchange is not an unpaired block");
});

test("tail caps keep complete tool exchanges across split assistant entries and combined results", () => {
  const source = [boundary(), summary(), message("user", "old", "summary", "x".repeat(5000)),
    message("assistant", "call-a", "old", [{ type: "tool_use", id: "a", name: "Synthetic", input: {} }]),
    message("assistant", "call-b", "call-a", [{ type: "tool_use", id: "b", name: "Synthetic", input: {} }]),
    message("user", "results", "call-b", ["a", "b"].map(id => ({ type: "tool_result", tool_use_id: id, content: "Done" }))),
    message("assistant", "reply", "results", "Newest reply")];
  const complete = [source[0], source[1], { ...source[3], parentUuid: "summary" }, ...source.slice(4)];
  const without = [source[0], source[1], { ...source.at(-1), parentUuid: "summary" }];
  for (const expected of [complete, without]) {
    const budgetBytes = bytes(lines(expected)), result = sliceClaudeTranscript(lines(source), { budgetBytes });
    assert.deepEqual(inspect(result, budgetBytes), expected);
    assert.equal(result.meta.droppedUnpairedTools, 0);
  }
});

test("boundary and sidechain filtering remove unpaired tool blocks while preserving accompanying text", () => {
  const call = id => ({ type: "tool_use", id, name: "Synthetic", input: {} });
  const result = id => ({ type: "tool_result", tool_use_id: id, content: "Done" });
  const source = [message("assistant", "old-call", null, [call("old")]), boundary(), summary(),
    message("user", "old-result", "summary", [result("old"), { type: "text", text: "Keep this text" }]),
    message("assistant", "side-call", "old-result", [call("side")], { isSidechain: true }),
    message("user", "side-result", "side-call", [result("side")]),
    message("assistant", "main-call", "side-result", [call("side-result-only")]),
    message("user", "only-side-result", "main-call", [result("side-result-only")], { isSidechain: true }),
    message("assistant", "mixed", "main-call", [call("missing"), { type: "text", text: "Keep this answer" }])];
  const sliced = sliceClaudeTranscript(lines(source)), parsed = inspect(sliced);
  assert.deepEqual(parsed.map(entry => entry.uuid), ["boundary", "summary", "old-result", "mixed"]);
  assert.deepEqual(parsed[2].message.content, [{ type: "text", text: "Keep this text" }]);
  assert.deepEqual(parsed[3].message.content, [{ type: "text", text: "Keep this answer" }]);
  assert.equal(sliced.meta.droppedUnpairedTools, 4);
});

test("a parentless newest entry exactly matching the budget survives an older oversized entry", () => {
  const newest = { type: "user", message: { content: "Newest" } };
  const source = [{ type: "user", message: { content: "x".repeat(1000) } }, newest];
  const budgetBytes = bytes(lines([newest])), result = sliceClaudeTranscript(lines(source), { budgetBytes });
  assert.deepEqual(result.lines, lines([newest]));
  assert.equal(result.meta.slicedBytes, budgetBytes);
  assert.equal(result.meta.tailCapped, true);
});

test("oversized UUIDs stay in source content but never amplify repaired child links", () => {
  const oversized = "u".repeat(16 * 1024);
  const root = { type: "user", uuid: oversized, parentUuid: null, message: { content: "Root" } };
  const children = Array.from({ length: 128 }, (_value, index) => ({ type: "user", parentUuid: "missing", message: { content: `Child ${index}` } }));
  const source = [root, ...children], budgetBytes = 32 * 1024;
  const result = sliceClaudeTranscript(lines(source), { budgetBytes }), parsed = result.lines.map(JSON.parse);
  assert.equal(result.meta.tailCapped, false);
  assert.equal(result.meta.droppedEntries, 0);
  assert.ok(result.meta.slicedBytes <= result.meta.sourceBytes);
  assert.deepEqual(parsed[0], root);
  assert.ok(parsed.slice(1).every(entry => entry.parentUuid === null));
  const invalidParent = sliceClaudeTranscript(lines([message("user", "root", null, "Root"), message("user", "child", oversized, "Child")]));
  assert.equal(JSON.parse(invalidParent.lines[1]).parentUuid, "root");
});

test("serialization stops at its first over-budget repaired line", () => {
  const source = [{ type: "user", uuid: "root", parentUuid: null, message: { content: "Root" } },
    ...Array.from({ length: 100 }, () => ({ type: "user", parentUuid: "missing", message: { content: "x".repeat(100) } }))];
  const input = lines(source), originalStringify = JSON.stringify;
  let repairedLines = 0, result;
  JSON.stringify = function (value, ...args) {
    if (value?.type === "user" && value.parentUuid === "root") repairedLines++;
    return originalStringify(value, ...args);
  };
  try { result = sliceClaudeTranscript(input, { budgetBytes: 200 }); }
  finally { JSON.stringify = originalStringify; }
  assert.equal(repairedLines, 1, "the remaining repaired lines must not be materialised");
  assert.equal(result.meta.tailCapped, true);
  assert.ok(result.meta.slicedBytes <= 200);
  assert.equal(result.lines.length, 1);
});

test("identical UUID replays collapse to their first occurrence without self-links or cycles", () => {
  const first = message("user", "a", null, "Root"), second = message("assistant", "b", "a", "Answer");
  const reordered = Object.fromEntries(Object.entries(first).reverse());
  for (const source of [[first, first], [first, second, reordered]]) {
    const result = sliceClaudeTranscript(lines(source)), parsed = inspect(result);
    assert.deepEqual(parsed, source.length === 2 ? [first] : [first, second]);
    assert.equal(result.meta.droppedEntries, 1);
  }
});

test("conflicting UUID entries retain their content without targeting themselves or later entries", () => {
  const source = [message("user", "a", null, "First version"), message("assistant", "b", "a", "Answer"),
    message("user", "a", "b", "Second version"), message("assistant", "c", "a", "Newest")];
  const parsed = sliceClaudeTranscript(lines(source)).lines.map(JSON.parse), seen = new Set();
  assert.deepEqual(parsed.map(entry => entry.message), source.map(entry => entry.message));
  assert.equal(parsed.length, 4);
  for (const entry of parsed) {
    assert.notEqual(entry.parentUuid, entry.uuid);
    assert.ok(entry.parentUuid === null || seen.has(entry.parentUuid));
    assert.notEqual(entry.parentUuid, "a", "ambiguous UUIDs cannot be link targets");
    seen.add(entry.uuid);
  }
});

test("tail cap resolves branches and allows differently sized UUIDs while staying byte bounded", () => {
  const root = boundary("a-very-long-compact-boundary-uuid"), head = summary(root.uuid);
  head.uuid = "a-very-long-summary-uuid";
  const source = [root, head, message("assistant", "a", head.uuid, "x".repeat(4000)),
    row("attachment", "b", "a"), message("user", "c", "b", "Recent one"),
    message("assistant", "d", "b", "Recent sibling")];
  const budgetBytes = bytes(lines([root, head, { ...source[4], parentUuid: head.uuid }, { ...source[5], parentUuid: head.uuid }]));
  const parsed = inspect(sliceClaudeTranscript(lines(source), { budgetBytes }), budgetBytes);
  assert.deepEqual(parsed.map(entry => entry.uuid), [root.uuid, head.uuid, "c", "d"]);
  assert.equal(parsed.at(-1).parentUuid, head.uuid);
});

test("without compaction the newest entries that fit are kept and an oversized text entry is not rewritten", () => {
  const source = [message("user", "old", null, "x".repeat(4000)), message("assistant", "middle", "old", "Recent"),
    message("user", "new", "middle", "Newest")];
  const expected = [{ ...source[1], parentUuid: null }, source[2]], budgetBytes = bytes(lines(expected)) + 20;
  const result = sliceClaudeTranscript(lines(source), { budgetBytes });
  assert.deepEqual(inspect(result, budgetBytes), expected);
  assert.equal(result.meta.fromCompactBoundary, false);
  assert.equal(result.meta.tailCapped, true);
});

test("a recent entry that fits only after rooting its parent is still retained", () => {
  const source = [message("user", "a-very-long-previous-uuid", null, "x".repeat(4000)),
    message("assistant", "latest", "a-very-long-previous-uuid", "Recent")];
  const expected = [{ ...source[1], parentUuid: null }], budgetBytes = bytes(lines(expected));
  assert.deepEqual(inspect(sliceClaudeTranscript(lines(source), { budgetBytes }), budgetBytes), expected);
});

test("pinning a summary does not reorder conversational system entries before it", () => {
  const info = row("system", "info", "boundary", { subtype: "informational", content: "Status" });
  const source = [boundary(), info, summary("info"), message("user", "old", "summary", "x".repeat(4000)),
    message("assistant", "latest", "old", "Recent")];
  const expected = [source[0], info, source[2], { ...source.at(-1), parentUuid: "summary" }];
  const budgetBytes = bytes(lines(expected));
  assert.deepEqual(inspect(sliceClaudeTranscript(lines(source), { budgetBytes }), budgetBytes), expected);
});

test("the default 2 MiB budget caps a long conversational tail and keeps the newest entry", () => {
  const source = [boundary(), summary()];
  for (let i = 0; i < 6000; i++) source.push(message("user", `turn-${String(i).padStart(30, "0")}`,
    source.at(-1).uuid, "x".repeat(1024)));
  const result = sliceClaudeTranscript(lines(source)), parsed = inspect(result);
  assert.equal(result.meta.tailCapped, true);
  assert.equal(result.meta.fromCompactBoundary, true);
  assert.equal(parsed[1].uuid, "summary");
  assert.equal(parsed.at(-1).uuid, source.at(-1).uuid);
  assert.ok(result.meta.sourceBytes > 2 * 1024 * 1024);
  assert.ok(result.meta.slicedBytes > 1.9 * 1024 * 1024);
});

test("a short uncompacted session is unchanged apart from non-conversational entries", () => {
  const conversation = [message("user", "user", null, "Question"), message("assistant", "assistant", "user", "Answer")];
  const result = sliceClaudeTranscript(lines([row("custom-title", "title", null), ...conversation]));
  assert.deepEqual(result.lines, lines(conversation));
  assert.deepEqual(inspect(result), conversation);
  assert.equal(result.meta.droppedEntries, 1);
  assert.equal(result.meta.fromCompactBoundary, false);
  assert.equal(result.meta.tailCapped, false);
});

test("raw JSONL input accounts for CRLF and a missing final newline", () => {
  const source = lines([message("user", "u", null, "界"), message("assistant", "a", "u", "Answer")]).join("\r\n");
  const result = sliceClaudeTranscript(source);
  inspect(result);
  assert.equal(result.meta.sourceBytes, Buffer.byteLength(source));
});

test("invalid JSON, invalid budgets, and a compact summary that cannot fit fail explicitly", () => {
  for (const value of [0, -1, NaN, 1.5, Infinity]) {
    assert.throws(() => sliceClaudeTranscript([], { budgetBytes: value }), /positive integer/);
    assert.throws(() => sliceClaudeTranscript([], { toolResultMaxBytes: value }), /positive integer/);
  }
  assert.throws(() => sliceClaudeTranscript(['{"type":']), /Invalid Claude transcript JSON at line 1/);
  assert.throws(() => sliceClaudeTranscript(["null"]), /Invalid Claude transcript entry/);
  assert.throws(() => sliceClaudeTranscript(lines([boundary(), summary()]), { budgetBytes: 100 }), /boundary and summary.*CODEX_COMPANION_FORK_BUDGET_BYTES/);
  assert.throws(() => sliceClaudeTranscript(lines([message("user", "u", null, "Text")]), { budgetBytes: 10 }), /No Claude conversation entry fits/);
});

function snapshotFixture() {
  const home = makeTempDir("fork-slice-"), project = path.join(home, ".claude", "projects", "synthetic");
  fs.mkdirSync(project, { recursive: true });
  const sourcePath = path.join(project, "synthetic-session.jsonl");
  const source = lines([boundary(), row("attachment", "attachment", "boundary"), summary("attachment")]).join("\n") + "\n";
  fs.writeFileSync(sourcePath, source);
  return { home, project, sourcePath, source, env: { HOME: home } };
}

test("snapshot hashes original bytes, preserves basename and permissions, and observes only the opened length", () => {
  const f = snapshotFixture(), originalRead = fs.readSync;
  let appended = false, snapshot;
  fs.readSync = (...args) => {
    if (!appended) {
      appended = true;
      fs.appendFileSync(f.sourcePath, JSON.stringify(message("user", "later", "summary", "Later append")) + "\n");
    }
    return originalRead(...args);
  };
  try {
    snapshot = snapshotClaudeSession(f.home, f.sourcePath, f.env);
    assert.equal(snapshot.sourceSha256, createHash("sha256").update(f.source).digest("hex"));
    assert.equal(snapshot.forkSlice.sourceBytes, Buffer.byteLength(f.source));
    const staged = fs.readFileSync(snapshot.snapshotPath, "utf8");
    assert.equal(snapshot.forkSlice.slicedBytes, Buffer.byteLength(staged));
    assert.ok(!staged.includes("Later append"));
    assert.ok(fs.statSync(f.sourcePath).size > snapshot.forkSlice.sourceBytes);
    assert.equal(path.basename(snapshot.snapshotPath), path.basename(f.sourcePath));
    assert.equal(fs.statSync(snapshot.snapshotPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(snapshot.snapshotPath)).mode & 0o777, 0o700);
  } finally {
    fs.readSync = originalRead;
    snapshot?.cleanup();
    fs.rmSync(f.home, { recursive: true, force: true });
  }
});

test("snapshot refuses truncation during reading and invalid limits without leaving a staged directory", () => {
  const f = snapshotFixture(), originalRead = fs.readSync;
  try {
    for (const key of ["CODEX_COMPANION_IMPORT_MAX_BYTES", "CODEX_COMPANION_FORK_BUDGET_BYTES"]) {
      assert.throws(() => snapshotClaudeSession(f.home, f.sourcePath, { ...f.env, [key]: "0" }), /positive integer/);
    }
    fs.readSync = () => 0;
    assert.throws(() => snapshotClaudeSession(f.home, f.sourcePath, f.env), /changed while taking its snapshot/);
    assert.deepEqual(fs.readdirSync(path.dirname(f.project)), ["synthetic"]);
  } finally {
    fs.readSync = originalRead;
    fs.rmSync(f.home, { recursive: true, force: true });
  }
});
