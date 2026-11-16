/** Read-only checks on raw data omitted by the compact canonical document. */
import { eachGroup, validatePayload, type PayloadArgs } from './authoring.js';
import { asTable, luaArray, type LuaTable, type LuaValue } from './lua.js';
import { findAirport, findUnitType, type FlyingType } from '../data/reference.js';
import type { ValidationIssue } from '../types.js';
import { authoringData } from '../data/authoring.js';
import { radioBand } from '../data/radio-bands.js';
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
      if (unitIds.has(unit.unitId)) issue('DUP_UNIT_ID', `Duplicate unit id ${unit.unitId}`, `unit:${unit.name}`);
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
    for (const unit of luaArray(group.units)) {
      const hit = findUnitType(String(unit.type)), location = `unit:${unit.name}`;
      if (hit && category !== 'static' && hit.category !== category) issue('UNIT_CATEGORY_MISMATCH', `${unit.type} is ${hit.category}, not ${category}`, location);
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
        try { validatePayload(unit, args); } catch (error) { issue('PAYLOAD_LIMIT', (error as Error).message, location); }
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
        if (parking.has(key)) issue('PARKING_CONFLICT', `${unit.name} and ${parking.get(key)} use parking ${key}`, location);
        parking.set(key, String(unit.name));
        try {
          const airport = findAirport(String(mission.theatre), Number(first.airdromeId));
          if (!airport.slots.some(s => s[1] === String(unit.parking_id))) issue('PARKING_SLOT_MISSING', `No parking '${unit.parking_id}' at ${airport.name}`, location);
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
            issue('TASK_WAYPOINT_MISSING', `${group.name} ${id} references missing waypoint ${destination}`, `group:${group.name}`);
        }
      }
      const reference = key && params?.[key];
      if (key && typeof reference === 'number' && reference > 0 && !(key === 'groupId' ? groupIds : unitIds).has(reference))
        issue('TASK_REFERENCE_MISSING', `${group.name} ${id} task references missing ${key} ${reference}`, `group:${group.name}`);
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
      if (typeof ref === 'number' && !known.has(ref)) issue('GOAL_REFERENCE_MISSING', `Goal '${goal.comment}' references missing ${field} ${ref}`, 'goals');
    }
  }
  return issues;
}
