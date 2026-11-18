import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addAircraftGroup, eachGroup, findGroup, findUnit, occupiedParking, newMissionTable } from '../src/miz/authoring.js';
import { populateAirfield } from '../src/miz/dressing.js';
import { addStatic } from '../src/miz/editing.js';
import { findAirport, findUnitType } from '../src/data/reference.js';
import { luaArray, parseLuaAssignment } from '../src/miz/lua.js';
import { serializeLuaAssignment } from '../src/miz/serializer.js';

test('Iron Veil includes visible parked planes, helicopters and equipment while retaining flight slots', async () => {
  // Scenario helper accepts the authoring function so tests use source, builders use dist.
  const { populateIronVeilAirfields } = await import('../scripts/iron-veil-airfields.mjs');
  const m = newMissionTable('Caucasus', 43200);
  addAircraftGroup(m, 'plane', { side: 'blue', country: 'USA', name: 'Player', type: 'F-16C_50', count: 2, x: 0, y: 0,
    start: { kind: 'parking_cold', airfield: 'Kutaisi' } });
  const occupied = luaArray(findGroup(m, 'Player')!.group.units).map(u => [u.x, u.y]);
  const manifest = populateIronVeilAirfields(m, populateAirfield, { addStatic, findUnit, findGroup, findAirport, findUnitType, occupiedParking, enableInstalledSceneryTypes: () => [] });
  assert.equal(manifest.length, 4);
  const back = parseLuaAssignment(serializeLuaAssignment('mission', m), 'mission');
  const categories = new Set(); let count = 0;
  eachGroup(back, (g, category) => {
    if (category !== 'static') return;
    assert.equal(g.dead, false); assert.equal(g.hidden, false);
    for (const u of luaArray(g.units)) {
      categories.add(u.category); count++;
      assert.ok(!occupied.some(([x, y]) => Math.hypot(Number(x) - Number(u.x), Number(y) - Number(u.y)) < 20), 'static overlaps player');
    }
  });
  assert.ok(count > 28, 'servicing and staging props are missing');
  const types = new Set<string>(); eachGroup(back, g => { for (const u of luaArray(g.units)) types.add(String(u.type)); });
  for (const type of ['Ladder', 'Toolbox01', 'ammo_cargo', 'M92_Ammo_Pallet', 'Ural-4320 APA-5D']) assert.ok(types.has(type), type);
  for (const scene of manifest) {
    assert.ok(scene.zones.some(z => z.role === 'servicing'));
    assert.ok(scene.zones.some(z => z.role === 'ordnance' || z.role === 'cargo'));
    assert.ok(scene.placed.length > scene.zones.length, 'each prop consumed its own parking stand');
    for (const prop of scene.placed.filter(p => p.parentAircraft)) {
      const parent = findUnit(back, prop.parentAircraft)!;
      const ref = findUnitType(String(parent.type))!.entry as {width:number;length:number};
      const dx = Number(findUnit(back, prop.name)!.x) - Number(parent.x), dy = Number(findUnit(back, prop.name)!.y) - Number(parent.y);
      const h = Number(parent.heading), forward = dx*Math.cos(h)+dy*Math.sin(h), right = -dx*Math.sin(h)+dy*Math.cos(h);
      assert.ok(Math.abs(forward) > ref.length/2 + prop.clearanceRadiusMetres || Math.abs(right) > ref.width/2 + prop.clearanceRadiusMetres, `${prop.type} overlaps ${parent.type}`);
    }
  }
  for (const c of ['Planes', 'Helicopters', 'Vehicles']) assert.ok(categories.has(c), String(c));
});
