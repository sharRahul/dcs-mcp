import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
// @ts-ignore Build tooling is JavaScript outside server compilation.
import { stagePackage } from '../scripts/build/stage-package.mjs';

test('package staging excludes ignored local files under an included documentation directory', { skip: !process.env.npm_execpath }, async t => {
  const stage = await mkdtemp(path.join(tmpdir(), 'dcs-stage-test-'));
  const sentinel = path.join('docs/reviews', `local-release-sentinel-${randomUUID()}.log`);
  t.after(async () => { await rm(sentinel, { force: true }); await rm(stage, { recursive: true, force: true }); });
  await writeFile(sentinel, 'local content must never ship');
  const staged = await stagePackage(process.cwd(), stage, process.env.npm_execpath);
  assert.ok(staged.includes('README.md'));
  assert.ok(!staged.includes(sentinel.replaceAll('\\', '/')));
  await assert.rejects(access(path.join(stage, sentinel)), { code: 'ENOENT' });
  await access(path.join(stage, 'package-lock.json'));
});
