/**
 * Installed aircraft liveries, found the way pydcs 1.0.0 liveries/liveryscanner.py does:
 * the same DCS-install and Saved Games paths, unit folders matched case-insensitively,
 * the livery id = the folder (or .zip) name written to unit.livery_id.
 *
 * description.lua is read as TEXT for `name = "..."` and `countries = { ... }` — never
 * executed. Zipped liveries are listed by id only. Like mods.ts, this never throws: an
 * unreadable folder simply yields fewer liveries, and "nothing found" means UNKNOWN,
 * not "not installed".
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { findSavedGamesDirs } from './install.js';
import { defaultInstallDirs } from './mods.js';
import { authoringData } from '../data/authoring.js';
import { findCountry } from '../data/reference.js';

export interface InstalledLivery { id: string; name: string; countries: string[] | null; source: string; zipped: boolean }
const MAX_DESC_BYTES = 256 * 1024;

function list(dir: string): string[] { try { return existsSync(dir) ? readdirSync(dir) : []; } catch { return []; } }
function isDir(p: string): boolean { try { return statSync(p).isDirectory(); } catch { return false; } }

export function parseDescription(text: string, id: string): { name: string; countries: string[] | null } {
  const src = text.replace(/--\[\[[\s\S]*?\]\]/g, '').replace(/--[^\n]*/g, '');
  const name = /^\s*name\s*=\s*(["'])(.*?)\1/m.exec(src)?.[2] ?? id;
  const block = /^\s*countries\s*=\s*\{([^}]*)\}/m.exec(src)?.[1];
  const countries = block === undefined ? null : [...block.matchAll(/(["'])(.*?)\1/g)].map(m => m[2]);
  return { name, countries };
}

/** The 'Liveries' roots pydcs scans: install (CoreMods/*, Bazar, campaigns, tech) then Saved Games. */
export function liveryRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const roots: string[] = [];
  const installs = env.DCS_INSTALL_DIR ? [env.DCS_INSTALL_DIR] : defaultInstallDirs(env);
  const modLiveries = (dir: string) => list(dir).map(m => path.join(dir, m, 'Liveries'));
  for (const root of installs) {
    roots.push(...modLiveries(path.join(root, 'CoreMods', 'aircraft')), ...modLiveries(path.join(root, 'CoreMods', 'WWII Units')),
      path.join(root, 'Bazar', 'Liveries'), ...modLiveries(path.join(root, 'Mods', 'campaigns')),
      ...modLiveries(path.join(root, 'CoreMods', 'tech')), path.join(root, 'Mods', 'tech', 'WWII Units', 'Liveries'));
  }
  for (const sg of findSavedGamesDirs(env)) roots.push(path.join(sg.path, 'Liveries'), ...modLiveries(path.join(sg.path, 'Mods', 'aircraft')));
  return roots.filter(isDir);
}

let cache: { at: number; roots: string[]; map: Map<string, InstalledLivery[]> } | undefined;

/** Map of UPPER-CASE unit folder -> liveries. */
export function scanLiveries(refresh = false, roots?: string[]): { roots: string[]; map: Map<string, InstalledLivery[]> } {
  if (!refresh && !roots && cache && Date.now() - cache.at < 60_000) return cache;
  const scanRoots = roots ?? liveryRoots();
  const map = new Map<string, InstalledLivery[]>();
  for (const root of scanRoots) {
    for (const unitDir of list(root)) {
      const unitPath = path.join(root, unitDir), unit = unitDir.toUpperCase();
      if (unit.includes('COCKPIT') || !isDir(unitPath)) continue;
      const bucket = map.get(unit) ?? [];
      for (const entry of list(unitPath)) {
        const zipped = entry.toLowerCase().endsWith('.zip');
        const id = zipped ? entry.slice(0, -4) : entry;
        if (id === 'placeholder' || bucket.some(l => l.id === id)) continue;
        const full = path.join(unitPath, entry);
        if (!zipped && !isDir(full)) continue;
        let meta = { name: id, countries: null as string[] | null };
        if (!zipped) {
          try {
            const file = path.join(full, 'description.lua');
            if (existsSync(file) && statSync(file).size <= MAX_DESC_BYTES) meta = parseDescription(readFileSync(file, 'latin1'), id);
          } catch { /* fewer details, never an error */ }
        }
        bucket.push({ id, ...meta, source: unitPath, zipped });
      }
      if (bucket.length) map.set(unit, bucket);
    }
  }
  const out = { at: Date.now(), roots: scanRoots, map };
  if (!roots) cache = out;
  return out;
}

export function liveriesForType(type: string, scan = scanLiveries()) {
  const folder = (authoringData().aircraft[type]?.liveryName ?? type).toUpperCase();
  return { type, folder, scannedRoots: scan.roots.length, liveries: scan.map.get(folder) ?? [] };
}

/** installed | not_installed | unknown (no livery roots found on this machine). */
export function liveryStatus(type: string, id: string, country?: string, scan = scanLiveries()) {
  if (!scan.roots.length) return { status: 'unknown' as const, reason: 'No DCS livery folders found (set DCS_INSTALL_DIR / DCS_SAVED_GAMES)' };
  const { liveries, folder } = liveriesForType(type, scan);
  const hit = liveries.find(l => l.id.toLowerCase() === id.toLowerCase());
  if (!hit) return { status: 'not_installed' as const, reason: `No livery '${id}' under any Liveries/${folder} folder` };
  const short = country ? (findCountry(country)?.short ?? country) : undefined;
  if (short && hit.countries && !hit.countries.includes(short))
    return { status: 'installed' as const, reason: `Livery is restricted to ${hit.countries.join(', ')}` };
  return { status: 'installed' as const };
}
