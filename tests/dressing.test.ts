import { test } from "node:test";
import assert from "node:assert/strict";
import { serializeLuaAssignment } from "../src/miz/serializer.js";
import { asTable, luaArray, parseLuaAssignment, type LuaTable } from "../src/miz/lua.js";
import { addAircraftGroup, addGroundGroup, findGroup, findUnit, newMissionTable } from "../src/miz/authoring.js";
import {
  addFarp,
  addTargetArea,
  findNavalTemplate,
  NAVAL_TEMPLATES,
  populateAirfield,
  TARGET_TEMPLATES,
} from "../src/miz/dressing.js";
import { addStatic } from "../src/miz/editing.js";
import { buildMissionDocument } from "../src/miz/parser.js";
import { validateMission } from "../src/miz/validator.js";
import { findAirport, findUnitType } from "../src/data/reference.js";

const blue = { side: "blue" as const, country: "USA" };
const roundTrip = (m: LuaTable) => parseLuaAssignment(serializeLuaAssignment("mission", m), "mission");
const firstPoint = (m: LuaTable, g: string) =>
  asTable(asTable(asTable(findGroup(m, g)!.group["route"])!["points"])![1])!;

test("FARP: heliport static with ATC fields; helicopters link to it", () => {
  const m = newMissionTable("Caucasus", 43200);
  const r = addFarp(m, { ...blue, name: "Forward", x: -280000, y: 650000, heading: 90, frequencyMHz: 128, support: true });
  assert.equal(r.statics.length, 5);
  assert.equal(r.supportGroup, "Forward-Support");
  addAircraftGroup(m, "helicopter", {
    ...blue, name: "Hog", type: "AH-64D_BLK_II", count: 2, x: 0, y: 0, start: { kind: "farp_cold", farp: "Forward" },
  });
  const reparsed = roundTrip(m);
  const pad = findUnit(reparsed, "Forward")!;
  assert.equal(pad["category"], "Heliports");
  assert.equal(pad["type"], "FARP");
  assert.equal(pad["shape_name"], "FARPS");
  assert.equal(pad["heliport_frequency"], 128);
  const p = firstPoint(reparsed, "Hog");
  assert.equal(p["type"], "TakeOffParking");
  assert.equal(p["linkUnit"], pad["unitId"]);
  assert.equal(p["helipadId"], pad["unitId"]);
  const report = validateMission(buildMissionDocument(reparsed, {}, "t"));
  assert.equal(report.errors.length, 0);
  assert.ok(!report.warnings.some((w) => w.code === "UNKNOWN_UNIT_TYPE"), JSON.stringify(report.warnings));
  assert.throws(
    () => addAircraftGroup(m, "helicopter", { ...blue, name: "X", type: "UH-1H", count: 1, x: 0, y: 0, start: { kind: "farp_cold", farp: "Forward-Support" } }),
    /No FARP/
  );
  assert.throws(() => addStatic(m, { ...blue, name: "F2", type: "FARP", x: 0, y: 0 }), /dcs_miz_add_farp/);
});

test("populateAirfield parks statics on real slots, and flights then avoid them", () => {
  const m = newMissionTable("Caucasus", 43200);
  addAircraftGroup(m, "plane", {
    ...blue, name: "Early", type: "F-16C_50", count: 2, x: 0, y: 0, start: { kind: "parking_cold", airfield: "Kutaisi" },
  });
  const early = luaArray(findGroup(m, "Early")!.group["units"]).map((u) => String(u["parking_id"]));
  const r = populateAirfield(m, {
    ...blue, airfield: "Kutaisi", types: ["F-16C_50", "KC-135"], count: 6, namePrefix: "Parked",
  });
  assert.equal(r.placed.length, 6);
  const kutaisi = findAirport("Caucasus", "Kutaisi");
  const used = r.placed.map((p) => p.slot);
  assert.equal(new Set([...used, ...early]).size, used.length + early.length, "a static landed on a flight's slot");
  for (const p of r.placed) {
    const slot = kutaisi.slots.find((s) => s[1] === p.slot)!;
    const u = findUnit(m, p.name)!;
    assert.equal(u["x"], slot[2]);
    assert.equal(u["y"], slot[3]);
    assert.equal(u["category"], "Planes");
  }
  // A KC-135 only goes where it fits.
  const tanker = r.placed.find((p) => p.type === "KC-135")!;
  const slot = kutaisi.slots.find((s) => s[1] === tanker.slot)!;
  assert.ok(slot[5] > 39.9, `KC-135 put on a ${slot[5]} m slot`);

  addAircraftGroup(m, "plane", {
    ...blue, name: "Late", type: "F-16C_50", count: 2, x: 0, y: 0, start: { kind: "parking_cold", airfield: "Kutaisi" },
  });
  const late = luaArray(findGroup(m, "Late")!.group["units"]).map((u) => String(u["parking_id"]));
  for (const s of late) assert.ok(!used.includes(s), `flight spawned onto static-occupied slot ${s}`);
});

test("target areas: one static per object, centred grid, covering radius", () => {
  const m = newMissionTable("Caucasus", 43200);
  const r = addTargetArea(m, { side: "red", country: "Russia", name: "Depot", template: "ammo-depot", x: 1000, y: 2000, heading: 45 });
  const t = TARGET_TEMPLATES.find((x) => x.id === "ammo-depot")!;
  assert.equal(r.objects.length, t.objects.reduce((n, o) => n + o.count, 0));
  const pts = r.objects.map((n) => findUnit(m, n)!);
  const cx = pts.reduce((a, u) => a + Number(u["x"]), 0) / pts.length;
  const cy = pts.reduce((a, u) => a + Number(u["y"]), 0) / pts.length;
  assert.ok(Math.hypot(cx - 1000, cy - 2000) < t.spacingMetres, "grid not centred");
  for (const u of pts) assert.ok(Math.hypot(Number(u["x"]) - 1000, Number(u["y"]) - 2000) <= r.radiusMetres);
  assert.equal(validateMission(buildMissionDocument(roundTrip(m), {}, "t")).errors.length, 0);
});

test("naval formation keeps each ship on its station", () => {
  const m = newMissionTable("Caucasus", 43200);
  const t = findNavalTemplate("csg");
  addGroundGroup(m, "ship", {
    ...blue, name: "CSG", type: t.ships[0].type, count: t.ships.length,
    composition: t.ships.map((s) => ({ type: s.type, count: 1 })),
    offsets: t.ships.map(({ forward, right }) => ({ forward, right })),
    x: -400000, y: 400000, heading: 90,
  });
  const units = luaArray(findGroup(roundTrip(m), "CSG")!.group["units"]);
  // Heading 90 (east): the cruiser 3 km AHEAD is 3 km east; a destroyer 2.5 km RIGHT is 2.5 km south.
  assert.ok(Math.abs(Number(units[1]["y"]) - 403000) < 1e-6 && Math.abs(Number(units[1]["x"]) + 400000) < 1e-6);
  assert.ok(Math.abs(Number(units[2]["x"]) - (-402500)) < 1e-6 && Math.abs(Number(units[2]["y"]) - 401000) < 1e-6);
});

test("every template type exists in the DCS catalogue", () => {
  for (const t of TARGET_TEMPLATES) for (const o of t.objects) assert.equal(findUnitType(o.type)?.category, "static", `${t.id}: ${o.type}`);
  for (const t of NAVAL_TEMPLATES) for (const s of t.ships) assert.equal(findUnitType(s.type)?.category, "ship", `${t.id}: ${s.type}`);
  for (const t of ["M978 HEMTT Tanker", "M 818", "M1043 HMMWV Armament", "ATZ-10", "Ural-375", "ZIL-131 KUNG"]) {
    assert.equal(findUnitType(t)?.category, "vehicle", t);
  }
});

for (const template of ['farp-staging', 'vehicle-staging', 'scud-base', 'sam-support', 'military-base']) test(`${template} leaves a central access corridor and supplies a gated boundary`, () => {
  const m = newMissionTable('Caucasus', 43200);
  const r = addTargetArea(m, { ...blue, name: 'Site', template, x: 1000, y: 2000, heading: 90 });
  assert.ok(r.perimeter?.entrances.length);
  const boundary = new Set(r.perimeter!.objects);
  for (const name of r.objects.filter(n => !boundary.has(n))) {
    const u = findUnit(m, name)!;
    // At heading 90, local right is negative world x. Centreline stays clear.
    assert.ok(Math.abs(Number(u.x) - 1000) >= 20, name);
    assert.ok(Math.hypot(Number(u.x) - 1000, Number(u.y) - 2000) <= r.radiusMetres);
  }
  assert.equal(validateMission(buildMissionDocument(roundTrip(m), {}, 'site')).errors.length, 0);
});
