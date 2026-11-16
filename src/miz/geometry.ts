/** Flat-grid geometry in DCS metres (x north, y east, bearing clockwise from grid north). */
import { asTable, luaArray, type LuaTable } from './lua.js';

export interface XY { x: number; y: number }
const DEG = Math.PI / 180;
const round = (n: number) => Math.round(n * 1000) / 1000;
const pt = (x: number, y: number) => ({ x: round(x), y: round(y) });

export function pointFromBearing(from: XY, bearingDegrees: number, distanceMetres: number): XY {
  return pt(from.x + distanceMetres * Math.cos(bearingDegrees * DEG), from.y + distanceMetres * Math.sin(bearingDegrees * DEG));
}
export function lerp(a: XY, b: XY, t: number): XY { return pt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t); }

/** mulberry32: deterministic when a seed is given, so a generated layout can be reproduced. */
function rng(seed?: number) {
  if (seed === undefined) return Math.random;
  let s = seed >>> 0;
  return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** Uniform over the disc area (sqrt radius), not clustered at the centre. */
export function randomPointInCircle(centre: XY, radiusMetres: number, count = 1, seed?: number): XY[] {
  const r = rng(seed);
  return Array.from({ length: count }, () => { const d = radiusMetres * Math.sqrt(r()), b = 360 * r(); return pointFromBearing(centre, b, d); });
}

export function pointInPolygon(p: XY, poly: XY[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Zone membership for circle zones (type 0) and quad zones (type 2, `verticies`). */
export function pointsInZone(mission: LuaTable, zoneName: string, points: XY[]) {
  const zone = luaArray(asTable(mission.triggers)?.zones).find(z => z.name === zoneName);
  if (!zone) throw new Error(`No trigger zone named '${zoneName}'`);
  const verts = luaArray(zone.verticies).map(v => ({ x: Number(v.x), y: Number(v.y) }));
  const quad = Number(zone.type) === 2 && verts.length >= 3;
  const centre = { x: Number(zone.x), y: Number(zone.y) }, radius = Number(zone.radius);
  return { zone: zoneName, shape: quad ? 'quad' : 'circle', results: points.map(p => ({ ...p,
    inside: quad ? pointInPolygon(p, verts) : Math.hypot(p.x - centre.x, p.y - centre.y) <= radius })) };
}
