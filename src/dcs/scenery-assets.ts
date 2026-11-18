/** Read supported local scenery declarations as syntax/data. Never execute mod Lua. */
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import luaparse from 'luaparse';
import { parseLuaAssignment } from '../miz/lua.js';
import { registerTypeSource, type StaticType } from '../data/reference.js';
import { findSavedGamesDirs } from './install.js';

export interface SceneryAsset extends StaticType { file: string }
function member(node: any): string | undefined {
  if (node?.type === 'Identifier') return node.name;
  if (node?.type === 'MemberExpression' && node.indexer === '.') {
    const base = member(node.base); return base ? `${base}.${node.identifier.name}` : undefined;
  }
}
function scalar(node: any): string | number | undefined {
  if (!['StringLiteral', 'NumericLiteral'].includes(node?.type)) return undefined;
  try {
    const value = parseLuaAssignment(`asset={value=${node.raw}}`, 'asset').value;
    return typeof value === 'string' || typeof value === 'number' ? value : undefined;
  } catch { return undefined; }
}
function display(node: any): string | undefined {
  const value = scalar(node);
  if (typeof value === 'string') return value;
  if (node?.type === 'CallExpression' && member(node.base) === '_') {
    const translated = scalar(node.arguments?.[0]); if (typeof translated === 'string') return translated;
  }
}

export function parseSceneryDeclarations(source: string, file: string): SceneryAsset[] {
  if (Buffer.byteLength(source) > 4 * 1024 * 1024) return [];
  let ast: any;
  try { ast = luaparse.parse(source, { luaVersion: '5.1', comments: false }); } catch { return []; }
  const out: SceneryAsset[] = [];
  let cway: Record<string, unknown> = {};
  const add = (fields: Record<string, unknown>) => {
    const type = fields.Name, shape = fields.ShapeName, category = fields.category;
    if (typeof type !== 'string' || !type.length || type.length > 200 || typeof shape !== 'string' || !shape.length) return;
    if (category !== 'Fortification' && category !== 'Personnel') return;
    out.push({ type, name: typeof fields.DisplayName === 'string' ? fields.DisplayName : type,
      shape, category: category === 'Personnel' ? category : 'Fortifications', group: category,
      rate: typeof fields.Rate === 'number' && Number.isFinite(fields.Rate) ? fields.Rate : 1, canCargo: false, file });
  };
  // Only literal, top-level registration statements count. Function bodies,
  // conditional/dynamic declarations and commented code are not registrations.
  for (const statement of ast.body) {
    if (statement.type === 'AssignmentStatement') {
      for (let i = 0; i < statement.variables.length; i++) {
        const key = member(statement.variables[i]), value = statement.init[i];
        if (key === 'CWAY') cway = {};
        else if (key === 'CWAY.visual.shape') cway.ShapeName = scalar(value);
        else if (key?.startsWith('CWAY.')) {
          const field = key.slice(5); if (['Name', 'DisplayName', 'category', 'Rate'].includes(field)) cway[field] = field === 'DisplayName' ? display(value) : scalar(value);
        }
      }
    } else if (statement.type === 'CallStatement') {
      const call = statement.expression, fn = member(call.base);
      if (fn === 'add_surface_unit' && member(call.arguments?.[0]) === 'CWAY') add(cway);
      else if (fn === 'add_structure' || fn === 'add_personnel') {
        const table = call.arguments?.[0]; if (table?.type !== 'TableConstructorExpression') continue;
        const fields: Record<string, unknown> = {};
        for (const f of table.fields) {
          if (f.type !== 'TableKeyString') continue;
          const key = f.key.name; fields[key] = key === 'DisplayName' ? display(f.value) : scalar(f.value);
        }
        add(fields);
      }
    }
  }
  return out;
}

/** Optional local dependencies; absent/unreadable mods contribute nothing. */
export function installedSceneryAssets(env: NodeJS.ProcessEnv = process.env): SceneryAsset[] {
  const out = new Map<string, SceneryAsset>();
  const files = ['Massun92-Humans/Database/db_M92_HumansAssets.lua', 'VPC Airfield Equipment/VPC_Object.lua', 'VPC Airfield Equipment/VPC_NATO_Object.lua'];
  for (const profile of findSavedGamesDirs(env)) for (const relative of files) {
    const file = path.join(profile.path, 'Mods', 'tech', relative);
    try {
      if (statSync(file).size > 4 * 1024 * 1024) continue;
      for (const asset of parseSceneryDeclarations(readFileSync(file, 'utf8'), file)) if (!out.has(asset.type)) out.set(asset.type, asset);
    } catch { /* Local mod unavailable, not a server failure. */ }
  }
  return [...out.values()];
}
export function enableInstalledSceneryTypes(env: NodeJS.ProcessEnv = process.env): SceneryAsset[] {
  const assets = installedSceneryAssets(env), byType = new Map(assets.map(a => [a.type, a]));
  if (assets.length) registerTypeSource({
    find(type) { const entry = byType.get(type); return entry ? { category: 'static', entry } : undefined; },
    list() { return assets.map(a => ({ type: a.type, category: 'static' as const })); },
  }, true);
  return assets;
}
