import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, access, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { missionOutputDirectory } from '../src/mission-output.js';
import { createProduction } from '../src/production/workflow.js';

test('mission folder defaults to the current user profile and requires an absolute setting', () => {
  const home = path.resolve('test-user');
  assert.equal(missionOutputDirectory({}, home), path.join(home, 'Saved Games', 'DCS', 'Missions', 'My Mission'));
  assert.equal(missionOutputDirectory({ DCS_MISSION_OUTPUT_DIR: '  ' }, home), missionOutputDirectory({}, home));
  assert.throws(() => missionOutputDirectory({ DCS_MISSION_OUTPUT_DIR: 'relative' }, home), /absolute/);
});

test('MCP saves only in the configured mission folder and preserves existing/source missions', async () => {
  // realpath: CI's temp dir is an 8.3 short path (RUNNER~1); the server returns long paths.
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'mission-output-')));
  const root = path.join(base, 'profile', 'Missions', 'My Mission');
  const client = new Client({ name: 'mission-output-test', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'src/index.ts'],
    env: { ...process.env, DCS_MCP_STATE_DIR: 'off', DCS_MISSION_OUTPUT_DIR: root } as Record<string, string>, stderr: 'ignore' }));
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    assert.ok(!r.isError, JSON.stringify(r.content));
    return r.structuredContent as Record<string, any>;
  };
  try {
    const { sessionId } = await call('dcs_miz_new', { theatre: 'Caucasus' });
    const requested = path.join(base, 'elsewhere.miz');
    const saved = await call('dcs_miz_save_as', { sessionId, outPath: requested });
    assert.equal(saved.outPath, path.join(root, 'elsewhere.miz'));
    await assert.rejects(access(requested), { code: 'ENOENT' });
    const bytes = await readFile(saved.outPath);
    const reopened = await call('dcs_miz_open', { path: saved.outPath });
    assert.equal(reopened.theatre, 'Caucasus');
    for (const args of [{ sessionId, outPath: requested }, { sessionId: reopened.sessionId, outPath: requested, overwrite: true }]) {
      assert.equal((await client.callTool({ name: 'dcs_miz_save_as', arguments: args })).isError, true);
    }
    assert.deepEqual(await readFile(saved.outPath), bytes);
    const windowsName = await call('dcs_miz_save_as', { sessionId, outPath: 'C:\\elsewhere\\second.miz' });
    assert.equal(windowsName.outPath, path.join(root, 'second.miz'));
    const created = await call('dcs_production_create', { outputDir: path.join(base, 'elsewhere-project'),
      plan: { name: 'Folder policy', theatre: 'Caucasus', objective: 'Verify output location',
        checks: [{ id: 'present', description: 'Unit present', criterion: { kind: 'group_exists', group: 'Player' } }] } });
    assert.equal(path.relative(created.projectDir, path.join(root, 'elsewhere-project')), '');
    const external = path.join(base, 'external-project');
    await createProduction(external, { name: 'External', theatre: 'Caucasus', objective: 'Unchanged external project',
      checks: [{ id: 'present', description: 'Unit present', criterion: { kind: 'group_exists', group: 'Player' } }] });
    const refused = await client.callTool({ name: 'dcs_production_revise', arguments: {
      projectDir: external, sessionId, expectedRevision: 0, notes: 'Must not write outside mission folder' } });
    assert.equal(refused.isError, true);
    assert.match(JSON.stringify(refused.content), /Mission projects must be inside/);
    for (const outPath of ['NUL.miz', 'bad:name.miz', 'wrong.txt']) {
      assert.equal((await client.callTool({ name: 'dcs_miz_save_as', arguments: { sessionId, outPath } })).isError, true);
    }
    const job = await call('dcs_acceptance_generate', { outputDir: path.join(base, 'acceptance-kit') });
    let status = job;
    for (let i = 0; i < 200 && status.status === 'running'; i++) {
      await new Promise(resolve => setTimeout(resolve, 50));
      status = await call('dcs_acceptance_job', { jobId: job.id });
    }
    assert.equal(status.status, 'complete', JSON.stringify(status));
    assert.equal(path.relative(status.result.directory, path.join(root, 'acceptance-kit')), '');
    assert.equal(status.result.offlineStatus, 'pass');
    await assert.rejects(access(path.join(base, 'acceptance-kit')), { code: 'ENOENT' });
  } finally { await client.close(); await rm(base, { recursive: true, force: true }); }
});
