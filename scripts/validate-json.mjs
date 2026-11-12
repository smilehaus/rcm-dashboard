#!/usr/bin/env node
/**
 * Walk every JSON file in the repo and fail if any file is unreadable or
 * still contains git conflict markers. Known dashboard feeds also have to
 * match their schema. backups/ is ignored; those snapshots are not committed.
 *
 * Usage: node scripts/validate-json.mjs [files...]
 */
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";
import { findConflictMarkers, parseDashboardJson, assertPublishable, SCHEMAS } from "./lib/json-guard.mjs";

const root = new URL("..", import.meta.url).pathname;
const skipDirs = new Set(["node_modules", ".git", "backups"]);

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (skipDirs.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (name.endsWith(".json")) out.push(full);
  }
}

const args = process.argv.slice(2);
const files = [];
if (args.length) {
  for (const a of args) files.push(a);
} else {
  walk(root, files);
}

let failed = 0;
for (const full of files) {
  const label = relative(root, full) || full;
  let text;
  try {
    text = readFileSync(full, "utf8");
  } catch (err) {
    console.error(`FAIL ${label}: ${err.message}`);
    failed++;
    continue;
  }
  const markers = findConflictMarkers(text);
  if (markers.length) {
    console.error(`FAIL ${label}: git conflict markers on line ${markers.join(", ")}`);
    failed++;
    continue;
  }
  try {
    const base = label.split("/").pop();
    if (SCHEMAS[base]) assertPublishable(label, text);
    else parseDashboardJson(text, label);
  } catch (err) {
    console.error(`FAIL ${label}: ${err.message}`);
    failed++;
  }
}

if (failed) {
  console.error(`\n${failed} JSON file(s) failed validation.`);
  process.exit(1);
}
console.log(`OK ${files.length} JSON file(s)`);
