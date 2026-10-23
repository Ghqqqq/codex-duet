// Function hooks have no Node globals. Only the bounded instruction inventory
// crosses stdin to the host helper; conversation blocks/messages never do.
// prompt.context has no agent attribution in 2.1.302. Only the session's first
// context may capture instructions; later main/subagent contexts are ignored.
// CLAUDE.md edits therefore apply from the next Claude session. An incomplete
// first capture leaves no snapshot and dispatch uses the approximate fallback.
export function instructionInventory(files) {
  const entries = [], omittedPaths = [];
  let complete = Array.isArray(files), omittedCount = 0, size = 0, stopped = false;
  for (const file of files ?? []) {
    if (file.kind === "memory") continue;
    if (typeof file.path !== "string" || file.path.length > 4096 ||
        typeof file.content !== "string" || !["managed", "user", "project", "local"].includes(file.kind) ||
        (file.parent != null && (typeof file.parent !== "string" || file.parent.length > 4096))) {
      complete = false;
      continue;
    }
    const entry = { path: file.path, tier: file.kind, text: file.content, importer: file.parent ?? null };
    const length = JSON.stringify(entry).length;
    if (stopped || entries.length >= 256 || size + length > 1000000) {
      complete = false; stopped = true; omittedCount++;
      if (omittedPaths.length < 256) omittedPaths.push(file.path);
    } else { entries.push(entry); size += length; }
  }
  return { entries, complete, inventoryAvailable: Array.isArray(files), omittedPaths, omittedCount };
}

export const register = on => {
  let claiming = Promise.resolve();
  const keyFor = sessionId => `claude-memory:first-context:v1:${sessionId}`;
  on("prompt.context", async ($, e, next) => {
    let sessionId, capture = false;
    const claim = async () => {
      try {
        sessionId = await $.session.id();
        const key = keyFor(sessionId);
        if (await $.store.get(key)) return;
        // Remember the attempt even if the inventory is incomplete or capture
        // fails. Persist before next(e), which may start another context.
        await $.store.set(key, true);
        capture = true;
      } catch { /* Without the first-context claim, do not capture. */ }
    };
    const claimed = claiming.then(claim, claim);
    claiming = claimed.then(() => undefined, () => undefined);
    await claimed;
    const result = await next(e);
    if (!capture) return result;
    try {
      if (await $.env.get("CODEX_COMPANION_CLAUDE_MD") === "0") return result;
      // A downstream rewrite without an inventory is no more authoritative
      // than an upstream rewrite (which arrives with instructionFiles absent).
      const block = value => JSON.stringify(value.blocks.filter(item => item.name === "claudeMd"));
      const files = result.instructionFiles ?? (block(e) === block(result) ? e.instructionFiles : undefined);
      const inventory = instructionInventory(files);
      if (result.instructionFiles && JSON.stringify(result.instructionFiles) !== JSON.stringify(e.instructionFiles)) inventory.complete = false;
      const payload = { sessionId, cwd: await $.session.cwd(), ...inventory };
      await $.process.run(["node", `${$.plugin.root}/scripts/lib/claude-memory.mjs`, "capture"], {
        stdin: JSON.stringify(payload), timeoutMs: 5000
      });
    } catch { /* Capture is optional: dispatch reports its approximate fallback. */ }
    return result;
  });
  on("classic.SessionEnd", async ($, e, next) => {
    try { await $.store.delete(keyFor(e.session_id)); } catch { /* Best-effort marker cleanup. */ }
    return next(e);
  });
};
