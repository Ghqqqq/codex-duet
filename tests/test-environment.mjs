// Test processes never inherit a user's Codex runtime, broker, state or homes.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-fixture-home-"));
for (const key of Object.keys(process.env)) {
  if (key.startsWith("CODEX_") || ["CLAUDE_PLUGIN_DATA", "CLAUDE_ENV_FILE"].includes(key)) delete process.env[key];
}
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.GIT_CONFIG_GLOBAL = path.join(home, ".gitconfig");
process.env.GIT_CONFIG_NOSYSTEM = "1";
