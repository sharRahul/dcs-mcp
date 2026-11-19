import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import { editWarehouse, readWarehouses } from '../src/miz/logistics.js';
import { asTable, parseLuaAssignment, type LuaTable } from '../src/miz/lua.js';
import { serializeLuaAssignment } from '../src/miz/serializer.js';
import { closeSession, enableSessionPersistence, evictSession, newSession, openSession, refresh, requireSession, saveSessionAs } from '../src/miz/sessions.js';
function fixture(): LuaTable {
  return { opaque: { future: 'keep me' }, airports: { 12: { coalition: 'BLUE', unlimitedAircrafts: true, unlimitedMunitions: true, unlimitedFuel: true,
    jet_fuel: { InitFuel: 100, opaque: 77 }, aircrafts: { planes: { 'F-16C_50': { initialAmount: 4, wsType: { 1: 1, 2: 1, 3: 1, 4: 1 }, unlimited: true, linkDynTempl: 9, future: 'keep' } } },
    weapons: { 2: { initialAmount: 20, wsType: { 1: 4, 2: 4, 3: 7, 4: 1 }, future: 'keep' } },
    suppliers: { 1: { Id: 13, type: 'airports', future: 'keep' } }, customRestriction: true }, 13: { coalition: 'BLUE', opaque: 'other airfield' } },
    warehouses: { 900: { coalition: 'RED', opaque: 'unit warehouse' } } };
}
function sessionWithWarehouse() {
  const s = newSession('Caucasus', 43200), zip = new AdmZip(s.sourceBytes);
  zip.updateFile('warehouses', Buffer.from(serializeLuaAssignment('warehouses', fixture())));
  zip.addFile('opaque.bin', Buffer.from([0, 255, 17, 128])); s.sourceBytes = zip.toBuffer(); return s;
}
test('warehouse edits preserve wsType, unknown entries and untouched archive members across save/reopen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dcs-wh-')), s = sessionWithWarehouse();
  s.warehouses = editWarehouse(s, 'airports', 12, { aircraft: [{ category: 'planes', type: 'F-16C_50', quantity: 6 }],
    weapons: [{ index: 2, quantity: 9 }], fuel: { jet_fuel: 33 }, unlimitedFuel: false, periodicity: 45 });
  await saveSessionAs(s, join(dir, 'edited.miz'));
  const reopened = await openSession(join(dir, 'edited.miz')), table = readWarehouses(reopened);
  const wh = asTable(asTable(table.airports)?.[12])!;
  const stock = asTable(asTable(asTable(wh.aircrafts)?.planes)?.['F-16C_50'])!;
  assert.equal(stock.initialAmount, 6); assert.equal(stock.unlimited, false); assert.equal(stock.linkDynTempl, 9); assert.equal(stock.future, 'keep');
  assert.deepEqual(stock.wsType, { 1: 1, 2: 1, 3: 1, 4: 1 });
  assert.equal(asTable(wh.jet_fuel)!.InitFuel, 33); assert.equal(asTable(wh.jet_fuel)!.opaque, 77);
  assert.equal(asTable(asTable(wh.weapons)?.[2])!.initialAmount, 9); assert.equal(wh.unlimitedMunitions, false);
  assert.deepEqual(table.warehouses, fixture().warehouses); assert.deepEqual(table.opaque, fixture().opaque);
  assert.deepEqual(new AdmZip(reopened.sourceBytes).getEntry('opaque.bin')!.getData(), Buffer.from([0, 255, 17, 128]));
  assert.deepEqual(readWarehouses(s), table);
  closeSession(s.id); closeSession(reopened.id);
});
test('untouched logistics remains byte-for-byte and reading does not mark it for serialization', async () => {
  const s = sessionWithWarehouse(), original = new AdmZip(s.sourceBytes).getEntry('warehouses')!.getData();
  readWarehouses(s); assert.equal(s.warehouses, undefined);
  const dir = mkdtempSync(join(tmpdir(), 'dcs-wh-')); await saveSessionAs(s, join(dir, 'copy.miz'));
  assert.deepEqual(new AdmZip(join(dir, 'copy.miz')).getEntry('warehouses')!.getData(), original); closeSession(s.id);
});
test('invalid stock metadata, quantities and suppliers fail without mutating the session', () => {
  const s = sessionWithWarehouse(), before = serializeLuaAssignment('warehouses', readWarehouses(s));
  for (const patch of [
    { aircraft: [{ category: 'planes' as const, type: 'FA-18C_hornet', quantity: 3 }] },
    { aircraft: [{ category: 'helicopters' as const, type: 'F-16C_50', quantity: 3 }] },
    { weapons: [{ index: 99, quantity: 3 }] }, { fuel: { diesel: -1 } },
    { suppliers: [{ kind: 'airports' as const, id: 12 }] }, { suppliers: [{ kind: 'warehouses' as const, id: 900 }] },
  ]) { assert.throws(() => editWarehouse(s, 'airports', 12, patch)); assert.equal(serializeLuaAssignment('warehouses', readWarehouses(s)), before); }
  closeSession(s.id);
});
test('supply restrictions reuse existing records and default warehouse creation checks real endpoints', () => {
  const s = sessionWithWarehouse();
  s.warehouses = editWarehouse(s, 'airports', 12, { suppliers: [{ kind: 'airports', id: 13 }], dynamicCargo: true, allowHotStart: false });
  assert.equal(asTable(asTable(asTable(asTable(s.warehouses.airports)?.[12])?.suppliers)?.[1])!.future, 'keep');
  s.warehouses = editWarehouse(s, 'airports', 12, { suppliers: [] });
  assert.deepEqual(asTable(asTable(s.warehouses.airports)?.[12])!.suppliers, {});
  assert.throws(() => editWarehouse(s, 'airports', 999999, {}, true), /No airfield/);
  assert.throws(() => editWarehouse(s, 'warehouses', 999999, {}, true), /existing ship or FARP/);
  const table = editWarehouse(s, 'airports', 14, { unlimitedFuel: false }, true);
  assert.equal(asTable(asTable(table.airports)?.[14])!.unlimitedFuel, false);
  assert.equal(asTable(asTable(table.airports)?.[14])!.coalition, 'NEUTRAL');
  closeSession(s.id);
});
test('edited logistics survive session snapshots and restoration', () => {
  enableSessionPersistence(mkdtempSync(join(tmpdir(), 'dcs-wh-state-')));
  const s = sessionWithWarehouse();
  s.warehouses = editWarehouse(s, 'airports', 12, { fuel: { jet_fuel: 7 } }); refresh(s);
  evictSession(s.id); const restored = requireSession(s.id);
  assert.equal(asTable(asTable(asTable(readWarehouses(restored).airports)?.[12])?.jet_fuel)!.InitFuel, 7);
  closeSession(s.id); enableSessionPersistence('off');
});

test('new supplier links use editor keys and survive save/reopen without losing opaque fields', async()=>{
 const s=sessionWithWarehouse(); const dir=mkdtempSync(join(tmpdir(),'dcs-supply-'));
 s.warehouses=editWarehouse(s,'airports',14,{},true);
 s.warehouses=editWarehouse(s,'airports',14,{coalition:'BLUE',suppliers:[{kind:'airports',id:12},{kind:'airports',id:13}]});
 const links=asTable(asTable(asTable(s.warehouses.airports)?.[14])?.suppliers)!;
 assert.deepEqual(links,{1:{Id:12,type:'airports'},2:{Id:13,type:'airports'}});
 const before=structuredClone(s.warehouses);
 assert.throws(()=>editWarehouse(s,'airports',14,{suppliers:[{kind:'airports',id:12},{kind:'airports',id:12}]}),/duplicate/i);
 assert.deepEqual(s.warehouses,before);
 await saveSessionAs(s,join(dir,'supplier.miz'));const reopened=await openSession(join(dir,'supplier.miz'));
 assert.deepEqual(asTable(asTable(asTable(readWarehouses(reopened).airports)?.[14])?.suppliers),links);
 closeSession(s.id);closeSession(reopened.id);
});
