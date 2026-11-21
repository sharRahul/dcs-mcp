/** Typed flight templates and waypoint tasking. Format evidence: pydcs 1.0.0 task.py.
 * All additions are offline-verified only. Role aliases are authoring conventions.
 */
import { z } from 'zod';
import { authoringData } from '../data/authoring.js';
import { countries, countryOffers, findCountryById, findUnitType, type FlyingType } from '../data/reference.js';
import { liveryStatus } from '../dcs/liveries.js';
import { resolveFamily } from './callsigns.js';
import { asTable, luaArray, type LuaTable } from './lua.js';
import { addAircraftGroup, addWaypoint, eachGroup, findGroup, findUnit, setPayload, type AddGroupArgs, type AirCategory } from './authoring.js';

export const ROLES = ['CAP', 'BARCAP', 'TARCAP', 'SEAD', 'DEAD', 'CAS', 'strike', 'escort', 'interception', 'reconnaissance', 'transport', 'AWACS', 'tanker'] as const;
export type Role = typeof ROLES[number];
export const ROLE_TASK: Record<Role, string> = { CAP: 'CAP', BARCAP: 'CAP', TARCAP: 'CAP', SEAD: 'SEAD', DEAD: 'SEAD', CAS: 'CAS',
  strike: 'CAS', escort: 'Escort', interception: 'Intercept', reconnaissance: 'Reconnaissance', transport: 'Transport', AWACS: 'AWACS', tanker: 'Refueling' };
const point = z.object({ x: z.number().finite(), y: z.number().finite() }).strict();
const orbitFields = { pattern: z.enum(['Circle', 'Race-Track']).default('Circle'),
  point: point, point2: point.optional(), altitudeMetres: z.number().positive().max(20000).default(6000),
  speedMps: z.number().positive().max(400).default(180), durationSeconds: z.number().positive().max(86400).optional() };
export const orbitSchema = z.object(orbitFields).strict();
export const taskSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('orbit'), ...orbitFields }).strict(),
  z.object({ kind: z.literal('engage'), targets: z.array(z.enum(['Air', 'Planes', 'Helicopters', 'Ground Units', 'Air Defence', 'Ships'])).min(1).max(6),
    maxDistanceMetres: z.number().positive().max(500000).default(80000), zone: z.object({ ...point.shape, radiusMetres: z.number().positive().max(500000) }).strict().optional() }).strict(),
  z.object({ kind: z.literal('attack_group'), group: z.string().min(1), weaponType: z.number().int().min(0).default(9663676414),
    expend: z.enum(['Auto', 'One', 'Two', 'Four', 'Quarter', 'Half', 'All']).default('Auto') }).strict(),
  z.object({ kind: z.literal('escort'), group: z.string().min(1), maxDistanceMetres: z.number().positive().max(500000).default(60000),
    offset: z.object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() }).strict().default({ x: -200, y: -100, z: -500 }) }).strict(),
  z.object({ kind: z.literal('awacs') }).strict(), z.object({ kind: z.literal('tanker') }).strict(),
  z.object({ kind: z.literal('option'), option: z.enum(['roe', 'reaction', 'radar', 'formation']), value: z.number().int().min(0) }).strict(),
  z.object({ kind: z.literal('tacan'), channel: z.number().int().min(1).max(126), band: z.enum(['X', 'Y']).default('Y'),
    callsign: z.string().regex(/^[A-Z0-9]{1,3}$/) }).strict(),
  z.object({ kind: z.literal('frequency'), frequencyMHz: z.number().positive().max(400), modulation: z.union([z.literal(0), z.literal(1)]).default(0) }).strict(),
]);
export type WaypointTask = z.input<typeof taskSchema>;
export const FORMATIONS = { trail: 131073, wedge: 196609, echelon_right: 262145, echelon_left: 327681, finger_four: 393217, spread_four: 458753 } as const;
export const flightConfigSchema = z.object({
  frequencyMHz: z.number().positive().max(400).optional(), modulation: z.union([z.literal(0), z.literal(1)]).optional(),
  callsign: z.union([z.number().int().positive().describe('Russian-style numeric callsign; unit i gets number + i'),
    z.object({ family: z.union([z.number().int().positive(), z.string().min(1)]).describe('Family number or name (dcs_list_callsigns)'),
      flight: z.number().int().min(1).max(9), name: z.string().min(1).optional().describe('Optional; must match the family') }).strict()]).optional(),
  tailNumbers: z.array(z.string().regex(/^\d{1,3}$/)).min(1).max(16).optional(), livery: z.string().min(1).max(200).optional(),
  skills: z.array(z.enum(['Average', 'Good', 'High', 'Excellent', 'Random', 'Player', 'Client'])).min(1).max(16).optional(),
  formation: z.enum(['trail', 'wedge', 'echelon_right', 'echelon_left', 'finger_four', 'spread_four']).optional(),
}).strict();
export function flyingReference(type: string, category?: string): FlyingType {
  const hit = findUnitType(type);
  if (!hit || !['plane', 'helicopter'].includes(hit.category) || (category && hit.category !== category))
    throw new Error(`Aircraft '${type}' has no matching ${category ?? 'flying'} reference data; use generic authoring for unlisted mods`);
  return hit.entry as FlyingType;
}
function requireFlight(mission: LuaTable, name: string) {
  const found = findGroup(mission, name);
  if (!found || !['plane', 'helicopter'].includes(found.category)) throw new Error(`No aircraft group '${name}'`);
  return found;
}
function validateTaskSupport(group: LuaTable, task: string) {
  for (const unit of luaArray(group.units)) {
    const ref = flyingReference(String(unit.type));
    if (!ref.tasks.includes(task)) throw new Error(`${unit.type} does not support '${task}' in the bundled reference`);
  }
}
function wrapped(id: string, params: LuaTable): LuaTable { return { id: 'WrappedAction', params: { action: { id, params } } }; }
function waypoint(group: LuaTable, index: number): LuaTable {
  if (!Number.isInteger(index) || index < 1) throw new Error('waypointIndex is 1-based');
  const wp = asTable(asTable(asTable(group.route)?.points)?.[index]);
  if (!wp) throw new Error(`Waypoint ${index} does not exist`);
  return wp;
}
export function appendWaypointTask(mission: LuaTable, name: string, index: number, input: WaypointTask): number {
  const spec = taskSchema.parse(input);
  const found = requireFlight(mission, name), group = found.group;
  const wp = waypoint(group, index);
  let task: LuaTable;
  switch (spec.kind) {
    case 'orbit': {
      if (spec.pattern === 'Race-Track' && (!spec.point2 || Math.hypot(spec.point2.x - spec.point.x, spec.point2.y - spec.point.y) < 1))
        throw new Error('Race-Track orbit needs a distinct point2');
      if (String(wp.type).startsWith('TakeOff')) throw new Error('Orbit must be placed on an airborne waypoint');
      task = { id: 'Orbit', params: { pattern: spec.pattern, point: spec.point, ...(spec.point2 ? { point2: spec.point2 } : {}),
        altitude: spec.altitudeMetres, speed: spec.speedMps, speedEdited: true } };
      if (spec.durationSeconds) task = { id: 'ControlledTask', params: { task: { ...task, auto: false, enabled: true, number: 1 }, stopCondition: { duration: spec.durationSeconds } } };
      break;
    }
    case 'engage': {
      const primary = String(group.task);
      if (!['CAP', 'CAS', 'SEAD', 'Fighter Sweep', 'Antiship Strike', 'Intercept'].includes(primary)) throw new Error(`Engage task unsupported for '${primary}'`);
      const targetTypes = Object.fromEntries(spec.targets.map((t, i) => [i + 1, t]));
      task = spec.zone ? { id: 'EngageTargetsInZone', params: { targetTypes, value: spec.targets.join(';'), priority: 0,
        x: spec.zone.x, y: spec.zone.y, zoneRadius: spec.zone.radiusMetres } } :
        { id: 'EngageTargets', params: { targetTypes, value: spec.targets.join(';'), priority: 0, maxDistEnabled: true, maxDist: spec.maxDistanceMetres } };
      break;
    }
    case 'attack_group': {
      const target = findGroup(mission, spec.group);
      if (!target || target.side === found.side || spec.group === name) throw new Error('Attack target must be an existing opposing group');
      if (!['CAS', 'SEAD', 'Intercept', 'Antiship Strike'].includes(String(group.task))) throw new Error(`AttackGroup unsupported for '${group.task}'; use an appropriate main task`);
      task = { id: 'AttackGroup', params: { groupId: target.group.groupId!, weaponType: spec.weaponType, expend: spec.expend,
        groupAttack: false, attackQtyLimit: false, attackQty: 1, altitudeEnabled: false, altitude: 0, directionEnabled: false, direction: 0 } };
      break;
    }
    case 'escort': {
      if (group.task !== 'Escort' && group.task !== 'SEAD') throw new Error('Escort task requires Escort or SEAD main task');
      validateTaskSupport(group, 'Escort');
      const target = requireFlight(mission, spec.group);
      if (spec.group === name || target.side !== found.side) throw new Error('Escort target must be another friendly aircraft group');
      task = { id: 'Escort', params: { groupId: target.group.groupId!, engagementDistMax: spec.maxDistanceMetres, targetTypes: { 1: 'Planes' },
        pos: spec.offset, lastWptIndexFlag: false, lastWptIndexFlagChangedManually: false } }; break;
    }
    case 'awacs': if (group.task !== 'AWACS') throw new Error('AWACS task requires AWACS main task'); validateTaskSupport(group, 'AWACS'); task = { id: 'AWACS', params: {} }; break;
    case 'tanker': if (group.task !== 'Refueling') throw new Error('Tanker task requires Refueling main task'); validateTaskSupport(group, 'Refueling'); task = { id: 'Tanker', params: {} }; break;
    case 'option': {
      const keys = { roe: 0, reaction: 1, radar: 3, formation: 5 };
      if (spec.option === 'formation') {
        if (found.category !== 'plane' || !(Object.values(FORMATIONS) as number[]).includes(spec.value)) throw new Error('Unsupported fixed-wing formation value');
      // Reaction 5 is the editor's Horizontal AAA Fire Evade (also in our catalogue).
      // ED documents this option and its fix in DCS 2.9.9.2280; it is not an ROE value.
      } else if (spec.value > (spec.option === 'radar' ? 3 : spec.option === 'reaction' ? 5 : 4)) throw new Error(`Invalid ${spec.option} value`);
      task = wrapped('Option', { name: keys[spec.option], value: spec.value,
        ...(spec.option === 'formation' ? { formationIndex: Math.floor(spec.value / 65536), variantIndex: 1 } : {}) }); break;
    }
    case 'frequency': task = wrapped('SetFrequency', { frequency: Math.round(spec.frequencyMHz * 1000000), modulation: spec.modulation, power: 10 }); break;
    case 'tacan': {
      validateTaskSupport(group, 'Refueling');
      const frequency = (spec.channel < 64 ? 1088 + spec.channel - 1 : 1025 + spec.channel - 64) * 1000000;
      task = wrapped('ActivateBeacon', { type: 4, frequency, callsign: spec.callsign, channel: spec.channel,
        unitId: luaArray(group.units)[0].unitId!, modeChannel: spec.band, bearing: true, system: spec.band === 'Y' ? 5 : 4 }); break;
    }
  }
  const combo = asTable(wp.task);
  if (combo && combo.id !== 'ComboTask') throw new Error('Existing non-ComboTask waypoint task cannot be safely appended');
  const tasks = asTable(asTable(combo?.params)?.tasks) ?? {};
  const next = Math.max(0, ...Object.keys(tasks).map(Number).filter(Number.isFinite)) + 1;
  task = { ...task, enabled: true, auto: false, number: next };
  tasks[next] = task;
  if (!combo) wp.task = { id: 'ComboTask', params: { tasks } };
  else { const params = (combo.params ??= {}) as LuaTable; params.tasks = tasks; }
  return next;
}
/** Validates first and commits only when all configuration succeeds. */
export function configureFlight(mission: LuaTable, name: string, input: z.input<typeof flightConfigSchema>): string[] {
  const config = flightConfigSchema.parse(input);
  const found = requireFlight(mission, name), group = structuredClone(found.group), units = luaArray(group.units);
  const warnings: string[] = [];
  if (config.skills && config.skills.length !== units.length) throw new Error('skills must have one entry per aircraft');
  if (config.tailNumbers && config.tailNumbers.length !== units.length) throw new Error('tailNumbers must have one entry per aircraft');
  let existingPlayers = 0;
  eachGroup(mission, g => { if (g !== found.group) existingPlayers += luaArray(g.units).filter(u => u.skill === 'Player').length; });
  if (existingPlayers + units.filter((u, i) => (config.skills?.[i] ?? u.skill) === 'Player').length > 1) throw new Error('Mission can have only one Player aircraft; use Client for multiplayer');
  if (config.frequencyMHz !== undefined) group.frequency = config.frequencyMHz;
  if (config.modulation !== undefined) group.modulation = config.modulation;
  if (config.frequencyMHz !== undefined || config.modulation !== undefined) group.communication = true;
  let callsign: number | { family: number; flight: number; name: string } | undefined;
  if (typeof config.callsign === 'number') callsign = config.callsign;
  else if (config.callsign) {
    const resolved = resolveFamily(String(units[0]?.type), String(group.task ?? ''), config.callsign.family);
    if (config.callsign.name && config.callsign.name.replace(/\s+/g, '').toLowerCase() !== resolved.name.toLowerCase())
      throw new Error(`Callsign name '${config.callsign.name}' does not match family ${resolved.family} (${resolved.name})`);
    callsign = { ...resolved, flight: config.callsign.flight };
  }
  units.forEach((u, i) => {
    if (config.skills) u.skill = config.skills[i];
    if (config.tailNumbers) u.onboard_num = config.tailNumbers[i];
    if (config.livery) u.livery_id = config.livery;
    if (callsign !== undefined) u.callsign = typeof callsign === 'number' ? callsign + i :
      { 1: callsign.family, 2: callsign.flight, 3: i + 1, name: `${callsign.name}${callsign.flight}${i + 1}` };
  });
  if (config.formation) {
    if (found.category !== 'plane') throw new Error('These formation presets are fixed-wing only');
    // Use temporary mission to apply the same validated task builder atomically.
    const copy = structuredClone(mission); Object.assign(requireFlight(copy, name).group, group);
    appendWaypointTask(copy, name, 1, { kind: 'option', option: 'formation', value: FORMATIONS[config.formation] });
    Object.assign(group, requireFlight(copy, name).group);
  }
  if (config.livery) {
    const country = findCountryById(Number(found.country.id))?.name;
    const check = liveryStatus(String(units[0]?.type), config.livery, country);
    warnings.push(check.status === 'installed'
      ? (check.reason ? `livery_country_restricted: ${check.reason}` : 'Livery found in an installed Liveries folder')
      : check.status === 'not_installed' ? `livery_not_installed: ${check.reason}; the id was stored anyway`
      : `Livery id stored; installation unknown (${check.reason})`);
  }
  if (config.frequencyMHz !== undefined) warnings.push('Frequency stored in MHz; aircraft-specific radio bands are not in the bundled data');
  if (callsign !== undefined && typeof callsign !== 'number') warnings.push(`Callsign ${callsign.name} ${callsign.flight}-1 (family ${callsign.family}) checked against the Hoggit wiki callsign lists; not ME-verified`);
  Object.assign(found.group, group);
  return warnings;
}
export interface CreateFlightArgs extends AddGroupArgs {
  role: Role; category: AirCategory; orbit?: z.input<typeof orbitSchema>; targetGroup?: string;
  engagementDistanceMetres?: number; config?: z.input<typeof flightConfigSchema>;
}
export function createFlight(mission: LuaTable, args: CreateFlightArgs) {
  const copy = structuredClone(mission);
  if (!ROLES.includes(args.role)) throw new Error('Unknown flight role');
  if (findGroup(copy, args.name)) throw new Error(`Group '${args.name}' already exists`);
  const reference = flyingReference(args.type, args.category);
  if (!reference.tasks.includes(ROLE_TASK[args.role])) throw new Error(`${args.type} does not support role '${args.role}' (${ROLE_TASK[args.role]})`);
  // Some catalogue aircraft (notably F-16C_50) are absent from every country
  // in this pydcs snapshot. Absence everywhere is missing data, not incompatibility.
  const hasCountryCoverage = countries().some(c => c.units[args.category].includes(args.type));
  if (hasCountryCoverage && countryOffers(args.country, args.type) === false) throw new Error(`${args.country} is not offered '${args.type}' by the bundled DCS catalogue`);
  if (!Number.isInteger(args.count) || args.count < 1 || args.count > 4) throw new Error('Role templates support 1..4 aircraft');
  if (args.composition) throw new Error('Role flights require one aircraft type');
  if (['escort', 'interception', 'strike'].includes(args.role) && !args.targetGroup) throw new Error(`${args.role} requires targetGroup`);
  if (args.targetGroup && !['escort', 'interception', 'strike', 'CAS', 'SEAD', 'DEAD'].includes(args.role)) throw new Error('targetGroup does not apply to this role');
  if (['BARCAP', 'TARCAP', 'AWACS', 'tanker'].includes(args.role) && !args.orbit) throw new Error(`${args.role} requires orbit geometry`);
  // A strike against a group needs the CAS task, whose AttackGroup action is documented.
  const mainTask = args.role === 'strike' ? 'CAS' : ROLE_TASK[args.role];
  if (!reference.tasks.includes(mainTask)) throw new Error(`${args.type} does not support group strike task '${mainTask}'`);
  const group = addAircraftGroup(copy, args.category, { ...args, task: mainTask });
  let station = 1;
  if (args.orbit) {
    const orbit = orbitSchema.parse(args.orbit);
    station = addWaypoint(copy, args.name, { ...orbit.point, altitudeMetres: orbit.altitudeMetres, speedMps: orbit.speedMps, name: `${args.role} station` });
  }
  if (args.role === 'AWACS' || args.role === 'tanker') appendWaypointTask(copy, args.name, station, { kind: args.role === 'AWACS' ? 'awacs' : 'tanker' });
  if (['CAP', 'BARCAP', 'TARCAP', 'SEAD', 'DEAD', 'CAS'].includes(args.role)) appendWaypointTask(copy, args.name, station, {
    kind: 'engage', targets: [mainTask === 'CAP' ? 'Air' : mainTask === 'SEAD' ? 'Air Defence' : 'Ground Units'], maxDistanceMetres: args.engagementDistanceMetres ?? 80000,
  });
  if (args.targetGroup) appendWaypointTask(copy, args.name, station, args.role === 'escort' ?
    { kind: 'escort', group: args.targetGroup, maxDistanceMetres: args.engagementDistanceMetres ?? 60000 } : { kind: 'attack_group', group: args.targetGroup });
  if (args.orbit) appendWaypointTask(copy, args.name, station, { kind: 'orbit', ...args.orbit });
  // A targeted flight with nothing but its start point never goes to the target: flown
  // live (2026-11-20), a SEAD flight against a dark SA-11 found nothing, ran out of
  // route and landed. Give it a leg to the target's position.
  let attackWaypoint: number | undefined;
  if (args.targetGroup && args.role !== 'escort' && !args.orbit) {
    const target = findGroup(copy, args.targetGroup)!.group;
    attackWaypoint = addWaypoint(copy, args.name, { x: Number(target.x), y: Number(target.y),
      altitudeMetres: args.altitudeMetres ?? (args.category === 'helicopter' ? 60 : 6096), name: 'Target area' });
    // Helicopters fly the attack leg above GROUND ("RADIO", as editor-saved missions write
    // it): 60 m above sea level is underground near Gali (terrain ~67 m).
    if (args.category === 'helicopter') {
      const points = asTable(asTable(findGroup(copy, args.name)!.group.route)?.points)!;
      asTable(points[attackWaypoint])!.alt_type = 'RADIO';
    }
  }
  const warnings = configureFlight(copy, args.name, args.config ?? {});
  if (!hasCountryCoverage) warnings.push(`Country compatibility unavailable: ${args.type} is absent from every country in the bundled snapshot`);
  if (args.role === 'DEAD') warnings.push('DEAD uses SEAD tasking; destruction depends on target, loadout and DCS AI. Weapons are not automatically selected.');
  if (args.role === 'transport') warnings.push('Transport role sets the main task only; cargo and loading/unloading are not configured.');
  // Each of these was learned the hard way in a flown mission (2026-11-20/21).
  if (!['AWACS', 'tanker', 'transport', 'reconnaissance'].includes(args.role)) {
    warnings.push('No weapons are loaded: pick a stock preset with dcs_list_loadouts and apply it with dcs_miz_apply_loadout (or set pylons with dcs_miz_set_payload). An unarmed flight flies its tasks and cannot fire.');
  }
  if (attackWaypoint) {
    warnings.push(`After the target leg (waypoint ${attackWaypoint}) the AI lands at the NEAREST airfield, which may be enemy-held: add dcs_miz_add_airfield_landing to send it home.`);
  }
  const start = asTable(args.start as LuaTable | undefined);
  if (args.category === 'helicopter' && (!start || start.kind === 'air') && (args.altitudeMetres ?? 6096) < 300) {
    warnings.push(`A helicopter air start of ${args.altitudeMetres} m is above SEA level, not ground: on high terrain it spawns underground and crashes at once. Use 300 m or more, or a ground/FARP start.`);
  }
  Object.assign(mission, copy);
  return { group: String(group.name), role: args.role, mainTask, stationWaypoint: station, ...(attackWaypoint ? { attackWaypoint } : {}), warnings, verification: 'offline only; not flown in DCS' };
}
