/**
 * fetch-statements.ts
 *
 * Reads statement-dates.json (written by the local statement-tracker browser
 * agent and committed to this repo) and merges statement data into
 * ar-snapshot.json.
 *
 * Updates each office's `lastStatementSent` field:
 *   { date, eStatementsSent, manualNoPrint, manualWithEmail, asOf }
 *
 * Then commits + pushes so the dashboard reflects the latest statement dates.
 *
 * Run after each statement-tracker batch:
 *   npx tsx scripts/fetch-statements.ts
 *   npx tsx scripts/fetch-statements.ts --dry-run   (no file writes or git ops)
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const DRY_RUN = process.argv.includes("--dry-run");
const __dirname = dirname(fileURLToPath(import.meta.url));

// When running locally from SH Agents root the paths point one level up;
// when running inside the rcm-dashboard repo (GitHub Actions) they're relative
// to the repo root (parent of scripts/).
const REPO_ROOT     = join(__dirname, "..");
const STMT_PATH     = join(REPO_ROOT, "statement-dates.json");
const SNAPSHOT_PATH = join(REPO_ROOT, "ar-snapshot.json");
const DASHBOARD_DIR = REPO_ROOT;

type StmtEntry = {
  date: string | null;
  eStatementsSent?: number;
  manualNoPrint?: number;
  manualWithEmail?: number;
  capturedAt?: string;
};

type StmtFile = {
  generated: string;
  offices: Record<string, StmtEntry>;
};

async function main() {
  console.log("\n📋 Merging statement dates into ar-snapshot.json…");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  if (!existsSync(STMT_PATH)) {
    // The browser agent runs locally and pushes statement-dates.json before
    // this workflow fires. If the file isn't there yet, exit cleanly so the
    // workflow doesn't fail — the next Friday run will pick it up.
    console.warn("⚠ statement-dates.json not found — statement-tracker agent hasn't run yet. Skipping.");
    return;
  }

  const stmtFile: StmtFile = JSON.parse(readFileSync(STMT_PATH, "utf8"));
  const offices = stmtFile.offices || {};
  const snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));

  let updated = 0;
  let skipped = 0;

  for (const [code, entry] of Object.entries(offices)) {
    if (!snapshot.offices?.[code]) {
      console.log(`  ⚠ ${code}: not found in ar-snapshot.json — skipping`);
      skipped++;
      continue;
    }

    if (!entry.date) {
      console.log(`  — ${code}: no valid statement date captured (green badge absent) — leaving existing`);
      skipped++;
      continue;
    }

    const prev = snapshot.offices[code].lastStatementSent;
    const prevDate = prev
      ? (typeof prev === "string" ? prev : (prev.date || prev.value || ""))
      : null;

    snapshot.offices[code].lastStatementSent = {
      date:            entry.date,
      eStatementsSent: entry.eStatementsSent ?? null,
      manualNoPrint:   entry.manualNoPrint   ?? 0,
      manualWithEmail: entry.manualWithEmail ?? 0,
      asOf:            entry.capturedAt || new Date().toISOString(),
    };

    const change = prevDate && prevDate !== entry.date ? ` (was ${prevDate})` : "";
    console.log(
      `  ✓ ${code.padEnd(5)} ${entry.date}  ` +
      `e=${entry.eStatementsSent ?? "?"}  ` +
      `noPrint=${entry.manualNoPrint ?? 0}  ` +
      `withEmail=${entry.manualWithEmail ?? 0}` +
      change
    );
    updated++;
  }

  console.log(`\n  ${updated} offices updated, ${skipped} skipped`);

  if (DRY_RUN) {
    console.log("\nDRY RUN — no files written, no git ops.");
    return;
  }

  // Write snapshot
  snapshot.generated = new Date().toISOString();
  writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2));
  console.log("\n✓ Wrote ar-snapshot.json");

  // Commit + push
  try {
    console.log("\n📤 Pushing to GitHub Pages…");
    execSync(`git add ar-snapshot.json statement-dates.json`, { cwd: DASHBOARD_DIR, stdio: "pipe" });
    try { execSync(`git stash`, { cwd: DASHBOARD_DIR, stdio: "pipe" }); } catch {}
    execSync(`git pull --rebase origin master`, { cwd: DASHBOARD_DIR, stdio: "pipe" });
    try { execSync(`git stash pop`, { cwd: DASHBOARD_DIR, stdio: "pipe" }); } catch {}
    execSync(`git add ar-snapshot.json statement-dates.json`, { cwd: DASHBOARD_DIR, stdio: "pipe" });
    execSync(
      `git commit -m "chore: update statement dates ${new Date().toLocaleDateString("en-US")}"`,
      { cwd: DASHBOARD_DIR, stdio: "pipe" }
    );
    execSync(`git push origin master`, { cwd: DASHBOARD_DIR, stdio: "pipe" });
    console.log("✅ Pushed.");
  } catch (err: any) {
    console.error(`⚠ Push failed: ${err.message?.slice(0, 300) ?? err}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
