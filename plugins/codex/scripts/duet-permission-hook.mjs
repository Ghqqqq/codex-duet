#!/usr/bin/env node
// Deliberately small shell grammar, never a shell/eval. PATH is reconstructed
// from the hook environment with this plugin's bin appended (Claude 2.1.302).
// Rewrite to the quoted absolute launcher without scanning shell snapshots.
// Residual risk: even that path can name a shell function, but anyone able to
// plant functions in the user's shell initialisation can already run arbitrary
// commands. Scanning caused silent loss of report attachment on harmless aliases,
// helper text and stale/missing snapshots.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { COMMAND_ALIASES, COMMAND_OPTIONS, DIRECT_OPTION_CONFLICTS } from "./lib/command-options.mjs";
import { SANDBOX_MODES } from "./lib/setup-config.mjs";

const launcher = fileURLToPath(new URL("../bin/duet", import.meta.url));
const quote = value => `'${value.replace(/'/g, `'"'"'`)}'`;
const safeId = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const target = value => /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(value);
// Allow the companion's options by default, except permission grants, the legacy
// --write permission override, non-stdin briefs, and options incompatible with
// the launcher's implicit direct mode. Session/help are handled globally by the
// companion, outside its per-verb parsers.
const excluded = new Set(["write", "prompt-file", "approve-browser-origin", "approve-computer-app"]);
const schemas = Object.fromEntries(Object.entries(COMMAND_OPTIONS).map(([verb, options]) => {
  const allowed = name => !options.internalValueOptions?.includes(name) && !excluded.has(name) && !DIRECT_OPTION_CONFLICTS[verb]?.includes(name);
  return [verb, {
    boolean: new Set([...options.booleanOptions, "help"].filter(allowed)),
    value: new Set([...options.valueOptions, ...(options.repeatableOptions ?? []), "session"].filter(allowed)),
    aliases: { ...COMMAND_ALIASES, ...options.aliasMap, h: "help" }
  }];
}));

export function trustedLauncher(env = process.env, cwd = process.cwd()) {
  try {
    if (Object.keys(env).some(key => /^BASH_FUNC_duet(?:%%|\(\))$/.test(key))) return false;
    if (typeof env.PATH !== "string") return false;
    const expected = fs.realpathSync(launcher);
    for (const directory of [...env.PATH.split(path.delimiter), path.dirname(launcher)]) {
      const candidate = path.resolve(cwd, directory || ".", "duet");
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        if (!fs.statSync(candidate).isFile()) continue;
        return fs.realpathSync(candidate) === expected;
      } catch (error) {
        if (!["ENOENT", "ENOTDIR", "EACCES"].includes(error.code)) return false;
      }
    }
  } catch { /* Ambiguous resolution belongs to ordinary permissions. */ }
  return false;
}

export function approveDuet(input, env = process.env) {
  // PreToolUse runs even when no permission prompt is needed; allow paired with
  // updatedInput replaces the arguments in bypassPermissions too (2.1.302
  // PreToolUseResult; https://code.claude.com/docs/en/hooks#pretooluse-decision-control).
  if (input?.hook_event_name !== "PreToolUse" || input.tool_name !== "Bash"
      || !["default", "acceptEdits", "bypassPermissions", "dontAsk", "auto"].includes(input.permission_mode)
      || !safeId(input.session_id)) return {};
  // Claude's Bash sandbox must permit Duet's network and local sockets. Its
  // bypass flag is independent of the worker's validated --sandbox choice;
  // preserve it in updatedInput while still attaching the delivery binding.
  const command = input.tool_input?.command;
  if (typeof command !== "string" || /[\0\r]/.test(command)) return {};
  const newline = command.indexOf("\n");
  const first = newline < 0 ? command : command.slice(0, newline);
  const heredoc = /[ \t]+<<'([A-Z][A-Z0-9_]{2,31})'$/.exec(first);
  const header = heredoc ? first.slice(0, heredoc.index) : first;
  let resolved;
  try {
    resolved = fs.realpathSync(launcher);
    fs.accessSync(resolved, fs.constants.X_OK);
    if (!fs.statSync(resolved).isFile()) return {};
  } catch { return {}; }
  // Only these exact launcher spellings are allowed. The quoted form also
  // works when the plugin path has shell syntax.
  const executable = ["duet", quote(resolved), ...(/^[A-Za-z0-9_./:=,@%+-]+$/.test(resolved) ? [resolved] : [])]
    .find(value => header.startsWith(value) && /^[ \t]$/.test(header[value.length] ?? ""));
  if (!executable) return {};
  const argumentsHeader = header.slice(executable.length).replace(/^[ \t]+/, "");
  // Recognize our own fully quoted absolute rewrite on a repeated hook call.
  if (!/^(?:task|answer|wait|result|status|cancel)(?=[ \t]|$)/.test(argumentsHeader)
      && !(executable !== "duet" && /^'(?:task|answer|wait|result|status|cancel)'(?=[ \t]|$)/.test(argumentsHeader))) return {};
  if (heredoc) {
    if (newline < 0) return {};
    const lines = command.slice(newline + 1).split("\n");
    const end = lines.indexOf(heredoc[1]);
    if (end < 0 || !(end === lines.length - 1 || (end === lines.length - 2 && lines.at(-1) === ""))) return {};
  } else if (newline >= 0 && newline !== command.length - 1) return {};

  // Tokens cannot concatenate quoted and unquoted fragments. Quotes in the
  // header protect only this ASCII subset; heredoc stdin is entirely opaque.
  const tokens = [];
  let rest = argumentsHeader;
  while (rest) {
    const match = /^(?:([A-Za-z0-9_./:=,@%+-]+)|'([A-Za-z0-9_./:=,@%+ -]*)')(?:([ \t]+)|$)/.exec(rest);
    if (!match) return {};
    tokens.push(match[1] ?? match[2]);
    rest = rest.slice(match[0].length);
    if (!rest && match[3]) return {};
  }
  const [verb, ...args] = tokens;
  const schema = Object.hasOwn(schemas, verb ?? "") ? schemas[verb] : null;
  const delivers = ["task", "answer", "wait"].includes(verb);
  if (!schema || (heredoc && !["task", "answer"].includes(verb)) || (delivers && !safeId(input.tool_use_id))) return {};
  const flags = new Map(), positionals = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("-")) {
      if (!target(arg)) return {};
      positionals.push(arg);
      continue;
    }
    const option = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    const rawName = option ? option[1] : arg.slice(1);
    const name = Object.hasOwn(schema.aliases, rawName) ? schema.aliases[rawName] : rawName;
    if (!option && !Object.hasOwn(schema.aliases, rawName)) return {};
    if (name === "help" && !["--help", "-h"].includes(arg)) return {};
    const inlineValue = option?.[2];
    if (flags.has(name)) return {};
    if (schema.boolean.has(name)) {
      if (inlineValue !== undefined && !["true", "false"].includes(inlineValue)) return {};
      if (name === "direct" && inlineValue === "false") return {};
      flags.set(name, inlineValue !== "false");
    } else if (schema.value.has(name)) {
      const value = inlineValue ?? args[++i];
      if (!value || value.startsWith("-") || !value.trim()) return {};
      if (["to", "thread", "model", "continue"].includes(name) && !target(value)) return {};
      if (name === "session" && value !== input.session_id) return {};
      if (name === "effort" && !["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value)) return {};
      if (name === "sandbox" && !SANDBOX_MODES.includes(value)) return {};
      if (name === "timeout-sec" && (!/^\d+$/.test(value) || +value < 1 || +value > 3600)) return {};
      if (["lease-sec", "question-timeout-sec"].includes(name) && (!/^\d+$/.test(value) || +value < 1 || +value > 86400)) return {};
      flags.set(name, value);
    } else return {};
  }
  const needsTarget = ["answer", "wait", "cancel"].includes(verb) || (verb === "result" && !flags.has("thread"));
  if (positionals.length > (verb === "task" ? 0 : 1) || (needsTarget && !flags.has("help") && positionals.length !== 1)) return {};
  if ((flags.has("fast") && flags.has("normal")) || ["to", "thread", "fresh"].filter(key => flags.has(key)).length > 1) return {};
  if (flags.get("fork") && ["to", "thread", "continue", "resume", "resume-last"].some(key => flags.has(key))) return {};
  if (flags.has("source") && !flags.get("fork")) return {};
  if (flags.has("continue") && ["to", "thread", "fresh", "resume", "resume-last", "sandbox", "model", "effort", "fast", "normal"].some(key => flags.has(key))) return {};
  if (flags.has("help") && (heredoc || [...flags.keys()].some(key => !["help", "session", "cwd"].includes(key)))) return {};
  if (executable === "duet" && !trustedLauncher(env, input.cwd)) return {};
  // Re-emit validated words literally: unquoted arguments (including our own
  // bindings) can still expand through zsh global aliases or =command lookup.
  const binding = [...(flags.has("session") ? [] : ["--session", input.session_id]), ...(delivers ? ["--tool-use-id", input.tool_use_id] : [])];
  const rewritten = `${[resolved, ...tokens, ...binding].map(quote).join(" ")}${command.slice(header.length)}`;
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { ...input.tool_input, command: rewritten } } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  let result = {};
  try { result = approveDuet(JSON.parse(fs.readFileSync(0, "utf8"))); } catch { /* Abstain on malformed hook input. */ }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
