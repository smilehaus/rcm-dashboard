// archive-ar-snapshot.ts
// Snapshots the current per-office AR breakdown into a running history array
// inside ar-snapshot.json. Also writes ar-history-backup.json as a safety net.
//
// Slot model (auto-detected from current CT time):
//   hour < 16 CT  → PM slot, date = TODAY
//   hour >= 16 CT → AM slot, date = TOMORROW (banking-style overnight close)

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { publishFiles } from "./lib/git-publish.mjs";
import { resolveDashboardRoot } from "./lib/dashboard-root.mjs";

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
  const dashboardDir = resolveDashboardRoot(import.meta.url);
  const data = JSON.parse(readFileSync(join(dashboardDir, "ar-snapshot.json"), "utf8").replace(/^\uFEFF/, ""));

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

  // Rebuild the history entry from origin's latest snapshot inside the publish
  // retry, so this commit only touches perOfficeHistory and cannot drop an
  // unposted or legacy update that landed while we were archiving.
  console.log(`\n📤 Pushing to GitHub Pages...`);
  publishFiles({
    cwd: dashboardDir,
    message: `archive: AR snapshot ${entryDate} ${SLOT} (per-office history)`,
    paths: ["ar-snapshot.json", "ar-history-backup.json"],
    stage(dir) {
      const snapshotPath = join(dir, "ar-snapshot.json");
      const backupPath = join(dir, "ar-history-backup.json");
      const latest = JSON.parse(readFileSync(snapshotPath, "utf8").replace(/^\uFEFF/, ""));
      const freshEntry = {
        date: entryDate, slot: SLOT, asOf: ctNowFriendly(),
        generated: new Date().toISOString(),
        offices: {} as Record<string, ReturnType<typeof pickOfficeFields>>,
      };
      for (const [code, office] of Object.entries(latest.offices || {})) {
        freshEntry.offices[code] = pickOfficeFields(office);
      }
      latest.perOfficeHistory = Array.isArray(latest.perOfficeHistory) ? latest.perOfficeHistory : [];
      const at = latest.perOfficeHistory.findIndex((h: any) => h.date === entryDate && (h.slot || null) === SLOT);
      if (at >= 0) latest.perOfficeHistory[at] = freshEntry;
      else latest.perOfficeHistory.push(freshEntry);
      latest.perOfficeHistory.sort((a: any, b: any) => {
        const d = (a.date || "").localeCompare(b.date || "");
        return d !== 0 ? d : (slotOrder[a.slot] ?? 2) - (slotOrder[b.slot] ?? 2);
      });
      if (Number.isFinite(MAX_HISTORY_DAYS)) latest.perOfficeHistory = latest.perOfficeHistory.slice(-MAX_HISTORY_DAYS);
      writeFileSync(snapshotPath, JSON.stringify(latest, null, 2));

      let backupExisting: any = { perOfficeHistory: [] };
      try { backupExisting = JSON.parse(readFileSync(backupPath, "utf8")); } catch { /* first backup */ }
      const byKey = new Map<string, any>();
      for (const e of backupExisting.perOfficeHistory || []) if (e?.date) byKey.set(`${e.date}#${e.slot ?? ""}`, e);
      for (const e of latest.perOfficeHistory || []) if (e?.date) byKey.set(`${e.date}#${e.slot ?? ""}`, e);
      const merged = Array.from(byKey.values()).sort((a, b) => {
        const d = (a.date || "").localeCompare(b.date || "");
        return d !== 0 ? d : (slotOrder[a.slot] ?? 2) - (slotOrder[b.slot] ?? 2);
      });
      writeFileSync(backupPath, JSON.stringify({ updated: new Date().toISOString(), perOfficeHistory: merged }, null, 2));
    }
  });
  console.log(`✅ Pushed.`);
}

main();
