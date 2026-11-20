#!/usr/bin/env node
/** Reproducible offline acceptance artifact. Build first; never calls a running DCS. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { newSession, refresh, saveSessionAs, openSession, closeSession } from '../../dist/miz/sessions.js';
import { createFlight } from '../../dist/miz/flight.js';
import { addGroundGroup, findGroup, findUnit, setPayload } from '../../dist/miz/authoring.js';
import { findAirport } from '../../dist/data/reference.js';
import { createGroundPlan, addThreatRing } from '../../dist/miz/operations.js';
import { editWarehouse, readWarehouses } from '../../dist/miz/logistics.js';
import { validateMission } from '../../dist/miz/validator.js';
import { gridProvider } from '../../dist/terrain/providers.js';
import { lineOfSight, slope } from '../../dist/terrain/analysis.js';
if (!process.argv[2]) throw new Error('Usage: npm run build && npm run verify:capabilities -- <new-output-directory>');
const outDir = path.resolve(process.argv[2]); await mkdir(outDir, { recursive: true });
const s = newSession('Caucasus', 43200), airport = findAirport('Caucasus', 'Kutaisi');
const station = { x: airport.x + 40000, y: airport.y };
addGroundGroup(s.mission, 'vehicle', { side: 'red', country: 'Russia', name: 'SAM-Osa', type: 'Osa 9A33 ln', count: 2, x: station.x + 50000, y: station.y });
const flight = createFlight(s.mission, { side: 'blue', country: 'USA', name: 'Hornet', type: 'FA-18C_hornet', count: 2,
  category: 'plane', role: 'BARCAP', x: 0, y: 0, start: { kind: 'parking_hot', airfield: 'Kutaisi' },
  orbit: { point: station, pattern: 'Race-Track', point2: { x: station.x + 20000, y: station.y }, altitudeMetres: 7000, speedMps: 210, durationSeconds: 1200 },
  config: { frequencyMHz: 251, tailNumbers: ['401', '402'], skills: ['Client', 'High'], formation: 'finger_four' } });
setPayload(s.mission, 'Hornet-1', { fuel: 4000 });
createGroundPlan(s.mission, { side: 'blue', country: 'USA', name: 'Patrol', type: 'M-1 Abrams', count: 2, x: airport.x + 1000, y: airport.y + 1000 },
  { role: 'patrol', onRoad: true, route: [{ x: airport.x + 5000, y: airport.y + 1000 }], playerCanDrive: true });
addThreatRing(s.mission, { name: 'Planning range supplied by author (not authoritative)', center: { x: station.x + 50000, y: station.y }, radiusMetres: 15000 });
s.warehouses = editWarehouse(s, 'airports', airport.id, { coalition: 'BLUE', unlimitedFuel: false, fuel: { jet_fuel: 25 } }, true);
refresh(s);
const validation = validateMission(s.document, s.mission); assert.equal(validation.ok, true, JSON.stringify(validation));
const saved = await saveSessionAs(s, path.join(outDir, 'capability-proof.miz'));
const back = await openSession(saved.outPath);
assert.equal(findUnit(back.mission, 'Hornet-2').onboard_num, '402');
assert.equal(findGroup(back.mission, 'Patrol').group.lateActivation, false);
assert.equal(readWarehouses(back).airports[airport.id].jet_fuel.InitFuel, 25);
// Analytical data tests ONLY: this grid has no relationship to the mission theatre's real elevations.
const grid = { theatre: 'Caucasus', source: 'SYNTHETIC ANALYTICAL TEST GRID, NOT DCS TERRAIN', origin: { x: 0, y: 0 }, spacingMetres: 100,
  rows: 11, columns: 11, heights: Array.from({ length: 121 }, (_, i) => Math.floor(i / 11) === 5 ? 200 : 0), surfaces: Array(121).fill(1) };
const provider = gridProvider(grid, 'Caucasus');
const los = await lineOfSight(provider, { x: 100, y: 500 }, { x: 900, y: 500 }, { stepMetres: 100, observerHeightMetres: 10, targetHeightMetres: 10, earthRadiusFactor: 1 });
assert.equal(los.terrainMasked, true);
const terrainSlope = await slope(provider, { x: 300, y: 500 }, 100); assert.equal(terrainSlope.slopeDegrees, 0);
const report = { verification: 'OFFLINE ONLY; no DCS or Mission Editor execution', node: process.version, platform: process.platform,
  artifact: saved, flight, validation, terrain: { source: grid.source, los, slopeDegrees: terrainSlope.slopeDegrees },
  remaining: ['Real terrain coverage requires supplied data or running DCS', 'No authoritative sensor model', 'Carrier recovery/deck compatibility, historical service dates, radio bands and new warehouse stock metadata remain unsupported'] };
await writeFile(path.join(outDir, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
closeSession(s.id); closeSession(back.id);
console.log(JSON.stringify({ ...saved, evidence: path.join(outDir, 'verification.json'), verification: report.verification }, null, 2));
