import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { serializeLuaAssignment } from "../src/miz/serializer.js";
import { asTable, type LuaTable } from "../src/miz/lua.js";
import { addAircraftGroup, findUnit, newMissionTable, setPayload } from "../src/miz/authoring.js";
import { fuelInfo, fuelKgFromPercent, fuelReport, listFuel } from "../src/miz/fuel.js";
import { radioInfo, setIntraFlightFrequency, setRadioPresets } from "../src/miz/radios.js";
import { radioBand } from "../src/data/radio-bands.js";
import { validateAuthoring } from "../src/miz/advanced-validation.js";
import { addStockFromDonor, harvest, importDonor, loadDonor } from "../src/miz/warehouse-donor.js";
import { closeSession, newSession, saveSessionAs } from "../src/miz/sessions.js";

const hog = (name: string, type = "A-10C", skill = "Client") => ({ side: "blue" as const, country: "USA", name, type, count: 2, x: 0, y: 0, altitudeMetres: 5000, skill });
const codes = (m: LuaTable) => validateAuthoring(m).map((i) => i.code);

test("fuel limits: every aircraft has a maximum, percent converts, validator flags bad values", () => {
  const all = listFuel();
  assert.ok(all.length >= 170 && all.every((t) => typeof t.fuelMaxKg === "number" && t.fuelMaxKg > 0));
  const max = fuelInfo("F-16C_50").fuelMaxKg!;
  assert.equal(fuelKgFromPercent("F-16C_50", 50), Math.round(max * 50) / 100);
  assert.throws(() => fuelKgFromPercent("F-16C_50", 101), /0-100/);
  assert.throws(() => fuelInfo("T-72B"), /not a known aircraft/);
  const m = newMissionTable("Caucasus", 43200);
  addAircraftGroup(m, "plane", { ...hog("Viper", "F-16C_50") });
  setPayload(m, "Viper-1", { fuel: max / 2 });
  // Writing fuel far above the tank is still refused; a rounding overshoot is not, because
  // the editor itself saves fuel a fraction over fuel_max.
  assert.throws(() => setPayload(m, "Viper-1", { fuel: max * 2 }), /above the aircraft's catalogued maximum/);
  setPayload(m, "Viper-1", { fuel: max + 0.4 });
  setPayload(m, "Viper-1", { fuel: max / 2 });
  (asTable(findUnit(m, "Viper-2")!.payload)!).fuel = "lots";
  const r = fuelReport(m);
  assert.equal(r.find((u) => u.unit === "Viper-1")!.percent, 50);
  assert.equal(r.find((u) => u.unit === "Viper-2")!.issue, "not a number");
  assert.ok(codes(m).includes("FUEL_NOT_NUMERIC"));
  // In an EXISTING mission the same value is catalogue staleness, not an error: the
  // validator was calibrated against 184 editor-saved missions, which carry
  // countermeasure counts above pydcs's and rounded fuel a hair over fuel_max.
  (asTable(findUnit(m, "Viper-2")!.payload)!).fuel = String(max * 2);
  const issues = validateAuthoring(m).filter((i) => i.code === "PAYLOAD_LIMIT");
  assert.equal(issues.length, 1);
  assert.equal(issues[0].severity, "warning");
  assert.match(issues[0].message, /catalogue staleness/);
});

test("radio bands are applied only where documented, and enforced there", () => {
  assert.deepEqual(radioBand("A-10C", 2)?.band, "UHF");
  assert.equal(radioBand("A-10C_2", 1), undefined); // defaults span bands: deliberately unmapped
  assert.equal(radioBand("F-16C_50", 1), undefined);
  assert.equal(radioInfo("A-10C").bandsValidated, true);
  assert.equal(radioInfo("F-16C_50").bandsValidated, false);
  const m = newMissionTable("Caucasus", 43200);
  addAircraftGroup(m, "plane", hog("Hog"));
  setRadioPresets(m, "Hog-1", { radio: 2, channels: { 1: 251 } });
  assert.throws(() => setRadioPresets(m, "Hog-1", { radio: 2, channels: { 1: 130 } }), /outside A-10C radio 2's UHF band 225-400/);
  assert.throws(() => setIntraFlightFrequency(m, "Hog", 40, 1), /VHF AM band 118-150/);
  setIntraFlightFrequency(m, "Hog", 124, 1);
  addAircraftGroup(m, "plane", { ...hog("Viper", "F-16C_50"), y: 5000 });
  const w = setRadioPresets(m, "Viper-1", { radio: 1, channels: { 1: 999 } });
  assert.ok(w.warnings.some((x) => /No documented band/.test(x)));
});

test("radio validator: structure, values, modulation and documented bands", () => {
  const m = newMissionTable("Caucasus", 43200);
  addAircraftGroup(m, "plane", hog("Hog"));
  setRadioPresets(m, "Hog-1", { radio: 2, channels: { 1: 251 } });
  assert.deepEqual(codes(m).filter((c) => c.startsWith("RADIO")), []);
  const radio = findUnit(m, "Hog-1")!.Radio as LuaTable;
  ((radio[2] as LuaTable).channels as LuaTable)[1] = 100;   // out of UHF
  ((radio[2] as LuaTable).channels as LuaTable)[99] = 300;  // no such channel
  ((radio[3] as LuaTable).channels as LuaTable)[1] = -5;    // invalid
  radio[7] = { channels: { 1: 250 } };                       // no such radio
  const g = asTable(asTable(asTable(asTable(asTable(m.coalition)!.blue)!.country)![1])!.plane)!;
  const group = asTable(asTable(g.group)![1])!;
  group.modulation = 3; group.frequency = 0;
  const c = codes(m);
  for (const code of ["RADIO_OUT_OF_BAND", "RADIO_UNKNOWN_CHANNEL", "RADIO_FREQUENCY_INVALID", "RADIO_UNKNOWN", "RADIO_MODULATION_INVALID"]) assert.ok(c.includes(code), code);
});

function warehouses(): LuaTable {
  return { airports: {
    12: { coalition: "BLUE", aircrafts: { planes: { "F-16C_50": { initialAmount: 4, wsType: { 1: 1, 2: 1, 3: 5, 4: 56 }, linkDynTempl: 9 },
      Bogus: { initialAmount: 1, wsType: { 1: 1, 2: 1, 3: 1, 4: 1 } } }, helicopters: { "AH-64D_BLK_II": { initialAmount: 2 } } },
      weapons: { 1: { initialAmount: 20, wsType: { 1: 4, 2: 4, 3: 7, 4: 24 }, future: "keep" }, 2: { initialAmount: 3 } } },
    13: { coalition: "BLUE", aircrafts: {}, weapons: {} } }, warehouses: {} };
}

test("warehouse donors supply real entries and nothing is fabricated", async () => {
  const h = harvest(warehouses());
  assert.deepEqual(Object.keys(h.aircraft.planes), ["F-16C_50"]);
  assert.deepEqual(h.weapons.map((w) => w.key), ["4.4.7.24"]);
  assert.ok(h.skipped.some((s) => /Bogus: unknown type/.test(s)) && h.skipped.some((s) => /AH-64D_BLK_II: no valid wsType/.test(s)));
  // A donor .miz on disk.
  const dir = mkdtempSync(join(tmpdir(), "donor-")), store = mkdtempSync(join(tmpdir(), "donor-store-"));
  const src = newSession("Caucasus", 43200), zip = new AdmZip(src.sourceBytes);
  zip.updateFile("warehouses", Buffer.from(serializeLuaAssignment("warehouses", warehouses())));
  src.sourceBytes = zip.toBuffer();
  const donorFile = join(dir, "donor.miz");
  await saveSessionAs(src, donorFile); closeSession(src.id);
  const imported = importDonor(donorFile, "test-donor", store);
  assert.deepEqual([imported.planes, imported.weapons], [1, 1]);
  assert.match(imported.source.sha256, /^[0-9a-f]{64}$/);
  assert.throws(() => importDonor(donorFile, "test-donor", store), /already exists/);
  const donor = loadDonor("test-donor", store);
  // Target: a session whose airport 13 has no stock.
  const target = newSession("Caucasus", 43200), tz = new AdmZip(target.sourceBytes);
  tz.updateFile("warehouses", Buffer.from(serializeLuaAssignment("warehouses", warehouses())));
  target.sourceBytes = tz.toBuffer();
  const after = addStockFromDonor(target, "airports", 13, donor, { aircraft: [{ category: "planes", type: "F-16C_50", quantity: 6 }], weapons: [{ wsType: "4.4.7.24", quantity: 8 }] });
  const wh = asTable(asTable(after.airports)![13])!;
  const plane = asTable(asTable(asTable(wh.aircrafts)!.planes)!["F-16C_50"])!;
  assert.deepEqual([plane.initialAmount, plane.unlimited, plane.linkDynTempl, (plane.wsType as LuaTable)[4]], [6, false, 9, 56]);
  const weapon = asTable(asTable(wh.weapons)![1])!;
  assert.deepEqual([weapon.initialAmount, weapon.future, wh.unlimitedMunitions, wh.unlimitedAircrafts], [8, "keep", false, false]);
  assert.throws(() => addStockFromDonor(target, "airports", 12, donor, { aircraft: [{ category: "planes", type: "F-16C_50", quantity: 1 }] }), /already stocked/);
  assert.throws(() => addStockFromDonor(target, "airports", 13, donor, { aircraft: [{ category: "planes", type: "FA-18C_hornet", quantity: 1 }] }), /no planes entry/);
  assert.throws(() => addStockFromDonor(target, "airports", 13, donor, { weapons: [{ wsType: "1.2.3.4", quantity: 1 }] }), /no weapon with wsType/);
  closeSession(target.id);
});
