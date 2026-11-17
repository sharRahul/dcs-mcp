/** Shared offline acceptance: structure/format only, never a claim about DCS AI. */
import luaparse from 'luaparse';
import { readMizArchive } from '../miz/archive.js';
import { parseMissionTables, buildMissionDocument } from '../miz/parser.js';
import { validateMission } from '../miz/validator.js';
import { compileTrig, findGroup } from '../miz/authoring.js';
import { asTable, luaArray } from '../miz/lua.js';
export async function checkMission(path: string) {
  const archive = await readMizArchive(path), { mission, dictionary } = parseMissionTables(archive);
  const doc = buildMissionDocument(mission, dictionary, archive.digest), validation = validateMission(doc, mission);
  const errors = validation.errors.map(e => `${e.code}: ${e.message}`), warnings = validation.warnings.map(e => e.message);
  const parsed = structuredClone(mission), compiled = compileTrig(parsed);
  for (const section of ['conditions', 'actions', 'func', 'funcStartup']) {
    const table = asTable(asTable(mission.trig)?.[section]) ?? {};
    for (const [index, source] of Object.entries(table)) if (typeof source === 'string') {
      try { luaparse.parse(source, { luaVersion: '5.1' }); } catch (e) { errors.push(`Lua 5.1 ${section}[${index}]: ${(e as Error).message}`); }
    }
    for (const index of compiled.compiled) if (table[index] !== asTable(asTable(parsed.trig)?.[section])?.[index]) errors.push(`Stale/missing compiled trigger ${index} (${section})`);
  }
  for (const side of ['blue', 'red', 'offline']) for (const section of ['conditions', 'actions', 'func']) {
    for (const source of Object.values(asTable(asTable(asTable(mission.result)?.[side])?.[section]) ?? {})) if (typeof source === 'string') {
      try { luaparse.parse(source, { luaVersion: '5.1' }); } catch (e) { errors.push(`Goal Lua 5.1 ${side}.${section}: ${(e as Error).message}`); }
    }
  }
  for (const group of doc.groups) {
    for (const u of group.units) if (![u.x, u.y, u.heading ?? 0].every(Number.isFinite) || (u.heading !== undefined && Math.abs(u.heading) >= 2 * Math.PI)) errors.push(`Invalid geometry: ${u.name}`);
    // Arbitrary layouts (wedge/line/naval stations) are valid; do not assume every group is a column.
    const raw = findGroup(mission, group.name)?.group;
    for (const p of luaArray(asTable(raw?.route)?.points)) if (![p.x, p.y].every(v => typeof v === 'number' && Number.isFinite(v))) errors.push(`Invalid route geometry: ${group.name}`);
  }
  const theatre = archive.entries.get('theatre'); if (theatre && theatre.trim() !== doc.theatre) errors.push('Archive theatre and mission theatre differ');
  for (const [key, value] of Object.entries(parseMissionTables(archive).mapResource ?? {})) if (typeof value === 'string' && !archive.manifest.some(e => e.name === `l10n/DEFAULT/${value}`)) errors.push(`Missing resource '${key}': ${value}`);
  return { ok: errors.length === 0, verification: 'offline only; not DCS/AI behavior verification', digest: archive.digest,
    entries: archive.manifest.length, groups: doc.summary.groupCount, units: doc.summary.unitCount, triggers: doc.triggers.length,
    triggerCompilation: { compiled: compiled.compiled.length, preservedUnsupported: compiled.skipped }, errors, warnings };
}
