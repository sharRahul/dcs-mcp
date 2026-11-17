/**
 * Offline airbase packs: airfields, runways and parking spots sampled from a RUNNING DCS
 * through the bridge's `airbases` command, cached on disk.
 *
 * Why this exists: the bundled airfield catalogue is pydcs's export, so a theatre pydcs
 * never had (Iraq, Marianas WWII) has no airfield ids, no coordinates and no parking —
 * and that data is in the terrain's binary files, which this server cannot read. DCS
 * itself can: `world.getAirbases()` / `Airbase:getID()` / `getParking()` / `getRunways()`.
 * One sampling run on the map turns that into offline data, exactly as a terrain pack
 * turns `land.getHeight` into offline elevation.
 *
 * What is sound and what is not, because it must not be blurred:
 *   - ids, names, callsigns, category, coalition, position (map metres + lat/lon),
 *     runways and parking positions are DCS's own answers. Sound.
 *   - a parking slot's physical size is NOT in the live answer. Its category is: DCS
 *     reports `termType`, but that is a DIFFERENT enum from the `flags` pydcs stores -
 *     sampling Bandar Abbas live gave termType 104/72/16 against bundled flags 6/4 on the
 *     same airfield - so termType is kept in the pack and never mapped onto flags.
 *     Term_Index_0 comes back as -1 when a slot has none, so the terminal index is used
 *     for `parking_id` instead. Size and flags are recorded as unknown (0) and a
 *     pack airfield is marked `slotsUnverified`, so parking choice stops applying the
 *     pydcs fit rule rather than inventing dimensions. A flight parked from a pack has
 *     not been opened in the Mission Editor by this project.
 *   - lat/lon is per sampled airbase only. A pack does NOT give a theatre projection, so
 *     arbitrary lat/lon <-> x/y conversion stays unavailable for an unbundled theatre.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { bridgeRequest, type BridgeOptions } from '../bridge/client.js';
import { registerAirportSource, resolveTheatreName, type Airport, type ParkingSlotTuple } from '../data/reference.js';

export const AIRBASE_PACK_FORMAT = 'dcs-mcp-airbase-pack/1';
/** One sampling run: DCS answers in pages, this is the cap on pages and airbases. */
export const MAX_AIRBASES = 200;
const PAGE = 8;

export interface SampledRunway { name?: string; course?: number; length?: number; width?: number; x?: number; y?: number }
export interface SampledParking { term?: number; term0?: number; termType?: number; toAC?: boolean; distRW?: number; x?: number; y?: number; alt?: number }
export interface SampledAirbase {
  id: number; name: string; callsign?: string; displayName?: string;
  category: string; coalition?: number;
  x: number; y: number; alt?: number; lat?: number; lon?: number;
  runways: SampledRunway[]; parking: SampledParking[];
}
export interface AirbasePack {
  format: string; name: string; theatre: string; createdAt: string; source: string;
  dcsVersion?: string;
  airbases: SampledAirbase[];
}

export function airbasePackDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DCS_MCP_AIRBASE_DIR) return env.DCS_MCP_AIRBASE_DIR;
  const base = env.LOCALAPPDATA ?? path.join(homedir(), '.dcs-mcp');
  return path.join(base, env.LOCALAPPDATA ? 'dcs-mcp' : '', 'airbases');
}
const canon = (t: string) => resolveTheatreName(t) ?? t;
const safeName = (n: string) => { if (!/^[A-Za-z0-9_-]{1,64}$/.test(n)) throw new Error('Pack name: 1-64 letters, digits, _ or -'); return n; };
const fileFor = (dir: string, theatre: string, name: string) => path.join(dir, `${canon(theatre)}__${safeName(name)}.json`);

export function loadAirbasePacks(theatre?: string, dir = airbasePackDir()): AirbasePack[] {
  let files: string[] = [];
  try { files = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.json')) : []; } catch { return []; }
  const packs: AirbasePack[] = [];
  for (const f of files) {
    try {
      const p = JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as AirbasePack;
      if (p.format !== AIRBASE_PACK_FORMAT || !Array.isArray(p.airbases)) continue;
      if (theatre && canon(p.theatre) !== canon(theatre)) continue;
      packs.push(p);
    } catch { /* an unreadable pack is skipped, never fatal */ }
  }
  return packs;
}

export function describeAirbasePack(p: AirbasePack) {
  return {
    name: p.name, theatre: p.theatre, createdAt: p.createdAt, source: p.source, dcsVersion: p.dcsVersion ?? null,
    airbases: p.airbases.length,
    withParking: p.airbases.filter(a => a.parking.length).length,
    parkingSpots: p.airbases.reduce((n, a) => n + a.parking.length, 0),
    categories: [...new Set(p.airbases.map(a => a.category))].sort(),
  };
}

/**
 * Turn sampled airbases into the Airport shape the authoring code uses. Slot tuples are
 * [parking, parking_id, x, y, flags, width, length, height]; everything the live answer
 * does not contain is 0, which `chooseParking` reads as "unknown" instead of "does not
 * fit". AIRDROME entries only: a helipad or a ship is not an airfield a flight starts
 * from with an airdromeId.
 */
export function packAirports(theatre: string, packs = loadAirbasePacks(theatre)): (Airport & { slotsUnverified: true; source: string })[] {
  const byId = new Map<number, Airport & { slotsUnverified: true; source: string }>();
  // Newest pack wins for an airfield sampled more than once.
  for (const pack of [...packs].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    for (const ab of pack.airbases) {
      if (ab.category !== 'AIRDROME') continue;
      const slots: ParkingSlotTuple[] = ab.parking
        .filter(s => Number.isFinite(s.x) && Number.isFinite(s.y))
        .map(s => [
          Number(s.term ?? 0),
          // `parking_id` is the slot NAME the mission file carries. DCS reports
          // Term_Index_0 as -1 when the slot has none (seen on every Persian Gulf
          // airbase sampled live on 2026-11-17), so a negative value means absent
          // and the terminal index is used instead - writing "-1" as a parking id
          // would be a slot name no airfield has.
          String(typeof s.term0 === 'number' && s.term0 >= 0 ? s.term0 : s.term ?? ''),
          Number(s.x), Number(s.y),
          // Size and category flags: see the note at the top of this file. DCS's
          // own `termType` IS in the live answer, but it is a different enum from
          // the pydcs `flags` this tuple's 5th element holds - sampling Bandar
          // Abbas live gave termType 104/72/16 where the bundled slots carry
          // flags 6/4 - so it is kept in the pack and NOT mapped here.
          0, 0, 0, 0,
        ] as ParkingSlotTuple);
      byId.set(ab.id, {
        id: ab.id, name: ab.displayName || ab.name, x: ab.x, y: ab.y, slots,
        slotsUnverified: true, source: `airbase pack ${pack.name} (${pack.theatre}, sampled ${pack.createdAt})`,
      });
    }
  }
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

export interface BuildAirbaseArgs { theatre: string; name: string; parking?: boolean; runways?: boolean; maxAirbases?: number; dcsVersion?: string }

/**
 * Walk the bridge's paged `airbases` command and write the result as a pack. The running
 * theatre must be the one asked for: a pack labelled with the wrong map would place
 * flights at coordinates on another terrain.
 */
export async function buildAirbasePack(a: BuildAirbaseArgs, options: BridgeOptions, dir = airbasePackDir()) {
  safeName(a.name);
  const limit = Math.min(Math.max(a.maxAirbases ?? MAX_AIRBASES, 1), MAX_AIRBASES);
  const airbases: SampledAirbase[] = [];
  let theatre: string | undefined;
  let total = 0;
  for (let from = 1; from <= limit; from += PAGE) {
    const data = await bridgeRequest(
      { cmd: 'airbases', args: { from, limit: Math.min(PAGE, limit - airbases.length), parking: a.parking !== false, runways: a.runways !== false } },
      options
    ) as { theatre?: string; total?: number; airbases?: SampledAirbase[] };
    if (!Array.isArray(data.airbases)) throw new Error('Malformed airbases response from the bridge');
    theatre ??= data.theatre;
    total = Number(data.total ?? 0);
    for (const ab of data.airbases) {
      if (!Number.isFinite(ab?.id) || !Number.isFinite(ab?.x) || !Number.isFinite(ab?.y)) continue;
      airbases.push({ ...ab, runways: ab.runways ?? [], parking: ab.parking ?? [] });
    }
    if (!data.airbases.length || airbases.length >= total || airbases.length >= limit) break;
  }
  if (!airbases.length) throw new Error('DCS reported no airbases; is a mission running?');
  const running = resolveTheatreName(theatre ?? '') ?? theatre;
  if (running && canon(a.theatre) !== running && theatre !== a.theatre) {
    throw new Error(`The running mission is on '${theatre}', not '${a.theatre}'. Load a mission on that map first.`);
  }
  const pack: AirbasePack = {
    format: AIRBASE_PACK_FORMAT, name: a.name, theatre: theatre || canon(a.theatre),
    createdAt: new Date().toISOString(),
    source: `DCS bridge airbases command (world.getAirbases/getID/getRunways/getParking); sampled ${airbases.length} of ${total || airbases.length}`,
    dcsVersion: a.dcsVersion, airbases,
  };
  mkdirSync(dir, { recursive: true });
  const file = fileFor(dir, pack.theatre, a.name), tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(pack));
  renameSync(tmp, file);
  return {
    file, ...describeAirbasePack(pack), totalReported: total,
    notes: [
      'Ids, names, positions, runways and parking positions are DCS\'s own answers for the running theatre.',
      'A parking slot\'s size and category flags are not in the live answer: they are stored as unknown, so parking choice no longer applies the pydcs fit rule for these airfields.',
      'Which of Term_Index / Term_Index_0 the mission file\'s parking_id holds is not established by this sample; parking_id is written from Term_Index_0. A flight parked from a pack has not been opened in the Mission Editor by this project.',
      'A pack carries no theatre projection, so lat/lon <-> x/y for an unbundled theatre stays unavailable.',
    ],
  };
}

/**
 * Make installed packs visible to the airfield lookup (dcs_list_airfields, flight starts,
 * validation). Called once at server start; tests call it with their own directory.
 * Packs are re-read on each call so a pack built in this session is usable at once.
 */
export function enableAirbasePacks(dir = airbasePackDir()): void {
  registerAirportSource({
    theatres: () => [...new Set(loadAirbasePacks(undefined, dir).map(p => p.theatre))],
    airports: (theatre: string) => packAirports(theatre, loadAirbasePacks(theatre, dir)),
  });
}

export function removeAirbasePack(theatre: string, name: string, dir = airbasePackDir()) {
  const file = fileFor(dir, theatre, name);
  if (!existsSync(file)) throw new Error(`No airbase pack '${name}' for '${canon(theatre)}'`);
  rmSync(file);
  return { removed: name, theatre: canon(theatre) };
}
