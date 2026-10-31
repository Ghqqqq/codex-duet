// Shared by human renderers, the native display and activity (which keeps CR in JSON projections).
export function cleanDisplayText(value, { preserveCarriageReturn = false } = {}) {
  return String(value ?? "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\r/g, preserveCarriageReturn ? "\r" : " ");
}
