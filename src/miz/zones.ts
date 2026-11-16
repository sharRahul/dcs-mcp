/**
 * Quad (polygon) trigger zones, pydcs triggers.py TriggerZoneQuadPoint: type = 2, absolute
 * `verticies` (DCS's own spelling), x/y at the centroid, radius 0 as pydcs notes the editor
 * writes for new ones. Exactly four vertices: the editor's zone type is a quad. Offline only.
 */
import { asTable, luaArray, type LuaTable } from './lua.js';
import { maxZoneId } from './authoring.js';

export interface QuadZoneArgs { name: string; vertices: { x: number; y: number }[]; hidden?: boolean; color?: [number, number, number, number] }

export function addQuadZone(mission: LuaTable, args: QuadZoneArgs): LuaTable {
  if (args.vertices.length !== 4) throw new Error('A quad zone has exactly 4 vertices');
  for (const v of args.vertices) if (!Number.isFinite(v.x) || !Number.isFinite(v.y)) throw new Error('Vertices must be finite DCS x/y metres');
  // Reject a self-intersecting quad: the two diagonals of a simple quad's edges never cross.
  const [a, b, c, d] = args.vertices;
  const cross = (p: typeof a, q: typeof a, r: typeof a) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const crosses = (p1: typeof a, p2: typeof a, p3: typeof a, p4: typeof a) =>
    cross(p1, p2, p3) * cross(p1, p2, p4) < 0 && cross(p3, p4, p1) * cross(p3, p4, p2) < 0;
  if (crosses(a, b, c, d) || crosses(b, c, d, a)) throw new Error('Quad vertices cross; give them in order around the shape');
  const area = Math.abs(cross(a, b, c) + cross(a, c, d)) / 2;
  if (area < 1) throw new Error('Quad zone has (near) zero area');
  const triggers = (mission.triggers ??= { zones: {} }) as LuaTable;
  const zones = (triggers.zones ??= {}) as LuaTable;
  if (luaArray(zones).some(z => z.name === args.name)) throw new Error(`A trigger zone named '${args.name}' already exists`);
  const cx = args.vertices.reduce((s, v) => s + v.x, 0) / 4, cy = args.vertices.reduce((s, v) => s + v.y, 0) / 4;
  const [r, g, bl, al] = args.color ?? [1, 1, 1, 0.15];
  const zone: LuaTable = {
    name: args.name, zoneId: maxZoneId(mission) + 1, x: cx, y: cy, radius: 0, hidden: args.hidden ?? false, type: 2,
    heading: 0, properties: {}, color: { 1: r, 2: g, 3: bl, 4: al },
    verticies: Object.fromEntries(args.vertices.map((v, i) => [i + 1, { x: v.x, y: v.y }])),
  };
  const next = Math.max(0, ...Object.keys(zones).map(Number).filter(Number.isFinite)) + 1;
  zones[next] = zone;
  return zone;
}
