/**
 * Weekly Office KPI Snapshot — pulls from ClickUp list "Weekly Office KPIs" (901415926262).
 * Output: kpi-snapshot.json
 */

import { getClickUpToken } from "../lib/clickup-oauth.js";
import { writeFileSync } from "fs";
import { join } from "path";
import { publishFiles } from "./lib/git-publish.mjs";
import { resolveDashboardRoot } from "./lib/dashboard-root.mjs";

const CLICKUP_BASE = "https://api.clickup.com/api/v2";
const KPI_LIST_ID = "901415926262";
const MAX_WEEKS = 12;
const DRY_RUN = process.argv.includes("--dry-run");

const OFFICE_BY_INDEX: Record<number, string> = {
  0: "SQ", 1: "GT", 2: "ATX", 3: "MP", 4: "NBDA",
  5: "IC", 6: "AR", 7: "PF", 8: "SATX", 9: "AM",
};

const FIELD_MAP = {
  monthlyProduction: "MTD Adjusted Production",
  collectionRate:    "RCM Collection Rate %",
  hygReappt:         "Hyg Re-appointment Rate %",
  cancellationRate:  "Cancellation Rate %",
  caseAcceptance:    "Dr Case Acceptance %",
  arDays:            "AR Days",
  arOver30:          "AR Over 30 Days",
} as const;
type MetricKey = keyof typeof FIELD_MAP;
const METRIC_KEYS = Object.keys(FIELD_MAP) as MetricKey[];

interface ClickUpField { id: string; name: string; type: string; type_config?: { options?: Array<{ id: string; name: string; orderindex: number }> }; value?: any; }
interface Task { id: string; name: string; custom_fields?: ClickUpField[]; }

async function api(path: string, token: string) {
  const r = await fetch(`${CLICKUP_BASE}${path}`, { headers: { Authorization: token } });
  if (!r.ok) throw new Error(`ClickUp ${r.status} ${path}: ${await r.text()}`);
  return r.json();
}

function getField(t: Task, name: string): ClickUpField | undefined {
  return t.custom_fields?.find(f => f.name === name);
}

function parsePct(v: any): number | null {
  if (v == null || v === "") return null;
  const n = parseFloat(String(v).replace(/[%\s,]/g, ""));
  return Number.isFinite(n) ? n : null;
}
function parseNum(v: any): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}
function isoFromMs(ms: number | string): string {
  const n = typeof ms === "string" ? Number(ms) : ms;
  return Number.isFinite(n) ? new Date(n).toISOString().slice(0, 10) : "";
}
function normalizeToSunday(iso: string): string {
  const d = new Date(iso + "T12:00:00");
  const day = d.getDay();
  if (day !== 0) d.setDate(d.getDate() + (7 - day));
  return d.toISOString().slice(0, 10);
}
function shortLabel(weekEndingIso: string): string {
  const end = new Date(weekEndingIso + "T12:00:00");
  if (Number.isNaN(end.getTime())) return weekEndingIso;
  const start = new Date(end); start.setDate(end.getDate() - 6);
  const fmt = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}`;
  return `${fmt(start)} – ${fmt(end)}`;
}

async function fetchAllTasks(token: string): Promise<Task[]> {
  const out: Task[] = [];
  let page = 0;
  while (true) {
    const j: any = await api(`/list/${KPI_LIST_ID}/task?include_closed=true&subtasks=false&page=${page}`, token);
    const tasks: Task[] = j.tasks || [];
    out.push(...tasks);
    if (tasks.length < 100 || ++page > 50) break;
  }
  return out;
}

function officeCodeFor(t: Task): string | null {
  const f = getField(t, "👔 Office");
  if (!f) return null;
  const opts = f.type_config?.options || [];
  const idx = typeof f.value === "number" ? f.value : opts.find(o => o.id === f.value)?.orderindex;
  return idx != null ? (OFFICE_BY_INDEX[idx] ?? null) : null;
}

function weekEndingFor(t: Task): string | null {
  const f = getField(t, "Week Ending");
  if (!f?.value) return null;
  const iso = isoFromMs(f.value);
  return iso ? normalizeToSunday(iso) : null;
}

function metricsFor(t: Task): Record<MetricKey, number | null> {
  const out = {} as Record<MetricKey, number | null>;
  for (const key of METRIC_KEYS) {
    const f = getField(t, FIELD_MAP[key]);
    if (!f) { out[key] = null; continue; }
    const isNumeric = key === "monthlyProduction" || key === "arDays" || key === "arOver30";
    out[key] = isNumeric ? parseNum(f.value) : parsePct(f.value);
  }
  return out;
}

async function main() {
  console.log("→ Fetching Weekly Office KPIs…");
  const token = await getClickUpToken();
  const tasks = await fetchAllTasks(token);
  console.log(`  ${tasks.length} tasks`);

  const byWeek: Record<string, Record<string, Record<MetricKey, number | null>>> = {};
  for (const t of tasks) {
    const week = weekEndingFor(t);
    const office = officeCodeFor(t);
    if (!week || !office) continue;
    byWeek[week] ??= {};
    byWeek[week][office] = metricsFor(t);
  }

  const recent = Object.keys(byWeek).sort().slice(-MAX_WEEKS);
  const weeks = recent.map(weekIso => {
    const offices = byWeek[weekIso];
    const totals: Record<MetricKey, number | null> = { monthlyProduction: null, collectionRate: null, hygReappt: null, cancellationRate: null, caseAcceptance: null, arDays: null, arOver30: null };
    for (const key of METRIC_KEYS) {
      const vals = Object.values(offices).map(o => o[key]).filter((v): v is number => v != null);
      if (!vals.length) continue;
      totals[key] = (key === "monthlyProduction" || key === "arOver30")
        ? vals.reduce((a, b) => a + b, 0)
        : vals.reduce((a, b) => a + b, 0) / vals.length;
    }
    return { weekEnding: weekIso, weekLabel: shortLabel(weekIso), offices, totals };
  });

  const out = {
    generated: new Date().toISOString(),
    asOf: new Date().toLocaleString("en-US", { timeZone: "America/Chicago", dateStyle: "short", timeStyle: "short" }) + " CT",
    listId: KPI_LIST_ID, metrics: METRIC_KEYS, weeks,
  };
  console.log(`  → ${weeks.length} week(s) captured`);

  if (DRY_RUN) { console.log("(dry-run — no write)"); return; }

  const dashboardDir = resolveDashboardRoot(import.meta.url);
  const payload = JSON.stringify(out, null, 2);
  console.log(`✔ prepared kpi-snapshot.json`);
  console.log("\n📤 Pushing to GitHub Pages…");
  publishFiles({
    cwd: dashboardDir,
    message: `chore: update KPI snapshot ${new Date().toLocaleDateString("en-US")}`,
    paths: ["kpi-snapshot.json"],
    stage(dir) { writeFileSync(join(dir, "kpi-snapshot.json"), payload); }
  });
  console.log("✅ Pushed.");
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
