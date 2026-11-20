import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore Release tooling is JavaScript outside server compilation.
import { assertReleaseInputs, selectSuccessfulRun } from '../scripts/build/prepare-github-release.mjs';

test('release gates refuse wrong refs, versions and missing exact-commit acceptance', () => {
  const sha = 'a'.repeat(40);
  const accepted = { version: '0.6.4', ref: 'refs/heads/main', sha, versions: ['0.6.4', '0.6.4', '0.6.4'] };
  assert.doesNotThrow(() => assertReleaseInputs(accepted));
  for (const change of [{ ref: 'refs/heads/other' }, { version: '0.6.4;echo' }, { sha: 'main' }, { versions: ['0.6.4', '0.6.3', '0.6.4'] }]) {
    assert.throws(() => assertReleaseInputs({ ...accepted, ...change }));
  }
  const run = { headSha: sha, headBranch: 'main', event: 'push', status: 'completed', conclusion: 'success' };
  assert.equal(selectSuccessfulRun([run], sha), run);
  for (const change of [{ headSha: 'b'.repeat(40) }, { headBranch: 'other' }, { event: 'pull_request' }, { status: 'in_progress' }, { conclusion: 'failure' }]) {
    assert.throws(() => selectSuccessfulRun([{ ...run, ...change }], sha));
  }
});
