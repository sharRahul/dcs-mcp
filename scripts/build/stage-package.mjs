/** Stage versioned package sources plus a fresh dist; never copy ignored local directory contents. */
import { execFileSync } from 'node:child_process';
import { mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';

export async function stagePackage(root, destination, npmCli) {
  const tracked = new Set(execFileSync('git', ['ls-files', '--cached', '-z'], { cwd: root, encoding: 'utf8', windowsHide: true }).split('\0').filter(Boolean));
  const [pack] = JSON.parse(execFileSync(process.execPath, [npmCli, 'pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024,
  }));
  const allowed = pack.files.map(f => f.path).filter(file => tracked.has(file) || file.startsWith('dist/'));
  // npm excludes its lockfile from the tarball; desktop bundles still need it for npm ci.
  if (!tracked.has('package-lock.json')) throw new Error('Package lockfile must be versioned');
  for (const file of new Set([...allowed, 'package-lock.json'])) {
    if (path.isAbsolute(file) || file.split(/[\\/]/).includes('..')) throw new Error('Unsafe packlist path');
    const target = path.join(destination, file);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(root, file), target);
  }
  return allowed;
}
