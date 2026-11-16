/** Real stdio MCP contract test: new tools mutate and save the same session safely. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { openSession, closeSession } from '../src/miz/sessions.js';
import { findGroup, findUnit } from '../src/miz/authoring.js';
import { asTable, luaArray } from '../src/miz/lua.js';
import { findAirport } from '../src/data/reference.js';
import { readWarehouses } from '../src/miz/logistics.js';

test('advanced MCP tools validate, preserve state on failure, and round-trip a complete offline authoring session', { timeout: 60000 }, async () => {
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'src/index.ts'], env: { ...process.env, DCS_MCP_STATE_DIR: 'off', DCS_MCP_TERRAIN_DIR: mkdtempSync(join(tmpdir(), 'dcs-no-packs-')) } as Record<string, string>, stderr: 'ignore' });
  const client = new Client({ name: 'advanced-contract-test', version: '0' });
  const dir = mkdtempSync(join(tmpdir(), 'dcs-advanced-mcp-'));
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    assert.ok(!r.isError, `${name}: ${JSON.stringify(r.content)}`); return r.structuredContent as Record<string, any>;
  };
  const fails = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args }); assert.equal(r.isError, true, JSON.stringify(r));
  };
  try {
    const tools = (await client.listTools()).tools;
    for (const name of ['dcs_miz_create_flight', 'dcs_miz_configure_flight', 'dcs_miz_add_waypoint_task', 'dcs_terrain_analyze',
      'dcs_distance_bearing', 'dcs_miz_move_ground_on_terrain', 'dcs_miz_create_ground_plan', 'dcs_miz_configure_iads',
      'dcs_miz_add_threat_ring', 'dcs_miz_add_surface_task', 'dcs_miz_list_warehouses', 'dcs_miz_edit_warehouse', 'dcs_miz_add_airfield_landing']) assert.ok(tools.some(t => t.name === name), name);
    const { sessionId } = await call('dcs_miz_new', { theatre: 'Caucasus' });
    const unavailable = await call('dcs_terrain_analyze', { operation: 'slope', theatre: 'Caucasus', start: { x: 0, y: 0 } });
    assert.equal(unavailable.available, false); assert.match(unavailable.reason, /No offline elevation/);
    await call('dcs_miz_create_flight', { sessionId, side: 'blue', country: 'USA', name: 'CAP', type: 'FA-18C_hornet', count: 2, role: 'BARCAP',
      start: { kind: 'parking_hot', airfield: 'Kutaisi' }, orbit: { point: { x: -270000, y: 700000 }, pattern: 'Race-Track', point2: { x: -260000, y: 700000 }, durationSeconds: 900 },
      config: { skills: ['Client', 'High'], tailNumbers: ['401', '402'], frequencyMHz: 251, formation: 'finger_four' } });
    await call('dcs_miz_add_waypoint_task', { sessionId, group: 'CAP', waypointIndex: 2, task: { kind: 'option', option: 'roe', value: 2 } });
    await call('dcs_miz_add_airfield_landing', { sessionId, group: 'CAP', airfield: 'Kutaisi' });
    await fails('dcs_miz_set_payload', { sessionId, unit: 'CAP-1', fuel: 999999 });
    await fails('dcs_miz_create_flight', { sessionId, side: 'blue', country: 'USA', name: 'BAD', type: 'FA-18C_hornet', role: 'AWACS', x: 0, y: 0 });
    await call('dcs_miz_create_ground_plan', { sessionId, side: 'blue', country: 'USA', name: 'Patrol', x: 0, y: 0,
      composition: [{ type: 'M-1 Abrams', count: 2 }], plan: { role: 'patrol', route: [{ x: 200, y: 200 }] } });
    const grid = { theatre: 'Caucasus', source: 'SYNTHETIC CONTRACT TEST, NOT REAL TERRAIN', origin: { x: -100, y: -100 }, spacingMetres: 10, rows: 41, columns: 41,
      heights: Array(1681).fill(0), surfaces: Array.from({ length: 1681 }, (_, i) => Math.floor(i / 41) <= 10 ? 3 : 1) };
    const rejected = await call('dcs_miz_move_ground_on_terrain', { sessionId, group: 'Patrol', candidates: [{ x: 0, y: 0 }], grid });
    assert.equal(rejected.moved, false);
    const placed = await call('dcs_miz_move_ground_on_terrain', { sessionId, group: 'Patrol', candidates: [{ x: 0, y: 0 }, { x: 100, y: 100 }], grid });
    assert.equal(placed.moved, true); assert.equal(placed.rejected.length, 1); assert.ok(placed.findings.every((f: any) => f.suitable === true));
    await call('dcs_miz_add_threat_ring', { sessionId, ring: { name: 'Caller range', center: { x: 100, y: 100 }, radiusMetres: 25000 } });
    await call('dcs_miz_edit_warehouse', { sessionId, kind: 'airports', id: 14, create: true, patch: { unlimitedFuel: false, fuel: { jet_fuel: 25 } } });
    await fails('dcs_miz_edit_warehouse', { sessionId, kind: 'airports', id: 14, patch: { weapons: [{ index: 999, quantity: 4 }] } });
    const stock = await call('dcs_miz_list_warehouses', { sessionId });
    assert.equal(stock.warehouses[0].data.jet_fuel.InitFuel, 25);
    const validation = await call('dcs_miz_validate', { sessionId, response_format: 'json' });
    assert.equal(validation.ok, true, JSON.stringify(validation));
    const saved = await call('dcs_miz_save_as', { sessionId, outPath: join(dir, 'mission.miz') }); assert.equal(saved.saved, true);
    const back = await openSession(join(dir, 'mission.miz'));
    assert.equal(findUnit(back.mission, 'CAP-2')!.onboard_num, '402');
    assert.equal(findGroup(back.mission, 'BAD'), undefined);
    const route = luaArray(asTable(findGroup(back.mission, 'CAP')!.group.route)?.points);
    assert.equal(route.length, 3); assert.equal(route[2].type, 'Land'); assert.equal(route[2].airdromeId, findAirport('Caucasus', 'Kutaisi').id);
    assert.equal(findUnit(back.mission, 'Patrol-1')!.x, 100);
    assert.equal(asTable(asTable(asTable(readWarehouses(back).airports)?.[14])?.jet_fuel)!.InitFuel, 25);
    closeSession(back.id);
  } finally { await client.close(); rmSync(dir, { recursive: true, force: true }); }
});
