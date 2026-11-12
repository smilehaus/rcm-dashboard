import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execFileSync } from "child_process";
import { publishFiles } from "./lib/git-publish.mjs";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function makeOrigin() {
  const root = mkdtempSync(join(tmpdir(), "rcm-pub-"));
  const bare = join(root, "origin.git");
  const seed = join(root, "seed");
  git(root, ["init", "--bare", "-b", "master", bare]);
  git(root, ["clone", bare, seed]);
  writeFileSync(join(seed, "aging-alerts.json"), JSON.stringify({ generated: "2026-10-01T00:00:00.000Z", offices: {} }, null, 2) + "\n");
  writeFileSync(join(seed, "ar-snapshot.json"), JSON.stringify({
    generated: "2026-10-01T00:00:00.000Z",
    offices: { SQ: { unposted: { total: 1 }, legacy: [{ total: 2 }] } }
  }, null, 2) + "\n");
  git(seed, ["-c", "user.email=t@t", "-c", "user.name=t", "add", "."]);
  git(seed, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "seed"]);
  git(seed, ["push", "origin", "master"]);
  return { root, bare };
}

test("refuses to commit conflict markers", () => {
  const { root, bare } = makeOrigin();
  const clone = join(root, "clone");
  git(root, ["clone", bare, clone]);
  assert.throws(() => publishFiles({
    cwd: clone,
    message: "bad",
    paths: ["aging-alerts.json"],
    stage(dir) {
      writeFileSync(join(dir, "aging-alerts.json"), "{\n<<<<<<< Updated upstream\n}\n");
    }
  }), /conflict markers/);
  const tip = git(bare, ["log", "-1", "--format=%s"]);
  assert.match(tip, /seed/);
  rmSync(root, { recursive: true, force: true });
});

test("two publishers racing keep both files", async () => {
  const { root, bare } = makeOrigin();
  const a = join(root, "a");
  const b = join(root, "b");
  git(root, ["clone", bare, a]);
  git(root, ["clone", bare, b]);
  await Promise.all([
    Promise.resolve().then(() => publishFiles({
      cwd: a,
      message: "aging",
      paths: ["aging-alerts.json"],
      stage(dir) {
        writeFileSync(join(dir, "aging-alerts.json"), JSON.stringify({
          generated: "2026-11-12T00:00:00.000Z", offices: { SQ: { overdue: 1 } }
        }, null, 2));
      }
    })),
    Promise.resolve().then(() => publishFiles({
      cwd: b,
      message: "snapshot patch",
      paths: ["ar-snapshot.json"],
      stage(dir) {
        const data = JSON.parse(readFileSync(join(dir, "ar-snapshot.json"), "utf8"));
        data.generated = "2026-11-12T01:00:00.000Z";
        data.offices.SQ.unposted = { total: 9 };
        writeFileSync(join(dir, "ar-snapshot.json"), JSON.stringify(data, null, 2));
      }
    }))
  ]);
  const check = join(root, "check");
  git(root, ["clone", bare, check]);
  const aging = JSON.parse(readFileSync(join(check, "aging-alerts.json"), "utf8"));
  const snap = JSON.parse(readFileSync(join(check, "ar-snapshot.json"), "utf8"));
  assert.equal(aging.generated, "2026-11-12T00:00:00.000Z");
  assert.equal(snap.offices.SQ.unposted.total, 9);
  assert.equal(snap.offices.SQ.legacy[0].total, 2);
  rmSync(root, { recursive: true, force: true });
});
