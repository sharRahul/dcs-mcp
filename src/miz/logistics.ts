/** Existing-entry inventory editing: preserve wsType and every unknown logistics field. */
import AdmZip from 'adm-zip';
import { z } from 'zod';
import { asTable, luaArray, parseLuaAssignment, type LuaTable } from './lua.js';
import { findAirport, findUnitType } from '../data/reference.js';
import { eachGroup, findGroupOfUnit, findUnit } from './authoring.js';
import { refresh, type MissionSession } from './sessions.js';
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
/**
 * Give each airfield that a plane/helicopter group STARTS from (parking, hot,
 * runway) to that group's side when the airfield is unowned or NEUTRAL.
 *
 * Verified in DCS 2.9.31 (2026-11-16): a Player F-16 set to start at Kutaisi in
 * a mission whose warehouses file had no entry for it never spawned (spectator
 * only, any ground start); the identical mission with Kutaisi BLUE spawned it.
 * An air start was unaffected. An airfield already owned by the OTHER side is
 * never flipped — that is reported, since the flight cannot spawn there.
 */
export function claimStartAirfields(session: MissionSession): string[] {
  const notes: string[] = [];
  const wanted = new Map<number, Set<string>>();
  eachGroup(session.mission, (group, category, side) => {
    if (category !== 'plane' && category !== 'helicopter') return;
    const first = asTable(asTable(asTable(group.route)?.points)?.[1]);
    const id = Number(first?.airdromeId);
    if (!first || !Number.isInteger(id) || id < 1 || !String(first.type ?? '').startsWith('TakeOff')) return;
    if (side !== 'red' && side !== 'blue') return;
    (wanted.get(id) ?? wanted.set(id, new Set()).get(id)!).add(`${side.toUpperCase()}:${group.name}`);
  });
  for (const [id, claims] of wanted) {
    const sides = new Set([...claims].map(c => c.split(':')[0]));
    const entry = asTable(asTable(readWarehouses(session).airports)?.[id]);
    const owner = String(entry?.coalition ?? 'NEUTRAL').toUpperCase();
    const groups = [...claims].map(c => c.split(':').slice(1).join(':')).join(', ');
    if (sides.size > 1) { notes.push(`airfield ${id}: both sides start flights there (${groups}); ownership left ${owner}`); continue; }
    const side = [...sides][0];
    if (owner === side) continue;
    if (owner !== 'NEUTRAL') { notes.push(`airfield ${id} is ${owner}; ${side} flight(s) ${groups} cannot spawn there`); continue; }
    session.warehouses = editWarehouse(session, 'airports', id, { coalition: side as 'RED' | 'BLUE' }, true);
    notes.push(`airfield ${id} set to ${side}: ${groups} start there (DCS does not spawn a flight at an airfield its side does not own)`);
  }
  // Ship and FARP starts (linkUnit). Verified in DCS 2.9.31 (2026-11-17): a Player
  // F/A-18 linked to a Stennis with no warehouses entry never spawned; adding the
  // carrier's entry (its own coalition) spawned it on deck. editWarehouse creates
  // the entry with the ship's/FARP's side, never the flight's.
  const linked = new Map<number, string[]>();
  eachGroup(session.mission, (group, category) => {
    if (category !== 'plane' && category !== 'helicopter') return;
    const first = asTable(asTable(asTable(group.route)?.points)?.[1]);
    const id = Number(first?.linkUnit);
    if (!first || !Number.isInteger(id) || id < 1 || !String(first.type ?? '').startsWith('TakeOff')) return;
    (linked.get(id) ?? linked.set(id, []).get(id)!).push(String(group.name));
  });
  // editWarehouse finds the ship/FARP through the canonical document; make sure
  // it reflects groups added since the last refresh.
  if (linked.size) refresh(session);
  for (const [id, groups] of linked) {
    if (asTable(asTable(readWarehouses(session).warehouses)?.[id])) continue;
    try {
      session.warehouses = editWarehouse(session, 'warehouses', id, {}, true);
      const side = String(asTable(asTable(session.warehouses.warehouses)?.[id])?.coalition);
      notes.push(`ship/FARP unit ${id} given its warehouse entry (${side}): ${groups.join(', ')} start there (DCS does not spawn flights from a ship/FARP without one)`);
    } catch (error) {
      notes.push(`ship/FARP unit ${id} has no warehouse entry and none could be created (${(error as Error).message}); ${groups.join(', ')} may not spawn`);
    }
  }
  return notes;
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
    const seen = new Set<string>();
    for (const [i, supplier] of patch.suppliers.entries()) {
      const key = `${supplier.kind}:${supplier.id}`;
      if (seen.has(key)) throw new Error(`Duplicate supplier ${key}`);
      seen.add(key);
      if (supplier.kind === kind && supplier.id === id) throw new Error('Warehouse cannot supply itself');
      if (!asTable(asTable(copy[supplier.kind])?.[supplier.id])) throw new Error(`Supplier ${supplier.kind}:${supplier.id} does not exist`);
      const upstream = asTable(asTable(copy[supplier.kind])?.[supplier.id])!;
      if (upstream.coalition !== entry.coalition) throw new Error(`Supplier ${key} belongs to a different coalition`);
      // ED me_mission.lua addSupplier: {Id=supplierId,type=supplierType}.
      // Keep unknown fields on existing records.
      const existing = luaArray(entry.suppliers).find(s => s.Id === supplier.id && s.type === supplier.kind);
      suppliers[i + 1] = existing ?? { Id: supplier.id, type: supplier.kind };
    }
    entry.suppliers = suppliers;
  }
  category[id] = entry; copy[kind] = category;
  return copy;
}
