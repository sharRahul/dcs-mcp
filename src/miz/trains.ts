/**
 * Trains, in the exact shape the Mission Editor saves them.
 *
 * Captured from an ME-saved mission (a train group in `F 16 - Operation Silent Strike
 * v07.miz`), because none of it is guessable:
 *   - a train is a GROUND group: `country.vehicle.group`, `task = "Ground Nothing"`;
 *   - its units are type `Train` — which the pydcs catalogue lists as a STATIC type, so
 *     the usual ground-group path refuses it; each unit carries `wagons = {}`,
 *     `playerCanDrive = false` and `coldAtStart = false`;
 *   - every route point is `type = "On Railroads"` and `action = "On Railroads"`, with
 *     only point 1 ETA-locked, exactly like any other ground route.
 *
 * `wagons` was empty in every train in every ME-saved mission available here, so this
 * writes it empty too and refuses to populate it: what a non-empty wagons table looks
 * like is not established, and a guess would be a train DCS may ignore.
 *
 * Rails are the caller's problem, honestly: DCS snaps a train to the railway when the ME
 * places it, and this server has no offline railway graph (it is terrain data it cannot
 * read). Give it points ON the railway — `dcs_terrain_roads` with kind=railroads returns
 * rail-snapped coordinates from a running mission — or the train will sit next to the
 * track. Nothing here has been flown.
 */
import { z } from 'zod';
import { assertNamesFree, countryId, ensureCountry, headingRadians, maxIds } from './authoring.js';
import { findUnitType } from '../data/reference.js';
import type { LuaTable } from './lua.js';

export const TRAIN_UNIT_TYPE = 'Train';

export const trainSchema = z.object({
  name: z.string().min(1).max(64),
  side: z.enum(['red', 'blue', 'neutrals']).default('red'),
  country: z.string().min(1),
  countryId: z.number().int().positive().optional(),
  /** Rail path in DCS metres (x = north, y = east). Point 1 is where the train spawns. */
  path: z.array(z.object({ x: z.number().finite(), y: z.number().finite() }).strict()).min(1).max(100),
  altitudeMetres: z.number().finite().optional().describe('Ground altitude of the first point; the editor stores one per point.'),
  headingDegrees: z.number().min(-360).max(360).default(0),
  speedKph: z.number().min(1).max(160).default(40),
  count: z.number().int().min(1).max(10).default(1).describe('Train units in the group (the editor places one per train).'),
  skill: z.enum(['Average', 'Good', 'High', 'Excellent', 'Random']).default('High'),
}).strict();

export function addTrain(mission: LuaTable, input: z.input<typeof trainSchema>) {
  const a = trainSchema.parse(input);
  if (findUnitType(TRAIN_UNIT_TYPE)?.category === undefined) {
    throw new Error(`The bundled catalogue has no '${TRAIN_UNIT_TYPE}' type; regenerate data/unit-types.json.`);
  }
  const unitNames = Array.from({ length: a.count }, (_, i) => `${a.name}-${i + 1}`);
  assertNamesFree(mission, a.name, unitNames);
  const country = ensureCountry(mission, a.side, a.country, countryId(a.country, a.countryId));
  const catTable = (country.vehicle ??= { group: {} }) as LuaTable;
  const groups = (catTable.group ??= {}) as LuaTable;
  const ids = maxIds(mission);
  const speedMps = a.speedKph / 3.6;
  const heading = headingRadians(a.headingDegrees);
  const start = a.path[0];

  // The editor keeps the units at the group's own point; the engine strings the train
  // along the track from there.
  const units: LuaTable = {};
  unitNames.forEach((name, i) => {
    units[i + 1] = {
      type: TRAIN_UNIT_TYPE,
      unitId: ids.unitId + 1 + i,
      name,
      x: start.x, y: start.y,
      heading,
      skill: a.skill,
      coldAtStart: false,
      playerCanDrive: false,
      // Empty exactly as every ME-saved train in evidence has it.
      wagons: {},
    };
  });

  const points: LuaTable = {};
  a.path.forEach((p, i) => {
    points[i + 1] = {
      type: 'On Railroads',
      action: 'On Railroads',
      x: p.x, y: p.y,
      alt: a.altitudeMetres ?? 0,
      alt_type: 'BARO',
      speed: speedMps,
      ETA: 0,
      // Only the mission-start point is ETA-locked; locking later points pins each one
      // to a computed arrival time (the editor's red ETA).
      ETA_locked: i === 0,
      speed_locked: true,
      formation_template: '',
      task: { id: 'ComboTask', params: { tasks: {} } },
    };
  });

  const group: LuaTable = {
    name: a.name,
    groupId: ids.groupId + 1,
    task: 'Ground Nothing',
    taskSelected: true,
    tasks: {},
    uncontrollable: false,
    hidden: false,
    visible: false,
    start_time: 0,
    units,
    route: { spans: {}, points },
    x: start.x, y: start.y,
  };
  const index = Math.max(0, ...Object.keys(groups).map(Number).filter(Number.isFinite)) + 1;
  groups[index] = group;
  return {
    group: a.name, groupId: group.groupId as number, units: unitNames,
    points: a.path.length, speedKph: a.speedKph, speedMps,
    notes: [
      'Group shape, the "On Railroads" route points and the unit fields are copied from an ME-saved mission; wagons is written empty because no non-empty example exists here.',
      'The path must already be on the railway: there is no offline railway graph. Get rail-snapped points from a running mission with dcs_terrain_roads kind=railroads.',
      `'${TRAIN_UNIT_TYPE}' is a static type in the pydcs catalogue but a vehicle group in the editor's own files, so the validator's category check does not apply to it.`,
      'Not flown or opened in the Mission Editor by this project.',
    ],
  };
}
