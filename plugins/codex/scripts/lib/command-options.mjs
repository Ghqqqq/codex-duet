// Public parser definitions are also the permission hook's source of option
// names and types. Internal values are companion-only; other policy exclusions
// belong in the hook.
export const COMMAND_ALIASES = { C: "cwd" };
export const COMMAND_OPTIONS = {
  // Host-hook only; the permission hook's public verb allowlist excludes it.
  "reserve-name": { valueOptions: [], internalValueOptions: ["session-cwd", "preferred"], booleanOptions: [] },
  task: {
    valueOptions: ["model", "effort", "cwd", "name", "prompt-file", "thread", "to", "continue", "run", "source", "sandbox", "lease-sec", "question-timeout-sec", "owner", "timeout-sec", "feed-limit"],
    // Companion-only values: the permission hook does not auto-approve these.
    internalValueOptions: ["session-cwd", "dispatch-nonce", "tool-use-id", "agent-name"],
    repeatableOptions: ["approve-browser-origin", "approve-computer-app"],
    booleanOptions: ["json", "report", "write", "resume-last", "resume", "fresh", "fork", "background", "detached", "follow", "direct", "quiet", "fast", "normal", "no-claude-md"],
    aliasMap: { m: "model" }
  },
  answer: {
    valueOptions: ["cwd", "question", "owner", "timeout-sec"],
    internalValueOptions: ["tool-use-id"],
    booleanOptions: ["json", "direct", "quiet"]
  },
  wait: {
    valueOptions: ["cwd", "timeout-sec", "min-interval-sec", "owner", "after-question", "feed-limit"],
    internalValueOptions: ["tool-use-id"],
    booleanOptions: ["json", "report", "direct", "quiet", "details"]
  },
  result: {
    valueOptions: ["cwd", "thread"],
    booleanOptions: ["json", "report", "details"]
  },
  status: {
    valueOptions: ["cwd", "thread", "timeout-ms", "poll-interval-ms", "owner"],
    internalValueOptions: ["dispatch-nonce"],
    booleanOptions: ["json", "all", "wait"]
  },
  cancel: { valueOptions: ["cwd"], booleanOptions: ["json"] }
};

// The duet launcher implies direct mode for these verbs.
export const DIRECT_OPTION_CONFLICTS = {
  task: ["follow", "detached", "background", "json", "feed-limit", "min-interval-sec"],
  answer: ["json"],
  wait: ["json", "feed-limit", "min-interval-sec"]
};
