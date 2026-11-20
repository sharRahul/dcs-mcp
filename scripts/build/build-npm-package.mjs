import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stagePackage } from './stage-package.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Use npm run package:build');
const stage = await mkdtemp(path.join(tmpdir(), 'dcs-pack-'));
try {
  await stagePackage(root, stage, npmCli);
  const result = execFileSync(process.execPath, [npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', root], { cwd: stage, encoding: 'utf8', windowsHide: true });
  console.log(result);
} finally { await rm(stage, { recursive: true, force: true }); }
