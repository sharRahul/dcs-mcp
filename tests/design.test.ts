import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import luaparse from 'luaparse';
import { removeGroup } from "../src/miz/editing.js";
import { validateMission } from "../src/miz/validator.js";
import { buildMissionDocument } from "../src/miz/parser.js";
import { configureMission, assignCountry, addReferencePoint } from '../src/miz/configuration.js';
import { addDrawing } from '../src/miz/drawings.js';
import { addGoal } from '../src/miz/scoring.js';
import { addAircraftGroup, addGroundGroup, addTrigger, findGroup, newMissionTable, replaceTrigger } from '../src/miz/authoring.js';
import { embedAsset, removeAsset, listAssets } from '../src/miz/assets.js';
import { newSession, openSession, saveSessionAs, closeSession, enableSessionPersistence, refresh, evictSession, requireSession } from '../src/miz/sessions.js';
import { luaArray, asTable, parseLuaAssignment, type LuaTable } from '../src/miz/lua.js';
import { serializeLuaAssignment } from '../src/miz/serializer.js';
const plane = { side: 'blue' as const, country: 'USA', name: 'Hornet', type: 'FA-18C_hornet', count: 1, x: 0, y: 0 };
const rt = (m: LuaTable) => parseLuaAssignment(serializeLuaAssignment('mission', m), 'mission');
test('mission configuration validates atomically and preserves weather and briefing fields', () => {
  const m = newMissionTable('Caucasus', 43200); asTable(m.weather)!.future = { keep: true };
  configureMission(m, { date: { year: 2024, month: 2, day: 29 }, startTime: 12345, countries: [{ name: 'USA', side: 'blue' }],
    coalitionBriefing: { blue: 'Blue "task"', red: 'Red task' }, bullseyes: { blue: { x: 10, y: 20 } },
    weather: { temperatureCelsius: -10, qnhMmHg: 750, wind: { at2000: { speed: 12, dir: 180 } }, clouds: { base: 1000, density: 5, preset: null },
      fog: { enabled: true, visibility: 1000, thickness: 50 }, dust: { enabled: false, density: 0 }, visibilityMetres: 50000, turbulence: 5 } });
  const back = rt(m), weather = asTable(back.weather)!;
  assert.deepEqual(back.date, { Year: 2024, Month: 2, Day: 29 }); assert.equal(back.start_time, 12345);
  assert.deepEqual(weather.future, { keep: true }); assert.deepEqual(asTable(weather.wind)!.at2000, { speed: 12, dir: 180 });
  assert.equal(back.descriptionBlueTask, 'Blue "task"'); assert.deepEqual(asTable(asTable(back.coalition)!.blue)!.bullseye, { x: 10, y: 20 });
  const before = serializeLuaAssignment('mission', m);
  assert.throws(() => configureMission(m, { date: { year: 2025, month: 2, day: 29 }, weather: { qnhMmHg: 720 } }), /valid date/);
  assert.equal(serializeLuaAssignment('mission', m), before);
});
test('country transfers preserve groups and ids in both coalition representations', () => {
  const m = newMissionTable('Caucasus', 43200); addAircraftGroup(m, 'plane', plane);
  const id = findGroup(m, 'Hornet')!.group.groupId;
  assignCountry(m, 'USA', 'red');
  const found = findGroup(rt(m), 'Hornet')!; assert.equal(found.side, 'red'); assert.equal(found.group.groupId, id);
  assert.ok(luaArray(asTable(m.coalitions)?.red).some(c => c.value === 2)); assert.ok(!luaArray(asTable(m.coalitions)?.blue).some(c => c.value === 2));
  assert.throws(() => configureMission(m, { theatre: 'Syria' }), /placed content/);
});
test('theatre changes also change the archive theatre member', async () => {
  const s = newSession('Caucasus', 43200), dir = mkdtempSync(join(tmpdir(), 'dcs-theatre-'));
  configureMission(s.mission, { theatre: 'syria' }); await saveSessionAs(s, join(dir, 'syria.miz'));
  assert.equal(new AdmZip(join(dir, 'syria.miz')).getEntry('theatre')!.getData().toString(), 'Syria'); closeSession(s.id);
});
test('aircraft reference points and all drawing primitives match explicit format fields after reparse', () => {
  const m = newMissionTable('Caucasus', 43200); addAircraftGroup(m, 'plane', plane);
  addReferencePoint(m, 'Hornet', 'IP', { x: 100, y: 200 });
  assert.deepEqual(asTable(findGroup(rt(m), 'Hornet')!.group.NavTargetPoints)?.[1], { index: 1, text_comment: 'IP', x: 100, y: 200 });
  const origin = { x: 100, y: 200 };
  addDrawing(m, { kind: 'line', name: 'Boundary', origin, points: [origin, { x: 200, y: 250 }, { x: 300, y: 300 }], layer: 'Blue' });
  addDrawing(m, { kind: 'polygon', name: 'Target area', origin, points: [origin, { x: 200, y: 200 }, { x: 200, y: 300 }] });
  addDrawing(m, { kind: 'circle', name: 'Range', origin, radiusMetres: 10000 });
  addDrawing(m, { kind: 'text', name: 'Waypoint annotation', origin, text: 'WP 2 – ingress' });
  const layers = luaArray(asTable(rt(m).drawings)?.layers), objects = layers.flatMap(l => luaArray(l.objects));
  const boundary = objects.find(o => o.name === 'Boundary')!;
  assert.equal(boundary.primitiveType, 'Line'); assert.equal(boundary.lineMode, 'segments'); assert.deepEqual(asTable(boundary.points)?.[2], { x: 100, y: 50 });
  assert.equal(objects.find(o => o.name === 'Target area')!.polygonMode, 'free');
  assert.equal(objects.find(o => o.name === 'Waypoint annotation')!.primitiveType, 'TextBox');
  assert.throws(() => addDrawing(m, { kind: 'circle', name: 'Bad', origin, radiusMetres: 2, layer: 'custom' as 'Blue' }));
});
test('goals carry compiled results and full trigger replacement keeps stable runtime indices', () => {
  const m = newMissionTable('Caucasus', 43200), dict = {};
  addTrigger(m, { type: 'once', comment: 'first', conditions: [{ kind: 'time_after', seconds: 10 }], actions: [{ kind: 'set_flag', flag: 7, value: 1 }] }, dict);
  addTrigger(m, { type: 'change', comment: 'second', conditions: [{ kind: 'flag_is_true', flag: 7 }], actions: [{ kind: 'set_flag', flag: 8, value: 1 }] }, dict);
  const second = asTable(asTable(m.trig)?.actions)?.[2];
  replaceTrigger(m, dict, 1, { type: 'once', comment: 'edited', conditions: [{ kind: 'time_after', seconds: 20 }], actions: [{ kind: 'set_flag', flag: 9, value: 1 }] });
  assert.equal(asTable(asTable(m.trig)?.actions)?.[2], second); assert.equal(luaArray(m.trigrules).length, 2);
  addGoal(m, { side: 'blue', score: 100, comment: 'Win', conditions: [{ kind: 'flag_is_true', flag: 9 }] });
  const back = rt(m), result = asTable(asTable(back.result)?.blue)!;
  assert.equal(luaArray(back.goals)[0].side, 'BLUE'); assert.equal(asTable(result.actions)?.[1], 'a_set_mission_result(100)');
  assert.equal(asTable(result.conditions)?.[1], 'return(c_flag_is_true(9) )');
  for (const section of ['conditions', 'actions', 'func']) for (const text of Object.values(asTable(result[section]) ?? {})) luaparse.parse(String(text), { luaVersion: '5.1' });
});
test('media additions, reference-safe removals, kneeboards and opaque members survive save/reopen and restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dcs-assets-')), s = newSession('Caucasus', 43200), zip = new AdmZip(s.sourceBytes);
  zip.addFile('opaque/member.bin', Buffer.from([0, 255, 42])); zip.addFile('l10n/DEFAULT/old.ogg', Buffer.from([1, 2, 3])); s.sourceBytes = zip.toBuffer();
  const audio = embedAsset(s, 'audio', 'voice.ogg', Buffer.from([9, 8, 7]));
  embedAsset(s, 'briefing_image', 'brief.png', Buffer.from([1, 2, 3]), 'blue');
  embedAsset(s, 'kneeboard', 'page.png', Buffer.from([4, 5, 6]), 'blue', 'FA-18C_hornet');
  addTrigger(s.mission, { type: 'once', conditions: [], actions: [{ kind: 'sound', resourceKey: audio.resourceKey! }] }, s.dictionary);
  assert.throws(() => removeAsset(s, 'l10n/DEFAULT/voice.ogg'), /referenced/);
  assert.throws(() => embedAsset(s, 'media', 'old.ogg', Buffer.from([3, 2, 1])), /different asset/);
  removeAsset(s, 'l10n/DEFAULT/old.ogg');
  await saveSessionAs(s, join(dir, 'edited.miz'));
  const back = await openSession(join(dir, 'edited.miz')); const archive = new AdmZip(back.sourceBytes);
  assert.equal(archive.getEntry('l10n/DEFAULT/old.ogg'), null);
  assert.deepEqual(archive.getEntry('KNEEBOARD/FA-18C_hornet/IMAGES/page.png')!.getData(), Buffer.from([4, 5, 6]));
  assert.deepEqual(archive.getEntry('opaque/member.bin')!.getData(), Buffer.from([0, 255, 42]));
  assert.equal(luaArray(back.mission.pictureFileNameB).length, 1);
  enableSessionPersistence(join(dir, 'state')); refresh(s); evictSession(s.id);
  const restored = requireSession(s.id); assert.ok(restored.removedEntries!.has('l10n/DEFAULT/old.ogg')); assert.equal(restored.archiveFiles!.size, 1);
  assert.ok(listAssets(restored).some(a => a.path.startsWith('KNEEBOARD/')));
  assert.throws(() => embedAsset(restored, 'media', '..\\evil', Buffer.from([1])), /bare file/);
  closeSession(s.id); closeSession(back.id); enableSessionPersistence('off');
});

test('deleting a goal target is diagnosed without rewriting score definitions', () => {
  const m = newMissionTable('Caucasus', 43200); addAircraftGroup(m, 'plane', plane);
  addGoal(m, { side: 'blue', comment: 'Goal target', score: 10, conditions: [{ kind: 'group_dead', group: 'Hornet' }] });
  removeGroup(m, [], 'Hornet', true);
  // DCS loads a mission whose goal points at a deleted group; that goal simply can never
  // be met, so it is reported as a warning.
  assert.ok(validateMission(buildMissionDocument(m, {}, 'test'), m).warnings.some(e => e.code === 'GOAL_REFERENCE_MISSING'));
});

test('removed newly embedded resources never reappear after snapshot restoration', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dcs-remove-state-')); enableSessionPersistence(join(dir, 'state'));
  const s = newSession('Caucasus', 43200);
  embedAsset(s, 'media', 'obsolete.txt', Buffer.from('obsolete')); refresh(s);
  removeAsset(s, 'l10n/DEFAULT/obsolete.txt'); refresh(s); evictSession(s.id);
  const restored = requireSession(s.id); assert.equal(restored.files.has('obsolete.txt'), false);
  await saveSessionAs(restored, join(dir, 'restored.miz'));
  assert.equal(new AdmZip(join(dir, 'restored.miz')).getEntry('l10n/DEFAULT/obsolete.txt'), null);
  closeSession(s.id); enableSessionPersistence('off');
});

test('snapshot restoration preserves equal-length pending resource byte changes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dcs-resource-bytes-')); enableSessionPersistence(join(dir, 'state'));
  const s = newSession('Caucasus', 43200); embedAsset(s, 'media', 'data.bin', Buffer.from('AAAA')); refresh(s);
  s.files.set('data.bin', Buffer.from('BBBB')); refresh(s); evictSession(s.id);
  const restored = requireSession(s.id); assert.equal(restored.files.get('data.bin')!.toString(), 'BBBB');
  closeSession(s.id); enableSessionPersistence('off');
});
