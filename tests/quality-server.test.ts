/** Real stdio MCP contract test for fuel, radio-band, provenance and warehouse-donor tools. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { closeSession, newSession, saveSessionAs } from '../src/miz/sessions.js';
import { serializeLuaAssignment } from '../src/miz/serializer.js';

test('fuel, radio bands, provenance and donors work over stdio', { timeout: 60000 }, async () => {
  const donors = mkdtempSync(join(tmpdir(), 'dcs-donors-')), dir = mkdtempSync(join(tmpdir(), 'dcs-q-'));
  // Donor mission with one wsType-bearing aircraft and weapon; airport 22 (Batumi) has a warehouse with no stock.
  const wh = { airports: { 22: { coalition: 'BLUE', aircrafts: { planes: { 'F-16C_50': { initialAmount: 2, wsType: { 1: 1, 2: 1, 3: 5, 4: 56 } } } },
    weapons: { 1: { initialAmount: 10, wsType: { 1: 4, 2: 4, 3: 7, 4: 24 } } } } }, warehouses: {} };
  const src = newSession('Caucasus', 43200), zip = new AdmZip(src.sourceBytes);
  zip.updateFile('warehouses', Buffer.from(serializeLuaAssignment('warehouses', wh))); src.sourceBytes = zip.toBuffer();
  const donorFile = join(dir, 'donor.miz'); await saveSessionAs(src, donorFile); closeSession(src.id);
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'src/index.ts'],
    env: { ...process.env, DCS_MISSION_OUTPUT_DIR: dir, DCS_MCP_STATE_DIR: 'off', DCS_MCP_DONOR_DIR: donors } as Record<string, string>, stderr: 'ignore' });
  const client = new Client({ name: 'quality-test', version: '0' });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args }); assert.ok(!r.isError, `${name}: ${JSON.stringify(r.content)}`); return r.structuredContent as Record<string, any>;
  };
  const fails = async (name: string, args: Record<string, unknown>) => { const r = await client.callTool({ name, arguments: args }); assert.equal(r.isError, true, JSON.stringify(r)); };
  try {
    const fuel = await call('dcs_aircraft_fuel', { type: 'A-10C' });
    assert.ok(fuel.fuelMaxKg > 0);
    const { sessionId } = await call('dcs_miz_new', { theatre: 'Caucasus' });
    await call('dcs_miz_add_aircraft_group', { sessionId, side: 'blue', country: 'USA', name: 'Hog', type: 'A-10C', count: 1, x: 0, y: 0, altitudeMetres: 4000, skill: 'Client' });
    await call('dcs_miz_set_payload', { sessionId, unit: 'Hog-1', fuelPercent: 25 });
    await fails('dcs_miz_set_payload', { sessionId, unit: 'Hog-1', fuelPercent: 25, fuel: 100 });
    const report = await call('dcs_miz_fuel_report', { sessionId });
    assert.equal(report.units[0].percent, 25);
    const radios = await call('dcs_list_radios', { type: 'A-10C' });
    assert.equal(radios.bandsValidated, true);
    await fails('dcs_miz_set_radio_presets', { sessionId, unit: 'Hog-1', radio: 2, channels: { '1': 130 } });
    const prov = await call('dcs_data_provenance', {});
    assert.deepEqual(prov.unregistered, []);
    assert.ok(prov.datasets.every((d: any) => d.pinnedInputs > 0));
    const imp = await call('dcs_import_warehouse_donor', { file: donorFile, id: 'kutaisi' });
    assert.equal(imp.weapons, 1);
    assert.equal((await call('dcs_list_warehouse_donors', {})).count, 1);
    await call('dcs_miz_edit_warehouse', { sessionId, kind: 'airports', id: 22, create: true, patch: {} });
    await call('dcs_miz_add_warehouse_stock', { sessionId, kind: 'airports', id: 22, donor: 'kutaisi',
      aircraft: [{ category: 'planes', type: 'F-16C_50', quantity: 3 }], weapons: [{ wsType: '4.4.7.24', quantity: 5 }] });
    await fails('dcs_miz_add_warehouse_stock', { sessionId, kind: 'airports', id: 22, donor: 'kutaisi', weapons: [{ wsType: '4.4.7.24', quantity: 5 }] });
    const list = await call('dcs_miz_list_warehouses', { sessionId });
    const batumi = list.warehouses.find((w: any) => w.kind === 'airports' && w.id === 22).data;
    assert.equal(batumi.aircrafts.planes['F-16C_50'].initialAmount, 3);
    assert.equal(await call('dcs_miz_save_as', { sessionId, outPath: join(dir, 'out.miz') }).then(r => r.saved), true);
  } finally { await client.close(); }
});
