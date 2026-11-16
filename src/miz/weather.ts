/**
 * Cloud presets, following pydcs 1.0.0 weather.py `_make_cloud_dict` and the preset
 * table in cloud_presets.py (generated into data/authoring.json `cloudPresets`).
 * Offline only; not Mission-Editor verified.
 */
import { authoringData } from '../data/authoring.js';
import { asTable, type LuaTable } from './lua.js';

export function listCloudPresets() {
  return Object.entries(authoringData().cloudPresets).map(([name, p]) => ({
    name, uiName: p.uiName, member: p.member, minBaseMetres: p.minBase, maxBaseMetres: p.maxBase,
    description: p.description.replace(/\s*\n\s*/g, ' — '),
  }));
}

/** Accepts the stored name (`Preset7`), the editor label (`Scattered 2`) or the pydcs member (`Scattered2`). */
export function resolveCloudPreset(id: string) {
  const presets = authoringData().cloudPresets, key = id.trim().toLowerCase();
  const hit = Object.entries(presets).find(([name, p]) => name.toLowerCase() === key || p.uiName.toLowerCase() === key || p.member.toLowerCase() === key);
  if (!hit) throw new Error(`Unknown cloud preset '${id}'. Use dcs_list_cloud_presets.`);
  return { name: hit[0], ...hit[1] };
}

export function setCloudPreset(mission: LuaTable, id: string | null, baseMetres?: number) {
  const weather = (mission.weather ??= {}) as LuaTable;
  const clouds = (asTable(weather.clouds) ?? (weather.clouds = {})) as LuaTable;
  if (id === null) {
    // Back to manual clouds: drop the preset key, keep the manual fields pydcs writes.
    delete clouds.preset;
    clouds.thickness ??= 200; clouds.density ??= 0; clouds.base ??= 300; clouds.iprecptns ??= 0;
    if (baseMetres !== undefined) clouds.base = baseMetres;
    return { preset: null, baseMetres: clouds.base };
  }
  const preset = resolveCloudPreset(id);
  const current = Number(clouds.base);
  const base = baseMetres ?? (current >= preset.minBase && current <= preset.maxBase ? current : preset.minBase);
  // pydcs CloudPreset.validate_base.
  if (!Number.isFinite(base) || base < preset.minBase || base > preset.maxBase)
    throw new Error(`Cloud base ${base} m is outside ${preset.uiName}'s range ${preset.minBase}..${preset.maxBase} m`);
  // Thickness/density are not configurable for presets; pydcs writes back what was there (new missions: 200 / 0).
  Object.assign(clouds, { base, preset: preset.name, iprecptns: 0, thickness: clouds.thickness ?? 200, density: clouds.density ?? 0 });
  return { preset: preset.name, uiName: preset.uiName, baseMetres: base };
}
