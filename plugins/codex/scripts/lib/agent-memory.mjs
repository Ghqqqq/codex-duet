import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { resolveIsolatedCodexHome } from "./codex-home.mjs";
import { contextSetup } from "./setup-config.mjs";

const hash = value => createHash("sha256").update(value).digest("hex").slice(0, 24);
export function agentMemoryFile(workspace, role = "worker", env = process.env) {
  let canonical = path.resolve(workspace);
  try { canonical = fs.realpathSync(canonical); } catch { /* Retain the workspace key if unavailable. */ }
  return path.join(resolveIsolatedCodexHome(env), "duet", "agent-memory", hash(canonical), hash(role), "MEMORY.md");
}

export function prepareAgentMemory({ workspace, role = "worker" }, env = process.env) {
  if (contextSetup({ env }).agentMemory !== "on") return { text: "", agentMemory: { enabled: false } };
  try {
    const file = agentMemoryFile(workspace, role, env), home = resolveIsolatedCodexHome(env);
    let current = home;
    for (const part of path.relative(home, file).split(path.sep)) {
      current = path.join(current, part);
      const stat = fs.lstatSync(current, { throwIfNoEntry: false });
      if (stat?.isSymbolicLink() || (current === file && stat && (!stat.isFile() || stat.nlink > 1))) throw new Error("Unsafe agent memory path.");
    }
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    let content = "", bounded = false;
    if (fs.existsSync(file)) {
      const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink > 1) throw new Error("Unsafe agent memory file.");
        const buffer = Buffer.alloc(25 * 1024);
        const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
        const lines = buffer.subarray(0, count).toString("utf8").split("\n");
        bounded = fs.fstatSync(fd).size > count || lines.length > 200;
        content = lines.slice(0, 200).join("\n");
      } finally { fs.closeSync(fd); }
    }
    return { text: `\n\n### Fugato agent memory (${role})\nFugato-owned memory: ${file}\nUse this memory for this workspace and role. Update MEMORY.md only when the current sandbox already permits this path; do not widen the sandbox for memory. Keep durable notes concise.\n${content}${bounded ? "\n[Memory truncated to 200 lines / 25 KB.]" : ""}`,
      agentMemory: { enabled: true, path: file, role, bounded } };
  } catch { return { text: "", agentMemory: { enabled: true, unavailable: true } }; }
}
