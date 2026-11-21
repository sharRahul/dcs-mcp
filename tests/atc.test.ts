import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { serializeLuaAssignment } from "../src/miz/serializer.js";
import { asTable, luaArray, parseLuaAssignment, type LuaTable } from "../src/miz/lua.js";
import { addAircraftGroup, addWaypoint, findGroup, newMissionTable } from "../src/miz/authoring.js";
import { addFlightAtc } from "../src/miz/atc.js";
import { findAirport } from "../src/data/reference.js";
import { flyableTypes, playerFlyable, scanModFolder } from "../src/dcs/mods.js";

const blue = { side: "blue" as const, country: "USA" };

function playerMission(land?: string) {
  const m = newMissionTable("Caucasus", 43200);
  addAircraftGroup(m, "plane", { ...blue, name: "Viper", type: "F-16C_50", count: 2, x: 0, y: 0, skill: "Player",
    start: { kind: "parking_cold", airfield: "Kutaisi" } });
  if (land) {
    const a = findAirport("Caucasus", land);
    const i = addWaypoint(m, "Viper", { x: a.x, y: a.y, altitudeMetres: 0, speedMps: 0, type: "Land", action: "Landing" });
    asTable(asTable(asTable(findGroup(m, "Viper")!.group.route)?.points)?.[i])!.airdromeId = a.id;
  }
  return m;
}
const compiled = (m: LuaTable, k: "actions" | "conditions") => Object.values(asTable(asTable(m.trig)![k])!).map(String).join("\n");

test("player flight: only the lead is Player, the wingman is AI", () => {
  const units = luaArray(asTable(findGroup(playerMission(), "Viper")!.group.units));
  assert.deepEqual(units.map(u => u.skill), ["Player", "High"]);
});

test("full-sortie ATC: departure, AWACS, arrival; DCS ATC silenced at both fields; round-trips", () => {
  const m = playerMission("Senaki-Kolkhi"), dict: LuaTable = {};
  const r = addFlightAtc(m, "Viper", { callsign: "Viper 1-1", briefing: "Strike the bridge.", departure: { runway: "07" },
    awacs: { frequencyMHz: 251, tasking: "Proceed to CAP Alpha, angels 25." }, arrival: { runway: "09" }, audio: { briefing: "ResKey_Action_1" } }, dict);
  assert.equal(r.departure?.airfield, "Kutaisi");
  assert.equal(r.arrival?.airfield, "Senaki-Kolkhi");
  assert.match(r.departure!.atc, /UHF/);
  assert.match(r.awacs!, /Magic on 251/);
  assert.deepEqual(r.silenced, ["Kutaisi", "Senaki-Kolkhi"]);
  assert.equal(r.triggers.length, 13);
  const actions = compiled(m, "actions");
  assert.equal((actions.match(/a_set_ATC_silent_mode/g) ?? []).length, 2);
  for (const p of ["a_add_radio_item_for_group", "a_remove_radio_item_for_group", "a_out_sound_g"]) assert.match(actions, new RegExp(p));
  const conds = compiled(m, "conditions");
  for (const p of ["c_unit_altitude_higher_AGL", "c_unit_in_zone", "c_unit_out_zone"]) assert.match(conds, new RegExp(p));
  const texts = Object.values(dict).map(String).join("\n");
  for (const t of [/cleared for takeoff/, /radar contact\. Proceed to CAP Alpha/, /expect runway 09/, /cleared to land/, /taxi to parking/]) assert.match(texts, t);
  assert.equal(luaArray(asTable(asTable(m.triggers)?.zones)).length, 2);
  const back = parseLuaAssignment(serializeLuaAssignment("mission", m)) as LuaTable;
  assert.equal(luaArray(asTable(back.trigrules)).length, 13);
  assert.equal(compiled(back, "actions"), actions);
});

test("ATC defaults the arrival from the Landing waypoint and refuses a second script", () => {
  const m = playerMission("Kutaisi");
  const r = addFlightAtc(m, "Viper", { briefing: "x" });
  assert.equal(r.arrival?.airfield, "Kutaisi");
  assert.deepEqual(r.silenced, ["Kutaisi"]);
  assert.ok(r.notes.some(n => /first designator/.test(n)));
  const before = JSON.stringify(m);
  assert.throws(() => addFlightAtc(m, "Viper", { briefing: "y" }), /already has an ATC script/);
  assert.equal(JSON.stringify(m), before);
});

test("ATC is atomic: a failure leaves triggers, zones and the dictionary untouched", () => {
  const m = playerMission("Senaki-Kolkhi"), dict: LuaTable = {};
  const before = JSON.stringify(m);
  assert.throws(() => addFlightAtc(m, "Viper", { briefing: "x", arrival: { inboundKm: 5, finalKm: 10 } }, dict), /finalKm/);
  assert.equal(JSON.stringify(m), before);
  assert.deepEqual(dict, {});
});

test("ATC refuses an air start with nothing to script", () => {
  const m = newMissionTable("Caucasus", 43200);
  addAircraftGroup(m, "plane", { ...blue, name: "Air", type: "F-16C_50", count: 2, x: 0, y: 0, skill: "Player" });
  assert.throws(() => addFlightAtc(m, "Air", { briefing: "x" }), /neither starts at an airfield/);
  const r = addFlightAtc(m, "Air", { briefing: "x", awacs: { tasking: "y" } });
  assert.equal(r.departure, undefined);
  assert.deepEqual(r.silenced, []);
});

test("flyable = make_flyable / MAC_flyable in a deployed mod, including a local holding the id", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "flyable-"));
  mkdirSync(path.join(dir, "Mod"));
  writeFileSync(path.join(dir, "Mod", "entry.lua"),
    "declare_plugin('X', {})\nlocal flyable_ID = 'MiG-29 Fulcrum'\nmake_flyable(flyable_ID, p)\nMAC_flyable('Su-27', p)\n-- make_flyable('Commented', p)\n");
  const mod = scanModFolder(path.join(dir, "Mod"), "aircraft", true);
  const fly = flyableTypes([mod]);
  assert.deepEqual([...fly].sort(), ["MiG-29 Fulcrum", "Su-27"]);
  assert.equal(playerFlyable("Su-27", [mod]), "yes");
  assert.equal(playerFlyable("F-15E", [mod]), "no");
  assert.equal(playerFlyable("Su-27", [{ ...mod, deployed: false }]), "unknown");
});
