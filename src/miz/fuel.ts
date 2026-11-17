/**
 * Aircraft internal fuel limits. The maximum is pydcs's `fuel_max` (kg, exported from DCS) in
 * data/unit-types.json; ED's DCS User Manual describes the editor's INTERNAL FUEL slider as a
 * percentage of that maximum, so percent <-> kg is a straight proportion. Per-airframe DEFAULT
 * starting fuel is not in any bundled source and is never inferred. Offline only.
 */
import { findUnitType, unitTypes, type FlyingType } from '../data/reference.js';
import { asTable, luaArray, type LuaTable } from './lua.js';
import { eachGroup } from './authoring.js';

export function fuelInfo(type: string) {
  const hit = findUnitType(type);
  if (!hit || (hit.category !== 'plane' && hit.category !== 'helicopter')) throw new Error(`'${type}' is not a known aircraft type`);
  const max = (hit.entry as FlyingType).fuelMax;
  return { type, category: hit.category, fuelMaxKg: max ?? null, source: 'pydcs fuel_max (exported from DCS)',
    notes: ['Default starting fuel per airframe is not in the bundled data; new aircraft get the maximum.'] };
}

export function listFuel() {
  const all = unitTypes();
  return (['plane', 'helicopter'] as const).flatMap(c => (all[c] as FlyingType[]).map(t => ({ type: t.type, category: c, fuelMaxKg: t.fuelMax })));
}

/** kg for a percentage of the type's maximum (the editor's INTERNAL FUEL slider). */
export function fuelKgFromPercent(type: string, percent: number): number {
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) throw new Error('fuelPercent must be 0-100');
  const { fuelMaxKg } = fuelInfo(type);
  if (fuelMaxKg == null) throw new Error(`No fuel maximum known for '${type}'`);
  return Math.round(fuelMaxKg * percent) / 100;
}

/** Every aircraft unit's internal fuel against its maximum. */
export function fuelReport(mission: LuaTable) {
  const rows: { unit: string; type: string; fuelKg: number | null; fuelMaxKg: number | null; percent: number | null; issue?: string }[] = [];
  eachGroup(mission, (group, category) => {
    if (category !== 'plane' && category !== 'helicopter') return;
    for (const u of luaArray(group.units)) {
      const raw = asTable(u.payload)?.fuel, kg = raw === undefined ? null : Number(raw);
      const max = (findUnitType(String(u.type))?.entry as FlyingType | undefined)?.fuelMax ?? null;
      const row = { unit: String(u.name), type: String(u.type), fuelKg: kg, fuelMaxKg: max,
        percent: kg !== null && Number.isFinite(kg) && max ? Math.round((kg / max) * 1000) / 10 : null } as (typeof rows)[number];
      if (raw !== undefined && !Number.isFinite(kg)) row.issue = 'not a number';
      else if (kg !== null && kg < 0) row.issue = 'negative';
      else if (kg !== null && max !== null && kg > max) row.issue = 'over maximum';
      rows.push(row);
    }
  });
  return rows;
}
