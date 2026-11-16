import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addAircraftGroup, addGroundGroup, chooseParking, findGroup, findUnit, newMissionTable, setPayload } from '../src/miz/authoring.js';
import { appendWaypointTask, configureFlight, createFlight, ROLES, type Role } from '../src/miz/flight.js';
import { addFarp } from '../src/miz/dressing.js';
import { asTable, luaArray, parseLuaAssignment, type LuaTable } from '../src/miz/lua.js';
import { serializeLuaAssignment } from '../src/miz/serializer.js';
import { findAirport, type Airport } from '../src/data/reference.js';
import { authoringData } from '../src/data/authoring.js';
import { validateMission } from '../src/miz/validator.js';
import { buildMissionDocument } from '../src/miz/parser.js';
const base = { side: 'blue' as const, country: 'USA', name: 'Viper', type: 'F-16C_50', category: 'plane' as const, count: 2, x: 0, y: 0 };
const orbit = { point: { x: 10000, y: 20000 }, pattern: 'Race-Track' as const, point2: { x: 30000, y: 20000 }, altitudeMetres: 7000, speedMps: 210, durationSeconds: 600 };
function fresh() { return newMissionTable('Caucasus', 43200); }
function rt(m: LuaTable) { return parseLuaAssignment(serializeLuaAssignment('mission', m), 'mission'); }
function tasks(m: LuaTable, name = 'Viper', index = 1) {
  return Object.values(asTable(asTable(asTable(asTable(asTable(findGroup(m, name)!.group.route)?.points)?.[index])?.task)?.params)?.tasks ?? {}) as LuaTable[];
}
for (const role of ROLES) test(`role ${role} authors executable task data and round-trips`, () => {
  const m = fresh();
  addGroundGroup(m, 'vehicle', { side: 'red', country: 'Russia', name: 'Target', type: 'T-72B', count: 1, x: 1000, y: 1000 });
  addAircraftGroup(m, 'plane', { ...base, name: 'Friendly' });
  let type = role === 'AWACS' ? 'E-3A' : role === 'tanker' ? 'KC-135' : role === 'transport' ? 'C-130' : base.type;
  const result = createFlight(m, { ...base, type, role, orbit: ['BARCAP', 'TARCAP', 'AWACS', 'tanker'].includes(role) ? orbit : undefined,
    targetGroup: ['strike', 'interception'].includes(role) ? 'Target' : role === 'escort' ? 'Friendly' : undefined,
    config: { tailNumbers: ['101', '102'], skills: ['Client', 'High'], frequencyMHz: 251, callsign: { family: 1, flight: 1, name: 'Enfield' } } });
  const back = rt(m), group = findGroup(back, 'Viper')!.group;
  assert.equal(group.task, result.mainTask);
  assert.equal(findUnit(back, 'Viper-2')!.onboard_num, '102');
  assert.equal(findUnit(back, 'Viper-1')!.skill, 'Client');
  assert.equal(group.frequency, 251);
  if (['BARCAP', 'TARCAP', 'AWACS', 'tanker'].includes(role)) {
    const station = tasks(back, 'Viper', 2);
    assert.equal(station.at(-1)!.id, 'ControlledTask');
    assert.deepEqual(asTable(asTable(asTable(station.at(-1)!.params)?.task)?.params)?.point2, orbit.point2);
  }
  if (['CAP', 'CAS', 'SEAD', 'DEAD'].includes(role)) assert.equal(tasks(back)[0].id, 'EngageTargets');
  assert.deepEqual(back, rt(back));
});

test('role failures are atomic for bad role, target, country, and ground start', () => {
  const m = fresh(), before = serializeLuaAssignment('mission', m);
  for (const args of [
    { ...base, role: 'AWACS' as Role, orbit },
    { ...base, role: 'escort' as Role },
    { ...base, role: 'CAP' as Role, country: 'Narnia' },
    { ...base, role: 'CAP' as Role, start: { kind: 'parking_cold' as const, airfield: 'Not a field' } },
    { ...base, role: 'BARCAP' as Role, orbit: { ...orbit, point2: undefined } },
    { ...base, role: 'CAP' as Role, skill: 'Player' },
  ]) {
    assert.throws(() => createFlight(m, args));
    assert.equal(serializeLuaAssignment('mission', m), before);
  }
});

test('TACAN, options, en-route zones preserve existing unknown tasks', () => {
  const m = fresh();
  createFlight(m, { ...base, name: 'Texaco', role: 'tanker', type: 'KC-135', orbit });
  const group = findGroup(m, 'Texaco')!.group;
  const first = asTable(asTable(asTable(group.route)?.points)?.[1])!;
  first.task = { id: 'ComboTask', params: { tasks: { 3: { id: 'FutureTask', number: 3, params: { opaque: 'keep' } } } } };
  assert.equal(appendWaypointTask(m, 'Texaco', 1, { kind: 'tacan', channel: 64, band: 'Y', callsign: 'TKR' }), 4);
  appendWaypointTask(m, 'Texaco', 1, { kind: 'frequency', frequencyMHz: 251.5 });
  const taskList = tasks(rt(m), 'Texaco');
  assert.equal(taskList[0].id, 'FutureTask');
  const beacon = asTable(asTable(asTable(taskList[1].params)?.action)?.params)!;
  assert.equal(beacon.frequency, 1025000000); assert.equal(beacon.system, 5);
  assert.equal(beacon.unitId, findUnit(m, 'Texaco-1')!.unitId);
  assert.equal(asTable(asTable(asTable(taskList[2].params)?.action)?.params)!.frequency, 251500000);
  createFlight(m, { ...base, role: 'CAP', config: { formation: 'finger_four' } });
  appendWaypointTask(m, 'Viper', 1, { kind: 'engage', targets: ['Air'], zone: { x: 10, y: 20, radiusMetres: 25000 } });
  assert.equal(tasks(rt(m)).at(-1)!.id, 'EngageTargetsInZone');
  const formation = tasks(rt(m)).find(t => asTable(asTable(t.params)?.action)?.id === 'Option')!;
  const formationParams = asTable(asTable(asTable(formation.params)?.action)?.params)!;
  assert.equal(formationParams.value, 393217); assert.equal(formationParams.formationIndex, 6); assert.equal(formationParams.variantIndex, 1);
  const before = serializeLuaAssignment('mission', m);
  assert.throws(() => appendWaypointTask(m, 'Viper', 1, { kind: 'tacan', channel: 10, callsign: 'BAD' }), /Refueling/);
  assert.throws(() => appendWaypointTask(m, 'Viper', 9, { kind: 'awacs' }), /Waypoint/);
  assert.equal(serializeLuaAssignment('mission', m), before);
});

test('configuration validates per-unit lengths, skill uniqueness, and formation category atomically', () => {
  const m = fresh(); addAircraftGroup(m, 'plane', base);
  configureFlight(m, 'Viper', { skills: ['Player', 'High'], tailNumbers: ['011', '012'], livery: 'custom' });
  const before = serializeLuaAssignment('mission', m);
  assert.throws(() => configureFlight(m, 'Viper', { skills: ['Player', 'Player'] }), /one Player/);
  assert.throws(() => configureFlight(m, 'Viper', { tailNumbers: ['1'] }), /one entry/);
  assert.equal(serializeLuaAssignment('mission', m), before);
  assert.equal(findUnit(rt(m), 'Viper-1')!.livery_id, 'custom');
});

test('payload validates fuel, countermeasures, pylons and stores before changing existing payload', () => {
  const m = fresh(); addAircraftGroup(m, 'plane', base);
  const clsid = authoringData().aircraft['F-16C_50'].pylons['3'][0];
  setPayload(m, 'Viper-1', { fuel: 1000, pylons: [{ pylon: 3, CLSID: clsid }] });
  const before = serializeLuaAssignment('mission', m);
  for (const bad of [{ fuel: 3250 }, { fuel: NaN }, { flare: 61 }, { gun: 101 },
    { pylons: [{ pylon: 3, CLSID: 'FABRICATED' }] }, { pylons: [{ pylon: 3, CLSID: clsid }, { pylon: 3, CLSID: clsid }] }]) {
    assert.throws(() => setPayload(m, 'Viper-1', bad)); assert.equal(serializeLuaAssignment('mission', m), before);
  }
  assert.equal(asTable(asTable(findUnit(rt(m), 'Viper-1')!.payload)?.pylons)?.[3] && true, true);
});

test('requested parking rejects duplicate, wrong category, too-small and occupied slots', () => {
  const ap: Airport = { id: 1, name: 'Synthetic', x: 0, y: 0, slots: [
    [1, 'small', 0, 0, 4, 1, 1, 1], [2, 'heli', 10, 0, 2, 100, 100, 100], [3, 'large', 20, 0, 4, 100, 100, 100] ] };
  assert.throws(() => chooseParking(ap, 'plane', base.type, 2, new Set(), ['large', 'large']), /Duplicate/);
  for (const slot of ['small', 'heli']) assert.throws(() => chooseParking(ap, 'plane', base.type, 1, new Set(), [slot]), /does not fit/);
  assert.throws(() => chooseParking(ap, 'plane', base.type, 1, new Set(['large']), ['large']), /already used/);
  assert.equal(chooseParking(ap, 'plane', base.type, 1, new Set(), ['large'])[0][0], 3);
  assert.ok(findAirport('Caucasus', 'Kutaisi').slots.length > 0);
});

test('FARP starts enforce category and shared pad capacity; ships need a deck', () => {
  const m = fresh(); addFarp(m, { side: 'blue', country: 'USA', name: 'Pad', kind: 'SINGLE_HELIPAD', x: 0, y: 0 });
  assert.throws(() => addAircraftGroup(m, 'plane', { ...base, count: 1, start: { kind: 'farp_cold', farp: 'Pad' } }), /helicopters/);
  addAircraftGroup(m, 'helicopter', { ...base, name: 'Huey', type: 'UH-1H', count: 1, start: { kind: 'farp_cold', farp: 'Pad' } });
  assert.throws(() => addAircraftGroup(m, 'helicopter', { ...base, type: 'UH-1H', count: 1, start: { kind: 'farp_hot', farp: 'Pad' } }), /insufficient pads/);
  addGroundGroup(m, 'ship', { ...base, name: 'Cargo', type: 'Dry-cargo ship-1', count: 1 });
  assert.throws(() => addAircraftGroup(m, 'plane', { ...base, start: { kind: 'ship_hot', ship: 'Cargo-1' } }), /no aircraft parking/);
  assert.equal(findUnit(rt(m), 'Huey-1')!.type, 'UH-1H');
});

test('raw validator detects parking and task references, fuel and category errors without changing data', () => {
  const m = fresh(); addAircraftGroup(m, 'plane', { ...base, start: { kind: 'parking_cold', airfield: 'Kutaisi' } });
  const one = findUnit(m, 'Viper-1')!, two = findUnit(m, 'Viper-2')!;
  two.parking_id = one.parking_id!; asTable(one.payload)!.fuel = '999999';
  const group = findGroup(m, 'Viper')!.group;
  asTable(asTable(asTable(group.route)?.points)?.[1])!.task = { id: 'ComboTask', params: { tasks: { 1: { id: 'AttackGroup', params: { groupId: 9999 } } } } };
  const before = serializeLuaAssignment('mission', m);
  const codes = validateMission(buildMissionDocument(m, {}, 'test'), m).errors.map(e => e.code);
  for (const code of ['PARKING_CONFLICT', 'PAYLOAD_LIMIT', 'TASK_REFERENCE_MISSING']) assert.ok(codes.includes(code), code);
  assert.equal(serializeLuaAssignment('mission', m), before);
});

test('validator leaves unknown and EPLRS network ids opaque', () => {
  const m = fresh(); addAircraftGroup(m, 'plane', base);
  const group = findGroup(m, 'Viper')!.group;
  asTable(asTable(asTable(group.route)?.points)?.[1])!.task = { id: 'ComboTask', params: { tasks: {
    1: { id: 'WrappedAction', params: { action: { id: 'EPLRS', params: { groupId: 9999, value: true } } } },
    2: { id: 'FutureTask', params: { groupId: 8888, unitId: 7777 } },
  } } };
  const codes = validateMission(buildMissionDocument(m, {}, 'test'), m).errors.map(e => e.code);
  assert.ok(!codes.includes('TASK_REFERENCE_MISSING'));
});
