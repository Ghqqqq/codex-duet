import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { makeTempDir } from "./helpers.mjs";

const reader = new URL("../plugins/codex/scripts/lib/fs.mjs", import.meta.url).href;
const source = `
  import fs from "node:fs";
  import { readStdinIfPiped } from ${JSON.stringify(reader)};
  const [mode, cap] = process.argv.slice(1);
  if (mode === "blocking") process.stdin._handle.setBlocking(true);
  if (mode === "closed") fs.closeSync(0);
  if (mode === "tty") Object.defineProperty(process.stdin, "isTTY", { value: true });
  if (["EINTR", "EWOULDBLOCK"].includes(mode)) {
    const read = fs.readSync;
    fs.readSync = (...args) => {
      fs.readSync = read;
      throw Object.assign(new Error("interrupted read"), { code: mode });
    };
  }
  try { console.log(JSON.stringify(readStdinIfPiped({ maxBytes: cap === undefined ? Infinity : Number(cap) }))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
`;

test("stdin reads files and interrupted pipes, treats closed or TTY input as empty, and enforces byte caps", t => {
  const dir = makeTempDir("stdin-reader-"), file = path.join(dir, "input");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true })); fs.writeFileSync(file, "字🙂\n");
  const read = (mode, input = "", cap, stdio) => spawnSync(process.execPath, ["--input-type=module", "-e", source, mode, ...(cap === undefined ? [] : [String(cap)])], {
    input: stdio ? undefined : input, stdio, encoding: "utf8", timeout: 10000
  });
  const fd = fs.openSync(file, "r");
  try { const result = read("file", "", undefined, [fd, "pipe", "pipe"]); assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout), "字🙂\n"); }
  finally { fs.closeSync(fd); }
  for (const [mode, input, expected] of [["blocking", "字🙂\n", "字🙂\n"], ["EINTR", "retry", "retry"], ["EWOULDBLOCK", "retry", "retry"], ["closed", "", ""], ["tty", "unused", ""]]) {
    const result = read(mode, input); assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout), expected);
  }
  assert.equal(JSON.parse(read("pipe", "字", 3).stdout), "字");
  assert.equal(read("pipe", "字", 2).status, 1);
});

test("hook stdin completes without EOF, bounds incomplete input and removes its listeners", () => {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { PassThrough } from "node:stream";
    import { readHookInput } from ${JSON.stringify(reader)};
    const input = () => { const stream = new PassThrough(); Object.defineProperty(process, "stdin", { configurable: true, value: stream }); return stream; };
    const stream = input(), text = JSON.stringify({ text: "字🙂" }), pending = readHookInput(), bytes = Buffer.from(text);
    stream.write(bytes.subarray(0, 9)); stream.write(bytes.subarray(9));
    assert.equal(await pending, text);
    assert.equal(stream.readableEnded, false);
    for (const event of ["data", "end", "error"]) assert.equal(stream.listenerCount(event), 0);
    assert.equal(stream.isPaused(), true);
    const incomplete = input(), timeout = readHookInput({ timeoutMs: 25 }); incomplete.write("{");
    assert.equal(await timeout, "{"); assert.equal(incomplete.listenerCount("data"), 0);
    const ended = input(), eof = readHookInput(); ended.end(); assert.equal(await eof, "");
    const capped = input(), oversized = readHookInput({ maxBytes: 4 }); capped.write('"字"');
    await assert.rejects(oversized, /Stdin exceeds the 4-byte limit/);
  `], { encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
});
