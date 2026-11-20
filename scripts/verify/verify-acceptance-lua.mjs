#!/usr/bin/env node
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readMizArchive } from '../../dist/miz/archive.js';
import { parseMissionTables } from '../../dist/miz/parser.js';
import { serializeLuaAssignment } from '../../dist/miz/serializer.js';
if (!process.env.LUA51 || !process.argv[2]) throw new Error('Set LUA51 to Lua 5.1; provide generated acceptance directory');
const root = path.resolve(process.argv[2]), manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
if (manifest.version !== 1 || !Array.isArray(manifest.scenarios) || manifest.scenarios.length > 100) throw new Error('Invalid manifest');
const temp = await mkdtemp(path.join(os.tmpdir(), 'dcs-compile-'));
try {
 for (const scenario of manifest.scenarios) {
  if (!/^\d\d-[a-z0-9-]+$/.test(scenario.id) || scenario.mission !== `missions/${scenario.id}.miz`) throw new Error('Unsafe scenario path');
  const archive = await readMizArchive(path.join(root, scenario.mission));
  if (archive.digest !== scenario.digest) throw new Error(`${scenario.id}: mission digest changed`);
  // Only execute data reserialized by our data-only parser, never package-supplied Lua.
  const file = path.join(temp, 'mission.lua'); await writeFile(file, serializeLuaAssignment('mission', parseMissionTables(archive).mission));
  const result = spawnSync(process.env.LUA51, [path.resolve('scripts/verify/lua51/acceptance-compile.lua'), file], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${scenario.id}: ${result.error ?? ''}${result.stdout}${result.stderr}`);
  console.log(`${scenario.id}: ${result.stdout.trim()}`);
 }
} finally { await rm(temp, { recursive: true, force: true }); }
console.log('All generated Lua compiled under Lua 5.1. NO DCS behavior verified.');
