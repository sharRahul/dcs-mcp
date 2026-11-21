import { test } from "node:test";
import assert from "node:assert/strict";
import { serializeLuaAssignment } from "../src/miz/serializer.js";
import { asTable, luaArray, parseLuaAssignment, type LuaTable } from "../src/miz/lua.js";
import { addAircraftGroup, findGroup, newMissionTable } from "../src/miz/authoring.js";
import { addDepartureComms } from "../src/miz/departure-comms.js";

const blue = { side: "blue" as const, country: "USA" };

function playerMission() {
  const m = newMissionTable("Caucasus", 43200);
  addAircraftGroup(m, "plane", { ...blue, name: "Viper", type: "F-16C_50", count: 2, x: 0, y: 0, skill: "Player",
    start: { kind: "parking_cold", airfield: "Kutaisi" } });
  return m;
}

test("player flight: only the lead is Player, the wingman is AI", () => {
  const m = playerMission();
  const units = luaArray(asTable(findGroup(m, "Viper")!.group.units));
  assert.deepEqual(units.map(u => u.skill), ["Player", "High"]);
});

test("departure comms compile, gate each step and round-trip", () => {
  const m = playerMission(), dict: LuaTable = {};
  const r = addDepartureComms(m, { group: "Viper", callsign: "Viper 1-1", runway: "07", briefing: "Strike the bridge.",
    awacs: { callsign: "Magic", frequencyMHz: 251, tasking: "Proceed to CAP Alpha, angels 25." }, audio: { briefing: "ResKey_Action_1" } }, dict);
  assert.equal(r.airfield, "Kutaisi");
  assert.equal(r.triggers.length, 6);
  assert.match(r.atc, /UHF/);
  assert.match(r.awacs, /Magic on 251/);
  const trig = asTable(m.trig)!;
  const actions = Object.values(asTable(trig.actions)!).map(String).join("\n");
  assert.match(actions, /a_add_radio_item_for_group/);
  assert.match(actions, /a_remove_radio_item_for_group/);
  assert.match(actions, /a_out_sound_g/);
  const conds = Object.values(asTable(trig.conditions)!).map(String).join("\n");
  assert.match(conds, /c_unit_altitude_higher_AGL/);
  const texts = Object.values(dict).map(String).join("\n");
  assert.match(texts, /cleared for takeoff/);
  assert.match(texts, /radar contact\. Proceed to CAP Alpha/);
  const back = parseLuaAssignment(serializeLuaAssignment("mission", m)) as LuaTable;
  assert.equal(luaArray(asTable(back.trigrules)).length, 6);
});

test("departure comms refuse an air start", () => {
  const m = newMissionTable("Caucasus", 43200);
  addAircraftGroup(m, "plane", { ...blue, name: "Air", type: "F-16C_50", count: 2, x: 0, y: 0, skill: "Player" });
  assert.throws(() => addDepartureComms(m, { group: "Air", briefing: "x", awacs: { tasking: "y" } }), /does not start at an airfield/);
});
