/**
 * Import an air-defence site layout from a mission the user supplies (ideally saved by the
 * Mission Editor): unit types in order and each unit's exact offset from the lead, measured
 * along / right of the lead's heading, so placement reproduces the source layout at any
 * position and heading. Stored as JSON under DCS_MCP_TEMPLATE_DIR (default: the user data
 * folder next to terrain packs) with the source file's sha256 and group name.
 *
 * Provenance is "imported": this project has not flown it and cannot prove the source was
 * ME-saved. Per-unit headings relative to the lead are not kept (placement gives every unit
 * the group heading, as the rest of the authoring API does) and the result says so.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { readMizArchive } from './archive.js';
import { asTable, luaArray, parseLuaAssignment, type LuaTable } from './lua.js';
import { findGroup } from './authoring.js';
import { findUnitType } from '../data/reference.js';
import type { SiteTemplate } from './templates.js';

export function templateDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DCS_MCP_TEMPLATE_DIR) return env.DCS_MCP_TEMPLATE_DIR;
  return env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'dcs-mcp', 'templates') : path.join(homedir(), '.dcs-mcp', 'templates');
}
const safeId = (id: string) => { if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,47}$/.test(id)) throw new Error('Template id: 1-48 letters, digits, space, _ . -'); return id; };
const fileFor = (dir: string, id: string) => path.join(dir, `${safeId(id).replace(/[ .]/g, '_')}.json`);

/** Imported templates on disk; an unreadable file is skipped, never fatal. */
export function loadImportedTemplates(dir = templateDir()): SiteTemplate[] {
  let files: string[] = [];
  try { files = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.json')) : []; } catch { return []; }
  const out: SiteTemplate[] = [];
  for (const f of files) {
    try {
      const t = JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as SiteTemplate;
      if (t.provenance === 'imported' && Array.isArray(t.composition) && Array.isArray(t.offsets)) out.push(t);
    } catch { /* skipped */ }
  }
  return out;
}

export interface ImportArgs { file: string; group: string; id: string; description?: string; skynetRole?: 'sam' | 'ewr'; overwrite?: boolean }

export async function importSiteTemplate(args: ImportArgs, builtInIds: string[], dir = templateDir()) {
  safeId(args.id);
  if (builtInIds.some(b => b.toLowerCase() === args.id.toLowerCase())) throw new Error(`'${args.id}' is a built-in template id; choose another`);
  const archive = await readMizArchive(args.file);
  const source = archive.entries.get('mission');
  if (!source) throw new Error('No mission entry in that .miz');
  const mission = parseLuaAssignment(source, 'mission');
  const found = findGroup(mission, args.group);
  if (!found) throw new Error(`No group named '${args.group}' in ${path.basename(args.file)}`);
  if (found.category !== 'vehicle') throw new Error(`'${args.group}' is a ${found.category} group; site templates are ground vehicle groups`);
  const units = luaArray(found.group.units);
  if (units.length < 2) throw new Error('A site template needs at least 2 units');
  const unknown = [...new Set(units.map(u => String(u.type)).filter(t => !findUnitType(t)))];
  if (unknown.length) throw new Error(`Unknown unit types (not in the DCS catalogue): ${unknown.join(', ')}`);
  const lead = units[0];
  const h = Number(lead.heading ?? 0), cos = Math.cos(h), sin = Math.sin(h);
  const r = (n: number) => Math.round(n * 100) / 100;
  const offsets = units.map(u => {
    const dx = Number(u.x) - Number(lead.x), dy = Number(u.y) - Number(lead.y);
    return { forward: r(dx * cos + dy * sin), right: r(-dx * sin + dy * cos) };
  });
  // Consecutive same-type units collapse into composition blocks; order is preserved.
  const composition: { type: string; count: number }[] = [];
  for (const u of units) {
    const last = composition[composition.length - 1];
    if (last && last.type === u.type) last.count++; else composition.push({ type: String(u.type), count: 1 });
  }
  const turned = units.filter(u => Math.abs(Number(u.heading ?? 0) - h) > 1e-3).length;
  const template: SiteTemplate = {
    id: args.id, provenance: 'imported',
    description: args.description ?? `${composition.map(c => `${c.count}x ${c.type}`).join(', ')} (imported from ${path.basename(args.file)}:${args.group})`,
    composition, spacingMetres: 0, skynetRole: args.skynetRole ?? 'sam', offsets,
    source: { file: path.basename(args.file), sha256: archive.digest, group: args.group, theatre: String(mission.theatre ?? ''), importedAt: new Date().toISOString() },
  };
  mkdirSync(dir, { recursive: true });
  const file = fileFor(dir, args.id);
  if (existsSync(file) && !args.overwrite) throw new Error(`Template '${args.id}' already exists; pass overwrite=true to replace it`);
  writeFileSync(`${file}.tmp`, JSON.stringify(template, null, 1));
  renameSync(`${file}.tmp`, file);
  return { id: args.id, provenance: template.provenance, units: units.length, composition, source: template.source,
    warnings: [
      ...(turned ? [`${turned} unit(s) face a different way from the lead; placement gives every unit the group heading.`] : []),
      'Imported from a user-supplied mission; not flown by this project and not proven ME-saved.',
    ] };
}

export function removeImportedTemplate(id: string, dir = templateDir()) {
  const file = fileFor(dir, id);
  if (!existsSync(file)) throw new Error(`No imported template '${id}'`);
  rmSync(file);
  return { removed: id };
}
