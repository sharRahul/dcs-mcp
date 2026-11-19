import AdmZip from 'adm-zip';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newSession, saveSessionAs, openSession, closeSession, refresh } from '../src/miz/sessions.js';
import { addAircraftGroup, addTrigger, findUnit, type ActionSpec } from '../src/miz/authoring.js';
import { addResource } from '../src/miz/resources.js';
import { asTable, luaArray, parseLuaAssignment } from '../src/miz/lua.js';
import { serializeLuaAssignment } from '../src/miz/serializer.js';
import { buildMissionDocument } from '../src/miz/parser.js';
import { actionSchema } from '../src/miz/trigger-schema.js';

test('unit sound resolves the selected unit, compiles delay, and preserves resource bytes on save', async () => {
  const s = newSession('Caucasus', 43200);
  const dir = await mkdtemp(join(tmpdir(), 'dcs-unit-sound-'));
  let reopened: ReturnType<typeof newSession> | undefined;
  try {
    addAircraftGroup(s.mission, 'plane', { side: 'blue', country: 'USA', name: 'Colt', type: 'F-16C_50', count: 2, x: 0, y: 0 });
    const unitId = findUnit(s.mission, 'Colt-2')!.unitId;
    const bytes = Buffer.from([79, 103, 103, 83, 0, 255, 128, 1]);
    const { key } = addResource(s, 'clearance.ogg', bytes);
    const action = { kind: 'sound_to_unit', unit: 'Colt-2', resourceKey: key, delaySeconds: 15 };
    assert.ok(actionSchema.safeParse(action).success);
    addTrigger(s.mission, { type: 'once', conditions: [], actions: [action as ActionSpec] }, s.dictionary);
    const reparsed = parseLuaAssignment(serializeLuaAssignment('mission', s.mission), 'mission');
    const rule = luaArray(luaArray(reparsed.trigrules)[0].actions)[0];
    assert.equal(rule.predicate, 'a_out_sound_u');
    assert.equal(rule.unit, unitId);
    assert.equal(asTable(asTable(reparsed.trig)!.actions)![1], 'a_out_sound_u(' + unitId + ', getValueResourceByKey("' + key + '"), 15); mission.trig.func[1]=nil;');
    assert.deepEqual(buildMissionDocument(reparsed, s.dictionary, '').triggers[0].unitRefs, [unitId]);
    refresh(s);
    await saveSessionAs(s, join(dir, 'sound.miz'));
    reopened = await openSession(join(dir, 'sound.miz'));
    assert.deepEqual(new AdmZip(join(dir, 'sound.miz')).readFile('l10n/DEFAULT/clearance.ogg'), bytes);
    assert.deepEqual(reopened.document.triggers[0].unitRefs, [unitId]);
  } finally { closeSession(s.id); if (reopened) closeSession(reopened.id); await rm(dir, { recursive: true, force: true }); }
});

test('unit sound refuses an unknown unit instead of creating a broken trigger', () => {
  const s = newSession('Caucasus', 43200);
  try {
    assert.throws(() => addTrigger(s.mission, { type: 'once', conditions: [], actions: [
      { kind: 'sound_to_unit', unit: 'missing', resourceKey: 'ResKey_Action_1' } as ActionSpec,
    ] }), /Unknown unit|not found|No unit/i);
  } finally { closeSession(s.id); }
});
