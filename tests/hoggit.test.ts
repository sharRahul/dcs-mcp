import { test } from "node:test";
import assert from "node:assert/strict";
import { serializeLuaAssignment } from "../src/miz/serializer.js";
import { parseLuaAssignment, asTable, luaArray, type LuaTable } from "../src/miz/lua.js";
import { addAircraftGroup, addGroundGroup, addWaypoint, findGroup, findUnit, newMissionTable } from "../src/miz/authoring.js";
import { addWaypointAction, hoggitData, listWaypointActions } from "../src/miz/actions.js";
import { callsignOptions, resolveFamily, typeSpecific } from "../src/miz/callsigns.js";
import { configureFlight } from "../src/miz/flight.js";

const rt = (m: LuaTable) => parseLuaAssignment(serializeLuaAssignment("mission", m), "mission");
const tasksAt = (m: LuaTable, group: string, wp: number) =>
  luaArray(asTable(asTable(asTable(asTable(findGroup(rt(m), group)!.group.route)!.points)![wp])!.task)!.params!.tasks as LuaTable);
function mission() {
  const m = newMissionTable("Caucasus", 43200);
  addAircraftGroup(m, "plane", { side: "blue", country: "USA", name: "Viper", type: "F-16C_50", count: 2, x: 0, y: 0, altitudeMetres: 6000, task: "CAS" });
  addWaypoint(m, "Viper", { x: 10000, y: 0 });
  addGroundGroup(m, "vehicle", { side: "red", country: "Russia", name: "SAM", type: "T-72B", count: 1, x: 20000, y: 0 });
  return m;
}

test("catalogue is generated from the wiki with ids, revisions and categories", () => {
  const d = hoggitData();
  assert.match(d._source, /Hoggit/);
  assert.ok(Object.keys(d.actions).length >= 85);
  for (const [k, a] of Object.entries(d.actions)) {
    assert.ok(a.categories.length, `${k} has categories`);
    assert.match(a.page, /^https:\/\/wiki\.hoggitworld\.com\/view\//);
    if (a.kind !== "option") assert.ok(a.id, `${k} has an id`);
  }
  assert.deepEqual(d.actions["option:roe"].optionIds, { Air: 0, Ground: 0, Naval: 0 });
  assert.equal(d.actions["option:forcedAttack"].optionIds!.Air, 26); // page form typo resolved by its own enum line
  assert.deepEqual(d.actions["option:formation"].categories, ["helicopter", "plane"]); // mis-tagged page, |for= kept
  assert.ok(listWaypointActions("ship").every((a) => a.categories.includes("ship")));
});

test("tasks, commands and options are built in the documented shapes and round-trip", () => {
  const m = mission();
  addWaypointAction(m, "Viper", 2, { action: "Bombing", params: { point: { x: 20000, y: 0 }, attackQty: 1, expend: "Two", groupAttack: true } });
  addWaypointAction(m, "Viper", 2, { action: "SetUnlimitedFuel", params: { value: true } });
  addWaypointAction(m, "Viper", 2, { action: "option:roe", value: "WEAPON_HOLD" });
  addWaypointAction(m, "Viper", 2, { action: "option:ECMUsing", value: 3 });
  addWaypointAction(m, "Viper", 2, { action: "AttackGroup", params: { groupId: "SAM" } });
  addWaypointAction(m, "Viper", 2, { action: "SetCallsign", params: { callname: "Viper", number: 3 } });
  const t = tasksAt(m, "Viper", 2);
  assert.deepEqual(t.map((x) => x.number), [1, 2, 3, 4, 5, 6]);
  assert.equal(t[0].id, "Bombing"); assert.equal((t[0].params as LuaTable).expend, "Two");
  assert.deepEqual([t[1].id, ((t[1].params as LuaTable).action as LuaTable).id], ["WrappedAction", "SetUnlimitedFuel"]);
  assert.deepEqual(((t[2].params as LuaTable).action as LuaTable).params, { name: 0, value: 4 });
  assert.deepEqual(((t[3].params as LuaTable).action as LuaTable).params, { name: 13, value: 3 });
  assert.equal((t[4].params as LuaTable).groupId, findGroup(m, "SAM")!.group.groupId);
  assert.deepEqual(((t[5].params as LuaTable).action as LuaTable).params, { callname: 9, number: 3 });
  // Ground group: domain-specific option ids and values.
  addWaypointAction(m, "SAM", 1, { action: "option:alarmState", value: "RED" });
  assert.deepEqual(((tasksAt(m, "SAM", 1)[0].params as LuaTable).action as LuaTable).params, { name: 9, value: 2 });
});

test("undocumented, misapplied or invalid actions are refused without changing the mission", () => {
  const m = mission();
  const before = JSON.stringify(m);
  const bad: [string, number, Parameters<typeof addWaypointAction>[3], RegExp][] = [
    ["Viper", 2, { action: "NoSuchTask" }, /Unknown action/],
    ["Viper", 2, { action: "Hold" }, /not plane/],
    ["Viper", 2, { action: "Bombing", params: { point: { x: 1, y: 1 } } }, /requires 'attackQty'/],
    ["Viper", 2, { action: "Bombing", params: { point: { x: 1, y: 1 }, attackQty: 1, bogus: 1 } }, /no documented parameter 'bogus'/],
    ["Viper", 2, { action: "Bombing", params: { point: { x: 1, y: 1 }, attackQty: 1, expend: "Lots" } }, /expend must be one of/],
    ["Viper", 2, { action: "option:roe", value: 9 }, /takes/],
    ["SAM", 1, { action: "option:roe", value: 0 }, /Ground/], // ground ROE has no WEAPON_FREE
    ["Viper", 2, { action: "option:prohibitAA", value: 1 }, /true or false/],
    ["Viper", 2, { action: "AttackGroup", params: { groupId: "Viper" } }, /own group/],
    ["Viper", 2, { action: "SetCallsign", params: { callname: "Texaco", number: 1 } }, /not available/],
    ["Viper", 9, { action: "Start" }, /does not exist/],
  ];
  for (const [g, wp, req, re] of bad) assert.throws(() => addWaypointAction(m, g, wp, req), re, req.action);
  assert.equal(JSON.stringify(m), before);
});

test("callsign families: wiki numbers, cross-checked with pydcs callnames", () => {
  assert.equal(typeSpecific("F-16C_50").template, "f16");
  assert.equal(typeSpecific("FA-18C_hornet").template, "f18");
  assert.equal(typeSpecific("A-10C_2").template, "a10");
  assert.match(typeSpecific("F-15E").conflict!, /differs/); // pydcs has "Mad"
  assert.match(typeSpecific("AH-64D_BLK_II").conflict!, /differs/);
  const viper = callsignOptions("F-16C_50");
  assert.equal(viper.families[1], "Enfield"); assert.equal(viper.families[9], "Viper"); assert.equal(viper.families[20], "Jedi");
  assert.equal(callsignOptions("F-15E").families[9], undefined);
  assert.deepEqual(Object.values(callsignOptions("E-3A", "AWACS").families), ["Overlord", "Magic", "Wizard", "Focus", "Darkstar"]);
  assert.deepEqual(resolveFamily("KC-135", "Refueling", "arco"), { family: 2, name: "Arco" });
  assert.throws(() => resolveFamily("F-16C_50", "CAS", 21), /not available/);
});

test("configure_flight resolves callsign family by name and writes the unit tables", () => {
  const m = mission();
  configureFlight(m, "Viper", { callsign: { family: "Weasel", flight: 2 } });
  const u2 = findUnit(rt(m), "Viper-2")!.callsign as LuaTable;
  assert.deepEqual(u2, { 1: 17, 2: 2, 3: 2, name: "Weasel22" });
  assert.throws(() => configureFlight(m, "Viper", { callsign: { family: 1, flight: 1, name: "Uzi" } }), /does not match/);
  configureFlight(m, "Viper", { callsign: { family: 1, flight: 1, name: "Enfield" } }); // legacy form still accepted
  assert.equal((findUnit(m, "Viper-1")!.callsign as LuaTable).name, "Enfield11");
});
