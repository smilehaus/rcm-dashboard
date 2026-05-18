/**
 * Timely Filing Deadline Flag — Daily Priority Script
 * Scans all Master Aging INS AR lists and marks claims based on DOS age.
 */

import { getClickUpToken } from "../lib/clickup-oauth.js";
import { writeFileSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const CLICKUP_BASE = "https://api.clickup.com/api/v2";
const DOS_FIELD_ID = "80e9173a-e6c5-4815-a0e7-18e69255bec5";
const TIMELY_FILING_DAYS = 365;
const WARNING_DAYS = 7;
const CUTOFF_DAYS = TIMELY_FILING_DAYS - WARNING_DAYS;
const PRIORITY_URGENT = 1;
const OVERDUE_TAG = "OVERDUE";
const OVERDUE_FLOOR = new Date("2025-01-01T00:00:00Z").getTime();
const AGING_STATUS_FIELD_ID = "830bff4a-37c3-41ca-9e38-2f63a9a08a55";
const PMS_FIELD_ID = "4e365613-1fac-481e-8e71-3a1cab327cf9";

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

function hasTag(task: any, tagName: string): boolean {
  return task.tags?.some((t: any) => t.name.toLowerCase() === tagName.toLowerCase()) ?? false;
}

async function addTag(taskId: string, tag: string): Promise<void> {
  await clickupApi(`/task/${taskId}/tag/${encodeURIComponent(tag)}`, { method: "POST" });
}

async function main() {
  const now = Date.now();
  const cutoffMs = CUTOFF_DAYS * 86400000;
  const deadlineMs = TIMELY_FILING_DAYS * 86400000;

  console.log(`\n🔴 Timely Filing Deadline Flag`);
  console.log(`📅 Today: ${new Date().toLocaleDateString("en-US")}`);
  if (DRY_RUN) console.log(`🧪 DRY RUN\n`);

  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const dashboardDir = process.env.CI
    ? join(scriptDir, "..")
    : join(scriptDir, "..", "apps", "rcm-dashboard");
  const dashboardPath = join(dashboardDir, "aging-alerts.json");

  let totalFlaggedUrgent = 0, totalTaggedOverdue = 0, totalSkippedUrgent = 0, totalSkippedOverdue = 0, totalScanned = 0;

  for (const [office, listId] of Object.entries(INS_AR_LISTS)) {
    const tasks = await getAllTasks(listId);
    let officeFlagged = 0, officeOverdue = 0;
    for (const task of tasks) {
      totalScanned++;
      const dosField = task.custom_fields?.find((f: any) => f.id === DOS_FIELD_ID);
      if (!dosField?.value) continue;
      const dosMs = Number(dosField.value);
      const ageMs = now - dosMs;
      const ageDays = Math.floor(ageMs / 86400000);
      const dosDate = new Date(dosMs).toLocaleDateString("en-US", { timeZone: "UTC", month: "2-digit", day: "2-digit", year: "numeric" });

      if (ageMs >= deadlineMs && dosMs >= OVERDUE_FLOOR) {
        if (hasTag(task, OVERDUE_TAG)) { totalSkippedOverdue++; }
        else {
          if (!DRY_RUN) await addTag(task.id, OVERDUE_TAG);
          console.log(`  ${DRY_RUN ? "[DRY]" : "🏷️ "} ${office} | ${task.name} | DOS: ${dosDate} (${ageDays}d) → OVERDUE`);
          officeOverdue++;
        }
        if (task.priority?.id !== String(PRIORITY_URGENT)) {
          if (!DRY_RUN) await clickupApi(`/task/${task.id}`, { method: "PUT", body: JSON.stringify({ priority: PRIORITY_URGENT }) });
          officeFlagged++;
        } else { totalSkippedUrgent++; }
        continue;
      }
      if (ageMs >= cutoffMs && ageMs < deadlineMs) {
        if (task.priority?.id === String(PRIORITY_URGENT)) { totalSkippedUrgent++; continue; }
        const daysLeft = TIMELY_FILING_DAYS - ageDays;
        if (!DRY_RUN) await clickupApi(`/task/${task.id}`, { method: "PUT", body: JSON.stringify({ priority: PRIORITY_URGENT }) });
        console.log(`  ${DRY_RUN ? "[DRY]" : "⚠️ "} ${office} | ${task.name} | DOS: ${dosDate} (${ageDays}d) — ${daysLeft}d left → Urgent`);
        officeFlagged++;
      }
    }
    totalFlaggedUrgent += officeFlagged; totalTaggedOverdue += officeOverdue;
    if (officeFlagged > 0 || officeOverdue > 0) console.log(`  ${office}: ${officeFlagged} urgent, ${officeOverdue} overdue`);
  }

  console.log(`\n📊 Scanned: ${totalScanned} · Urgent: ${totalFlaggedUrgent} · OVERDUE: ${totalTaggedOverdue}`);

  // Generate aging-alerts.json
  type PmsBucket = { overdue: number; priority: number };
  type OfficeData = { oryx: PmsBucket; legacy: PmsBucket };
  const dashData: Record<string, OfficeData> = {};

  for (const [office, listId] of Object.entries(INS_AR_LISTS)) {
    dashData[office] = { oryx: { overdue: 0, priority: 0 }, legacy: { overdue: 0, priority: 0 } };
    const tasks = await getAllTasks(listId);
    for (const t of tasks) {
      if (t.status?.status !== "new / unworked") continue;
      if (t.priority?.id !== "1") continue;
      const agingStatusField = t.custom_fields?.find((f: any) => f.id === AGING_STATUS_FIELD_ID);
      if (agingStatusField?.value != null && agingStatusField.value !== "") continue;
      const pmsField = t.custom_fields?.find((f: any) => f.id === PMS_FIELD_ID);
      let pmsName = "";
      if (pmsField?.value != null && pmsField.type_config?.options) {
        const opt = pmsField.type_config.options.find((o: any) => o.orderindex === pmsField.value);
        pmsName = (opt?.name || "").toLowerCase();
      }
      const bucket = pmsName.includes("oryx") ? dashData[office].oryx : dashData[office].legacy;
      const isOverdue = (t.tags || []).some((tag: any) => tag.name.toUpperCase() === "OVERDUE");
      if (isOverdue) bucket.overdue++;
      else bucket.priority++;
    }
  }

  const jsonPayload = { generated: new Date().toISOString(), offices: dashData };
  writeFileSync(dashboardPath, JSON.stringify(jsonPayload, null, 2));
  console.log(`✅ aging-alerts.json written`);

  if (!DRY_RUN) {
    try {
      const freshFile = readFileSync(dashboardPath, "utf8");
      execSync(`git fetch origin master`, { cwd: dashboardDir, stdio: "pipe" });
      execSync(`git reset --hard origin/master`, { cwd: dashboardDir, stdio: "pipe" });
      writeFileSync(dashboardPath, freshFile);
      execSync(`git add aging-alerts.json`, { cwd: dashboardDir, stdio: "pipe" });
      execSync(`git commit -m "chore: update aging-alerts ${new Date().toLocaleDateString("en-US")}"`, { cwd: dashboardDir, stdio: "pipe" });
      execSync(`git push origin master`, { cwd: dashboardDir, stdio: "pipe" });
      console.log(`✅ Pushed.`);
    } catch (e: any) {
      if (e.message?.includes("nothing to commit")) console.log(`ℹ️  No changes`);
      else console.error(`⚠️  Git push failed: ${e.message}`);
    }
  }
}

main().catch((err) => { console.error(`\n❌ ERROR: ${err.message}`); process.exit(1); });
