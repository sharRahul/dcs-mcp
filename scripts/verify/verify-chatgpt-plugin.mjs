import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const temp = await mkdtemp(path.join(tmpdir(), 'dcs plugin smoke '));
const plugin = path.join(temp, 'plugin');
let client;
try {
  await cp(path.join(root, 'plugins/dcs-chatgpt'), plugin, { recursive: true });
  const config = JSON.parse(await readFile(path.join(plugin, 'mcp.json'), 'utf8')).mcpServers.dcs;
  assert.equal(config.type, 'stdio');
  assert.equal(config.command, 'node');
  const expand = value => value.replaceAll('${PLUGIN_ROOT}', plugin);
  client = new Client({ name: 'dcs-plugin-smoke', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: config.args.map(expand), cwd: expand(config.cwd),
    env: { ...process.env, ...config.env, DCS_MISSION_OUTPUT_DIR: temp, DCS_MCP_STATE_DIR: 'off' }, stderr: 'inherit' }));
  const tools = (await client.listTools()).tools;
  for (const name of ['dcs_miz_new', 'dcs_miz_validate', 'dcs_miz_save_as', 'dcs_list_airfields']) {
    assert.ok(tools.some(t => t.name === name), `Missing ${name}`);
  }
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, `${name}: ${JSON.stringify(result.content)}`);
    assert.ok(result.structuredContent, `${name} missing structuredContent`);
    return result.structuredContent;
  };
  await call('dcs_list_airfields', { theatre: 'Caucasus' });
  const { sessionId } = await call('dcs_miz_new', { theatre: 'Caucasus' });
  await call('dcs_miz_add_aircraft_group', { sessionId, side: 'blue', country: 'USA', name: 'Plugin Smoke',
    type: 'F-16C_50', count: 1, x: -280000, y: 680000 });
  await call('dcs_miz_add_trigger', { sessionId, type: 'once', conditions: [{ kind: 'time_after', seconds: 5 }],
    actions: [{ kind: 'message', text: 'Plugin smoke test', seconds: 10 }] });
  const validation = await call('dcs_miz_validate', { sessionId });
  assert.equal(validation.ok, true, JSON.stringify(validation));
  const outPath = path.join(temp, 'plugin-smoke.miz');
  const saved = await call('dcs_miz_save_as', { sessionId, outPath });
  assert.equal(saved.saved, true);
  const reopened = await call('dcs_miz_open', { path: outPath });
  assert.equal(reopened.theatre, 'Caucasus');
  assert.equal(reopened.groupCount, 1);
  assert.equal(reopened.unitCount, 1);
  const triggers = await call('dcs_miz_list_triggers', { sessionId: reopened.sessionId });
  assert.equal(triggers.count, 1);
  const revalidated = await call('dcs_miz_validate', { sessionId: reopened.sessionId });
  assert.equal(revalidated.ok, true, JSON.stringify(revalidated));
  await client.readResource({ uri: 'dcs://guide/conventions' });
  await client.readResource({ uri: 'dcs://skills/mission-production/contracts' });
  await call('dcs_miz_get_summary', { sessionId: reopened.sessionId });
  console.log(`PASS: ${tools.length} tools discovered; isolated plugin created, validated, saved and reopened a mission.`);
} finally {
  if (client) await client.close();
  await rm(temp, { recursive: true, force: true });
}
