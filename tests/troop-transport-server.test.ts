import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// The tool's handler once passed sessionId into makeTroopTransport, whose strict
// schema rejected it: every call through MCP failed. Found building a mission live.
test('dcs_miz_make_troop_transport works through the MCP interface', async () => {
  const client = new Client({ name: 'troop-transport-test', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'src/index.ts'],
    env: { ...process.env, DCS_MCP_STATE_DIR: 'off' } as Record<string, string>, stderr: 'ignore' }));
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    assert.ok(!r.isError, `${name}: ${JSON.stringify(r.content)}`);
    return r.structuredContent as Record<string, any>;
  };
  try {
    const { sessionId } = await call('dcs_miz_new', { theatre: 'Caucasus' });
    const side = { sessionId, side: 'blue', country: 'USA' };
    await call('dcs_miz_add_ground_group', { ...side, name: 'Troops', type: 'Soldier M4', count: 4, x: -281400, y: 647900 });
    await call('dcs_miz_add_aircraft_group', { ...side, name: 'Lift', type: 'UH-1H', category: 'helicopter', x: -281500, y: 648200, altitudeMetres: 50 });
    await call('dcs_miz_set_route', { sessionId, group: 'Lift', points: [
      { x: -281400, y: 647900, altitudeMetres: 50 }, { x: -270000, y: 650000, altitudeMetres: 60 }] });
    await call('dcs_miz_make_troop_transport', { sessionId, transport: 'Lift', troops: 'Troops', pickupWaypoint: 2, dropWaypoint: 3 });
    const route = await call('dcs_miz_get_route', { sessionId, group: 'Lift' });
    const ids = JSON.stringify(route);
    assert.match(ids, /Embarking/);
    assert.match(ids, /Disembark/);
  } finally { await client.close(); }
});
