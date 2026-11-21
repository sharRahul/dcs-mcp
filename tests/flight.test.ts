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
test('horizontal AAA reaction is accepted for planes and helicopters without widening other option ranges', () => {
  const m = fresh();
  for (const category of ['plane', 'helicopter'] as const) {
    const name = category;
    addAircraftGroup(m, category, { ...base, name, type: category === 'plane' ? base.type : 'UH-1H', count: 1 });
    appendWaypointTask(m, name, 1, { kind: 'option', option: 'reaction', value: 5 });
    const action = asTable(asTable(tasks(rt(m), name).at(-1)!.params)?.action)!;
    assert.equal(action.id, 'Option');
    assert.deepEqual(action.params, { name: 1, value: 5 });
    const before = serializeLuaAssignment('mission', m);
    for (const [option, value] of [['reaction', 6], ['roe', 5], ['radar', 4]] as const) {
      assert.throws(() => appendWaypointTask(m, name, 1, { kind: 'option', option, value }), /Invalid/);
      assert.equal(serializeLuaAssignment('mission', m), before);
    }
  }
});
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
    config: { tailNumbers: ['101', '102'], skills: ['Client', 'High'], frequencyMHz: 251, callsign: { family: 1, flight: 1,
      // Family 1 is role-dependent (Hoggit wiki callsign enums): AWACS Overlord, tanker Texaco, else Enfield.
      name: role === 'AWACS' ? 'Overlord' : role === 'tanker' ? 'Texaco' : 'Enfield' } } });
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
  for (const bad of [{ fuel: 6000 }, { fuel: NaN }, { fuel: -1 }, { gun: 101 },
    { pylons: [{ pylon: 3, CLSID: 'FABRICATED' }] }, { pylons: [{ pylon: 3, CLSID: clsid }, { pylon: 3, CLSID: clsid }] }]) {
    assert.throws(() => setPayload(m, 'Viper-1', bad)); assert.equal(serializeLuaAssignment('mission', m), before);
  }
  // A countermeasure count above the pydcs catalogue is NOT refused: editor-saved
  // missions carry an F-16C with 90 flares where the catalogue says 60, so refusing it
  // would reject a payload DCS flies. The validator reports it as staleness instead.
  setPayload(m, 'Viper-1', { flare: 90 });
  const stale = validateMission(buildMissionDocument(m, {}, 'test'), m);
  assert.ok(stale.warnings.some(i => i.code === 'PAYLOAD_LIMIT' && /flare/.test(i.message)));
  assert.ok(!stale.errors.some(i => i.code === 'PAYLOAD_LIMIT'));
  setPayload(m, 'Viper-1', { fuel: 1000, pylons: [{ pylon: 3, CLSID: clsid }] });
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
  const report = validateMission(buildMissionDocument(m, {}, 'test'), m);
  // All three occur in editor-saved missions that DCS loads and flies, so they are
  // reported as warnings; the validator must still find every one of them.
  const codes = report.warnings.map(e => e.code);
  for (const code of ['PARKING_CONFLICT', 'PAYLOAD_LIMIT', 'TASK_REFERENCE_MISSING']) assert.ok(codes.includes(code), code);
  assert.deepEqual(report.errors.map(e => e.code).filter(c => ['PARKING_CONFLICT', 'PAYLOAD_LIMIT', 'TASK_REFERENCE_MISSING'].includes(c)), []);
  assert.equal(serializeLuaAssignment('mission', m), before);
});

test('validator leaves unknown and EPLRS network ids opaque', () => {
  const m = fresh(); addAircraftGroup(m, 'plane', base);
  const group = findGroup(m, 'Viper')!.group;
  asTable(asTable(asTable(group.route)?.points)?.[1])!.task = { id: 'ComboTask', params: { tasks: {
    1: { id: 'WrappedAction', params: { action: { id: 'EPLRS', params: { groupId: 9999, value: true } } } },
    2: { id: 'FutureTask', params: { groupId: 8888, unitId: 7777 } },
  } } };
  const checked = validateMission(buildMissionDocument(m, {}, 'test'), m);
  assert.ok(![...checked.errors, ...checked.warnings].some(e => e.code === 'TASK_REFERENCE_MISSING'));
});

// Flown 2026-11-20: a SEAD flight whose only waypoint was its start point never
// went near a dark SA-11 and landed. Targeted roles now get a leg to the target.
test('targeted flights get a waypoint at the target; escort and orbit flights do not', () => {
  const m = fresh();
  addGroundGroup(m, 'vehicle', { side: 'red', country: 'Russia', name: 'SAM', type: 'T-72B', count: 1, x: 40000, y: 50000 });
  const sead = createFlight(m, { ...base, name: 'Viper 1', role: 'SEAD', targetGroup: 'SAM', altitudeMetres: 6500 });
  assert.equal(sead.attackWaypoint, 2);
  const points = Object.values(asTable(asTable(rt(m) && findGroup(rt(m), 'Viper 1')!.group.route)?.points) ?? {}) as LuaTable[];
  assert.equal(points.length, 2);
  assert.equal(Number(points[1].x), 40000);
  assert.equal(Number(points[1].y), 50000);
  assert.equal(Number(points[1].alt), 6500);
  const escort = createFlight(m, { ...base, name: 'Viper 2', role: 'escort', targetGroup: 'Viper 1' });
  assert.equal(escort.attackWaypoint, undefined);
});

test('a helicopter attack leg is flown above ground, a fixed-wing one barometric', () => {
  const m = fresh();
  addGroundGroup(m, 'vehicle', { side: 'red', country: 'Russia', name: 'Armour', type: 'T-72B', count: 1, x: 40000, y: 50000 });
  createFlight(m, { ...base, name: 'Hammer', type: 'AH-64D', category: 'helicopter', role: 'CAS', targetGroup: 'Armour', altitudeMetres: 60 });
  createFlight(m, { ...base, name: 'Hog', role: 'CAS', targetGroup: 'Armour' });
  const alt = (g: string) => (Object.values(asTable(asTable(findGroup(rt(m), g)!.group.route)?.points)!) as LuaTable[])[1].alt_type;
  assert.equal(alt('Hammer'), 'RADIO');
  assert.equal(alt('Hog'), 'BARO');
});

test('a combat flight says it is unarmed, has no way home, and a low helicopter air start is flagged', () => {
  const m = fresh();
  addGroundGroup(m, 'vehicle', { side: 'red', country: 'Russia', name: 'Armour', type: 'T-72B', count: 1, x: 40000, y: 50000 });
  const sead = createFlight(m, { ...base, name: 'Viper 1', role: 'SEAD', targetGroup: 'Armour' });
  assert.ok(sead.warnings.some(w => /No weapons are loaded/.test(w)));
  assert.ok(sead.warnings.some(w => /NEAREST airfield/.test(w)));
  const helo = createFlight(m, { ...base, name: 'Hind', type: 'AH-64D', category: 'helicopter', role: 'CAS', targetGroup: 'Armour', altitudeMetres: 80 });
  assert.ok(helo.warnings.some(w => /above SEA level/.test(w)));
  const awacs = createFlight(m, { ...base, name: 'Overlord', type: 'E-3A', role: 'AWACS', orbit });
  assert.ok(!awacs.warnings.some(w => /No weapons/.test(w)));
});
