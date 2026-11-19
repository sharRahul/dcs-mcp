import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { findDcsLua } from './helpers/dcs-lua.js';
import luaparse from 'luaparse';
import { generateScenario } from '../src/scenario/engine.js';
import { closeSession, openSession, saveSessionAs } from '../src/miz/sessions.js';
import { findGroup, findUnit, validatePayload } from '../src/miz/authoring.js';
import { luaArray, asTable } from '../src/miz/lua.js';
import { serializeLuaAssignment } from '../src/miz/serializer.js';
import { validateMission } from '../src/miz/validator.js';

const dir = 'examples/scenarios';
const required = [
  'interception.json', 'sead-strike.json', 'convoy-escort.json', 'carrier-defense.json',
  'ground-attack-base.json', 'cas-a10c.json', 'cas-su25t.json', 'cas-apache.json', 'cas-ka50.json',
];
const casCases: Record<string, { delay: number; trigger: string; protected: string; convoyArrival?: boolean }> = {
  "cas-a10c.json": {
    "delay": 90,
    "trigger": "zone",
    "protected": "Protected-1"
  },
  "cas-su25t.json": {
    "delay": 60,
    "trigger": "primary",
    "protected": "Protected-1"
  },
  "cas-apache.json": {
    "delay": 30,
    "trigger": "zone",
    "protected": "Protected-1",
    "convoyArrival": true
  },
  "cas-ka50.json": {
    "delay": 45,
    "trigger": "secondary",
    "protected": "Forward Pad"
  }
};
const casAircraft: Record<string, string> = {
  "cas-a10c.json": "A-10C_2",
  "cas-su25t.json": "Su-25T",
  "cas-apache.json": "AH-64D_BLK_II",
  "cas-ka50.json": "Ka-50_3"
};
const files = readdirSync(dir).filter(f => f.endsWith('.json'));
test('scenario examples cover the documented mission families', () => {
  for (const file of required) assert.ok(files.includes(file), file);
});
for (const file of files) test(file + ' generates deterministically, validates stores and survives archive round-trip', async () => {
  const spec = JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
  const a = generateScenario(spec), b = generateScenario(spec);
  try {
    assert.equal(a.report.validation.ok, true);
    assert.equal(serializeLuaAssignment('mission', a.session.mission), serializeLuaAssignment('mission', b.session.mission));
    assert.equal(a.report.warnings.some(w => w.includes('no pylon stores supplied')), false);
    if (casAircraft[file]) {
      const player = findGroup(a.session.mission, spec.player.group)!.group;
      assert.equal(luaArray(player.units)[0].type, casAircraft[file]);
      if (spec.forces.find((f: { name: string }) => f.name === spec.player.group).start.kind.startsWith('farp_')) {
        const pad = findUnit(a.session.mission, 'Forward Pad')!;
        const first = luaArray(asTable(player.route)?.points)[0];
        assert.equal(first.linkUnit, pad.unitId);
        assert.equal(first.helipadId, pad.unitId);
      }
    }
    assert.ok(spec.forces.length >= 6);
    assert.ok(spec.director.events.length >= 6);
    assert.ok(spec.forces.some((f: { lateActivation?: boolean }) => f.lateActivation));
    for (const force of spec.forces) if (force.payload) {
      for (const unit of luaArray(findGroup(a.session.mission, force.name)!.group.units))
        validatePayload(unit, force.payload, { enforceCatalogueFuel: true });
    }
    for (const rule of luaArray(a.session.mission.trigrules)) for (const action of luaArray(rule.actions))
      if (action.predicate === 'a_do_script') luaparse.parse(String(action.text), { luaVersion: '5.1' });
    const target = path.join(mkdtempSync(path.join(tmpdir(), 'scenario-example-')), file.replace('.json', '.miz'));
    await saveSessionAs(a.session, target);
    const back = await openSession(target);
    try { assert.equal(validateMission(back.document, back.mission).ok, true); }
    finally { closeSession(back.id); }
  } finally { closeSession(a.session.id); closeSession(b.session.id); }
});

const lua = findDcsLua();
for (const file of required) test(file + ' enforces mission phases and protected-asset failure under Lua', { skip: lua ? false : 'DCS Lua interpreter not available' }, () => {
  const built = generateScenario(JSON.parse(readFileSync(path.join(dir, file), 'utf8')));
  try {
    const temp = mkdtempSync(path.join(tmpdir(), 'scenario-phases-'));
    const mission = path.join(temp, 'mission.lua'), dictionary = path.join(temp, 'dictionary.lua'), manifestFile = path.join(temp, 'manifest.lua');
    writeFileSync(mission, serializeLuaAssignment('mission', built.session.mission));
    writeFileSync(dictionary, serializeLuaAssignment('dictionary', built.session.dictionary));
    const groups: Record<string, number> = {}, units: Record<string, number> = {}, zones: Record<string, number> = {};
    for (const force of built.specification.forces) {
      const group = findGroup(built.session.mission, force.name)!.group;
      groups[force.name] = Number(group.groupId);
      for (const unit of luaArray(group.units)) units[String(unit.name)] = Number(unit.unitId);
    }
    for (const zone of luaArray(asTable(built.session.mission.triggers)?.zones)) zones[String(zone.name)] = Number(zone.zoneId);
    for (const mode of ['success', 'failure']) for (const order of ['forward', 'reverse']) {
      writeFileSync(manifestFile, serializeLuaAssignment('manifest', { kind: built.specification.kind, outcome: built.report.outcome.outcomeFlag, groups, units, zones, mode, order, ...(casCases[file] ? { cas: casCases[file] } : {}) }));
      const result = spawnSync(lua!, ['tests/fixtures/scenario-examples.lua', mission, dictionary, manifestFile], { encoding: 'utf8' });
      assert.equal(result.status, 0, [result.error, result.stdout, result.stderr].join('\n'));
      assert.match(result.stdout, /SCENARIO_EXAMPLE_OK/);
    }
  } finally { closeSession(built.session.id); }
});
