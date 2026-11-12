import test from "node:test";
import assert from "node:assert/strict";
import "../board-sync.js";

const B = globalThis.RCMBoard;

function person(id, dept) {
  return { id, name: id, dept: dept || "RCM", initials: id.slice(0, 2).toUpperCase() };
}

test("seed roster is the hardcoded 14 and nothing with IV dates", () => {
  const seed = { staff: B.SEED_STAFF_IDS.map(id => person(id, "")), ivDates: {} };
  assert.equal(B.looksLikeSeedRoster(seed), true);
  const real = { staff: [...seed.staff, person("aby")], ivDates: { SQ: "2026-10-01" } };
  assert.equal(B.looksLikeSeedRoster(real), false);
  assert.equal(B.shouldIgnoreRemote(real, seed), true);
  assert.equal(B.shouldIgnoreRemote(seed, seed), false);
});

test("stale active copy cannot revive someone marked inactive", () => {
  const base = { staff: [person("princess", "RCM")], staffArchive: [], ivDates: {}, offices: [], assign: {}, live: {} };
  const local = { staff: [person("princess", "RCM")], staffArchive: [], ivDates: {}, offices: [], assign: { ATX: { ins_verif: ["princess"] } }, live: {} };
  const remote = {
    staff: [{ ...person("princess", "Inactive"), inactiveReason: "Terminated" }],
    staffArchive: [{ id: "princess", name: "princess", inactiveReason: "Terminated", inactiveDate: "Sep 1" }],
    ivDates: { ATX: "2026-10-20" },
    offices: [{ code: "ATX", lbl: "ATX", name: "Austin" }],
    assign: { ATX: { ins_verif: [] } },
    live: {}
  };
  // local edited the cell (token added vs empty base cell) AND the person is inactive remotely
  base.assign = { ATX: { ins_verif: [] } };
  const merged = B.mergeBoardState(base, local, remote);
  const princess = merged.staff.find(s => s.id === "princess");
  assert.equal(princess.dept, "Inactive");
  assert.deepEqual(merged.assign.ATX.ins_verif, []);
  assert.equal(merged.ivDates.ATX, "2026-10-20");
});

test("tombstone survives a client that never heard about it", () => {
  const base = { staff: [person("aby")], staffArchive: [], offices: [], ivDates: {}, assign: {}, live: {} };
  const local = { staff: [person("aby"), person("princess", "RCM")], staffArchive: [], offices: [], ivDates: {}, assign: {}, live: {} };
  const remote = {
    staff: [person("aby")],
    staffArchive: [{ id: "princess", name: "Princess", inactiveReason: "Terminated", inactiveDate: "Aug 1" }],
    offices: [], ivDates: {}, assign: {}, live: {}
  };
  const merged = B.mergeBoardState(base, local, remote);
  assert.ok(merged.staffArchive.some(t => t.id === "princess"));
  const princess = merged.staff.find(s => s.id === "princess");
  assert.equal(princess.dept, "Inactive");
});

test("empty local IV map does not wipe remote dates", () => {
  const base = { staff: [], ivDates: {}, offices: [], assign: {}, live: {} };
  const local = { staff: [], ivDates: {}, offices: [], assign: {}, live: {} };
  const remote = { staff: [], ivDates: { SQ: "2026-10-22", GT: "2026-10-21" }, offices: [], assign: {}, live: {} };
  const merged = B.mergeBoardState(base, local, remote);
  assert.equal(merged.ivDates.SQ, "2026-10-22");
  assert.equal(merged.ivDates.GT, "2026-10-21");
});

test("a real IV edit still applies onto remote", () => {
  const base = { staff: [], ivDates: { SQ: "2026-10-01" }, offices: [], assign: {}, live: {} };
  const local = { staff: [], ivDates: { SQ: "2026-10-22" }, offices: [], assign: {}, live: {} };
  const remote = { staff: [], ivDates: { SQ: "2026-10-01", GT: "2026-10-20" }, offices: [], assign: {}, live: {} };
  const merged = B.mergeBoardState(base, local, remote);
  assert.equal(merged.ivDates.SQ, "2026-10-22");
  assert.equal(merged.ivDates.GT, "2026-10-20");
});

test("a client that never had Anderson Mill cannot drop it", () => {
  const offices = [
    { code: "SQ", lbl: "SQ", name: "On the Square" },
    { code: "AM", lbl: "AM", name: "Anderson Mill" }
  ];
  const without = offices.filter(o => o.code !== "AM");
  const base = { staff: [], offices: without, ivDates: {}, assign: {}, live: {} };
  const local = { staff: [], offices: without, ivDates: {}, assign: {}, live: {} };
  const remote = { staff: [], offices, ivDates: {}, assign: {}, live: {} };
  const merged = B.mergeBoardState(base, local, remote);
  assert.ok(merged.offices.some(o => o.code === "AM"));
});

test("an admin who removed an office they previously had is honored", () => {
  const am = { code: "AM", lbl: "AM", name: "Anderson Mill" };
  const base = { staff: [], offices: [am], ivDates: {}, assign: {}, live: {} };
  const local = { staff: [], offices: [], ivDates: {}, assign: {}, live: {} };
  const remote = { staff: [], offices: [am], ivDates: {}, assign: {}, live: {} };
  const merged = B.mergeBoardState(base, local, remote);
  assert.equal(merged.offices.some(o => o.code === "AM"), false);
});

test("seed write is refused when the server has a real roster", () => {
  const seed = { staff: B.SEED_STAFF_IDS.map(id => person(id)) };
  const real = { staff: [...seed.staff, person("aby")], ivDates: { SQ: "2026-10-01" } };
  assert.equal(B.writeWouldClobberRoster(seed, real), true);
  assert.equal(B.writeWouldClobberRoster(real, real), false);
});

test("older build cannot write over a newer minimum", () => {
  assert.equal(B.clientMayWrite(2026111201, { _minBuild: 2026111202 }), false);
  assert.equal(B.clientMayWrite(2026111201, { _minBuild: 2026111201 }), true);
});

test("empty cells round-trip through the firebase placeholder", () => {
  const state = { assign: { SQ: { ins_verif: [] } }, live: {}, lunch: [], off: ["aby"] };
  B.encodeEmpties(state);
  assert.deepEqual(state.assign.SQ.ins_verif, [B.EMPTY_CELL]);
  assert.deepEqual(state.lunch, [B.EMPTY_CELL]);
  assert.deepEqual(state.off, ["aby"]);
  B.decodeEmpties(state);
  assert.deepEqual(state.assign.SQ.ins_verif, []);
  assert.deepEqual(state.lunch, []);
  assert.deepEqual(state.off, ["aby"]);
});

test("concurrent token adds to the same cell both survive", () => {
  const base = { staff: [], offices: [], ivDates: {}, assign: { SQ: { ins_verif: ["a"] } }, live: {} };
  const local = { staff: [], offices: [], ivDates: {}, assign: { SQ: { ins_verif: ["a", "b"] } }, live: {} };
  const remote = { staff: [], offices: [], ivDates: {}, assign: { SQ: { ins_verif: ["a", "c"] } }, live: {} };
  const merged = B.mergeBoardState(base, local, remote);
  assert.deepEqual(merged.assign.SQ.ins_verif, ["a", "c", "b"]);
});
