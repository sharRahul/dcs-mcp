/**
 * F10 map drawings. Field shapes follow pydcs 1.0.0 dcs/drawing/{drawing,line,polygon,
 * text_box,icon,layer}.py — that is the format evidence; none of the shapes added here
 * has been opened in the Mission Editor by this project yet.
 */
import { z } from 'zod';
import { xySchema } from './configuration.js';
import { asTable, type LuaTable } from './lua.js';
import { meIcons } from '../data/me-icons.js';

export const STANDARD_LAYERS = ['Red', 'Blue', 'Neutral', 'Common', 'Author'] as const;
/** pydcs drawing.py LineStyle values. */
export const LINE_STYLES = ['solid', 'dot', 'dash', 'cross', 'square', 'triangle', 'wirefence', 'dot2', 'solid2',
  'dotdash', 'strongpoint', 'boundry1', 'boundry2', 'boundry3', 'boundry4', 'boundry5'] as const;
/** pydcs icon.py StandardIcon: the nine names pydcs knows, kept so existing calls still work. */
export const STANDARD_ICONS = {
  Mechanized: 'P91000001.png', MechanizedInfantryWithFightingVehicle: 'P91000002.png', Recce: 'P91000003.png',
  MechanizedInfantry: 'P91000004.png', Logistics: 'P91000005.png', MechanizedArtillery: 'P91000006.png',
  MechanizedRocketArtillery: 'P91000007.png', AirDefense: 'P91000009.png', SearchRadar: 'P91000010.png',
} as const;

/**
 * Every icon the Mission Editor's own picker offers, by the editor's label
 * (data/me-icons.json, from the install's icons.lua), plus pydcs's nine names. A pydcs
 * name wins a collision so nothing that worked before changes meaning. Unknown names are
 * refused: the icon file must be one the editor itself lists, never a guessed file name.
 */
export const ICON_FILES: Record<string, string> = (() => {
  const all: Record<string, string> = {};
  try { Object.assign(all, meIcons().icons); } catch { /* catalogue unreadable: pydcs names still work */ }
  return { ...all, ...STANDARD_ICONS };
})();
const ICON_NAMES = Object.keys(ICON_FILES).sort() as [string, ...string[]];
/** pydcs polygon.py Arrow.get_default_arrow_points: the arrow outline relative to its origin. */
const ARROW_POINTS = [[976.01054900139, 0], [976.01054900139, 5205.3895946741], [2602.694797337, 5205.3895946741],
  [0, 7808.0843920111], [-2602.694797337, 5205.3895946741], [-976.01054900139, 5205.3895946741],
  [-976.01054900139, 0], [976.01054900139, 0]];

const colour = z.string().regex(/^0x[0-9a-fA-F]{8}$/);
const common = { name: z.string().min(1).max(128), layer: z.enum(STANDARD_LAYERS).default('Author'),
  origin: xySchema, color: colour.default('0xffffffff'), fill: colour.default('0x00000000'),
  thickness: z.number().positive().max(50).default(2), visible: z.boolean().default(true),
  style: z.enum(LINE_STYLES).default('solid') };
const angle = z.number().finite().min(-360).max(360).default(0)
  .describe('Rotation as the editor stores it (pydcs passes it through unconverted; degrees by its usage). Not ME-verified.');
const size = z.number().positive().max(1000000);
export const drawingSchema = z.discriminatedUnion('kind', [
  z.object({ ...common, kind: z.literal('line'), points: z.array(xySchema).min(2).max(1000), closed: z.boolean().default(false),
    mode: z.enum(['segment', 'segments', 'free']).optional().describe('Default: segment for 2 points, segments otherwise. free = freehand line.') }).strict(),
  z.object({ ...common, kind: z.literal('polygon'), points: z.array(xySchema).min(3).max(1000) }).strict(),
  z.object({ ...common, kind: z.literal('circle'), radiusMetres: size }).strict(),
  z.object({ ...common, kind: z.literal('oval'), radius1Metres: size, radius2Metres: size, angle }).strict(),
  z.object({ ...common, kind: z.literal('rectangle'), widthMetres: size, heightMetres: size, angle }).strict(),
  z.object({ ...common, kind: z.literal('arrow'), lengthMetres: size, angle }).strict(),
  z.object({ ...common, kind: z.literal('oblong'), end: xySchema, radiusMetres: size,
    resolution: z.number().int().min(4).max(90).default(20) }).strict()
    .describe('A stadium shape (e.g. a corridor) from origin to end; written as a free polygon like pydcs add_oblong.'),
  z.object({ ...common, kind: z.literal('text'), text: z.string().min(1).max(10000), fontSize: z.number().int().min(6).max(144).default(14), angle }).strict(),
  z.object({ ...common, kind: z.literal('icon'), icon: z.enum(ICON_NAMES).describe("Icon name: a Mission Editor picker label (e.g. 'Air Defence SAM', 'Warship') or a pydcs StandardIcon name. dcs_list_map_icons lists them."),
    scale: z.number().positive().max(10).default(1), angle: z.number().int().min(-360).max(360).default(0) }).strict(),
]);

const entries = (table: LuaTable) => Object.values(table).filter(v => v && typeof v === 'object') as LuaTable[];
const nextKey = (t: LuaTable) => Math.max(0, ...Object.keys(t).map(Number).filter(Number.isFinite)) + 1;
const relative = (points: { x: number; y: number }[], o: { x: number; y: number }) =>
  Object.fromEntries(points.map((p, j) => [j + 1, { x: p.x - o.x, y: p.y - o.y }]));
const DEG = Math.PI / 180;

/** pydcs layer.add_oblong: two half-circles joined, closed by repeating the first point. Absolute points. */
export function oblongPoints(p1: { x: number; y: number }, p2: { x: number; y: number }, radius: number, resolution: number) {
  const hdg = Math.atan2(p2.y - p1.y, p2.x - p1.x) / DEG;
  const from = (p: { x: number; y: number }, h: number) => ({ x: p.x + Math.cos(h * DEG) * radius, y: p.y + Math.sin(h * DEG) * radius });
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i <= resolution; i++) pts.push(from(p2, hdg - 90 + i * (180 / resolution)));
  for (let i = 0; i <= resolution; i++) pts.push(from(p1, hdg + 90 + i * (180 / resolution)));
  pts.push({ ...pts[0] });
  return pts;
}

function drawingsCopy(mission: LuaTable): LuaTable {
  const copy = structuredClone(asTable(mission.drawings) ?? {});
  const layers = (copy.layers ??= {}) as LuaTable;
  for (const name of STANDARD_LAYERS) if (!entries(layers).some(l => l.name === name)) layers[nextKey(layers)] = { name, visible: true, objects: {} };
  if (!copy.options) copy.options = { hiddenOnF10Map: Object.fromEntries(['Observer', 'Instructor', 'ForwardObserver', 'Spectrator', 'ArtilleryCommander', 'Pilot'].map(r => [r, { Neutral: false, Blue: false, Red: false }])) };
  return copy;
}

export function addDrawing(mission: LuaTable, input: z.input<typeof drawingSchema>) {
  const a = drawingSchema.parse(input), copy = drawingsCopy(mission);
  const layer = entries(copy.layers as LuaTable).find(l => l.name === a.layer)!;
  const objects = (layer.objects ??= {}) as LuaTable;
  if (entries(objects).some(o => o.name === a.name)) throw new Error('Drawing name already exists in this layer');
  let origin = a.origin;
  const object: LuaTable = { name: a.name, layerName: a.layer, visible: a.visible, colorString: a.color };
  const polygon = (mode: string, extra: LuaTable) => Object.assign(object, { primitiveType: 'Polygon', polygonMode: mode,
    fillColorString: a.fill, thickness: a.thickness, style: a.style, ...extra });
  switch (a.kind) {
    case 'text':
      // pydcs layer.add_text_box default font.
      Object.assign(object, { primitiveType: 'TextBox', text: a.text, fontSize: a.fontSize, font: 'DejaVuLGCSansCondensed.ttf',
        borderThickness: a.thickness, fillColorString: a.fill, angle: a.angle });
      break;
    case 'icon':
      Object.assign(object, { primitiveType: 'Icon', file: ICON_FILES[a.icon], scale: a.scale, angle: a.angle });
      break;
    case 'circle': polygon('circle', { radius: a.radiusMetres }); break;
    case 'oval': polygon('oval', { r1: a.radius1Metres, r2: a.radius2Metres, angle: a.angle }); break;
    case 'rectangle': polygon('rect', { width: a.widthMetres, height: a.heightMetres, angle: a.angle }); break;
    case 'arrow':
      polygon('arrow', { length: a.lengthMetres, angle: a.angle,
        points: Object.fromEntries(ARROW_POINTS.map(([x, y], j) => [j + 1, { x, y }])) });
      break;
    case 'oblong': {
      const pts = oblongPoints(a.origin, a.end, a.radiusMetres, a.resolution);
      origin = pts[0];
      polygon('free', { points: relative(pts, origin) });
      break;
    }
    case 'polygon': polygon('free', { points: relative(a.points, origin) }); break;
    case 'line':
      // API vertices are absolute; DCS stores drawing vertices relative to mapX/mapY.
      Object.assign(object, { primitiveType: 'Line', lineMode: a.mode ?? (a.points.length === 2 ? 'segment' : 'segments'),
        closed: a.closed, thickness: a.thickness, style: a.style, points: relative(a.points, origin) });
      break;
  }
  object.mapX = origin.x; object.mapY = origin.y;
  const i = nextKey(objects);
  objects[i] = object;
  mission.drawings = copy;
  return { name: a.name, layer: a.layer, index: i, primitiveType: object.primitiveType,
    verification: 'offline format only (pydcs field shapes); coalition visibility follows DCS standard layers and mission F10 options' };
}

export function listDrawings(mission: LuaTable, layerName?: string) {
  const layers = entries(asTable(asTable(mission.drawings)?.layers) ?? {});
  return layers.filter(l => !layerName || l.name === layerName).flatMap(l => entries(asTable(l.objects) ?? {}).map(o => ({
    layer: String(l.name), name: String(o.name), primitiveType: String(o.primitiveType ?? ''),
    mode: o.polygonMode ?? o.lineMode ?? undefined, x: Number(o.mapX), y: Number(o.mapY), visible: o.visible !== false,
  })));
}

function renumber(objects: LuaTable, keep: LuaTable[]): void {
  for (const k of Object.keys(objects)) delete objects[k];
  keep.forEach((o, j) => { objects[j + 1] = o; });
}

export function removeDrawing(mission: LuaTable, layerName: string, name: string) {
  const copy = drawingsCopy(mission);
  const layer = entries(copy.layers as LuaTable).find(l => l.name === layerName);
  if (!layer) throw new Error(`No drawing layer '${layerName}'`);
  const objects = (layer.objects ??= {}) as LuaTable, all = entries(objects);
  if (!all.some(o => o.name === name)) throw new Error(`No drawing '${name}' on layer '${layerName}'`);
  renumber(objects, all.filter(o => o.name !== name));
  mission.drawings = copy;
  return { removed: name, layer: layerName, remaining: all.length - 1 };
}

export function clearLayer(mission: LuaTable, layerName: string) {
  const copy = drawingsCopy(mission);
  const layer = entries(copy.layers as LuaTable).find(l => l.name === layerName);
  if (!layer) throw new Error(`No drawing layer '${layerName}'`);
  const objects = (layer.objects ??= {}) as LuaTable, count = entries(objects).length;
  renumber(objects, []);
  mission.drawings = copy;
  return { layer: layerName, removed: count };
}
