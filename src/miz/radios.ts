/**
 * Aircraft radio presets, following pydcs 1.0.0 flyingunit.py (set_radio_preset,
 * set_radio_channel_preset) and unitgroup.py FlyingGroup.set_frequency.
 *
 * Data: `panelRadio` / `radioFrequency` in data/authoring.json, generated from pydcs
 * `panel_radio` / `radio_frequency`. pydcs carries no frequency bands. Where a band IS
 * documented (data/radio-bands.json, Hoggit "<type> Radios" pages, mapped to a pydcs radio only
 * when all its default channels fit), out-of-band frequencies are refused; everywhere else they
 * are not checked and the result says so. Offline only, not Mission-Editor verified.
 */
import { authoringData } from '../data/authoring.js';
import { asTable, luaArray, type LuaTable } from './lua.js';
import { findGroup, findUnit } from './authoring.js';
import { radioBand } from '../data/radio-bands.js';

type Panel = Record<string, { channels: Record<string, number> }>;

export function radioInfo(type: string) {
  const entry = authoringData().aircraft[type];
  if (!entry) throw new Error(`No pydcs aircraft data for type '${type}'`);
  const panel = entry.panelRadio as Panel | undefined;
  return {
    type,
    defaultFrequencyMHz: entry.radioFrequency ?? null,
    configurable: !!panel,
    radios: panel ? Object.entries(panel).map(([radio, cfg]) => ({
      radio: Number(radio), channels: Object.keys(cfg.channels).length,
      defaults: Object.fromEntries(Object.entries(cfg.channels).map(([c, f]) => [c, f])),
      band: radioBand(type, radio) ?? null,
    })) : [],
    bandsValidated: panel ? Object.keys(panel).every(r => radioBand(type, r)) : false,
    source: 'pydcs 1.0.0 panel_radio / radio_frequency',
  };
}

function panelFor(type: string): Panel {
  const panel = authoringData().aircraft[type]?.panelRadio as Panel | undefined;
  if (!panel) throw new Error(`'${type}' has no configurable radio presets in pydcs`);
  return panel;
}

/** pydcs set_radio_preset: unit.Radio is a deep copy of the airframe's panel_radio. */
function defaultRadio(type: string): LuaTable {
  const radio: LuaTable = {};
  for (const [r, cfg] of Object.entries(panelFor(type))) {
    radio[Number(r)] = { channels: Object.fromEntries(Object.entries(cfg.channels).map(([c, f]) => [Number(c), f])) };
  }
  return radio;
}

const isHuman = (u: LuaTable) => u.skill === 'Client' || u.skill === 'Player';

function requireAircraftUnit(mission: LuaTable, unitName: string): LuaTable {
  const unit = findUnit(mission, unitName);
  if (!unit) throw new Error(`No unit named '${unitName}' in this mission`);
  if (!authoringData().aircraft[String(unit.type)]) throw new Error(`Unit '${unitName}' (${unit.type}) is not a known aircraft`);
  return unit;
}

/** Refuse a frequency outside a documented band; silent where no band is sourced. */
export function checkBand(type: string, radio: number, mhz: number, what: string): void {
  const band = radioBand(type, radio);
  if (band && (mhz < band.minMHz || mhz > band.maxMHz))
    throw new Error(`${what}: ${mhz} MHz is outside ${type} radio ${radio}'s ${band.band} band ${band.minMHz}-${band.maxMHz} MHz (${band.page})`);
}

export interface PresetArgs { radio: number; channels: Record<string, number> }

/** Set channel presets on one unit. Unknown radios/channels are refused (pydcs raises KeyError). */
export function setRadioPresets(mission: LuaTable, unitName: string, args: PresetArgs) {
  const unit = requireAircraftUnit(mission, unitName);
  const type = String(unit.type);
  const panel = panelFor(type);
  const radioCfg = panel[String(args.radio)];
  if (!radioCfg) throw new Error(`'${type}' has no radio ${args.radio}; it has radios ${Object.keys(panel).join(', ')}`);
  for (const [channel, mhz] of Object.entries(args.channels)) {
    if (!(channel in radioCfg.channels)) throw new Error(`Radio ${args.radio} of '${type}' has no channel ${channel} (1..${Object.keys(radioCfg.channels).length})`);
    if (!Number.isFinite(mhz) || mhz <= 0 || mhz > 1000) throw new Error(`Channel ${channel}: frequency must be a positive MHz value`);
    checkBand(type, args.radio, mhz, `Channel ${channel}`);
  }
  const existing = asTable(unit.Radio);
  const radio = existing ? structuredClone(existing) : defaultRadio(type);
  const target = asTable(radio[args.radio]) ?? (radio[args.radio] = { channels: {} }) as LuaTable;
  const channels = (asTable(target.channels) ?? (target.channels = {})) as LuaTable;
  for (const [channel, mhz] of Object.entries(args.channels)) channels[Number(channel)] = mhz;
  unit.Radio = radio;
  const warnings: string[] = [];
  if (!isHuman(unit)) warnings.push('pydcs only writes presets for Client/Player units; AI aircraft may ignore them.');
  if (!radioBand(type, args.radio)) warnings.push(`No documented band for ${type} radio ${args.radio}; frequencies are not band-checked.`);
  return { unit: unitName, type, radio: args.radio, set: Object.keys(args.channels).length, warnings };
}

/** pydcs set_radio_preset for every unit of a group (or the named unit only). */
export function resetRadioPresets(mission: LuaTable, groupName: string) {
  const found = findGroup(mission, groupName);
  if (!found) throw new Error(`No group named '${groupName}' in this mission`);
  const units = luaArray(found.group.units);
  for (const u of units) u.Radio = defaultRadio(String(u.type));
  return { group: groupName, units: units.length };
}

/**
 * pydcs FlyingGroup.set_frequency: the group's intra-flight frequency. Client/Player
 * units that carry presets also get channel 1 of `radio` set to it.
 */
export function setIntraFlightFrequency(mission: LuaTable, groupName: string, frequencyMHz?: number, radio = 1, modulation?: 0 | 1) {
  const found = findGroup(mission, groupName);
  if (!found) throw new Error(`No group named '${groupName}' in this mission`);
  if (found.category !== 'plane' && found.category !== 'helicopter') throw new Error(`'${groupName}' is not an aircraft group`);
  const units = luaArray(found.group.units);
  const mhz = frequencyMHz ?? authoringData().aircraft[String(units[0]?.type)]?.radioFrequency;
  if (mhz === undefined || !Number.isFinite(mhz) || mhz <= 0) throw new Error('No frequency given and no pydcs default for this airframe');
  checkBand(String(units[0]?.type), radio, mhz, 'Intra-flight frequency');
  found.group.frequency = mhz;
  found.group.radioSet = true;
  if (modulation !== undefined) found.group.modulation = modulation;
  const presetUnits: string[] = [];
  for (const u of units) {
    if (!isHuman(u) || !authoringData().aircraft[String(u.type)]?.panelRadio) continue;
    setRadioPresets(mission, String(u.name), { radio, channels: { 1: mhz } });
    presetUnits.push(String(u.name));
  }
  return { group: groupName, frequencyMHz: mhz, defaulted: frequencyMHz === undefined, presetUnits,
    warnings: radioBand(String(units[0]?.type), radio) ? [] : [`No documented band for ${units[0]?.type} radio ${radio}; frequency not band-checked.`] };
}
