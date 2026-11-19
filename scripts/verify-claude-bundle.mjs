/**
 * Verify the built Claude Desktop extension: unpack the .mcpb somewhere else,
 * check the manifest against the MCPB required-field list, expand the
 * substitutions Claude Desktop expands, launch the server exactly as the
 * manifest says to, and author, validate, save and reopen a mission through it.
 *
 * It deliberately leaves every optional user_config value EMPTY, which is what a
 * user who answers nothing produces: the run proves the server still starts and
 * falls back to its own defaults.
 *
 * It does not install anything in Claude Desktop and does not prove that the app
 * accepted the bundle — only that the bundle's own entry point works standalone.
 */
import AdmZip from 'adm-zip';
import assert from 'node:assert/strict';
import { readdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { MANIFEST_VERSION } from './claude-bundle-manifest.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const explicit = process.argv[2];
const bundle = explicit
  ? path.resolve(explicit)
  : path.join(
      root,
      (await readdir(root)).filter((f) => f.endsWith('.mcpb')).sort().at(-1)
        ?? assert.fail('No .mcpb found in the repository root. Run npm run bundle:build first.')
    );

const temp = await mkdtemp(path.join(tmpdir(), 'dcs mcpb smoke '));
let client;
try {
  new AdmZip(bundle).extractAllTo(temp, true);
  const manifest = JSON.parse(await readFile(path.join(temp, 'manifest.json'), 'utf8'));

  // Required top-level fields, MCPB MANIFEST.md.
  for (const field of ['manifest_version', 'name', 'version', 'description', 'author', 'server']) {
    assert.ok(manifest[field] !== undefined, `manifest.json is missing required field '${field}'`);
  }
  assert.equal(manifest.manifest_version, MANIFEST_VERSION);
  assert.ok(manifest.author.name, 'author.name is required');
  assert.match(manifest.version, /^\d+\.\d+\.\d+/, 'version must be semver');
  assert.equal(manifest.server.type, 'node');
  assert.equal(manifest.server.mcp_config.command, 'node');

  const entryPoint = path.join(temp, manifest.server.entry_point);
  await readFile(entryPoint); // throws if entry_point does not point at a real file
  for (const key of Object.keys(manifest.user_config ?? {})) {
    const config = manifest.user_config[key];
    assert.ok(['string', 'number', 'boolean', 'directory', 'file'].includes(config.type),
      `user_config.${key}.type '${config.type}' is not an MCPB type`);
    assert.equal(config.required ?? false, false,
      `user_config.${key} is required, but the bundle must start with nothing answered`);
  }

  // Exactly the substitutions Claude Desktop performs, with every optional value unanswered.
  const expand = (value) =>
    String(value).replaceAll('${__dirname}', temp).replace(/\$\{user_config\.([A-Za-z0-9_]+)\}/g, (_, key) => {
      const fallback = manifest.user_config?.[key]?.default;
      return fallback === undefined ? '' : String(fallback);
    });
  const env = Object.fromEntries(
    Object.entries(manifest.server.mcp_config.env ?? {}).map(([key, value]) => [key, expand(value)])
  );
  assert.equal(env.DCS_BRIDGE_HOST, '127.0.0.1');
  assert.equal(env.DCS_SAVED_GAMES, '', 'an unanswered directory must expand to nothing, not a literal token');

  client = new Client({ name: 'dcs-mcpb-smoke', version: '1.0.0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath, // what "command": "node" resolves to; Claude Desktop ships its own Node
    args: manifest.server.mcp_config.args.map(expand),
    cwd: temp,
    env: { ...process.env, ...env, DCS_MCP_STATE_DIR: 'off' },
    stderr: 'inherit',
  }));

  const tools = (await client.listTools()).tools;
  for (const name of ['dcs_miz_new', 'dcs_miz_validate', 'dcs_miz_save_as', 'dcs_list_airfields', 'dcs_bridge_status']) {
    assert.ok(tools.some((t) => t.name === name), `Missing ${name}`);
  }
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, `${name}: ${JSON.stringify(result.content)}`);
    assert.ok(result.structuredContent, `${name} missing structuredContent`);
    return result.structuredContent;
  };
  await call('dcs_list_airfields', { theatre: 'Caucasus' });
  const { sessionId } = await call('dcs_miz_new', { theatre: 'Caucasus' });
  await call('dcs_miz_add_aircraft_group', {
    sessionId, side: 'blue', country: 'USA', name: 'Bundle Smoke',
    type: 'F-16C_50', count: 1, x: -280000, y: 680000,
  });
  const validation = await call('dcs_miz_validate', { sessionId });
  assert.equal(validation.ok, true, JSON.stringify(validation));
  const outPath = path.join(temp, 'bundle-smoke.miz');
  assert.equal((await call('dcs_miz_save_as', { sessionId, outPath })).saved, true);
  const reopened = await call('dcs_miz_open', { path: outPath });
  assert.equal(reopened.theatre, 'Caucasus');
  assert.equal(reopened.unitCount, 1);
  await client.readResource({ uri: 'dcs://guide/conventions' });
  console.log(
    `PASS: ${path.basename(bundle)} manifest ${manifest.manifest_version} v${manifest.version}; `
    + `${tools.length} tools discovered; unpacked bundle created, validated, saved and reopened a mission `
    + 'with every user_config field left empty.'
  );
} finally {
  if (client) await client.close();
  await rm(temp, { recursive: true, force: true });
}
