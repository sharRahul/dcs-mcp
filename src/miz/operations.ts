/** Ground templates and F10 circles. Geometries are project conventions, not ME defaults. */
import { z } from 'zod';
import { countryOffers, findUnitType } from '../data/reference.js';
import { addGroundGroup, addWaypoint, findGroup, type AddGroupArgs } from './authoring.js';
import { asTable, luaArray, type LuaTable } from './lua.js';
const point = z.object({ x: z.number().finite(), y: z.number().finite() }).strict();
export const groundMovementSchema = z.enum(['road', 'offroad', 'line_abreast', 'wedge', 'diamond', 'echelon_left', 'echelon_right']);
export const GROUND_MOVEMENT_ACTIONS = { road: 'On Road', offroad: 'Off Road', line_abreast: 'Rank', wedge: 'Vee',
  diamond: 'Diamond', echelon_left: 'EchelonL', echelon_right: 'EchelonR' } as const;
export const groundPlanSchema = z.object({
  role: z.enum(['convoy', 'patrol', 'defensive', 'assault']).default('convoy'),
  formation: z.enum(['column', 'line', 'wedge', 'rectangle']).optional(),
  spacingMetres: z.number().positive().max(2000).default(20),
  route: z.array(point.extend({ movement: groundMovementSchema.optional(), speedMps: z.number().positive().max(50).optional() })).max(100).default([]),
  speedMps: z.number().positive().max(50).default(5.5555555555556),
  onRoad: z.boolean().optional(), lateActivation: z.boolean().default(false), playerCanDrive: z.boolean().default(false),
}).strict();
export function validateGroundPlan(input: z.input<typeof groundPlanSchema>) {
  const plan = groundPlanSchema.parse(input);
  if (['convoy', 'patrol', 'assault'].includes(plan.role) && !plan.route.length) throw new Error(`${plan.role} needs route destinations`);
  if (plan.role === 'defensive' && plan.route.length) throw new Error('Defensive positions do not take movement routes');
  return plan;
}
export function createGroundPlan(mission: LuaTable, args: AddGroupArgs, input: z.input<typeof groundPlanSchema>) {
  const plan = validateGroundPlan(input), copy = structuredClone(mission);
  if (findGroup(copy, args.name)) throw new Error(`Group '${args.name}' already exists`);
  const composition = args.composition ?? [{ type: args.type, count: args.count }];
  let count = 0;
  for (const block of composition) {
    if (!Number.isInteger(block.count) || block.count < 1) throw new Error('Composition counts must be positive integers');
    if (findUnitType(block.type)?.category !== 'vehicle') throw new Error(`Unknown vehicle type '${block.type}'`);
    if (countryOffers(args.country, block.type) === false) throw new Error(`${args.country} is not offered '${block.type}'`);
    count += block.count;
  }
  if (count > 100 || count < 1) throw new Error('Ground plans support 1..100 units');
  const s = plan.spacingMetres;
  const formation = plan.formation ?? (['assault', 'defensive'].includes(plan.role) ? 'line' : 'column');
  const offsets = Array.from({ length: count }, (_, i) => {
    if (formation === 'column') return { forward: -i * s, right: 0 };
    if (formation === 'line') return { forward: 0, right: i * s };
    if (formation === 'wedge') return { forward: -Math.ceil(i / 2) * s, right: i === 0 ? 0 : (i % 2 ? -1 : 1) * Math.ceil(i / 2) * s };
    const width = Math.ceil(Math.sqrt(count));
    return { forward: -Math.floor(i / width) * s, right: (i % width) * s };
  });
  const group = addGroundGroup(copy, 'vehicle', { ...args, composition, offsets, spacingMetres: s });
  group.lateActivation = plan.lateActivation;
  for (const unit of luaArray(group.units)) unit.playerCanDrive = plan.playerCanDrive;
  const points = asTable(asTable(group.route)?.points)!;
  const first = asTable(points[1])!;
  first.speed = plan.role === 'defensive' ? 0 : plan.speedMps;
  const onRoad = plan.onRoad ?? plan.role === 'convoy';
  first.action = onRoad ? 'On Road' : formation === 'line' ? 'Rank' : formation === 'wedge' ? 'Vee' : 'Off Road';
  let action = String(first.action);
  for (const p of plan.route) {
    if (p.movement) action = GROUND_MOVEMENT_ACTIONS[p.movement];
    addWaypoint(copy, args.name, { x: p.x, y: p.y, speedMps: p.speedMps ?? plan.speedMps, action });
  }
  if (plan.role === 'patrol') {
    const lastIndex = luaArray(points).length;
    const last = asTable(points[lastIndex])!;
    last.task = { id: 'ComboTask', params: { tasks: { 1: { id: 'GoToWaypoint', enabled: true, auto: false, number: 1,
      params: { fromWaypointIndex: lastIndex, nWaypointIndx: 1 } } } } };
  }
  Object.assign(mission, copy);
  return { group: args.name, units: count, role: plan.role, formation, onRoad,
    verification: 'offline only; terrain/pathfinding and Combined Arms type support require DCS' };
}

const LAYERS = ['Red', 'Blue', 'Neutral', 'Common', 'Author'] as const;
export const ringSchema = z.object({ name: z.string().min(1).max(128), center: point, radiusMetres: z.number().positive().max(1000000),
  layer: z.enum(LAYERS).default('Author'), color: z.string().regex(/^0x[0-9a-fA-F]{8}$/).default('0xff0000ff') }).strict();
export function addThreatRing(mission: LuaTable, input: z.input<typeof ringSchema>) {
  const spec = ringSchema.parse(input);
  const drawings = asTable(mission.drawings) ?? {};
  const layers = asTable(drawings.layers) ?? {};
  let layer = luaArray(layers).find(l => l.name === spec.layer);
  if (!layer) {
    // Always use the five DCS standard layers. Preserve additional existing data as-is.
    for (const name of LAYERS) if (!luaArray(layers).some(l => l.name === name)) {
      const next = Math.max(0, ...Object.keys(layers).map(Number).filter(Number.isFinite)) + 1;
      layers[next] = { name, visible: true, objects: {} };
    }
    layer = luaArray(layers).find(l => l.name === spec.layer)!;
  }
  const objects = asTable(layer.objects) ?? {};
  if (luaArray(objects).some(o => o.name === spec.name)) throw new Error(`Drawing '${spec.name}' already exists in ${spec.layer}`);
  const next = Math.max(0, ...Object.keys(objects).map(Number).filter(Number.isFinite)) + 1;
  objects[next] = { visible: true, name: spec.name, layerName: spec.layer, mapX: spec.center.x, mapY: spec.center.y,
    primitiveType: 'Polygon', polygonMode: 'circle', radius: spec.radiusMetres,
    colorString: spec.color, fillColorString: '0x00000000', thickness: 2, style: 'solid' };
  layer.objects = objects; drawings.layers = layers;
  if (!drawings.options) drawings.options = { hiddenOnF10Map: Object.fromEntries(
    ['Observer', 'Instructor', 'ForwardObserver', 'Spectrator', 'ArtilleryCommander', 'Pilot'].map(role => [role, { Neutral: false, Blue: false, Red: false }])) };
  mission.drawings = drawings;
  return { drawing: spec.name, layer: spec.layer, radiusMetres: spec.radiusMetres,
    limitation: 'Caller-supplied range, visual aid only; not a model of DCS engagement range', verification: 'offline only' };
}

export const surfaceTaskSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('hold') }).strict(),
  z.object({ kind: z.literal('fire_at_point'), point, radiusMetres: z.number().min(0).max(100000).default(0), rounds: z.number().int().positive().max(10000).optional() }).strict(),
  z.object({ kind: z.literal('go_to_waypoint'), destination: z.number().int().positive() }).strict(),
]);
/** Common MovingPoint task format, pydcs task.py Hold/FireAtPoint/GoToWaypoint. */
export function appendSurfaceTask(mission: LuaTable, name: string, index: number, input: z.input<typeof surfaceTaskSchema>) {
  const spec = surfaceTaskSchema.parse(input), found = findGroup(mission, name);
  if (!found || !['vehicle', 'ship'].includes(found.category)) throw new Error('Surface tasks require a vehicle or ship group');
  if (!Number.isInteger(index) || index < 1) throw new Error('waypointIndex is 1-based');
  const points = asTable(asTable(found.group.route)?.points), wp = asTable(points?.[index]);
  if (!wp) throw new Error('Waypoint does not exist');
  const combo = asTable(wp.task);
  if (combo && combo.id !== 'ComboTask') throw new Error('Refusing to replace existing non-ComboTask data');
  const tasks = asTable(asTable(combo?.params)?.tasks) ?? {};
  const next = Math.max(0, ...Object.keys(tasks).map(Number).filter(Number.isFinite)) + 1;
  let task: LuaTable;
  if (spec.kind === 'go_to_waypoint') {
    if (!asTable(points?.[spec.destination]) || spec.destination === index) throw new Error('Destination must be another existing waypoint');
    task = { id: 'GoToWaypoint', params: { fromWaypointIndex: index, nWaypointIndx: spec.destination } };
  } else if (spec.kind === 'hold') task = { id: 'Hold', params: { templateId: '' } };
  else task = { id: 'FireAtPoint', params: { x: spec.point.x, y: spec.point.y, zoneRadius: spec.radiusMetres,
    expendQty: spec.rounds ?? 1, expendQtyEnabled: spec.rounds !== undefined, templateId: '', weaponType: 9663676414 } };
  tasks[next] = { ...task, enabled: true, auto: false, number: next };
  if (!combo) wp.task = { id: 'ComboTask', params: { tasks } };
  else { const params = (combo.params ??= {}) as LuaTable; params.tasks = tasks; }
  return { group: name, waypointIndex: index, taskIndex: next, verification: 'offline only',
    warning: 'Task structure supported; weapon range, ammunition, type-specific AI execution and pathfinding require DCS verification' };
}
