import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import luaparse from "luaparse";
import { serializeLuaAssignment } from "../src/miz/serializer.js";
import { asTable, luaArray, parseLuaAssignment, type LuaTable } from "../src/miz/lua.js";
import {
  addAircraftGroup,
  addGroundGroup,
  addTrigger,
  addTriggerZone,
  compileTrig,
  countryId,
  findGroup,
  findUnit,
  newMissionTable,
  removeTrigger,
  updateTrigger,
} from "../src/miz/authoring.js";
import {
  addStatic,
  moveGroup,
  removeGroup,
  removeUnit,
  removeWaypoint,
  removeZone,
  renameGroup,
  setMissionOptions,
  updateGroup,
  updateZone,
} from "../src/miz/editing.js";
import { buildMissionDocument } from "../src/miz/parser.js";
import { validateMission } from "../src/miz/validator.js";
import { findAirport, findUnitType, theatres } from "../src/data/reference.js";
import { latLonToXY, xyToLatLon } from "../src/miz/projection.js";
import { SITE_TEMPLATES } from "../src/miz/templates.js";
import {
  enableSessionPersistence,
  evictSession,
  listSnapshots,
  newSession,
  refresh,
  requireSession,
  closeSession,
} from "../src/miz/sessions.js";
import { installHook } from "../src/dcs/install.js";

/** serialize -> reparse, the round trip every authoring change must survive. */
function roundTrip(mission: LuaTable): LuaTable {
  return parseLuaAssignment(serializeLuaAssignment("mission", mission), "mission");
}

function doc(mission: LuaTable) {
  return buildMissionDocument(mission, {}, "test");
}

function caucasus(): LuaTable {
  return newMissionTable("Caucasus", 43200);
}

const blueArgs = { side: "blue" as const, country: "USA" };

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

test("projection matches PROJ tmerc to the millimetre (Caucasus constants)", () => {
  // Reference values from pyproj 3 with the pydcs Caucasus parameters, +axis=neu.
  const vectors: [number, number, number, number][] = [
    [41.6103, 41.5997, -355737.0358325243, 617333.5423221545],
    [45.0, 37.3, -6163.606847931631, 239389.0378911034],
    [43.0, 45.5, -160832.16490579862, 919860.831470338],
  ];
  for (const [lat, lon, x, y] of vectors) {
    const p = latLonToXY("Caucasus", lat, lon);
    assert.ok(Math.abs(p.x - x) < 0.001 && Math.abs(p.y - y) < 0.001, `${lat},${lon} -> ${p.x},${p.y}`);
    const back = xyToLatLon("Caucasus", x, y);
    assert.ok(Math.abs(back.lat - lat) < 1e-9 && Math.abs(back.lon - lon) < 1e-9);
  }
});

test("theatre constants put real airfields where they are in the world", () => {
  // Independent check of the per-theatre constants: airfield reference points
  // from DCS, unprojected, against published aerodrome coordinates.
  const known: [string, string, number, number][] = [
    ["Caucasus", "Batumi", 41.6103, 41.5997],
    ["Nevada", "Nellis", 36.2362, -115.0343],
    ["PersianGulf", "Al Dhafra", 24.2483, 54.5475],
    ["Syria", "Incirlik", 37.0021, 35.4259],
    ["MarianaIslands", "Andersen", 13.584, 144.93],
  ];
  for (const [t, name, lat, lon] of known) {
    const ap = findAirport(t, name);
    const ll = xyToLatLon(t, ap.x, ap.y);
    assert.ok(Math.abs(ll.lat - lat) < 0.01 && Math.abs(ll.lon - lon) < 0.01, `${t}/${ap.name}: ${ll.lat},${ll.lon}`);
  }
  assert.ok(Object.keys(theatres()).length >= 12);
});

// ---------------------------------------------------------------------------
// Countries and coalitions
// ---------------------------------------------------------------------------

test("country names resolve from the full DCS list; unknown names throw", () => {
  assert.equal(countryId("USA"), 2);
  assert.equal(countryId("russia"), 0);
  assert.equal(countryId("Combined Joint Task Forces Blue"), 80);
  assert.throws(() => countryId("Atlantis"), /Unknown country/);
});

test("a country cannot be on two sides, and mission.coalitions follows the units", () => {
  const m = caucasus();
  addGroundGroup(m, "vehicle", { ...blueArgs, name: "Tanks", type: "M-1 Abrams", count: 1, x: 0, y: 0 });
  assert.throws(
    () => addGroundGroup(m, "vehicle", { side: "red", country: "USA", name: "X", type: "T-72B", count: 1, x: 0, y: 0 }),
    /already on the blue side/
  );
  const lists = roundTrip(m)["coalitions"] as LuaTable;
  assert.deepEqual(luaArray(lists["blue"]).map((e) => e["value"]), [2]);
});

// ---------------------------------------------------------------------------
// Aircraft starts
// ---------------------------------------------------------------------------

test("parking start: ME point type, airdromeId, distinct slots per unit and per flight", () => {
  const m = caucasus();
  const g1 = addAircraftGroup(m, "plane", {
    ...blueArgs, name: "Hornet", type: "FA-18C_hornet", count: 2, x: 0, y: 0,
    start: { kind: "parking_cold", airfield: "Batumi" },
  });
  const g2 = addAircraftGroup(m, "plane", {
    ...blueArgs, name: "Viper", type: "F-16C_50", count: 2, x: 0, y: 0,
    start: { kind: "parking_hot", airfield: "Batumi" },
  });
  const reparsed = roundTrip(m);
  const batumi = findAirport("Caucasus", "Batumi");
  const p1 = asTable(asTable(asTable(findGroup(reparsed, "Hornet")!.group["route"])!["points"])![1])!;
  assert.equal(p1["type"], "TakeOffParking");
  assert.equal(p1["action"], "From Parking Area");
  assert.equal(p1["airdromeId"], batumi.id);
  const p2 = asTable(asTable(asTable(findGroup(reparsed, "Viper")!.group["route"])!["points"])![1])!;
  assert.equal(p2["type"], "TakeOffParkingHot");

  const slots = [g1, g2].flatMap((g) => luaArray(g["units"]).map((u) => String(u["parking_id"])));
  assert.equal(new Set(slots).size, 4, `slots reused: ${slots}`);
  for (const u of [...luaArray(g1["units"]), ...luaArray(g2["units"])]) {
    const slot = batumi.slots.find((s) => s[1] === u["parking_id"])!;
    assert.equal(u["parking"], slot[0]);
    assert.equal(u["x"], slot[2]);
    assert.equal(u["y"], slot[3]);
  }
});

test("runway, explicit parking and ship starts", () => {
  const m = caucasus();
  addAircraftGroup(m, "plane", {
    ...blueArgs, name: "Rwy", type: "F-16C_50", count: 1, x: 0, y: 0, start: { kind: "runway", airfield: 22 },
  });
  const rwy = asTable(asTable(asTable(findGroup(m, "Rwy")!.group["route"])!["points"])![1])!;
  assert.equal(rwy["type"], "TakeOff");
  assert.equal(rwy["action"], "From Runway");

  const batumi = findAirport("Caucasus", "Batumi");
  const slot = batumi.slots.find((s) => s[4] & 4)!;
  addAircraftGroup(m, "plane", {
    ...blueArgs, name: "Exact", type: "F-16C_50", count: 1, x: 0, y: 0,
    start: { kind: "parking_cold", airfield: "Batumi", parking: [slot[1]] },
  });
  assert.equal(findUnit(m, "Exact-1")!["parking_id"], slot[1]);
  assert.throws(
    () => addAircraftGroup(m, "plane", {
      ...blueArgs, name: "Clash", type: "F-16C_50", count: 1, x: 0, y: 0,
      start: { kind: "parking_cold", airfield: "Batumi", parking: [slot[1]] },
    }),
    /already used/
  );

  addGroundGroup(m, "ship", { ...blueArgs, name: "CVN", type: "CVN_71", count: 1, x: -300000, y: 500000 });
  addAircraftGroup(m, "plane", {
    ...blueArgs, name: "Deck", type: "FA-18C_hornet", count: 1, x: 0, y: 0, start: { kind: "ship_cold", ship: "CVN-1" },
  });
  const deck = asTable(asTable(asTable(findGroup(m, "Deck")!.group["route"])!["points"])![1])!;
  const cvnId = findUnit(m, "CVN-1")!["unitId"];
  assert.equal(deck["linkUnit"], cvnId);
  assert.equal(deck["helipadId"], cvnId);
  assert.equal(deck["airdromeId"], undefined);
});

test("aircraft get full internal fuel and the type's countermeasures by default", () => {
  const m = caucasus();
  addAircraftGroup(m, "plane", { ...blueArgs, name: "H", type: "FA-18C_hornet", count: 1, x: 0, y: 0 });
  const payload = asTable(findUnit(roundTrip(m), "H-1")!["payload"])!;
  assert.equal(payload["fuel"], "4900");
  assert.equal(payload["chaff"], 60);
  assert.equal(payload["flare"], 60);
});

// ---------------------------------------------------------------------------
// Removal
// ---------------------------------------------------------------------------

function missionWithTriggers(): LuaTable {
  const m = caucasus();
  addGroundGroup(m, "vehicle", { side: "red", country: "Russia", name: "SAM", type: "Kub 1S91 str", count: 2, x: 0, y: 0 });
  addGroundGroup(m, "vehicle", { side: "red", country: "Russia", name: "Trucks", type: "Ural-375", count: 2, x: 10, y: 10 });
  addTriggerZone(m, { name: "Zone", x: 0, y: 0, radius: 1000 });
  const dict: LuaTable = {};
  addTrigger(m, { type: "once", comment: "A", conditions: [{ kind: "group_dead", group: "SAM" }], actions: [{ kind: "set_flag", flag: 1 }] }, dict);
  addTrigger(m, { type: "once", comment: "B", conditions: [{ kind: "time_after", seconds: 10 }], actions: [{ kind: "set_flag", flag: 2 }] }, dict);
  addTrigger(m, { type: "start", comment: "C", conditions: [], actions: [{ kind: "set_flag", flag: 3 }] }, dict);
  return m;
}

test("removing a group a trigger references is refused unless forced", () => {
  const m = missionWithTriggers();
  assert.throws(() => removeGroup(m, doc(m).triggers, "SAM"), /referenced by trigger\(s\) #1 'A'/);
  const r = removeGroup(m, doc(m).triggers, "Trucks");
  assert.deepEqual(r.danglingTriggers, []);
  const forced = removeGroup(m, doc(m).triggers, "SAM", true);
  assert.deepEqual(forced.danglingTriggers, [1]);
  const reparsed = roundTrip(m);
  assert.equal(findGroup(reparsed, "SAM"), undefined);
  assert.equal(findGroup(reparsed, "Trucks"), undefined);
});

test("the last unit of a group cannot be removed; others can", () => {
  const m = missionWithTriggers();
  removeUnit(m, doc(m).triggers, "Trucks-2");
  assert.throws(() => removeUnit(m, doc(m).triggers, "Trucks-1"), /only unit/);
  assert.equal(luaArray(findGroup(roundTrip(m), "Trucks")!.group["units"]).length, 1);
});

test("zones referenced by triggers are protected too", () => {
  const m = caucasus();
  addGroundGroup(m, "vehicle", { ...blueArgs, name: "T", type: "M-1 Abrams", count: 1, x: 0, y: 0 });
  addTriggerZone(m, { name: "Z", x: 0, y: 0, radius: 500 });
  addTrigger(m, { type: "once", conditions: [{ kind: "unit_in_zone", unit: "T-1", zone: "Z" }], actions: [{ kind: "set_flag", flag: 1 }] });
  assert.throws(() => removeZone(m, doc(m).triggers, "Z"), /referenced/);
  updateZone(m, "Z", { name: "Z2", radius: 900 });
  assert.equal(doc(m).zones[0].name, "Z2");
});

test("removing a trigger renumbers and recompiles the ones after it", () => {
  const m = missionWithTriggers();
  const r = removeTrigger(m, 1);
  assert.equal(r.removed, "A");
  const reparsed = roundTrip(m);
  const rules = luaArray(reparsed["trigrules"]);
  assert.deepEqual(rules.map((x) => x["comment"]), ["B", "C"]);
  const trig = asTable(reparsed["trig"])!;
  // B is now #1: a `once` trigger disarms its OWN slot.
  assert.match(String(asTable(trig["actions"])![1]), /mission\.trig\.func\[1\]=nil;$/);
  assert.match(String(asTable(trig["func"])![1]), /conditions\[1\]/);
  // C (a start trigger) is now #2 and wired through funcStartup.
  assert.ok(asTable(trig["funcStartup"])![2]);
  assert.equal(asTable(trig["func"])![2], undefined);
  assert.equal(asTable(trig["actions"])![3], undefined);
  // Every compiled string still loads as Lua, and a recompile changes nothing.
  for (const key of ["conditions", "actions", "func", "funcStartup"]) {
    for (const v of Object.values(asTable(trig[key]) ?? {})) luaparse.parse(String(v));
  }
  const before = serializeLuaAssignment("mission", m);
  compileTrig(m);
  assert.equal(serializeLuaAssignment("mission", m), before);
});

test("trigger removal refuses to renumber a trigger it cannot recompile", () => {
  const m = missionWithTriggers();
  const rules = m["trigrules"] as LuaTable;
  (asTable(asTable(rules[3])!["actions"]) as LuaTable)[2] = { predicate: "a_something_unverified" };
  assert.throws(() => removeTrigger(m, 1), /no verified compiler/);
  // Removing the last one is always safe.
  removeTrigger(m, 3);
  assert.equal(luaArray(m["trigrules"]).length, 2);
});

test("event-driven triggers are never renumbered or retyped", () => {
  const m = missionWithTriggers();
  (asTable(m["trigrules"])![3] as LuaTable)["eventlist"] = "shot";
  // Removing #1 would renumber the event trigger #3, whose compiled Lua names its slot.
  assert.throws(() => removeTrigger(m, 1), /eventlist "shot"/);
  assert.throws(() => updateTrigger(m, 3, { type: "continuous" }), /eventlist "shot"/);
  // An empty eventlist is how the editor stores "no event": still a normal trigger.
  (asTable(m["trigrules"])![3] as LuaTable)["eventlist"] = "";
  updateTrigger(m, 3, { type: "continuous" });
});

test("updateTrigger rewires a type change", () => {
  const m = missionWithTriggers();
  updateTrigger(m, 2, { type: "start", comment: "B2" });
  const trig = asTable(m["trig"])!;
  assert.ok(asTable(trig["funcStartup"])![2]);
  assert.equal(asTable(trig["func"])![2], undefined);
  assert.equal(asTable(asTable(m["trigrules"])![2])!["comment"], "B2");
});

// ---------------------------------------------------------------------------
// Rename / move / update
// ---------------------------------------------------------------------------

test("renaming a group renames its <group>-N units and refuses collisions", () => {
  const m = missionWithTriggers();
  const r = renameGroup(m, "Trucks", "Convoy");
  assert.deepEqual(r.renamedUnits.map((u) => u.to), ["Convoy-1", "Convoy-2"]);
  assert.throws(() => renameGroup(m, "Convoy", "SAM"), /already exists/);
  assert.ok(findUnit(roundTrip(m), "Convoy-2"));
});

test("moving a group keeps the column trailing the new heading", () => {
  const m = caucasus();
  addGroundGroup(m, "vehicle", { ...blueArgs, name: "Col", type: "M-1 Abrams", count: 3, x: 0, y: 0, heading: 0 });
  addGroundGroup(m, "vehicle", { ...blueArgs, name: "Dummy", type: "M-1 Abrams", count: 1, x: 5, y: 5 });
  moveGroup(m, "Col", { x: 1000, y: 2000, heading: 90 });
  const units = luaArray(findGroup(roundTrip(m), "Col")!.group["units"]);
  assert.ok(Math.abs(Number(units[0]["x"]) - 1000) < 1e-6 && Math.abs(Number(units[0]["y"]) - 2000) < 1e-6);
  // Heading 90 = east: the second unit sits 20 m WEST of the lead.
  assert.ok(Math.abs(Number(units[1]["x"]) - 1000) < 1e-6);
  assert.ok(Math.abs(Number(units[1]["y"]) - 1980) < 1e-6);
  assert.ok(Math.abs(Number(units[1]["heading"]) - Math.PI / 2) < 1e-9);
  const wp1 = asTable(asTable(asTable(findGroup(m, "Col")!.group["route"])!["points"])![1])!;
  assert.equal(wp1["x"], 1000);
});

test("waypoint 1 cannot be removed; group flags are written", () => {
  const m = caucasus();
  addAircraftGroup(m, "plane", { ...blueArgs, name: "F", type: "F-16C_50", count: 1, x: 0, y: 0 });
  assert.throws(() => removeWaypoint(m, "F", 1), /spawn point/);
  updateGroup(m, "F", { lateActivation: true, uncontrolled: true, skill: "Client" });
  const g = findGroup(roundTrip(m), "F")!.group;
  assert.equal(g["lateActivation"], true);
  assert.equal(g["uncontrolled"], true);
  assert.equal(luaArray(g["units"])[0]["skill"], "Client");
  addGroundGroup(m, "vehicle", { ...blueArgs, name: "V", type: "M-1 Abrams", count: 1, x: 0, y: 0 });
  assert.throws(() => updateGroup(m, "V", { uncontrolled: true }), /aircraft groups only/);
});

// ---------------------------------------------------------------------------
// Statics and options
// ---------------------------------------------------------------------------

test("static objects: one-unit group with catalogue category and shape, round-trips", () => {
  const m = caucasus();
  addStatic(m, { ...blueArgs, name: "CP", type: ".Command Center", x: 100, y: 200, heading: 90 });
  addStatic(m, { ...blueArgs, name: "Cargo", type: "barrels_cargo", x: 0, y: 0, massKg: 500 });
  assert.throws(() => addStatic(m, { ...blueArgs, name: "Bad", type: "Nope", x: 0, y: 0 }), /Unknown static type/);
  const reparsed = roundTrip(m);
  const cp = findGroup(reparsed, "CP")!;
  assert.equal(cp.category, "static");
  const unit = luaArray(cp.group["units"])[0];
  assert.equal(unit["category"], "Fortifications");
  assert.equal(unit["shape_name"], "ComCenter");
  assert.ok(Math.abs(Number(unit["heading"]) - Math.PI / 2) < 1e-9);
  assert.equal(luaArray(asTable(cp.group["route"])!["points"]).length, 1);
  const cargo = luaArray(findGroup(reparsed, "Cargo")!.group["units"])[0];
  assert.equal(cargo["canCargo"], true);
  assert.equal(cargo["mass"], 500);
  assert.equal(validateMission(doc(reparsed)).errors.length, 0);
});

test("mission options validate dates and forced-option values", () => {
  const m = caucasus();
  setMissionOptions(m, { date: { year: 2024, month: 2, day: 29 }, startTime: 3600, forcedOptions: { labels: 0, externalViews: false, geffect: "realistic" } });
  assert.throws(() => setMissionOptions(m, { date: { year: 2023, month: 2, day: 29 } }), /not a valid date/);
  assert.throws(() => setMissionOptions(m, { forcedOptions: { labels: 9 } }), /one of/);
  setMissionOptions(m, { clearForcedOptions: ["labels"] });
  const reparsed = roundTrip(m);
  assert.deepEqual(reparsed["date"], { Year: 2024, Month: 2, Day: 29 });
  assert.deepEqual(reparsed["forcedOptions"], { externalViews: false, geffect: "realistic" });
});

// ---------------------------------------------------------------------------
// Catalogue, templates, validator
// ---------------------------------------------------------------------------

test("every site-template unit type exists in the DCS catalogue", () => {
  for (const t of SITE_TEMPLATES) {
    for (const c of t.composition) assert.equal(findUnitType(c.type)?.category, "vehicle", `${t.id}: ${c.type}`);
  }
});

test("validator warns on unknown unit types and multiple Player units", () => {
  const m = caucasus();
  addGroundGroup(m, "vehicle", { ...blueArgs, name: "Typo", type: "M-1 Abramz", count: 1, x: 0, y: 0 });
  addAircraftGroup(m, "plane", { ...blueArgs, name: "P1", type: "F-16C_50", count: 1, x: 0, y: 0, skill: "Player" });
  addAircraftGroup(m, "plane", { ...blueArgs, name: "P2", type: "F-16C_50", count: 1, x: 0, y: 0, skill: "Player" });
  const codes = validateMission(doc(m)).warnings.map((w) => w.code);
  assert.ok(codes.includes("UNKNOWN_UNIT_TYPE"));
  assert.ok(codes.includes("MULTIPLE_PLAYER_UNITS"));
});

// ---------------------------------------------------------------------------
// Session snapshots
// ---------------------------------------------------------------------------

test("a session survives a server restart through its snapshot", () => {
  const dir = mkdtempSync(join(tmpdir(), "dcs-state-"));
  enableSessionPersistence(dir);
  try {
    const s = newSession("Caucasus", 43200);
    addGroundGroup(s.mission, "vehicle", { ...blueArgs, name: "Kept", type: "M-1 Abrams", count: 2, x: 0, y: 0 });
    s.files.set("note.lua", Buffer.from("-- hi"));
    s.dirty = true;
    refresh(s);
    const id = s.id;
    evictSession(id);
    assert.ok(listSnapshots().some((x) => x.id === id));
    const restored = requireSession(id); // transparent restore
    assert.ok(findGroup(restored.mission, "Kept"));
    assert.equal(restored.files.get("note.lua")?.toString(), "-- hi");
    assert.equal(restored.dirty, true);
    assert.ok(closeSession(id));
    assert.equal(existsSync(join(dir, id)), false);
  } finally {
    enableSessionPersistence("off");
  }
});

// ---------------------------------------------------------------------------
// Hook installer
// ---------------------------------------------------------------------------

test("hook installer installs, leaves an edited copy alone, and backs up on overwrite", async () => {
  const saved = mkdtempSync(join(tmpdir(), "dcs-saved-"));
  mkdirSync(join(saved, "Logs"));
  const first = await installHook({ savedGames: saved, telemetry: true });
  assert.deepEqual(first.files.map((f) => f.status), ["installed", "installed"]);
  assert.equal(first.restartRequired, true);
  const target = join(saved, "Scripts", "Hooks", "dcs-mcp-hook.lua");
  assert.equal(readFileSync(target, "utf8"), readFileSync("runtime/dcs/Hooks/dcs-mcp-hook.lua", "utf8"));

  assert.equal((await installHook({ savedGames: saved })).files[0].status, "unchanged");
  writeFileSync(target, "-- edited by the user");
  const kept = await installHook({ savedGames: saved });
  assert.equal(kept.files[0].status, "differs");
  assert.equal(readFileSync(target, "utf8"), "-- edited by the user");
  const dry = await installHook({ savedGames: saved, overwrite: true, dryRun: true });
  assert.equal(dry.files[0].status, "would-replace");
  const replaced = await installHook({ savedGames: saved, overwrite: true });
  assert.equal(replaced.files[0].status, "replaced");
  assert.equal(readFileSync(replaced.files[0].backup!, "utf8"), "-- edited by the user");
  assert.ok(readdirSync(join(saved, "Scripts", "Hooks")).length === 2);
});
