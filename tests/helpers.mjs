import "./test-environment.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import net from "node:net";
import { spawnSync } from "node:child_process";

export function makeTempDir(prefix = "codex-plugin-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Skip only a demonstrated OS capability restriction. Once sockets work, a
// missing broker is a failure, never a reason to skip the assertions.
let socketCapability;
export async function requireLocalSockets(t) {
  socketCapability ??= (async () => {
    const dir = makeTempDir("cx-socket-");
    const endpoint = process.platform === "win32"
      ? `\\\\.\\pipe\\codex-test-${process.pid}` : path.join(dir, "s");
    const server = net.createServer();
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(endpoint, resolve);
      });
      return null;
    } catch (error) {
      if (!["EPERM", "EACCES"].includes(error.code)) throw error;
      return `Local socket bind denied (${error.code}); rerun outside the sandbox.`;
    } finally {
      if (server.listening) await new Promise(resolve => server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  })();
  const reason = await socketCapability;
  if (reason) t.skip(reason);
  return !reason;
}

export function writeExecutable(filePath, source) {
  fs.writeFileSync(filePath, source, { encoding: "utf8", mode: 0o755 });
}

export function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    shell: options.shell ?? (process.platform === "win32" && !path.isAbsolute(command)),
    windowsHide: true
  });
}

export function initGitRepo(cwd) {
  run("git", ["init", "-b", "main"], { cwd });
  run("git", ["config", "user.name", "Codex Plugin Tests"], { cwd });
  run("git", ["config", "user.email", "tests@example.com"], { cwd });
  run("git", ["config", "commit.gpgsign", "false"], { cwd });
  run("git", ["config", "tag.gpgsign", "false"], { cwd });
}
