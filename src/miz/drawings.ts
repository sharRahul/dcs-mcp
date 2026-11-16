/** pydcs drawing/drawing.py, line.py, polygon.py and text_box.py field shapes. */
import { z } from 'zod';
import { xySchema } from './configuration.js';
import { asTable, type LuaTable } from './lua.js';
const common = { name: z.string().min(1).max(128), layer: z.enum(['Red', 'Blue', 'Neutral', 'Common', 'Author']).default('Author'),
  origin: xySchema, color: z.string().regex(/^0x[0-9a-fA-F]{8}$/).default('0xffffffff'), fill: z.string().regex(/^0x[0-9a-fA-F]{8}$/).default('0x00000000'),
  thickness: z.number().positive().max(50).default(2), visible: z.boolean().default(true) };
export const drawingSchema = z.discriminatedUnion('kind', [
  z.object({ ...common, kind: z.literal('line'), points: z.array(xySchema).min(2).max(1000), closed: z.boolean().default(false) }).strict(),
  z.object({ ...common, kind: z.literal('polygon'), points: z.array(xySchema).min(3).max(1000) }).strict(),
  z.object({ ...common, kind: z.literal('circle'), radiusMetres: z.number().positive().max(1000000) }).strict(),
  z.object({ ...common, kind: z.literal('text'), text: z.string().min(1).max(10000), fontSize: z.number().int().min(6).max(144).default(14), angle: z.literal(0).default(0) }).strict(),
]);
const entries = (table: LuaTable) => Object.values(table).filter(v => v && typeof v === 'object') as LuaTable[];
export function addDrawing(mission: LuaTable, input: z.input<typeof drawingSchema>) {
  const a = drawingSchema.parse(input), copy = structuredClone(asTable(mission.drawings) ?? {});
  const layers = (copy.layers ??= {}) as LuaTable;
  for (const name of ['Red', 'Blue', 'Neutral', 'Common', 'Author']) if (!entries(layers).some(l => l.name === name)) {
    const i = Math.max(0, ...Object.keys(layers).map(Number).filter(Number.isFinite)) + 1;
    layers[i] = { name, visible: true, objects: {} };
  }
  const layer = entries(layers).find(l => l.name === a.layer)!;
  const objects = (layer.objects ??= {}) as LuaTable;
  if (entries(objects).some(o => o.name === a.name)) throw new Error('Drawing name already exists in this layer');
  const i = Math.max(0, ...Object.keys(objects).map(Number).filter(Number.isFinite)) + 1;
  const object: LuaTable = { name: a.name, layerName: a.layer, visible: a.visible, mapX: a.origin.x, mapY: a.origin.y, colorString: a.color };
  if (a.kind === 'text') Object.assign(object, { primitiveType: 'TextBox', text: a.text, fontSize: a.fontSize, font: 'DejaVuLGCSansCondensed', borderThickness: a.thickness, fillColorString: a.fill, angle: a.angle });
  else {
    Object.assign(object, { thickness: a.thickness, style: 'solid' });
    if (a.kind === 'circle') Object.assign(object, { primitiveType: 'Polygon', polygonMode: 'circle', radius: a.radiusMetres, fillColorString: a.fill });
    else {
      // API vertices are absolute; DCS stores drawing vertices relative to mapX/mapY.
      const points = Object.fromEntries(a.points.map((p, j) => [j + 1, { x: p.x - a.origin.x, y: p.y - a.origin.y }]));
      if (a.kind === 'line') Object.assign(object, { primitiveType: 'Line', lineMode: a.points.length === 2 ? 'segment' : 'segments', closed: a.closed, points });
      else Object.assign(object, { primitiveType: 'Polygon', polygonMode: 'free', fillColorString: a.fill, points });
    }
  }
  objects[i] = object;
  if (!copy.options) copy.options = { hiddenOnF10Map: Object.fromEntries(['Observer', 'Instructor', 'ForwardObserver', 'Spectrator', 'ArtilleryCommander', 'Pilot'].map(r => [r, { Neutral: false, Blue: false, Red: false }])) };
  mission.drawings = copy;
  return { name: a.name, layer: a.layer, index: i, verification: 'offline format only; coalition visibility follows DCS standard layers and mission F10 options' };
}
