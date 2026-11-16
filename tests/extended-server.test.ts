/** Real stdio MCP contract test for the drawing/radio/group/weather/livery/geometry/terrain-pack tools. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildPack } from '../src/terrain/packs.js';
import { openSession, closeSession } from '../src/miz/sessions.js';
import { findGroup, findUnit } from '../src/miz/authoring.js';
import { listDrawings } from '../src/miz/drawings.js';

test('extended MCP tools mutate one session and survive save/reopen', { timeout: 60000 }, async () => {
  const packs = mkdtempSync(join(tmpdir(), 'dcs-packs-')), out = mkdtempSync(join(tmpdir(), 'dcs-ext-'));
  await buildPack({ source: 'SYNTHETIC CONTRACT TEST, NOT REAL TERRAIN', theatre: 'Caucasus', resolutionMetres: null,
    async sample(points) { return points.map(p => ({ ...p, height: 100 + p.x * 0.05, surface: 1 })); } },
  { theatre: 'Caucasus', name: 'test', origin: { x: 0, y: 0 }, spacingMetres: 50, rows: 21, columns: 21 }, packs);
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'src/index.ts'],
    env: { ...process.env, DCS_MCP_STATE_DIR: 'off', DCS_MCP_TERRAIN_DIR: packs } as Record<string, string>, stderr: 'ignore' });
  const client = new Client({ name: 'extended-contract-test', version: '0' });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    assert.ok(!r.isError, `${name}: ${JSON.stringify(r.content)}`); return r.structuredContent as Record<string, any>;
  };
  const fails = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args }); assert.equal(r.isError, true, JSON.stringify(r));
  };
  try {
    const { sessionId } = await call('dcs_miz_new', { theatre: 'Caucasus' });
    // Drawings
    await call('dcs_miz_add_drawing', { sessionId, drawing: { kind: 'arrow', name: 'Push', origin: { x: 0, y: 0 }, lengthMetres: 5000, angle: 45, layer: 'Blue' } });
    await call('dcs_miz_add_drawing', { sessionId, drawing: { kind: 'oval', name: 'Box', origin: { x: 0, y: 0 }, radius1Metres: 1, radius2Metres: 2 } });
    assert.equal((await call('dcs_miz_list_drawings', { sessionId })).count, 2);
    await call('dcs_miz_remove_drawing', { sessionId, layer: 'Author', name: 'Box' });
    await fails('dcs_miz_remove_drawing', { sessionId, layer: 'Author', name: 'Box' });
    // Radios
    await call('dcs_miz_add_aircraft_group', { sessionId, side: 'blue', country: 'USA', name: 'Viper', type: 'F-16C_50', count: 2, x: 0, y: 0, altitudeMetres: 6000, skill: 'Client' });
    const radios = await call('dcs_list_radios', { type: 'F-16C_50' });
    assert.equal(radios.bandsValidated, false);
    await call('dcs_miz_set_radio_presets', { sessionId, unit: 'Viper-1', radio: 1, channels: { '2': 262.5 } });
    await fails('dcs_miz_set_radio_presets', { sessionId, unit: 'Viper-1', radio: 1, channels: { '99': 262.5 } });
    const freq = await call('dcs_miz_set_intra_flight_frequency', { sessionId, group: 'Viper', frequencyMHz: 140, radio: 2 });
    assert.deepEqual(freq.presetUnits, ['Viper-1', 'Viper-2']);
    // Groups
    await call('dcs_miz_add_ground_group', { sessionId, side: 'red', country: 'Russia', name: 'Armor', type: 'T-72B', count: 2, x: 500, y: 500 });
    await call('dcs_miz_clone_group', { sessionId, source: 'Armor', newName: 'Armor2', dx: 100 });
    await call('dcs_miz_add_units_to_group', { sessionId, group: 'Armor2', count: 1 });
    await call('dcs_miz_set_route', { sessionId, group: 'Armor2', points: [{ x: 900, y: 900 }] });
    const near = await call('dcs_miz_find_groups_near', { sessionId, x: 500, y: 500, radiusMetres: 300, side: 'red' });
    assert.deepEqual(near.groups.map((g: any) => g.name), ['Armor', 'Armor2']);
    // Weather, geometry, zones
    assert.equal((await call('dcs_list_cloud_presets', {})).count, 30);
    assert.equal((await call('dcs_miz_set_cloud_preset', { sessionId, preset: 'Overcast 1' })).preset, 'Preset21');
    await fails('dcs_miz_set_cloud_preset', { sessionId, preset: 'Preset1', baseMetres: 1 });
    assert.deepEqual((await call('dcs_geometry', { operation: 'point_from_bearing', from: { x: 0, y: 0 }, bearingDegrees: 0, distanceMetres: 10 })).point, { x: 10, y: 0 });
    await fails('dcs_geometry', { operation: 'midpoint', from: { x: 0, y: 0 } });
    await call('dcs_miz_add_trigger_zone', { sessionId, name: 'Z', x: 0, y: 0, radius: 100 });
    await fails('dcs_miz_add_trigger_zone', { sessionId, name: 'Z', x: 0, y: 0, radius: 100 });
    assert.deepEqual((await call('dcs_miz_points_in_zone', { sessionId, zone: 'Z', points: [{ x: 1, y: 1 }] })).results[0].inside, true);
    // Liveries: unknown on a machine without DCS, never an error
    const liv = await call('dcs_check_livery', { type: 'F-16C_50', livery: 'x' });
    assert.ok(['unknown', 'not_installed', 'installed'].includes(liv.status));
    // Terrain packs: offline analysis with no grid uses the installed pack
    assert.equal((await call('dcs_terrain_list_packs', { theatre: 'Caucasus' })).count, 1);
    const elev = await call('dcs_terrain_analyze', { operation: 'elevation', theatre: 'Caucasus', start: { x: 500, y: 500 } });
    assert.equal(elev.available, true); assert.ok(Math.abs(elev.data.samples[0].height - 125) < 1e-6); assert.match(elev.source, /terrain pack/);
    const outside = await call('dcs_terrain_analyze', { operation: 'elevation', theatre: 'Caucasus', start: { x: -5000, y: 0 } });
    assert.equal(outside.available, false);
    const noPack = await call('dcs_terrain_analyze', { operation: 'elevation', theatre: 'Syria', start: { x: 0, y: 0 } });
    assert.equal(noPack.available, false); assert.match(noPack.reason, /no terrain pack/);
    // Save and reopen
    const file = join(out, 'ext.miz');
    assert.equal((await call('dcs_miz_save_as', { sessionId, outPath: file })).saved, true);
    const s = await openSession(file);
    try {
      assert.ok(findGroup(s.mission, 'Armor2')); assert.equal(findGroup(s.mission, 'Viper')!.group.frequency, 140);
      assert.ok(findUnit(s.mission, 'Viper-1')!.Radio);
      assert.deepEqual(listDrawings(s.mission).map(d => d.name), ['Push']);
    } finally { closeSession(s.id); }
  } finally { await client.close(); }
});
