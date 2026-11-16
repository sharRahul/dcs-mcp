import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import luaparse from 'luaparse';
import { createGroundPlan, addThreatRing, appendSurfaceTask } from '../src/miz/operations.js';
import { removeWaypoint } from '../src/miz/editing.js';
import { validateMission } from '../src/miz/validator.js';
import { buildMissionDocument } from '../src/miz/parser.js';
import { configureIads } from '../src/miz/iads.js';
import { newSession, closeSession } from '../src/miz/sessions.js';
import { addGroundGroup, addWaypoint, findGroup, newMissionTable } from '../src/miz/authoring.js';
import { SITE_TEMPLATES } from '../src/miz/templates.js';
import { asTable, luaArray, parseLuaAssignment, type LuaTable } from '../src/miz/lua.js';
import { serializeLuaAssignment } from '../src/miz/serializer.js';
const base = { side: 'blue' as const, country: 'USA', name: 'Convoy', type: 'M-1 Abrams', count: 3, x: 100, y: 200, heading: 90 };
function rt(m: LuaTable) { return parseLuaAssignment(serializeLuaAssignment('mission', m), 'mission'); }
for (const formation of ['column', 'line', 'wedge', 'rectangle'] as const) test(`ground ${formation} rotates offsets and retains movement intent`, () => {
  const m = newMissionTable('Caucasus', 43200);
  createGroundPlan(m, base, { role: 'convoy', formation, route: [{ x: 300, y: 400 }], spacingMetres: 40, onRoad: true, playerCanDrive: true, lateActivation: true });
  const group = findGroup(rt(m), 'Convoy')!.group, units = luaArray(group.units), points = luaArray(asTable(group.route)?.points);
  assert.equal(units.length, 3); assert.equal(group.lateActivation, true); assert.ok(units.every(u => u.playerCanDrive));
  assert.ok(Math.abs(Math.hypot(Number(units[1].x) - Number(units[0].x), Number(units[1].y) - Number(units[0].y)) - (formation === 'wedge' ? Math.sqrt(2) * 40 : 40)) < 1e-8);
  assert.ok(points.every(p => p.action === 'On Road')); assert.equal(points.length, 2);
  if (formation === 'column') assert.ok(Math.abs(Number(units[1].y) - 160) < 1e-8);
});
test('patrol loops with GoToWaypoint and defensive groups remain stationary', () => {
  const m = newMissionTable('Caucasus', 43200);
  createGroundPlan(m, base, { role: 'patrol', route: [{ x: 300, y: 400 }, { x: 300, y: 500 }] });
  const last = luaArray(asTable(findGroup(rt(m), 'Convoy')!.group.route)?.points).at(-1)!;
  const task = luaArray(asTable(asTable(last.task)?.params)?.tasks)[0];
  assert.equal(task.id, 'GoToWaypoint'); assert.equal(asTable(task.params)!.nWaypointIndx, 1);
  createGroundPlan(m, { ...base, name: 'Defence' }, { role: 'defensive', formation: 'line' });
  assert.equal(luaArray(asTable(findGroup(rt(m), 'Defence')!.group.route)?.points)[0].speed, 0);
  const before = serializeLuaAssignment('mission', m);
  assert.throws(() => createGroundPlan(m, { ...base, name: 'Bad', type: 'Not a type' }, { role: 'assault', route: [{ x: 0, y: 0 }] }), /Unknown vehicle/);
  assert.equal(serializeLuaAssignment('mission', m), before);
});
test('threat rings use only standard F10 layers and preserve unrelated drawings/options', () => {
  const m = newMissionTable('Caucasus', 43200);
  m.drawings = { options: { future: true }, layers: { 1: { name: 'Author', visible: true, objects: { 1: { name: 'Existing', future: 'keep' } } } } };
  addThreatRing(m, { name: 'SAM range (user supplied)', center: { x: 100, y: 200 }, radiusMetres: 25000 });
  const drawings = asTable(rt(m).drawings)!;
  assert.deepEqual(drawings.options, { future: true });
  const objects = luaArray(luaArray(drawings.layers)[0].objects);
  assert.equal(objects[0].future, 'keep'); assert.equal(objects[1].primitiveType, 'Polygon'); assert.equal(objects[1].radius, 25000);
  assert.throws(() => addThreatRing(m, { name: 'bad', center: { x: 0, y: 0 }, radiusMetres: -1 }));
  assert.throws(() => addThreatRing(m, { name: 'bad', center: { x: 0, y: 0 }, radiusMetres: 1, layer: 'Custom' as 'Author' }));
});
test('all SAM templates remain mixed single-group compositions with unchanged provenance', () => {
  const m = newMissionTable('Caucasus', 43200);
  for (const site of SITE_TEMPLATES) {
    addGroundGroup(m, 'vehicle', { side: 'red', country: 'Russia', name: site.id, type: site.composition[0].type, count: 1,
      x: 0, y: 0, composition: site.composition, spacingMetres: site.spacingMetres });
    const units = luaArray(findGroup(rt(m), site.id)!.group.units);
    assert.equal(units.length, site.composition.reduce((n, c) => n + c.count, 0));
    assert.deepEqual(units.map(u => u.type), site.composition.flatMap(c => Array(c.count).fill(c.type)));
  }
  assert.equal(SITE_TEMPLATES.find(s => s.id === 'SA-10')!.provenance, 'catalogue');
});
test('IADS setup follows MIST/Skynet loads, compiles Lua 5.1, preserves configuration and refuses unsafe matches', async () => {
  const s = newSession('Caucasus', 43200), dir = mkdtempSync(join(tmpdir(), 'dcs-iads-'));
  const mist = join(dir, 'mist.lua'), skynet = join(dir, 'skynet-iads.lua');
  writeFileSync(mist, '-- synthetic test framework, never executed\n'); writeFileSync(skynet, '-- synthetic test framework, never executed\n');
  addGroundGroup(s.mission, 'vehicle', { side: 'red', country: 'Russia', name: 'SAM-SA6', type: 'Kub 1S91 str', count: 1, x: 0, y: 0 });
  addGroundGroup(s.mission, 'vehicle', { side: 'red', country: 'Russia', name: 'EW-North', type: '55G6 EWR', count: 1, x: 0, y: 0 });
  const config = { name: "IADS ' north", side: 'red' as const, mistPath: mist, skynetPath: skynet, goLivePercent: 70, harmDetectionPercent: 90 };
  const result = await configureIads(s, config);
  assert.deepEqual(result.sams, ['SAM-SA6']); assert.deepEqual(result.ewrs, ['EW-North-1']);
  const back = rt(s.mission), rules = luaArray(back.trigrules), actions = luaArray(rules[0].actions);
  assert.equal(actions.length, 3); assert.equal(actions[0].predicate, 'a_do_script_file'); assert.equal(actions[1].predicate, 'a_do_script_file');
  const script = String(actions[2].text);
  assert.match(script, /ipairs\(iads:getSAMSites\(\)\)/); assert.match(script, /setGoLiveRangeInPercent\(70\)/);
  luaparse.parse(script, { luaVersion: '5.1' });
  assert.match(script, /DCSMCP_IADS\[/);
  luaparse.parse(readFileSync('scripts/dcs-mcp-telemetry.lua', 'utf8'), { luaVersion: '5.1' });
  luaparse.parse(String(asTable(asTable(back.trig)?.actions)?.[1]), { luaVersion: '5.1' });
  const before = serializeLuaAssignment('mission', s.mission);
  await assert.rejects(() => configureIads(s, config), /already configured/);
  await assert.rejects(() => configureIads(s, { ...config, name: 'missing', mistPath: join(dir, 'absent.lua') }), /not found/);
  assert.equal(serializeLuaAssignment('mission', s.mission), before);
  addGroundGroup(s.mission, 'vehicle', { ...base, name: 'SAM-Blue' });
  await assert.rejects(() => configureIads(s, { ...config, name: 'unsafe' }), /another coalition/);
  closeSession(s.id);
});

test('surface mission tasks preserve existing data for naval and ground routes', () => {
  const m = newMissionTable('Caucasus', 43200);
  addGroundGroup(m, 'ship', { ...base, name: 'Navy', type: 'PERRY', count: 1 });
  appendSurfaceTask(m, 'Navy', 1, { kind: 'fire_at_point', point: { x: 5000, y: 6000 }, rounds: 5, radiusMetres: 50 });
  appendSurfaceTask(m, 'Navy', 1, { kind: 'hold' });
  const wp = luaArray(asTable(findGroup(rt(m), 'Navy')!.group.route)?.points)[0];
  const tasks = luaArray(asTable(asTable(wp.task)?.params)?.tasks);
  assert.equal(tasks[0].id, 'FireAtPoint'); assert.equal(asTable(tasks[0].params)!.expendQty, 5);
  assert.equal(tasks[1].id, 'Hold');
  const before = serializeLuaAssignment('mission', m);
  assert.throws(() => appendSurfaceTask(m, 'Navy', 1, { kind: 'go_to_waypoint', destination: 1 }), /another existing/);
  assert.equal(serializeLuaAssignment('mission', m), before);
});

test('deleting a waypoint leaves opaque task data intact and validation catches the dangling destination', () => {
  const m = newMissionTable('Caucasus', 43200);
  addGroundGroup(m, 'ship', { ...base, name: 'Navy', type: 'PERRY', count: 1 });
  addWaypoint(m, 'Navy', { x: 500, y: 600 });
  appendSurfaceTask(m, 'Navy', 1, { kind: 'go_to_waypoint', destination: 2 });
  removeWaypoint(m, 'Navy', 2);
  const back = rt(m), report = validateMission(buildMissionDocument(back, {}, 'test'), back);
  assert.ok(report.errors.some(e => e.code === 'TASK_WAYPOINT_MISSING'));
  const wp = luaArray(asTable(findGroup(back, 'Navy')!.group.route)?.points)[0];
  assert.equal(asTable(luaArray(asTable(asTable(wp.task)?.params)?.tasks)[0].params)!.nWaypointIndx, 2);
});
