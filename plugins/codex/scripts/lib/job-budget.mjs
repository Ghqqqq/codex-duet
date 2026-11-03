// Token budgets are checked on each Codex usage update and can overshoot by
// one update. Wall time excludes queueing and the durable parent-question slot.
export const BUDGET_NOTE = "Wall time counts only while the Codex turn runs, excluding queued time and parent questions. Token budgets use this turn's total tokens and can overshoot by one usage update.";

export function budgetLimit(value, name, { allowOff = false } = {}) {
  if (allowOff && value === "off") return null;
  const number = Number(value);
  const valid = typeof value !== "boolean" && /^(?:\d+(?:\.\d+)?|\.\d+)$/.test(String(value)) &&
    Number.isFinite(number) && number > 0 && number <= Number.MAX_SAFE_INTEGER / (name.includes("minutes") ? 60000 : 1) &&
    (name.includes("minutes") || Number.isSafeInteger(number));
  if (!valid) throw new Error(`--${name} must be a positive ${name.includes("minutes") ? "number" : "integer"}${allowOff ? " or off" : ""}.`);
  return number;
}

export function newJobBudget(maxMinutes = null, maxTokens = null) {
  return { maxMinutes, maxTokens, consumedMs: 0, consumedTokens: 0, runningSince: null };
}

export const budgetEnabled = budget => budget?.maxMinutes != null || budget?.maxTokens != null;

/** @param {any} job @param {number} [now] @param {{ running?: boolean, tokens?: number }} [options] */
export function advanceBudget(job, now = Date.now(), { running, tokens } = {}) {
  if (!budgetEnabled(job.budget)) return job.budget;
  const budget = { ...job.budget };
  const active = !budget.exceeded && !job.cancelRequested && job.status === "running" && Boolean(job.turnId) && !job.pendingQuestion;
  if (budget.runningSince != null) budget.consumedMs += Math.max(0, now - budget.runningSince);
  budget.runningSince = (running ?? active) && !budget.exceeded && !job.cancelRequested ? now : null;
  if (tokens !== undefined) budget.consumedTokens = Math.max(budget.consumedTokens, tokens);
  if (!budget.exceeded && !job.cancelRequested) {
    const limit = budget.maxMinutes != null && budget.consumedMs >= budget.maxMinutes * 60000 ? "max_minutes"
      : budget.maxTokens != null && budget.consumedTokens >= budget.maxTokens ? "max_tokens" : null;
    if (limit) { budget.exceeded = limit; budget.runningSince = null; }
  }
  return budget;
}

export function budgetReason(reason) {
  const limit = /^budget_exceeded:(max_minutes|max_tokens)$/.exec(reason ?? "")?.[1];
  return limit ? { code: "budget_exceeded", limit } : null;
}
