/**
 * Campaign files, imported compound footprints, reactive spawns and the
 * editor's effect statics.
 *
 * The campaign expectations are ED's own rules from the installed
 * `me_campaign.lua` / `me_campaign_editor.lua`; the footprint tests check that a
 * layout measured out of a mission comes back out unchanged at another position
 * and heading, which is the whole reason for importing one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  parseCampaign, validateCampaign, stepCampaign, buildCampaignTable, writeCampaignFile,
  readCampaignFile, playerUnitType, checkCampaignFiles, DEFAULT_SKIP_SCORE,
} from '../src/dcs/campaign.js';
import { serializeLuaAssignment } from '../src/miz/serializer.js';
import { parseLuaAssignment, asTable, luaArray, type LuaTable } from '../src/miz/lua.js';
import { addAircraftGroup, addGroundGroup, addTriggerZone, compileTrig, findGroup, newMissionTable } from '../src/miz/authoring.js';
import { addStatic, updateGroup } from '../src/miz/editing.js';
import { packMiz } from '../src/miz/archive.js';
import { scanSceneCandidates, importSceneTemplate, findSceneTemplate, loadSceneTemplates, removeSceneTemplate } from '../src/miz/scene-import.js';
import { addSceneTemplate } from '../src/miz/dressing.js';
import { addReactiveSpawn, nextFreeFlag, setDynamicSpawnTemplate } from '../src/miz/reactive.js';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'dcs-mcp-cs-'));

// --- campaign files --------------------------------------------------------

/** A .cmp exactly as the editor writes one, in its bracketed-key style. */
const SAMPLE_CMP = `campaign =
{
    ["description"] = "Two stages.",
    ["name"] = "Probe Campaign",
    ["startStage"] = 1,
    ["version"] = 1,
    ["necessaryUnits"] =
    {
        ["A-10C"] = "A-10C",
    }, -- end of ["necessaryUnits"]
    ["stages"] =
    {
        [1] =
        {
            ["name"] = "Stage 1",
            ["missions"] =
            {
                [1] =
                {
                    ["file"] = "one.miz",
                    ["interval"] = { [1] = 0, [2] = 100 },
                    ["description"] = "",
                    ["skipScore"] = 100,
                }, -- end of [1]
            }, -- end of ["missions"]
        }, -- end of [1]
        [2] =
        {
            ["name"] = "Stage 2",
            ["missions"] =
            {
                [1] =
                {
                    ["file"] = "two.miz",
                    ["interval"] = { [1] = 0, [2] = 100 },
                    ["description"] = "",
                    ["skipScore"] = 100,
                }, -- end of [1]
            }, -- end of ["missions"]
        }, -- end of [2]
    }, -- end of ["stages"]
} -- end of campaign
`;

test('a .cmp is parsed as data, in ladder order, with its locale keys kept', () => {
  const campaign = parseCampaign(SAMPLE_CMP.replace('["name"] = "Probe Campaign",', '["name"] = "Probe Campaign",\n    ["name_RU"] = "x",'));
  assert.equal(campaign.name, 'Probe Campaign');
  assert.equal(campaign.startStage, 1);
  assert.deepEqual(campaign.stages.map(s => s.name), ['Stage 1', 'Stage 2']);
  assert.deepEqual(campaign.stages[0].missions[0].interval, [0, 100]);
  assert.equal(campaign.necessaryUnits?.['A-10C'], 'A-10C');
  // Localised variants are not modelled, but a round trip must not drop them.
  assert.equal(campaign.extra?.['name_RU'], 'x');
  assert.equal(validateCampaign(campaign).findings.filter(f => f.severity === 'error').length, 0);
});

test('stage keys out of order still read as the ladder DCS walks', () => {
  // ED iterates `for i = 1, #campaign.stages`, so [3] before [1] in the file is
  // still stage 1 then stage 3; the numeric key is the position.
  const text = SAMPLE_CMP.replace('[1] =\n        {\n            ["name"] = "Stage 1",', '[2] =\n        {\n            ["name"] = "Stage 1",')
    .replace('[2] =\n        {\n            ["name"] = "Stage 2",', '[1] =\n        {\n            ["name"] = "Stage 2",');
  assert.deepEqual(parseCampaign(text).stages.map(s => s.name), ['Stage 2', 'Stage 1']);
});

test('campaign validation reports what DCS itself refuses', () => {
  const base = parseCampaign(SAMPLE_CMP);

  const empty = structuredClone(base);
  empty.stages[1].missions = [];
  const emptyCodes = validateCampaign(empty).findings.filter(f => f.severity === 'error').map(f => f.code);
  assert.ok(emptyCodes.includes('STAGE_EMPTY'), 'an empty stage makes DCS refuse the campaign');

  // A score no mission covers stops the campaign with 'no mission chosen'.
  const gap = structuredClone(base);
  gap.stages[1].missions[0].interval = [60, 100];
  const gapFinding = validateCampaign(gap).findings.find(f => f.code === 'STAGE_SCORE_GAP');
  assert.ok(gapFinding && gapFinding.severity === 'error');
  assert.match(gapFinding.message, /0-59/);

  // The start stage wants an opener whose interval ends at 100.
  const noOpener = structuredClone(base);
  noOpener.stages[0].missions[0].interval = [0, 90];
  const opener = validateCampaign(noOpener).findings.find(f => f.code === 'START_STAGE_NO_OPENER');
  assert.ok(opener && opener.severity === 'warning', 'DCS falls back to mission 1 and logs it, so this is a warning');

  const outOfRange = structuredClone(base);
  outOfRange.startStage = 9;
  assert.ok(validateCampaign(outOfRange).findings.some(f => f.code === 'START_STAGE_OUT_OF_RANGE'));

  const withPath = structuredClone(base);
  withPath.stages[0].missions[0].file = 'sub/one.miz';
  assert.ok(validateCampaign(withPath).findings.some(f => f.code === 'MISSION_FILE_HAS_PATH'));
});

test('campaign progression follows ED chooseNextMission', () => {
  const campaign = parseCampaign(SAMPLE_CMP);
  assert.equal(stepCampaign(campaign, { stage: 1, result: 80 }).stage, 2, 'above 50 advances');
  assert.equal(stepCampaign(campaign, { stage: 1, result: 50 }).stage, 1, 'exactly 50 repeats');
  assert.equal(stepCampaign(campaign, { stage: 1, result: 10 }).outcome, 'lost', 'below stage 1 is a loss');
  assert.equal(stepCampaign(campaign, { stage: 2, result: 90 }).outcome, 'won', 'past the last stage is a win');
  // A skipped mission advances whatever the score was.
  assert.equal(stepCampaign(campaign, { stage: 1, result: 0, skipped: true }).stage, 2);
  // Candidates are every matching mission, because DCS picks among them at random.
  const wide = structuredClone(campaign);
  wide.stages[1].missions.push({ file: 'two-b.miz', interval: [0, 100] });
  assert.deepEqual(stepCampaign(wide, { stage: 1, result: 70 }).candidates.map(c => c.file), ['two.miz', 'two-b.miz']);
  assert.throws(() => stepCampaign(campaign, { stage: 7, result: 60 }), /outside 1\.\.2/);
});

test('a written campaign round-trips and refuses one DCS could not run', async () => {
  const dir = tmp();
  try {
    for (const name of ['one.miz', 'two.miz']) writeFileSync(path.join(dir, name), 'not a real mission');
    const out = path.join(dir, 'probe.cmp');
    const written = await writeCampaignFile(out, {
      name: 'Probe',
      description: 'Written by a test.',
      stages: [
        { name: 'Stage 1', missions: [{ file: 'one.miz', interval: [0, 100] }] },
        { name: 'Stage 2', missions: [{ file: 'two.miz', interval: [0, 100] }] },
      ],
    });
    assert.equal(written.stages, 2);
    assert.equal(written.missions, 2);
    assert.deepEqual(written.missingMissions, []);
    const read = await readCampaignFile(out);
    assert.equal(read.campaign.name, 'Probe');
    assert.equal(read.campaign.stages[0].missions[0].skipScore, DEFAULT_SKIP_SCORE);
    assert.equal(read.sha256, written.sha256);
    // The ladder must be complete, or DCS stops mid-campaign.
    await assert.rejects(
      writeCampaignFile(path.join(dir, 'gap.cmp'), {
        name: 'Gap',
        stages: [{ name: 'Stage 1', missions: [{ file: 'one.miz', interval: [60, 100] }] }],
      }),
      /STAGE_SCORE_GAP/
    );
    // Missions must sit beside the .cmp; DCS resolves directory .. file.
    const away = await writeCampaignFile(path.join(dir, 'away.cmp'), {
      name: 'Away',
      stages: [{ name: 'Stage 1', missions: [{ file: 'missing.miz', interval: [0, 100] }] }],
    });
    assert.deepEqual(away.missingMissions, ['missing.miz']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('necessaryUnits comes from the player unit, as the editor derives it', () => {
  const mission = newMissionTable('Caucasus', 43200);
  addAircraftGroup(mission, 'plane', { side: 'blue', country: 'USA', name: 'Viper', type: 'F-16C_50', count: 1, x: 0, y: 0, altitudeMetres: 3000, task: 'CAS' });
  assert.equal(playerUnitType(mission), undefined, 'no Player skill unit yet');
  const group = findGroup(mission, 'Viper')!.group;
  luaArray(asTable(group['units']))[0]['skill'] = 'Player';
  assert.equal(playerUnitType(mission), 'F-16C_50');
  const table = buildCampaignTable(
    { name: 'N', startStage: 1, stages: [{ name: 'S', missions: [{ file: 'a.miz', interval: [0, 100] as [number, number] }] }] },
    { necessaryUnits: ['F-16C_50'] }
  );
  assert.equal(asTable(table['necessaryUnits'])?.['F-16C_50'], 'F-16C_50');
  // What is written must parse back as a campaign.
  assert.equal(parseCampaign(serializeLuaAssignment('campaign', table)).stages.length, 1);
});

// --- imported compound footprints -----------------------------------------

/** A mission with one deliberate compound: a square of walls plus two huts. */
async function missionWithCompound(dir: string) {
  const mission = newMissionTable('Caucasus', 43200);
  // Perimeter at individual headings, which is what a grid cannot express.
  const wall = [
    { dx: -40, dy: -40, h: 0 }, { dx: 0, dy: -40, h: 0 }, { dx: 40, dy: -40, h: 0 },
    { dx: 40, dy: 0, h: 90 }, { dx: 40, dy: 40, h: 180 }, { dx: 0, dy: 40, h: 180 },
    { dx: -40, dy: 40, h: 180 }, { dx: -40, dy: 0, h: 270 },
  ];
  wall.forEach((w, i) =>
    addStatic(mission, { side: 'red', country: 'Russia', name: `Wall-${i + 1}`, type: 'Sandbag_03', x: 1000 + w.dx, y: 2000 + w.dy, heading: w.h })
  );
  addStatic(mission, { side: 'red', country: 'Russia', name: 'Hut-1', type: 'Barracks 2', x: 1010, y: 2000, heading: 0 });
  addStatic(mission, { side: 'red', country: 'Russia', name: 'Hut-2', type: 'Barracks 2', x: 990, y: 2010, heading: 0 });
  // A second, far-away cluster that must not merge with the first.
  for (let i = 0; i < 5; i++) {
    addStatic(mission, { side: 'red', country: 'Russia', name: `Far-${i + 1}`, type: 'Tank', x: 9000 + i * 30, y: 9000, heading: 0 });
  }
  const file = path.join(dir, 'compound.miz');
  await packMiz(Buffer.from(emptyZip(), 'base64'), new Map([
    ['mission', serializeLuaAssignment('mission', mission)],
    ['l10n/DEFAULT/dictionary', serializeLuaAssignment('dictionary', {})],
    ['l10n/DEFAULT/mapResource', serializeLuaAssignment('mapResource', {})],
  ]), file);
  return file;
}

/** The smallest valid ZIP, so packMiz has a source archive to copy from. */
function emptyZip(): string {
  return 'UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==';
}

test('a compound is found, imported with its own headings, and placed unchanged', async () => {
  const dir = tmp();
  const store = path.join(dir, 'templates');
  try {
    const file = await missionWithCompound(dir);
    const scan = await scanSceneCandidates({ file });
    assert.equal(scan.theatre, 'Caucasus');
    const biggest = scan.candidates[0];
    assert.equal(biggest.count, 10, 'the walled compound is one cluster of ten');
    assert.ok(biggest.distinctHeadings > 1, 'individual object headings are kept, not flattened');
    assert.ok(scan.candidates.some(c => c.count === 5), 'the far cluster stays separate at the default link distance');

    const { template } = await importSceneTemplate({ file, candidate: biggest.index, id: 'probe', description: 'walled compound' }, store);
    assert.equal(template.provenance, 'imported');
    assert.equal(template.objects.length, 10);
    assert.equal(template.source.sha256, scan.sha256);
    assert.equal(findSceneTemplate('probe', store).objects.length, 10);
    assert.equal(loadSceneTemplates(store).length, 1);
    await assert.rejects(importSceneTemplate({ file, candidate: biggest.index, id: 'probe' }, store), /already exists/);
    await assert.rejects(importSceneTemplate({ file, candidate: 99, id: 'other' }, store), /does not exist/);

    // Placed at a new origin with no rotation: offsets reappear exactly.
    const target = newMissionTable('Caucasus', 43200);
    addSceneTemplate(target, template, { side: 'blue', country: 'USA', name: 'Camp', x: 50000, y: 60000 });
    const parsed = parseLuaAssignment(serializeLuaAssignment('mission', target), 'mission');
    const statics = staticsOf(parsed, 'blue');
    assert.equal(statics.length, 10);
    template.objects.forEach((o, i) => {
      assert.ok(Math.abs(Number(statics[i]['x']) - (50000 + o.forward)) < 1e-6, `object ${i + 1} x`);
      assert.ok(Math.abs(Number(statics[i]['y']) - (60000 + o.right)) < 1e-6, `object ${i + 1} y`);
    });

    // Rotated 90 degrees: forward goes east, right goes south, and every object
    // turns with the compound.
    const turned = newMissionTable('Caucasus', 43200);
    addSceneTemplate(turned, template, { side: 'blue', country: 'USA', name: 'Camp', x: 0, y: 0, heading: 90 });
    const turnedStatics = staticsOf(parseLuaAssignment(serializeLuaAssignment('mission', turned), 'mission'), 'blue');
    template.objects.forEach((o, i) => {
      assert.ok(Math.abs(Number(turnedStatics[i]['x']) - -o.right) < 1e-6, `rotated object ${i + 1} x`);
      assert.ok(Math.abs(Number(turnedStatics[i]['y']) - o.forward) < 1e-6, `rotated object ${i + 1} y`);
      const expected = ((90 + o.headingOffset) % 360) * (Math.PI / 180);
      assert.ok(Math.abs(Number(turnedStatics[i]['heading']) - expected) < 1e-6, `rotated object ${i + 1} heading`);
    });

    assert.deepEqual(removeSceneTemplate('probe', store), { removed: 'probe' });
    assert.equal(loadSceneTemplates(store).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function staticsOf(mission: LuaTable, side: string): LuaTable[] {
  const out: LuaTable[] = [];
  for (const country of luaArray(asTable(asTable(mission['coalition'])?.[side])?.['country'])) {
    for (const group of luaArray(asTable(country['static'])?.['group'])) {
      for (const unit of luaArray(asTable(group['units']))) out.push(unit);
    }
  }
  return out;
}

// --- reactive spawns -------------------------------------------------------

function reactiveMission() {
  const mission = newMissionTable('Caucasus', 43200);
  addAircraftGroup(mission, 'plane', { side: 'blue', country: 'USA', name: 'Player', type: 'F-16C_50', count: 1, x: 0, y: 0, altitudeMetres: 3000, task: 'CAS' });
  addGroundGroup(mission, 'vehicle', { side: 'red', country: 'Russia', name: 'Reserve', type: 'T-72B', count: 2, x: 20000, y: 0 });
  addTriggerZone(mission, { name: 'Ingress', x: 10000, y: 0, radius: 5000 });
  return mission;
}

test('a reactive spawn needs a late-activated group and compiles to real trig', () => {
  const mission = reactiveMission();
  assert.throws(
    () => addReactiveSpawn(mission, { label: 'Ambush', trigger: { on: 'coalition_in_zone', zone: 'Ingress', coalition: 'blue' }, activate: ['Reserve'] }, {}),
    /not late-activated/
  );
  updateGroup(mission, 'Reserve', { lateActivation: true });
  const out = addReactiveSpawn(
    mission,
    {
      label: 'Ambush',
      trigger: { on: 'coalition_in_zone', zone: 'Ingress', coalition: 'blue', unitType: 'AIRPLANE' },
      activate: ['Reserve'],
      chancePercent: 70,
      message: { text: 'Contacts!', coalition: 'blue' },
      setFlag: 12,
    },
    {}
  );
  assert.equal(out.triggers.length, 1);
  const { compiled, skipped } = compileTrig(mission);
  assert.deepEqual(skipped, [], 'every predicate a reactive spawn writes has a compiler');
  assert.deepEqual(compiled, out.triggers);
  const trig = asTable(mission['trig'])!;
  const condition = String(asTable(trig['conditions'])![out.triggers[0]]);
  assert.match(condition, /c_part_of_coalition_in_zone\("blue", \d+, "AIRPLANE"\)/);
  assert.match(condition, /c_random_less\(70\)/);
  const action = String(asTable(trig['actions'])![out.triggers[0]]);
  assert.match(action, /a_activate_group\(\d+\)/);
  assert.match(action, /a_set_flag\(12\)/);
  assert.match(action, /mission\.trig\.func\[\d+\]=nil;$/, 'a once trigger disarms itself');
});

test('a delayed reactive spawn uses two triggers and one free flag', () => {
  const mission = reactiveMission();
  updateGroup(mission, 'Reserve', { lateActivation: true });
  const out = addReactiveSpawn(
    mission,
    { label: 'Second wave', trigger: { on: 'group_dead', group: 'Reserve' }, activate: ['Reserve'], delaySeconds: 120 },
    {}
  );
  assert.equal(out.triggers.length, 2, 'DCS has no delay on a_activate_group, so arm-then-fire');
  assert.equal(typeof out.delayFlag, 'number');
  const { skipped } = compileTrig(mission);
  assert.deepEqual(skipped, []);
  const conditions = asTable(asTable(mission['trig'])!['conditions'])!;
  assert.match(String(conditions[out.triggers[1]]), new RegExp(`c_time_since_flag\\(${out.delayFlag}, 120\\)`));
  // The next free flag must now skip the one the delay took.
  assert.notEqual(nextFreeFlag(mission), out.delayFlag);
});

test('a reactive spawn with nothing to do, or an unknown group, is refused', () => {
  const mission = reactiveMission();
  assert.throws(() => addReactiveSpawn(mission, { label: 'Nothing', trigger: { on: 'time', seconds: 60 } }, {}), /needs something to do/);
  assert.throws(
    () => addReactiveSpawn(mission, { label: 'Ghost', trigger: { on: 'time', seconds: 60 }, deactivate: ['Nope'] }, {}),
    /No group named 'Nope'/
  );
});

test('dynSpawnTemplate is written as the flag it is, with no claim about it', () => {
  const mission = reactiveMission();
  const out = setDynamicSpawnTemplate(mission, 'Player', true);
  assert.equal(out.dynSpawnTemplate, true);
  assert.equal(findGroup(mission, 'Player')!.group['dynSpawnTemplate'], true);
  assert.ok(out.notes.some(n => /not been seen, flown or verified/.test(n)));
  assert.throws(() => setDynamicSpawnTemplate(mission, 'Reserve', true), /vehicle group/);
});

// --- effect statics --------------------------------------------------------

test("the editor's smoke effect is placeable, and only with a preset", () => {
  const mission = newMissionTable('Caucasus', 43200);
  assert.throws(
    () => addStatic(mission, { side: 'red', country: 'Russia', name: 'Smoke', type: 'big_smoke', x: 0, y: 0 }),
    /needs effectPreset/
  );
  assert.throws(
    () => addStatic(mission, { side: 'red', country: 'Russia', name: 'Smoke', type: 'big_smoke', x: 0, y: 0, effectPreset: 9 }),
    /effectPreset must be an integer 1-8/
  );
  addStatic(mission, {
    side: 'red', country: 'Russia', name: 'Smoke', type: 'big_smoke', x: 100, y: 200,
    effectPreset: 6, effectTransparency: 0.5, effectCourseDegrees: 45,
  });
  const unit = staticsOf(parseLuaAssignment(serializeLuaAssignment('mission', mission), 'mission'), 'red')[0];
  assert.equal(unit['category'], 'Effects', "big_smoke is an Effects static, per ED's own db_countries.lua");
  assert.equal(unit['effectPreset'], 6);
  assert.equal(unit['effectTransparency'], 0.5);
  assert.equal(unit['effectCourse'], 45);
  // Effect settings on a building would be vestigial, so they are refused.
  assert.throws(
    () => addStatic(mission, { side: 'red', country: 'Russia', name: 'Shed', type: 'Barracks 2', x: 0, y: 0, effectPreset: 1 }),
    /not an effect static/
  );
});

test('a static livery is only accepted where DCS stores one', () => {
  const mission = newMissionTable('Caucasus', 43200);
  addStatic(mission, { side: 'blue', country: 'USA', name: 'Parked', type: 'F-16C_50', x: 0, y: 0, liveryId: 'default', hiddenOnPlanner: true });
  const parsed = parseLuaAssignment(serializeLuaAssignment('mission', mission), 'mission');
  assert.equal(staticsOf(parsed, 'blue')[0]['livery_id'], 'default');
  const group = luaArray(asTable(luaArray(asTable(asTable(parsed['coalition'])?.['blue'])?.['country'])[0]['static'])?.['group'])[0];
  assert.equal(group['hiddenOnPlanner'], true);
  assert.throws(
    () => addStatic(mission, { side: 'blue', country: 'USA', name: 'Shed', type: 'Barracks 2', x: 0, y: 0, liveryId: 'default' }),
    /liveryId applies to aircraft and ships/
  );
});

test('a campaign folder with no missions still reports cleanly', async () => {
  const dir = tmp();
  try {
    mkdirSync(path.join(dir, 'empty'), { recursive: true });
    const campaign = parseCampaign(SAMPLE_CMP);
    const files = await checkCampaignFiles(campaign, path.join(dir, 'empty'));
    assert.deepEqual(files.present, []);
    assert.deepEqual(files.missing.sort(), ['one.miz', 'two.miz']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
