/**
 * Detect staff emails and PIN-like fields in committed JSON.
 * Reports the file and the kind of hit, never the value.
 */

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const SECRET_KEYS = new Set([
  "pin",
  "password",
  "passwd",
  "secret",
  "client_secret",
  "access_token",
  "refresh_token",
  "authorization",
]);

function isFilled(value) {
  if (value == null || value === false) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number") return true;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return false;
}

export function sensitiveHits(data) {
  const hits = new Set();
  function walk(value) {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (!value || typeof value !== "object") {
      if (typeof value === "string" && EMAIL.test(value)) hits.add("email");
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (SECRET_KEYS.has(String(key).toLowerCase()) && isFilled(child)) {
        hits.add("secret-key:" + key);
      }
      if (typeof child === "string" && EMAIL.test(child)) hits.add("email");
      else walk(child);
    }
  }
  walk(data);
  return [...hits];
}
