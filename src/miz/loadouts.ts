/**
 * Apply a named loadout from the user's DCS payload library (src/dcs/payloads.ts) to every
 * unit of an aircraft group, or to one unit. Pylons are written as pydcs loadout_by_name
 * does: {CLSID, settings?} per pylon number; fuel, chaff, flares and gun are left as they
 * are. The library is the user's own DCS data, newer than the bundled pydcs catalogue, so a
 * CLSID pydcs does not list on that pylon is a warning, not a refusal. Offline only.
 */
import { asTable, luaArray, type LuaTable } from './lua.js';
import { findGroup, findGroupOfUnit, findUnit } from './authoring.js';
import { authoringData } from '../data/authoring.js';
import { loadoutsFor, scanPayloads } from '../dcs/payloads.js';

export function applyLoadout(mission: LuaTable, target: { group?: string; unit?: string }, loadoutName: string, scan = scanPayloads()) {
  if (!!target.group === !!target.unit) throw new Error('Give exactly one of group or unit');
  const units: LuaTable[] = [];
  if (target.group) {
    const found = findGroup(mission, target.group);
    if (!found) throw new Error(`No group named '${target.group}'`);
    if (found.category !== 'plane' && found.category !== 'helicopter') throw new Error(`'${target.group}' is not an aircraft group`);
    units.push(...luaArray(found.group.units));
  } else {
    const u = findUnit(mission, target.unit!);
    const g = findGroupOfUnit(mission, target.unit!);
    if (!u || !g) throw new Error(`No unit named '${target.unit}'`);
    if (g.category !== 'plane' && g.category !== 'helicopter') throw new Error(`'${target.unit}' is not an aircraft`);
    units.push(u);
  }
  const types = [...new Set(units.map(u => String(u.type)))];
  if (types.length !== 1) throw new Error(`Group mixes types (${types.join(', ')}); apply per unit`);
  const lib = loadoutsFor(types[0], undefined, scan);
  if (lib.status === 'unknown') throw new Error(lib.notes[0]);
  const loadout = lib.loadouts.find(l => l.name === loadoutName);
  if (!loadout) throw new Error(`No loadout '${loadoutName}' for ${types[0]}; available: ${lib.loadouts.map(l => l.name).slice(0, 40).join(' | ') || 'none'}`);
  const catalogue = authoringData().aircraft[types[0]]?.pylons ?? {};
  const warnings = loadout.pylons.filter(p => Object.keys(catalogue).length && !catalogue[String(p.pylon)]?.includes(p.CLSID))
    .map(p => `pylon ${p.pylon}: ${p.CLSID} is not in the bundled pydcs catalogue (the DCS library is newer)`);
  for (const u of units) {
    const payload = (asTable(u.payload) ?? (u.payload = { pylons: {}, fuel: '0', flare: 0, chaff: 0, gun: 100 })) as LuaTable;
    payload.pylons = Object.fromEntries(loadout.pylons.map(p => [p.pylon, { CLSID: p.CLSID, ...(p.settings ? { settings: structuredClone(p.settings) } : {}) }]));
  }
  return { loadout: loadoutName, type: types[0], units: units.map(u => String(u.name)), pylons: loadout.pylons.length, tasks: loadout.tasks,
    source: loadout.file, warnings };
}
