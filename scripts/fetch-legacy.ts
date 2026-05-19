// fetch-legacy.ts
// Pulls per-office legacy balances (Dentrix / Open Dental) from ClickUp and
// writes them into ar-snapshot.json → offices.<CODE>.legacy.

import { readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import { getClickUpToken } from "../lib/clickup-oauth.js";

const DRY_RUN = process.argv.includes("--dry-run");

type LegacyBucketConfig = {
  label: string; viewId: string; closingDateISO: string;
  excludeViewId?: string; homeOfficeFilter?: string;
  source: "Open Dental" | "Dentrix"; forceAllOver90?: boolean;
};

const LEGACY: Record<string, LegacyBucketConfig[]> = {
  GT: [
    { label: "GT Open Dental", source: "Open Dental", viewId: "8cmfvnv-41554", closingDateISO: "2019-09-05", excludeViewId: "8cmfvnv-42054", forceAllOver90: true },
    { label: "HZ Dentrix",     source: "Dentrix",     viewId: "8cmfvnv-41534", closingDateISO: "2024-12-20", excludeViewId: "8cmfvnv-42054", forceAllOver90: true },
  ],
  MP: [
    { label: "MP Dentrix", source: "Dentrix", viewId: "8cmfvnv-47874", closingDateISO: "2020-12-07", homeOfficeFilter: "SH MP",      forceAllOver90: true },
    { label: "FS Dentrix", source: "Dentrix", viewId: "8cmfvnv-47874", closingDateISO: "2025-04-30", homeOfficeFilter: "Hassan - FS", forceAllOver90: true },
  ],
  NBDA: [{ label: "NBDA Dentrix",   source: "Dentrix",     viewId: "8cmfvnv-49094", closingDateISO: "2021-12-22", forceAllOver90: true }],
  IC:   [{ label: "IC Open Dental", source: "Open Dental", viewId: "8cmfvnv-42874", closingDateISO: "2023-05-03", forceAllOver90: true }],
  AR:   [{ label: "AR Dentrix",     source: "Dentrix",     viewId: "8cmfvnv-42834", closingDateISO: "2022-08-01", forceAllOver90: true }],
  SATX: [{ label: "SATX Open Dental", source: "Open Dental", viewId: "8cmfvnv-53154", closingDateISO: "2025-04-30", forceAllOver90: true }],
};

let TOKEN: string;
async function api(path: string): Promise<any> {
  const r = await fetch(`https://api.clickup.com/api/v2${path}`, { headers: { Authorization: TOKEN } });
  if (!r.ok) throw new Error(`API ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

function parseDollarText(v: any): number {
  if (v == null) return 0;
  const n = Number(String(v).replace(/[$,\s]/g, "").trim());
  return Number.isFinite(n) ? n : 0;
}

function getCustomFieldByName(task: any, name: string): any {
  return (task.custom_fields || []).find((f: any) => f.name === name);
}

function getDropdownOption(field: any): string {
  if (!field || field.value == null || !field.type_config?.options) return "";
  const opt = field.type_config.options.find((o: any) => o.id === field.value || o.orderindex === field.value);
  return opt?.name ?? "";
}

async function fetchAllTasksInView(viewId: string): Promise<any[]> {
  const all: any[] = [];
  for (let page = 0; page < 100; page++) {
    const r = await api(`/view/${viewId}/task?page=${page}`);
    if (!r.tasks?.length) break;
    all.push(...r.tasks);
    if (r.tasks.length < 30) break;
  }
  return all;
}

async function fetchViewTaskIds(viewId: string): Promise<Set<string>> {
  return new Set((await fetchAllTasksInView(viewId)).map((t: any) => t.id));
}

type Buckets = { d0_30: number; d31_60: number; d61_90: number; d90plus: number; total: number };
type LegacyResult = Buckets & { label: string; source: string; closingDate: string; taskCount: number; excludedCount: number; preDosCount: number; filteredOutCount: number };

async function sumLegacyBucket(cfg: LegacyBucketConfig): Promise<LegacyResult> {
  const closingMs = new Date(cfg.closingDateISO + "T00:00:00Z").getTime();
  const exclude   = cfg.excludeViewId ? await fetchViewTaskIds(cfg.excludeViewId) : new Set<string>();
  const tasks     = await fetchAllTasksInView(cfg.viewId);
  const b: Buckets = { d0_30: 0, d31_60: 0, d61_90: 0, d90plus: 0, total: 0 };
  let kept = 0, excluded = 0, preDos = 0, filteredOut = 0;
  for (const t of tasks) {
    if (t.parent) continue;
    if (exclude.has(t.id)) { excluded++; continue; }
    if (cfg.homeOfficeFilter) {
      const ho = getDropdownOption(getCustomFieldByName(t, "HOME OFFICE"));
      if (ho !== cfg.homeOfficeFilter) { filteredOut++; continue; }
    }
    // Skip resolved/closed tasks — balance is preserved for history but must not
    // be counted toward active AR totals. Status is the source of truth; do NOT
    // rely on $0 balance to exclude resolved tasks (that destroys historical data).
    if (t.status?.status === "resolved per report" || t.status?.type === "closed") continue;

    const dosField = getCustomFieldByName(t, "Date-of-Service");
    const dosMs    = dosField?.value ? Number(dosField.value) : null;
    if (!dosMs || dosMs < closingMs) { preDos++; continue; }
    const claimBal = Number(getCustomFieldByName(t, "Claim Balance")?.value ?? 0);
    if (!claimBal) continue;
    let bucket: keyof Buckets;
    if (cfg.forceAllOver90) {
      bucket = "d90plus";
    } else {
      const ageDays = Math.floor((Date.now() - dosMs) / 86400000);
      bucket = ageDays <= 30 ? "d0_30" : ageDays <= 60 ? "d31_60" : ageDays <= 90 ? "d61_90" : "d90plus";
    }
    b[bucket] += claimBal; b.total += claimBal; kept++;
  }
  const round = (n: number) => Math.round(n * 100) / 100;
  return { d0_30: round(b.d0_30), d31_60: round(b.d31_60), d61_90: round(b.d61_90), d90plus: round(b.d90plus), total: round(b.total), label: cfg.label, source: cfg.source, closingDate: cfg.closingDateISO, taskCount: kept, excludedCount: excluded, preDosCount: preDos, filteredOutCount: filteredOut };
}

async function main() {
  console.log(`\n📜 Fetching legacy balances…`);
  TOKEN = await getClickUpToken();

  const scriptDir    = dirname(fileURLToPath(import.meta.url));
  const dashboardDir = process.env.CI
    ? join(scriptDir, "..")
    : join(scriptDir, "..", "apps", "rcm-dashboard");
  const snapshotPath = join(dashboardDir, "ar-snapshot.json");

  const results: Record<string, LegacyResult[]> = {};
  for (const [code, buckets] of Object.entries(LEGACY)) {
    results[code] = [];
    for (const cfg of buckets) {
      process.stdout.write(`  ${code.padEnd(5)} ${cfg.label.padEnd(22)} `);
      try {
        const r = await sumLegacyBucket(cfg);
        results[code].push(r);
        console.log(`total=$${r.total.toFixed(2)} (>90 $${r.d90plus}) · ${r.taskCount} kept${r.excludedCount ? ` · ${r.excludedCount} NTCO` : ""}${r.preDosCount ? ` · ${r.preDosCount} pre-closing` : ""}`);
      } catch (err: any) {
        console.error(`✗ ${err.message?.slice(0, 200) ?? err}`);
      }
    }
  }

  if (DRY_RUN) { console.log(`\nDRY RUN — skipping write.`); return; }

  const data = JSON.parse(readFileSync(snapshotPath, "utf8"));
  data.offices = data.offices || {};
  if (data.offices.HZ) { delete data.offices.HZ; console.log(`✓ Removed standalone HZ office`); }
  for (const [code, items] of Object.entries(results)) {
    if (!data.offices[code]) continue;
    data.offices[code].legacy = items.map(r => ({
      label: r.label, source: r.source, closingDate: r.closingDate,
      d0_30: r.d0_30, d31_60: r.d31_60, d61_90: r.d61_90, d90plus: r.d90plus,
      total: r.total, taskCount: r.taskCount, excludedCount: r.excludedCount,
      asOf: new Date().toISOString(),
    }));
  }
  data.generated = new Date().toISOString();
  writeFileSync(snapshotPath, JSON.stringify(data, null, 2));
  console.log(`\n✓ Wrote ar-snapshot.json`);

  try {
    console.log(`\n📤 Pushing to GitHub Pages...`);
    const freshSnapshot = readFileSync(snapshotPath, "utf8");
    execSync(`git fetch origin master`, { cwd: dashboardDir, stdio: "pipe" });
    execSync(`git reset --hard origin/master`, { cwd: dashboardDir, stdio: "pipe" });
    writeFileSync(snapshotPath, freshSnapshot);
    execSync(`git add ar-snapshot.json`, { cwd: dashboardDir, stdio: "pipe" });
    execSync(`git commit -m "chore: refresh legacy balances ${new Date().toLocaleDateString("en-US")}"`, { cwd: dashboardDir, stdio: "pipe" });
    execSync(`git push origin master`, { cwd: dashboardDir, stdio: "pipe" });
    console.log(`✅ Pushed.`);
  } catch (err: any) {
    console.error(`⚠ Push failed: ${err.message?.slice(0, 300) ?? err}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
