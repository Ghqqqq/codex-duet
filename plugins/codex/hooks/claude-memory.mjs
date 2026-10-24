// Function hooks have no Node globals. Only the bounded instruction inventory
// crosses stdin to the host helper; conversation blocks/messages never do.
// prompt.context has no agent attribution in 2.1.302. Only the session's first
// context may capture instructions; later main/subagent contexts are ignored.
// CLAUDE.md edits therefore apply from the next Claude session. An unknown or
// invalid inventory uses the fallback; a valid bounded inventory stays authoritative.
export function instructionInventory(files) {
  const entries = [], omittedPaths = [];
  let valid = Array.isArray(files), omittedCount = 0, size = 0, omittedSize = 0, stopped = false;
  for (const file of Array.isArray(files) ? files : []) {
    if (file?.kind === "memory") continue;
    if (!file || typeof file.path !== "string" ||
        typeof file.content !== "string" || !["managed", "user", "project", "local"].includes(file.kind) ||
        (file.parent != null && typeof file.parent !== "string")) {
      valid = false;
      continue;
    }
    const entry = { path: file.path, tier: file.kind, text: file.content, importer: file.parent ?? null };
    const length = JSON.stringify(entry).length;
    if (stopped || file.path.length > 4096 || file.parent?.length > 4096 || entries.length >= 256 || size + length > 1000000) {
      stopped = true; omittedCount++;
      const pathSize = JSON.stringify(file.path).length;
      if (file.path.length <= 4096 && omittedPaths.length < 256 && omittedSize + pathSize <= 1000000) {
        omittedPaths.push(file.path); omittedSize += pathSize;
      }
    } else { entries.push(entry); size += length; }
  }
  return { entries, complete: valid && !stopped, inventoryAvailable: valid, bounded: stopped, omittedPaths, omittedCount };
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
      // The host keeps explicit inventories in step with claudeMd. A valid
      // final list is authoritative, including files a downstream hook drops.
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
