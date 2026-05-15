/**
 * Posting Completion % — Dashboard Data Script
 *
 * Fetches the current pay period's EOB/ERA Posting Goals from ClickUp,
 * extracts Completion % per office, and writes posting-alerts.json
 * for the RCM Dashboard.
 */

import { getClickUpToken } from "../lib/clickup-oauth.js";
import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const CLICKUP_BASE = "https://api.clickup.com/api/v2";
const POSTING_GOALS_LIST = "901414704146";
const COMPLETION_FIELD_ID = "00c8f2c8-7952-47e3-b029-b064eb077a87";
const COLLECTION_FIELD_ID = "8bfa3bc0-7757-4194-a42f-9e35d00dc802";
const PRODUCTION_FIELD_ID = "64458005-803f-457f-b093-14fc9a05e2f7";

const DRY_RUN = process.argv.includes("--dry-run");

const OFFICE_NAME_MAP: Record<string, string> = {
  SQ: "SQ", GT: "GT", ATX: "ATX", MP: "MP", NBDA: "NBDA",
  IC: "IC", AR: "AR", PF: "PF", "S.ATX": "SATX", SATX: "SATX", AM: "AM",
};

async function clickupApi(path: string): Promise<any> {
  const token = await getClickUpToken();
  const res = await fetch(`${CLICKUP_BASE}${path}`, {
    headers: { Authorization: token, "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`ClickUp API ${res.status}: ${await res.text()}`);
  return res.json();
}

async function main() {
  console.log(`\n📊 Posting Completion % — Dashboard Data`);
  if (DRY_RUN) console.log(`🧪 DRY RUN — no files will be written\n`);

  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const dashboardDir = process.env.CI
    ? join(scriptDir, "..")
    : join(scriptDir, "..", "apps", "rcm-dashboard");
  const dashboardPath = join(dashboardDir, "posting-alerts.json");

  const data = await clickupApi(
    `/list/${POSTING_GOALS_LIST}/task?subtasks=true&page=0&limit=100&include_closed=false`
  );
  const parentTasks = data.tasks
    .filter((t: any) => !t.parent)
    .sort((a: any, b: any) => (Number(b.due_date) || 0) - (Number(a.due_date) || 0));
  const parentTask = parentTasks[0];
  if (!parentTask) { console.log("❌ No parent pay period task found"); process.exit(1); }
  console.log(`📅 Pay Period: ${parentTask.name}`);

  const parentFull = await clickupApi(`/task/${parentTask.id}?include_subtasks=true`);
  const officeSubtasks = parentFull.subtasks || [];
  const postingData: Record<string, { pct: number; label: string }> = {};

  for (const sub of officeSubtasks) {
    const officeCode = OFFICE_NAME_MAP[sub.name?.trim()];
    if (!officeCode) continue;
    const fullSub = await clickupApi(`/task/${sub.id}?include_subtasks=true`);
    const compField = fullSub.custom_fields?.find((f: any) => f.id === COMPLETION_FIELD_ID);
    let pct = parseFloat((compField?.value || "").replace("%", "")) || 0;
    let source = "custom field";
    if (!pct) {
      const coll = parseFloat(fullSub.custom_fields?.find((f: any) => f.id === COLLECTION_FIELD_ID)?.value || "0") || 0;
      const prod = parseFloat(fullSub.custom_fields?.find((f: any) => f.id === PRODUCTION_FIELD_ID)?.value || "0") || 0;
      if (prod > 0 && coll > 0) { pct = (coll / prod) * 100; source = "collection/production"; }
    }
    if (!pct && fullSub.subtasks?.length) {
      const doctorPcts: number[] = [];
      for (const ds of fullSub.subtasks) {
        const fullDs = await clickupApi(`/task/${ds.id}`);
        const dsPct = parseFloat((fullDs.custom_fields?.find((f: any) => f.id === COMPLETION_FIELD_ID)?.value || "").replace("%", "")) || 0;
        if (dsPct > 0) doctorPcts.push(dsPct);
      }
      if (doctorPcts.length) { pct = doctorPcts.reduce((a, b) => a + b, 0) / doctorPcts.length; source = "doctor avg"; }
    }
    const rounded = Math.round(pct * 10) / 10;
    postingData[officeCode] = { pct: rounded, label: rounded > 0 ? `${rounded}%` : "0%" };
    const icon = pct < 50 ? "🔴" : pct < 75 ? "🟡" : pct < 90 ? "⚪" : "🟢";
    console.log(`  ${icon} ${officeCode}: ${rounded}%${source !== "custom field" ? ` (via ${source})` : ""}`);
  }

  const jsonPayload = { generated: new Date().toISOString(), payPeriod: parentTask.name, offices: postingData };

  if (DRY_RUN) {
    console.log(`\n🧪 Would write to ${dashboardPath}`);
    return;
  }

  writeFileSync(dashboardPath, JSON.stringify(jsonPayload, null, 2));
  console.log(`✅ posting-alerts.json written`);

  try {
    console.log(`\n📤 Pushing to GitHub Pages...`);
    execSync(`git add posting-alerts.json`, { cwd: dashboardDir, stdio: "pipe" });
    try { execSync(`git stash`, { cwd: dashboardDir, stdio: "pipe" }); } catch {}
    execSync(`git pull --rebase origin master`, { cwd: dashboardDir, stdio: "pipe" });
    try { execSync(`git stash pop`, { cwd: dashboardDir, stdio: "pipe" }); } catch {}
    execSync(`git add posting-alerts.json`, { cwd: dashboardDir, stdio: "pipe" });
    execSync(`git commit -m "chore: update posting-alerts ${new Date().toLocaleDateString("en-US")}"`, { cwd: dashboardDir, stdio: "pipe" });
    execSync(`git push origin master`, { cwd: dashboardDir, stdio: "pipe" });
    console.log(`✅ Pushed.`);
  } catch (e: any) {
    if (e.message?.includes("nothing to commit")) console.log(`ℹ️  No changes to push`);
    else console.error(`⚠️  Git push failed: ${e.message}`);
  }
}

main().catch((err) => { console.error(`\n❌ ERROR: ${err.message}`); process.exit(1); });
