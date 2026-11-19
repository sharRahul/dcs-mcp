import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import luaparse from 'luaparse';
import { generateScenario, generateCampaign, scenarioSchema, type ScenarioInput } from '../src/scenario/engine.js';
import { embedAsset } from '../src/miz/assets.js';
import { directMission } from '../src/miz/director.js';
import { newSession, closeSession, listSessions } from '../src/miz/sessions.js';
import { addAircraftGroup, addGroundGroup, findGroup, addTriggerZone } from '../src/miz/authoring.js';
import { luaArray, asTable } from '../src/miz/lua.js';
import { serializeLuaAssignment } from '../src/miz/serializer.js';
const base: ScenarioInput = {
  name: 'Fixture', kind: 'cas', theatre: 'Caucasus', seed: 7, coalitions: { blue: ['USA'], red: ['Russia'] }, player: { group: 'Player' }, objective: 'Destroy the target before timeout',
  forces: [
    { name: 'Player', side: 'blue', country: 'USA', category: 'plane', type: 'FA-18C_hornet', position: { x: 100, y: 200 }, role: 'CAS', targetGroup: 'Target' },
    { name: 'Target', side: 'red', country: 'Russia', category: 'vehicle', type: 'Osa 9A33 ln', position: { x: 5000, y: 6000 }, jitterMetres: 100 },
  ], victory: [{ kind: 'group_dead', group: 'Target' }], failure: [{ kind: 'unit_dead', unit: 'Player-1' }],
};
const fresh = () => structuredClone(base);
for (const kind of ['interception', 'defensive_counter_air', 'offensive_counter_air', 'sead', 'dead', 'cas', 'strike', 'csar', 'convoy_escort', 'naval_strike', 'carrier_operations'] as const) test(`${kind} scenario compiles a valid independent mission with an honest report`, () => {
  const spec = fresh(); spec.kind = kind;
  const role: Record<string, string> = { interception: 'interception', defensive_counter_air: 'CAP', offensive_counter_air: 'CAP', sead: 'SEAD', dead: 'DEAD', cas: 'CAS', strike: 'strike', csar: 'transport', convoy_escort: 'CAP', naval_strike: 'naval_strike', carrier_operations: 'CAP' };
  spec.forces[0].role = role[kind] as typeof spec.forces[0]['role'];
  if (['interception', 'defensive_counter_air', 'offensive_counter_air'].includes(kind)) {
    spec.forces.push({ name: 'Bandits', side: 'red', country: 'Russia', category: 'plane', type: 'MiG-29A', role: 'CAP', position: { x: 10000, y: 20000 } });
    if (kind === 'interception') spec.forces[0].targetGroup = 'Bandits'; else delete spec.forces[0].targetGroup;
  }
  if (['csar', 'convoy_escort', 'carrier_operations'].includes(kind)) delete spec.forces[0].targetGroup;
  if (kind === 'csar') {
    spec.forces[0].category = 'helicopter'; spec.forces[0].type = 'UH-1H';
    spec.zones = [{ name: 'Pickup', x: 1000, y: 2000, radius: 100 }]; spec.victory = [{ kind: 'unit_in_zone', unit: 'Player-1', zone: 'Pickup' }];
  }
  if (kind === 'convoy_escort') spec.forces.push({ name: 'Convoy', side: 'blue', country: 'USA', category: 'vehicle', type: 'M-1 Abrams', position: { x: 0, y: 0 }, route: [{ x: 1000, y: 1000 }] });
  if (kind === 'naval_strike') { spec.forces[1].category = 'ship'; spec.forces[1].type = 'MOSCOW'; }
  if (kind === 'carrier_operations') {
    spec.forces.push({ name: 'Carrier', side: 'blue', country: 'USA', category: 'ship', type: 'CVN_71', position: { x: -300000, y: 400000 } });
    spec.forces[0].start = { kind: 'ship_hot', ship: 'Carrier-1' };
  }
  const built = generateScenario(spec);
  assert.equal(built.report.validation.ok, true); assert.ok(built.report.forces.length >= 2);
  assert.ok(built.report.outcome.outcomeFlag > 999);
  assert.ok(built.report.triggers.some(t => t.comment === 'Scenario time limit'));
  assert.ok(luaArray(built.session.mission.goals).length === 2);
  if (kind === 'csar') assert.ok(built.report.warnings.some(w => w.includes('no automatic personnel pickup')));
  closeSession(built.session.id);
});
test('seeded generation is byte-identical as mission data and seed variation is explicit and bounded', () => {
  const a = generateScenario(fresh()), b = generateScenario(fresh()), c = generateScenario({ ...fresh(), seed: 8 });
  assert.equal(serializeLuaAssignment('mission', a.session.mission), serializeLuaAssignment('mission', b.session.mission));
  assert.deepEqual(a.report, b.report);
  assert.notEqual(findGroup(a.session.mission, 'Target')!.group.x, findGroup(c.session.mission, 'Target')!.group.x);
  assert.ok(Math.abs(Number(findGroup(a.session.mission, 'Target')!.group.x) - 5000) <= 100);
  assert.equal(luaArray(findGroup(a.session.mission, 'Player')!.group.units)[0].skill, 'Player');
  assert.equal(luaArray(findGroup(a.session.mission, 'Target')!.group.units)[0].skill, 'Good');
  for (const built of [a, b, c]) closeSession(built.session.id);
});
test('invalid scenarios reject independently without leaking sessions or touching existing work', () => {
  const initial = listSessions().length;
  for (const mutate of [
    (s: ScenarioInput) => { s.theatre = 'Unknown'; },
    (s: ScenarioInput) => { s.coalitions.red = ['USA']; },
    (s: ScenarioInput) => { s.forces[0].type = 'E-3A'; },
    (s: ScenarioInput) => { s.forces[0].targetGroup = 'Missing'; },
    (s: ScenarioInput) => { s.forces[0].start = { kind: 'parking_cold', airfield: 'Missing' }; },
    (s: ScenarioInput) => { s.requiredSupport = ['Missing']; },
    (s: ScenarioInput) => { s.victory = [{ kind: 'group_dead', group: 'Missing' }]; },
    (s: ScenarioInput) => { s.forces[1].country = 'USA'; },
    (s: ScenarioInput) => { s.forces.push({ ...s.forces[0] }); },
    (s: ScenarioInput) => { s.threatLevel = 'none'; },
  ]) { const s = fresh(); mutate(s); assert.throws(() => generateScenario(s)); assert.equal(listSessions().length, initial); }
});
test('campaign manifest validates transitions, cycles, ambiguity and atomic stage failure', () => {
  const first = { ...fresh(), name: 'First' }, second = { ...fresh(), name: 'Second' };
  const campaign = { name: 'Campaign', stages: [first, second], transitions: [{ from: 'First', to: 'Second', on: 'victory' as const }] };
  const built = generateCampaign(campaign); assert.equal(built.stages.length, 2); assert.match(built.limitation, /No .cmp/);
  for (const s of built.stages) closeSession(s.session.id);
  assert.throws(() => generateCampaign({ ...campaign, transitions: [...campaign.transitions, { from: 'Second', to: 'First', on: 'failure' }] }), /Cyclic/);
  assert.throws(() => generateCampaign({ ...campaign, transitions: [...campaign.transitions, ...campaign.transitions] }), /Ambiguous/);
  const initial = listSessions().length; second.forces[0].type = 'Not an aircraft';
  assert.throws(() => generateCampaign(campaign)); assert.equal(listSessions().length, initial);
});
test('example specification is valid and its world-event/director scripts use Lua 5.1 syntax', () => {
  const spec = JSON.parse(readFileSync('examples/scenarios/interception.json', 'utf8'));
  const built = generateScenario(spec);
  assert.equal(built.report.director!.radioScript.length, spec.director.events.length);
  for (const text of built.report.director!.radioScript) assert.match(text.procedureStatus, /fictional/);
  assert.ok(built.report.director!.radioScript.some(e => e.audioStatus.includes('PLACEHOLDER')));
  for (const rule of luaArray(built.session.mission.trigrules)) for (const action of luaArray(rule.actions)) if (action.predicate === 'a_do_script') luaparse.parse(String(action.text), { luaVersion: '5.1' });
  closeSession(built.session.id);
});
test('director dependencies, resources and activation are atomic; placeholders never author fake radio', () => {
  const s = newSession('Caucasus', 43200);
  addAircraftGroup(s.mission, 'plane', { side: 'blue', country: 'USA', name: 'Player', type: 'FA-18C_hornet', count: 1, x: 0, y: 0 });
  addGroundGroup(s.mission, 'vehicle', { side: 'red', country: 'Russia', name: 'Reinforce', type: 'T-72B', count: 1, x: 1000, y: 1000 });
  const channels = [{ id: 'control', speaker: 'Controller', callsign: 'Overlord', frequencyMHz: 251 }];
  const input = { name: 'Film', channels, events: [
    { id: 'departure', phase: 'atc_departure' as const, channel: 'control', when: { worldEvent: { kind: 'takeoff' as const, unit: 'Player-1' } }, template: 'depart' as const, delivery: 'radio' as const },
    { id: 'update', phase: 'awacs' as const, channel: 'control', when: { afterEvent: 'departure', delaySeconds: 10 }, template: 'contact' as const, subject: 'two contacts' },
  ] };
  const report = directMission(s, input); assert.equal(report.radioScript[0].audioStatus.startsWith('PLACEHOLDER'), true);
  assert.equal(report.timeline[1].conditions.find(c => c.kind === 'time_since_flag')!.seconds, 10);
  assert.ok(!luaArray(s.mission.trigrules).flatMap(t => luaArray(t.actions)).some(a => a.predicate === 'a_radio_transmission'));
  const before = serializeLuaAssignment('mission', s.mission);
  assert.throws(() => directMission(s, { ...input, name: 'Cycle', events: [{ ...input.events[0], when: { afterEvent: 'departure' } }] }), /Cyclic/);
  assert.throws(() => directMission(s, { ...input, name: 'Audio', events: [{ ...input.events[0], audioResourceKey: 'Missing' }] }), /Audio key/);
  assert.throws(() => directMission(s, { ...input, name: 'Units', events: [{ ...input.events[0], effects: [{ kind: 'activate_group', group: 'Reinforce' }] }] }), /lateActivation/);
  assert.equal(serializeLuaAssignment('mission', s.mission), before); closeSession(s.id);
});

test('scenario assets resolve symbolic keys deterministically and radio audio is only configured when an asset exists', () => {
  const spec = fresh();
  spec.assets = [{ id: 'voice', kind: 'audio', fileName: 'voice.ogg', contentBase64: Buffer.from([1, 2, 3, 4]).toString('base64') }];
  spec.zones = [{ name: 'Radio', x: 0, y: 0, radius: 10 }];
  spec.director = { name: 'Voice', channels: [{ id: 'net', callsign: 'Control', speaker: 'Controller', frequencyMHz: 251 }],
    events: [{ id: 'contact', phase: 'detection', channel: 'net', when: { atSeconds: 1 }, template: 'contact', delivery: 'radio', audioResourceKey: 'asset:voice', transmitterZone: 'Radio' }] };
  const a = generateScenario(spec), b = generateScenario(spec);
  assert.equal(a.report.assetKeys.voice, b.report.assetKeys.voice);
  assert.match(a.report.director!.radioScript[0].audioStatus, /configured; decoding/);
  const actions = luaArray(a.session.mission.trigrules).flatMap(t => luaArray(t.actions));
  assert.ok(actions.some(a => a.predicate === 'a_radio_transmission'));
  assert.equal(serializeLuaAssignment('mission', a.session.mission), serializeLuaAssignment('mission', b.session.mission));
  closeSession(a.session.id); closeSession(b.session.id);
  spec.assets[0].contentBase64 = 'AB=='; assert.throws(() => generateScenario(spec), /canonical base64/);
});

test('script syntax is checked without execution and broken script/resource specifications are atomic', () => {
  const spec = fresh();
  spec.assets = [{ id: 'setup', kind: 'script', fileName: 'setup.lua', contentBase64: Buffer.from("error('must not execute on server')").toString('base64') }];
  spec.events = [{ type: 'start', conditions: [], actions: [{ kind: 'do_script_file', resourceKey: 'asset:setup' }] }];
  const built = generateScenario(spec); closeSession(built.session.id);
  const initial = listSessions().length;
  spec.assets[0].contentBase64 = Buffer.from('function broken(').toString('base64'); assert.throws(() => generateScenario(spec));
  spec.assets = []; spec.events = [{ conditions: [], actions: [{ kind: 'do_script', text: 'function broken(' }] }]; assert.throws(() => generateScenario(spec));
  spec.events = [{ conditions: [], actions: [{ kind: 'set_flag_random', flag: 10, min: 100, max: 1 }] }]; assert.throws(() => generateScenario(spec), /minimum exceeds/);
  assert.equal(listSessions().length, initial);
});

test('scenario SAM templates stay in one mixed group and retain catalogue provenance', () => {
  const spec = fresh(); spec.forces[1].type = 'S-300PS 54K6 cp'; spec.forces[1].site = 'SA-10';
  const built = generateScenario(spec), units = luaArray(findGroup(built.session.mission, 'Target')!.group.units);
  assert.equal(units.length, 8); assert.ok(units.some(u => u.type === 'S-300PS 40B6M tr'));
  assert.ok(built.report.warnings.some(w => w.includes('provenance catalogue'))); closeSession(built.session.id);
});
