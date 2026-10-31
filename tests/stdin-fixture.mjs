import { spawnOwned } from "../plugins/codex/scripts/lib/process.mjs";

// Wait for a sync EAGAIN or the start of an async read before producing bytes.
// This avoids guessing how long the consumer takes to start up.
const preload = `
  import fs from "node:fs";
  void process.stdin;
  let notified = false;
  const notify = () => {
    if (!notified) { notified = true; fs.writeSync(3, "waiting\\n"); }
  };
  const read = process.stdin._read;
  process.stdin._read = function(...args) { notify(); return read.apply(this, args); };
  for (const name of ["readSync", "readFileSync"]) {
    const original = fs[name];
    fs[name] = function(fd, ...args) {
      try { return original.call(this, fd, ...args); }
      catch (error) {
        if (fd === 0 && !notified && ["EAGAIN", "EWOULDBLOCK"].includes(error.code)) {
          notify();
        }
        throw error;
      }
    };
  }
`;

export function runWithDelayedStdin(script, args, input, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnOwned("/bin/sh", ["-c", '/bin/cat | "$@"', "stdin-pipe",
      process.execPath, "--import", `data:text/javascript,${encodeURIComponent(preload)}`, script, ...args], {
      ...options, detached: true, stdio: ["pipe", "pipe", "pipe", "pipe"]
    });
    let stdout = "", stderr = "", waited = false;
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ }
      reject(new Error("Delayed stdin consumer did not finish within 60 seconds."));
    }, 60000);
    child.stdout.setEncoding("utf8").on("data", text => { stdout += text; });
    child.stderr.setEncoding("utf8").on("data", text => { stderr += text; });
    child.stdin.on("error", () => { /* An early consumer exit is asserted by the caller. */ });
    child.stdio[3].once("data", () => {
      waited = true;
      child.stdin.end(input);
    });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr, waited });
    });
  });
}

// Keep the producer open until the consumer exits (or explicitly delay EOF).
// Completion while inputEnded is false proves the hook did not wait for EOF.
export function runWithRetainedStdin(script, args, input, { endAfterMs, ...options } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnOwned(process.execPath, [script, ...args], {
      ...options, detached: true, stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "", stderr = "", inputEnded = false, timedOut = false;
    child.stdout.setEncoding("utf8").on("data", text => { stdout += text; });
    child.stderr.setEncoding("utf8").on("data", text => { stderr += text; });
    child.stdin.on("error", () => { /* An early consumer exit is asserted by the caller. */ });
    child.stdin.write(input);
    const endTimer = endAfterMs === undefined ? null : setTimeout(() => {
      inputEnded = true;
      child.stdin.end();
    }, endAfterMs);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        else process.kill(-child.pid, "SIGKILL");
      } catch { /* already exited */ }
    }, 10000);
    child.once("error", error => { clearTimeout(timer); clearTimeout(endTimer); reject(error); });
    child.once("close", (status, signal) => {
      clearTimeout(timer); clearTimeout(endTimer);
      resolve({ status, signal, stdout, stderr, inputEnded, timedOut });
    });
  });
}
