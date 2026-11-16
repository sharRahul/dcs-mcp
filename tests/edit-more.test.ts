import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeLuaAssignment } from "../src/miz/serializer.js";
import { asTable, luaArray, parseLuaAssignment, parseLuaDataFile, type LuaTable } from "../src/miz/lua.js";
import { addAircraftGroup, addGroundGroup, addWaypoint, findGroup, findUnit, newMissionTable } from "../src/miz/authoring.js";
import { addWaypointAction } from "../src/miz/actions.js";
import { appendWaypointTask } from "../src/miz/flight.js";
import { getGroup, getRoute, getUnit, modifyWaypointTask, removeWaypointTask, setTaskEnabled } from "../src/miz/route-edit.js";
import { modifyUnit } from "../src/miz/units.js";
import { addGoal } from "../src/miz/scoring.js";
import { getGoal, listGoals, modifyGoal, removeGoal } from "../src/miz/goals.js";
import { addQuadZone } from "../src/miz/zones.js";
import { pointsInZone } from "../src/miz/geometry.js";
import { loadoutsFor, scanPayloads } from "../src/dcs/payloads.js";
import { applyLoadout } from "../src/miz/loadouts.js";

const rt = (m: LuaTable) => parseLuaAssignment(serializeLuaAssignment("mission", m), "mission");
function mission() {
  const m = newMissionTable("Caucasus", 43200);
  addAircraftGroup(m, "plane", { side: "blue", country: "USA", name: "Viper", type: "F-16C_50", count: 2, x: 0, y: 0, altitudeMetres: 6000, task: "CAS" });
  addWaypoint(m, "Viper", { x: 10000, y: 0 });
  addGroundGroup(m, "vehicle", { side: "red", country: "Russia", name: "Armor", type: "T-72B", count: 2, x: 20000, y: 0 });
  return m;
}

test("get_route identifies stored tasks; group and unit detail round-trip", () => {
  const m = mission();
  addWaypointAction(m, "Viper", 2, { action: "Bombing", params: { point: { x: 20000, y: 0 }, attackQty: 1 } });
  addWaypointAction(m, "Viper", 2, { action: "option:roe", value: "WEAPON_HOLD" });
  const route = getRoute(rt(m), "Viper");
  assert.equal(route.points.length, 2);
  assert.deepEqual(route.points[1].tasks.map((t) => [t.number, t.key, t.kind]), [[1, "Bombing", "task"], [2, "option:roe", "option"]]);
  const g = getGroup(m, "Viper");
  assert.equal(g.units.length, 2); assert.equal(g.side, "blue"); assert.equal(typeof g.units[0].headingDegrees, "number");
  assert.equal(getUnit(m, "Armor-2").group, "Armor");
  assert.throws(() => getUnit(m, "Nope"), /No unit/);
});

test("modify / disable / remove waypoint tasks keep undocumented fields and renumber", () => {
  const m = mission();
  addWaypointAction(m, "Viper", 2, { action: "Bombing", params: { point: { x: 20000, y: 0 }, attackQty: 1 } });
  addWaypointAction(m, "Viper", 2, { action: "option:roe", value: 4 });
  addWaypointAction(m, "Viper", 2, { action: "SetInvisible", params: { value: true } });
  // An editor-written field the catalogue does not document must survive a modify.
  const tasks = () => luaArray(asTable(asTable(asTable(asTable(findGroup(m, "Viper")!.group.route)!.points)![2])!.task)!.params!.tasks as LuaTable);
  (tasks()[0].params as LuaTable).editorOnly = 7;
  const r = modifyWaypointTask(m, "Viper", 2, 1, { params: { attackQty: 3, expend: "Half" } });
  assert.deepEqual(r.preservedUndocumentedParams, ["editorOnly"]);
  const p = tasks()[0].params as LuaTable;
  assert.deepEqual([p.attackQty, p.expend, p.editorOnly, (p.point as LuaTable).x], [3, "Half", 7, 20000]);
  assert.equal(tasks()[0].number, 1);
  modifyWaypointTask(m, "Viper", 2, 2, { value: "RETURN_FIRE" });
  assert.equal((((tasks()[1].params as LuaTable).action as LuaTable).params as LuaTable).value, 3);
  assert.throws(() => modifyWaypointTask(m, "Viper", 2, 1, { params: { bogus: 1 } }), /no documented parameter/);
  setTaskEnabled(m, "Viper", 2, 3, false);
  assert.equal(tasks()[2].enabled, false);
  removeWaypointTask(m, "Viper", 2, 1);
  assert.deepEqual(tasks().map((t) => t.number), [1, 2]);
  assert.equal(getRoute(rt(m), "Viper").points[1].tasks[0].key, "option:roe");
  // ControlledTask (from flight.ts orbit with a duration) is not in the catalogue: modify refuses, remove works.
  appendWaypointTask(m, "Viper", 2, { kind: "orbit", pattern: "Circle", point: { x: 10000, y: 0 }, altitudeMetres: 6000, speedMps: 200, durationSeconds: 600 } as never);
  const n = tasks().length;
  assert.throws(() => modifyWaypointTask(m, "Viper", 2, n, { params: {} }), /not in the catalogue/);
  removeWaypointTask(m, "Viper", 2, n);
});

test("modify_unit applies per-unit rules", () => {
  const m = mission();
  const r = modifyUnit(m, "Viper-2", { skill: "Client", tailNumber: "042", headingDegrees: 90, altitudeMetres: 7000 });
  assert.deepEqual(r.changed, ["skill", "onboard_num", "heading", "alt"]);
  const u = findUnit(rt(m), "Viper-2")!;
  assert.deepEqual([u.skill, u.onboard_num, u.alt], ["Client", "042", 7000]);
  assert.ok(Math.abs(Number(u.heading) - Math.PI / 2) < 1e-9);
  assert.equal(findUnit(m, "Viper-1")!.skill !== "Client", true); // only the named unit
  modifyUnit(m, "Viper-1", { skill: "Player" });
  assert.throws(() => modifyUnit(m, "Viper-2", { skill: "Player" }), /already has a Player/);
  assert.throws(() => modifyUnit(m, "Armor-1", { skill: "Client" }), /aircraft units only/);
  assert.throws(() => modifyUnit(m, "Armor-1", { tailNumber: "1" }), /aircraft units only/);
  modifyUnit(m, "Armor-1", { playerCanDrive: true });
  assert.equal(findUnit(m, "Armor-1")!.playerCanDrive, true);
});

test("goals can be listed, modified and removed with result tables rebuilt in pydcs format", () => {
  const m = mission();
  const dead = (group: string) => ({ kind: "group_dead", group } as never);
  addGoal(m, { side: "blue", comment: "Kill armor", score: 50, conditions: [dead("Armor")] });
  addGoal(m, { side: "red", comment: "Kill vipers", score: 40, conditions: [dead("Viper")] });
  addGoal(m, { side: "blue", comment: "Second", score: 30, conditions: [dead("Viper")] });
  assert.deepEqual(listGoals(m).map((g) => [g.index, g.side, g.resultIndex]), [[1, "blue", 1], [2, "red", 1], [3, "blue", 2]]);
  modifyGoal(m, 3, { score: 70, comment: "Second!" });
  const back = rt(m);
  const blue = asTable(asTable(back.result)!.blue)!;
  assert.equal(asTable(blue.actions)![2], "a_set_mission_result(70)");
  assert.equal(getGoal(back, 3).goal.comment, "Second!");
  const keptCondition = asTable(blue.conditions)![2];
  removeGoal(m, 1);
  const after = asTable(asTable(m.result)!.blue)!;
  assert.deepEqual(listGoals(m).map((g) => [g.index, g.side, g.score]), [[1, "red", 40], [2, "blue", 70]]);
  assert.equal(asTable(after.conditions)![1], keptCondition);          // moved down with its goal
  assert.equal(asTable(after.func)![1], "if mission.result.blue.conditions[1]() then mission.result.blue.actions[1]() end");
  assert.equal(asTable(after.actions)![2], undefined);
  assert.equal(asTable(m.result)!.total, 2);
  // A hand-written result entry is never renumbered.
  (asTable(asTable(asTable(m.result)!.red)!.func)!)[1] = "custom()";
  assert.throws(() => removeGoal(m, 1), /not the standard generated form/);
});

test("quad zones follow pydcs TriggerZoneQuadPoint and work with point-in-zone", () => {
  const m = mission();
  const z = addQuadZone(m, { name: "Box", vertices: [{ x: 0, y: 0 }, { x: 0, y: 100 }, { x: 100, y: 100 }, { x: 100, y: 0 }] });
  const zr = luaArray(asTable(rt(m).triggers)!.zones).find((x) => x.name === "Box")!;
  assert.deepEqual([zr.type, zr.radius, zr.x, zr.y, luaArray(zr.verticies).length], [2, 0, 50, 50, 4]);
  assert.equal(z.zoneId, zr.zoneId);
  assert.deepEqual(pointsInZone(m, "Box", [{ x: 50, y: 50 }, { x: 150, y: 50 }]).results.map((r) => r.inside), [true, false]);
  assert.throws(() => addQuadZone(m, { name: "Bow", vertices: [{ x: 0, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }, { x: 100, y: 0 }] }), /cross/);
  assert.throws(() => addQuadZone(m, { name: "Box", vertices: [{ x: 0, y: 0 }, { x: 0, y: 9 }, { x: 9, y: 9 }, { x: 9, y: 0 }] }), /already exists/);
  assert.throws(() => addQuadZone(m, { name: "Tri", vertices: [{ x: 0, y: 0 }, { x: 0, y: 9 }, { x: 9, y: 9 }] }), /exactly 4/);
});

const PAYLOADS = `local unitPayloads = {
  ["name"] = "F-16C_50",
  ["payloads"] = {
    [1] = { ["name"] = "Test CAP", ["pylons"] = {
        [1] = { ["CLSID"] = "{40EF17B7-F508-45de-8566-6FFECC0C1AB8}", ["num"] = 4 },
        [2] = { ["CLSID"] = "{NOT-IN-PYDCS}", ["num"] = 3, ["settings"] = { ["mode"] = 2 } } },
      ["tasks"] = { [1] = CAP, [2] = 31 } },
    [2] = { ["name"] = "Second", ["pylons"] = {}, ["tasks"] = { [1] = SEAD } },
  },
  ["unitType"] = "F-16C_50",
}
return unitPayloads
`;

test("payload library files are read as data with only main-task identifiers allowed", () => {
  const dir = mkdtempSync(join(tmpdir(), "payloads-"));
  writeFileSync(join(dir, "F-16C_50.lua"), PAYLOADS);
  writeFileSync(join(dir, "evil.lua"), 'local unitPayloads = { ["unitType"] = os.execute("x") }\nreturn unitPayloads\n');
  writeFileSync(join(dir, "badident.lua"), 'local unitPayloads = { ["unitType"] = "A", ["payloads"] = { [1] = { ["tasks"] = { [1] = NOT_A_TASK } } } }\nreturn unitPayloads\n');
  const scan = scanPayloads(true, [dir]);
  assert.equal(scan.skipped.length, 2);
  assert.ok(scan.skipped.some((s) => /identifier 'NOT_A_TASK'/.test(s.reason)));
  const lib = loadoutsFor("F-16C_50", undefined, scan);
  assert.deepEqual(lib.loadouts.map((l) => [l.name, l.tasks]), [["Test CAP", ["CAP", "CAS"]], ["Second", ["SEAD"]]]);
  assert.deepEqual(loadoutsFor("F-16C_50", "sead", scan).loadouts.map((l) => l.name), ["Second"]);
  assert.equal(loadoutsFor("F-16C_50", undefined, scanPayloads(true, [])).status, "unknown");
  assert.throws(() => parseLuaDataFile("x = 1\nprint(x)", "x"), /non-data statement/);
  const m = mission();
  const r = applyLoadout(m, { group: "Viper" }, "Test CAP", scan);
  assert.deepEqual(r.units, ["Viper-1", "Viper-2"]);
  assert.ok(r.warnings.some((w) => /NOT-IN-PYDCS/.test(w)));
  const pylons = asTable(asTable(findUnit(rt(m), "Viper-2")!.payload)!.pylons)!;
  assert.equal((pylons[4] as LuaTable).CLSID, "{40EF17B7-F508-45de-8566-6FFECC0C1AB8}");
  assert.deepEqual((pylons[3] as LuaTable).settings, { mode: 2 });
  assert.throws(() => applyLoadout(m, { group: "Viper" }, "Nope", scan), /No loadout 'Nope'/);
  assert.throws(() => applyLoadout(m, { group: "Armor" }, "Test CAP", scan), /not an aircraft group/);
});
