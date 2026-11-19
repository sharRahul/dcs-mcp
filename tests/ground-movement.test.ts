import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createGroundPlan } from '../src/miz/operations.js';
import { findGroup, newMissionTable } from '../src/miz/authoring.js';
import { luaArray, asTable } from '../src/miz/lua.js';
import { generateScenario, validateScenario } from '../src/scenario/engine.js';
import { closeSession } from '../src/miz/sessions.js';

const args = { side: 'blue' as const, country: 'USA', name: 'Ground', type: 'M-1 Abrams', count: 3, x: 100, y: 200 };
test('convoy transit defaults to native road routing, with explicit off-road override', () => {
  for (const [onRoad, want] of [[undefined, 'On Road'], [false, 'Off Road']] as const) {
    const m = newMissionTable('Caucasus', 43200);
    createGroundPlan(m, args, { role: 'convoy', onRoad, route: [{ x: 500, y: 200 }] });
    assert.ok(luaArray(asTable(findGroup(m, 'Ground')!.group.route)?.points).every(p => p.action === want));
  }
});
test('assault defaults to parallel placement and moving line abreast, not a spawn-only line', () => {
  const m = newMissionTable('Caucasus', 43200);
  createGroundPlan(m, args, { role: 'assault', spacingMetres: 40, route: [{ x: 500, y: 200 }] });
  const g = findGroup(m, 'Ground')!.group;
  assert.deepEqual(luaArray(g.units).map(u => [u.x, u.y]), [[100, 200], [100, 240], [100, 280]]);
  assert.ok(luaArray(asTable(g.route)?.points).every(p => p.action === 'Rank'));
});
test('route legs change from road transit to combat line and inherit the selected movement', () => {
  const m = newMissionTable('Caucasus', 43200);
  createGroundPlan(m, args, { role: 'convoy', route: [
    { x: 500, y: 200 }, { x: 700, y: 200, movement: 'line_abreast' }, { x: 900, y: 200 },
    { x: 1100, y: 200, movement: 'road', speedMps: 8 },
  ] });
  const ps = luaArray(asTable(findGroup(m, 'Ground')!.group.route)?.points);
  assert.deepEqual(ps.map(p => p.action), ['On Road', 'On Road', 'Rank', 'Rank', 'On Road']);
  assert.equal(ps.at(-1)!.speed, 8);
});
test('scenario ground plans preserve native road intent through generation', () => {
  const spec = JSON.parse(readFileSync('examples/scenarios/convoy-escort.json', 'utf8'));
  spec.forces.find((f: { name: string }) => f.name === 'Convoy').groundPlan = { role: 'convoy' };
  const b = generateScenario(spec);
  try { assert.ok(luaArray(asTable(findGroup(b.session.mission, 'Convoy')!.group.route)?.points).every(p => p.action === 'On Road')); }
  finally { closeSession(b.session.id); }
});

test('aircraft and SAM site templates reject ground movement plans instead of discarding them', () => {
  const spec = JSON.parse(readFileSync('examples/scenarios/interception.json', 'utf8'));
  spec.forces[0].groundPlan = { role: 'convoy' };
  assert.throws(() => generateScenario(spec), /groundPlan requires a vehicle/);
  const sead = JSON.parse(readFileSync('examples/scenarios/sead-strike.json', 'utf8'));
  const sam = sead.forces.find((f: { name: string }) => f.name === 'Corridor SAM');
  sam.site = 'SA-6'; sam.groundPlan = { role: 'defensive' };
  assert.throws(() => generateScenario(sead), /groundPlan requires a vehicle/);
});

test('scenario validation rejects ground route speeds and role constraints before generation', () => {
  for (const speed of [0, 51]) {
    const spec = JSON.parse(readFileSync('examples/scenarios/convoy-escort.json', 'utf8'));
    const convoy = spec.forces.find((f: { name: string }) => f.name === 'Convoy');
    convoy.route[0].speedMps = speed;
    assert.throws(() => validateScenario(spec));
  }
  const spec = JSON.parse(readFileSync('examples/scenarios/convoy-escort.json', 'utf8'));
  spec.forces.find((f: { name: string }) => f.name === 'Convoy').groundPlan.role = 'defensive';
  assert.throws(() => validateScenario(spec), /Defensive positions do not take movement routes/);
});
