#!/usr/bin/env node
/** Execute only generated setup and trusted telemetry under a user-supplied Lua 5.1. */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { newSession, closeSession } from '../dist/miz/sessions.js';
import { addGroundGroup } from '../dist/miz/authoring.js';
import { configureIads } from '../dist/miz/iads.js';
import { luaArray } from '../dist/miz/lua.js';
const lua = process.env.LUA51;
if (!lua) throw new Error('Set LUA51 to a Lua 5.1 interpreter. This check uses mocks and is not DCS verification.');
const dir = mkdtempSync(join(tmpdir(), 'dcs-lua51-')), s = newSession('Caucasus', 43200);
try {
  const mistPath = join(dir, 'mist.lua'), skynetPath = join(dir, 'skynet.lua');
  writeFileSync(mistPath, '-- mock resource; not executed\n'); writeFileSync(skynetPath, '-- mock resource; not executed\n');
  addGroundGroup(s.mission, 'vehicle', { side: 'red', country: 'Russia', name: 'SAM-Test', type: 'Kub 1S91 str', count: 1, x: 0, y: 0 });
  await configureIads(s, { name: 'Runtime Test', side: 'red', mistPath, skynetPath, goLivePercent: 70, harmDetectionPercent: 90, radioMenu: true });
  const script = luaArray(luaArray(s.mission.trigrules)[0].actions).find(a => a.predicate === 'a_do_script').text;
  const setup = join(dir, 'generated.lua'); writeFileSync(setup, String(script));
  const result = spawnSync(lua, [resolve('scripts/lua51/advanced-runtime.lua'), setup, resolve('scripts/dcs-mcp-telemetry.lua')], { encoding: 'utf8' });
  if (result.error) throw result.error;
  process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
  if (result.status !== 0) process.exitCode = 1;
} finally { closeSession(s.id); rmSync(dir, { recursive: true, force: true }); }
