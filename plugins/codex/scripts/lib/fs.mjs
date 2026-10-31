import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as scheduleTimeout, clearTimeout as cancelTimeout } from "node:timers";

export function ensureAbsolutePath(cwd, maybePath) {
  return path.isAbsolute(maybePath) ? maybePath : path.resolve(cwd, maybePath);
}

export function createTempDir(prefix = "codex-plugin-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function writeJsonFile(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function safeReadFile(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
}

export function isProbablyText(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  for (const value of sample) {
    if (value === 0) {
      return false;
    }
  }
  return true;
}

const stdinRetryWait = new Int32Array(new SharedArrayBuffer(4));

function validateStdinByteLimit(maxBytes) {
  if (maxBytes !== Infinity && (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) {
    throw new RangeError("Stdin byte limit must be a non-negative safe integer.");
  }
}

export function readStdinIfPiped({ maxBytes = Infinity } = {}) {
  validateStdinByteLimit(maxBytes);
  if (process.stdin.isTTY) {
    return "";
  }
  const buffer = Buffer.allocUnsafe(64 * 1024), chunks = [];
  let length = 0;
  for (;;) {
    let bytesRead;
    try {
      bytesRead = fs.readSync(0, buffer, 0, Math.min(buffer.length, maxBytes - length + 1), null);
    } catch (error) {
      if (error.code === "EINTR") continue;
      if (["EAGAIN", "EWOULDBLOCK"].includes(error.code)) {
        // Initializing process.stdin can make a pipe non-blocking. Wait for
        // its producer instead of treating a temporary lack of bytes as EOF.
        Atomics.wait(stdinRetryWait, 0, 0, 1);
        continue;
      }
      if (error.code === "EBADF") break; // Closed stdin is empty input.
      throw error;
    }
    if (bytesRead === 0) break;
    length += bytesRead;
    if (length > maxBytes) throw new RangeError(`Stdin exceeds the ${maxBytes}-byte limit.`);
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
  }
  // Decode once so a UTF-8 character split across reads remains intact.
  return Buffer.concat(chunks, length).toString("utf8");
}

// Hooks receive one JSON value. Unlike CLI briefs, they must not depend on the
// host closing stdin, and incomplete/invalid input must leave time to exit.
export async function readHookInput({ timeoutMs = 2000, maxBytes = Infinity } = {}) {
  validateStdinByteLimit(maxBytes);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
    throw new RangeError("Hook stdin timeout must be a non-negative safe integer.");
  }
  const stdin = process.stdin;
  if (stdin.isTTY || stdin.readableEnded) return "";
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder("utf8");
    let raw = "", length = 0, first;
    const finish = error => {
      cancelTimeout(timer);
      stdin.pause();
      stdin.unref?.(); // A retained host pipe must not keep the hook alive.
      stdin.removeListener("data", onData);
      stdin.removeListener("end", onEnd);
      stdin.removeListener("error", onError);
      if (error) reject(error);
      else resolve(raw + decoder.end());
    };
    const onEnd = () => finish();
    const onError = error => finish(error.code === "EBADF" ? undefined : error);
    const onData = chunk => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += bytes.length;
      if (length > maxBytes) {
        finish(new RangeError(`Stdin exceeds the ${maxBytes}-byte limit.`));
        return;
      }
      const text = decoder.write(bytes), trimmed = text.trim();
      raw += text;
      first ??= trimmed[0];
      if (!trimmed) return;
      const last = trimmed.at(-1);
      // Avoid repeatedly parsing a large unfinished container/string when the
      // latest chunk cannot possibly close it. Scalars still parse each chunk.
      if ((first === "{" && last !== "}") || (first === "[" && last !== "]") || (first === '"' && last !== '"')) return;
      try { JSON.parse(raw); } catch { return; }
      finish();
    };
    const timer = scheduleTimeout(onEnd, timeoutMs);
    stdin.once("end", onEnd);
    stdin.once("error", onError);
    stdin.on("data", onData);
  });
}
