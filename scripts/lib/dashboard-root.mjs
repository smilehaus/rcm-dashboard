import { existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

/**
 * GitHub Actions checks this repo out as the dashboard itself (CI=true).
 * A local monorepo checkout keeps the dashboard at apps/rcm-dashboard.
 * Prefer the layout that actually contains index.html so a local run
 * cannot commit into the wrong tree.
 */
export function resolveDashboardRoot(scriptFileUrl) {
  const scriptDir = dirname(fileURLToPath(scriptFileUrl));
  const repoRoot = scriptDir.endsWith(`${join("scripts", "lib")}`) || scriptDir.endsWith("/scripts/lib")
    ? join(scriptDir, "..", "..")
    : join(scriptDir, "..");
  const nested = join(repoRoot, "apps", "rcm-dashboard");
  if (!process.env.CI && existsSync(join(nested, "index.html"))) return nested;
  return repoRoot;
}
