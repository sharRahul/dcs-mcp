import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import luaparse from 'luaparse';

const hook = 'scripts/Hooks/dcs-mcp-hook.lua';
test('aircraft runtime is embedded in the installable hook and parses as Lua 5.1', () => {
  const source = readFileSync(hook, 'utf8').match(/local AIRCRAFT_SRC = \[==\[([\s\S]*?)\]==\]/)?.[1];
  assert.ok(source, 'aircraft runtime module is missing');
  luaparse.parse(source, { luaVersion: '5.1' });
});
const lua = [process.env.DCS_LUA, 'C:/Program Files/Eagle Dynamics/DCS World/bin/luae.exe', 'C:/Program Files/Eagle Dynamics/DCS World/bin-mt/luae.exe'].find(p => p && existsSync(p));
test('aircraft runtime preserves information boundaries, task semantics and evidence', { skip: lua ? false : 'Set DCS_LUA to a Lua 5.1 interpreter' }, () => {
  const run = spawnSync(lua!, ['tests/fixtures/aircraft-runtime.lua', hook], { encoding: 'utf8' });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /AIRCRAFT_RUNTIME_OK/);
});
