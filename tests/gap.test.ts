import { test } from "node:test";
import assert from "node:assert/strict";
import { serializeLuaAssignment } from "../src/miz/serializer.js";
import { parseLuaAssignment, type LuaTable } from "../src/miz/lua.js";
import { addGroundGroup, addTriggerZone, newMissionTable } from "../src/miz/authoring.js";
import { addStatic } from "../src/miz/editing.js";

export function roundTrip(mission: LuaTable): LuaTable {
  return parseLuaAssignment(serializeLuaAssignment("mission", mission), "mission");
}
export const ground = (name: string, extra: Record<string, unknown> = {}) => ({
  side: "red" as const, country: "Russia", name, type: "T-72B", count: 2, x: 1000, y: 2000, ...extra,
});

test("duplicate trigger-zone names are refused", () => {
  const m = newMissionTable("Caucasus", 43200);
  addTriggerZone(m, { name: "Z", x: 0, y: 0, radius: 500 });
  assert.throws(() => addTriggerZone(m, { name: "Z", x: 10, y: 10, radius: 500 }), /already exists/);
});

test("duplicate group and unit names are refused without touching the mission", () => {
  const m = newMissionTable("Caucasus", 43200);
  addGroundGroup(m, "vehicle", ground("Armor"));
  const before = JSON.stringify(m);
  assert.throws(() => addGroundGroup(m, "vehicle", ground("Armor")), /Group 'Armor' already exists/);
  // A static named like an existing unit would collide on unit name.
  assert.throws(() => addStatic(m, { side: "red", country: "Russia", name: "Armor-1", type: "Fuel tank", x: 0, y: 0 }), /unit named 'Armor-1'/);
  assert.equal(JSON.stringify(m), before);
  // A group whose generated unit names collide with existing units is refused too.
  addStatic(m, { side: "red", country: "Russia", name: "Depot-1", type: "Fuel tank", x: 0, y: 0 });
  assert.throws(() => addGroundGroup(m, "vehicle", ground("Depot")), /unit named 'Depot-1'/);
});

import { addDrawing, clearLayer, listDrawings, oblongPoints, removeDrawing } from "../src/miz/drawings.js";
import { asTable, luaArray } from "../src/miz/lua.js";

test("every pydcs drawing primitive round-trips with its pydcs fields", () => {
  const m = newMissionTable("Caucasus", 43200);
  const o = { x: 1000, y: 2000 };
  addDrawing(m, { kind: "oval", name: "Ov", origin: o, radius1Metres: 500, radius2Metres: 200, angle: 30 });
  addDrawing(m, { kind: "rectangle", name: "Rc", origin: o, widthMetres: 300, heightMetres: 100, angle: 0, style: "dash" });
  addDrawing(m, { kind: "arrow", name: "Ar", origin: o, lengthMetres: 8000, angle: 90, layer: "Blue" });
  addDrawing(m, { kind: "icon", name: "Ic", origin: o, icon: "AirDefense", layer: "Red" });
  addDrawing(m, { kind: "line", name: "Fl", origin: o, mode: "free", points: [o, { x: 1100, y: 2100 }, { x: 1200, y: 2000 }] });
  addDrawing(m, { kind: "oblong", name: "Ob", origin: o, end: { x: 11000, y: 2000 }, radiusMetres: 1000 });
  addDrawing(m, { kind: "text", name: "Tx", origin: o, text: "HELLO", angle: 45 });
  const objs = luaArray(asTable(roundTrip(m).drawings)!.layers).flatMap((l) => luaArray(l.objects));
  const by = (n: string) => objs.find((x) => x.name === n)!;
  assert.deepEqual([by("Ov").polygonMode, by("Ov").r1, by("Ov").r2, by("Ov").angle], ["oval", 500, 200, 30]);
  assert.deepEqual([by("Rc").polygonMode, by("Rc").width, by("Rc").height, by("Rc").style], ["rect", 300, 100, "dash"]);
  assert.equal(by("Ar").polygonMode, "arrow"); assert.equal(by("Ar").length, 8000); assert.equal(luaArray(by("Ar").points).length, 8);
  assert.deepEqual([by("Ic").primitiveType, by("Ic").file, by("Ic").layerName], ["Icon", "P91000009.png", "Red"]);
  assert.equal(by("Fl").lineMode, "free");
  assert.equal(by("Tx").font, "DejaVuLGCSansCondensed.ttf"); assert.equal(by("Tx").angle, 45);
  // Oblong: free polygon whose first vertex is the origin and which is closed.
  const ob = luaArray(by("Ob").points);
  assert.equal(by("Ob").polygonMode, "free");
  assert.deepEqual(ob[0], { x: 0, y: 0 }); assert.deepEqual(ob[ob.length - 1], { x: 0, y: 0 });
  assert.equal(ob.length, 2 * 21 + 1);
});

test("oblong vertices sit exactly radius from the nearest end point", () => {
  const p1 = { x: 0, y: 0 }, p2 = { x: 0, y: 10000 };
  const pts = oblongPoints(p1, p2, 1000, 20);
  for (const p of pts.slice(0, 21)) assert.ok(Math.abs(Math.hypot(p.x - p2.x, p.y - p2.y) - 1000) < 1e-6);
  for (const p of pts.slice(21, 42)) assert.ok(Math.abs(Math.hypot(p.x - p1.x, p.y - p1.y) - 1000) < 1e-6);
});

test("drawings can be listed, removed and a layer cleared", () => {
  const m = newMissionTable("Caucasus", 43200);
  const o = { x: 0, y: 0 };
  for (const name of ["A", "B", "C"]) addDrawing(m, { kind: "circle", name, origin: o, radiusMetres: 10 });
  addDrawing(m, { kind: "circle", name: "R", origin: o, radiusMetres: 10, layer: "Red" });
  assert.equal(listDrawings(m).length, 4);
  removeDrawing(m, "Author", "B");
  const author = listDrawings(roundTrip(m), "Author");
  assert.deepEqual(author.map((d) => d.name), ["A", "C"]);
  assert.throws(() => removeDrawing(m, "Author", "B"), /No drawing/);
  assert.equal(clearLayer(m, "Author").removed, 2);
  assert.deepEqual(listDrawings(m).map((d) => d.name), ["R"]);
});

import { addAircraftGroup } from "../src/miz/authoring.js";
import { radioInfo, resetRadioPresets, setIntraFlightFrequency, setRadioPresets } from "../src/miz/radios.js";
import { listCloudPresets, setCloudPreset } from "../src/miz/weather.js";
import { findUnit, findGroup } from "../src/miz/authoring.js";

const viper = (name: string, skill = "Client") => ({ side: "blue" as const, country: "USA", name, type: "F-16C_50", count: 2,
  x: 0, y: 0, altitudeMetres: 6000, skill });

test("radio data comes from pydcs panel_radio and refuses unknown radios/channels", () => {
  const info = radioInfo("F-16C_50");
  assert.equal(info.defaultFrequencyMHz, 305);
  assert.equal(info.radios[0].channels, 20);
  assert.equal(info.bandsValidated, false);
  const m = newMissionTable("Caucasus", 43200);
  addAircraftGroup(m, "plane", viper("Viper"));
  setRadioPresets(m, "Viper-1", { radio: 1, channels: { 1: 251.5, 2: 260 } });
  const radio = findUnit(roundTrip(m), "Viper-1")!.Radio as LuaTable;
  const ch = (radio[1] as LuaTable).channels as LuaTable;
  assert.equal(ch[1], 251.5); assert.equal(ch[2], 260); assert.equal(ch[3], 265); // untouched default kept
  assert.ok((radio[2] as LuaTable).channels);
  assert.throws(() => setRadioPresets(m, "Viper-1", { radio: 9, channels: { 1: 250 } }), /no radio 9/);
  assert.throws(() => setRadioPresets(m, "Viper-1", { radio: 1, channels: { 21: 250 } }), /no channel 21/);
  resetRadioPresets(m, "Viper");
  assert.equal(((findUnit(m, "Viper-1")!.Radio as LuaTable)[1] as LuaTable).channels && (((findUnit(m, "Viper-1")!.Radio as LuaTable)[1] as LuaTable).channels as LuaTable)[1], 305);
});

test("intra-flight frequency follows pydcs set_frequency", () => {
  const m = newMissionTable("Caucasus", 43200);
  addAircraftGroup(m, "plane", viper("Client"));
  addAircraftGroup(m, "plane", { ...viper("Ai", "High"), y: 5000 });
  const r = setIntraFlightFrequency(m, "Client", 133, 2, 0);
  assert.deepEqual(r.presetUnits, ["Client-1", "Client-2"]);
  const g = findGroup(roundTrip(m), "Client")!.group;
  assert.equal(g.frequency, 133); assert.equal(g.radioSet, true); assert.equal(g.modulation, 0);
  assert.equal((((findUnit(m, "Client-2")!.Radio as LuaTable)[2] as LuaTable).channels as LuaTable)[1], 133);
  const ai = setIntraFlightFrequency(m, "Ai");
  assert.equal(ai.frequencyMHz, 305); assert.equal(ai.defaulted, true); assert.deepEqual(ai.presetUnits, []);
  assert.equal(findUnit(m, "Ai-1")!.Radio, undefined);
});

test("cloud presets follow pydcs _make_cloud_dict and validate_base", () => {
  assert.equal(listCloudPresets().length, 30);
  const m = newMissionTable("Caucasus", 43200);
  const r = setCloudPreset(m, "Light Scattered 1");
  assert.equal(r.preset, "Preset1"); assert.equal(r.baseMetres, 1200); // existing in-range base kept
  assert.equal(setCloudPreset(m, "Preset10").baseMetres, 1260); // out-of-range existing base -> preset minimum
  setCloudPreset(m, "Preset1", 1200);
  const clouds = (roundTrip(m).weather as LuaTable).clouds as LuaTable;
  assert.equal(clouds.preset, "Preset1"); assert.equal(clouds.iprecptns, 0);
  assert.throws(() => setCloudPreset(m, "Preset1", 100), /outside/);
  assert.throws(() => setCloudPreset(m, "NoSuch"), /Unknown cloud preset/);
  setCloudPreset(m, null);
  assert.equal(((m.weather as LuaTable).clouds as LuaTable).preset, undefined);
});

import { addUnitsToGroup, cloneGroup, findGroupsNear, setRoute } from "../src/miz/groups.js";
import { addWaypoint, maxIds } from "../src/miz/authoring.js";

test("clone gives fresh ids/names, moves the whole route and drops datalinks", () => {
  const m = newMissionTable("Caucasus", 43200);
  addGroundGroup(m, "vehicle", ground("Armor"));
  addWaypoint(m, "Armor", { x: 5000, y: 2000 });
  addAircraftGroup(m, "plane", { ...viper("Viper"), y: 9000 });
  (findUnit(m, "Viper-1")! as LuaTable).datalinks = { Link16: { network: { teamMembers: { 1: { missionUnitId: 3 } } } } };
  const before = maxIds(m);
  const r = cloneGroup(m, "Armor", { newName: "Armor2", dx: 100, dy: -50 });
  assert.deepEqual(r.units, ["Armor2-1", "Armor2-2"]);
  const rt = roundTrip(m);
  const g = findGroup(rt, "Armor2")!.group;
  assert.equal(g.groupId, before.groupId + 1);
  const pts = Object.values(((g.route as LuaTable).points as LuaTable)) as LuaTable[];
  assert.deepEqual([pts[0].x, pts[0].y, pts[1].x, pts[1].y], [1100, 1950, 5100, 1950]);
  assert.equal(findUnit(rt, "Armor2-1")!.unitId, before.unitId + 1);
  assert.equal(findGroup(rt, "Armor")!.group.name, "Armor"); // source untouched
  const v = cloneGroup(m, "Viper", { newName: "Viper2", side: "red", country: "Russia" });
  assert.equal(v.side, "red"); assert.equal(findUnit(m, "Viper2-1")!.datalinks, undefined);
  assert.ok(v.warnings.some((w) => /Datalinks dropped/.test(w)));
  assert.throws(() => cloneGroup(m, "Armor", { newName: "Armor2" }), /already exists/);
});

test("parking starts cannot be cloned or grown", () => {
  const m = newMissionTable("Caucasus", 43200);
  addAircraftGroup(m, "plane", { ...viper("Ramp", "High"), count: 1, start: { kind: "parking_cold", airfield: "Batumi" } });
  assert.throws(() => cloneGroup(m, "Ramp", { newName: "Ramp2" }), /parking start/);
  assert.throws(() => addUnitsToGroup(m, "Ramp", { count: 1 }), /parking start/);
});

test("added units trail the last unit along the heading with fresh ids", () => {
  const m = newMissionTable("Caucasus", 43200);
  addGroundGroup(m, "vehicle", ground("Col", { heading: 0 }));
  const r = addUnitsToGroup(m, "Col", { count: 2, type: "BMP-2" });
  assert.deepEqual(r.added, ["Col-3", "Col-4"]); assert.equal(r.total, 4);
  const u3 = findUnit(roundTrip(m), "Col-3")!, u2 = findUnit(m, "Col-2")!;
  assert.equal(u3.type, "BMP-2");
  assert.ok(Math.abs(Number(u2.x) - Number(u3.x) - 20) < 1e-9 && Math.abs(Number(u3.y) - Number(u2.y)) < 1e-9);
  addAircraftGroup(m, "plane", { ...viper("Air"), count: 2 });
  assert.throws(() => addUnitsToGroup(m, "Air", { count: 1, type: "FA-18C_hornet" }), /match the lead/);
  addUnitsToGroup(m, "Air", { count: 2 });
  const cs = findUnit(m, "Air-4")!.callsign as LuaTable | undefined;
  if (cs && typeof cs === "object") assert.equal(cs[3], 4);
  assert.throws(() => addUnitsToGroup(m, "Air", { count: 13 }), /at most 16/);
});

test("find near and set route", () => {
  const m = newMissionTable("Caucasus", 43200);
  addGroundGroup(m, "vehicle", ground("Near", { x: 0, y: 0 }));
  addGroundGroup(m, "vehicle", ground("Far", { x: 0, y: 50000 }));
  assert.deepEqual(findGroupsNear(m, { x: 0, y: 100, radiusMetres: 1000 }).map((g) => g.name), ["Near"]);
  assert.equal(findGroupsNear(m, { x: 0, y: 0, radiusMetres: 1e6, side: "blue" }).length, 0);
  addWaypoint(m, "Near", { x: 1, y: 1 }); addWaypoint(m, "Near", { x: 2, y: 2 });
  const r = setRoute(m, "Near", [{ x: 10, y: 10 }]);
  assert.equal(r.removed, 2); assert.equal(r.total, 2);
  const pts = Object.values(((findGroup(roundTrip(m), "Near")!.group.route as LuaTable).points as LuaTable)) as LuaTable[];
  assert.deepEqual(pts.map((p) => [p.x, p.ETA_locked]), [[0, true], [10, false]]);
});

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { liveriesForType, liveryStatus, parseDescription, scanLiveries } from "../src/dcs/liveries.js";

test("livery scan reads folders and description.lua as text, case-insensitively", () => {
  const root = mkdtempSync(join(tmpdir(), "liv-"));
  const dir = join(root, "f-16c_50");
  mkdirSync(join(dir, "Viper Grey"), { recursive: true });
  writeFileSync(join(dir, "Viper Grey", "description.lua"),
    '-- name = "commented"\nlivery = {}\nname = "Grey Viper"\ncountries = {"USA", "BEL"}\n');
  mkdirSync(join(dir, "placeholder"));
  writeFileSync(join(dir, "zipped.zip"), "");
  mkdirSync(join(root, "F-16C_50 Cockpit"));
  const scan = scanLiveries(true, [root]);
  const r = liveriesForType("F-16C_50", scan);
  assert.deepEqual(r.liveries.map((l) => [l.id, l.name, l.countries, l.zipped]).sort(),
    [["Viper Grey", "Grey Viper", ["USA", "BEL"], false], ["zipped", "zipped", null, true]]);
  assert.equal(liveryStatus("F-16C_50", "viper grey", undefined, scan).status, "installed");
  assert.match(liveryStatus("F-16C_50", "Viper Grey", "Russia", scan).reason!, /restricted/);
  assert.equal(liveryStatus("F-16C_50", "nope", undefined, scan).status, "not_installed");
  assert.equal(liveryStatus("F-16C_50", "x", undefined, scanLiveries(true, [])).status, "unknown");
  assert.deepEqual(parseDescription("livery = {}", "id"), { name: "id", countries: null });
});

import { buildPack, loadPacks, packProvider, removePack } from "../src/terrain/packs.js";
import type { TerrainProvider } from "../src/terrain/analysis.js";
import { lerp, pointFromBearing, pointsInZone, randomPointInCircle } from "../src/miz/geometry.js";

test("terrain packs store exactly what DCS sampled and serve it offline", async () => {
  const dir = mkdtempSync(join(tmpdir(), "packs-"));
  let calls = 0;
  // Stand-in for the live bridge: a tilted plane, water (surface 3) below x=0.
  const live: TerrainProvider = { source: "fake live", theatre: "Caucasus", resolutionMetres: null,
    async sample(points) { calls++; return points.map((p) => ({ ...p, height: p.x * 0.1 + p.y * 0.01, surface: p.x < 0 ? 3 : 1 })); } };
  const r = await buildPack(live, { theatre: "caucasus", name: "t1", origin: { x: -1000, y: 0 }, spacingMetres: 100, rows: 101, columns: 101 }, dir);
  assert.equal(r.theatre, "Caucasus"); assert.equal(r.rows * r.columns, 10201); assert.equal(calls, 2); // 8192-point batches
  const packs = loadPacks("Caucasus", dir);
  assert.equal(packs.length, 1); assert.match(packs[0].source, /fake live/);
  const provider = packProvider("Caucasus", packs);
  const [a, b, outside] = await provider.sample([{ x: 250, y: 350 }, { x: -500, y: 0 }, { x: 99999, y: 0 }]);
  assert.ok(Math.abs(a.height! - (25 + 3.5)) < 1e-9); // bilinear of a plane is exact
  assert.equal(b.surface, 3); assert.equal(outside.height, null);
  assert.equal(loadPacks("Syria", dir).length, 0);
  assert.throws(() => packProvider("Syria", []), /No terrain pack/);
  await assert.rejects(buildPack(live, { theatre: "Caucasus", name: "big", origin: { x: 0, y: 0 }, spacingMetres: 100, rows: 1000, columns: 1000 }, dir), /several packs/);
  assert.throws(() => removePack("Caucasus", "../x", dir), /Pack name/);
  removePack("Caucasus", "t1", dir);
  assert.equal(loadPacks(undefined, dir).length, 0);
});

test("geometry helpers use x north / y east and are reproducible with a seed", () => {
  const p = pointFromBearing({ x: 0, y: 0 }, 90, 1000);
  assert.deepEqual(p, { x: 0, y: 1000 });
  assert.deepEqual(lerp({ x: 0, y: 0 }, { x: 10, y: 20 }, 0.5), { x: 5, y: 10 });
  const r1 = randomPointInCircle({ x: 0, y: 0 }, 500, 50, 7), r2 = randomPointInCircle({ x: 0, y: 0 }, 500, 50, 7);
  assert.deepEqual(r1, r2);
  assert.ok(r1.every((q) => Math.hypot(q.x, q.y) <= 500 + 1e-6));
  const m = newMissionTable("Caucasus", 43200);
  addTriggerZone(m, { name: "C", x: 0, y: 0, radius: 100 });
  const zones = ((m.triggers as LuaTable).zones as LuaTable);
  zones[2] = { name: "Q", zoneId: 99, type: 2, x: 5, y: 5, radius: 10,
    verticies: { 1: { x: 0, y: 0 }, 2: { x: 0, y: 10 }, 3: { x: 10, y: 10 }, 4: { x: 10, y: 0 } } };
  assert.deepEqual(pointsInZone(m, "C", [{ x: 50, y: 50 }, { x: 90, y: 90 }]).results.map((r) => r.inside), [true, false]);
  const q = pointsInZone(m, "Q", [{ x: 5, y: 5 }, { x: 11, y: 5 }]);
  assert.equal(q.shape, "quad"); assert.deepEqual(q.results.map((r) => r.inside), [true, false]);
});
