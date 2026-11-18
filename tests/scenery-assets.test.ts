import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSceneryDeclarations } from '../src/dcs/scenery-assets.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanModFolder, findModUnit } from '../src/dcs/mods.js';

test('installed scenery metadata is read without running Lua, guessing expressions or reading commented declarations', () => {
  const source = `
    error('must never execute')
    -- add_personnel({Name='Fake',ShapeName='fake',category='Personnel'})
    local function unused() add_personnel({Name='NotRegistered',ShapeName='no',category='Personnel'}) end
    add_personnel({Name='LandCrew',ShapeName='crew_shape',category='Personnel',Rate=1,DisplayName=_('Ground crew')})
    CWAY = {}; CWAY.Name='BombCart'; CWAY.visual.shape='cart_shape'; CWAY.category='Fortification'; CWAY.Rate=2
    add_surface_unit(CWAY)
    CWAY={}; CWAY.Name='Unregistered'; CWAY.visual.shape='no'
    add_structure({Name='Dynamic',ShapeName=makeShape(),category='Fortification'})
  `;
  const found = parseSceneryDeclarations(source, 'local-mod.lua');
  assert.deepEqual(found.map(x => [x.type, x.category, x.shape]), [['LandCrew', 'Personnel', 'crew_shape'], ['BombCart', 'Fortifications', 'cart_shape']]);
  assert.equal(found[0].name, 'Ground crew');
  assert.equal(found[1].file, 'local-mod.lua');
  assert.deepEqual(parseSceneryDeclarations('not valid Lua !', 'broken.lua'), []);
});

test('declared scenery is recognised as a deployed mod type rather than falsely reported missing', () => {
  const dir=mkdtempSync(join(tmpdir(),'dcs-scenery-'));
  try {
    writeFileSync(join(dir,'objects.lua'), `add_personnel({Name='LocalCrew',ShapeName='crew',category='Personnel',Rate=1})`);
    const mod=scanModFolder(dir,'tech');
    assert.equal(findModUnit('LocalCrew',[mod])?.deployed,true);
    assert.equal(findModUnit('LocalCrew',[mod])?.category,'static');
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
