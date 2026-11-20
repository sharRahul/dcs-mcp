/** Test the actual npm tarball in isolation; never publishes or edits app settings. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, access, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import AdmZip from 'adm-zip';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const tarball = path.resolve(process.argv[2] ?? path.join(root, `${pkg.name}-${pkg.version}.tgz`));
await access(tarball);
assert.ok(process.env.npm_execpath, 'Run through npm run package:verify');
const temp = await mkdtemp(path.join(tmpdir(), 'dcs npm package '));
function run(command, args, cwd = temp, input) {
  const result = spawnSync(command, args, { cwd, input, encoding: 'utf8', windowsHide: true, timeout: 120000,
    env: { ...process.env, DCS_MISSION_OUTPUT_DIR: temp, DCS_MCP_STATE_DIR: path.join(temp, 'sessions') } });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command}: ${result.stderr || result.stdout}`);
  return result.stdout;
}
try {
  const installDir = path.join(temp, 'tools', 'dcs');
  await mkdir(installDir, { recursive: true });
  await writeFile(path.join(installDir, 'package.json'), '{"private":true}\n');
  run(process.execPath, [process.env.npm_execpath, 'install', '--prefix', installDir, '--ignore-scripts', '--no-audit', '--no-fund', tarball]);
  const installed = path.join(installDir, 'node_modules', pkg.name);
  const manifest = JSON.parse(await readFile(path.join(installed, 'package.json'), 'utf8'));
  const entry = path.join(installed, manifest.bin['dcs-sortie-mcp']);
  assert.equal(run(process.execPath, [entry, '--version']).trim(), pkg.version);
  await access(path.join(installDir, 'node_modules', '.bin', process.platform === 'win32' ? 'dcs-sortie-mcp.cmd' : 'dcs-sortie-mcp'));
  for (const file of ['docs/user/clients.md', 'docs/development/releasing.md', 'data/unit-types.json', 'runtime/dcs/Hooks/dcs-mcp-hook.lua', 'skills/dcs-mission-production/SKILL.md']) await access(path.join(installed, file));
  await assert.rejects(access(path.join(installed, 'sources')), { code: 'ENOENT' });
  assert.deepEqual((await readdir(path.join(installed, 'scripts'))).sort(), ['README.md', 'build', 'data', 'dev', 'verify'].sort());
  const config = path.join(temp, 'claude.json');
  const original = { preferences: { keep: true }, mcpServers: { other: { command: 'keep' } } };
  await writeFile(config, JSON.stringify(original));
  run(process.execPath, [entry, 'install-claude-desktop', '--dry-run', '--config', config]);
  assert.deepEqual(JSON.parse(await readFile(config, 'utf8')), original);
  run(process.execPath, [entry, 'install-claude-desktop', '--local', '--config', config]);
  const merged = JSON.parse(await readFile(config, 'utf8'));
  assert.deepEqual(merged.preferences, original.preferences);
  assert.deepEqual(merged.mcpServers.other, original.mcpServers.other);
  assert.deepEqual(merged.mcpServers.dcs, { command: process.execPath, args: [entry] });
  await mkdir(path.join(temp, 'DCS'));
  run(process.execPath, [entry, 'install-hook', '--telemetry', '--saved-games', path.join(temp, 'DCS')]);
  await access(path.join(temp, 'DCS', 'Scripts', 'Hooks', 'dcs-mcp-hook.lua'));
  await access(path.join(temp, 'DCS', 'Scripts', 'dcs-mcp-telemetry.lua'));
  const starter = JSON.parse(await readFile(path.join(installed, 'examples/clients/raiker-tools.json'), 'utf8'));
  const frameworkRoot = path.join(installed, 'vendor', 'lua');
  const frameworks = JSON.parse(await readFile(path.join(frameworkRoot, 'manifest.json'), 'utf8')).files;
  const { resolveFrameworkPath } = await import(pathToFileURL(path.join(installed, 'dist/miz/frameworks.js')).href);
  const frameworkPaths = {};
  for (const framework of frameworks) {
    const source = await readFile(path.join(frameworkRoot, framework.file));
    assert.equal(source.length, framework.bytes);
    assert.equal(createHash('sha256').update(source).digest('hex'), framework.sha256);
    await access(path.join(frameworkRoot, framework.licenseFile));
    frameworkPaths[framework.framework] = path.join(frameworkRoot, framework.file);
    assert.equal(await resolveFrameworkPath(framework.framework, undefined, []), frameworkPaths[framework.framework]);
  }
  await access(path.join(installed, 'NOTICE'));
  for (const limited of [false, true]) {
    const client = new Client({ name: 'npm-artifact-check', version: '1' });
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [entry, ...(limited ? ['--tools', starter.join(',')] : [])], cwd: temp,
      env: { ...process.env, DCS_MISSION_OUTPUT_DIR: temp, DCS_MCP_STATE_DIR: 'off' }, stderr: 'ignore' }));
    try {
      const listed = await client.listTools();
      if (limited) {
        assert.deepEqual(listed.tools.map(t => t.name).sort(), [...starter].sort());
        assert.ok(Buffer.byteLength(JSON.stringify(listed)) < 180000, 'Starter catalogue exceeds Raiker budget');
      }
      const call = async (name, args) => {
        const r = await client.callTool({ name, arguments: args });
        assert.ok(!r.isError, `${name}: ${JSON.stringify(r.content)}`);
        return r.structuredContent;
      };
      const { sessionId } = await call('dcs_miz_new', { theatre: 'Caucasus' });
      await call('dcs_miz_add_aircraft_group', { sessionId, side: 'blue', country: 'USA', name: 'Package Test', type: 'F-16C_50', count: 1, x: -280000, y: 680000 });
      if (!limited) {
        const loaded = await call('dcs_miz_load_scripts', { sessionId, frameworks: ['skynet', 'moose', 'splash'], frameworkPaths });
        assert.equal(loaded.loaded.length, 4);
      }
      const report = await call('dcs_miz_validate', { sessionId });
      assert.equal(report.ok, true);
      const outPath = path.join(temp, limited ? 'starter.miz' : 'full.miz');
      assert.equal((await call('dcs_miz_save_as', { sessionId, outPath })).saved, true);
      const reopened = await call('dcs_miz_open', { path: outPath });
      assert.equal(reopened.groupCount, 1);
      if (!limited) {
        const zip = new AdmZip(outPath);
        for (const framework of frameworks) {
          const embedded = zip.readFile('l10n/DEFAULT/' + framework.file);
          assert.ok(embedded, `Missing embedded framework ${framework.file}`);
          assert.equal(createHash('sha256').update(embedded).digest('hex'), framework.sha256);
        }
      }
      console.log(`PASS: installed npm package, ${listed.tools.length} ${limited ? 'starter' : 'full'} tools; mission saved and reopened.`);
    } finally { await client.close(); }
  }
  const python = process.env.PYTHON || 'python';
  if (spawnSync(python, ['--version'], { windowsHide: true }).status === 0) {
    const launcher = path.join(installed, 'examples/clients/raiker-launcher.py');
    const batch = operation => [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'raiker-style-check', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, ...operation },
    ].map(r => JSON.stringify(r)).join('\n') + '\n';
    const exchange = operation => {
      const stdout = run(python, ['-B', launcher], temp, batch(operation));
      assert.ok(Buffer.byteLength(stdout) < 200000);
      const replies = stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
      assert.equal(replies.find(r => r.id === 1)?.result?.protocolVersion, '2025-06-18');
      const result = replies.find(r => r.id === 2);
      assert.ok(result && !result.error && !result.result.isError, JSON.stringify(result));
      return result.result;
    };
    assert.equal(exchange({ method: 'tools/list', params: {} }).tools.length, starter.length);
    const created = exchange({ method: 'tools/call', params: { name: 'dcs_miz_new', arguments: { theatre: 'Caucasus' } } });
    const sessionId = created.structuredContent.sessionId;
    const saved = exchange({ method: 'tools/call', params: { name: 'dcs_miz_save_as', arguments: { sessionId, outPath: path.join(temp, 'raiker.miz') } } });
    assert.equal(saved.structuredContent.saved, true);
    console.log('PASS: Raiker-style batched launcher, shared protocol revision, bounded catalogue and cross-process session restore.');
  } else console.log('SKIP: Raiker launcher requires Python; full and starter SDK checks passed.');
  console.log('PASS: bin, packaged resources, isolated Claude config merge and hook installation. Nothing published.');
} finally { await rm(temp, { recursive: true, force: true }); }
