// A failed transport probe says nothing about the account's login state.
export function classifyRuntimeError(error) {
  const detail = error instanceof Error ? error.message : String(error);
  const signature = `${error?.code ?? ""} ${detail}`;
  if (/timed?\s*out|timeout|ETIMEDOUT/i.test(signature)) return { status: "unreachable", reason: "timeout", detail };
  if (/sandbox|EPERM|EACCES|operation not permitted|permission denied/i.test(signature)) return { status: "unreachable", reason: "sandbox-or-permission", detail };
  if (/socket|ECONNREFUSED|ECONNRESET|EPIPE|connection closed|connection reset/i.test(signature)) return { status: "unreachable", reason: "socket", detail };
  if (/network|ENETUNREACH|EHOSTUNREACH|ENOTFOUND|EAI_AGAIN|DNS|fetch failed|connection failed|TLS/i.test(signature)) return { status: "unreachable", reason: "network", detail };
  if (/unauthenticated|not authenticated|not logged in|authentication (?:expired|failed|required)|invalid (?:access |refresh )?token|\b401\b/i.test(signature)) return { status: "unauthenticated", reason: "authentication", detail };
  return { status: "unknown", reason: "runtime-error", detail };
}

export const UNREACHABLE_GUIDANCE = "Codex authentication could not be checked. Rerun the companion with Bash dangerouslyDisableSandbox: true, or allow network access and local sockets, then rerun setup --json. Do not log in again for this transport failure.";
