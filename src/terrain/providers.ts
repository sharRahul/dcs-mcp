import { bridgeRequest, type BridgeOptions } from '../bridge/client.js';
import { resolveTheatreName } from '../data/reference.js';
import { finite, positive, MAX_SAMPLES, TerrainUnavailable, type Point, type TerrainProvider, type Sample } from './analysis.js';

export interface ElevationGrid {
  theatre: string;
  source: string;
  origin: Point;
  spacingMetres: number;
  rows: number;
  columns: number;
  /** Row increases north (x), column increases east (y). null means no data. */
  heights: (number | null)[];
  /** DCS land surface codes 1..5, nearest node. Optional: suitability becomes indeterminate. */
  surfaces?: (number | null)[];
}
export function gridProvider(grid: ElevationGrid, theatre: string): TerrainProvider {
  if ((resolveTheatreName(grid.theatre) ?? grid.theatre) !== (resolveTheatreName(theatre) ?? theatre))
    throw new TerrainUnavailable(`Grid theatre '${grid.theatre}' does not match '${theatre}'`);
  positive(grid.spacingMetres, 'grid spacing'); finite(grid.origin.x, 'origin.x'); finite(grid.origin.y, 'origin.y');
  if (!grid.source.trim()) throw new Error('Grid source/provenance is required');
  const size = grid.rows * grid.columns;
  if (![grid.rows, grid.columns].every(n => Number.isInteger(n) && n >= 2) || size > 65536 ||
    grid.heights.length !== size || (grid.surfaces && grid.surfaces.length !== size)) throw new Error('Invalid grid dimensions or data length (maximum 65536 nodes)');
  if (grid.heights.some(h => h !== null && !Number.isFinite(h))) throw new Error('Invalid grid elevation');
  if (grid.surfaces?.some(s => s !== null && ![1, 2, 3, 4, 5].includes(s))) throw new Error('Invalid DCS surface code');
  return { source: grid.source, theatre, resolutionMetres: grid.spacingMetres, async sample(points) {
    return points.map(p => {
      finite(p.x, 'x'); finite(p.y, 'y');
      const row = (p.x - grid.origin.x) / grid.spacingMetres;
      const col = (p.y - grid.origin.y) / grid.spacingMetres;
      if (row < 0 || col < 0 || row > grid.rows - 1 || col > grid.columns - 1) return { ...p, height: null };
      const r = Math.min(Math.floor(row), grid.rows - 2), c = Math.min(Math.floor(col), grid.columns - 2);
      const dr = row - r, dc = col - c;
      const corners = [[r, c, (1 - dr) * (1 - dc)], [r + 1, c, dr * (1 - dc)],
        [r, c + 1, (1 - dr) * dc], [r + 1, c + 1, dr * dc]];
      let height: number | null = 0;
      for (const [rr, cc, weight] of corners) {
        if (weight === 0) continue;
        const h = grid.heights[rr * grid.columns + cc];
        if (h === null) { height = null; break; }
        height += h * weight;
      }
      const surface = grid.surfaces?.[Math.round(row) * grid.columns + Math.round(col)] ?? undefined;
      return { ...p, height, surface };
    });
  } };
}
/** Uses the existing structured land command, with no raw Lua execution. */
export async function liveProvider(theatre: string, options: BridgeOptions): Promise<TerrainProvider> {
  try {
    const mission = await bridgeRequest({ cmd: 'mission' }, options) as { theatre?: string };
    if ((resolveTheatreName(mission.theatre ?? '') ?? mission.theatre) !== (resolveTheatreName(theatre) ?? theatre))
      throw new TerrainUnavailable(`Running theatre '${mission.theatre ?? 'unknown'}' does not match '${theatre}'`);
  } catch (error) {
    throw new TerrainUnavailable(`Live terrain unavailable: ${(error as Error).message}`);
  }
  return { source: 'DCS bridge land.getHeight/getSurfaceType (coordinates rounded to millimetres)', theatre,
    resolutionMetres: null, async sample(points) {
      if (points.length > MAX_SAMPLES) throw new Error('Terrain sample budget exceeded');
      const samples: Sample[] = [];
      for (let i = 0; i < points.length; i += 500) {
        const batch = points.slice(i, i + 500);
        try {
          const data = await bridgeRequest({ cmd: 'land', args: { points: batch } }, options) as { points?: Sample[] };
          if (!Array.isArray(data.points) || data.points.length !== batch.length) throw new Error('Malformed terrain response');
          data.points.forEach((s, j) => {
            if (!Number.isFinite(s.x) || !Number.isFinite(s.y) || Math.abs(s.x - batch[j].x) > .002 || Math.abs(s.y - batch[j].y) > .002 || !Number.isFinite(s.height)) throw new Error('Malformed terrain point');
            samples.push({ ...batch[j], height: s.height, surface: s.surface });
          });
        } catch (error) { throw new TerrainUnavailable(`Live terrain query failed: ${(error as Error).message}`); }
      }
      return samples;
    } };
}
