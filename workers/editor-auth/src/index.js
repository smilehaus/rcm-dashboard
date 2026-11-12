import { isEditorRole, isLocked, registerFailure } from "./policy.js";
import { hashPin, pinMatches } from "./pin-hash.js";
import { signCustomToken } from "./custom-token.js";

const ALLOWED_ORIGINS = new Set([
  "https://smilehaus.github.io",
  "http://127.0.0.1:8080",
  "http://localhost:8080"
]);

function cors(request) {
  const origin = request.headers.get("Origin") || "";
  const allow = ALLOWED_ORIGINS.has(origin) || /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin);
  const headers = {
    "Access-Control-Allow-Origin": allow ? origin : "https://smilehaus.github.io",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json",
    "Cache-Control": "no-store"
  };
  return headers;
}

function json(request, status, body) {
  return new Response(JSON.stringify(body), { status, headers: cors(request) });
}

async function readJson(request) {
  try { return await request.json(); } catch { return null; }
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(request) });
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/session") return session(request, env);
    if (request.method === "POST" && url.pathname === "/admin/pin") return setPin(request, env);
    return json(request, 404, { error: "not_found" });
  }
};

async function session(request, env) {
  const body = await readJson(request);
  const staffId = body && typeof body.staffId === "string" ? body.staffId.trim() : "";
  const pin = body && typeof body.pin === "string" ? body.pin : "";
  if (!staffId || !pin) return json(request, 401, { error: "denied" });

  const lockKey = "lock:" + staffId;
  const lock = await readState(env, lockKey);
  if (isLocked(lock, Date.now())) return json(request, 429, { error: "locked" });

  const record = await readState(env, "pin:" + staffId);
  const ok = await pinMatches(pin, record);
  const allowed = ok && record && (record.editor === true || isEditorRole(record.role));
  if (!allowed) {
    const next = registerFailure(lock, Date.now());
    await env.PINS.put(lockKey, JSON.stringify(next.state));
    return json(request, next.locked ? 429 : 401, { error: next.locked ? "locked" : "denied" });
  }
  await env.PINS.delete(lockKey);
  let account;
  try { account = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT); } catch { return json(request, 500, { error: "unavailable" }); }
  const token = await signCustomToken(account, staffId);
  return json(request, 200, { token, role: record.role || "Editor" });
}

async function setPin(request, env) {
  const expected = env.EDITOR_ADMIN_SECRET || "";
  const header = request.headers.get("Authorization") || "";
  if (!expected || header !== "Bearer " + expected) return json(request, 401, { error: "denied" });
  const body = await readJson(request);
  const staffId = body && typeof body.staffId === "string" ? body.staffId.trim() : "";
  const pin = body && typeof body.pin === "string" ? body.pin.trim() : "";
  const role = body && typeof body.role === "string" ? body.role.trim() : "";
  if (!staffId || pin.length < 4 || pin.length > 12) return json(request, 400, { error: "bad_request" });
  if (!(body.editor === true || isEditorRole(role))) return json(request, 400, { error: "not_editor_role" });
  const hashed = await hashPin(pin);
  await env.PINS.put("pin:" + staffId, JSON.stringify({
    hash: hashed.hash,
    salt: hashed.salt,
    role,
    editor: true
  }));
  return json(request, 200, { ok: true });
}

async function readState(env, key) {
  const raw = await env.PINS.get(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
