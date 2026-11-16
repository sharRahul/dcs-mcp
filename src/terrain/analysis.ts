/** Geometric planning only. DCS x=north, y=east, heights MSL; never invent missing data. */
export interface Point { x: number; y: number }
export interface Sample extends Point { height: number | null; surface?: number }
export interface TerrainProvider {
  source: string;
  theatre: string;
  resolutionMetres: number | null;
  sample(points: Point[]): Promise<Sample[]>;
}
export class TerrainUnavailable extends Error {}
export const MAX_SAMPLES = 8192;
export function finite(n: number, label: string): number {
  if (!Number.isFinite(n)) throw new Error(`${label} must be finite`);
  return n;
}
export function positive(n: number, label: string): number {
  if (finite(n, label) <= 0) throw new Error(`${label} must be positive`);
  return n;
}
export function distanceBearing(a: Point, b: Point) {
  for (const p of [a, b]) { finite(p.x, 'x'); finite(p.y, 'y'); }
  const distanceMetres = Math.hypot(b.x - a.x, b.y - a.y);
  return { distanceMetres, bearingDegrees: distanceMetres === 0 ? null :
    (Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI + 360) % 360,
    basis: 'DCS theatre grid; bearing clockwise from grid north' };
}
function walk(a: Point, b: Point, step: number): Point[] {
  positive(step, 'stepMetres');
  const d = distanceBearing(a, b).distanceMetres;
  const n = Math.max(1, Math.ceil(d / step));
  if (n + 1 > MAX_SAMPLES) throw new Error(`Analysis exceeds ${MAX_SAMPLES} samples; increase stepMetres`);
  return Array.from({ length: n + 1 }, (_, i) => ({ x: a.x + (b.x - a.x) * i / n, y: a.y + (b.y - a.y) * i / n }));
}
async function read(provider: TerrainProvider, points: Point[]): Promise<Sample[]> {
  if (points.length > MAX_SAMPLES) throw new Error(`Analysis exceeds ${MAX_SAMPLES} samples`);
  const samples = await provider.sample(points);
  if (samples.length !== points.length || samples.some((s, i) => s.x !== points[i].x || s.y !== points[i].y ||
    s.height === null || !Number.isFinite(s.height))) {
    throw new TerrainUnavailable('Missing, out-of-coverage, or malformed terrain samples; analysis refused');
  }
  return samples;
}
export function metadata(provider: TerrainProvider) {
  return { source: provider.source, theatre: provider.theatre, resolutionMetres: provider.resolutionMetres,
    verification: 'geometric estimate; not DCS sensor or movement simulation' };
}
export async function profile(provider: TerrainProvider, a: Point, b: Point, step: number) {
  const samples = await read(provider, walk(a, b, step));
  return { ...distanceBearing(a, b), samples };
}
export async function slope(provider: TerrainProvider, p: Point, step: number) {
  positive(step, 'stepMetres');
  const samples = await read(provider, [{ x: p.x - step, y: p.y }, { x: p.x + step, y: p.y },
    { x: p.x, y: p.y - step }, { x: p.x, y: p.y + step }, p]);
  const h = samples.map(s => s.height!);
  const northGradient = (h[1] - h[0]) / (2 * step);
  const eastGradient = (h[3] - h[2]) / (2 * step);
  return { slopeDegrees: Math.atan(Math.hypot(northGradient, eastGradient)) * 180 / Math.PI,
    northGradient, eastGradient, samples };
}
function footprint(p: Point, radius: number, step: number): Point[] {
  return [-1, 0, 1].flatMap(dx => [-1, 0, 1].flatMap(dy => {
    const x = p.x + dx * radius, y = p.y + dy * radius;
    return [{ x: x - step, y }, { x: x + step, y }, { x, y: y - step }, { x, y: y + step }, { x, y }];
  }));
}
function assessFootprint(samples: Sample[], maxSlope: number) {
  const slopes = Array.from({ length: 9 }, (_, i) => {
    const heights = samples.slice(i * 5, i * 5 + 5);
    const north = (heights[1].height! - heights[0].height!) / (heights[1].x - heights[0].x);
    const east = (heights[3].height! - heights[2].height!) / (heights[3].y - heights[2].y);
    return Math.atan(Math.hypot(north, east)) * 180 / Math.PI;
  });
  const unknownSurface = samples.some(s => s.surface === undefined || ![1, 2, 3, 4, 5].includes(s.surface));
  const water = samples.some(s => s.surface === 2 || s.surface === 3);
  const steep = slopes.some(s => s > maxSlope);
  return { suitable: water || steep ? false : unknownSurface ? null : true, water, unknownSurface,
    maxSlopeDegrees: Math.max(...slopes), samples,
    limitation: 'Sampled footprint only; trees, buildings, roads, collision geometry and unit mobility are not modelled' };
}
export async function assessPositions(provider: TerrainProvider, positions: Point[], radius: number, step: number, maxSlope: number) {
  positive(radius, 'radiusMetres'); positive(step, 'stepMetres'); positive(maxSlope, 'maxSlopeDegrees');
  const samples = await read(provider, positions.flatMap(p => footprint(p, radius, step)));
  return positions.map((p, i) => ({ ...p, ...assessFootprint(samples.slice(i * 45, i * 45 + 45), maxSlope) }));
}
export async function suitability(provider: TerrainProvider, p: Point, radius: number, step: number, maxSlope: number) {
  return (await assessPositions(provider, [p], radius, step, maxSlope))[0];
}
export interface VisibilityOptions {
  observerHeightMetres: number; targetHeightMetres: number; stepMetres: number;
  /** Effective Earth radius factor; 1 = geometric curvature, no atmospheric refraction. */
  earthRadiusFactor: number;
  maxRangeMetres?: number;
}
function visibilityFromSamples(samples: Sample[], options: VisibilityOptions) {
  const a = samples[0], b = samples[samples.length - 1];
  const distance = distanceBearing(a, b).distanceMetres;
  const observerMSL = a.height! + options.observerHeightMetres;
  const targetMSL = b.height! + options.targetHeightMetres;
  let minimumClearanceMetres = Math.min(options.observerHeightMetres, options.targetHeightMetres);
  let obstruction: Sample | null = null;
  for (let i = 1; i < samples.length - 1; i++) {
    const d = distanceBearing(a, samples[i]).distanceMetres;
    const bulge = d * (distance - d) / (2 * 6371000 * options.earthRadiusFactor);
    const clearance = observerMSL + (targetMSL - observerMSL) * d / distance - (samples[i].height! + bulge);
    if (clearance < minimumClearanceMetres) { minimumClearanceMetres = clearance; obstruction = samples[i]; }
  }
  const withinRange = options.maxRangeMetres === undefined || distance <= options.maxRangeMetres;
  return { visible: minimumClearanceMetres >= 0 && withinRange, terrainMasked: minimumClearanceMetres < 0,
    withinRange, minimumClearanceMetres, obstruction, distanceMetres: distance,
    sampleCount: samples.length, earthRadiusFactor: options.earthRadiusFactor,
    limitation: 'Sampled bare-earth LOS plus optional caller-supplied range; not radar detection. No buildings, vegetation, RCS, antenna patterns, jamming or weather' };
}
function validateVisibility(options: VisibilityOptions) {
  positive(options.earthRadiusFactor, 'earthRadiusFactor');
  positive(options.stepMetres, 'stepMetres');
  for (const h of [options.observerHeightMetres, options.targetHeightMetres]) {
    if (finite(h, 'height AGL') < 0) throw new Error('Heights AGL must be non-negative');
  }
  if (options.maxRangeMetres !== undefined) positive(options.maxRangeMetres, 'maxRangeMetres');
}
export async function lineOfSight(provider: TerrainProvider, a: Point, b: Point, options: VisibilityOptions) {
  validateVisibility(options);
  return visibilityFromSamples(await read(provider, walk(a, b, options.stepMetres)), options);
}
export async function viewshed(provider: TerrainProvider, center: Point, radius: number, rays: number, options: VisibilityOptions) {
  validateVisibility(options); positive(radius, 'radiusMetres');
  if (!Number.isInteger(rays) || rays < 4 || rays > 180) throw new Error('rays must be an integer from 4 to 180');
  if ((Math.ceil(radius / options.stepMetres) + 1) * rays > MAX_SAMPLES) throw new Error(`Analysis exceeds ${MAX_SAMPLES} samples; increase stepMetres or reduce rays`);
  const paths = Array.from({ length: rays }, (_, i) => {
    const angle = i * 2 * Math.PI / rays;
    return walk(center, { x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) }, options.stepMetres);
  });
  const samples = await read(provider, paths.flat());
  const cells = [];
  let offset = 0;
  for (let i = 0; i < paths.length; i++) {
    const ray = samples.slice(offset, offset + paths[i].length); offset += paths[i].length;
    // Return every radial cell, not just visibility at the perimeter.
    for (let j = 1; j < ray.length; j++) cells.push({ x: ray[j].x, y: ray[j].y, bearingDegrees: i * 360 / rays,
      ...visibilityFromSamples(ray.slice(0, j + 1), options) });
  }
  return { cells, rays, radiusMetres: radius, sampleCount: samples.length,
    limitation: 'Radial sampled viewshed; gaps between rays are not analysed' };
}
export async function routeFeasibility(provider: TerrainProvider, route: Point[], step: number, maxGrade: number) {
  if (route.length < 2) throw new Error('Route needs at least two points');
  positive(maxGrade, 'maxGradeDegrees');
  const required = route.slice(1).reduce((n, p, i) => n + Math.max(1, Math.ceil(distanceBearing(route[i], p).distanceMetres / positive(step, 'stepMetres'))) + 1, 0);
  if (required > MAX_SAMPLES) throw new Error(`Analysis exceeds ${MAX_SAMPLES} samples; increase stepMetres`);
  const paths = route.slice(1).map((p, i) => walk(route[i], p, step));
  const samples = await read(provider, paths.flat());
  let offset = 0;
  const legs = paths.map(path => {
    const points = samples.slice(offset, offset + path.length); offset += path.length;
    let maxGradeDegrees = 0;
    for (let i = 1; i < points.length; i++) {
      const d = distanceBearing(points[i - 1], points[i]).distanceMetres;
      if (d > 0) maxGradeDegrees = Math.max(maxGradeDegrees, Math.atan2(Math.abs(points[i].height! - points[i - 1].height!), d) * 180 / Math.PI);
    }
    const water = points.some(p => p.surface === 2 || p.surface === 3);
    const unknownSurface = points.some(p => p.surface === undefined || ![1, 2, 3, 4, 5].includes(p.surface));
    return { maxGradeDegrees, water, unknownSurface, feasible: water || maxGradeDegrees > maxGrade ? false : unknownSurface ? null : true };
  });
  return { feasible: legs.some(l => l.feasible === false) ? false : legs.some(l => l.feasible === null) ? null : true, legs,
    limitation: 'Straight sampled legs and along-route grade only; no road connectivity, bridges, cross-slope, obstacles or DCS pathfinding' };
}
