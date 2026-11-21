import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scanModFolder } from '../src/dcs/mods.js';

// ED's Supercarrier (CoreMods/tech/USS_Nimitz) declares deck equipment through a local
// helper, so AS32-31A in a real mission was reported as "will not spawn here".
test('types declared through a local add_surface_unit helper are found, and nothing else', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'mod-helper-'));
  mkdirSync(path.join(root, 'Database'));
  writeFileSync(path.join(root, 'Database', 'db_ground_objects.lua'), `
local function support_unit(name, displayName, shapeName)
	local u = {}
	u.Name = name;
	u.DisplayName = displayName;
	add_surface_unit(u)
	GT = nil;
end
local function note(text)
	print(text)
end
support_unit("AS32-31A", _("AS32-31A"), "AS32-31A")
support_unit("AS32-p25", _("AS32-P25"), "AS32-p25")
note("NOT-A-UNIT")
`);
  const types = scanModFolder(root, 'tech').units.map(u => u.type).sort();
  assert.deepEqual(types, ['AS32-31A', 'AS32-p25']);
});
