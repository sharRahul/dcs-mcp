/**
 * The DCS payload library (the Mission Editor's named loadouts), read from the user's own
 * install the way pydcs 1.0.0 payloads.py / unittype.py do, in pydcs's order of preference:
 *   <Saved Games/DCS profile>/MissionEditor/UnitPayloads   (user loadouts)
 *   <install>/MissionEditor/data/scripts/UnitPayloads      (stock)
 *   <install>/CoreMods/aircraft/<x>/UnitPayloads           (stock, per airframe)
 *   <Saved Games/DCS profile>/Mods/Aircraft/<x>/UnitPayloads (mods)
 * A loadout name found in an earlier directory wins, as in pydcs.
 *
 * Files are parsed as DATA (lua.ts parseLuaDataFile): `[local] unitPayloads = {...}` with the
 * main-task names as the only allowed bare identifiers (pydcs _UnitPayloadGlobals). Nothing is
 * executed. Like mods.ts and liveries.ts this never throws: an unreadable or non-data file is
 * skipped and reported, and "no directories found" means UNKNOWN, not "no loadouts".
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { authoringData } from '../data/authoring.js';
import { asTable, luaArray, parseLuaDataFile, type LuaTable } from '../miz/lua.js';
import { findSavedGamesDirs } from './install.js';
import { defaultInstallDirs } from './mods.js';

export interface Loadout { name: string; tasks: string[]; pylons: { pylon: number; CLSID: string; settings?: LuaTable }[]; file: string }
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const list = (d: string) => { try { return existsSync(d) ? readdirSync(d) : []; } catch { return []; } };
const isDir = (d: string) => { try { return statSync(d).isDirectory(); } catch { return false; } };

export function payloadDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const saved = findSavedGamesDirs(env).map(s => s.path);
  const installs = env.DCS_INSTALL_DIR ? [env.DCS_INSTALL_DIR] : defaultInstallDirs(env);
  const dirs: string[] = [];
  for (const sg of saved) dirs.push(path.join(sg, 'MissionEditor', 'UnitPayloads'));
  for (const root of installs) {
    dirs.push(path.join(root, 'MissionEditor', 'data', 'scripts', 'UnitPayloads'));
    const ac = path.join(root, 'CoreMods', 'aircraft');
    for (const e of list(ac)) dirs.push(path.join(ac, e, 'UnitPayloads'));
  }
  for (const sg of saved) { const m = path.join(sg, 'Mods', 'Aircraft'); for (const e of list(m)) dirs.push(path.join(m, e, 'UnitPayloads')); }
  return dirs.filter(isDir);
}

function taskConstants(): Record<string, number> {
  return Object.fromEntries(Object.entries(authoringData().mainTasks).map(([k, v]) => [k, v.id]));
}
const taskNames = () => Object.fromEntries(Object.values(authoringData().mainTasks).map(v => [v.id, v.name]));

let cache: { at: number; dirs: string[]; byType: Map<string, Loadout[]>; skipped: { file: string; reason: string }[] } | undefined;

export function scanPayloads(refresh = false, dirs?: string[]) {
  if (!refresh && !dirs && cache && Date.now() - cache.at < 60_000) return cache;
  const scanDirs = dirs ?? payloadDirs();
  const byType = new Map<string, Loadout[]>(), skipped: { file: string; reason: string }[] = [];
  const constants = taskConstants(), names = taskNames();
  for (const dir of scanDirs) {
    for (const f of list(dir).filter(n => n.toLowerCase().endsWith('.lua'))) {
      const file = path.join(dir, f);
      try {
        if (statSync(file).size > MAX_FILE_BYTES) { skipped.push({ file, reason: 'larger than 4 MB' }); continue; }
        const data = parseLuaDataFile(readFileSync(file, 'utf8'), 'unitPayloads', constants);
        const type = String(data.unitType ?? '');
        if (!type) { skipped.push({ file, reason: 'no unitType' }); continue; }
        const bucket = byType.get(type) ?? [];
        for (const p of luaArray(asTable(data.payloads) ?? {})) {
          const name = String(p.name ?? '');
          if (!name || bucket.some(l => l.name === name)) continue; // earlier directory wins
          const pylons = Object.values(asTable(p.pylons) ?? {}).map(v => asTable(v)!).filter(Boolean)
            .map(py => ({ pylon: Number(py.num), CLSID: String(py.CLSID ?? ''), ...(asTable(py.settings) ? { settings: asTable(py.settings)! } : {}) }))
            .filter(py => Number.isInteger(py.pylon) && py.pylon > 0 && py.CLSID)
            .sort((a, b) => a.pylon - b.pylon);
          const tasks = Object.values(asTable(p.tasks) ?? {}).map(t => names[Number(t)] ?? String(t));
          bucket.push({ name, tasks, pylons, file });
        }
        byType.set(type, bucket);
      } catch (e) { skipped.push({ file, reason: (e as Error).message.slice(0, 200) }); }
    }
  }
  const out = { at: Date.now(), dirs: scanDirs, byType, skipped };
  if (!dirs) cache = out;
  return out;
}

export function loadoutsFor(type: string, task?: string, scan = scanPayloads()) {
  const all = scan.byType.get(type) ?? [];
  const filtered = task ? all.filter(l => l.tasks.some(t => t.toLowerCase() === task.toLowerCase())) : all;
  return { type, scannedDirs: scan.dirs.length, status: scan.dirs.length ? 'scanned' : 'unknown', loadouts: filtered,
    skippedFiles: scan.skipped.length,
    notes: scan.dirs.length ? [] : ['No DCS payload directories found (set DCS_INSTALL_DIR / DCS_SAVED_GAMES); loadouts are unknown, not absent.'] };
}
