import test from "node:test";
import assert from "node:assert/strict";
import { isEditorRole, isLocked, registerFailure } from "./src/policy.js";
import { hashPin, pinMatches } from "./src/pin-hash.js";

test("editor roles match titles, not names", () => {
  assert.equal(isEditorRole("RCM Manager"), true);
  assert.equal(isEditorRole("REACH Manager"), true);
  assert.equal(isEditorRole("Office Manager"), true);
  assert.equal(isEditorRole("Operations Manager"), true);
  assert.equal(isEditorRole("Ops Manager"), true);
  assert.equal(isEditorRole("Executive"), true);
  assert.equal(isEditorRole("Ins Verifier"), false);
  assert.equal(isEditorRole("Regional Manager - North"), false);
  assert.equal(isEditorRole(""), false);
});

test("five bad attempts lock the staff id", () => {
  let state = null;
  const start = 1_000_000;
  for (let i = 0; i < 4; i++) {
    const step = registerFailure(state, start + i);
    assert.equal(step.locked, false);
    state = step.state;
  }
  const locked = registerFailure(state, start + 4);
  assert.equal(locked.locked, true);
  assert.equal(isLocked(locked.state, start + 5), true);
  assert.equal(isLocked(locked.state, locked.state.lockUntil + 1), false);
});

test("pin hash matches only the same pin", async () => {
  const stored = await hashPin("1234");
  assert.equal(await pinMatches("1234", stored), true);
  assert.equal(await pinMatches("9999", stored), false);
  assert.equal(stored.hash.includes("1234"), false);
});
