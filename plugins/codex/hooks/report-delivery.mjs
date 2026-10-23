// No Node globals/imports in a function-hook module. The read-only helper uses
// descriptor-level file checks and bounded reads unavailable in $.fs.
export function register(on) {
  let pending = Promise.resolve();
  on("prompt.submit", async ($, e, next) => {
    if (e.origin?.kind !== "task-notification") return next(e);
    // Serialize store check/set even when two notifications enter together.
    const deliver = async () => {
      try {
        const sessionId = await $.session.id();
        const root = $.plugin.root;
        const result = await $.process.run(["node", `${root}/scripts/lib/report-delivery.mjs`], {
          stdin: JSON.stringify({ text: e.text, sessionId }), timeoutMs: 5000
        });
        if (result.exitCode !== 0 || result.isStdoutTruncated) return e;
        const delivery = JSON.parse(result.stdout);
        if (!delivery || !/^[A-Za-z0-9_-]{1,128}$/.test(delivery.taskId) || typeof delivery.entry !== "string") return e;
        const context = e.context ?? [];
        if (!Array.isArray(context) || context.some(item => typeof item !== "string" || item.length > 100000)
            || !delivery.entry.length || delivery.entry.length > 100000
            || context.reduce((sum, item) => sum + item.length, delivery.entry.length) > 200000) return e;
        const key = `report-delivery:v1:${sessionId}:${delivery.taskId}`;
        if (await $.store.get(key)) return e;
        await $.store.set(key, true);
        return { ...e, context: [...context, delivery.entry] };
      } catch { return e; }
    };
    const current = pending.then(deliver, deliver);
    pending = current.then(() => undefined, () => undefined);
    return next(await current);
  });
}
