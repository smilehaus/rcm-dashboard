#!/usr/bin/env node
/**
 * Fail if any committed JSON file contains an email address or a filled-in
 * PIN / password / token field outside backups/. The plaintext files in
 * backups/ are the legacy snapshots. They stay until the
 * encrypt-historical-backups workflow replaces them with ciphertext.
 * Prints the path and the kind of hit only.
 *
 * Usage: node scripts/scan-sensitive-json.mjs
 */
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";
import { sensitiveHits } from "./lib/sensitive-json.mjs";

const root = new URL("..", import.meta.url).pathname;
const skipDirs = new Set(["node_modules", ".git", "backups"]);

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (skipDirs.has(name)) continue;
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(full, out);
    else if (name.endsWith(".json")) out.push(full);
  }
}

const files = [];
walk(root, files);
let failed = 0;
for (const full of files) {
  const label = relative(root, full) || full;
  let data;
  try {
    data = JSON.parse(readFileSync(full, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    continue;
  }
  const hits = sensitiveHits(data);
  if (hits.length) {
    console.error(`FAIL ${label}: ${hits.join(", ")}`);
    failed++;
  }
}
if (failed) {
  console.error(`\n${failed} JSON file(s) contain emails or PIN-like fields.`);
  process.exit(1);
}
console.log(`OK ${files.length} JSON file(s) have no emails or PIN-like fields`);
