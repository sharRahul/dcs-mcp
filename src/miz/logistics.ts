/** Existing-entry inventory editing: preserve wsType and every unknown logistics field. */
import AdmZip from 'adm-zip';
import { z } from 'zod';
import { asTable, luaArray, parseLuaAssignment, type LuaTable } from './lua.js';
import { findAirport, findUnitType } from '../data/reference.js';
import { findGroupOfUnit, findUnit } from './authoring.js';
import type { MissionSession } from './sessions.js';
const endpoint = z.object({ kind: z.enum(['airports', 'warehouses']), id: z.number().int().positive() }).strict();
export const warehousePatchSchema = z.object({
  coalition: z.enum(['RED', 'BLUE', 'NEUTRAL']).optional(),
  unlimitedFuel: z.boolean().optional(), unlimitedMunitions: z.boolean().optional(), unlimitedAircrafts: z.boolean().optional(),
  dynamicSpawn: z.boolean().optional(), dynamicCargo: z.boolean().optional(), allowHotStart: z.boolean().optional(),
  size: z.number().positive().max(100000).optional(), speed: z.number().nonnegative().max(1000).optional(), periodicity: z.number().positive().max(100000).optional(),
  OperatingLevel_Air: z.number().min(0).max(100).optional(), OperatingLevel_Fuel: z.number().min(0).max(100).optional(), OperatingLevel_Eqp: z.number().min(0).max(100).optional(),
  fuel: z.object({ jet_fuel: z.number().finite().nonnegative().optional(), gasoline: z.number().finite().nonnegative().optional(), diesel: z.number().finite().nonnegative().optional(), methanol_mixture: z.number().finite().nonnegative().optional() }).strict().optional(),
  aircraft: z.array(z.object({ category: z.enum(['planes', 'helicopters']), type: z.string().min(1), quantity: z.number().int().nonnegative() }).strict()).max(200).optional(),
  weapons: z.array(z.object({ index: z.number().int().positive(), quantity: z.number().int().nonnegative() }).strict()).max(1000).optional(),
  suppliers: z.array(endpoint).max(100).optional(),
}).strict();
export function readWarehouses(session: MissionSession): LuaTable {
  if (session.warehouses) return session.warehouses;
  const entry = new AdmZip(session.sourceBytes).getEntry('warehouses');
  return entry ? parseLuaAssignment(entry.getData().toString('utf8'), 'warehouses') : { airports: {}, warehouses: {} };
}
export function listWarehouses(table: LuaTable) {
  return (['airports', 'warehouses'] as const).flatMap(kind => Object.entries(asTable(table[kind]) ?? {}).map(([id, value]) => ({ kind, id: Number(id), data: value })));
}
function defaultWarehouse(coalition: string): LuaTable {
  return { coalition, size: 100, speed: 16.666666, periodicity: 30, unlimitedMunitions: true, unlimitedAircrafts: true, unlimitedFuel: true,
    OperatingLevel_Air: 10, OperatingLevel_Fuel: 10, OperatingLevel_Eqp: 10, aircrafts: {}, weapons: {}, suppliers: {},
    gasoline: { InitFuel: 100 }, methanol_mixture: { InitFuel: 100 }, diesel: { InitFuel: 100 }, jet_fuel: { InitFuel: 100 },
    dynamicSpawn: false, dynamicCargo: false, allowHotStart: false };
}
function validWsType(value: unknown): boolean {
  const table = value && typeof value === 'object' ? value as LuaTable : undefined;
  return !!table && [1, 2, 3, 4].every(k => typeof table[k] === 'number' && Number.isInteger(table[k]) && Number(table[k]) >= 0);
}
export function editWarehouse(session: MissionSession, kind: 'airports' | 'warehouses', id: number,
  input: z.input<typeof warehousePatchSchema>, create = false): LuaTable {
  const patch = warehousePatchSchema.parse(input);
  if (patch.aircraft?.length && patch.unlimitedAircrafts === true) throw new Error('Finite aircraft stock conflicts with unlimitedAircrafts=true');
  if (patch.weapons?.length && patch.unlimitedMunitions === true) throw new Error('Finite weapon stock conflicts with unlimitedMunitions=true');
  if (Object.keys(patch.fuel ?? {}).length && patch.unlimitedFuel === true) throw new Error('Finite fuel stock conflicts with unlimitedFuel=true');
  if (!Number.isInteger(id) || id < 1) throw new Error('Warehouse id must be a positive integer');
  const copy = structuredClone(readWarehouses(session));
  const category = asTable(copy[kind]) ?? {};
  let entry = asTable(category[id]);
  if (!entry) {
    if (!create) throw new Error(`No ${kind} warehouse ${id}; use create=true for a supported airfield, ship or FARP`);
    let side = 'NEUTRAL';
    if (kind === 'airports') findAirport(String(session.mission.theatre), id);
    else {
      let matched: { name: string; type: string } | undefined;
      // Warehouse ids are unit ids. Reuse the canonical document, then check the raw unit.
      for (const group of session.document.groups) for (const unit of group.units) if (unit.id === id) matched = unit;
      const unit = matched && findUnit(session.mission, matched.name);
      const group = matched && findGroupOfUnit(session.mission, matched.name);
      if (!unit || !group || !(group.category === 'ship' || unit.category === 'Heliports')) throw new Error('Unit warehouse requires an existing ship or FARP');
      side = group.side === 'neutrals' ? 'NEUTRAL' : group.side.toUpperCase();
    }
    entry = defaultWarehouse(side);
  }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || ['fuel', 'aircraft', 'weapons', 'suppliers'].includes(key)) continue;
    entry[key] = value as string | number | boolean;
  }
  if (Object.keys(patch.fuel ?? {}).length) entry.unlimitedFuel = false;
  for (const [fuel, amount] of Object.entries(patch.fuel ?? {})) {
    if (amount !== undefined) { const target = (entry[fuel] ??= {}) as LuaTable; target.InitFuel = amount; }
  }
  for (const stock of patch.aircraft ?? []) {
    const ref = findUnitType(stock.type);
    if (ref && ref.category !== (stock.category === 'planes' ? 'plane' : 'helicopter')) throw new Error(`Wrong warehouse category for ${stock.type}`);
    const item = asTable(asTable(asTable(entry.aircrafts)?.[stock.category])?.[stock.type]);
    if (!item || !validWsType(item.wsType)) throw new Error(`Aircraft '${stock.type}' needs an existing wsType-bearing warehouse entry; bundled data cannot safely create it`);
    item.initialAmount = stock.quantity; item.unlimited = false;
    entry.unlimitedAircrafts = false;
  }
  for (const stock of patch.weapons ?? []) {
    const item = asTable(asTable(entry.weapons)?.[stock.index]);
    if (!item || !validWsType(item.wsType)) throw new Error(`Weapon index ${stock.index} needs an existing wsType-bearing entry`);
    item.initialAmount = stock.quantity; entry.unlimitedMunitions = false;
  }
  if (patch.suppliers) {
    const suppliers: LuaTable = {};
    for (const [i, supplier] of patch.suppliers.entries()) {
      if (supplier.kind === kind && supplier.id === id) throw new Error('Warehouse cannot supply itself');
      if (!asTable(asTable(copy[supplier.kind])?.[supplier.id])) throw new Error(`Supplier ${supplier.kind}:${supplier.id} does not exist`);
      // pydcs stores supplier records opaquely; exact DCS key names are in existing mission entries.
      // Refuse fabricating records: reuse only an existing record matching Id/type.
      const existing = luaArray(entry.suppliers).find(s => s.Id === supplier.id && s.type === supplier.kind);
      if (!existing) throw new Error(`Supplier ${supplier.kind}:${supplier.id} is not an existing supplier record; creating supplier links is unsupported`);
      suppliers[i + 1] = existing;
    }
    entry.suppliers = suppliers;
  }
  category[id] = entry; copy[kind] = category;
  return copy;
}
