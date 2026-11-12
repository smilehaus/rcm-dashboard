#!/usr/bin/env node
/**
 * Safety net for a laptop that still publishes with `git stash pop`.
 * If a JSON file on master contains conflict markers, keep the side with
 * the newer `generated` timestamp when both sides parse, otherwise restore
 * the parent version of that file. Then commit the repair.
 *
 * Exits 0 when there is nothing to repair.
 */
import { execFileSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { findConflictMarkers, parseDashboardJson } from "./lib/json-guard.mjs";
import { publishFiles } from "./lib/git-publish.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

function splitConflict(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let mode = "keep";
  const ours = [];
  const theirs = [];
  for (const line of lines) {
    if (/^<{7}( |$)/.test(line)) { mode = "ours"; continue; }
    if (/^={7}$/.test(line)) { mode = "theirs"; continue; }
    if (/^>{7}( |$)/.test(line)) { mode = "keep"; continue; }
    if (mode === "ours") ours.push(line);
    else if (mode === "theirs") theirs.push(line);
    else out.push(line);
  }
  return { prefix: out, ours, theirs };
}

function chooseSide(text) {
  const { prefix, ours, theirs } = splitConflict(text);
  const candidates = [ours, theirs].map(side => [...prefix.slice(0, 1), ...side, ...prefix.slice(1)].join("\n"));
  // Reconstruct by substituting each side into the original skeleton once.
  const skeletonOurs = text
    .replace(/^<{7}.*\n/m, "")
    .replace(/^={7}\n[\s\S]*?^>{7}.*\n/m, "");
  const skeletonTheirs = text
    .replace(/^<{7}[\s\S]*?^={7}\n/m, "")
    .replace(/^>{7}.*\n/m, "");
  const parsed = [];
  for (const candidate of [skeletonOurs, skeletonTheirs]) {
    try {
      parsed.push({ text: candidate.endsWith("\n") ? candidate : candidate + "\n", data: parseDashboardJson(candidate, "side") });
    } catch { /* side still broken */ }
  }
  if (!parsed.length) return null;
  parsed.sort((a, b) => String(b.data.generated || "").localeCompare(String(a.data.generated || "")));
  return JSON.stringify(parsed[0].data, null, 2) + "\n";
}

const files = git(["ls-files", "*.json"]).trim().split("\n").filter(Boolean);
const repairs = {};
for (const rel of files) {
  const text = readFileSync(join(root, rel), "utf8");
  if (!findConflictMarkers(text).length) continue;
  let fixed = chooseSide(text);
  if (!fixed) {
    try {
      fixed = git(["show", `HEAD~1:${rel}`]);
      parseDashboardJson(fixed, rel);
    } catch {
      console.error(`Could not repair ${rel}`);
      process.exit(1);
    }
  }
  repairs[rel] = fixed.endsWith("\n") ? fixed : fixed + "\n";
  console.log(`repair ${rel}`);
}

if (!Object.keys(repairs).length) {
  console.log("No conflict markers to repair.");
  process.exit(0);
}

publishFiles({
  cwd: root,
  message: "fix: reject committed JSON conflict markers",
  paths: Object.keys(repairs),
  stage(dir) {
    for (const [rel, text] of Object.entries(repairs)) writeFileSync(join(dir, rel), text);
  }
});
