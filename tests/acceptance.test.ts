import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, link, readdir } from 'node:fs/promises';
import os from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { generateAcceptancePackage } from '../src/acceptance/package.js';
import { collectAcceptance } from '../src/acceptance/collect.js';
import { atomicWrite } from '../src/security/files.js';
import { assertArchiveWithinLimits, assertSafeEntryName } from '../src/security/archive-policy.js';
import { assertInputBudget } from '../src/security/input-budget.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('ten generated acceptance missions validate; evidence stays pending until correlated and attested', async () => {
 const temp = await mkdtemp(path.join(os.tmpdir(), 'dcs-acceptance-'));
 try {
  const kit = path.join(temp, 'kit'); const result = await generateAcceptancePackage(kit);
  assert.equal(result.scenarios, 10); assert.equal(result.liveStatus, 'pending');
  await assert.rejects(generateAcceptancePackage(kit), /EEXIST/);
  const manifest = JSON.parse(await readFile(path.join(kit, 'manifest.json'), 'utf8'));
  assert.ok(manifest.scenarios.every((s: any) => s.offline.ok && s.liveStatus === 'pending' && s.expectedUnits.length > 0));
  const scenario = manifest.scenarios[0], logPath = path.join(temp, 'dcs.log');
  await writeFile(logPath, 'unrelated old Lua Error\n');
  let report = await collectAcceptance({ packageDir: kit, scenarioId: scenario.id, logPath, outputDir: path.join(temp, 'pending') });
  assert.equal(report.status, 'pending'); assert.equal(report.identityMatched, false);
  await writeFile(logPath, `old Lua Error\n[DCSMCP] ACCEPTANCE runId=${manifest.runId} scenarioId=${scenario.id}\n[DCSMCP] ACCEPTANCE_OBJECTIVE runId=${manifest.runId} scenarioId=${scenario.id} outcome=victory\n`);
  const sourceLog = await readFile(logPath);
  const operator = { runId: manifest.runId, scenarioId: scenario.id, expectedOutcome: 'victory', notes: 'Test operator fixture only; not a real DCS result', checks: scenario.checks.map((c: any) => ({ id: c.id, status: 'pass', notes: 'Synthetic evidence tests collection only', evidence: ['capture.txt'] })) };
  const resultsPath = path.join(temp, 'operator.json'); await writeFile(path.join(temp, 'capture.txt'), 'synthetic evidence'); await writeFile(resultsPath, JSON.stringify(operator));
  report = await collectAcceptance({ packageDir: kit, scenarioId: scenario.id, logPath, resultsPath, outputDir: path.join(temp, 'attested') });
  assert.equal(report.status, 'pass'); assert.match(report.basis, /Operator-attested/); assert.deepEqual(await readFile(logPath), sourceLog);
  operator.checks[0].evidence = ['../escape']; await writeFile(resultsPath, JSON.stringify(operator));
  await assert.rejects(collectAcceptance({ packageDir: kit, scenarioId: scenario.id, logPath, resultsPath, outputDir: path.join(temp, 'unsafe') }), /Unsafe evidence/);
  operator.checks[0].evidence = ['capture.txt']; await writeFile(resultsPath, JSON.stringify(operator));
  await writeFile(logPath, sourceLog.toString() + 'ERROR SCRIPTING: Lua Error: broken mission\n');
  report = await collectAcceptance({ packageDir: kit, scenarioId: scenario.id, logPath, resultsPath, outputDir: path.join(temp, 'failed') }); assert.equal(report.status, 'fail');
 } finally { await rm(temp, { recursive: true, force: true }); }
});
test('atomic writes refuse source aliases and racing overwrite; leave no temporary files', async () => {
 const root = await mkdtemp(path.join(os.tmpdir(), 'dcs-atomic-'));
 try {
  const source = path.join(root, 'source'); await writeFile(source, 'original'); const alias = path.join(root, 'alias'); await link(source, alias);
  await assert.rejects(atomicWrite(alias, 'bad', { sourcePath: source, overwrite: true }), /alias/);
  const out = path.join(root, 'out'); const writes = await Promise.allSettled([atomicWrite(out, 'a'.repeat(10000)), atomicWrite(out, 'b'.repeat(10000))]);
  assert.equal(writes.filter(w => w.status === 'fulfilled').length, 1); assert.ok(['a'.repeat(10000), 'b'.repeat(10000)].includes(await readFile(out, 'utf8')));
  assert.equal(await readFile(source, 'utf8'), 'original'); assert.ok(!(await readdir(root)).some(f => f.endsWith('.tmp')));
 } finally { await rm(root, { recursive: true, force: true }); }
});
test('archive metadata, Windows aliases and bounded input reject malformed requests', () => {
 for (const name of ['../mission', 'a\\..\\mission', 'a:stream', 'CON.txt', 'a/./mission', 'a//mission', 'a./mission']) assert.throws(() => assertSafeEntryName(name));
 for (const sizes of [{ compressedSize: 10, uncompressedSize: 0 }, { compressedSize: -1, uncompressedSize: 2 }, { compressedSize: 1, uncompressedSize: NaN }]) assert.throws(() => assertArchiveWithinLimits([{ name: 'mission', ...sizes }]));
 assert.throws(() => assertArchiveWithinLimits([{ name: 'Mission', compressedSize: 1, uncompressedSize: 1 }, { name: 'mission', compressedSize: 1, uncompressedSize: 1 }]), /Duplicate/);
 assert.throws(() => assertInputBudget({ many: new Array(65537).fill(0) }));
 let deep: any = {}; for (let n = 0; n < 70; n++) deep = { a: deep }; assert.throws(() => assertInputBudget(deep));
});
test('patched SDK and Zod 4 discover acceptance tools, validate defaults and recover after invalid calls', async () => {
 const client = new Client({ name: 'acceptance-contract', version: '1' });
 const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'src/index.ts'], env: { ...process.env, DCS_MCP_STATE_DIR: 'off' } as Record<string,string>, stderr: 'ignore' });
 await client.connect(transport);
 try {
  const tools = (await client.listTools()).tools;
  const fixture = JSON.parse(await readFile(new URL('./fixtures/mcp-schema-sha256.json', import.meta.url), 'utf8'));
  function sorted(v: any): any { if (Array.isArray(v)) return v.map(sorted); if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, sorted(v[k])])); return v; }
  assert.equal(tools.length, Object.keys(fixture).length);
  for (const t of tools) assert.equal(createHash('sha256').update(JSON.stringify(sorted({ input: t.inputSchema, output: t.outputSchema ?? null }))).digest('hex'), fixture[t.name], `Public schema changed: ${t.name}`);
  for (const name of ['dcs_runtime_inspect', 'dcs_acceptance_check', 'dcs_acceptance_generate', 'dcs_acceptance_job', 'dcs_acceptance_collect', 'dcs_tool_catalogue']) assert.ok(tools.some(t => t.name === name));
  const bad = await client.callTool({ name: 'dcs_tool_catalogue', arguments: { limit: 51 } }); assert.equal(bad.isError, true);
  const good = await client.callTool({ name: 'dcs_tool_catalogue', arguments: { query: 'acceptance', limit: 2 } }); assert.equal(good.isError, undefined); assert.equal((good.structuredContent as any).tools.length, 2); assert.ok((good.structuredContent as any).nextOffset);
 } finally { await client.close(); }
});

test('corrupt mission archives fail before editing or replacing their source', async () => {
 const root = await mkdtemp(path.join(os.tmpdir(), 'dcs-corrupt-'));
 try {
  const file = path.join(root, 'broken.miz'); const bytes = Buffer.from('PK\x03\x04truncated archive'); await writeFile(file, bytes);
  const { checkMission } = await import('../src/acceptance/checks.js'); await assert.rejects(checkMission(file));
  assert.deepEqual(await readFile(file), bytes); assert.deepEqual(await readdir(root), ['broken.miz']);
 } finally { await rm(root, { recursive: true, force: true }); }
});
