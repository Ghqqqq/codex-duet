import "./test-environment.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { makeTempDir } from "./helpers.mjs";
import { sliceClaudeTranscript, snapshotClaudeSession, parseClaudeTranscript } from "../plugins/codex/scripts/lib/claude-session-transfer.mjs";

import { fullReport } from "../plugins/codex/scripts/lib/job-runtime.mjs";

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

test("fork slices retain the latest compact summary, filter private entries and trim tool payloads", () => {
  const output = "界".repeat(6000), image = { type: "image", source: { type: "base64", data: "A".repeat(18000) } };
  const source = lines([
    boundary("old"), message("user", "old-turn", "old", "Old context"), boundary(),
    row("attachment", "attachment", "boundary"), summary("attachment"),
    message("assistant", "thinking", "summary", [{ type: "thinking", thinking: "private" }]),
    message("assistant", "call", "thinking", [{ type: "redacted_thinking", data: "private" }, { type: "tool_use", id: "tool", name: "Synthetic", input: {} }]),
    message("user", "result", "call", [{ type: "tool_result", tool_use_id: "tool", content: output }, image], { toolUseResult: { stdout: output } }),
    { ...boundary("side"), isSidechain: true }
  ]);
  const original = [...source], result = sliceClaudeTranscript(source), parsed = inspect(result);
  assert.equal(parseClaudeTranscript(source.join("\n")).length, source.length);
  assert.equal(result.meta.droppedEntries, source.length - result.lines.length);
  assert.deepEqual(fullReport({}, { request: { forkSlice: result.meta } }).forkSlice, result.meta);
  assert.deepEqual(source, original);
  assert.deepEqual(parsed.map(entry => entry.uuid), ["boundary", "summary", "call", "result"]);
  assert.deepEqual(parsed[0], boundary());
  assert.equal(parsed[1].isCompactSummary, true);
  assert.equal(parsed[2].message.content.length, 1);
  assert.equal(parsed[3].message.content[0].tool_use_id, "tool");
  assert.equal(result.meta.trimmedToolResults, 2);
  assert.equal(result.meta.trimmedImages, 1);
  assert.doesNotMatch(result.lines.join("\n"), /private|AAAAAAAAAA/);
  assert.ok(!result.lines.join("\n").includes(output));
  const small = { type: "tool_result", tool_use_id: "small", content: "Unchanged" };
  const nested = sliceClaudeTranscript(lines([
    message("assistant", "call", null, ["image", "small"].map(id => ({ type: "tool_use", id, name: "Synthetic", input: {} }))),
    message("user", "result", "call", [{ type: "tool_result", tool_use_id: "image", content: [image] }, small])
  ]));
  assert.equal(nested.meta.trimmedImages, 1);
  assert.deepEqual(inspect(nested)[1].message.content[1], small);
  assert.doesNotMatch(nested.lines.join("\n"), /AAAAAAAAAA/);
});

test("fork ancestry repair handles discarded branches, forward references, cycles and replayed identities", () => {
  const root = message("user", "root", null, "Root"), answer = message("assistant", "answer", "root", "Answer");
  const cases = [
    { source: [root, answer, row("attachment", "bridge", "root"), message("user", "child", "bridge", "Child")], parents: [null, "root", "root"] },
    { source: [root, row("attachment", "bridge", "future"), message("user", "early", "bridge", "Early"),
      message("assistant", "future", "root", "Future"), message("user", "late", "bridge", "Late")], parents: [null, "root", "root", "future"] },
    { source: [root, row("attachment", "a", "b"), row("attachment", "b", "a"), message("user", "child", "a", "Child"),
      message("user", "orphan", "missing", "Orphan")], parents: [null, "root", "child"] },
    { source: [root, answer, Object.fromEntries(Object.entries(root).reverse())], parents: [null, "root"] }
  ];
  for (const { source, parents } of cases) {
    assert.deepEqual(inspect(sliceClaudeTranscript(lines(source))).map(entry => entry.parentUuid), parents);
  }
  const conflict = [root, answer, message("user", "root", "answer", "Changed root"), message("assistant", "latest", "root", "Newest")];
  const parsed = sliceClaudeTranscript(lines(conflict)).lines.map(JSON.parse), seen = new Set();
  assert.deepEqual(parsed.map(entry => entry.message), conflict.map(entry => entry.message));
  for (const entry of parsed) {
    assert.ok(entry.parentUuid === null || seen.has(entry.parentUuid));
    assert.notEqual(entry.parentUuid, entry.uuid);
    assert.notEqual(entry.parentUuid, "root");
    seen.add(entry.uuid);
  }
  const oversized = "u".repeat(16 * 1024), hugeRoot = { ...root, uuid: oversized };
  const repaired = sliceClaudeTranscript(lines([hugeRoot, ...Array.from({ length: 16 }, () => ({ type: "user", parentUuid: "missing", message: { content: "Child" } }))]));
  assert.ok(repaired.meta.slicedBytes <= repaired.meta.sourceBytes);
  assert.ok(repaired.lines.slice(1).map(JSON.parse).every(entry => entry.parentUuid === null));
  const shared = [boundary(), summary()];
  for (let i = 0; i < 128; i++) shared.push(row("attachment", `attachment-${i}`, i ? `attachment-${i - 1}` : "summary"));
  for (let i = 0; i < 128; i++) shared.push(message("user", `sibling-${i}`, "attachment-127", "Sibling"));
  const capped = inspect(sliceClaudeTranscript(lines(shared), { budgetBytes: 2048 }), 2048);
  assert.equal(capped.at(-1).uuid, "sibling-127");
  assert.ok(capped.slice(2).every(entry => entry.parentUuid === "summary"));
});

test("fork byte caps keep newest context and complete tool exchanges, never orphan blocks", () => {
  const call = id => ({ type: "tool_use", id, name: "Synthetic", input: {} });
  const result = id => ({ type: "tool_result", tool_use_id: id, content: "Done" });
  const source = [boundary(), summary(), message("user", "old", "summary", "x".repeat(5000)),
    message("assistant", "a", "old", [call("a")]), message("assistant", "b", "a", [call("b")]),
    message("user", "results", "b", [result("a"), result("b")]), message("assistant", "reply", "results", "Newest")];
  for (const expected of [
    [source[0], source[1], { ...source[3], parentUuid: "summary" }, ...source.slice(4)],
    [source[0], source[1], { ...source.at(-1), parentUuid: "summary" }]
  ]) {
    const budgetBytes = bytes(lines(expected)), sliced = sliceClaudeTranscript(lines(source), { budgetBytes });
    assert.deepEqual(inspect(sliced, budgetBytes), expected);
    assert.equal(sliced.meta.tailCapped, true);
  }
  const oversized = [boundary(), summary(), message("assistant", "write", "summary", [{ ...call("write"), input: { content: "x".repeat(2 * 1024 * 1024) } }]),
    message("user", "result", "write", [result("write")]), message("assistant", "reply", "result", "Newest")];
  assert.deepEqual(inspect(sliceClaudeTranscript(lines(oversized))).map(entry => entry.uuid), ["boundary", "summary", "reply"]);
  const unpaired = [message("assistant", "old", null, [call("old")]), boundary(), summary(),
    message("user", "mixed", "summary", [result("old"), { type: "text", text: "Keep" }]),
    message("assistant", "side", "mixed", [call("side")], { isSidechain: true }), message("user", "orphan", "side", [result("side")])];
  const filtered = inspect(sliceClaudeTranscript(lines(unpaired)));
  assert.deepEqual(filtered.map(entry => entry.uuid), ["boundary", "summary", "mixed"]);
  assert.deepEqual(filtered.at(-1).message.content, [{ type: "text", text: "Keep" }]);
  const latest = message("assistant", "latest", "a-very-long-previous-uuid", "Recent");
  const expected = [{ ...latest, parentUuid: null }], budgetBytes = bytes(lines(expected));
  assert.deepEqual(inspect(sliceClaudeTranscript(lines([message("user", "a-very-long-previous-uuid", null, "x".repeat(4000)), latest]), { budgetBytes }), budgetBytes), expected);
  const parentless = { type: "user", message: { content: "Newest" } }, budget = bytes(lines([parentless]));
  assert.deepEqual(sliceClaudeTranscript(lines([{ ...parentless, message: { content: "x".repeat(1000) } }, parentless]), { budgetBytes: budget }).lines, lines([parentless]));
  const info = row("system", "info", "boundary", { subtype: "informational", content: "Status" });
  const ordered = [boundary(), info, summary("info"), message("user", "old", "summary", "x".repeat(4000)), message("assistant", "latest", "old", "Recent")];
  const pinned = [ordered[0], info, ordered[2], { ...ordered.at(-1), parentUuid: "summary" }], cap = bytes(lines(pinned));
  assert.deepEqual(inspect(sliceClaudeTranscript(lines(ordered), { budgetBytes: cap }), cap), pinned);
  const raw = lines([message("user", "u", null, "界"), message("assistant", "a", "u", "Answer")]).join("\r\n");
  assert.equal(sliceClaudeTranscript(raw).meta.sourceBytes, Buffer.byteLength(raw));
  for (const [input, options] of [[['{"type":'], {}], [["null"], {}], [[], { budgetBytes: 0 }], [lines([boundary(), summary()]), { budgetBytes: 100 }]]) {
    assert.throws(() => sliceClaudeTranscript(input, options));
  }
});

test("fork snapshots preserve source identity and private staging, ignore later appends and clean up failed reads", t => {
  const home = makeTempDir("fork-slice-"), project = path.join(home, ".claude", "projects", "synthetic");
  fs.mkdirSync(project, { recursive: true });
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const sourcePath = path.join(project, "synthetic-session.jsonl"), source = lines([boundary(), summary()]).join("\n") + "\n";
  fs.writeFileSync(sourcePath, source);
  const read = fs.readSync; let appended = false;
  t.mock.method(fs, "readSync", (...args) => {
    if (!appended) { appended = true; fs.appendFileSync(sourcePath, lines([message("user", "later", "summary", "Later append")])[0] + "\n"); }
    return read(...args);
  });
  const snapshot = snapshotClaudeSession(home, sourcePath, { HOME: home });
  t.mock.restoreAll();
  try {
    assert.equal(snapshot.sourceSha256, createHash("sha256").update(source).digest("hex"));
    assert.equal(snapshot.forkSlice.sourceBytes, Buffer.byteLength(source));
    assert.doesNotMatch(fs.readFileSync(snapshot.snapshotPath, "utf8"), /Later append/);
    assert.equal(path.basename(snapshot.snapshotPath), path.basename(sourcePath));
    assert.equal(fs.statSync(snapshot.snapshotPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(snapshot.snapshotPath)).mode & 0o777, 0o700);
  } finally { snapshot.cleanup(); }
  for (const key of ["CODEX_COMPANION_IMPORT_MAX_BYTES", "CODEX_COMPANION_FORK_BUDGET_BYTES"]) {
    assert.throws(() => snapshotClaudeSession(home, sourcePath, { HOME: home, [key]: "0" }));
  }
  t.mock.method(fs, "readSync", () => 0);
  assert.throws(() => snapshotClaudeSession(home, sourcePath, { HOME: home }), /changed while taking its snapshot/);
  t.mock.restoreAll();
  assert.deepEqual(fs.readdirSync(path.dirname(project)), ["synthetic"]);
});
