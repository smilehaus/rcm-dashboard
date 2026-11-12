export async function hashPin(pin, saltBytes) {
  const salt = saltBytes || crypto.getRandomValues(new Uint8Array(16));
  const data = new Uint8Array(salt.length + pin.length);
  data.set(salt, 0);
  data.set(new TextEncoder().encode(pin), salt.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return { salt: bytesToB64(salt), hash: bytesToB64(digest) };
}

export async function pinMatches(pin, record) {
  if (!record || !record.salt || !record.hash || typeof pin !== "string") return false;
  const salt = b64ToBytes(record.salt);
  const hashed = await hashPin(pin, salt);
  return timingSafeEqual(hashed.hash, record.hash);
}

function bytesToB64(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64ToBytes(text) {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function timingSafeEqual(a, b) {
  const left = String(a);
  const right = String(b);
  let diff = left.length ^ right.length;
  const n = Math.max(left.length, right.length);
  for (let i = 0; i < n; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}
