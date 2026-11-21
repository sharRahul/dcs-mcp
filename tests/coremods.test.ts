import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { coreModAircraft, enableCoreModTypes, parseAircraftDefinitions } from "../src/dcs/coremods.js";
import { findUnitType, registerInstallTypeSource, type FlyingType } from "../src/data/reference.js";

const HELO = `
local x = {
\tName = 'TEST_HELO',
\tDisplayName = _('Test Helo'),
\tTasks = {
\t\taircraft_task(CAP), -- 11
\t\taircraft_task(CAS),
\t\taircraft_task(MadeUpTask),
\t},
\tDefaultTask = aircraft_task(CAS),
\tCarriers = {
           Name = "HelicopterCarrier",
\t},
\tlength = 10.20,
\theight = 2.77,
\trotor_diameter = 10.668,
\tM_empty = base + 12, -- expression: must stay null
\tM_max = 2358.68,
\tM_fuel_max = 333.69, -- 109.8 US gallons
\tpassivCounterm = {
\t\tSingleChargeTotal = 30,
\t\tchaff = {default = 0, increment = 1, chargeSz = 1},
\t\tflare = {default = 30, increment = 1, chargeSz = 1}
\t},
\tPylons = { pylon(1, 0, 0, 0, 0, {}, { { CLSID = "TEST_AGM" }, { CLSID = "{TEST-2}" } }) },
}
add_aircraft(x)
`;

test("CoreMods definitions are parsed from literals only, nested Names skipped", () => {
  const [d, ...rest] = parseAircraftDefinitions(HELO, "aircraft/Test", "CoreMods/aircraft/Test/x.lua");
  assert.equal(rest.length, 0);
  assert.equal(d.type, "TEST_HELO");
  assert.equal(d.displayName, "Test Helo");
  assert.equal(d.category, "helicopter");
  assert.equal(d.fuelMaxKg, 333.69);
  assert.equal(d.massMaxKg, 2358.68);
  assert.equal(d.massEmptyKg, null);
  assert.deepEqual([d.chaff, d.flare], [0, 30]);
  assert.deepEqual(d.tasks, ["CAP", "CAS"]);
  assert.deepEqual(d.unknownTaskIds, ["MadeUpTask"]);
  assert.equal(d.defaultTask, "CAS");
  assert.deepEqual(d.clsids, ["TEST_AGM", "{TEST-2}"]);
});

test("an installed type pydcs lacks becomes placeable with its fuel; bundled ids still win", () => {
  const root = mkdtempSync(path.join(tmpdir(), "coremods-"));
  for (const d of ["Mods", "bin", "CoreMods/aircraft/Test"]) mkdirSync(path.join(root, d), { recursive: true });
  writeFileSync(path.join(root, "CoreMods/aircraft/Test/x.lua"), HELO + HELO.replace("TEST_HELO", "F-16C_50"));
  const env = { DCS_INSTALL_DIR: root, PROGRAMFILES: root, USERPROFILE: root } as NodeJS.ProcessEnv;
  try {
    assert.equal(coreModAircraft(env, true).aircraft.length, 2);
    assert.equal(enableCoreModTypes(env), 1);
    const hit = findUnitType("TEST_HELO")!;
    assert.equal(hit.source, "install");
    assert.equal((hit.entry as FlyingType).fuelMax, 333.69);
    assert.equal(findUnitType("F-16C_50")!.source, "bundled");
  } finally { registerInstallTypeSource(undefined); coreModAircraft({ DCS_INSTALL_DIR: "" } as NodeJS.ProcessEnv, true); }
});
