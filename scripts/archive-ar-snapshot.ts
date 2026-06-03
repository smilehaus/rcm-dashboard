// archive-ar-snapshot.ts
// Snapshots the current per-office AR breakdown into a running history array
// inside ar-snapshot.json. Also writes ar-history-backup.json as a safety net.
//
// Slot model (auto-detected from current CT time):
//   hour < 16 CT  → PM slot, date = TODAY
//   hour >= 16 CT → AM slot, date = TOMORROW (banking-style overnight close)

import { readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const DRY_RUN = process.argv.includes("--dry-run");
const MAX_HISTORY_DAYS = Number.POSITIVE_INFINITY;

// Always auto-detect from current CT time — never use --slot= flag override.
function resolveSlot(): "AM" | "PM" {
  const ctHour = Number(new Date().toLocaleString("en-US", { timeZone: "America/Chicago", hour: "2-digit", hour12: false }).slice(0, 2));
  return ctHour >= 16 ? "AM" : "PM";
}
const SLOT = resolveSlot();

function resolveEntryDate(slot: "AM" | "PM"): string {
  const nowCT = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Chicago" }));
  if (slot === "AM") nowCT.setDate(nowCT.getDate() + 1);
  const y = nowCT.getFullYear();
  const m = String(nowCT.getMonth() + 1).padStart(2, "0");
  const d = String(nowCT.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function deepCopy<T>(x: T): T { return JSON.parse(JSON.stringify(x)); }

function pickOfficeFields(o: any) {
  if (!o) return null;
  return {
    outstanding: o.outstanding ? deepCopy(o.outstanding) : null,
    patients:    o.patients    ? deepCopy(o.patients)    : null,
    insurance:   o.insurance   ? deepCopy(o.insurance)   : null,
    unposted:    o.unposted ? {
      y2025: o.unposted.y2025 ?? null,
      y2026: o.unposted.y2026 ?? null,
      total: o.unposted.total ?? null,
      completedThisWeek2026:     o.unposted.completedThisWeek2026     ?? null,
      completedThisWeekStart:    o.unposted.completedThisWeekStart    ?? null,
      newTasksAddedThisWeek2026: o.unposted.newTasksAddedThisWeek2026 ?? null,
    } : null,
    legacy:      o.legacy ? deepCopy(o.legacy) : null,
  };
}

function ctNowFriendly(): string {
  return new Date().toLocaleString("en-US", {
    timeZone: "America/Chicago", month: "numeric", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit",
  }) + " CT";
}

function main() {
  console.log(`\n📚 Archiving AR snapshot per-office breakdown…`);
  const scriptDir    = dirname(fileURLToPath(import.meta.url));
  const dashboardDir = process.env.CI
    ? join(scriptDir, "..")
    : join(scriptDir, "..", "apps", "rcm-dashboard");
  const snapshotPath = join(dashboardDir, "ar-snapshot.json");
  const backupPath   = join(dashboardDir, "ar-history-backup.json");
  const data = JSON.parse(readFileSync(snapshotPath, "utf8").replace(/^﻿/, ""));

  const entryDate = resolveEntryDate(SLOT);
  const entry = {
    date: entryDate, slot: SLOT, asOf: ctNowFriendly(),
    generated: new Date().toISOString(),
    offices: {} as Record<string, ReturnType<typeof pickOfficeFields>>,
  };
  console.log(`  🕒 Slot: ${SLOT}  · business day: ${entryDate}  · captured: ${entry.asOf}`);

  let totalOfficesCaptured = 0;
  for (const [code, office] of Object.entries(data.offices || {})) {
    const picked = pickOfficeFields(office);
    entry.offices[code] = picked;
    if (picked && (picked.outstanding?.total != null || picked.unposted?.total != null)) totalOfficesCaptured++;
  }

  data.perOfficeHistory = Array.isArray(data.perOfficeHistory) ? data.perOfficeHistory : [];
  const idx = data.perOfficeHistory.findIndex((h: any) => h.date === entryDate && (h.slot || null) === SLOT);
  if (idx >= 0) { data.perOfficeHistory[idx] = entry; console.log(`  ↻ Replaced existing entry for ${entryDate} ${SLOT}`); }
  else           { data.perOfficeHistory.push(entry);  console.log(`  ＋ Appended entry for ${entryDate} ${SLOT}`); }

  const slotOrder: Record<string, number> = { AM: 0, PM: 1 };
  data.perOfficeHistory.sort((a: any, b: any) => {
    const d = (a.date || "").localeCompare(b.date || "");
    return d !== 0 ? d : (slotOrder[a.slot] ?? 2) - (slotOrder[b.slot] ?? 2);
  });
  if (Number.isFinite(MAX_HISTORY_DAYS)) data.perOfficeHistory = data.perOfficeHistory.slice(-MAX_HISTORY_DAYS);

  console.log(`  ✓ ${totalOfficesCaptured}/10 offices captured`);
  console.log(`  📚 History now contains ${data.perOfficeHistory.length} entries`);

  if (DRY_RUN) { console.log(`\nDRY RUN — skipping write.`); return; }

  writeFileSync(snapshotPath, JSON.stringify(data, null, 2));
  console.log(`  ✓ Wrote ar-snapshot.json`);

  // Safety-net standalone backup — ar-history-backup.json accumulates all history.
  try {
    let backupExisting: any = { perOfficeHistory: [] };
    try { backupExisting = JSON.parse(readFileSync(backupPath, "utf8")); } catch {}
    // Dedup key: (date, slot)
    const byKey = new Map<string, any>();
    for (const e of backupExisting.perOfficeHistory || []) if (e?.date) byKey.set(`${e.date}#${e.slot ?? ""}`, e);
    for (const e of data.perOfficeHistory || [])           if (e?.date) byKey.set(`${e.date}#${e.slot ?? ""}`, e);
    const merged = Array.from(byKey.values()).sort((a, b) => {
      const d = (a.date || "").localeCompare(b.date || "");
      return d !== 0 ? d : (slotOrder[a.slot] ?? 2) - (slotOrder[b.slot] ?? 2);
    });
    writeFileSync(backupPath, JSON.stringify({ updated: new Date().toISOString(), perOfficeHistory: merged }, null, 2));
    console.log(`  🛡  Wrote ar-history-backup.json (${merged.length} entries)`);
  } catch (err: any) {
    console.warn(`  ⚠ Backup file write failed: ${err.message ?? err}`);
  }

  // Git push — conflict-proof: save our data, hard-reset to remote, re-apply, commit+push.
  // Avoids merge conflict markers when two runs overlap (e.g. GitHub Actions + local rerun).
  try {
    console.log(`\n📤 Pushing to GitHub Pages...`);
    // Hold what we just wrote in memory before resetting
    const freshSnapshot = readFileSync(snapshotPath, "utf8");
    const freshBackup   = readFileSync(backupPath,   "utf8");
    // Sync to latest remote state (no stash needed — we'll re-apply below)
    execSync(`git fetch origin master`, { cwd: dashboardDir, stdio: "pipe" });
    execSync(`git reset --hard origin/master`, { cwd: dashboardDir, stdio: "pipe" });
    // Re-apply our freshly computed data on top (guaranteed conflict-free)
    writeFileSync(snapshotPath, freshSnapshot);
    writeFileSync(backupPath,   freshBackup);
    execSync(`git add ar-snapshot.json ar-history-backup.json`, { cwd: dashboardDir, stdio: "pipe" });
    execSync(`git commit -m "archive: AR snapshot ${entryDate} ${SLOT} (per-office history)"`, { cwd: dashboardDir, stdio: "pipe" });
    execSync(`git push origin master`, { cwd: dashboardDir, stdio: "pipe" });
    console.log(`✅ Pushed.`);
  } catch (err: any) {
    console.error(`⚠ Push failed: ${err.message?.slice(0, 300) ?? err}`);
  }
}

main();
