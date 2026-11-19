/**
 * Build a one-click Claude Desktop extension (.mcpb) from this checkout, using
 * the locked dependencies.
 *
 * A .mcpb is a zip holding `manifest.json` at its root plus the server. Claude
 * Desktop supplies Node, so the bundle only has to carry this package, its
 * production dependencies and its data files — nothing is downloaded at install
 * time, which is what makes it work on a machine with no npm.
 */
import AdmZip from 'adm-zip';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildManifest } from './claude-bundle-manifest.mjs';

/**
 * Files the published npm package carries that an extension has no use for.
 * `npx @anthropic-ai/mcpb pack` drops these by default (2609 files against our
 * first unfiltered 4843, 5.0 MB against 6.7 MB); they are pruned here so the
 * staging directory matches what ships.
 */
const PRUNE = /\.d\.ts$|\.d\.ts\.map$|\.js\.map$/;

async function prune(dir) {
  let removed = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) removed += await prune(full);
    else if (PRUNE.test(entry.name)) {
      await rm(full);
      removed += 1;
    }
  }
  return removed;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundleDir = path.join(root, 'plugins', 'dcs-claude-desktop');
const server = path.join(bundleDir, 'server');
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run through npm run bundle:build so the npm CLI path is available.');
function npm(args, cwd) {
  const result = spawnSync(process.execPath, [npmCli, ...args], { cwd, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm ${args.join(' ')} failed (${result.status})`);
}

npm(['run', 'clean'], root);
npm(['run', 'build'], root);

// The whole staging directory is generated: replace it rather than merging into
// a stale copy, or a file dropped from package.json#files would ship for ever.
await rm(bundleDir, { recursive: true, force: true });
await mkdir(server, { recursive: true });

const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
for (const entry of [...pkg.files, 'package.json', 'package-lock.json']) {
  await cp(path.join(root, entry), path.join(server, entry), { recursive: true });
}
npm(['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], server);
const pruned = await prune(server);

const manifest = buildManifest(pkg);
await writeFile(path.join(bundleDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
await cp(path.join(root, 'LICENSE'), path.join(bundleDir, 'LICENSE'));

const out = path.join(root, `dcs-mcp-${pkg.version}.mcpb`);
await rm(out, { force: true });
const zip = new AdmZip();
zip.addLocalFolder(bundleDir);
zip.writeZip(out);

const entries = zip.getEntries().length;
console.log(`Built ${out} (${entries} entries, ${pruned} declarations and sourcemaps pruned, version ${pkg.version}).`);
console.log('Run npm run bundle:validate and npm run bundle:verify before installing it in Claude Desktop.');
