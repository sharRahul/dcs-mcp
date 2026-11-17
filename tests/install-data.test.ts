import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { coverageReport, findInstallDirs, installInfo, installRootFromLog } from '../src/dcs/install-info.js';
import { installAirfieldData, parseBeaconsLua, parseRadioLua } from '../src/dcs/terrain-files.js';
import { meIcons } from '../src/data/me-icons.js';
import { ICON_FILES } from '../src/miz/drawings.js';
import { AIRBASE_PACK_FORMAT, enableAirbasePacks, loadAirbasePacks, packAirports } from '../src/dcs/airbase-packs.js';
import { findAirport, registerAirportSource, theatreAirports } from '../src/data/reference.js';
import { chooseParking } from '../src/miz/authoring.js';

/**
 * These cover the install-derived half of the server without needing DCS: a fake install
 * tree with ED's own file shapes, and the parsers run over them. The real install is only
 * used by the live tools, which are tested through the hook harness.
 */

const RADIO_LUA = `dofile('Scripts/World/Radio/ModulationTypes.lua')
dofile('Scripts/World/Radio/FrequencyBands.lua')

local gettext = require("i_18n")
local       _ = gettext.translate

--WORLD RADIO

radioTableFormat = 3
radio = {
\t{
\t\t-- Al_Asad_Airbase
\t\tradioId = 'airfield1_0';
\t\trole = {"ground", "tower", "approach"};
\t\tcallsign = {{["common"] = {_("ORAA"), "ORAA"}}};
\t\tfrequency = {[HF] = {MODULATIONTYPE_AM, 3900000.000000}, [UHF] = {MODULATIONTYPE_AM, 363700000.000000}, [VHF_HI] = {MODULATIONTYPE_AM, 131200000.000000}, [VHF_LOW] = {MODULATIONTYPE_AM, 38700000.000000}};
\t\tsceneObjects = {'t:167724340'};
\t};
\t{
\t\t-- Al_Kut_Airport
\t\tradioId = 'airfield19_0';
\t\trole = {"ground", "tower"};
\t\tcallsign = {{["common"] = {_("ORUB"), "ORUB"}}};
\t\tfrequency = {[UHF] = {MODULATIONTYPE_AM, 250850000.000000}};
\t\tsceneObjects = {'t:128353333'};
\t};
}
`;

const BEACONS_LUA = `dofile('Scripts/Database/wsTypes.lua')
dofile('Scripts/World/Radio/BeaconTypes.lua')

local gettext = require("i_18n")
local       _ = gettext.translate

beaconsTableFormat = 2
beacons = {
\t{
\t\tdisplay_name = _('RAA');
\t\tbeaconId = 'airfield1_0';
\t\ttype = BEACON_TYPE_TACAN;
\t\tcallsign = 'RAA';
\t\tchannel = 80;
\t\tposition = { 61461.031250, 173.118993, -164405.296875 };
\t\tdirection = -20.371848;
\t\tpositionGeo = { latitude = 33.787370, longitude = 42.443594 };
\t\tsceneObjects = {'t:56197987'};
\t};
\t{
\t\tdisplay_name = _('IRAA');
\t\tbeaconId = 'airfield1_1';
\t\ttype = BEACON_TYPE_ILS_GLIDESLOPE;
\t\tcallsign = 'IRAA';
\t\tfrequency = 108800000.000000;
\t\tposition = { 61581.535156, 173.118993, -165048.218750 };
\t\tdirection = -89.975619;
\t\tpositionGeo = { latitude = 33.788311, longitude = 42.436624 };
\t};
}
`;

function fakeInstall(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'dcs-install-'));
  mkdirSync(path.join(root, 'bin'), { recursive: true });
  mkdirSync(path.join(root, 'Mods', 'terrains', 'Testland'), { recursive: true });
  mkdirSync(path.join(root, 'CoreMods', 'aircraft', 'TestJet'), { recursive: true });
  writeFileSync(path.join(root, 'autoupdate.cfg'), JSON.stringify({
    version: '2.9.31.29434', timestamp: '20261027-141234', modules: ['WORLD', 'TESTLAND_terrain'],
  }));
  writeFileSync(path.join(root, 'Mods', 'terrains', 'Testland', 'entry.lua'),
    "theatre = {\n\t['update_id'] = \"TESTLAND_terrain\";\n\t['id'] = \"Testland\";\n}\n");
  writeFileSync(path.join(root, 'Mods', 'terrains', 'Testland', 'radio.lua'), RADIO_LUA);
  writeFileSync(path.join(root, 'Mods', 'terrains', 'Testland', 'beacons.lua'), BEACONS_LUA);
  writeFileSync(path.join(root, 'CoreMods', 'aircraft', 'TestJet', 'entry.lua'),
    'declare_plugin("TestJet", {})\nmake_flyable("Test-Jet-999", {})\n');
  return root;
}

test("ED's radio.lua is read as data: frequencies per band, callsign and the airfield index", () => {
  const atc = parseRadioLua(RADIO_LUA);
  assert.equal(atc.length, 2);
  assert.equal(atc[0].radioId, 'airfield1_0');
  assert.equal(atc[0].airfieldIndex, 1);
  assert.equal(atc[0].comment, 'Al_Asad_Airbase');
  assert.equal(atc[0].callsign, 'ORAA');
  assert.deepEqual(atc[0].roles, ['ground', 'tower', 'approach']);
  // The file holds Hz; MHz is what a client flies with.
  assert.deepEqual(atc[0].mhz, { hf: 3.9, vhfLow: 38.7, vhfHigh: 131.2, uhf: 363.7 });
  assert.equal(atc[0].modulation.uhf, 'AM');
  // A band the file does not list must stay absent, not become 0.
  assert.deepEqual(Object.keys(atc[1].mhz), ['uhf']);
  assert.equal(atc[1].airfieldIndex, 19);
});

test("ED's beacons.lua is read as data: TACAN channel, ILS MHz, position and lat/lon", () => {
  const beacons = parseBeaconsLua(BEACONS_LUA);
  assert.equal(beacons.length, 2);
  const tacan = beacons[0];
  assert.equal(tacan.kind, 'TACAN');
  assert.equal(tacan.channel, 80);
  assert.equal(tacan.mhz, undefined, 'a TACAN with no frequency field must not get one');
  // position is {x, alt, z} in the file; x is north and y is east in this API.
  assert.deepEqual(tacan.position, { x: 61461.03125, y: -164405.296875, alt: 173.118993 });
  assert.equal(tacan.lat, 33.78737);
  assert.equal(tacan.lon, 42.443594);
  const ils = beacons[1];
  assert.equal(ils.kind, 'ILS_GLIDESLOPE');
  assert.equal(ils.mhz, 108.8);
  assert.equal(ils.channel, undefined);
  assert.equal(ils.airfieldIndex, 1);
});

test('a parser change in ED\'s format reports nothing rather than guessing', () => {
  assert.deepEqual(parseRadioLua('radio = {\n\t{\n\t\tnotARadio = 1;\n\t};\n}'), []);
  assert.deepEqual(parseBeaconsLua('beacons = {\n\t{\n\t\tbeaconId = \'x_0\';\n\t};\n}'), [],
    'a beacon with no type must be skipped, not given one');
});

test('the install is found and described from its own files', () => {
  const root = fakeInstall();
  const env = { DCS_INSTALL_DIR: root } as NodeJS.ProcessEnv;
  const found = findInstallDirs(env);
  assert.equal(found[0].source, 'env');
  assert.equal(found[0].path, root);

  const info = installInfo(env, true);
  assert.equal(info.version, '2.9.31.29434');
  assert.equal(info.versionSource, 'autoupdate.cfg');
  assert.equal(info.installedAt, '20261027-141234');
  assert.deepEqual(info.modules, ['WORLD', 'TESTLAND_terrain']);
  assert.equal(info.theatres.length, 1);
  assert.deepEqual(info.theatres[0], {
    folder: 'Testland', id: 'Testland', updateId: 'TESTLAND_terrain', bundledKey: undefined,
    files: { entry: true, radio: true, beacons: true },
  });

  // Coverage drift: a terrain with no bundled data, and a type the install declares that
  // the pinned catalogue has never heard of.
  const coverage = coverageReport(env);
  assert.deepEqual(coverage.theatresWithoutData.map(t => t.folder), ['Testland']);
  assert.ok(coverage.theatresWithoutData[0].readableData.length === 2);
  assert.ok(coverage.typesNotInCatalogue.some(t => t.type === 'Test-Jet-999'), JSON.stringify(coverage.typesNotInCatalogue));
  assert.ok(coverage.theatresNotInstalled.includes('Syria'));
  assert.ok(coverage.notes.join(' ').includes('states no DCS build'), 'the report must say why there is no version comparison');
  installInfo({} as NodeJS.ProcessEnv, true); // drop the cache for other tests
});

test('install terrain data is grouped per airfield and says what is missing', () => {
  const root = fakeInstall();
  const env = { DCS_INSTALL_DIR: root } as NodeJS.ProcessEnv;
  installInfo(env, true);
  const data = installAirfieldData('Testland', env);
  assert.equal(data.airfields.length, 2);
  const first = data.airfields[0];
  assert.equal(first.airfieldIndex, 1);
  assert.equal(first.name, 'Al_Asad_Airbase');
  assert.equal(first.beacons.length, 2);
  assert.equal(data.files.length, 2);
  assert.match(data.files[0].sha256, /^[0-9a-f]{64}$/);
  assert.ok(data.notes.some(n => n.includes('not mission-file airdromeId')), data.notes.join(' | '));
  assert.throws(() => installAirfieldData('Nowhere', env), /not an installed terrain/);
  installInfo({} as NodeJS.ProcessEnv, true);
});

test("the Mission Editor's own icon list is bundled and usable by drawings", () => {
  const icons = meIcons();
  assert.ok(icons.count >= 50, `expected the editor's full picker list, got ${icons.count}`);
  assert.equal(icons.icons['Air Defence SAM'], 'P91000009.png');
  assert.equal(icons.icons['Warship'], 'P91000039.png');
  // pydcs's nine names still resolve, and to the same files.
  assert.equal(ICON_FILES.AirDefense, 'P91000009.png');
  assert.ok(Object.keys(ICON_FILES).length >= icons.count);
});

test('an airbase pack makes an unbundled theatre usable, with slot sizes left unknown', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dcs-airbases-'));
  writeFileSync(path.join(dir, 'Testmap__sample.json'), JSON.stringify({
    format: AIRBASE_PACK_FORMAT, name: 'sample', theatre: 'Testmap', createdAt: '2026-11-17T00:00:00Z',
    source: 'DCS bridge airbases command', dcsVersion: '2.9.31.29434',
    airbases: [
      { id: 77, name: 'Testfield', displayName: 'Testfield Intl', category: 'AIRDROME', x: 1000, y: 2000,
        lat: 33.5, lon: 42.5, runways: [{ name: '09-27', course: 1.57 }],
        parking: [{ term: 10, term0: 10, termType: 104, x: 1100, y: 2050 }, { term: 11, term0: 11, termType: 104, x: 1120, y: 2070 }] },
      { id: 78, name: 'Testpad', category: 'HELIPAD', x: 5000, y: 6000, runways: [], parking: [] },
    ],
  }));
  try {
    assert.equal(loadAirbasePacks('Testmap', dir).length, 1);
    const airports = packAirports('Testmap', loadAirbasePacks('Testmap', dir));
    // A helipad is not an airfield a flight starts from with an airdromeId.
    assert.equal(airports.length, 1);
    assert.equal(airports[0].id, 77);
    assert.equal(airports[0].name, 'Testfield Intl');
    assert.equal(airports[0].slots.length, 2);
    // Everything the live answer does not contain stays 0 = unknown.
    assert.deepEqual(airports[0].slots[0], [10, '10', 1100, 2050, 0, 0, 0, 0]);
    assert.equal(airports[0].slotsUnverified, true);

    enableAirbasePacks(dir);
    const found = theatreAirports('Testmap');
    assert.equal(found.source, 'pack');
    assert.equal(findAirport('Testmap', 'Testfield').id, 77);
    // Unknown slot dimensions must not be failed against invented ones: the pydcs fit
    // rule is skipped for a sampled slot rather than rejecting every aircraft.
    const chosen = chooseParking(airports[0], 'plane', 'FA-18C_hornet', 2, new Set());
    assert.equal(chosen.length, 2);
    // A bundled theatre is unaffected by packs.
    assert.equal(theatreAirports('Syria').source, 'bundled');
  } finally {
    registerAirportSource(undefined);
  }
});
