import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { payloadDirs } from '../src/dcs/payloads.js';

// payloadDirs used to look only under Program Files, so an install on another
// drive (known only from dcs.log) contributed no stock loadouts at all.
test('stock payloads of a non-default install are found through the DCS log', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dcs-install-'));
  mkdirSync(path.join(root, 'Mods'));
  mkdirSync(path.join(root, 'bin'));
  const stock = path.join(root, 'MissionEditor', 'data', 'scripts', 'UnitPayloads');
  mkdirSync(stock, { recursive: true });
  const log = path.join(root, 'dcs.log');
  writeFileSync(log, 'Command line: "' + path.join(root, 'bin', 'DCS.exe') + '" --no-launcher');
  const env = { DCS_LOG_PATH: log, ProgramFiles: path.join(root, 'no-program-files'), DCS_SAVED_GAMES: path.join(root, 'no-saved-games') };
  assert.ok(payloadDirs(env).some(d => path.resolve(d) === path.resolve(stock)), JSON.stringify(payloadDirs(env)));
});
