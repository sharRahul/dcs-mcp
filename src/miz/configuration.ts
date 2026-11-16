/** Typed mission structure/weather edits. Field evidence: pydcs 1.0.0 mission/weather/coalition. */
import { z } from 'zod';
import { asTable, luaArray, type LuaTable } from './lua.js';
import { countryId, ensureCountry, eachGroup } from './authoring.js';
import { resolveTheatreName } from '../data/reference.js';
import { setMissionOptions, type MissionOptionsArgs } from './editing.js';
export const xySchema = z.object({ x: z.number().finite(), y: z.number().finite() }).strict();
export const sideSchema = z.enum(['blue', 'red', 'neutrals']);
const wind = z.object({ speed: z.number().min(0).max(100), dir: z.number().min(0).max(359) }).strict();
export const weatherEditSchema = z.object({
  atmosphereType: z.literal(0).optional().describe("Static atmosphere only; dynamic cyclone generation is unsupported"),
  temperatureCelsius: z.number().min(-80).max(60).optional(), qnhMmHg: z.number().min(600).max(850).optional(),
  wind: z.object({ atGround: wind.optional(), at2000: wind.optional(), at8000: wind.optional() }).strict().optional(),
  clouds: z.object({ base: z.number().min(0).max(20000).optional(), thickness: z.number().min(0).max(20000).optional(), density: z.number().int().min(0).max(10).optional(),
    iprecptns: z.number().int().min(0).max(2).optional(), preset: z.string().regex(/^Preset\d+$/).nullable().optional() }).strict().optional(),
  visibilityMetres: z.number().min(100).max(200000).optional(), turbulence: z.number().min(0).max(100).optional(),
  fog: z.object({ enabled: z.boolean(), thickness: z.number().min(0).max(10000).optional(), visibility: z.number().min(0).max(100000).optional() }).strict().optional(),
  dust: z.object({ enabled: z.boolean(), density: z.number().min(0).max(3000) }).strict().optional(),
}).strict();
export const configurationSchema = z.object({
  theatre: z.string().min(1).optional(),
  countries: z.array(z.object({ name: z.string().min(1), side: sideSchema }).strict()).max(100).optional(),
  date: z.object({ year: z.number().int().min(1900).max(2100), month: z.number().int().min(1).max(12), day: z.number().int().min(1).max(31) }).strict().optional(),
  forcedOptions: z.record(z.union([z.boolean(), z.number().finite(), z.string()])).optional(), clearForcedOptions: z.array(z.string()).max(100).optional(),
  startTime: z.number().int().min(0).max(86399).optional(), weather: weatherEditSchema.optional(),
  title: z.string().max(1000).optional(), briefing: z.string().max(100000).optional(),
  coalitionBriefing: z.object({ blue: z.string().max(100000).optional(), red: z.string().max(100000).optional(), neutrals: z.string().max(100000).optional() }).strict().optional(),
  bullseyes: z.object({ blue: xySchema.optional(), red: xySchema.optional(), neutrals: xySchema.optional() }).strict().optional(),
}).strict();
export function configureMission(mission: LuaTable, input: z.input<typeof configurationSchema>) {
  const a = configurationSchema.parse(input), copy = structuredClone(mission);
  if (a.theatre) {
    const theatre = resolveTheatreName(a.theatre); if (!theatre) throw new Error('Unknown theatre; use the bundled theatre catalogue');
    let occupied = false; eachGroup(copy, () => { occupied = true; });
    if (theatre !== copy.theatre && (occupied || luaArray(asTable(copy.triggers)?.zones).length || Object.keys(asTable(copy.drawings) ?? {}).length))
      throw new Error('Cannot change theatre with placed content; create a new mission and transform coordinates explicitly');
    if (theatre !== copy.theatre) {
      for (const side of ['blue', 'red', 'neutrals']) {
        const coalition = asTable(asTable(copy.coalition)?.[side]);
        if (coalition) { delete coalition.bullseye; delete coalition.nav_points; }
      }
      copy.theatre = theatre;
    }
  }
  const requested = new Map<number, string>();
  for (const c of a.countries ?? []) {
    const id = countryId(c.name);
    if (requested.has(id) && requested.get(id) !== c.side) throw new Error(`Country '${c.name}' requested on two sides`);
    requested.set(id, c.side); ensureCountry(copy, c.side, c.name, id);
  }
  setMissionOptions(copy, { date: a.date, startTime: a.startTime, forcedOptions: a.forcedOptions as MissionOptionsArgs["forcedOptions"], clearForcedOptions: a.clearForcedOptions as MissionOptionsArgs["clearForcedOptions"] });
  const w = (copy.weather ??= {}) as LuaTable;
  const spec = a.weather;
  if (spec) {
    if (spec.atmosphereType !== undefined) w.atmosphere_type = spec.atmosphereType;
    if (spec.temperatureCelsius !== undefined) ((w.season ??= {}) as LuaTable).temperature = spec.temperatureCelsius;
    if (spec.qnhMmHg !== undefined) w.qnh = spec.qnhMmHg;
    if (spec.wind) for (const [level, values] of Object.entries(spec.wind)) if (values) {
      const levels = (w.wind ??= {}) as LuaTable;
      levels[level] = { ...(asTable(levels[level]) ?? {}), ...values };
    }
    if (spec.clouds) {
      const clouds = (w.clouds ??= {}) as LuaTable;
      for (const [key, value] of Object.entries(spec.clouds)) {
        if (value === null) delete clouds[key]; else if (value !== undefined) clouds[key] = value;
      }
    }
    if (spec.visibilityMetres !== undefined) ((w.visibility ??= {}) as LuaTable).distance = spec.visibilityMetres;
    if (spec.turbulence !== undefined) w.groundTurbulence = spec.turbulence;
    if (spec.fog) { w.enable_fog = spec.fog.enabled; const f = (w.fog ??= {}) as LuaTable;
      if (spec.fog.thickness !== undefined) f.thickness = spec.fog.thickness;
      if (spec.fog.visibility !== undefined) f.visibility = spec.fog.visibility; }
    if (spec.dust) { w.enable_dust = spec.dust.enabled; w.dust_density = spec.dust.density; }
  }
  if (a.title !== undefined) copy.sortie = a.title;
  if (a.briefing !== undefined) copy.descriptionText = a.briefing;
  const briefingKeys = { blue: 'descriptionBlueTask', red: 'descriptionRedTask', neutrals: 'descriptionNeutralsTask' };
  for (const [side, text] of Object.entries(a.coalitionBriefing ?? {})) if (text !== undefined) copy[briefingKeys[side as keyof typeof briefingKeys]] = text;
  for (const [side, point] of Object.entries(a.bullseyes ?? {})) if (point) {
    const coalition = (copy.coalition ??= {}) as LuaTable;
    const entry = (coalition[side] ??= { name: side, country: {} }) as LuaTable; entry.bullseye = { ...point };
  }
  Object.assign(mission, copy);
  return { changed: Object.keys(a), warnings: ['Weather preset availability depends on the installed DCS version; season follows the mission date, temperature is explicit', 'Offline format validation only'] };
}
export function assignCountry(mission: LuaTable, name: string, side: z.infer<typeof sideSchema>) {
  const copy = structuredClone(mission), id = countryId(name);
  const coalitions = (copy.coalition ??= {}) as LuaTable;
  let transferred: LuaTable | undefined;
  for (const other of ['blue', 'red', 'neutrals']) {
    const entry = asTable(coalitions[other]), list = asTable(entry?.country);
    if (!list) continue;
    const countries = luaArray(list), found = countries.find(c => c.id === id);
    if (found && other !== side) {
      transferred = found;
      entry!.country = Object.fromEntries(countries.filter(c => c !== found).map((c, i) => [i + 1, c]));
    }
  }
  const target = ensureCountry(copy, side, name, id);
  if (transferred) Object.assign(target, transferred);
  // ensureCountry also repairs the ME coalition id lists for a moved country.
  const lists = (copy.coalitions ??= {}) as LuaTable;
  for (const other of ['blue', 'red', 'neutrals']) {
    const ids = luaArray(lists[other]).map(v => v.value).filter(v => v !== id);
    if (other === side) ids.push(id);
    lists[other] = Object.fromEntries(ids.map((v, i) => [i + 1, v]));
  }
  Object.assign(mission, copy);
  return { country: name, side, warning: 'Moving a country moves all its groups; existing triggers, warehouse ownership and tasks are preserved and should be reviewed' };
}
export const referencePointSchema = z.object({ group: z.string().min(1), name: z.string().min(1).max(100), position: xySchema }).strict();
export function addReferencePoint(mission: LuaTable, groupName: string, name: string, point: z.infer<typeof xySchema>) {
  // Aircraft nav_target_points field is distinct from coalition nav_points; do not invent a coalition-point schema.
  let group: LuaTable | undefined; eachGroup(mission, (g, cat) => { if (g.name === groupName && ['plane', 'helicopter'].includes(cat)) group = g; });
  if (!group) throw new Error('Reference points require an existing aircraft group');
  const points = (group.NavTargetPoints ??= {}) as LuaTable;
  const next = Math.max(0, ...Object.keys(points).map(Number).filter(Number.isFinite)) + 1;
  points[next] = { ...point, index: next, text_comment: name };
  return { group: groupName, index: next, warning: 'Nav target points are aircraft-specific (e.g. F-14/JF-17); other modules may ignore them' };
}
