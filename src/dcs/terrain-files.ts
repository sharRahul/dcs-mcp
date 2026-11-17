/**
 * Airfield ATC radios and navigation beacons read from the DCS install's own terrain
 * modules: `Mods/terrains/<theatre>/radio.lua` and `beacons.lua`.
 *
 * This is ED's own data for the theatre as installed, which makes it the strongest
 * source this project has for ATC frequencies and for TACAN / ILS / VOR / NDB — stronger
 * than pydcs (a pinned export) and stronger than the OCR'd kneeboards
 * (data/airfield-navaids.json), and it is the ONLY source for a theatre pydcs never had
 * (Iraq, Marianas WWII). It is read per request from the user's machine, so it is never
 * bundled and never pinned: results carry the file's sha256 and the install's build.
 *
 * Both files are read as TEXT and never executed. They are declarations with `dofile`
 * calls, `_()` translation calls and bare constants (`HF`, `BEACON_TYPE_TACAN`,
 * `MODULATIONTYPE_AM`) at the top, so they are not data-only Lua and lua.ts cannot take
 * them. Parsing is therefore a field scan over each entry block, exactly like mods.ts
 * scans mod declarations: a block without the one required id field is skipped, every
 * value must pass its own format check, and a field that is absent stays absent rather
 * than becoming a default. Nothing here guesses a frequency.
 *
 * Caveat that must survive into the client: these files describe the beacon and radio
 * objects of the theatre. An airfield's identity is `airfield<N>` in the ids ED uses
 * here, which is NOT the mission-file `airdromeId` — that mapping is only sound where
 * the bundled (pydcs) airfield data already lists the same beacon ids, and for an
 * unknown theatre it has to come from a live sample instead.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { installInfo, readText, type InstalledTheatre } from './install-info.js';

/** ED's frequency bands (Scripts/World/Radio/FrequencyBands.lua): HF, VHF_LOW, VHF_HI, UHF. */
const BANDS = { HF: 'hf', VHF_LOW: 'vhfLow', VHF_HI: 'vhfHigh', UHF: 'uhf' } as const;
type BandKey = (typeof BANDS)[keyof typeof BANDS];

export interface AtcRadio {
  /** ED's own id, e.g. "airfield1_0". */
  radioId: string;
  /** The `airfield<N>` index in that id, when it has one. */
  airfieldIndex?: number;
  /** The comment ED puts above the entry (the airfield's folder-style name), when present. */
  comment?: string;
  /** ATC callsign (usually the ICAO code). */
  callsign?: string;
  roles: string[];
  /** Frequencies in MHz per band, as ED states them (file holds Hz). */
  mhz: Partial<Record<BandKey, number>>;
  /** Modulation per band, e.g. "AM". */
  modulation: Partial<Record<BandKey, string>>;
}

export type BeaconKind = string;

export interface Beacon {
  beaconId: string;
  airfieldIndex?: number;
  displayName?: string;
  /** `BEACON_TYPE_x` with the prefix removed: TACAN, ILS_LOCALIZER, VOR_DME, ... */
  kind: BeaconKind;
  callsign?: string;
  /** TACAN/RSBN channel, when the beacon has one. */
  channel?: number;
  /** MHz, converted from the file's Hz. */
  mhz?: number;
  /** DCS map metres: x = north, y = east, alt = metres. */
  position?: { x: number; y: number; alt: number };
  lat?: number;
  lon?: number;
  /** Degrees as ED states it (localizer/glideslope bearing); not re-derived. */
  direction?: number;
}

export interface TerrainFileData {
  theatre: string;
  installRoot: string;
  installVersion?: string;
  files: { file: string; sha256: string; bytes: number }[];
  atc: AtcRadio[];
  beacons: Beacon[];
  notes: string[];
}

/**
 * Split an ED declaration list into its entry blocks.
 *
 * Both files are `name = { { ...; }; { ...; }; }` with one entry per indented block and
 * nested tables kept on a single line. Blocks are cut on a line that is only `{` or `};`,
 * which is what ED's generator emits; a block that does not then yield the required id
 * field is dropped by the caller rather than half-parsed.
 */
function entryBlocks(text: string, listName: string): string[] {
  const start = new RegExp(`(^|\\n)\\s*${listName}\\s*=\\s*\\{`).exec(text);
  if (!start) return [];
  const body = text.slice(start.index + start[0].length);
  return body
    .split(/\n\s*\{\s*(?:\r?\n|$)/)
    .slice(1)
    .map(block => block.split(/\n\s*\}\s*;?/)[0])
    .filter(block => block.length > 0 && block.length < 16_000);
}

const num = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
};
const airfieldIndex = (id: string): number | undefined => num(/^airfield(\d+)_/.exec(id)?.[1]);
/** ED writes Hz; MHz keeps 6 decimals so 108.100000 stays exact. */
const toMhz = (hz: number | undefined): number | undefined =>
  hz === undefined ? undefined : Math.round((hz / 1_000_000) * 1e6) / 1e6;

export function parseRadioLua(text: string): AtcRadio[] {
  const out: AtcRadio[] = [];
  // ED puts the airfield name in a comment on the block's first line.
  for (const block of entryBlocks(text, 'radio')) {
    const radioId = /radioId\s*=\s*'([^'\n]{1,64})'/.exec(block)?.[1] ?? /radioId\s*=\s*"([^"\n]{1,64})"/.exec(block)?.[1];
    if (!radioId) continue;
    const mhz: Partial<Record<BandKey, number>> = {};
    const modulation: Partial<Record<BandKey, string>> = {};
    for (const [band, key] of Object.entries(BANDS) as [keyof typeof BANDS, BandKey][]) {
      const m = new RegExp(`\\[${band}\\]\\s*=\\s*\\{\\s*MODULATIONTYPE_([A-Z]+)\\s*,\\s*([0-9.]+)`).exec(block);
      if (!m) continue;
      const v = toMhz(num(m[2]));
      if (v === undefined || v <= 0) continue;
      mhz[key] = v;
      modulation[key] = m[1];
    }
    const roles = [...block.matchAll(/"(ground|tower|approach|departure|atis|intercom)"/g)].map(m => m[1]);
    out.push({
      radioId,
      airfieldIndex: airfieldIndex(radioId),
      comment: /--\s*([A-Za-z0-9_][A-Za-z0-9_' .-]{0,63})/.exec(block)?.[1]?.trim(),
      callsign: /callsign\s*=\s*\{\{.*?,\s*"([A-Za-z0-9 _-]{1,24})"/.exec(block)?.[1],
      roles: [...new Set(roles)],
      mhz, modulation,
    });
  }
  return out;
}

export function parseBeaconsLua(text: string): Beacon[] {
  const out: Beacon[] = [];
  for (const block of entryBlocks(text, 'beacons')) {
    const beaconId = /beaconId\s*=\s*'([^'\n]{1,64})'/.exec(block)?.[1] ?? /beaconId\s*=\s*"([^"\n]{1,64})"/.exec(block)?.[1];
    const kind = /type\s*=\s*BEACON_TYPE_([A-Z_0-9]{1,48})/.exec(block)?.[1];
    if (!beaconId || !kind) continue;
    const pos = /position\s*=\s*\{\s*(-?[0-9.]+)\s*,\s*(-?[0-9.]+)\s*,\s*(-?[0-9.]+)\s*\}/.exec(block);
    const lat = num(/latitude\s*=\s*(-?[0-9.]+)/.exec(block)?.[1]);
    const lon = num(/longitude\s*=\s*(-?[0-9.]+)/.exec(block)?.[1]);
    const channel = num(/\bchannel\s*=\s*(\d{1,3})/.exec(block)?.[1]);
    const mhz = toMhz(num(/\bfrequency\s*=\s*([0-9.]+)/.exec(block)?.[1]));
    const beacon: Beacon = {
      beaconId,
      airfieldIndex: airfieldIndex(beaconId),
      displayName: /display_name\s*=\s*_\(['"]([^'"\n]{1,64})['"]\)/.exec(block)?.[1],
      kind,
      callsign: /\bcallsign\s*=\s*['"]([A-Za-z0-9 _-]{1,24})['"]/.exec(block)?.[1],
      ...(channel !== undefined ? { channel } : {}),
      ...(mhz !== undefined && mhz > 0 ? { mhz } : {}),
      ...(pos ? { position: { x: Number(pos[1]), y: Number(pos[3]), alt: Number(pos[2]) } } : {}),
      ...(lat !== undefined ? { lat } : {}),
      ...(lon !== undefined ? { lon } : {}),
      ...(num(/\bdirection\s*=\s*(-?[0-9.]+)/.exec(block)?.[1]) !== undefined
        ? { direction: num(/\bdirection\s*=\s*(-?[0-9.]+)/.exec(block)?.[1]) }
        : {}),
    };
    out.push(beacon);
  }
  return out;
}

/** The installed terrain folder for a theatre name, matched on folder, id or bundled key. */
export function findInstalledTheatre(name: string, env: NodeJS.ProcessEnv = process.env): InstalledTheatre | undefined {
  const wanted = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  return installInfo(env).theatres.find(t =>
    [t.folder, t.id, t.bundledKey, t.updateId?.replace(/_terrain$/i, '')]
      .filter((c): c is string => !!c)
      .some(c => c.toLowerCase().replace(/[^a-z0-9]/g, '') === wanted));
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * ATC radios and beacons for one installed theatre, straight from the install.
 * A theatre that ships neither file (Marianas WWII ships no beacons) reports the empty
 * list and says which file was missing — never an invented value.
 */
export function installTerrainData(theatreName: string, env: NodeJS.ProcessEnv = process.env): TerrainFileData {
  const info = installInfo(env);
  if (!info.root) throw new Error(info.notes[0] ?? 'No DCS install folder found; set DCS_INSTALL_DIR.');
  const theatre = findInstalledTheatre(theatreName, env);
  if (!theatre) {
    throw new Error(`'${theatreName}' is not an installed terrain. Installed: ${info.theatres.map(t => t.folder).join(', ') || 'none found'}.`);
  }
  const dir = path.join(info.root, 'Mods', 'terrains', theatre.folder);
  const files: TerrainFileData['files'] = [];
  const notes: string[] = [];
  const read = (name: string) => {
    const file = path.join(dir, name);
    if (!existsSync(file)) { notes.push(`${name} is not present in Mods/terrains/${theatre.folder} — that data is unavailable, not empty.`); return undefined; }
    const text = readText(file);
    if (text === undefined) { notes.push(`${name} could not be read (too large or no permission).`); return undefined; }
    files.push({ file: `Mods/terrains/${theatre.folder}/${name}`, sha256: sha256(text), bytes: Buffer.byteLength(text) });
    return text;
  };
  const radioText = read('radio.lua');
  const beaconText = read('beacons.lua');
  const atc = radioText ? parseRadioLua(radioText) : [];
  const beacons = beaconText ? parseBeaconsLua(beaconText) : [];
  if (radioText && !atc.length) notes.push('radio.lua was read but no entry parsed — ED may have changed the format; nothing is reported rather than guessed.');
  if (beaconText && !beacons.length) notes.push('beacons.lua was read but no entry parsed — ED may have changed the format; nothing is reported rather than guessed.');
  notes.push(`Source: this install (${info.version ?? 'unknown build'}), read as text, never executed. ED's own terrain data.`);
  notes.push("Ids are ED's airfield<N> beacon/radio ids. They are not mission-file airdromeId values; join them through the bundled airfield data (which lists the same beacon ids) or a live airbase sample.");
  if (!theatre.bundledKey) notes.push(`${theatre.folder} has no bundled airfield data, so these entries cannot be mapped to airfield names or ids offline. Build an airbase pack from a running mission on this map to get ids, coordinates and parking.`);
  return {
    theatre: theatre.bundledKey ?? theatre.id ?? theatre.folder,
    installRoot: info.root, installVersion: info.version,
    files, atc, beacons, notes,
  };
}

/**
 * The install's beacons for a set of ED beacon ids — the ids the bundled (pydcs) airfield
 * data already lists per airfield, which is what makes this join sound rather than a guess
 * at an index. Returns undefined when there is no readable install, so a caller can say
 * "unknown" instead of "none"; it never throws.
 */
export function beaconsForIds(theatreName: string, beaconIds: string[], env: NodeJS.ProcessEnv = process.env):
  { beacons: Beacon[]; source: { file: string; sha256: string }; installVersion?: string } | undefined {
  if (!beaconIds.length) return undefined;
  let data: TerrainFileData;
  try { data = installTerrainData(theatreName, env); } catch { return undefined; }
  const file = data.files.find(f => f.file.endsWith('beacons.lua'));
  if (!file) return undefined;
  const wanted = new Set(beaconIds);
  // ED groups beacons by the `airfield<N>` part of the id, so once one listed id matches,
  // every beacon of that airfield belongs to it by ED's own grouping — not by proximity.
  // pydcs's per-airfield list is often shorter than the install's (an ILS pair it never
  // exported), and those siblings are the same airfield's beacons.
  const indices = new Set(data.beacons.filter(b => wanted.has(b.beaconId)).map(b => b.airfieldIndex)
    .filter((i): i is number => i !== undefined));
  return {
    beacons: data.beacons.filter(b => wanted.has(b.beaconId) || (b.airfieldIndex !== undefined && indices.has(b.airfieldIndex))),
    source: { file: file.file, sha256: file.sha256 },
    installVersion: data.installVersion,
  };
}

export interface AirfieldInstallData {
  airfieldIndex: number;
  name?: string;
  callsign?: string;
  atcMHz: Partial<Record<BandKey, number>>;
  beacons: Beacon[];
}

/** The same data grouped per `airfield<N>`, which is how a client wants to read it. */
export function installAirfieldData(theatreName: string, env: NodeJS.ProcessEnv = process.env) {
  const data = installTerrainData(theatreName, env);
  const byIndex = new Map<number, AirfieldInstallData>();
  const at = (i: number) => {
    let e = byIndex.get(i);
    if (!e) { e = { airfieldIndex: i, atcMHz: {}, beacons: [] }; byIndex.set(i, e); }
    return e;
  };
  for (const radio of data.atc) {
    if (radio.airfieldIndex === undefined) continue;
    const e = at(radio.airfieldIndex);
    e.name ??= radio.comment;
    e.callsign ??= radio.callsign;
    for (const [k, v] of Object.entries(radio.mhz)) if (e.atcMHz[k as BandKey] === undefined) e.atcMHz[k as BandKey] = v;
  }
  for (const beacon of data.beacons) {
    if (beacon.airfieldIndex === undefined) continue;
    at(beacon.airfieldIndex).beacons.push(beacon);
  }
  const unattached = data.beacons.filter(b => b.airfieldIndex === undefined);
  return {
    ...data,
    airfields: [...byIndex.values()].sort((a, b) => a.airfieldIndex - b.airfieldIndex),
    unattachedBeacons: unattached,
  };
}
