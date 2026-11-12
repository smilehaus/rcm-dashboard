import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isEditorRole } from "../workers/editor-auth/src/policy.js";
import { hashPin, isStoredSecret } from "../workers/editor-auth/src/pin-hash.js";
import { planEditorSeeds, seedReport } from "./lib/editor-pin-seed.mjs";

test("current roster editors exclude Aging team and inactive managers", () => {
  const roster = JSON.parse(readFileSync(new URL("../board-baseline.json", import.meta.url), "utf8"));
  const plan = planEditorSeeds(roster.staff, [], isEditorRole);
  const names = plan.missing.map((row) => row.name).sort();
  assert.deepEqual(names, ["Aby", "Adela", "Becky", "Karina", "Kelly Rodriguez", "Lacy"]);
  assert.equal(names.includes("Yasmine"), false);
  assert.equal(names.includes("Gianna"), false);
});

test("an old title on the PIN source cannot add an editor", () => {
  const roster = [
    { id: "y", name: "Yasmine", role: "Aging team", dept: "Management" },
    { id: "g", name: "Gianna", role: "Office Manager", dept: "Inactive" },
    { id: "a", name: "Aby", role: "REACH Manager", dept: "Management" }
  ];
  const pins = [
    { id: "y", role: "Office Manager", pin: "9999" },
    { id: "g", role: "Office Manager", pin: "8888" },
    { id: "a", role: "REACH Manager", pin: "1111" }
  ];
  const plan = planEditorSeeds(roster, pins, isEditorRole);
  const report = seedReport(plan);
  assert.deepEqual(report.ready, [{ id: "a", name: "Aby", role: "REACH Manager" }]);
  assert.deepEqual(report.missing, []);
  assert.equal(JSON.stringify(report).includes("9999"), false);
  assert.equal(JSON.stringify(report).includes("1111"), false);
});

test("hashed PIN material is what the worker will store", async () => {
  const hashed = await hashPin("1111");
  assert.equal(isStoredSecret(hashed.hash), true);
  assert.equal(isStoredSecret(hashed.salt), true);
  assert.equal(hashed.hash.includes("1111"), false);
});
