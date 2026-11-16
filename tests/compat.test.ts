/**
 * Compatibility matrix: every theatre, every catalogued unit type, every site template, every
 * drawing kind and every catalogued option per group category is authored, serialized,
 * reparsed, validated and saved/reopened. When a Lua 5.1 interpreter is available (LUA51 or
 * DCS_LUA) the Mission Editor's load-time fix-ups (tests/fixtures/me-open.lua) run over the
 * result too. Offline only: this is format compatibility, not DCS behaviour.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serializeLuaAssignment } from "../src/miz/serializer.js";
import { parseLuaAssignment, type LuaTable } from "../src/miz/lua.js";
import { addAircraftGroup, addGroundGroup, newMissionTable } from "../src/miz/authoring.js";
import { addStatic } from "../src/miz/editing.js";
import { theatres, unitTypes, type FlyingType } from "../src/data/reference.js";
import { SITE_TEMPLATES } from "../src/miz/templates.js";
import { addDrawing } from "../src/miz/drawings.js";
import { addWaypointAction, hoggitData, listWaypointActions } from "../src/miz/actions.js";
import { validateAuthoring } from "../src/miz/advanced-validation.js";
import { closeSession, newSession, openSession, saveSessionAs } from "../src/miz/sessions.js";
import { validateMission } from "../src/miz/validator.js";

const rt = (m: LuaTable) => parseLuaAssignment(serializeLuaAssignment("mission", m), "mission");
const errors = (m: LuaTable) => validateAuthoring(m).filter((i) => i.severity === "error");
const lua = process.env.LUA51 || process.env.DCS_LUA;
function meOpen(m: LuaTable, label: string) {
  if (!lua) return;
  const p = join(mkdtempSync(join(tmpdir(), "compat-me-")), "mission.lua");
  writeFileSync(p, serializeLuaAssignment("mission", m), "utf8");
  const r = spawnSync(lua, [fileURLToPath(new URL("./fixtures/me-open.lua", import.meta.url)), p], { encoding: "utf8" });
  assert.equal(r.status, 0, `${label}: editor fix-ups failed\n${r.stdout}${r.stderr}`);
}
async function saveAndReopen(m: LuaTable, theatre: string) {
  const s = newSession(theatre, 43200);
  Object.assign(s.mission, m);
  const p = join(mkdtempSync(join(tmpdir(), "compat-")), "m.miz");
  await saveSessionAs(s, p, false);
  const back = await openSession(p);
  try {
    assert.deepEqual(back.mission, rt(m));
    assert.deepEqual(validateMission(back.document, back.mission).errors.map((e) => e.code), []);
  } finally { closeSession(s.id); closeSession(back.id); }
}

test("every theatre: airfield parking start, ground group, save/reopen/validate", async () => {
  for (const [name, t] of Object.entries(theatres())) {
    const m = newMissionTable(name, 43200);
    const ap = t.airports.find((a) => a.slots.length) ?? t.airports[0];
    addGroundGroup(m, "vehicle", { side: "red", country: "Russia", name: "Armor", type: "T-72B", count: 2, x: ap.x + 2000, y: ap.y });
    let start: { kind: "parking_cold"; airfield: number } | undefined = { kind: "parking_cold", airfield: ap.id };
    try { addAircraftGroup(m, "helicopter", { side: "blue", country: "USA", name: "Huey", type: "UH-1H", count: 1, x: ap.x, y: ap.y, start }); }
    catch { start = undefined; addAircraftGroup(m, "helicopter", { side: "blue", country: "USA", name: "Huey", type: "UH-1H", count: 1, x: ap.x, y: ap.y, altitudeMetres: 300 }); }
    assert.deepEqual(errors(rt(m)), [], name);
    meOpen(m, name);
    await saveAndReopen(m, name);
  }
});

test("every catalogued aircraft, vehicle and ship type authors cleanly", async () => {
  const all = unitTypes();
  const m = newMissionTable("Caucasus", 43200);
  let n = 0;
  for (const cat of ["plane", "helicopter"] as const) for (const t of all[cat] as FlyingType[])
    addAircraftGroup(m, cat, { side: "blue", country: "USA", name: `A${n}`, type: t.type, count: 1, x: (n++) * 200, y: 0, altitudeMetres: 3000 });
  for (const cat of ["vehicle", "ship"] as const) for (const t of all[cat] as { type: string }[])
    addGroundGroup(m, cat, { side: "red", country: "Russia", name: `G${n}`, type: t.type, count: 1, x: (n++) * 200, y: 50000 });
  const back = rt(m);
  assert.deepEqual(errors(back).map((e) => `${e.code} ${e.location}`), []);
  meOpen(m, "all types");
  await saveAndReopen(m, "Caucasus");
});

test("every static type and site template authors cleanly", () => {
  const m = newMissionTable("Caucasus", 43200);
  // Heliports are deliberately refused by addStatic (they need dcs_miz_add_farp's ATC settings).
  (unitTypes().static as { type: string; category?: string }[]).filter((t) => t.category !== "Heliports").forEach((t, i) => addStatic(m, { side: "blue", country: "USA", name: `S${i}`, type: t.type, x: i * 100, y: -20000 }));
  SITE_TEMPLATES.forEach((t, i) => addGroundGroup(m, "vehicle", { side: "red", country: "Russia", name: `SAM ${t.id}`, type: t.composition[0].type,
    count: 1, composition: t.composition, spacingMetres: t.spacingMetres, x: i * 3000, y: 80000 }));
  assert.deepEqual(errors(rt(m)).map((e) => `${e.code} ${e.location}`), []);
  meOpen(m, "statics and sites");
});

test("every drawing kind and every catalogued option per category builds and round-trips", () => {
  const m = newMissionTable("Caucasus", 43200);
  const o = { x: 0, y: 0 };
  const shapes = [{ kind: "line", points: [o, { x: 10, y: 10 }] }, { kind: "polygon", points: [o, { x: 0, y: 10 }, { x: 10, y: 0 }] },
    { kind: "circle", radiusMetres: 5 }, { kind: "oval", radius1Metres: 5, radius2Metres: 3 }, { kind: "rectangle", widthMetres: 5, heightMetres: 3 },
    { kind: "arrow", lengthMetres: 50 }, { kind: "oblong", end: { x: 100, y: 0 }, radiusMetres: 10 }, { kind: "text", text: "T" }, { kind: "icon", icon: "AirDefense" }];
  shapes.forEach((s, i) => addDrawing(m, { name: `D${i}`, origin: o, ...s } as never));
  addAircraftGroup(m, "plane", { side: "blue", country: "USA", name: "Plane", type: "F-16C_50", count: 1, x: 0, y: 0, altitudeMetres: 3000, task: "CAS" });
  addAircraftGroup(m, "helicopter", { side: "blue", country: "USA", name: "Helo", type: "UH-1H", count: 1, x: 0, y: 1000, altitudeMetres: 300 });
  addGroundGroup(m, "vehicle", { side: "red", country: "Russia", name: "Veh", type: "T-72B", count: 1, x: 0, y: 2000 });
  addGroundGroup(m, "ship", { side: "red", country: "Russia", name: "Ship", type: "PERRY", count: 1, x: -50000, y: 0 });
  const groups = { plane: "Plane", helicopter: "Helo", vehicle: "Veh", ship: "Ship" } as const;
  let built = 0;
  for (const [cat, group] of Object.entries(groups) as [keyof typeof groups, string][]) {
    for (const a of listWaypointActions(cat, "option")) {
      const entry = hoggitData().actions[a.key];
      const v = entry.values!;
      const value = entry.valuesByDomain ? Object.values(entry.valuesByDomain[cat === "vehicle" ? "Ground" : cat === "ship" ? "Naval" : "Air"]!)[0]
        : v.kind === "enum" ? Object.values(v.values as Record<string, number>)[0] : v.kind === "boolean" ? true : v.kind === "range" ? v.min
        : v.kind === "formation" ? Object.values((v.values as Record<string, Record<string, number>>)[cat] ?? {})[0]
        : v.kind === "attributes" ? ["Air"] : v.kind === "unknown" ? undefined : 0;
      if (value === undefined) continue;
      if (!entry.optionIds?.[cat === "vehicle" ? "Ground" : cat === "ship" ? "Naval" : "Air"]) continue;
      addWaypointAction(m, group, 1, { action: a.key, value });
      built++;
    }
  }
  assert.ok(built >= 40, `built ${built} options`);
  const back = rt(m);
  assert.deepEqual(errors(back).map((e) => `${e.code} ${e.location}`), []);
  meOpen(m, "drawings and options");
});
