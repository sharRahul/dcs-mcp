import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serializeLuaAssignment } from '../src/miz/serializer.js';
import { asTable, luaArray, parseLuaAssignment, type LuaTable } from '../src/miz/lua.js';
import { addAircraftGroup, addGroundGroup, addWaypoint, findGroup, newMissionTable } from '../src/miz/authoring.js';
import { getMissionValue, parsePath, setMissionValue } from '../src/miz/raw.js';
import { makeTroopTransport } from '../src/miz/transport.js';

const rt = (m: LuaTable) => parseLuaAssignment(serializeLuaAssignment('mission', m), 'mission');

function mission() {
  const m = newMissionTable('Caucasus', 43200);
  addAircraftGroup(m, 'helicopter', { side: 'blue', country: 'USA', name: 'Lift', type: 'UH-1H', count: 1, x: 0, y: 0, altitudeMetres: 500, task: 'Transport' });
  addWaypoint(m, 'Lift', { x: 5000, y: 0 });
  addWaypoint(m, 'Lift', { x: 12000, y: 0 });
  addGroundGroup(m, 'vehicle', { side: 'blue', country: 'USA', name: 'Infantry', type: 'Soldier M4', count: 4, x: 5050, y: 20 });
  return m;
}

test('a path is parsed into dotted names and 1-based indices, or refused', () => {
  assert.deepEqual(parsePath('coalition.blue.country[1].plane.group[2].name'),
    ['coalition', 'blue', 'country', 1, 'plane', 'group', 2, 'name']);
  assert.deepEqual(parsePath('["forced options"].fuel'), ['forced options', 'fuel']);
  assert.throws(() => parsePath(''), /path is required/);
  assert.throws(() => parsePath('a..b'), /Cannot parse path/);
  assert.throws(() => parsePath('a[b]'), /Cannot parse path/);
  // JavaScript's own object machinery is not mission data: writing it would reach
  // Object.prototype instead of the mission and pollute every object in the process.
  for (const bad of ['__proto__', 'a.__proto__.x', '["constructor"].prototype', 'a.prototype']) {
    assert.throws(() => parsePath(bad), /JavaScript object key/, bad);
  }
});

test('raw get reads scalars verbatim and summarises tables', () => {
  const m = mission();
  assert.deepEqual(getMissionValue(m, 'theatre'), { path: 'theatre', exists: true, type: 'string', value: 'Caucasus' });
  const group = getMissionValue(m, 'coalition.blue.country[1].helicopter.group[1].name');
  assert.equal(group.value, 'Lift');
  const table = getMissionValue(m, 'coalition.blue.country[1].helicopter.group[1]');
  assert.equal(table.type, 'table');
  assert.ok((table.keys ?? []).includes('route'));
  assert.equal(table.value, undefined, 'a table is summarised unless expand is asked for');
  assert.ok(Object.keys(getMissionValue(m, 'coalition.blue.country[1].helicopter.group[1]', true).value as object).length > 0);
  // An absent key is reported as absent, not as an error.
  assert.deepEqual(getMissionValue(m, 'nothingHere'), { path: 'nothingHere', exists: false, type: 'absent', value: undefined });
  assert.throws(() => getMissionValue(m, 'theatre.deeper'), /not a table/);
});

test('raw set refuses a new key without create, and reports what it changed', () => {
  const m = mission();
  assert.throws(() => setMissionValue(m, { path: 'myNewField', value: 'x' }), /Pass create=true/);
  const created = setMissionValue(m, { path: 'myNewField', value: 'Lift the infantry', create: true });
  assert.equal(created.action, 'created');
  assert.equal(rt(m).myNewField, 'Lift the infantry');

  const replaced = setMissionValue(m, { path: 'myNewField', value: 'Changed' });
  assert.equal(replaced.action, 'replaced');
  assert.equal(replaced.previousType, 'string');

  // Structures become Lua tables with 1-based array keys.
  setMissionValue(m, { path: 'myList', value: [10, 20], create: true });
  assert.deepEqual(asTable(rt(m).myList), { 1: 10, 2: 20 });
  setMissionValue(m, { path: 'myList[2]', value: 30 });
  assert.equal(asTable(rt(m).myList)![2], 30);

  const removed = setMissionValue(m, { path: 'myList', remove: true });
  assert.equal(removed.action, 'removed');
  assert.equal(rt(m).myList, undefined);
  assert.throws(() => setMissionValue(m, { path: 'myList', remove: true }), /Nothing to remove/);
  assert.throws(() => setMissionValue(m, { path: 'bad', value: null, create: true }), /null is not a Lua value/);
  assert.throws(() => setMissionValue(m, { path: 'bad', value: Number.POSITIVE_INFINITY, create: true }), /finite/);
  assert.throws(() => setMissionValue(m, { path: 'theatre.deeper', value: 1, create: true }), /not a table/);
  // Prototype pollution, by path and by value key.
  assert.throws(() => setMissionValue(m, { path: '__proto__', value: { polluted: true }, create: true }), /JavaScript object key/);
  // JSON.parse keeps "__proto__" as an OWN key, which is the actual vector.
  assert.throws(() => setMissionValue(m, { path: 'nested', value: JSON.parse('{"__proto__":{"polluted":true}}') as object, create: true }),
    /JavaScript object key/);
  assert.equal(({} as Record<string, unknown>).polluted, undefined, 'Object.prototype was polluted');
  // An inherited member is not mission data either: a lookup only reads own properties.
  assert.equal(getMissionValue(m, 'toString').exists, false);
});

test('a raw write that breaks the Lua round trip is rolled back', () => {
  const m = mission();
  const before = serializeLuaAssignment('mission', m);
  // A key that cannot be serialized as Lua: the write must not survive.
  assert.throws(() => setMissionValue(m, { path: 'weird', value: { bad: Symbol('x') as unknown }, create: true }),
    /Cannot write a symbol|Rolled back/);
  assert.equal(m.weird, undefined);
  assert.equal(serializeLuaAssignment('mission', m), before);
});

test('troop transport wires Embarking, EmbarkToTransport and Disembarking together', () => {
  const m = mission();
  const out = makeTroopTransport(m, { transport: 'Lift', troops: 'Infantry', pickupWaypoint: 2, dropWaypoint: 3 });
  const parsed = rt(m);

  const lift = findGroup(parsed, 'Lift')!.group;
  const infantry = findGroup(parsed, 'Infantry')!.group;
  const taskAt = (group: LuaTable, index: number, id: string) =>
    luaArray(asTable(asTable(asTable(asTable(asTable(group.route)?.points)?.[index])?.task)?.params)?.tasks)
      .find(t => t.id === id);

  const embarking = taskAt(lift, 2, 'Embarking');
  assert.ok(embarking, 'the transport has no Embarking task at its pickup waypoint');
  const params = asTable(embarking!.params)!;
  // Field for field as the Mission Editor writes it.
  assert.deepEqual(Object.keys(params).sort(),
    ['distribution', 'distributionFlag', 'duration', 'durationFlag', 'groupsForEmbarking', 'onStartMission', 'x', 'y']);
  const troopId = Number(infantry.groupId);
  assert.deepEqual(asTable(params.groupsForEmbarking), { 1: troopId });
  // distribution maps each carrying unit to the groups it takes.
  const unitId = Number(luaArray(asTable(lift.units))[0].unitId);
  assert.deepEqual(asTable(asTable(params.distribution)![unitId]), { 1: troopId });
  assert.equal(params.duration, 300);
  assert.equal(params.x, 5000);
  assert.equal(params.onStartMission, false);

  // The troops wait at the same pickup point.
  const embark = taskAt(infantry, 1, 'EmbarkToTransport');
  assert.ok(embark);
  assert.deepEqual(asTable(embark!.params), { x: 5000, y: 0, zoneRadius: 200 });

  // The unload task is 'Disembarking', not Hoggit's 'DisembarkFromTransport':
  // DCS refuses that one with a ComboTask error, and no editor-saved mission
  // uses it. Checked live on 2026-11-17.
  assert.equal(taskAt(lift, 3, 'DisembarkFromTransport'), undefined);
  const disembark = taskAt(lift, 3, 'Disembarking');
  assert.ok(disembark, "the transport has no Disembarking task at its drop waypoint");
  const dropParams = asTable(disembark!.params)!;
  assert.equal(dropParams.x, 12000);
  assert.deepEqual(Object.keys(dropParams).sort(), ['groupsForEmbarking', 'x', 'y']);
  assert.deepEqual(asTable(dropParams.groupsForEmbarking), { 1: troopId });

  assert.equal(out.troopGroupId, troopId);
  assert.ok(out.notes.some(n => n.includes('Not flown by this project')));
});

test('troop transport refuses mismatched groups and waypoints', () => {
  const m = mission();
  assert.throws(() => makeTroopTransport(m, { transport: 'Nope', troops: 'Infantry' }), /No group named 'Nope'/);
  assert.throws(() => makeTroopTransport(m, { transport: 'Lift', troops: 'Lift' }), /troops must be a ground/);
  assert.throws(() => makeTroopTransport(m, { transport: 'Infantry', troops: 'Infantry' }), /cannot carry itself/);
  assert.throws(() => makeTroopTransport(m, { transport: 'Lift', troops: 'Infantry', pickupWaypoint: 2, dropWaypoint: 2 }), /must differ/);
  assert.throws(() => makeTroopTransport(m, { transport: 'Lift', troops: 'Infantry', pickupWaypoint: 9 }), /Waypoint 9 does not exist/);
});
