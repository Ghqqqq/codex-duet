// No Node globals/imports in a function-hook module. The read-only helper uses
// descriptor-level file checks and bounded reads unavailable in $.fs.
const prefix = "report-delivery:v1:", retentionMs = 7 * 24 * 60 * 60 * 1000, sessionLimit = 2000;
// Within the 10 s hook budget, after this dispatch's own helper lookup.
const DUPLICATE_WAIT_MS = 3000;
async function prune($, sessionId, now, offset) {
  // Keep this session's dedupe history until SessionEnd, subject to its count
  // cap. Rotate bounded batches so fresh foreign markers cannot starve old ones.
  const keys = (await $.store.keys()).filter(key => key.startsWith(prefix) && !key.startsWith(`${prefix}${sessionId}:`));
  if (!keys.length) return 0;
  const count = Math.min(keys.length, 64);
  for (let i = 0; i < count; i++) {
    const key = keys[(offset + i) % keys.length];
    const timestamp = await $.store.get(key);
    if (timestamp === true || (typeof timestamp === "number" && timestamp < now - retentionMs)) await $.store.delete(key);
  }
  return (offset + count) % keys.length;
}

async function capSession($, sessionId) {
  // store.keys() is in insertion order. Markers are inserted once, on delivery,
  // so remove the oldest deliveries and leave room for the new one.
  const keys = (await $.store.keys()).filter(key => key.startsWith(`${prefix}${sessionId}:`));
  for (const key of keys.slice(0, Math.max(0, keys.length - sessionLimit + 1))) {
    try { await $.store.delete(key); } catch { /* Try the other keys too. */ }
  }
}

export function register(on) {
  let pending = Promise.resolve(), pruneOffset = 0;
  const inFlight = new Map(), unpersisted = new Set();
  // A SessionEnd that lands while a delivery is in next() must not have its
  // cleanup undone by that delivery's marker write.
  const sessionEnds = new Map();
  const serialize = work => {
    const current = pending.then(work, work);
    pending = current.then(() => undefined, () => undefined);
    return current;
  };
  on("prompt.submit", async ($, e, next) => {
    if (e.origin?.kind !== "task-notification") return next(e);
    let sessionId, key, delivery, context, own = null, endsAtStart = 0;
    try {
      sessionId = await $.session.id();
      endsAtStart = sessionEnds.get(sessionId) ?? 0;
      // Each dispatch owns its helper wait, which the host excludes from its
      // hook budget. Only the short marker operations share a queue.
      const result = await $.process.run(["node", `${$.plugin.root}/scripts/lib/report-delivery.mjs`], {
        stdin: JSON.stringify({ text: e.text, sessionId }), timeoutMs: 5000
      });
      if (result.exitCode !== 0 || result.isStdoutTruncated) return next(e);
      delivery = JSON.parse(result.stdout);
      if (!delivery || !/^[A-Za-z0-9_-]{1,128}$/.test(delivery.taskId) || typeof delivery.entry !== "string") return next(e);
      context = e.context ?? [];
      if (!Array.isArray(context) || context.some(item => typeof item !== "string" || item.length > 100000)
          || !delivery.entry.length || delivery.entry.length > 100000
          || context.reduce((sum, item) => sum + item.length, delivery.entry.length) > 200000) return next(e);
      key = `${prefix}${sessionId}:${delivery.taskId}`;
      // An overlapping copy waits, bounded, for the copy carrying the report.
      // It takes the report over only if that copy was dropped or failed.
      for (let attempt = 0; !own; attempt++) {
        const prior = await serialize(async () => {
          if (unpersisted.has(key) || await $.store.get(key)) return null;
          // Wrapped: an async callback returning the promise would await it here.
          if (inFlight.has(key)) return { settled: inFlight.get(key).settled };
          let settle;
          own = { settled: new Promise(resolve => { settle = resolve; }) };
          own.settle = settle;
          inFlight.set(key, own);
          return null;
        });
        if (!own && (!prior || attempt)) return next(e);
        if (prior) await Promise.race([prior.settled, $.clock.sleep(DUPLICATE_WAIT_MS)]);
      }
    } catch { return next(e); }
    try {
      const result = await next({ ...e, context: [...context, delivery.entry] });
      if (result && result.drop === undefined) {
        await serialize(async () => {
          if ((sessionEnds.get(sessionId) ?? 0) !== endsAtStart) return;
          // Retain dedupe in this module even if the post-delivery write fails.
          unpersisted.add(key);
          const keys = [...unpersisted].filter(item => item.startsWith(`${prefix}${sessionId}:`));
          for (const old of keys.slice(0, Math.max(0, keys.length - sessionLimit))) unpersisted.delete(old);
          try {
            const now = await $.clock.now();
            try { pruneOffset = await prune($, sessionId, now, pruneOffset); } catch { /* Best-effort age cleanup. */ }
            try { await capSession($, sessionId); } catch { /* Delivery has already entered. */ }
            await $.store.set(key, now);
            unpersisted.delete(key);
          } catch { /* An accepted prompt cannot be rolled back on store failure. */ }
        });
      }
      return result;
    } finally {
      if (inFlight.get(key) === own) inFlight.delete(key);
      own.settle();
    }
  });
  on("classic.SessionEnd", { hook_event_name: "SessionEnd" }, async ($, e, next) => {
    await serialize(async () => {
      const sessionPrefix = `${prefix}${e.session_id}:`, failed = [];
      sessionEnds.set(e.session_id, (sessionEnds.get(e.session_id) ?? 0) + 1);
      for (const key of unpersisted) if (key.startsWith(sessionPrefix)) unpersisted.delete(key);
      try {
        for (const key of await $.store.keys()) {
          if (!key.startsWith(sessionPrefix)) continue;
          try { await $.store.delete(key); } catch { failed.push(key); }
        }
      } catch { /* Best-effort marker enumeration. */ }
      // One bounded retry also recovers an isolated transient delete failure.
      for (const key of failed.slice(0, 64)) {
        try { await $.store.delete(key); } catch { /* Leave persistent failures for age cleanup. */ }
      }
    });
    return next(e);
  });
}
