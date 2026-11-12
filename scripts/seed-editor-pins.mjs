#!/usr/bin/env node
/**
 * Hash the current editors' existing check-in PINs and upload only the hashes.
 *
 * Roles come from the roster file (board-baseline.json). PINs come from a
 * backup file or from Firebase. The role on the PIN source is ignored, so an
 * old title cannot make someone an editor.
 *
 *   node scripts/seed-editor-pins.mjs --pins backups/2026-10-22_11-33.json --dry-run
 *   EDITOR_AUTH_URL=... EDITOR_ADMIN_SECRET=... node scripts/seed-editor-pins.mjs --pins backups/2026-10-22_11-33.json
 *   FIREBASE_DB_SECRET=... EDITOR_AUTH_URL=... EDITOR_ADMIN_SECRET=... node scripts/seed-editor-pins.mjs --firebase
 *
 * Prints names and roles only. Does not write a file.
 */
import { readFileSync } from "node:fs";
import { hashPin } from "../workers/editor-auth/src/pin-hash.js";
import { isEditorRole } from "../workers/editor-auth/src/policy.js";
import { planEditorSeeds, seedReport } from "./lib/editor-pin-seed.mjs";

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

function staffFrom(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.staff)) return data.staff;
  throw new Error("No staff list in that source");
}

async function loadPinStaff() {
  if (process.argv.includes("--firebase")) {
    const secret = process.env.FIREBASE_DB_SECRET || "";
    if (!secret) throw new Error("Set FIREBASE_DB_SECRET or pass --pins");
    const base = (process.env.FIREBASE_DB_URL || "https://smilehaus-rcm-default-rtdb.firebaseio.com").replace(/\/$/, "");
    let lastStatus = 0;
    for (const path of ["/board.json", "/state.json"]) {
      const response = await fetch(base + path + "?auth=" + encodeURIComponent(secret));
      lastStatus = response.status;
      if (!response.ok) continue;
      const data = await response.json();
      if (data && Array.isArray(data.staff) && data.staff.length) return data.staff;
    }
    throw new Error("Firebase did not return a staff list (" + lastStatus + ")");
  }
  const pinsPath = arg("--pins");
  if (!pinsPath) throw new Error("Pass --pins FILE or --firebase");
  return staffFrom(JSON.parse(readFileSync(pinsPath, "utf8")));
}

const rosterPath = arg("--roster") || "board-baseline.json";
const roster = JSON.parse(readFileSync(rosterPath, "utf8"));
const plan = planEditorSeeds(roster.staff, await loadPinStaff(), isEditorRole);
const report = seedReport(plan);
for (const row of report.ready) console.log("editor " + row.name + " (" + row.role + ")");
for (const row of report.missing) console.log("missing PIN for " + row.name + " (" + row.role + ")");
if (plan.missing.length || !plan.ready.length) process.exit(1);
if (process.argv.includes("--dry-run")) {
  console.log("dry run, nothing uploaded");
  process.exit(0);
}

const url = (process.env.EDITOR_AUTH_URL || "").replace(/\/$/, "");
const adminSecret = process.env.EDITOR_ADMIN_SECRET || "";
if (!url || !adminSecret) throw new Error("Set EDITOR_AUTH_URL and EDITOR_ADMIN_SECRET");
const records = [];
for (const row of plan.ready) {
  const hashed = await hashPin(row.pin);
  records.push({ staffId: row.id, role: row.role, hash: hashed.hash, salt: hashed.salt });
}
const response = await fetch(url + "/admin/seed", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: "Bearer " + adminSecret
  },
  body: JSON.stringify({ records })
});
if (!response.ok) {
  console.log("seed failed (" + response.status + ")");
  process.exit(1);
}
const result = await response.json().catch(() => ({}));
console.log("uploaded " + (result.count || records.length) + " hashed PINs");
