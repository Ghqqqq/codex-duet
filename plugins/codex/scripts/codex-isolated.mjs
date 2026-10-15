#!/usr/bin/env node
import { spawn } from "node:child_process";
import { isolatedCodexArgs, isolatedCodexEnv, resolveCodexBinary } from "./lib/codex-home.mjs";

try {
  const args = process.argv.slice(2);
  const sourceEnv = { ...process.env };
  if (args[0] === "--home") {
    if (!args[1]) throw new Error("--home requires an absolute directory.");
    sourceEnv.CODEX_COMPANION_HOME = args[1];
    args.splice(0, 2);
  }
  const env = isolatedCodexEnv(sourceEnv);
  const child = spawn(resolveCodexBinary(env), isolatedCodexArgs(args, env), { env, stdio: "inherit" });
  child.on("error", error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
  child.on("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
