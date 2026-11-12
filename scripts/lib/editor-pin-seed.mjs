/** Pick editors from the current roster and attach check-in PINs by staff id. */

export function planEditorSeeds(rosterStaff, pinStaff, isEditorRole) {
  const pins = new Map();
  for (const person of pinStaff || []) {
    if (!person || !person.id || typeof person.pin !== "string") continue;
    const pin = person.pin.trim();
    if (pin) pins.set(person.id, pin);
  }
  const ready = [];
  const missing = [];
  for (const person of rosterStaff || []) {
    if (!person || !person.id || person.dept === "Inactive") continue;
    if (!isEditorRole(person.role)) continue;
    const row = {
      id: person.id,
      name: person.name || person.id,
      role: String(person.role).trim()
    };
    const pin = pins.get(person.id);
    if (!pin) missing.push(row);
    else ready.push({ ...row, pin });
  }
  return { ready, missing };
}

export function seedReport(plan) {
  const hide = ({ id, name, role }) => ({ id, name, role });
  return {
    ready: plan.ready.map(hide),
    missing: plan.missing.map(hide)
  };
}
