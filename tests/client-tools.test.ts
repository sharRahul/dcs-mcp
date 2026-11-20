import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('a limited client discovers and can call only its selected DCS tools', async () => {
  const client = new Client({ name: 'limited-client-test', version: '1' });
  const names = ['dcs_miz_new', 'dcs_miz_get_summary', 'dcs_miz_validate'];
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: ['--import', 'tsx', 'src/index.ts', '--tools', names.join(',')],
    env: { ...process.env, DCS_MCP_STATE_DIR: 'off' } as Record<string, string>, stderr: 'ignore' }));
  try {
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map(t => t.name).sort(), [...names].sort());
    const created = await client.callTool({ name: 'dcs_miz_new', arguments: { theatre: 'Caucasus' } });
    assert.ok(!created.isError);
    const sessionId = (created.structuredContent as { sessionId: string }).sessionId;
    const validated = await client.callTool({ name: 'dcs_miz_validate', arguments: { sessionId } });
    assert.ok(!validated.isError);
    const excluded = await client.callTool({ name: 'dcs_miz_save_as', arguments: { sessionId, outPath: 'never-written.miz' } });
    assert.equal(excluded.isError, true);
  } finally { await client.close(); }
});

test('misspelled or empty selections fail before starting the server', () => {
  for (const args of [['--tools', 'dcs_missing_tool'], ['--tools'], ['--tools', ',']]) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/index.ts', ...args],
      { encoding: 'utf8', timeout: 5000, windowsHide: true });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /tools|tool/i);
  }
});
