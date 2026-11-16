/**
 * Warehouse "donor" data: wsType-bearing stock entries harvested from a mission the user supplies
 * (ideally saved by the Mission Editor, whose warehouses file carries the real wsType of every
 * aircraft and weapon it lists). With a donor, NEW stock can be added to a warehouse by copying
 * the donor's own entry — the wsType is never fabricated. Without one, adding stays refused.
 *
 * Harvested: aircraft entries (aircrafts.planes / aircrafts.helicopters, keyed by type) and weapon
 * entries (weapons.<index>, identified by their wsType tuple), from every airport and unit
 * warehouse, first occurrence wins. Each donor is stored as JSON (DCS_MCP_DONOR_DIR, default the
 * user data folder) with the source file's name and sha256. Offline only; DCS behaviour of added
 * stock is unverified.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { createHash } from 'node:crypto';
import { asTable, parseLuaAssignment, type LuaTable } from './lua.js';
import { findUnitType } from '../data/reference.js';
import { readWarehouses } from './logistics.js';
import type { MissionSession } from './sessions.js';

export interface Donor {
  id: string;
  source: { file: string; sha256: string; importedAt: string };
  aircraft: Record<'planes' | 'helicopters', Record<string, LuaTable>>;
  weapons: { key: string; wsType: number[]; entry: LuaTable }[];
  skipped: string[];
}

export function donorDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DCS_MCP_DONOR_DIR) return env.DCS_MCP_DONOR_DIR;
  return env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'dcs-mcp', 'warehouse-donors') : path.join(homedir(), '.dcs-mcp', 'warehouse-donors');
}
const safeId = (id: string) => { if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,47}$/.test(id)) throw new Error('Donor id: 1-48 letters, digits, _ . -'); return id; };
const wsTuple = (v: unknown): number[] | undefined => {
  const t = asTable(v as LuaTable);
  const vals = t ? [1, 2, 3, 4].map(k => t[k]) : [];
  return vals.length === 4 && vals.every(n => typeof n === 'number' && Number.isInteger(n) && n >= 0) ? vals as number[] : undefined;
};
export const wsKey = (ws: number[]) => ws.join('.');

/** Harvest from a warehouses table (pure; used by import and tests). */
export function harvest(table: LuaTable): Omit<Donor, 'id' | 'source'> {
  const aircraft: Donor['aircraft'] = { planes: {}, helicopters: {} };
  const weapons: Donor['weapons'] = [];
  const skipped: string[] = [];
  for (const kind of ['airports', 'warehouses'] as const) {
    for (const [wid, wh] of Object.entries(asTable(table[kind]) ?? {})) {
      const w = asTable(wh as LuaTable);
      if (!w) continue;
      for (const cat of ['planes', 'helicopters'] as const) {
        for (const [type, entry] of Object.entries(asTable(asTable(w.aircrafts)?.[cat]) ?? {})) {
          const e = asTable(entry as LuaTable);
          if (!e || !wsTuple(e.wsType)) { skipped.push(`${kind}:${wid} ${cat}/${type}: no valid wsType`); continue; }
          const ref = findUnitType(type);
          if (!ref) { skipped.push(`${kind}:${wid} ${cat}/${type}: unknown type`); continue; }
          if (ref.category !== (cat === 'planes' ? 'plane' : 'helicopter')) { skipped.push(`${type}: listed under ${cat} but is a ${ref.category}`); continue; }
          aircraft[cat][type] ??= structuredClone(e);
        }
      }
      for (const [index, entry] of Object.entries(asTable(w.weapons) ?? {})) {
        const e = asTable(entry as LuaTable), ws = e && wsTuple(e.wsType);
        if (!e || !ws) { skipped.push(`${kind}:${wid} weapon ${index}: no valid wsType`); continue; }
        if (!weapons.some(x => x.key === wsKey(ws))) weapons.push({ key: wsKey(ws), wsType: ws, entry: structuredClone(e) });
      }
    }
  }
  return { aircraft, weapons, skipped };
}

export function importDonor(file: string, id: string, dir = donorDir(), overwrite = false) {
  safeId(id);
  const bytes = readFileSync(file);
  const zipEntry = new AdmZip(bytes).getEntry('warehouses');
  if (!zipEntry) throw new Error(`${path.basename(file)} has no warehouses entry`);
  const h = harvest(parseLuaAssignment(zipEntry.getData().toString('utf8'), 'warehouses'));
  const total = Object.keys(h.aircraft.planes).length + Object.keys(h.aircraft.helicopters).length + h.weapons.length;
  if (!total) throw new Error('No wsType-bearing stock entries found in that mission; nothing to import');
  const donor: Donor = { id, source: { file: path.basename(file), sha256: createHash('sha256').update(bytes).digest('hex'), importedAt: new Date().toISOString() }, ...h };
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${id}.json`);
  if (existsSync(target) && !overwrite) throw new Error(`Donor '${id}' already exists; pass overwrite=true`);
  writeFileSync(`${target}.tmp`, JSON.stringify(donor));
  renameSync(`${target}.tmp`, target);
  return { id, source: donor.source, planes: Object.keys(h.aircraft.planes).length, helicopters: Object.keys(h.aircraft.helicopters).length,
    weapons: h.weapons.length, skipped: h.skipped.length };
}

export function loadDonor(id: string, dir = donorDir()): Donor {
  const file = path.join(dir, `${safeId(id)}.json`);
  if (!existsSync(file)) throw new Error(`No warehouse donor '${id}'; import one with dcs_import_warehouse_donor`);
  return JSON.parse(readFileSync(file, 'utf8')) as Donor;
}

export function listDonors(dir = donorDir()) {
  let files: string[] = [];
  try { files = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.json')) : []; } catch { return []; }
  return files.flatMap(f => { try { const d = JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as Donor;
    return [{ id: d.id, source: d.source, planes: Object.keys(d.aircraft.planes), helicopters: Object.keys(d.aircraft.helicopters), weapons: d.weapons.map(w => w.key) }]; } catch { return []; } });
}

export interface AddStock { aircraft?: { category: 'planes' | 'helicopters'; type: string; quantity: number }[]; weapons?: { wsType: string; quantity: number }[] }

/** Add NEW stock to one warehouse by copying donor entries. Existing entries are left to edit_warehouse. */
export function addStockFromDonor(session: MissionSession, kind: 'airports' | 'warehouses', id: number, donor: Donor, add: AddStock): LuaTable {
  const copy = structuredClone(readWarehouses(session));
  const entry = asTable(asTable(copy[kind])?.[id]);
  if (!entry) throw new Error(`No ${kind} warehouse ${id}; create it first (dcs_miz_edit_warehouse create=true)`);
  for (const a of add.aircraft ?? []) {
    const src = donor.aircraft[a.category][a.type];
    if (!src) throw new Error(`Donor '${donor.id}' has no ${a.category} entry for '${a.type}'`);
    const cat = ((entry.aircrafts ??= {}) as LuaTable)[a.category] ??= {};
    if (asTable(cat as LuaTable)?.[a.type]) throw new Error(`${a.type} is already stocked here; change its quantity with dcs_miz_edit_warehouse`);
    (cat as LuaTable)[a.type] = { ...structuredClone(src), initialAmount: a.quantity, unlimited: false };
    entry.unlimitedAircrafts = false;
  }
  for (const w of add.weapons ?? []) {
    const src = donor.weapons.find(x => x.key === w.wsType);
    if (!src) throw new Error(`Donor '${donor.id}' has no weapon with wsType ${w.wsType}`);
    const weapons = (entry.weapons ??= {}) as LuaTable;
    if (Object.values(weapons).some(e => { const ws = wsTuple(asTable(e as LuaTable)?.wsType); return ws && wsKey(ws) === w.wsType; }))
      throw new Error(`Weapon ${w.wsType} is already stocked here; change its quantity with dcs_miz_edit_warehouse`);
    const next = Math.max(0, ...Object.keys(weapons).map(Number).filter(Number.isFinite)) + 1;
    weapons[next] = { ...structuredClone(src.entry), initialAmount: w.quantity };
    entry.unlimitedMunitions = false;
  }
  return copy;
}
