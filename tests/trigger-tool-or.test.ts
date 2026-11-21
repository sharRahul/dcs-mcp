import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// The compiler supported both, but dcs_miz_add_trigger's schema refused them, so a
// client building a real mission (2026-11-20) had to fake OR with gate flags and show
// a coalition's F10 menu to everyone.
test('dcs_miz_add_trigger accepts OR groups and coalition-only radio items', async () => {
  const client = new Client({ name: 'trigger-or-test', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'src/index.ts'],
    env: { ...process.env, DCS_MCP_STATE_DIR: 'off' } as Record<string, string>, stderr: 'ignore' }));
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    assert.ok(!r.isError, `${name}: ${JSON.stringify(r.content)}`);
    return r.structuredContent as Record<string, any>;
  };
  try {
    const { sessionId } = await call('dcs_miz_new', { theatre: 'Caucasus' });
    await call('dcs_miz_add_trigger', { sessionId, type: 'start', conditions: [],
      actions: [{ kind: 'add_radio_item_for_coalition', coalition: 'blue', text: 'AWACS: Request picture', flag: 601 }] });
    await call('dcs_miz_add_trigger', { sessionId, type: 'once',
      conditions: [{ kind: 'flag_is_true', flag: 1 }, { kind: 'flag_is_true', flag: 2 }, { kind: 'or' }, { kind: 'time_after', seconds: 600 }],
      actions: [{ kind: 'set_flag', flag: 3 }] });
    const conditions = await call('dcs_miz_get_value', { sessionId, path: 'trig.conditions', expand: true });
    const actions = await call('dcs_miz_get_value', { sessionId, path: 'trig.actions', expand: true });
    assert.match(JSON.stringify(conditions), / and .* or /);
    assert.match(JSON.stringify(actions), /a_add_radio_item_for_coalition/);
    const bad = await client.callTool({ name: 'dcs_miz_add_trigger', arguments: { sessionId, type: 'once',
      conditions: [{ kind: 'or' }, { kind: 'time_after', seconds: 1 }], actions: [{ kind: 'set_flag', flag: 4 }] } });
    assert.equal(bad.isError, true, 'an OR with nothing on one side must be refused');
  } finally { await client.close(); }
});
