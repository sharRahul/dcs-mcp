/**
 * Whole-group operations: clone, grow, spatial search and route replacement.
 * Offline only; not Mission-Editor verified.
 */
import { findUnitType } from '../data/reference.js';
import { asTable, luaArray, type LuaTable } from './lua.js';
import {
  addWaypoint, assertNamesFree, defaultPayload, eachGroup, ensureCountry, countryId, findGroup, findUnit,
  FORMATION_SPACING, maxIds, type Side, type WaypointArgs,
} from './authoring.js';

const PARKING_TYPES = new Set(['TakeOffParking', 'TakeOffParkingHot']);
const nextKey = (t: LuaTable) => Math.max(0, ...Object.keys(t).map(Number).filter(Number.isFinite)) + 1;

function requireGroup(mission: LuaTable, name: string) {
  const found = findGroup(mission, name);
  if (!found) throw new Error(`No group named '${name}' in this mission`);
  return found;
}

function firstPoint(group: LuaTable): LuaTable | undefined {
  return luaArray(asTable(group.route)?.points)[0];
}

/** A start bound to a parking slot, ship deck or FARP pad cannot be copied as-is. */
function boundStart(group: LuaTable): string | undefined {
  const p = firstPoint(group);
  if (!p) return undefined;
  if (PARKING_TYPES.has(String(p.type))) return 'a parking start';
  if (p.linkUnit !== undefined) return 'a ship/FARP start';
  return undefined;
}

export interface CloneArgs { newName: string; dx?: number; dy?: number; side?: Side; country?: string }

/**
 * Deep-copy a group under a new name with fresh group/unit ids. Units and every route
 * point move by (dx, dy). Datalink tables are dropped because they name the source
 * group's unit ids; parking/ship/FARP starts are refused because the copy would sit on
 * the same slot.
 */
export function cloneGroup(mission: LuaTable, source: string, args: CloneArgs) {
  const found = requireGroup(mission, source);
  const bound = boundStart(found.group);
  if (bound) throw new Error(`'${source}' has ${bound}; cloning would reuse its slot. Create a new flight instead.`);
  const units = luaArray(found.group.units);
  const names = units.map((_, i) => `${args.newName}-${i + 1}`);
  assertNamesFree(mission, args.newName, names);
  const side = args.side ?? found.side;
  const country = args.country
    ? ensureCountry(mission, side, args.country, countryId(args.country))
    : found.country;
  if (!args.country && args.side && args.side !== found.side) throw new Error('Give a country when cloning to another side');
  const dx = args.dx ?? 0, dy = args.dy ?? 0;
  const ids = maxIds(mission);
  const copy = structuredClone(found.group);
  copy.name = args.newName;
  copy.groupId = ids.groupId + 1;
  if (typeof copy.x === 'number') copy.x += dx;
  if (typeof copy.y === 'number') copy.y += dy;
  const dropped: string[] = [];
  luaArray(copy.units).forEach((u, i) => {
    u.name = names[i];
    u.unitId = ids.unitId + i + 1;
    u.x = Number(u.x) + dx; u.y = Number(u.y) + dy;
    if (u.datalinks !== undefined) { delete u.datalinks; dropped.push(String(u.name)); }
  });
  for (const p of luaArray(asTable(copy.route)?.points)) { p.x = Number(p.x) + dx; p.y = Number(p.y) + dy; }
  const cat = (country[found.category] ??= { group: {} }) as LuaTable;
  const groups = (cat.group ??= {}) as LuaTable;
  groups[nextKey(groups)] = copy;
  const warnings: string[] = [];
  if (dropped.length) warnings.push(`Datalinks dropped from ${dropped.join(', ')} (they referenced the source group's units).`);
  if (units.some(u => u.onboard_num !== undefined)) warnings.push('Tail numbers (onboard_num) were copied unchanged; change them if they must differ.');
  if (units.some(u => u.callsign !== undefined)) warnings.push('Callsigns were copied unchanged.');
  warnings.push('Triggers that reference the source group are not copied.');
  return { group: args.newName, groupId: copy.groupId, units: names, category: found.category, side, warnings };
}

export interface AddUnitsArgs { type?: string; count: number }

/** Append units to a group, trailing its last unit along the lead's heading. */
export function addUnitsToGroup(mission: LuaTable, groupName: string, args: AddUnitsArgs) {
  const found = requireGroup(mission, groupName);
  if (!Number.isInteger(args.count) || args.count < 1 || args.count > 64) throw new Error('count must be 1..64');
  const unitsTable = (found.group.units ??= {}) as LuaTable;
  const units = luaArray(unitsTable);
  if (!units.length) throw new Error(`Group '${groupName}' has no units to extend`);
  const lead = units[0], last = units[units.length - 1];
  const type = args.type ?? String(lead.type);
  if (!findUnitType(type)) throw new Error(`Unknown unit type '${type}'`);
  const air = found.category === 'plane' || found.category === 'helicopter';
  if (air) {
    if (units.length + args.count > 16) throw new Error('An aircraft group holds at most 16 units');
    const bound = boundStart(found.group);
    if (bound) throw new Error(`'${groupName}' has ${bound}; new aircraft would need parking. Recreate the flight with a larger count.`);
    if (type !== lead.type) throw new Error('Aircraft added to a flight must match the lead type');
  }
  const heading = Number(lead.heading ?? 0);
  const spacing = FORMATION_SPACING[found.category] ?? FORMATION_SPACING.vehicle;
  const ids = maxIds(mission);
  const used = new Set(units.map(u => String(u.name)));
  const names: string[] = [];
  for (let n = units.length + 1; names.length < args.count; n++) {
    const name = `${groupName}-${n}`;
    if (!used.has(name) && !findUnit(mission, name)) names.push(name);
  }
  assertNamesFree(mission, undefined, names);
  names.forEach((name, i) => {
    const back = (i + 1) * spacing;
    const unit: LuaTable = { ...structuredClone(air ? lead : {}), name, unitId: ids.unitId + i + 1, type,
      x: Number(last.x) - back * Math.cos(heading), y: Number(last.y) - back * Math.sin(heading), heading,
      skill: lead.skill ?? 'Average' };
    if (air) {
      delete unit.datalinks; delete unit.onboard_num;
      if (unit.callsign && typeof unit.callsign === 'object') {
        const cs = asTable(unit.callsign)!;
        cs[3] = units.length + i + 1;
        if (typeof cs.name === 'string') cs.name = cs.name.replace(/\d$/, String(units.length + i + 1));
      }
      if (unit.payload === undefined) { const payload = defaultPayload(type); if (payload) unit.payload = payload; }
    } else if (lead.playerCanDrive !== undefined) unit.playerCanDrive = lead.playerCanDrive;
    unitsTable[nextKey(unitsTable)] = unit;
  });
  return { group: groupName, added: names, total: units.length + names.length };
}

export interface NearArgs { x: number; y: number; radiusMetres: number; side?: Side; category?: string }

/** Groups whose lead unit lies within radius, nearest first. */
export function findGroupsNear(mission: LuaTable, args: NearArgs) {
  const hits: { name: string; side: Side; category: string; distanceMetres: number; x: number; y: number; units: number }[] = [];
  eachGroup(mission, (group, category, side) => {
    if (args.side && side !== args.side) return;
    if (args.category && category !== args.category) return;
    const lead = luaArray(group.units)[0];
    if (!lead) return;
    const d = Math.hypot(Number(lead.x) - args.x, Number(lead.y) - args.y);
    if (d <= args.radiusMetres) hits.push({ name: String(group.name), side, category, distanceMetres: Math.round(d * 10) / 10,
      x: Number(lead.x), y: Number(lead.y), units: luaArray(group.units).length });
  });
  return hits.sort((a, b) => a.distanceMetres - b.distanceMetres);
}

/**
 * Replace every waypoint after the start point. Point 1 (spawn/start, ETA-locked) is
 * always kept — the editor's fixUnitsPos needs it and it may carry the start binding.
 */
export function setRoute(mission: LuaTable, groupName: string, points: WaypointArgs[]) {
  const found = requireGroup(mission, groupName);
  const route = (found.group.route ??= { points: {} }) as LuaTable;
  const table = (route.points ??= {}) as LuaTable;
  const existing = luaArray(table);
  if (!existing.length) throw new Error(`Group '${groupName}' has no start point`);
  const removed = existing.length - 1;
  const lostTasks = existing.slice(1).reduce((n, p) => n + luaArray(asTable(asTable(asTable(p.task)?.params)?.tasks)).length, 0);
  for (const k of Object.keys(table)) if (Number(k) !== 1) delete table[k];
  table[1] = existing[0];
  for (const p of points) addWaypoint(mission, groupName, p);
  return { group: groupName, removed, added: points.length, total: points.length + 1,
    warnings: lostTasks ? [`${lostTasks} task(s) on the replaced waypoints were removed.`] : [] };
}
