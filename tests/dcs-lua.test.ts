import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { findDcsLua } from './helpers/dcs-lua.js';

test('Lua discovery respects an explicit interpreter and rejects a broken override', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dcs-lua-'));
  const lua = path.join(root, 'luae.exe');
  writeFileSync(lua, '');
  assert.equal(findDcsLua({ DCS_LUA: lua }), lua);
  assert.throws(() => findDcsLua({ DCS_LUA: path.join(root, 'missing.exe') }), /DCS_LUA.*not a file/);
});

test('Lua discovery finds a non-default install from its environment or DCS log', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dcs-install-'));
  mkdirSync(path.join(root, 'Mods'));
  mkdirSync(path.join(root, 'bin'));
  const lua = path.join(root, 'bin', 'luae.exe');
  writeFileSync(lua, '');
  const log = path.join(root, 'dcs.log');
  writeFileSync(log, 'Command line: "' + path.join(root, 'bin', 'DCS.exe') + '" --no-launcher');
  assert.equal(findDcsLua({ DCS_INSTALL_DIR: root, DCS_LOG_PATH: log }), lua);
  assert.equal(findDcsLua({ DCS_LOG_PATH: log }), lua);
});
