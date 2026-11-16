/** Same-directory atomic publication; never follow a destination symlink or overwrite the source. */
import { randomUUID } from 'node:crypto';
import { lstat, stat, realpath, open, rename, link, unlink } from 'node:fs/promises';
import path from 'node:path';
export async function atomicWrite(target: string, bytes: Buffer | string, options: { overwrite?: boolean; sourcePath?: string } = {}) {
  const absolute = path.resolve(target), parent = await realpath(path.dirname(absolute));
  const destination = path.join(parent, path.basename(absolute));
  let existing;
  try { existing = await lstat(destination); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) throw new Error('Destination must be a regular file, not a symlink or directory');
  if (options.sourcePath) {
    if (path.resolve(options.sourcePath) === absolute) throw new Error('Refusing to overwrite the source mission');
    let source;
    try { source = await stat(options.sourcePath); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    if (source && existing && source.ino === existing.ino && source.dev === existing.dev) throw new Error('Refusing to overwrite an alias of the source mission');
    if (source && await realpath(options.sourcePath) === destination) throw new Error('Refusing to overwrite the source mission');
  }
  if (existing && !options.overwrite) throw new Error(`Refusing to overwrite the existing file '${target}'`);
  const temporary = path.join(parent, `.${path.basename(absolute)}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    if (options.overwrite) await rename(temporary, destination);
    else await link(temporary, destination); // atomic EEXIST, even if another writer appeared after lstat
  } finally {
    await unlink(temporary).catch(e => { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; });
  }
}
