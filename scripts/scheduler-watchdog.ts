// scheduler-watchdog.ts
// Runs late evening (9:30 PM CT) and verifies that today's scheduled refresh
// tasks actually fired. Creates a ClickUp alert task if something is stale.

import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { getClickUpToken } from "../lib/clickup-oauth.js";

const ALERT_LIST_ID = "901416373479";
const DRY_RUN = process.argv.includes("--dry-run");

const FILES_TO_CHECK = [
  { name: "ar-snapshot.json",     maxHrs: 26,  label: "AR snapshot" },
  { name: "kpi-snapshot.json",    maxHrs: 192, label: "KPI snapshot (weekly Mon)" },
  { name: "aging-alerts.json",    maxHrs: 26,  label: "Aging alerts" },
  { name: "resubmit-alerts.json", maxHrs: 26,  label: "Resubmit alerts" },
  { name: "posting-alerts.json",  maxHrs: 26,  label: "Posting alerts" },
];

function ctNowFriendly(): string {
  return new Date().toLocaleString("en-US", {
    timeZone: "America/Chicago", month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit",
  }) + " CT";
}

function main() {
  console.log(`\n🩺 Scheduler health check — ${ctNowFriendly()}`);
  const scriptDir    = dirname(fileURLToPath(import.meta.url));
  const dashboardDir = process.env.CI
    ? join(scriptDir, "..")
    : join(scriptDir, "..", "apps", "rcm-dashboard");

  const stale: { label: string; reason: string }[] = [];
  const now = Date.now();
  for (const f of FILES_TO_CHECK) {
    try {
      const data = JSON.parse(readFileSync(join(dashboardDir, f.name), "utf8"));
      const ts = data.generated || data.asOf;
      if (!ts) { stale.push({ label: f.label, reason: "no timestamp on file" }); continue; }
      const ageHrs = (now - new Date(ts).getTime()) / 3600000;
      if (ageHrs > f.maxHrs) {
        stale.push({ label: f.label, reason: `last updated ${ageHrs.toFixed(1)}h ago (max ${f.maxHrs}h)` });
      } else {
        console.log(`  ✓ ${f.label.padEnd(28)} ${ageHrs.toFixed(1)}h old (OK)`);
      }
    } catch (e: any) {
      stale.push({ label: f.label, reason: `read error: ${e.message?.slice(0, 200) ?? e}` });
    }
  }

  if (!stale.length) { console.log(`\n✅ All scheduled refreshes appear current.`); return; }

  console.log(`\n⚠ ${stale.length} stale file(s) detected:`);
  for (const s of stale) console.log(`  • ${s.label}: ${s.reason}`);

  if (DRY_RUN) { console.log(`\nDRY RUN — skipping ClickUp alert.`); return; }

  postAlert(stale).catch(e => console.error("Alert task creation failed:", e));
}

async function postAlert(stale: { label: string; reason: string }[]) {
  const token = await getClickUpToken();
  const H = { Authorization: token, "Content-Type": "application/json" };
  const todayCT = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
  const taskName = `⚠ Scheduler health alert — ${todayCT}`;

  const search = await fetch(`https://api.clickup.com/api/v2/list/${ALERT_LIST_ID}/task?include_closed=true&archived=false&subtasks=false&page=0`, { headers: { Authorization: token } });
  const existing = await search.json();
  const todayTask = (existing.tasks || []).find((t: any) => t.name === taskName);

  const desc = [
    `# Scheduler missed refresh — ${ctNowFriendly()}`,
    "",
    `One or more daily refresh scripts did not fire in their expected window.`,
    "",
    `## Affected files`,
    "", "| File | Status |", "|---|---|",
    ...stale.map(s => `| ${s.label} | ${s.reason} |`),
    "",
    `## Recovery`,
    "",
    `1. Check the GitHub Actions run log at https://github.com/smilehaus/rcm-dashboard/actions`,
    `2. Re-run the failed workflow from the Actions tab, or trigger manually via workflow_dispatch.`,
    `3. Verify the dashboard banner clears after the re-run.`,
  ].join("\n");

  if (todayTask) {
    await fetch(`https://api.clickup.com/api/v2/task/${todayTask.id}`, { method: "PUT", headers: H, body: JSON.stringify({ description: desc }) });
    console.log(`  ↻ Updated existing alert task ${todayTask.id}`);
  } else {
    const res = await fetch(`https://api.clickup.com/api/v2/list/${ALERT_LIST_ID}/task`, { method: "POST", headers: H, body: JSON.stringify({ name: taskName, description: desc, priority: 1, status: "to do" }) });
    const created = await res.json();
    console.log(`  ＋ Created alert task ${created.id}`);
    console.log(`  🔗 https://app.clickup.com/t/${created.id}`);
  }
}

main();
