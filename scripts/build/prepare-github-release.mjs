/** Manual GitHub-only release: require green checks on an exact main commit, then create a draft. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';

export function assertReleaseInputs({ version, ref, sha, versions }) {
  assert.match(version ?? '', /^\d+\.\d+\.\d+$/, 'Release version must be a stable semantic version');
  assert.equal(ref, 'refs/heads/main', 'Release must be dispatched from main');
  assert.match(sha ?? '', /^[a-f0-9]{40}$/, 'Release requires an exact source commit');
  assert.ok(versions.length >= 3 && versions.every(v => v === version), 'Package, lockfile and MCP metadata versions must match');
}

export function selectSuccessfulRun(runs, sha) {
  const run = runs.find(r => r.headSha === sha && r.headBranch === 'main' && r.event === 'push' && r.status === 'completed' && r.conclusion === 'success');
  assert.ok(run, `Missing successful main push workflow for ${sha}`);
  return run;
}

async function main() {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Use the manual Prepare GitHub release workflow');
  const version = process.env.RELEASE_VERSION;
  const sha = process.env.GITHUB_SHA;
  const repo = process.env.GITHUB_REPOSITORY;
  assert.match(repo ?? '', /^[\w.-]+\/[\w.-]+$/);
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
  const metadata = JSON.parse(readFileSync('server.json', 'utf8'));
  assertReleaseInputs({ version, sha, ref: process.env.GITHUB_REF, versions: [pkg.version, lock.version, metadata.version] });
  const tag = `v${version}`;
  const temp = mkdtempSync(path.join(process.env.RUNNER_TEMP || tmpdir(), 'dcs-release-'));
  const out = path.join(temp, 'assets');
  mkdirSync(out);
  function gh(args, json = true) {
    const result = execFileSync('gh', args, { encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    return json ? JSON.parse(result) : result;
  }
  function post(endpoint, value) {
    const file = path.join(temp, 'request.json');
    writeFileSync(file, JSON.stringify(value));
    return gh(['api', endpoint, '--method', 'POST', '--input', file]);
  }
  assert.equal(gh(['api', `repos/${repo}/commits/main`]).sha, sha, 'main moved; run acceptance on the new commit first');
  const refs = gh(['api', `repos/${repo}/git/matching-refs/tags/${tag}`]);
  assert.ok(!refs.some(r => r.ref === `refs/tags/${tag}`), 'Tag already exists; never replace a release tag');
  const runs = {};
  for (const [key, workflow] of [['ci', 'ci.yml'], ['packages', 'packages.yml']]) {
    const list = gh(['run', 'list', '--repo', repo, '--workflow', workflow, '--commit', sha, '--limit', '20', '--json', 'databaseId,headSha,headBranch,event,status,conclusion,url']);
    runs[key] = selectSuccessfulRun(list, sha);
    const jobResponse = gh(['api', `repos/${repo}/actions/runs/${runs[key].databaseId}/jobs?per_page=100`]);
    const jobs = jobResponse.jobs;
    assert.equal(jobs.length, jobResponse.total_count, 'Job list is incomplete');
    assert.ok(jobs.length && jobs.every(j => j.conclusion === 'success'), 'All acceptance jobs must succeed');
    for (const job of jobs) {
      const checkUrl = new URL(job.check_run_url);
      assert.equal(checkUrl.origin, 'https://api.github.com');
      assert.ok(checkUrl.pathname.startsWith(`/repos/${repo}/check-runs/`), 'Unexpected check-run URL');
      const notes = gh(['api', `${checkUrl.pathname}/annotations?per_page=100`, '--paginate', '--slurp']).flat();
      assert.ok(!notes.some(n => ['warning', 'failure'].includes(n.annotation_level)), `Unresolved annotations in ${job.name}`);
    }
  }
  const artifacts = gh(['api', `repos/${repo}/actions/runs/${runs.packages.databaseId}/artifacts?per_page=100`]).artifacts;
  for (const name of [`dcs-others-${version}`, `dcs-claude-desktop-${version}`, `dcs-chatgpt-plugin-${version}`]) {
    const artifact = artifacts.find(a => a.name === name && !a.expired);
    assert.ok(artifact && artifact.workflow_run?.head_sha === sha, `Missing matching artifact ${name}`);
    gh(['run', 'download', String(runs.packages.databaseId), '--repo', repo, '--name', name, '--dir', path.join(temp, name)], false);
  }
  const others = path.join(temp, `dcs-others-${version}`);
  assert.deepEqual(readdirSync(others), [`dcs-sortie-mcp-${version}.tgz`]);
  const outer = new AdmZip();
  outer.addLocalFolder(others);
  outer.writeZip(path.join(out, `dcs-others-${version}.zip`));
  const claude = path.join(temp, `dcs-claude-desktop-${version}`);
  assert.deepEqual(readdirSync(claude), [`dcs-mcp-${version}.mcpb`]);
  copyFileSync(path.join(claude, `dcs-mcp-${version}.mcpb`), path.join(out, `dcs-claude-desktop-${version}.mcpb`));
  const plugin = path.join(temp, `dcs-chatgpt-plugin-${version}`);
  assert.equal(JSON.parse(readFileSync(path.join(plugin, 'plugin.json'), 'utf8')).version, version);
  const pluginZip = new AdmZip();
  pluginZip.addLocalFolder(plugin);
  pluginZip.writeZip(path.join(out, `dcs-chatgpt-plugin-${version}.zip`));
  const audit = JSON.parse(execFileSync(process.execPath, [process.env.npm_execpath || '/usr/local/lib/node_modules/npm/bin/npm-cli.js', 'audit', '--json'], { encoding: 'utf8' }));
  assert.equal(audit.metadata.vulnerabilities.total, 0, 'Dependency audit must be clean at release preparation');
  const evidence = { version, tag, sourceCommit: sha, workflows: runs, dependencyAudit: audit.metadata.vulnerabilities,
    distribution: 'GitHub Releases only; no npm registry publication',
    securityAcceptance: `https://github.com/${repo}/blob/${sha}/docs/development/security-acceptance.md`,
    limits: ['Offline and mocked acceptance; not universal in-flight DCS certification', 'Client app/account installation eligibility requires the user app', 'Local stdio server has the invoking user filesystem permissions'] };
  writeFileSync(path.join(out, 'release-acceptance.json'), JSON.stringify(evidence, null, 2) + '\n');
  const names = readdirSync(out).sort();
  writeFileSync(path.join(out, 'SHA256SUMS.txt'), names.map(name => `${createHash('sha256').update(readFileSync(path.join(out, name))).digest('hex')}  ${name}`).join('\n') + '\n');
  const notes = `# DCS Sortie MCP ${tag}\n\nCreate, inspect and edit DCS World missions through a local MCP connection. An independent open-source project for DCS World. Not affiliated with or endorsed by Eagle Dynamics.\n\n## Downloads\n\n- **Claude Desktop:** open dcs-claude-desktop-${version}.mcpb.\n- **ChatGPT:** extract dcs-chatgpt-plugin-${version}.zip into plugins/dcs-chatgpt in a repository clone, then install through the local repository marketplace. Desktop plugin availability depends on your app/account.\n- **Codex and Others:** extract dcs-others-${version}.zip and install the enclosed dcs-sortie-mcp-${version}.tgz with npm install --ignore-scripts <path-to-file>. Node.js 20+ required; no npm account is needed.\n\n[Setup guide](https://github.com/${repo}/blob/${tag}/docs/user/clients.md). Distribution is GitHub-only; nothing is published to the npm registry.\n\n## Acceptance\n\n- Exact source commit: ${sha}\n- [CI](${runs.ci.url}): passed (Windows Node 20/22/24, Lua 5.1 checks, pinned data regeneration).\n- [Package checks](${runs.packages.url}): passed (isolated npm, Claude Desktop and ChatGPT mission workflows).\n- Dependency audit: zero reported vulnerabilities, including build dependencies.\n- [Security acceptance](https://github.com/${repo}/blob/${tag}/docs/development/security-acceptance.md); third-party framework licences and source hashes retained.\n- See SHA256SUMS.txt and release-acceptance.json for asset integrity and provenance. Checksums are integrity records, not a signing or SLSA attestation.\n\n## Limits\n\nOffline validation and mocked runtime tests do not certify every generated mission in DCS. Fly-test your mission and required modules. The live bridge is loopback-only and optional; raw execution is disabled by default. Local MCP tools run with your user permissions. Client screens and account eligibility remain client-side checks.\n`;
  const notesFile = path.join(temp, 'release-notes.md');
  writeFileSync(notesFile, notes);
  // Mutation begins only after all gates and assets are ready. Tags are never moved.
  const tagObject = post(`repos/${repo}/git/tags`, { tag, message: `DCS Sortie MCP ${tag}: accepted commit ${sha}`, object: sha, type: 'commit' });
  post(`repos/${repo}/git/refs`, { ref: `refs/tags/${tag}`, sha: tagObject.sha });
  const allAssets = readdirSync(out).sort().map(name => path.join(out, name));
  console.log(gh(['release', 'create', tag, '--repo', repo, '--verify-tag', '--draft', '--title', `DCS Sortie MCP ${tag}`, '--notes-file', notesFile, ...allAssets], false));
  console.log('Draft prepared. Inspect/download and verify every asset before publishing separately.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
