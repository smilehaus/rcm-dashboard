// backup-ar-snapshot-to-clickup.ts
//
// Off-site redundancy: creates one ClickUp task per day in "📚 AR Snapshot Backups"
// list (901416373479), attaches all dashboard JSON files, fills description with
// org-wide totals + change summary, marks task Complete.
//
// Run after archive-ar-snapshot.ts (which writes the history entry).
// NEVER deletes tasks, attachments, or comments — history is preserved cumulatively.

import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { getClickUpToken } from "../lib/clickup-oauth.js";

const LIST_ID = "901416373479";
const DRY_RUN = process.argv.includes("--dry-run");

// Always auto-detect slot from current CT time (same rule as archive-ar-snapshot.ts).
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

function fmtMoney(n: number | null | undefined): string {
  if (n == null) return "—";
  return "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function ctNowFriendly(): string {
  return new Date().toLocaleString("en-US", {
    timeZone: "America/Chicago", month: "numeric", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit",
  }) + " CT";
}

function sumOfficeTotals(offices: Record<string, any>) {
  let o = 0, p = 0, ins = 0, u26 = 0, uTotal = 0;
  for (const office of Object.values(offices || {})) {
    o     += Number(office?.outstanding?.total ?? 0);
    p     += Number(office?.patients?.total    ?? 0);
    ins   += Number(office?.insurance?.total   ?? 0);
    u26   += Number(office?.unposted?.y2026    ?? 0);
    uTotal+= Number(office?.unposted?.total    ?? 0);
  }
  return { outstanding: o, patients: p, insurance: ins, unposted2026: u26, unpostedTotal: uTotal };
}

function buildDescription(entry: any, prev: any | null): string {
  const cur = sumOfficeTotals(entry.offices);
  const cmp = prev ? sumOfficeTotals(prev.offices) : null;
  const lines: string[] = [];
  lines.push(`# AR Snapshot — ${entry.date}`, "", `**Captured:** ${entry.asOf || entry.generated}`, `**Offices included:** ${Object.keys(entry.offices || {}).length}`, "", `## Org-wide totals`, "", `| Metric | Value | vs ${prev?.date ?? "—"} |`, `|---|---|---|`);
  const slotOrder: Record<string, number> = { AM: 0, PM: 1 };
  function row(label: string, key: keyof typeof cur) {
    const v = cur[key];
    let delta = "—";
    if (cmp) {
      const d = v - cmp[key];
      const sign = d > 0 ? "▲" : d < 0 ? "▼" : "·";
      const pct = cmp[key] === 0 ? "" : ` (${d > 0 ? "+" : ""}${((d / Math.abs(cmp[key])) * 100).toFixed(1)}%)`;
      delta = `${sign} ${fmtMoney(Math.abs(d))}${pct}`;
    }
    lines.push(`| ${label} | ${fmtMoney(v)} | ${delta} |`);
  }
  row("Total Outstanding", "outstanding");
  row("Patient Balances", "patients");
  row("Insurance Balances", "insurance");
  row("Unposted '26", "unposted2026");
  row("Unposted Total", "unpostedTotal");
  lines.push("", `## Per-office totals`, "", "| Office | Total Outstanding | Unposted '26 |", "|---|---|---|");
  for (const [code, off] of Object.entries(entry.offices || {})) {
    lines.push(`| ${code} | ${fmtMoney((off as any)?.outstanding?.total)} | ${fmtMoney((off as any)?.unposted?.y2026)} |`);
  }
  lines.push("", `---`, `*Source: ar-snapshot.json. Full JSON attached.*`);
  return lines.join("\n");
}

async function main() {
  console.log(`\n☁  Backing up AR snapshot to ClickUp list ${LIST_ID}…`);
  const scriptDir    = dirname(fileURLToPath(import.meta.url));
  const dashboardDir = process.env.CI
    ? join(scriptDir, "..")
    : join(scriptDir, "..", "apps", "rcm-dashboard");
  const snapshotPath = join(dashboardDir, "ar-snapshot.json");
  const snapshot     = JSON.parse(readFileSync(snapshotPath, "utf8"));

  const history = Array.isArray(snapshot.perOfficeHistory) ? snapshot.perOfficeHistory : [];
  if (!history.length) { console.warn("  ⚠ perOfficeHistory is empty. Run archive-ar-snapshot.ts first."); return; }

  const entryDate  = resolveEntryDate(SLOT);
  const slotOrder: Record<string, number> = { AM: 0, PM: 1 };
  function rank(h: any) { return `${h.date}#${(slotOrder[h.slot] ?? 2).toString()}`; }
  const todaysEntry = history.find((h: any) => h.date === entryDate && (h.slot || null) === SLOT) || history[history.length - 1];
  const todayRank   = rank(todaysEntry);
  const prev        = [...history].filter((h: any) => rank(h) < todayRank).sort((a: any, b: any) => rank(a).localeCompare(rank(b))).pop() || null;

  const token = await getClickUpToken();
  const H = { Authorization: token, "Content-Type": "application/json" };
  const slotLabel  = todaysEntry.slot ? ` ${todaysEntry.slot}` : "";
  const taskName   = `AR Snapshot ${todaysEntry.date}${slotLabel}`;
  const search     = await fetch(`https://api.clickup.com/api/v2/list/${LIST_ID}/task?include_closed=true&archived=false&subtasks=false&page=0`, { headers: { Authorization: token } });
  const existing   = await search.json();
  const todayTask  = (existing.tasks || []).find((t: any) => t.name === taskName);
  const description = buildDescription(todaysEntry, prev);

  console.log(`  📝 Task: ${taskName}  (${todayTask ? "update" : "create"})`);
  if (DRY_RUN) { console.log("\nDRY RUN — skipping write."); return; }

  let taskId: string;
  if (todayTask) {
    taskId = todayTask.id;
    await fetch(`https://api.clickup.com/api/v2/task/${taskId}`, { method: "PUT", headers: H, body: JSON.stringify({ description }) });
  } else {
    const res = await fetch(`https://api.clickup.com/api/v2/list/${LIST_ID}/task`, { method: "POST", headers: H, body: JSON.stringify({ name: taskName, description, status: "to do" }) });
    const created = await res.json();
    taskId = created.id;
    console.log(`  ✓ Created ${taskId}`);
  }

  const slotSuffix = slotLabel.toLowerCase().replace(" ", "-");
  const FILES_TO_ATTACH = [
    { name: "ar-snapshot.json",       label: "AR snapshot (live state + history)" },
    { name: "ar-history-backup.json", label: "AR history standalone backup" },
    { name: "kpi-snapshot.json",      label: "Weekly office KPIs" },
    { name: "aging-alerts.json",      label: "Timely filing alerts" },
    { name: "resubmit-alerts.json",   label: "Resubmit claims alerts" },
    { name: "posting-alerts.json",    label: "Posting completion %" },
    { name: "state.json",             label: "Live dashboard state" },
  ];
  let uploaded = 0;
  for (const f of FILES_TO_ATTACH) {
    let fileBuf: Buffer;
    try { fileBuf = readFileSync(join(dashboardDir, f.name)); }
    catch { console.warn(`  ⚠ skip ${f.name} — not found`); continue; }
    const attachName = `${f.name.replace(/\.json$/, "")}-${todaysEntry.date}${slotSuffix}.json`;
    process.stdout.write(`  📎 ${f.name} (${(fileBuf.length / 1024).toFixed(1)} KB)… `);
    const fd = new FormData();
    fd.append("attachment", new Blob([fileBuf], { type: "application/json" }), attachName);
    const upRes = await fetch(`https://api.clickup.com/api/v2/task/${taskId}/attachment`, { method: "POST", headers: { Authorization: token }, body: fd as any });
    console.log(upRes.ok ? "✓" : `✗ ${upRes.status}`);
    if (upRes.ok) uploaded++;
  }
  console.log(`  ${uploaded}/${FILES_TO_ATTACH.length} files attached.`);

  const closeRes = await fetch(`https://api.clickup.com/api/v2/task/${taskId}`, { method: "PUT", headers: H, body: JSON.stringify({ status: "complete" }) });
  console.log(closeRes.ok ? `  ✅ Done` : `  ⚠ Status update failed: ${closeRes.status}`);
  console.log(`\n🔗 https://app.clickup.com/t/${taskId}`);
}

main().catch(e => { console.error(e); process.exit(1); });
