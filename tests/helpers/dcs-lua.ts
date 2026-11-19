import { statSync } from 'node:fs';
import path from 'node:path';
import { findInstallDirs } from '../../src/dcs/install-info.js';

const isFile = (file: string): boolean => {
  try { return statSync(file).isFile(); } catch { return false; }
};

/** Use the same install discovery as the server, including non-default roots in dcs.log. */
export function findDcsLua(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.DCS_LUA) {
    if (!isFile(env.DCS_LUA)) throw new Error('DCS_LUA is not a file: ' + env.DCS_LUA);
    return env.DCS_LUA;
  }
  return findInstallDirs(env).flatMap(root => ['bin', 'bin-mt'].map(bin =>
    path.join(root.path, bin, 'luae.exe'))).find(isFile);
}
