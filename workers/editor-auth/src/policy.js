/** Editor titles. Match the role text, not a person's name. */
export function isEditorRole(role) {
  const text = String(role || "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!text) return false;
  if (text.includes("office manager")) return true;
  if (text.includes("operations manager") || text.includes("ops manager")) return true;
  if (text.includes("rcm manager") || text.includes("reach manager")) return true;
  if (text === "executive" || text.includes("executive")) return true;
  return false;
}

const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;

export function registerFailure(prev, now) {
  const state = prev && prev.lockUntil > now
    ? prev
    : { fails: prev && prev.lockUntil ? 0 : (prev?.fails || 0), lockUntil: 0 };
  if (state.lockUntil > now) return { locked: true, state };
  const fails = state.fails + 1;
  if (fails >= MAX_FAILS) return { locked: true, state: { fails, lockUntil: now + LOCK_MS } };
  return { locked: false, state: { fails, lockUntil: 0 } };
}

export function isLocked(prev, now) {
  return !!(prev && prev.lockUntil > now);
}
