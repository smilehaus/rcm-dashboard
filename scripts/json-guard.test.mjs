import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { findConflictMarkers, assertPublishable, parseDashboardJson } from "./lib/json-guard.mjs";

test("conflict markers are rejected before a commit", () => {
  const text = `{
<<<<<<< Updated upstream
  "generated": "2026-09-30T10:43:10.912Z",
=======
  "generated": "2026-09-30T16:49:33.253Z",
>>>>>>> Stashed changes
  "offices": {}
}
`;
  const lines = findConflictMarkers(text);
  assert.ok(lines.length >= 3);
  assert.throws(() => parseDashboardJson(text, "resubmit-alerts.json"), /conflict markers/);
});

test("valid alert file passes schema", () => {
  const text = JSON.stringify({ generated: "2026-10-05T00:00:00.000Z", offices: { SQ: {} } }, null, 2);
  const data = assertPublishable("aging-alerts.json", text);
  assert.equal(data.generated.startsWith("2026-10-05"), true);
});

test("alert file missing generated fails schema", () => {
  const text = JSON.stringify({ offices: {} });
  assert.throws(() => assertPublishable("posting-alerts.json", text), /schema/);
});

test("checked-in baseline is a real roster, not the seed", () => {
  const text = readFileSync(new URL("../board-baseline.json", import.meta.url), "utf8");
  const data = assertPublishable("board-baseline.json", text);
  const ids = new Set(data.staff.map(s => s.id));
  assert.ok(ids.size > 14);
  assert.ok(Object.keys(data.ivDates).length >= 10);
  assert.equal(JSON.stringify(data).includes("\"pin\""), false);
  const archived = new Set((data.staffArchive || []).map(t => t.id));
  for (const [office, cols] of Object.entries(data.assign || {})) {
    for (const arr of Object.values(cols)) {
      for (const id of arr) assert.equal(archived.has(id), false, `${id} token still on ${office}`);
    }
  }
});

test("build.json has a numeric minimum", () => {
  const text = readFileSync(new URL("../build.json", import.meta.url), "utf8");
  const data = assertPublishable("build.json", text);
  assert.equal(data.build, data.minBuild);
});
