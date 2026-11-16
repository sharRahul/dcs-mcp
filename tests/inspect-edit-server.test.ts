/** Real stdio MCP contract test: inspection/editing, airbase ownership and site-template import. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('inspect/edit tools, airbase ownership and imported site templates work over stdio', { timeout: 60000 }, async () => {
  const templates = mkdtempSync(join(tmpdir(), 'dcs-tpl-')), out = mkdtempSync(join(tmpdir(), 'dcs-ie-'));
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'src/index.ts'],
    env: { ...process.env, DCS_MCP_STATE_DIR: 'off', DCS_MCP_TEMPLATE_DIR: templates } as Record<string, string>, stderr: 'ignore' });
  const client = new Client({ name: 'inspect-edit-test', version: '0' });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    assert.ok(!r.isError, `${name}: ${JSON.stringify(r.content)}`); return r.structuredContent as Record<string, any>;
  };
  const fails = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args }); assert.equal(r.isError, true, JSON.stringify(r));
  };
  try {
    // A source mission with a hand-laid-out site: radar ahead, launchers to each side.
    const src = (await call('dcs_miz_new', { theatre: 'Caucasus' })).sessionId;
    await call('dcs_miz_add_ground_group', { sessionId: src, side: 'red', country: 'Russia', name: 'Site', category: 'vehicle',
      composition: [{ type: 'Kub 1S91 str', count: 1 }, { type: 'Kub 2P25 ln', count: 2 }], x: 1000, y: 1000, heading: 0 });
    await call('dcs_miz_move_unit', { sessionId: src, unit: 'Site-2', x: 1000, y: 1100 });
    await call('dcs_miz_move_unit', { sessionId: src, unit: 'Site-3', x: 1000, y: 900 });
    const file = join(out, 'source.miz');
    await call('dcs_miz_save_as', { sessionId: src, outPath: file });
    const imp = await call('dcs_import_site_template', { file, group: 'Site', id: 'My-Kub' });
    assert.deepEqual(imp.composition, [{ type: 'Kub 1S91 str', count: 1 }, { type: 'Kub 2P25 ln', count: 2 }]);
    assert.equal(readdirSync(templates).length, 1);
    await fails('dcs_import_site_template', { file, group: 'Site', id: 'SA-6' }); // built-in id
    await fails('dcs_import_site_template', { file, group: 'Site', id: 'My-Kub' }); // exists
    const listed = await call('dcs_list_site_templates', { response_format: 'json' });
    assert.ok(listed.templates.some((t: any) => t.id === 'My-Kub' && t.provenance === 'imported'));
    // Place it facing east elsewhere: offsets rotate with the heading.
    const dst = (await call('dcs_miz_new', { theatre: 'Caucasus' })).sessionId;
    await call('dcs_miz_add_ground_group', { sessionId: dst, side: 'red', country: 'Russia', name: 'SAM Kub', category: 'vehicle', site: 'My-Kub', x: 0, y: 0, heading: 90 });
    const g = await call('dcs_miz_get_group', { sessionId: dst, group: 'SAM Kub' });
    const pos = g.units.map((u: any) => [Math.round(u.x) + 0, Math.round(u.y) + 0]);
    assert.deepEqual(pos, [[0, 0], [-100, 0], [100, 0]]); // +100 east of lead at heading 0 -> 100 south at heading 90
    // Route inspection and task editing over the wire.
    await call('dcs_miz_add_waypoint_action', { sessionId: dst, group: 'SAM Kub', waypointIndex: 1, action: 'option:alarmState', value: 'GREEN' });
    let route = await call('dcs_miz_get_route', { sessionId: dst, group: 'SAM Kub' });
    assert.equal(route.points[0].tasks[0].key, 'option:alarmState');
    await call('dcs_miz_modify_waypoint_task', { sessionId: dst, group: 'SAM Kub', waypointIndex: 1, taskNumber: 1, value: 'RED' });
    await call('dcs_miz_set_waypoint_task_enabled', { sessionId: dst, group: 'SAM Kub', waypointIndex: 1, taskNumber: 1, enabled: false });
    route = await call('dcs_miz_get_route', { sessionId: dst, group: 'SAM Kub' });
    assert.deepEqual([route.points[0].tasks[0].params.value, route.points[0].tasks[0].enabled], [2, false]);
    await call('dcs_miz_remove_waypoint_task', { sessionId: dst, group: 'SAM Kub', waypointIndex: 1, taskNumber: 1 });
    await call('dcs_miz_modify_unit', { sessionId: dst, unit: 'SAM Kub-1', change: { headingDegrees: 45 } });
    assert.equal((await call('dcs_miz_get_unit', { sessionId: dst, unit: 'SAM Kub-1' })).data.headingDegrees, 45);
    await call('dcs_miz_add_quad_zone', { sessionId: dst, name: 'Q', vertices: [{ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 0 }] });
    await call('dcs_miz_set_airbase_coalition', { sessionId: dst, airfield: 'Batumi', coalition: 'RED' });
    const wh = await call('dcs_miz_list_warehouses', { sessionId: dst });
    assert.equal(wh.warehouses.find((w: any) => w.kind === 'airports' && w.id === 22).data.coalition, 'RED');
    assert.equal((await call('dcs_miz_list_goals', { sessionId: dst })).count, 0);
    assert.ok(['scanned', 'unknown'].includes((await call('dcs_list_loadouts', { type: 'F-16C_50' })).status));
    await call('dcs_remove_site_template', { id: 'My-Kub' });
    await fails('dcs_miz_add_ground_group', { sessionId: dst, side: 'red', country: 'Russia', name: 'SAM 2', category: 'vehicle', site: 'My-Kub', x: 0, y: 0 });
  } finally { await client.close(); }
});
