/** Build a self-contained local plugin from this checkout, using the locked dependencies. */
import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const plugin = path.join(root, 'plugins', 'dcs-chatgpt');
const server = path.join(plugin, 'server');
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run through npm run plugin:build so the npm CLI path is available.');
function npm(args, cwd) {
  const result = spawnSync(process.execPath, [npmCli, ...args], { cwd, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm ${args.join(' ')} failed (${result.status})`);
}
npm(['run', 'clean'], root);
npm(['run', 'build'], root);
// Only generated, fixed directories inside this plugin are replaced.
await rm(server, { recursive: true, force: true });
await rm(path.join(plugin, 'skills'), { recursive: true, force: true });
await mkdir(server, { recursive: true });
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
for (const entry of [...pkg.files, 'package.json', 'package-lock.json']) {
  await cp(path.join(root, entry), path.join(server, entry), { recursive: true });
}
npm(['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], server);
await cp(path.join(root, 'skills'), path.join(plugin, 'skills'), { recursive: true });
const manifestPath = path.join(plugin, 'plugin.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
manifest.version = pkg.version;
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`Built ${plugin} (${pkg.version}). Run npm run plugin:verify before installing.`);
