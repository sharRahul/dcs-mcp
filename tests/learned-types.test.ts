/**
 * Types learned from missions: mod airframes with their stores, and DCS types
 * newer than the pinned pydcs.
 *
 * The missions here are built by this suite rather than supplied, so the test
 * does not depend on anyone's library. What it pins is the behaviour that
 * matters: a learned type becomes placeable, it never shadows a bundled type,
 * and it carries no catalogue facts it has not got.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { learnFromMissions, enableLearnedTypes, learnedTypes, loadLearnedPacks, removeLearnedPack, learnedFingerprint } from '../src/dcs/mission-learned.js';
import { findUnitType, registerTypeSource } from '../src/data/reference.js';
import { newMissionTable, addAircraftGroup, addGroundGroup, findGroup } from '../src/miz/authoring.js';
import { addStatic } from '../src/miz/editing.js';
import { addFarp } from '../src/miz/dressing.js';
import { packMiz } from '../src/miz/archive.js';
import { serializeLuaAssignment } from '../src/miz/serializer.js';
import { parseLuaAssignment, asTable, luaArray, type LuaTable } from '../src/miz/lua.js';

/** The smallest valid ZIP, so packMiz has a source archive to copy from. */
const EMPTY_ZIP = Buffer.from('UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==', 'base64');

/**
 * A mission carrying types no catalogue knows: a mod airframe with stores on its
 * pylons, a post-pydcs static, and a heliport static. Written by hand into the
 * mission table, because the authoring API would refuse these ids - which is the
 * whole point of learning them.
 */
async function missionWithUnknownTypes(file: string, suffix = '') {
  const mission = newMissionTable('Caucasus', 43200);
  addAircraftGroup(mission, 'plane', {
    side: 'red', country: 'Russia', name: `Mod Flight${suffix}`, type: 'Su-27',
    count: 1, x: 0, y: 0, altitudeMetres: 5000, task: 'CAP',
  });
  const group = findGroup(mission, `Mod Flight${suffix}`)!.group;
  const unit = luaArray(asTable(group['units']))[0];
  // Repoint it at a type nothing here catalogues, and give it the mod's stores.
  unit['type'] = 'Su-30MKI';
  unit['livery_id'] = 'IAF standard';
  unit['payload'] = {
    pylons: { 1: { CLSID: '{Su30_ASTRA}' }, 2: { CLSID: '{SU30_R27ET}' }, 3: { CLSID: '{SU30_RVVSD}' } },
    fuel: '9400', flare: 96, chaff: 96, gun: 100,
  };

  addStatic(mission, { side: 'red', country: 'Russia', name: `Shed${suffix}`, type: 'Barracks 2', x: 500, y: 500 });
  // Two statics the pinned catalogue does not list, written straight in.
  const country = luaArray(asTable(asTable(asTable(mission['coalition'])?.['red'])?.['country']))[0];
  const statics = asTable(asTable(country['static'])?.['group'])!;
  const next = luaArray(statics).length;
  statics[next + 1] = {
    name: `Rig${suffix}`, groupId: 900 + next, heading: 0, x: 1000, y: 1000, dead: false,
    units: { 1: { name: `Rig${suffix}`, unitId: 900 + next, type: 'Oil rig', x: 1000, y: 1000, heading: 0, category: 'Heliports', shape_name: 'oil_platform', rate: 100 } },
    route: { points: { 1: { alt: 0, type: '', name: '', x: 1000, y: 1000, speed: 0, formation_template: '', action: '' } } },
  };
  statics[next + 2] = {
    name: `Pad${suffix}`, groupId: 950 + next, heading: 0, x: 2000, y: 2000, dead: false,
    units: { 1: { name: `Pad${suffix}`, unitId: 950 + next, type: 'FARP_SINGLE_01', x: 2000, y: 2000, heading: 0, category: 'Heliports', shape_name: 'FARP_SINGLE_01', heliport_frequency: 127.5, heliport_modulation: 0, heliport_callsign_id: 1 } },
    route: { points: { 1: { alt: 0, type: '', name: '', x: 2000, y: 2000, speed: 0, formation_template: '', action: '' } } },
  };

  await packMiz(EMPTY_ZIP, new Map([
    ['mission', serializeLuaAssignment('mission', mission)],
    ['l10n/DEFAULT/dictionary', serializeLuaAssignment('dictionary', {})],
    ['l10n/DEFAULT/mapResource', serializeLuaAssignment('mapResource', {})],
  ]), file);
  return file;
}

test('learning reads unknown types, their category and their stores', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dcs-mcp-learn-'));
  t.after(() => { registerTypeSource(undefined); rmSync(dir, { recursive: true, force: true }); });
  const missions = path.join(dir, 'missions');
  const store = path.join(dir, 'packs');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(missions, { recursive: true });
  await missionWithUnknownTypes(path.join(missions, 'a.miz'));
  await missionWithUnknownTypes(path.join(missions, 'b.miz'), '-2');

  const { pack, storedAt } = await learnFromMissions({ folders: [missions], name: 'probe', dir: store });
  assert.equal(pack.sources.length, 2);
  assert.ok(storedAt);
  const byType = new Map(pack.types.map(t => [t.type, t]));

  const flanker = byType.get('Su-30MKI');
  assert.ok(flanker, 'the mod airframe was not learned');
  assert.equal(flanker.category, 'plane', 'category comes from where the mission filed it');
  assert.equal(flanker.missions, 2, 'confidence is the number of distinct missions');
  assert.deepEqual(flanker.stores, ['{SU30_R27ET}', '{SU30_RVVSD}', '{Su30_ASTRA}'], 'stores are the CLSIDs it was flown with');
  assert.deepEqual(flanker.liveries, ['IAF standard']);

  const rig = byType.get('Oil rig');
  assert.ok(rig);
  assert.equal(rig.category, 'static');
  assert.equal(rig.staticCategory, 'Heliports', "a static's own category field is stated by the file");
  assert.equal(rig.shapeName, 'oil_platform');
  assert.equal(rig.rate, 100);

  // A type the catalogue already has must not be reported unless asked for.
  assert.equal(byType.has('Barracks 2'), false);
  const withKnown = await learnFromMissions({ folders: [missions], includeKnown: true });
  assert.ok(withKnown.pack.types.some(t => t.type === 'Barracks 2'));

  // minMissions is the filter that separates a typo from a real type.
  const strict = await learnFromMissions({ folders: [missions], minMissions: 3 });
  assert.equal(strict.pack.types.length, 0);

  assert.match(learnedFingerprint(pack), /^[0-9a-f]{16}$/);
  assert.equal(loadLearnedPacks(store).length, 1);
  await assert.rejects(learnFromMissions({ folders: [missions], name: 'probe', dir: store }), /already exists/);
});

test('an enabled learned type is placeable but carries no catalogue facts', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dcs-mcp-learn2-'));
  t.after(() => { registerTypeSource(undefined); rmSync(dir, { recursive: true, force: true }); });
  const missions = path.join(dir, 'missions');
  const store = path.join(dir, 'packs');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(missions, { recursive: true });
  await missionWithUnknownTypes(path.join(missions, 'a.miz'));
  await learnFromMissions({ folders: [missions], name: 'probe', dir: store });

  assert.equal(findUnitType('Su-30MKI'), undefined, 'not known before the pack is enabled');
  const enabled = enableLearnedTypes(store);
  assert.ok(enabled.types >= 3);

  const flanker = findUnitType('Su-30MKI');
  assert.ok(flanker);
  assert.equal(flanker.source, 'learned');
  assert.equal(flanker.category, 'plane');
  const entry = flanker.entry as { fuelMax: number | null; width: number | null; tasks: string[] };
  assert.equal(entry.fuelMax, null, 'no maximum fuel is invented for a learned airframe');
  assert.equal(entry.width, null, 'no parking footprint either');
  assert.deepEqual(entry.tasks, []);

  // The bundled catalogue always wins, so a learned entry cannot shadow it.
  assert.equal(findUnitType('FA-18C_hornet')?.source, 'bundled');

  // Placing it works, and because fuelMax is unknown no payload.fuel is written:
  // DCS then applies its own default instead of a number we made up.
  const mission = newMissionTable('Caucasus', 43200);
  addAircraftGroup(mission, 'plane', {
    side: 'red', country: 'Russia', name: 'Learned Flight', type: 'Su-30MKI',
    count: 2, x: 0, y: 0, altitudeMetres: 6000, task: 'CAP',
  });
  const parsed = parseLuaAssignment(serializeLuaAssignment('mission', mission), 'mission');
  const group = findGroup(parsed, 'Learned Flight')!.group;
  const unit = luaArray(asTable(group['units']))[0];
  assert.equal(unit['type'], 'Su-30MKI');
  assert.equal(asTable(unit['payload'])?.['fuel'], undefined, 'no invented fuel figure');

  // A learned ground type is placeable as a ground group too.
  addGroundGroup(mission, 'vehicle', { side: 'red', country: 'Russia', name: 'Learned SAM', type: 'Oil rig', count: 1, x: 100, y: 100 });
  assert.ok(findGroup(mission, 'Learned SAM'));
});

test('a learned heliport static can be placed as a pad, with its own shape', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dcs-mcp-learn3-'));
  t.after(() => { registerTypeSource(undefined); rmSync(dir, { recursive: true, force: true }); });
  const missions = path.join(dir, 'missions');
  const store = path.join(dir, 'packs');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(missions, { recursive: true });
  await missionWithUnknownTypes(path.join(missions, 'a.miz'));
  await learnFromMissions({ folders: [missions], name: 'probe', dir: store });
  enableLearnedTypes(store);

  const mission = newMissionTable('Caucasus', 43200);
  // addStatic refuses a heliport on purpose: it needs the ATC fields.
  assert.throws(
    () => addStatic(mission, { side: 'blue', country: 'USA', name: 'Bad', type: 'FARP_SINGLE_01', x: 0, y: 0 }),
    /heliport/
  );
  addFarp(mission, { side: 'blue', country: 'USA', name: 'Learned Pad', x: 5000, y: 5000, type: 'FARP_SINGLE_01', frequencyMHz: 130 });
  const parsed = parseLuaAssignment(serializeLuaAssignment('mission', mission), 'mission');
  const unit = padUnit(parsed, 'Learned Pad');
  assert.equal(unit['type'], 'FARP_SINGLE_01');
  assert.equal(unit['category'], 'Heliports');
  assert.equal(unit['shape_name'], 'FARP_SINGLE_01', 'the shape comes from the learned entry, not a guess');
  assert.equal(unit['heliport_frequency'], 130);

  assert.throws(() => addFarp(mission, { side: 'blue', country: 'USA', name: 'X', x: 0, y: 0, type: 'Barracks 2' }), /not a heliport static/);
  assert.throws(() => addFarp(mission, { side: 'blue', country: 'USA', name: 'Y', x: 0, y: 0, type: 'No Such Pad' }), /Unknown heliport type/);

  assert.deepEqual(removeLearnedPack('probe', store), { removed: 'probe' });
  assert.equal(learnedTypes(store).size, 0);
});

function padUnit(mission: LuaTable, name: string): LuaTable {
  for (const country of luaArray(asTable(asTable(mission['coalition'])?.['blue'])?.['country'])) {
    for (const group of luaArray(asTable(country['static'])?.['group'])) {
      if (group['name'] !== name) continue;
      return luaArray(asTable(group['units']))[0];
    }
  }
  throw new Error(`no pad '${name}'`);
}

test('a mod that declares its units in split files is still detected', async () => {
  const { scanModFolder } = await import('../src/dcs/mods.js');
  const dir = mkdtempSync(path.join(tmpdir(), 'dcs-mcp-mod-'));
  try {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(path.join(dir, 'Database', 'Vehicles'), { recursive: true });
    // HighDigitSAMs' own shape: one unit per file, GT.Name with no registration
    // call beside it (a loader elsewhere calls add_surface_unit).
    writeFileSync(
      path.join(dir, 'Database', 'Vehicles', 'launcher.lua'),
      'local GT = {};\nlocal ws = GT_t.inc_ws();\nGT.Name = "S-300PMU1 5P85CE ln";\nGT.DisplayName = _("SAM SA-20A TEL");\nGT.Rate = 10;\n'
    );
    const mod = scanModFolder(dir, 'tech');
    assert.ok(
      mod.units.some(u => u.type === 'S-300PMU1 5P85CE ln' && u.category === 'vehicle'),
      'a GT.Name definition without add_surface_unit in the same file must still count'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a mod-manager repository is scanned, but its types are not pretended to be live', async (t) => {
  const { installedMods, deployedMods, findModUnit, modRepositoryRoots, clearModCache } = await import('../src/dcs/mods.js');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const dir = mkdtempSync(path.join(tmpdir(), 'dcs-mcp-repo-'));
  t.after(() => { delete process.env.DCS_MCP_MOD_REPOS; clearModCache(); rmSync(dir, { recursive: true, force: true }); });

  // An OvGME-shaped repository: one folder per mod, holding the tree it would
  // deploy. Nothing under Mods/, so DCS is not loading any of it.
  const mod = path.join(dir, 'F-22A Raptor', 'f-22a');
  mkdirSync(mod, { recursive: true });
  writeFileSync(path.join(mod, 'entry.lua'), 'declare_plugin("F-22A", {});\nmake_flyable("F-22A", current_mod_path, {}, {});\n');

  process.env.DCS_MCP_MOD_REPOS = dir;
  clearModCache();
  assert.deepEqual(modRepositoryRoots(), [dir]);
  const mods = installedMods(true);
  const repo = mods.find(m => m.id === 'F-22A');
  assert.ok(repo, 'the repository mod was not found');
  assert.equal(repo.deployed, false, 'a repository mod is available, not deployed');
  assert.equal(repo.repository, dir);
  assert.equal(deployedMods(mods).some(m => m.id === 'F-22A'), false);

  const hit = findModUnit('F-22A', mods);
  assert.ok(hit);
  assert.equal(hit.deployed, false, 'the lookup must say the type will not spawn yet');
});

test('an undeployed mod type is reported as such, not as a typo or as fine', async (t) => {
  const { clearModCache } = await import('../src/dcs/mods.js');
  const { buildMissionDocument } = await import('../src/miz/parser.js');
  const { validateMission } = await import('../src/miz/validator.js');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const dir = mkdtempSync(path.join(tmpdir(), 'dcs-mcp-repo2-'));
  t.after(() => { delete process.env.DCS_MCP_MOD_REPOS; clearModCache(); registerTypeSource(undefined); rmSync(dir, { recursive: true, force: true }); });

  const mod = path.join(dir, 'Raptor', 'f-22a');
  mkdirSync(mod, { recursive: true });
  writeFileSync(path.join(mod, 'entry.lua'), 'declare_plugin("Raptor Mod", {});\nmake_flyable("F-22A", current_mod_path, {}, {});\n');
  process.env.DCS_MCP_MOD_REPOS = dir;
  clearModCache();

  const mission = newMissionTable('Caucasus', 43200);
  addAircraftGroup(mission, 'plane', { side: 'blue', country: 'USA', name: 'Raptor', type: 'F-15C', count: 1, x: 0, y: 0, altitudeMetres: 5000, task: 'CAP' });
  luaArray(asTable(findGroup(mission, 'Raptor')!.group['units']))[0]['type'] = 'F-22A';

  const report = validateMission(buildMissionDocument(mission, {}, 'test'), mission);
  const codes = report.warnings.map(w => w.code);
  assert.ok(codes.includes('MOD_NOT_DEPLOYED'), `expected MOD_NOT_DEPLOYED, got ${codes.join(',')}`);
  assert.ok(!codes.includes('UNKNOWN_UNIT_TYPE'), 'a real mod id is not a typo');
  assert.equal(report.errors.length, 0, 'an undeployed mod is not a file DCS cannot open');
  // pydcs cannot know whether the editor offers a mod type to a country, so it
  // must not be reported as off-menu either.
  assert.ok(!codes.includes('COUNTRY_TYPE_NOT_OFFERED'));
});

test('a type known only from missions is flagged as not present here', async (t) => {
  const { clearModCache } = await import('../src/dcs/mods.js');
  const { buildMissionDocument } = await import('../src/miz/parser.js');
  const { validateMission } = await import('../src/miz/validator.js');
  const dir = mkdtempSync(path.join(tmpdir(), 'dcs-mcp-learn4-'));
  t.after(() => { registerTypeSource(undefined); clearModCache(); rmSync(dir, { recursive: true, force: true }); });
  const missions = path.join(dir, 'missions');
  const store = path.join(dir, 'packs');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(missions, { recursive: true });
  await missionWithUnknownTypes(path.join(missions, 'a.miz'));
  await learnFromMissions({ folders: [missions], name: 'probe', dir: store });
  enableLearnedTypes(store);

  const mission = newMissionTable('Caucasus', 43200);
  addAircraftGroup(mission, 'plane', { side: 'red', country: 'Russia', name: 'Learned', type: 'Su-30MKI', count: 1, x: 0, y: 0, altitudeMetres: 5000, task: 'CAP' });
  const report = validateMission(buildMissionDocument(mission, {}, 'test'), mission);
  const codes = report.warnings.map(w => w.code);
  // Learning the id makes it placeable; it does NOT make it present. Both facts
  // have to survive, or a mission would look fine and spawn nothing.
  assert.ok(codes.includes('TYPE_NOT_ON_THIS_MACHINE'), `expected TYPE_NOT_ON_THIS_MACHINE, got ${codes.join(',')}`);
  assert.ok(!codes.includes('UNKNOWN_UNIT_TYPE'));
  assert.equal(report.errors.length, 0);
});
