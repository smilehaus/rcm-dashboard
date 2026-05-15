/**
 * Resubmit Claims Flag — Daily Priority Script
 * Scans all Master Aging INS AR lists for claims where Aging Status = "Must resubmit".
 * Outputs: resubmit-alerts.json
 */

import { getClickUpToken } from "../lib/clickup-oauth.js";
import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const CLICKUP_BASE = "https://api.clickup.com/api/v2";
const DOS_FIELD_ID = "80e9173a-e6c5-4815-a0e7-18e69255bec5";
const AGING_STATUS_FIELD_ID = "830bff4a-37c3-41ca-9e38-2f63a9a08a55";
const PMS_FIELD_ID = "4e365613-1fac-481e-8e71-3a1cab327cf9";
const TIMELY_FILING_DAYS = 365;
const WARNING_DAYS = 7;
const PRIORITY_THRESHOLD_DAYS = TIMELY_FILING_DAYS - WARNING_DAYS;
const OVERDUE_FLOOR = new Date("2025-01-01T00:00:00Z").getTime();
const MUST_RESUBMIT_LABEL = "must resubmit";

const INS_AR_LISTS: Record<string, string> = {
  SQ:"901414222239",GT:"901414297874",ATX:"901414297968",MP:"901414298051",
  NBDA:"901414298058",IC:"901414298081",AR:"901414298085",PF:"901414298097",
  SATX:"901414298104",AM:"901414359405",
};

const DRY_RUN = process.argv.includes("--dry-run");

async function clickupApi(path: string, options: RequestInit = {}): Promise<any> {
  const token = await getClickUpToken();
  const res = await fetch(`${CLICKUP_BASE}${path}`, {
    ...options,
    headers: { Authorization: token, "Content-Type": "application/json", ...options.headers },
  });
  if (!res.ok) throw new Error(`ClickUp API ${res.status}: ${await res.text()}`);
  if (res.status === 204) return {};
  return res.json();
}

async function getAllTasks(listId: string): Promise<any[]> {
  let all: any[] = [];
  for (let page = 0; page < 20; page++) {
    const data = await clickupApi(`/list/${listId}/task?subtasks=false&page=${page}&limit=100&include_closed=false`);
    all = all.concat(data.tasks);
    if (data.tasks.length < 100) break;
  }
  return all;
}

function getDropdownOptionName(field: any): string {
  if (field?.value == null || !field?.type_config?.options) return "";
  const opt = field.type_config.options.find((o: any) => o.orderindex === field.value);
  return (opt?.name ?? "").trim();
}

function isMustResubmit(task: any): boolean {
  const field = task.custom_fields?.find((f: any) => f.id === AGING_STATUS_FIELD_ID);
  return !!field && getDropdownOptionName(field).toLowerCase() === MUST_RESUBMIT_LABEL;
}

function getPmsBucket(task: any): "oryx" | "legacy" {
  const field = task.custom_fields?.find((f: any) => f.id === PMS_FIELD_ID);
  return getDropdownOptionName(field).toLowerCase().includes("oryx") ? "oryx" : "legacy";
}

async function main() {
  const now = Date.now();
  const priorityThresholdMs = PRIORITY_THRESHOLD_DAYS * 86400000;
  const deadlineMs = TIMELY_FILING_DAYS * 86400000;

  console.log(`\nResubmit Claims Flag — ${new Date().toLocaleDateString("en-US")}`);
  if (DRY_RUN) console.log(`DRY RUN\n`);

  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const dashboardDir = process.env.CI
    ? join(scriptDir, "..")
    : join(scriptDir, "..", "apps", "rcm-dashboard");
  const dashboardPath = join(dashboardDir, "resubmit-alerts.json");

  type PmsBucket = { priority: number; overdue: number };
  type OfficeData = { oryx: PmsBucket; legacy: PmsBucket };
  const dashData: Record<string, OfficeData> = {};
  let totalScanned = 0, totalResubmit = 0, totalPriority = 0, totalOverdue = 0;

  for (const [office, listId] of Object.entries(INS_AR_LISTS)) {
    dashData[office] = { oryx: { priority: 0, overdue: 0 }, legacy: { priority: 0, overdue: 0 } };
    const tasks = await getAllTasks(listId);
    let officePriority = 0, officeOverdue = 0, officeResubmit = 0;
    for (const task of tasks) {
      totalScanned++;
      if (!isMustResubmit(task)) continue;
      officeResubmit++; totalResubmit++;
      const dosField = task.custom_fields?.find((f: any) => f.id === DOS_FIELD_ID);
      if (!dosField?.value) continue;
      const dosMs = Number(dosField.value);
      if (dosMs < OVERDUE_FLOOR) continue;
      const ageMs = now - dosMs;
      const ageDays = Math.floor(ageMs / 86400000);
      const pms = getPmsBucket(task);
      if (ageMs >= deadlineMs) {
        console.log(`  ${DRY_RUN ? "[DRY]" : "OVERDUE"} ${office} | ${task.name} | ${ageDays}d | ${pms}`);
        dashData[office][pms].overdue++; officeOverdue++; totalOverdue++;
        continue;
      }
      if (ageMs >= priorityThresholdMs) {
        console.log(`  ${DRY_RUN ? "[DRY]" : "PRIORITY"} ${office} | ${task.name} | ${ageDays}d | ${pms}`);
        dashData[office][pms].priority++; officePriority++; totalPriority++;
      }
    }
    if (officeResubmit > 0) console.log(`  ${office}: ${officeResubmit} resubmit (${officePriority} priority, ${officeOverdue} overdue)`);
  }

  console.log(`\nScanned: ${totalScanned} · Must Resubmit: ${totalResubmit} · Priority: ${totalPriority} · Overdue: ${totalOverdue}`);

  const jsonPayload = { generated: new Date().toISOString(), offices: dashData };

  if (DRY_RUN) { console.log(JSON.stringify(jsonPayload, null, 2)); return; }

  writeFileSync(dashboardPath, JSON.stringify(jsonPayload, null, 2));
  console.log(`resubmit-alerts.json written`);

  try {
    try { execSync(`git stash`, { cwd: dashboardDir, stdio: "pipe" }); } catch {}
    execSync(`git pull --rebase origin master`, { cwd: dashboardDir, stdio: "pipe" });
    try { execSync(`git stash pop`, { cwd: dashboardDir, stdio: "pipe" }); } catch {}
    execSync(`git add resubmit-alerts.json`, { cwd: dashboardDir, stdio: "pipe" });
    execSync(`git commit -m "chore: update resubmit-alerts ${new Date().toLocaleDateString("en-US")}"`, { cwd: dashboardDir, stdio: "pipe" });
    execSync(`git push origin master`, { cwd: dashboardDir, stdio: "pipe" });
    console.log(`Pushed.`);
  } catch (e: any) {
    if (e.message?.includes("nothing to commit")) console.log(`No changes to push`);
    else console.error(`Git push failed: ${e.message}`);
  }
}

main().catch((err) => { console.error(`\nERROR: ${err.message}`); process.exit(1); });
