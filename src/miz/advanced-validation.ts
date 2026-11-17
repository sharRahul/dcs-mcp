/** Read-only checks on raw data omitted by the compact canonical document. */
import { eachGroup, payloadOverCatalogue, validatePayload, type PayloadArgs } from './authoring.js';
import { asTable, luaArray, type LuaTable, type LuaValue } from './lua.js';
import { findAirport, findUnitType, type FlyingType } from '../data/reference.js';
import type { ValidationIssue } from '../types.js';
import { authoringData } from '../data/authoring.js';
import { radioBand } from '../data/radio-bands.js';
/**
 * Catalogued STATIC types the Mission Editor saves inside a ground (vehicle) group.
 * Evidence: a train in an ME-saved mission is `country.vehicle.group` whose units are
 * type 'Train' (with a `wagons` table), while pydcs lists 'Train' as a static.
 */
const EDITOR_VEHICLE_STATICS = new Set(['Train']);

export function validateAuthoring(mission: LuaTable): ValidationIssue[] {
  const issues: ValidationIssue[] = [], parking = new Map<string, string>();
  const groupIds = new Set<number>(), unitIds = new Set<number>();
  const issue = (code: string, message: string, location: string, severity: 'error' | 'warning' = 'error') => issues.push({ code, message, location, severity });
  eachGroup(mission, group => {
    if (typeof group.groupId === 'number') {
      if (groupIds.has(group.groupId)) issue('DUP_GROUP_ID', `Duplicate group id ${group.groupId}`, `group:${group.name}`);
      groupIds.add(group.groupId);
    }
    for (const unit of luaArray(group.units)) if (typeof unit.unitId === 'number') {
      // ED's own shipped missions contain duplicate unit ids (120 of them across
      // the installed campaign and instant-action missions) and DCS flies them,
      // so this cannot be an error by this validator's own definition.
      if (unitIds.has(unit.unitId)) issue('DUP_UNIT_ID', `Duplicate unit id ${unit.unitId}. Missions DCS ships do this and still fly; ` +
        'triggers and tasks that reference the id resolve to whichever unit DCS finds first.', `unit:${unit.name}`, 'warning');
      unitIds.add(unit.unitId);
    }
  });
  eachGroup(mission, (group, category) => {
    if (category === 'plane' || category === 'helicopter') {
      const where = `group:${group.name}`;
      if (group.frequency !== undefined && !(typeof group.frequency === 'number' && Number.isFinite(group.frequency) && group.frequency > 0))
        issue('RADIO_FREQUENCY_INVALID', `Group frequency '${group.frequency}' is not a positive MHz value`, where);
      if (group.modulation !== undefined && group.modulation !== 0 && group.modulation !== 1)
        issue('RADIO_MODULATION_INVALID', `Group modulation '${group.modulation}' is not 0 (AM) or 1 (FM)`, where);
    }
    // Every ME-saved non-static group carries start_time (2,332 of 2,332 sampled;
    // statics never do). Without it the ME auto-briefing fails on Fly.
    if (category !== 'static' && typeof group.start_time !== 'number')
      issue('GROUP_NO_START_TIME', `Group '${group.name}' has no start_time; the Mission Editor's auto-briefing fails on it (set 0 for mission start)`, `group:${group.name}`, 'warning');
    for (const unit of luaArray(group.units)) {
      const hit = findUnitType(String(unit.type)), location = `unit:${unit.name}`;
      // The editor places some catalogued STATIC types in a ground group: a train is
      // `country.vehicle.group` with units of type 'Train' (captured from an ME-saved
      // mission). Those are not category mistakes, so they are not reported as such.
      if (hit && category !== 'static' && hit.category !== category && !(category === 'vehicle' && EDITOR_VEHICLE_STATICS.has(String(unit.type))))
        issue('UNIT_CATEGORY_MISMATCH', `${unit.type} is ${hit.category}, not ${category}`, location);
      if (!['plane', 'helicopter'].includes(category)) continue;
      const reference = hit?.entry as FlyingType | undefined;
      if (reference?.tasks?.length && group.task && !reference.tasks.includes(String(group.task)))
        issue('AIRCRAFT_TASK_UNSUPPORTED', `${unit.type} does not list '${group.task}' in the bundled tasks`, location, 'warning');
      const payload = asTable(unit.payload);
      if (payload) {
        const args: PayloadArgs = {};
        for (const key of ['fuel', 'chaff', 'flare', 'gun'] as const) if (payload[key] !== undefined) args[key] = Number(payload[key]);
        // DCS stores internal fuel as a numeric string; anything else is unreadable to the editor.
        if (payload.fuel !== undefined && (typeof payload.fuel === 'boolean' || !Number.isFinite(Number(payload.fuel)) || String(payload.fuel).trim() === '')) {
          issue('FUEL_NOT_NUMERIC', `Internal fuel '${payload.fuel}' is not a number`, location);
          delete args.fuel;
        }
        try { validatePayload(unit, args, { enforceCatalogueFuel: false }); } catch (error) { issue('PAYLOAD_INVALID', (error as Error).message, location); }
        // Over the CATALOGUE's limit is not the same as over the aircraft's limit: the
        // counts come from pydcs, and ME-saved missions exceed them (an F/A-18C with 90
        // flares where pydcs says 60, a Chinook whose rounded fuel is 0.4 kg over
        // fuel_max). Reported, never treated as a broken mission.
        for (const over of payloadOverCatalogue(unit, args))
          issue('PAYLOAD_LIMIT', `${over.key} is ${over.value}, above the bundled (pydcs) limit of ${over.limit} for ${unit.type}. ` +
            'The installed DCS may allow more; this is catalogue staleness, not a mission fault.', location, 'warning');
        const stores = Object.entries(asTable(payload.pylons) ?? {}).map(([key, value]) => ({ pylon: Number(key), CLSID: String(asTable(value)?.CLSID ?? '') }));
        try { validatePayload(unit, { pylons: stores }); } catch (error) { issue('PAYLOAD_NOT_CATALOGUED', (error as Error).message, location, 'warning'); }
      }
      // Radio presets: structure against pydcs panel_radio, values, and documented bands.
      const radio = asTable(unit.Radio);
      if (radio) {
        const panel = authoringData().aircraft[String(unit.type)]?.panelRadio;
        for (const [r, cfg] of Object.entries(radio)) {
          const channels = asTable(asTable(cfg)?.channels) ?? {};
          if (panel && !panel[r]) issue('RADIO_UNKNOWN', `${unit.type} has no preset radio ${r}`, location, 'warning');
          for (const [c, f] of Object.entries(channels)) {
            const mhz = Number(f);
            if (!Number.isFinite(mhz) || mhz <= 0) { issue('RADIO_FREQUENCY_INVALID', `Radio ${r} channel ${c}: '${f}' is not a positive MHz value`, location); continue; }
            if (panel?.[r] && !(c in panel[r].channels)) issue('RADIO_UNKNOWN_CHANNEL', `${unit.type} radio ${r} has no channel ${c}`, location, 'warning');
            const band = radioBand(String(unit.type), r);
            if (band && (mhz < band.minMHz || mhz > band.maxMHz)) issue('RADIO_OUT_OF_BAND', `Radio ${r} channel ${c}: ${mhz} MHz outside ${band.band} ${band.minMHz}-${band.maxMHz} MHz`, location);
          }
        }
      }
      const first = asTable(asTable(asTable(group.route)?.points)?.[1]);
      if (unit.parking_id !== undefined && first?.airdromeId !== undefined) {
        const key = `${first.airdromeId}:${unit.parking_id}`;
        if (parking.has(key)) issue('PARKING_CONFLICT', `${unit.name} and ${parking.get(key)} use parking ${key}. ` +
          'DCS loads it (ME-saved missions do this), but the second aircraft may fail to spawn.', location, 'warning');
        parking.set(key, String(unit.name));
        try {
          const airport = findAirport(String(mission.theatre), Number(first.airdromeId));
          if (!airport.slots.some(s => s[1] === String(unit.parking_id)))
            issue('PARKING_SLOT_MISSING', `No parking '${unit.parking_id}' at ${airport.name} in the bundled (pydcs) slot list. ` +
              'ED has reworked airfields since that export, so the slot may well exist in your DCS; sample the airfield with ' +
              'dcs_airbase_build_pack to check against the running game.', location, 'warning');
        } catch (error) { issue('AIRFIELD_REFERENCE_UNKNOWN', (error as Error).message, location, 'warning'); }
      }
    }
    // Only known task reference fields are ids. For example EPLRS.groupId is
    // a network number, not a mission group id; unknown tasks must remain opaque.
    function visit(value: LuaValue | undefined, depth = 0) {
      if (depth > 30) return;
      const table = asTable(value); if (!table) return;
      const id = String(table.id ?? '');
      const params = asTable(table.params);
      const key = ['AttackGroup', 'EngageGroup', 'Escort', 'Follow', 'RecoveryTanker'].includes(id) ? 'groupId' :
        ['AttackUnit', 'EngageUnit', 'ActivateBeacon'].includes(id) ? 'unitId' : undefined;
      if (id === 'GoToWaypoint' || id === 'SwitchWaypoint') {
        const points = asTable(asTable(group.route)?.points);
        for (const field of ['fromWaypointIndex', id === 'GoToWaypoint' ? 'nWaypointIndx' : 'goToWaypointIndex']) {
          const destination = params?.[field];
          if (typeof destination === 'number' && !asTable(points?.[destination]))
            // Also present in missions DCS ships (195 occurrences), typically
            // after waypoints were deleted from a route whose task still names
            // them. The mission loads and flies; the jump does nothing.
            issue('TASK_WAYPOINT_MISSING', `${group.name} ${id} references missing waypoint ${destination}. ` +
              'Missions DCS ships do this too (the waypoint was probably deleted after the task was written); ' +
              'the mission loads and the jump has no effect.', `group:${group.name}`, 'warning');
        }
      }
      const reference = key && params?.[key];
      if (key && typeof reference === 'number' && reference > 0 && !(key === 'groupId' ? groupIds : unitIds).has(reference))
        issue('TASK_REFERENCE_MISSING', `${group.name} ${id} task references missing ${key} ${reference} ` +
          '(the target was probably deleted after the task was written). DCS loads the mission; the task does nothing.',
          `group:${group.name}`, 'warning');
      for (const child of Object.values(table)) if (asTable(child)) visit(child, depth + 1);
    }
    for (const wp of luaArray(asTable(group.route)?.points)) {
      if (typeof wp.linkUnit === 'number' && !unitIds.has(wp.linkUnit)) issue('WAYPOINT_LINK_MISSING', `${group.name} waypoint links missing unit ${wp.linkUnit}`, `group:${group.name}`);
      visit(wp.task);
    }
  });
  const zoneIds = new Set(luaArray(asTable(mission.triggers)?.zones).map(z => z.zoneId));
  for (const goal of luaArray(mission.goals)) for (const rule of luaArray(goal.rules)) {
    if (!['c_group_dead', 'c_group_life_less', 'c_part_of_group_in_zone', 'c_unit_dead', 'c_unit_in_zone', 'c_unit_out_zone', 'c_part_of_coalition_in_zone'].includes(String(rule.predicate))) continue;
    for (const [field, known] of [['group', groupIds], ['unit', unitIds], ['zone', zoneIds]] as const) {
      const ref = rule[field];
      if (typeof ref === 'number' && !known.has(ref))
        issue('GOAL_REFERENCE_MISSING', `Goal '${goal.comment}' references missing ${field} ${ref}; that goal can never be met. ` +
          'DCS still loads the mission.', 'goals', 'warning');
    }
  }
  return issues;
}
