/**
 * Publish a small set of JSON files to origin/master without merge commits.
 *
 * Several routines (and the backup job, and a laptop running the same
 * scripts) all push to master. The old pattern was `git stash` +
 * `pull --rebase` + `stash pop`, which writes conflict markers into the
 * file and the next `git add` committed them. The later `reset --hard`
 * rewrite avoided markers but still dropped the loser's update when push
 * was rejected — and the scripts swallowed that error, so the dashboard
 * kept serving stale JSON.
 *
 * This helper re-reads origin inside a retry loop, lets the caller apply
 * its change onto that latest tree, refuses conflict markers and broken
 * JSON, then pushes. A rejected push tries again against the new tip.
 */
import { execFileSync } from "child_process";
import { readFileSync, writeFileSync, renameSync } from "fs";
import { join } from "path";
import { assertPublishable } from "./json-guard.mjs";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function pushRejected(err) {
  const msg = `${err.stderr || ""}\n${err.message || ""}`;
  return /non-fast-forward|rejected|fetch first|failed to push|cannot lock ref|Updates were rejected/i.test(msg);
}

export function publishFiles({ cwd, message, paths, stage, retries = 5 }) {
  if (!paths?.length) throw new Error("publishFiles: no paths");
  let lastErr = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    git(cwd, ["fetch", "origin", "master"]);
    git(cwd, ["reset", "--hard", "origin/master"]);
    stage(cwd);
    for (const rel of paths) {
      const full = join(cwd, rel);
      const text = readFileSync(full, "utf8");
      assertPublishable(rel, text);
      const tmp = `${full}.tmp-publish`;
      writeFileSync(tmp, text.endsWith("\n") ? text : `${text}\n`);
      assertPublishable(rel, readFileSync(tmp, "utf8"));
      renameSync(tmp, full);
    }
    git(cwd, ["add", "--", ...paths]);
    const staged = git(cwd, ["diff", "--cached", "--name-only"]).trim();
    if (!staged) return { pushed: false, reason: "no changes" };
    git(cwd, ["-c", "user.email=rcm-publish@localhost", "-c", "user.name=rcm-publish", "commit", "-m", message]);
    try {
      git(cwd, ["push", "origin", "HEAD:master"]);
      return { pushed: true, attempt };
    } catch (err) {
      lastErr = err;
      if (pushRejected(err) && attempt < retries) continue;
      throw err;
    }
  }
  throw new Error(`git push failed after ${retries} attempts: ${lastErr?.stderr || lastErr?.message || lastErr}`);
}
