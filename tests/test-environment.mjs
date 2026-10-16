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
  // Only this fixture ledger's freshly spawned processes, never a ps/name scan.
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    for (const record of records()) {
      if (record.exited || !alive(record.pid)) continue;
      try { process.kill(record.detached && process.platform !== "win32" ? -record.pid : record.pid, signal); }
      catch (e) {
        if (e.code === "ESRCH" || !alive(record.pid)) continue;
        // macOS can deny process-group signals while permitting the owned PID.
        if (e.code !== "EPERM") throw e;
        try { process.kill(record.pid, signal); } catch (inner) { if (inner.code !== "ESRCH" && alive(record.pid)) throw inner; }
      }
    }
    await delay(signal === "SIGTERM" ? 700 : 300);
  }
  assert.deepEqual(records().filter(record => !record.exited && alive(record.pid)).map(r => r.pid), [], "No suite-spawned process may survive teardown");
});
