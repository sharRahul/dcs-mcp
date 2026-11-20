import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { luaArray, asTable } from "../src/miz/lua.js";
import { addAircraftGroup, addGroundGroup, findGroup, newMissionTable } from "../src/miz/authoring.js";
import { addAirWing, findNavalTemplate, NAVAL_TEMPLATES } from "../src/miz/dressing.js";
import { searchUnitTypes } from "../src/miz/editing.js";
import { buildMissionDocument } from "../src/miz/parser.js";
import { validateMission } from "../src/miz/validator.js";
import { countries, countryOffers, findCountry } from "../src/data/reference.js";
import { clearModCache, installedMods, scanModFolder } from "../src/dcs/mods.js";
import { designationFamilies } from "../src/miz/inventory.js";

test("every country carries DCS's own per-category unit list", () => {
  for (const c of countries()) {
    for (const k of ["plane", "helicopter", "ship", "vehicle"] as const) assert.ok(Array.isArray(c.units[k]), `${c.name}.${k}`);
  }
  assert.equal(countryOffers("USA", "FA-18C_hornet"), true);
  assert.equal(countryOffers("Russia", "Su-33"), true);
  assert.equal(countryOffers("USA", "S-300PS 5P85C ln"), false);
  assert.equal(countryOffers("USA", ".Command Center"), undefined); // statics: every country
  // pydcs lists these stock types for NO country; DCS offers and flies them
  // (a USA F-16C_50 spawned in every 2026-11-20 live run). Unknown, not "no".
  for (const t of ["F-16C_50", "F-14A", "F-4E", "Ka-50_3", "Mi-24P"]) assert.equal(countryOffers("USA", t), undefined, t);
  assert.equal(countryOffers("USA", "Su-33"), false); // a listed type still gates
  assert.ok(findCountry("India")!.units.plane.includes("Su-30"));
});

test("unit search narrows to a country's list", () => {
  const usa = searchUnitTypes("vehicle", "s-300", 50, { country: "USA", includeMods: false });
  assert.equal(usa.length, 0);
  const rus = searchUnitTypes("vehicle", "s-300", 50, { country: "Russia", includeMods: false });
  assert.ok(rus.length > 0 && rus.every((t) => t.source === "dcs"));
  assert.throws(() => searchUnitTypes(undefined, undefined, 5, { country: "Narnia" }), /Unknown country/);
});

test("validator flags a type the Mission Editor does not offer the country", () => {
  const m = newMissionTable("Caucasus", 43200);
  addGroundGroup(m, "vehicle", { side: "blue", country: "USA", name: "Odd", type: "S-300PS 5P85C ln", count: 1, x: 0, y: 0 });
  addGroundGroup(m, "vehicle", { side: "red", country: "Russia", name: "Fine", type: "S-300PS 5P85C ln", count: 1, x: 0, y: 0 });
  const w = validateMission(buildMissionDocument(m, {}, "t")).warnings.filter((x) => x.code === "COUNTRY_TYPE_NOT_OFFERED");
  assert.equal(w.length, 1);
  assert.match(w[0].message, /USA/);
});

test("carrier air wing: ship starts on the lead ship, country-filtered, nothing swapped", () => {
  const m = newMissionTable("Caucasus", 43200);
  const t = findNavalTemplate("csg");
  addGroundGroup(m, "ship", {
    side: "blue", country: "USA", name: "CSG", type: t.ships[0].type, count: t.ships.length,
    composition: t.ships.map((s) => ({ type: s.type, count: 1 })),
    offsets: t.ships.map(({ forward, right }) => ({ forward, right })), x: -300000, y: 400000,
  });
  const r = addAirWing(m, { side: "blue", country: "USA", deck: "CSG-1", namePrefix: "CVW", squadrons: t.airWing! });
  assert.equal(r.skipped.length, 0, JSON.stringify(r.skipped));
  assert.equal(r.groups.length, t.airWing!.length);
  const cvnId = findGroup(m, "CSG")!.group["units"] as Record<number, Record<string, unknown>>;
  for (const g of r.groups) {
    const p1 = asTable(asTable(asTable(findGroup(m, g.name)!.group["route"])!["points"])![1])!;
    assert.equal(p1["linkUnit"], cvnId[1]["unitId"]);
    assert.equal(p1["type"], "TakeOffParking");
  }
  // Su-33 is not offered to the USA: skipped with the reason, not replaced.
  const r2 = addAirWing(m, {
    side: "blue", country: "USA", deck: "CSG-1", namePrefix: "Odd",
    squadrons: [{ type: "Su-33", count: 2, category: "plane" }],
  });
  assert.equal(r2.groups.length, 0);
  assert.match(r2.skipped[0].reason, /does not offer Su-33 to USA/);
});

test("every template air wing type is offered to a country of the template's side", () => {
  for (const t of NAVAL_TEMPLATES) {
    const country = t.side === "blue" ? "USA" : "Russia";
    for (const sq of t.airWing ?? []) assert.equal(countryOffers(country, sq.type), true, `${t.id}: ${sq.type}`);
  }
});

test("mod scanner reads declarations as text, ignoring comments", () => {
  const root = mkdtempSync(join(tmpdir(), "dcs-mods-"));
  const plane = join(root, "Mods", "aircraft", "Su-30MKI-Mod");
  mkdirSync(join(plane, "Liveries"), { recursive: true });
  writeFileSync(join(plane, "entry.lua"), `declare_plugin("Su-30MKI by Example", { installed = true })\nmake_flyable('Su-30MKI', current_mod_path..'/Cockpit/')\n-- make_flyable('Su-30OLD')\n`);
  writeFileSync(join(plane, "Su-30MKI.lua"), `local su30 = { Name = 'Su-30MKI', DisplayName = _('Su-30MKI') }\nadd_aircraft(su30)\n`);
  const tech = join(root, "Mods", "tech", "Akash");
  mkdirSync(tech, { recursive: true });
  writeFileSync(join(tech, "akash.lua"), `GT = {}\nGT.Name = "Akash_LN"\nadd_surface_unit(GT)\n`);

  const mod = scanModFolder(plane, "aircraft");
  assert.equal(mod.id, "Su-30MKI by Example");
  assert.deepEqual(mod.units.map((u) => [u.type, u.category]), [["Su-30MKI", "plane"]]);

  clearModCache();
  const all = installedMods(true, [join(root, "Mods")]);
  assert.deepEqual(all.map((m) => m.units.map((u) => u.type)).flat().sort(), ["Akash_LN", "Su-30MKI"]);
  clearModCache();
});

test("designation families match variants to DCS families", () => {
  assert.deepEqual([...designationFamilies("Sukhoi Su-30MKI")], ["su30"]);
  assert.ok(designationFamilies("Boeing F/A-18E/F Super Hornet").has("fa18"));
  assert.ok(designationFamilies("FA-18C_hornet").has("fa18"));
});

test("real-world inventory: known matches hold (Wikipedia snapshot)", async () => {
  const { countryInventory } = await import("../src/miz/inventory.js");
  const india = countryInventory("India", []);
  const mki = india.aircraft.find((r) => /Su-30MKI/.test(r.name))!;
  assert.ok(mki, "Su-30MKI row");
  assert.deepEqual(mki.dcs, ["Su-30"]);
  assert.equal(mki.availability, "dcs-for-country");
  const rafale = india.aircraft.find((r) => /Rafale/.test(r.name))!;
  assert.equal(rafale.availability, "missing");
  const usa = countryInventory("USA", []);
  assert.ok(usa.aircraft.find((r) => /F\/A-18C/.test(r.name))!.dcs.includes("FA-18C_hornet"));
  const russia = countryInventory("Russia", []);
  assert.ok(russia.ground.find((r) => /Buk/.test(r.name))!.dcs.some((t) => t.startsWith("SA-11 Buk")));
  // A real type DCS lacks is matched to an installed mod by designation family.
  const withMod = countryInventory("India", [
    { id: "Example Tejas mod", folder: "x", kind: "aircraft", units: [{ type: "Tejas_Mk1", category: "plane", file: "entry.lua" }] },
    { id: "Example MKI mod", folder: "y", kind: "aircraft", units: [{ type: "Su-30MKI", category: "plane", file: "entry.lua" }] },
  ]);
  const tejas = withMod.aircraft.find((r) => /Tejas/.test(r.name))!;
  assert.equal(tejas.availability, "mod");
  assert.deepEqual(tejas.mods, [{ type: "Tejas_Mk1", mod: "Example Tejas mod" }]);
  // DCS has the Su-30 family, but the exact-variant mod is still pointed out.
  const mki2 = withMod.aircraft.find((r) => /Su-30MKI/.test(r.name))!;
  assert.equal(mki2.availability, "dcs-for-country");
  assert.ok(mki2.mods.some((m) => m.type === "Su-30MKI"));
  assert.throws(() => countryInventory("Narnia", []), /Unknown country/);
});

test("auto air wing is narrowed by data: pydcs country list + Wikipedia, never swapped", async () => {
  const { autoAirWing } = await import("../src/miz/dressing.js");
  const usa = autoAirWing(findNavalTemplate("csg"), "USA");
  const kept = usa.squadrons.map((s) => s.type);
  assert.ok(kept.includes("FA-18C_hornet") && kept.includes("E-2C"));
  // Retired from US service, so absent from the Wikipedia list: dropped and reported.
  for (const retired of ["F-14B", "S-3B Tanker"]) {
    assert.ok(!kept.includes(retired));
    assert.match(usa.dropped.find((d) => d.type === retired)!.reason, /Wikipedia/);
  }
  assert.match(usa.basis, /Wikipedia/);
  const rus = autoAirWing(findNavalTemplate("kuznetsov-group"), "Russia");
  assert.deepEqual(rus.squadrons.map((s) => s.type), ["Su-33", "Ka-27"]);
  // A country DCS does not offer these types to gets nothing, with pydcs as the reason.
  const odd = autoAirWing(findNavalTemplate("kuznetsov-group"), "USA");
  assert.equal(odd.squadrons.length, 0);
  assert.ok(odd.dropped.every((d) => /pydcs/.test(d.reason)));
});

test("mods are strictly additive and discovery never fails the caller", () => {
  const root = mkdtempSync(join(tmpdir(), "dcs-mods2-"));
  const mod = join(root, "Mods", "aircraft", "Clash");
  mkdirSync(mod, { recursive: true });
  // A mod re-declaring a stock DCS type id must not turn it into a mod type.
  writeFileSync(join(mod, "entry.lua"), `make_flyable('FA-18C_hornet')\nmake_flyable('Totally_New_Jet')\n`);
  clearModCache();
  const found = installedMods(true, [join(root, "Mods")]);
  assert.equal(found.length, 1);
  // Unreadable / missing roots: no throw, no mods.
  assert.deepEqual(installedMods(true, [join(root, "does-not-exist"), "\u0000bad"]), []);
  clearModCache();

  // Search puts DCS first and never lists a stock id as a mod.
  const hits = searchUnitTypes("plane", "FA-18C_hornet", 50);
  assert.ok(hits.every((h) => h.source === "dcs"));
});

test("real-world matches record exact vs family", async () => {
  const { countryInventory } = await import("../src/miz/inventory.js");
  const usa = countryInventory("USA", []);
  const c17 = usa.aircraft.find((r) => /C-17A/.test(r.name))!;
  assert.deepEqual(c17.exact, ["C-17A"]);
  const mki = countryInventory("India", []).aircraft.find((r) => /Su-30MKI/.test(r.name))!;
  assert.deepEqual(mki.exact, []); // Su-30 is the family, not the MKI
});
