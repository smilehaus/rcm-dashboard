/**
 * Unposted EOB/EFT Amount — pulls per-office unposted totals from ClickUp.
 * Writes per-office "unposted" into ar-snapshot.json, then commits and pushes.
 *
 * Usage:
 *   npx tsx scripts/fetch-unposted.ts            # live
 *   npx tsx scripts/fetch-unposted.ts --dry-run  # log only
 *   npx tsx scripts/fetch-unposted.ts --office SQ  # single office
 */

import { getClickUpToken } from "../lib/clickup-oauth.js";
import { writeFileSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const CLICKUP_BASE = "https://api.clickup.com/api/v2";
const TEAM_ID = "9014079163";
const SPACE_NAME = "SH Revenue Cycle Management";

const POSTING_PROGRESS_FIELD = "SH POSTING Progress";
const GRAND_TOTAL_FIELD      = "Grand Total";
const DATE_POSTED_FIELD      = "Date Posted";
const COMPLETED_OPTION       = "Completed";
const EXCLUDED_STATUSES = new Set(["completed", "send statement"]);

const OFFICE_CODES = ["SQ","GT","ATX","MP","NBDA","IC","AR","PF","SATX","AM"] as const;
type OfficeCode = typeof OFFICE_CODES[number];

const OFFICE_YEARS: Record<OfficeCode, number[]> = {
  SQ:[2025,2026],GT:[2025,2026],ATX:[2025,2026],MP:[2025,2026],NBDA:[2025,2026],
  IC:[2025,2026],AR:[2025,2026],PF:[2025,2026],SATX:[2025,2026],AM:[2025,2026],
};

const DRY_RUN     = process.argv.includes("--dry-run");
const officeArgIx = process.argv.indexOf("--office");
const ONLY_OFFICE = officeArgIx >= 0 ? (process.argv[officeArgIx + 1] || "").toUpperCase() : null;

async function clickupApi(path: string, options: RequestInit = {}): Promise<any> {
  const token = await getClickUpToken();
  const res = await fetch(`${CLICKUP_BASE}${path}`, {
    ...options,
    headers: { Authorization: token, "Content-Type": "application/json", ...options.headers },
  });
  if (!res.ok) throw new Error(`ClickUp API ${res.status} ${path}: ${await res.text()}`);
  if (res.status === 204) return {};
  return res.json();
}

async function getAllTasks(listId: string): Promise<any[]> {
  const all: any[] = [];
  for (let page = 0; page < 20; page++) {
    const data = await clickupApi(`/list/${listId}/task?subtasks=false&page=${page}&limit=100&include_closed=true&archived=false`);
    all.push(...data.tasks);
    if (data.tasks.length < 100) break;
  }
  return all;
}

function getCustomField(task: any, fieldName: string): any {
  return task.custom_fields?.find((f: any) => f.name === fieldName);
}
function getDropdownOptionName(field: any): string {
  if (field?.value == null || !field?.type_config?.options) return "";
  const opt = field.type_config.options.find((o: any) => o.id === field.value || o.orderindex === field.value);
  return (opt?.name ?? "").trim();
}
function getCurrencyValue(field: any): number {
  if (field?.value == null || field.value === "") return 0;
  const n = Number(field.value);
  return isNaN(n) ? 0 : n;
}

async function findSpaceId(): Promise<string> {
  const res = await clickupApi(`/team/${TEAM_ID}/space?archived=false`);
  const space = res.spaces.find((s: any) => s.name === SPACE_NAME);
  if (!space) throw new Error(`Space "${SPACE_NAME}" not found`);
  return space.id;
}

async function findOfficeFolders(spaceId: string): Promise<Record<string, string>> {
  const res = await clickupApi(`/space/${spaceId}/folder?archived=false`);
  const map: Record<string, string> = {};
  for (const code of OFFICE_CODES) {
    const folder = res.folders.find((f: any) => {
      const n = f.name.replace(/\s+/g, " ").trim().toUpperCase();
      return n === `SH ${code}` || n.startsWith(`SH ${code}/`) || n.startsWith(`SH ${code} `) || n === code;
    });
    if (folder) map[code] = folder.id;
  }
  return map;
}

async function findEobEraLists(folderId: string): Promise<{ id: string; name: string }[]> {
  const res = await clickupApi(`/folder/${folderId}/list?archived=false`);
  return res.lists.filter((l: any) => /(EOB Scans|ERA) Management/i.test(l.name)).map((l: any) => ({ id: l.id, name: l.name }));
}

type OfficeUnpostedResult = {
  y2025: number | null; y2026: number | null; total: number; taskCount: number;
  perList: { name: string; year: number; total: number; tasks: number }[];
  completedToday2026: number;
  completedThisWeek2026: number;
  completedThisWeekStart: string;    // YYYY-MM-DD of Monday
  newTasksAddedThisWeek2026: number; // Grand Total of all 2026 tasks created since Monday CT
};

function detectListYear(listName: string): number | null {
  const m = listName.match(/\b(20\d{2})\b/);
  return m ? Number(m[1]) : null;
}

async function sumOfficeUnposted(code: OfficeCode, lists: { id: string; name: string }[]): Promise<OfficeUnpostedResult> {
  const allowedYears = new Set(OFFICE_YEARS[code]);
  const yearTotals: Record<number, number> = {};
  let totalTaskCount = 0;
  const perList: { name: string; year: number; total: number; tasks: number }[] = [];
  const todayCT = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
  // Monday of the current week in CT — week resets at midnight Monday CT.
  const nowCT_ = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Chicago" }));
  const daysToMon_ = (nowCT_.getDay() + 6) % 7; // Sun→6, Mon→0, Tue→1, ...
  const monCT_ = new Date(nowCT_); monCT_.setDate(nowCT_.getDate() - daysToMon_);
  const mondayISO_ = monCT_.getFullYear() + "-" +
    String(monCT_.getMonth() + 1).padStart(2, "0") + "-" +
    String(monCT_.getDate()).padStart(2, "0");
  let completedToday2026 = 0;
  let completedThisWeek2026 = 0;
  let newTasksAddedThisWeek2026 = 0;

  for (const list of lists) {
    const year = detectListYear(list.name);
    if (year == null) { console.warn(`    ⚠️  Could not detect year: "${list.name}" — skipping`); continue; }
    if (!allowedYears.has(year)) continue;
    let listTotal = 0, listTasks = 0;
    const tasks = await getAllTasks(list.id);
    for (const task of tasks) {
      if (task.parent) continue;
      const progress = getCustomField(task, POSTING_PROGRESS_FIELD);
      const progressName = getDropdownOptionName(progress).toLowerCase();
      const isCompleted = progressName === COMPLETED_OPTION.toLowerCase();
      const isExcluded  = EXCLUDED_STATUSES.has(progressName);
      const gt = getCustomField(task, GRAND_TOTAL_FIELD);
      const v = getCurrencyValue(gt);

      // Track 2026 tasks whose ClickUp task was CREATED this week (Monday CT onward).
      // Uses date_created only — not date_updated — so that old tasks which are merely
      // edited this week are not counted. ERA batches entered retroactively (e.g. a
      // "05/28/26" ERA task entered into ClickUp on 06/02) are correctly caught because
      // their ClickUp date_created reflects when the task was first made, not the ERA date
      // in the task name.
      if (year === 2026 && v > 0 && task.date_created) {
        const createdCT = new Date(Number(task.date_created)).toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
        if (createdCT >= mondayISO_) newTasksAddedThisWeek2026 += v;
      }

      if (isCompleted) {
        if (year === 2026 && v > 0) {
          const dp = getCustomField(task, DATE_POSTED_FIELD);
          if (dp?.value) {
            const dpDate = new Date(Number(dp.value)).toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
            if (dpDate === todayCT)    completedToday2026    += v;
            if (dpDate >= mondayISO_) completedThisWeek2026 += v;
          }
        }
        continue;
      }
      if (isExcluded || v === 0) continue;
      listTotal += v; listTasks++;
    }
    yearTotals[year] = (yearTotals[year] || 0) + listTotal;
    totalTaskCount += listTasks;
    perList.push({ name: list.name, year, total: listTotal, tasks: listTasks });
  }
  const round = (n: number) => Math.round(n * 100) / 100;
  const y2025 = allowedYears.has(2025) ? round(yearTotals[2025] || 0) : null;
  const y2026 = allowedYears.has(2026) ? round(yearTotals[2026] || 0) : null;
  return {
    y2025, y2026, total: round((y2025 || 0) + (y2026 || 0)), taskCount: totalTaskCount, perList,
    completedToday2026:       round(completedToday2026),
    completedThisWeek2026:    round(completedThisWeek2026),
    completedThisWeekStart:   mondayISO_,
    newTasksAddedThisWeek2026: round(newTasksAddedThisWeek2026),
  };
}

async function main() {
  console.log(`\n💰 Unposted EOB/EFT — pulling from ClickUp`);
  if (DRY_RUN) console.log(`🧪 DRY RUN — no JSON write or push`);
  if (ONLY_OFFICE) console.log(`🎯 Single office: ${ONLY_OFFICE}`);

  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const dashboardDir = process.env.CI
    ? join(scriptDir, "..")
    : join(scriptDir, "..", "apps", "rcm-dashboard");
  const snapshotPath = join(dashboardDir, "ar-snapshot.json");

  const spaceId = await findSpaceId();
  const folders = await findOfficeFolders(spaceId);
  console.log(`✓ Found ${Object.keys(folders).length} office folders`);

  const results: Record<string, OfficeUnpostedResult | null> = {};
  for (const code of OFFICE_CODES) {
    if (ONLY_OFFICE && code !== ONLY_OFFICE) continue;
    if (!folders[code]) { console.warn(`  ⚠️  ${code}: folder not found`); results[code] = null; continue; }
    const lists = await findEobEraLists(folders[code]);
    if (!lists.length) { console.warn(`  ⚠️  ${code}: no EOB/ERA lists`); results[code] = null; continue; }
    const r = await sumOfficeUnposted(code as OfficeCode, lists);
    results[code] = r;
    console.log(`  ${code}: $${r.total.toFixed(2)} — 2025: $${(r.y2025 ?? 0).toFixed(2)} · 2026: $${(r.y2026 ?? 0).toFixed(2)} · ${r.taskCount} tasks`);
    for (const l of r.perList) console.log(`    └─ ${l.name}: $${l.total.toFixed(2)} (${l.tasks} tasks)`);
  }

  let grand2025 = 0, grand2026 = 0, grandTotal = 0;
  for (const r of Object.values(results)) { if (!r) continue; grand2025 += r.y2025 || 0; grand2026 += r.y2026 || 0; grandTotal += r.total; }
  console.log(`\n📊 Org-wide: $${grandTotal.toFixed(2)} (2025: $${grand2025.toFixed(2)} · 2026: $${grand2026.toFixed(2)})`);

  if (DRY_RUN) { console.log(`\nDRY RUN — skipping write.`); return; }

  const data = JSON.parse(readFileSync(snapshotPath, "utf8").replace(/^﻿/, ""));
  data.offices = data.offices || {};
  for (const code of OFFICE_CODES) {
    if (ONLY_OFFICE && code !== ONLY_OFFICE) continue;
    const r = results[code];
    if (r == null) continue;
    if (!data.offices[code]) data.offices[code] = { outstanding: null, patients: null, insurance: null, unposted: null };
    const prevUnposted = data.offices[code].unposted || {};
    data.offices[code].unposted = {
      y2025: r.y2025, y2026: r.y2026, total: r.total,
      mondayBaseline2026: prevUnposted.mondayBaseline2026 ?? null,
      mondayBaselineDate: prevUnposted.mondayBaselineDate ?? null,
      completedToday2026:        r.completedToday2026,
      completedTodayDate:        new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" }),
      completedThisWeek2026:     r.completedThisWeek2026,
      completedThisWeekStart:    r.completedThisWeekStart,
      newTasksAddedThisWeek2026: r.newTasksAddedThisWeek2026,
    };
  }

  const nowCT = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Chicago" }));
  const daysSinceMon = (nowCT.getDay() + 6) % 7;
  const mondayCT = new Date(nowCT); mondayCT.setDate(mondayCT.getDate() - daysSinceMon);
  const mondayISO = mondayCT.toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
  for (const code of OFFICE_CODES) {
    if (ONLY_OFFICE && code !== ONLY_OFFICE) continue;
    const office = data.offices[code];
    if (!office?.unposted) continue;
    if (!office.unposted.mondayBaselineDate || office.unposted.mondayBaselineDate < mondayISO) {
      office.unposted.mondayBaseline2026 = office.unposted.y2026;
      office.unposted.mondayBaselineDate = mondayISO;
    }
  }
  console.log(`📅 Weekly baseline date = ${mondayISO}`);
  const _now = new Date();
  data.generated = _now.toISOString();
  data.asOf = _now.toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    month: 'numeric', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  }) + ' CT';

  const todayCT = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
  data.history = Array.isArray(data.history) ? data.history : [];
  let entry = data.history.find((h: any) => h.date === todayCT);
  if (!entry) { entry = { date: todayCT }; data.history.push(entry); }
  entry.unposted = grandTotal; entry.unposted2026 = grand2026; entry.unposted2025 = grand2025;
  data.history.sort((a: any, b: any) => (a.date || "").localeCompare(b.date || ""));
  data.history = data.history.slice(-14);

  writeFileSync(snapshotPath, JSON.stringify(data, null, 2));
  console.log(`✓ Wrote ar-snapshot.json`);

  try {
    console.log(`\n📤 Pushing to GitHub Pages...`);
    const freshSnapshot = readFileSync(snapshotPath, "utf8");
    execSync(`git fetch origin master`, { cwd: dashboardDir, stdio: "pipe" });
    execSync(`git reset --hard origin/master`, { cwd: dashboardDir, stdio: "pipe" });
    writeFileSync(snapshotPath, freshSnapshot);
    execSync(`git add ar-snapshot.json`, { cwd: dashboardDir, stdio: "pipe" });
    execSync(`git commit -m "chore: update unposted ${new Date().toLocaleDateString("en-US")}"`, { cwd: dashboardDir, stdio: "pipe" });
    execSync(`git push origin master`, { cwd: dashboardDir, stdio: "pipe" });
    console.log(`✅ Pushed.`);
  } catch (e: any) {
    if (e.message?.includes("nothing to commit")) console.log(`ℹ️  No changes to push`);
    else console.error(`⚠️  Git push failed: ${e.message}`);
  }
}

main().catch((err) => { console.error(`\n❌ ERROR: ${err.message}`); process.exit(1); });
