/**
 * Troop transport: wiring a helicopter (or vehicle) group to pick up a ground group and
 * put it down somewhere else.
 *
 * DCS does this with three tasks that have to agree with each other, which is the whole
 * reason this is one call rather than three:
 *   - the TRANSPORT gets `Embarking` at its pickup waypoint, naming the group(s) to load
 *     and distributing them over its own units;
 *   - the TROOPS get `EmbarkToTransport` at their waypoint, with the same pickup point
 *     and a radius to wait in;
 *   - the TRANSPORT gets `DisembarkFromTransport` at its drop waypoint.
 * Get the group ids or the coordinates out of step and nothing happens at all — no error,
 * the helicopter just lands and leaves.
 *
 * Evidence. `Embarking` and `EmbarkToTransport` are taken from Mission-Editor-saved
 * missions, field for field:
 *   Embarking.params         = { distributionFlag, groupsForEmbarking = {groupId},
 *                                durationFlag, distribution = { [unitId] = {groupId} },
 *                                x, y, onStartMission, duration }
 *   EmbarkToTransport.params = { x, y, zoneRadius }
 * `durationFlag` and `onStartMission` are not in the Hoggit documentation, which is why
 * this does not go through the catalogue (`actions.ts` refuses undocumented params): they
 * are in the editor's own output. `DisembarkFromTransport` is Hoggit-documented
 * (x, y, zoneRadius) but this project has no ME-saved example of it — so the result says
 * so rather than implying the whole flow is editor-verified. Nothing here has been flown.
 */
import { z } from 'zod';
import { appendTaskTable } from './actions.js';
import { findGroup } from './authoring.js';
import { asTable, luaArray, type LuaTable } from './lua.js';

export const troopTransportSchema = z.object({
  transport: z.string().min(1).describe('Helicopter (or vehicle) group that carries the troops.'),
  troops: z.string().min(1).describe('Ground group to be carried.'),
  pickupWaypoint: z.number().int().min(1).default(2).describe("Waypoint of the transport's route where it loads."),
  dropWaypoint: z.number().int().min(1).default(3).describe("Waypoint of the transport's route where it unloads."),
  troopsWaypoint: z.number().int().min(1).default(1).describe("Waypoint of the troops' route that waits for the lift."),
  zoneRadiusMetres: z.number().min(10).max(5000).default(200).describe('How far from the pickup/drop point the task is satisfied.'),
  durationSeconds: z.number().int().min(10).max(7200).default(300).describe('How long the transport waits for the troops to board.'),
}).strict();

const pointOf = (group: LuaTable, index: number): { x: number; y: number } => {
  const wp = asTable(asTable(asTable(group.route)?.points)?.[index]);
  if (!wp) throw new Error(`Waypoint ${index} does not exist on '${String(group.name)}'`);
  const x = Number(wp.x), y = Number(wp.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`Waypoint ${index} of '${String(group.name)}' has no position`);
  return { x, y };
};

export function makeTroopTransport(mission: LuaTable, input: z.input<typeof troopTransportSchema>) {
  const a = troopTransportSchema.parse(input);
  const transport = findGroup(mission, a.transport);
  if (!transport) throw new Error(`No group named '${a.transport}' in this mission`);
  const troops = findGroup(mission, a.troops);
  if (!troops) throw new Error(`No group named '${a.troops}' in this mission`);
  if (transport.category !== 'helicopter' && transport.category !== 'vehicle') {
    throw new Error(`'${a.transport}' is a ${transport.category} group; only a helicopter or vehicle group can carry troops.`);
  }
  if (troops.category !== 'vehicle') {
    throw new Error(`'${a.troops}' is a ${troops.category} group; troops must be a ground (vehicle) group.`);
  }
  if (transport.group === troops.group) throw new Error('A group cannot carry itself');
  if (a.pickupWaypoint === a.dropWaypoint) throw new Error('pickupWaypoint and dropWaypoint must differ');
  const troopGroupId = Number(troops.group.groupId);
  if (!Number.isFinite(troopGroupId)) throw new Error(`'${a.troops}' has no groupId; save and reopen the mission first`);

  const pickup = pointOf(transport.group, a.pickupWaypoint);
  const drop = pointOf(transport.group, a.dropWaypoint);

  // Distribution maps each carrying UNIT to the groups it takes. With one transport unit
  // the editor still writes the table, keyed by that unit's id.
  const units = luaArray(asTable(transport.group.units));
  if (!units.length) throw new Error(`'${a.transport}' has no units`);
  const distribution: LuaTable = {};
  for (const unit of units) {
    const unitId = Number(unit.unitId);
    if (Number.isFinite(unitId)) distribution[unitId] = { 1: troopGroupId };
  }
  if (!Object.keys(distribution).length) throw new Error(`'${a.transport}' has no unit ids; save and reopen the mission first`);

  const embarking = appendTaskTable(transport.group, a.pickupWaypoint, {
    id: 'Embarking',
    params: {
      distributionFlag: false,
      groupsForEmbarking: { 1: troopGroupId },
      durationFlag: false,
      distribution,
      x: pickup.x, y: pickup.y,
      onStartMission: false,
      duration: a.durationSeconds,
    },
  });
  const embarkToTransport = appendTaskTable(troops.group, a.troopsWaypoint, {
    id: 'EmbarkToTransport',
    params: { x: pickup.x, y: pickup.y, zoneRadius: a.zoneRadiusMetres },
  });
  const disembark = appendTaskTable(transport.group, a.dropWaypoint, {
    id: 'DisembarkFromTransport',
    params: { x: drop.x, y: drop.y, zoneRadius: a.zoneRadiusMetres },
  });

  return {
    transport: a.transport, troops: a.troops, troopGroupId,
    pickup: { waypoint: a.pickupWaypoint, ...pickup, taskIndex: embarking },
    drop: { waypoint: a.dropWaypoint, ...drop, taskIndex: disembark },
    troopsTask: { waypoint: a.troopsWaypoint, taskIndex: embarkToTransport },
    carriedBy: Object.keys(distribution).map(Number),
    durationSeconds: a.durationSeconds, zoneRadiusMetres: a.zoneRadiusMetres,
    notes: [
      'Embarking and EmbarkToTransport are written in the exact field layout Mission-Editor-saved missions use (including durationFlag and onStartMission, which the Hoggit docs do not list).',
      'DisembarkFromTransport is Hoggit-documented (x, y, zoneRadius); this project has no ME-saved example of it.',
      'The troops wait at their own waypoint, so put them (and the pickup point) somewhere the transport can actually land: check the surface with dcs_check_terrain or dcs_terrain_clear_spot.',
      'Not flown by this project: no sortie has verified that these three tasks lift this group.',
    ],
  };
}
