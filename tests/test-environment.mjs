import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";
import assert from "node:assert/strict";

// Never inherit a runtime/home/data pointer, including baseline/archive tests.
// Short roots keep Unix socket paths below the platform length limit.
const root = fs.mkdtempSync(path.join(process.platform === "darwin" ? "/private/tmp" : os.tmpdir(), "dt-"));
for (const key of Object.keys(process.env)) {
  if (key.startsWith("CODEX_") || ["CLAUDE_PLUGIN_DATA", "CLAUDE_ENV_FILE"].includes(key)) delete process.env[key];
}
Object.assign(process.env, {
  CODEX_COMPANION_TEST_MODE: "1", CODEX_COMPANION_TEST_ROOT: root,
  CODEX_COMPANION_TEST_PROCESSES: path.join(root, "processes"),
  CODEX_COMPANION_HOME: path.join(root, "isolated"), CODEX_HOME: path.join(root, "normal"),
  CODEX_SQLITE_HOME: path.join(root, "normal"), CLAUDE_PLUGIN_DATA: path.join(root, "data"),
  HOME: path.join(root, "home"), USERPROFILE: path.join(root, "home"),
  TMPDIR: root, TMP: root, TEMP: root,
  GIT_CONFIG_GLOBAL: path.join(root, "home", ".gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
  CODEX_COMPANION_BROKER_IDLE_SEC: "2"
});
fs.mkdirSync(process.env.HOME, { recursive: true });
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { if (e.code === "ESRCH") return false; throw e; } };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
after(async () => {
  const directory = process.env.CODEX_COMPANION_TEST_PROCESSES;
  const records = () => fs.existsSync(directory) ? fs.readdirSync(directory).filter(n => n.endsWith(".json")).map(n => JSON.parse(fs.readFileSync(path.join(directory, n)))) : [];
  const survivors = () => records().filter(record => !record.exited && alive(record.pid));
  // Signal only ledger-owned PIDs. Poll process disappearance and include any
  // children published during shutdown; never assume they exit after a sleep.
  for (const [signal, ceiling] of [["SIGTERM", 1000], ["SIGKILL", 60000]]) {
    const deadline = Date.now() + ceiling;
    do {
      const pending = survivors();
      if (!pending.length) return;
      for (const record of pending) {
        try { process.kill(record.detached && process.platform !== "win32" ? -record.pid : record.pid, signal); }
        catch (error) {
          if (error.code === "ESRCH" || !alive(record.pid)) continue;
          if (error.code !== "EPERM") throw error;
          try { process.kill(record.pid, signal); }
          catch (inner) { if (inner.code !== "ESRCH" && alive(record.pid)) throw inner; }
        }
      }
      await delay(25);
    } while (Date.now() < deadline);
  }
  assert.deepEqual(survivors().map(record => record.pid), [], "No suite-spawned process may survive teardown");
});
