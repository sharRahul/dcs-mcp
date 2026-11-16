/**
 * Offline terrain packs: elevation/surface grids sampled from DCS's OWN terrain
 * (land.getHeight / land.getSurfaceType through the structured `land` bridge command)
 * and cached on disk, so terrain analysis works later with DCS closed.
 *
 * A pack is exactly what was sampled: bilinear interpolation between nodes, null outside
 * coverage. It is bare-earth (DCS's height field, no buildings or trees) and only as
 * fine as its spacing. Nothing is invented: no flat fallback, no data from elsewhere.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { resolveTheatreName } from '../data/reference.js';
import { MAX_SAMPLES, TerrainUnavailable, type Point, type Sample, type TerrainProvider } from './analysis.js';
import { gridProvider, type ElevationGrid } from './providers.js';

export const PACK_FORMAT = 'dcs-mcp-terrain-pack/1';
/** Per build call: 512 x 512 nodes. Larger areas are several tiles. */
export const MAX_PACK_NODES = 262144;

export interface TerrainPack extends ElevationGrid { format: string; name: string; createdAt: string; dcsVersion?: string }

export function packDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DCS_MCP_TERRAIN_DIR) return env.DCS_MCP_TERRAIN_DIR;
  const base = env.LOCALAPPDATA ?? path.join(homedir(), '.dcs-mcp');
  return path.join(base, env.LOCALAPPDATA ? 'dcs-mcp' : '', 'terrain');
}
const canon = (t: string) => resolveTheatreName(t) ?? t;
const safeName = (n: string) => { if (!/^[A-Za-z0-9_-]{1,64}$/.test(n)) throw new Error('Pack name: 1-64 letters, digits, _ or -'); return n; };
const fileFor = (dir: string, theatre: string, name: string) => path.join(dir, `${canon(theatre)}__${safeName(name)}.json`);

export function loadPacks(theatre?: string, dir = packDir()): TerrainPack[] {
  let files: string[] = [];
  try { files = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.json')) : []; } catch { return []; }
  const packs: TerrainPack[] = [];
  for (const f of files) {
    try {
      const p = JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as TerrainPack;
      if (p.format !== PACK_FORMAT) continue;
      if (theatre && canon(p.theatre) !== canon(theatre)) continue;
      packs.push(p);
    } catch { /* an unreadable pack is skipped, never fatal */ }
  }
  return packs;
}

export function describePack(p: TerrainPack) {
  return { name: p.name, theatre: p.theatre, source: p.source, createdAt: p.createdAt, dcsVersion: p.dcsVersion ?? null,
    origin: p.origin, spacingMetres: p.spacingMetres, rows: p.rows, columns: p.columns,
    extent: { xMin: p.origin.x, xMax: p.origin.x + (p.rows - 1) * p.spacingMetres, yMin: p.origin.y, yMax: p.origin.y + (p.columns - 1) * p.spacingMetres },
    nullNodes: p.heights.filter(h => h === null).length, surfaces: !!p.surfaces };
}

/** Samples from the finest pack that covers each point; null where no pack does. */
export function packProvider(theatre: string, packs = loadPacks(theatre)): TerrainProvider {
  if (!packs.length) throw new TerrainUnavailable(`No terrain pack installed for '${theatre}'. Build one with dcs_terrain_build_pack while DCS runs this theatre.`);
  const sorted = [...packs].sort((a, b) => a.spacingMetres - b.spacingMetres);
  const providers = sorted.map(p => ({ p, provider: gridProvider(p, theatre, p.rows * p.columns) }));
  const covers = (p: TerrainPack, pt: Point) => pt.x >= p.origin.x && pt.y >= p.origin.y &&
    pt.x <= p.origin.x + (p.rows - 1) * p.spacingMetres && pt.y <= p.origin.y + (p.columns - 1) * p.spacingMetres;
  return {
    source: `terrain pack(s) ${sorted.map(p => `${p.name} [${p.source}]`).join('; ')}`,
    theatre, resolutionMetres: sorted[0].spacingMetres,
    async sample(points) {
      if (points.length > MAX_SAMPLES) throw new Error('Terrain sample budget exceeded');
      const out: Sample[] = [];
      for (const pt of points) {
        const hit = providers.find(({ p }) => covers(p, pt));
        out.push(hit ? (await hit.provider.sample([pt]))[0] : { ...pt, height: null });
      }
      return out;
    },
  };
}

export interface BuildArgs { theatre: string; name: string; origin: Point; spacingMetres: number; rows: number; columns: number; dcsVersion?: string }

/** Sample a grid from a live provider (DCS) and write it as a pack. Atomic write. */
export async function buildPack(live: TerrainProvider, a: BuildArgs, dir = packDir()) {
  if (a.rows < 2 || a.columns < 2 || a.rows * a.columns > MAX_PACK_NODES) throw new Error(`rows x columns must be 4..${MAX_PACK_NODES}; build larger areas as several packs`);
  if (!(a.spacingMetres >= 10 && a.spacingMetres <= 10000)) throw new Error('spacingMetres must be 10..10000');
  const points: Point[] = [];
  for (let r = 0; r < a.rows; r++) for (let c = 0; c < a.columns; c++) points.push({ x: a.origin.x + r * a.spacingMetres, y: a.origin.y + c * a.spacingMetres });
  const heights: (number | null)[] = [], surfaces: (number | null)[] = [];
  for (let i = 0; i < points.length; i += MAX_SAMPLES) {
    for (const s of await live.sample(points.slice(i, i + MAX_SAMPLES))) {
      heights.push(s.height === null || !Number.isFinite(s.height) ? null : Math.round(s.height * 100) / 100);
      surfaces.push(s.surface !== undefined && [1, 2, 3, 4, 5].includes(s.surface) ? s.surface : null);
    }
  }
  const pack: TerrainPack = { format: PACK_FORMAT, name: safeName(a.name), theatre: canon(a.theatre), createdAt: new Date().toISOString(),
    source: `${live.source}; sampled ${a.rows}x${a.columns} at ${a.spacingMetres} m`, dcsVersion: a.dcsVersion,
    origin: a.origin, spacingMetres: a.spacingMetres, rows: a.rows, columns: a.columns, heights,
    surfaces: surfaces.some(s => s !== null) ? surfaces : undefined };
  mkdirSync(dir, { recursive: true });
  const file = fileFor(dir, a.theatre, a.name), tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(pack));
  renameSync(tmp, file);
  return { file, ...describePack(pack) };
}

export function removePack(theatre: string, name: string, dir = packDir()) {
  const file = fileFor(dir, theatre, name);
  if (!existsSync(file)) throw new Error(`No pack '${name}' for '${canon(theatre)}'`);
  rmSync(file);
  return { removed: name, theatre: canon(theatre) };
}
