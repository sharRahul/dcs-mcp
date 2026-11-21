/**
 * Aircraft definitions from the DCS install's own CoreMods, read as TEXT.
 *
 * `CoreMods/aircraft/<module>/*.lua` and `CoreMods/WWII Units/...` hold ED's (and
 * third parties') unit definitions: `Name`, `DisplayName`, masses, `M_fuel_max`,
 * dimensions, `passivCounterm` chaff/flare defaults, `Tasks = { aircraft_task(X) }`
 * and the pylon `CLSID`s. They are current to the installed build, unlike the pinned
 * pydcs catalogue, and cover stock types pydcs never had.
 *
 * Nothing is executed. A field is taken only when it is a numeric LITERAL
 * (`M_fuel_max = 333.69`); an expression (`M_empty = base + 79.8`) yields null, never a
 * guess. Task identifiers are mapped through pydcs's main-task table and anything it
 * does not list is reported, not invented. A definition block starts at the `Name = '...'` with the same indentation as its
 * `M_max`/`M_fuel_max`, which skips the nested `Name =` fields of carrier/datalink tables.
 *
 * The bundled catalogue always wins on a type id (`findUnitType` checks it first); this
 * source only fills types pydcs does not know, and `compareWithCatalogue` reports where the
 * installed numbers differ from pydcs's.
 */
import path from 'node:path';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { findInstallDirs, readText } from './install-info.js';
import { authoringData } from '../data/authoring.js';
import { registerInstallTypeSource, unitTypes, type FlyingType } from '../data/reference.js';

export interface CoreModAircraft {
  type: string;
  displayName: string | null;
  category: 'plane' | 'helicopter';
  module: string;
  file: string;
  massEmptyKg: number | null;
  massNominalKg: number | null;
  massMaxKg: number | null;
  fuelMaxKg: number | null;
  ceilingMetres: number | null;
  rangeKm: number | null;
  length: number | null;
  height: number | null;
  wingSpan: number | null;
  rotorDiameter: number | null;
  chaff: number | null;
  flare: number | null;
  tasks: string[];
  unknownTaskIds: string[];
  defaultTask: string | null;
  clsids: string[];
}

const list = (d: string) => { try { return existsSync(d) ? readdirSync(d) : []; } catch { return []; } };
const isDir = (d: string) => { try { return statSync(d).isDirectory(); } catch { return false; } };

function luaFiles(dir: string, depth = 0, out: string[] = []): string[] {
  if (depth > 3 || out.length > 400) return out;
  for (const name of list(dir)) {
    const full = path.join(dir, name);
    if (isDir(full)) { if (!/^(Liveries|Shapes|Textures|bin|Sounds|ImagesGui|Encyclopedia|Cockpit|Skins|Doc)$/i.test(name)) luaFiles(full, depth + 1, out); }
    else if (/\.lua$/i.test(name)) out.push(full);
  }
  return out;
}

const stripComments = (s: string) => s.replace(/--\[(=*)\[[\s\S]*?\]\1\]/g, '').replace(/--[^\n]*/g, '');

function num(block: string, field: string): number | null {
  const m = new RegExp(`(?:^|[\\s,{;])${field}\\s*=\\s*(-?\\d+(?:\\.\\d+)?(?:[eE][-+]?\\d+)?)\\s*(?:,|;|\\n|})`, 'm').exec(block);
  return m ? Number(m[1]) : null;
}

/** Definitions in one file's text. Exported for tests. */
export function parseAircraftDefinitions(text: string, module: string, file: string): CoreModAircraft[] {
  const src = stripComments(text);
  const lines = src.split(/\r?\n/);
  // A definition's Name sits at the SAME indentation as its M_max / M_fuel_max: that
  // skips nested Name fields (carrier tables, datalinks) and needs no DisplayName nearby.
  const indent = (l: string) => (/^[	 ]*/.exec(l)![0]).replace(/	/g, '    ').length;
  const starts: { line: number; type: string }[] = [];
  lines.forEach((l, i) => {
    if (!/^\s*M_(fuel_)?max\s*=/.test(l)) return;
    for (let j = i - 1; j >= 0 && j > i - 800; j--) {
      const m = /^\s*Name\s*=\s*['"]([^'"]+)['"]/.exec(lines[j]);
      if (m && indent(lines[j]) === indent(l)) { if (!starts.some(s => s.line === j)) starts.push({ line: j, type: m[1] }); break; }
    }
  });
  starts.sort((a, b) => a.line - b.line);
  const tasksTable = authoringData().mainTasks;
  return starts.map((s, k) => {
    const block = lines.slice(s.line, starts[k + 1]?.line ?? lines.length).join('\n');
    const display = /DisplayName\s*=\s*_?\(?\s*['"]([^'"]+)['"]/.exec(block)?.[1] ?? null;
    const taskBlock = /\bTasks\s*=\s*\{([\s\S]*?)\}/.exec(block)?.[1] ?? '';
    const ids = [...taskBlock.matchAll(/aircraft_task\(\s*([A-Za-z_]\w*)\s*\)/g)].map(m => m[1]);
    const tasks: string[] = [], unknown: string[] = [];
    for (const id of ids) (tasksTable[id] ? tasks.push(tasksTable[id].name) : unknown.push(id));
    const defId = /DefaultTask\s*=\s*aircraft_task\(\s*([A-Za-z_]\w*)\s*\)/.exec(block)?.[1];
    const counter = /passivCounterm\s*=\s*\{([\s\S]*?)\n\s*\}/.exec(block)?.[1] ?? '';
    const cm = (kind: string) => { const m = new RegExp(`${kind}\\s*=\\s*\\{[^}]*default\\s*=\\s*(\\d+)`).exec(counter); return m ? Number(m[1]) : null; };
    const rotor = num(block, 'rotor_diameter');
    return {
      type: s.type, displayName: display, category: rotor !== null || /\bMainRotor\b|\brotor_RPM\b/.test(block) ? 'helicopter' : 'plane',
      module, file,
      massEmptyKg: num(block, 'M_empty'), massNominalKg: num(block, 'M_nominal'), massMaxKg: num(block, 'M_max'), fuelMaxKg: num(block, 'M_fuel_max'),
      ceilingMetres: num(block, 'H_max'), rangeKm: num(block, 'range'),
      length: num(block, 'length'), height: num(block, 'height'), wingSpan: num(block, 'wing_span'), rotorDiameter: rotor,
      chaff: cm('chaff'), flare: cm('flare'),
      tasks: [...new Set(tasks)], unknownTaskIds: [...new Set(unknown)],
      defaultTask: defId ? tasksTable[defId]?.name ?? null : null,
      clsids: [...new Set([...block.matchAll(/CLSID\s*=\s*["']([^"']+)["']/g)].map(m => m[1]))],
    } satisfies CoreModAircraft;
  }).filter(d => d.fuelMaxKg !== null || d.massMaxKg !== null);
}

let cache: { root: string | null; aircraft: CoreModAircraft[] } | undefined;

/** Every aircraft definition under the install's CoreMods. Never throws; no install = empty. */
export function coreModAircraft(env: NodeJS.ProcessEnv = process.env, refresh = false): { root: string | null; aircraft: CoreModAircraft[] } {
  if (cache && !refresh) return cache;
  const root = findInstallDirs(env).find(r => isDir(path.join(r.path, 'CoreMods')))?.path ?? null;
  const seen = new Map<string, CoreModAircraft>();
  if (root) {
    for (const group of ['aircraft', 'WWII Units']) {
      const base = path.join(root, 'CoreMods', group);
      const modules = group === 'aircraft' ? list(base).filter(d => isDir(path.join(base, d))).map(d => path.join(base, d)) : [base];
      for (const dir of modules) {
        const module = path.relative(path.join(root, 'CoreMods'), dir).replace(/\\/g, '/');
        for (const file of luaFiles(dir)) {
          const text = readText(file);
          if (!text || !/M_fuel_max|M_max/.test(text)) continue;
          for (const def of parseAircraftDefinitions(text, module, path.relative(root, file).replace(/\\/g, '/'))) if (!seen.has(def.type)) seen.set(def.type, def);
        }
      }
    }
  }
  cache = { root, aircraft: [...seen.values()].sort((a, b) => a.type.localeCompare(b.type)) };
  return cache;
}

function bundledFlying(type: string): (FlyingType & { category: 'plane' | 'helicopter' }) | undefined {
  const all = unitTypes() as unknown as Record<string, FlyingType[]>;
  for (const category of ['plane', 'helicopter'] as const) {
    const hit = all[category]?.find(t => t.type === type);
    if (hit) return { ...hit, category };
  }
  return undefined;
}

/** Where the installed definition and the pinned pydcs catalogue disagree, plus types pydcs lacks. */
export function compareWithCatalogue(aircraft = coreModAircraft().aircraft) {
  const notInCatalogue: string[] = [], differences: { type: string; field: string; installed: number; bundled: number }[] = [];
  for (const a of aircraft) {
    const b = bundledFlying(a.type);
    if (!b) { notInCatalogue.push(a.type); continue; }
    for (const [field, inst, bund] of [['fuelMax', a.fuelMaxKg, b.fuelMax], ['chaff', a.chaff, b.chaff], ['flare', a.flare, b.flare], ['length', a.length, b.length], ['height', a.height, b.height]] as const) {
      if (inst !== null && bund !== null && bund !== undefined && Math.abs(inst - bund) > 0.5) differences.push({ type: a.type, field, installed: inst, bundled: bund });
    }
  }
  return { notInCatalogue, differences };
}

/**
 * Make CoreMods aircraft that pydcs lacks placeable WITH their first-party fuel,
 * dimensions, countermeasures and tasks. Width is the wing span or rotor diameter.
 */
export function enableCoreModTypes(env: NodeJS.ProcessEnv = process.env): number {
  const { aircraft } = coreModAircraft(env);
  const extra = new Map(aircraft.filter(a => !bundledFlying(a.type)).map(a => [a.type, a]));
  registerInstallTypeSource(extra.size ? {
    find(type) {
      const a = extra.get(type);
      if (!a) return undefined;
      return { category: a.category, entry: { type: a.type, fuelMax: a.fuelMaxKg, width: a.wingSpan ?? a.rotorDiameter, length: a.length, height: a.height,
        chaff: a.chaff, flare: a.flare, tasks: a.tasks, defaultTask: a.defaultTask } satisfies FlyingType };
    },
    list() { return [...extra.values()].map(a => ({ type: a.type, category: a.category })); },
  } : undefined);
  return extra.size;
}
