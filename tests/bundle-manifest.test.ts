import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-ignore Build tooling is JavaScript, outside the server's TypeScript compilation.
import { buildManifest } from '../scripts/build/claude-bundle-manifest.mjs';

test('bundle manifest validation accepts the generated manifest and rejects malformed server configuration', t => {
  const dir = mkdtempSync(join(tmpdir(), 'dcs-manifest-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'manifest.json');
  const manifest = buildManifest(JSON.parse(readFileSync('package.json', 'utf8')));
  const run = () => spawnSync(process.execPath, ['scripts/verify/validate-claude-manifest.mjs', file], { encoding: 'utf8', windowsHide: true });
  writeFileSync(file, JSON.stringify(manifest));
  const valid = run();
  assert.equal(valid.status, 0, valid.stderr);
  delete manifest.server;
  writeFileSync(file, JSON.stringify(manifest));
  const invalid = run();
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /server/);
});
