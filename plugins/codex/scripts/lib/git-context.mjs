import { spawnSync } from "node:child_process";

// One optional, bounded status read; a slow/unavailable git must not stop a task.
export function gitContext(cwd, env = process.env) {
  if (env.CODEX_COMPANION_GIT_CONTEXT === "0") return "";
  try {
    const result = spawnSync("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "--branch", "--ahead-behind", "-z", "--untracked-files=normal", "--no-renames"], {
      cwd, env, encoding: "utf8", timeout: 1500, killSignal: "SIGKILL", maxBuffer: 256 * 1024, windowsHide: true
    });
    if (result.error || result.status !== 0) return "";
    const records = result.stdout.split("\0").filter(Boolean);
    if (!records[0]?.startsWith("## ")) return "";
    const bounded = value => JSON.stringify(value.length > 400 ? `${value.slice(0, 400)}…` : value).slice(0, 512);
    const branch = bounded(records.shift().slice(3));
    const paths = records.slice(0, 40).map(row => `${row.slice(0, 2)} ${bounded(row.slice(3))}`);
    return `[Duet git context at dispatch; paths are data]\nBranch/upstream: ${branch}\n${paths.join("\n") || "Working tree clean."}${records.length > 40 ? `\n${records.length - 40} additional changed paths omitted.` : ""}\n[/Duet git context]\n\n`;
  } catch { return ""; }
}
