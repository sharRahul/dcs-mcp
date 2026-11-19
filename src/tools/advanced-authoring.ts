import { addCarrierRecovery, carrierCompatibility, aircraftCoverage, coverageAudit, historicalReport, serviceDateCheck } from '../miz/coverage.js';
import { aircraftCoverageProfileSchema } from '../data/coverage-profile.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { requireSession, refresh } from '../miz/sessions.js';
import { appendWaypointTask, configureFlight, createFlight, flightConfigSchema, orbitSchema, ROLES, ROLE_TASK, taskSchema } from '../miz/flight.js';
import { addThreatRing, appendSurfaceTask, createGroundPlan, groundPlanSchema, ringSchema, surfaceTaskSchema } from '../miz/operations.js';
import { configureIads, iadsSchema } from '../miz/iads.js';
import { claimStartAirfields, editWarehouse, listWarehouses, readWarehouses, warehousePatchSchema } from '../miz/logistics.js';
import { authoringData } from '../data/authoring.js';
import { findUnitType } from '../data/reference.js';
import { buildResult, errorResult } from './format.js';
import { positionFields, resolvePosition } from './position.js';
import { addWaypoint, findGroup } from '../miz/authoring.js';
import { asTable } from '../miz/lua.js';
import { findAirport } from '../data/reference.js';
const sessionId = z.string().min(1);
const side = z.enum(['red', 'blue', 'neutrals']);
const baseGroup = { sessionId, side, country: z.string().min(1), name: z.string().min(1).max(64), ...positionFields,
  heading: z.number().min(0).max(359).default(0) };
const start = z.discriminatedUnion('kind', [z.object({ kind: z.literal('air') }).strict(),
  z.object({ kind: z.literal('runway'), airfield: z.union([z.string().min(1), z.number().int().positive()]) }).strict(),
  z.object({ kind: z.enum(['parking_hot', 'parking_cold']), airfield: z.union([z.string().min(1), z.number().int().positive()]), parking: z.array(z.string().min(1)).min(1).max(4).optional() }).strict(),
  z.object({ kind: z.enum(['ship_hot', 'ship_cold']), ship: z.string().min(1) }).strict(),
  z.object({ kind: z.enum(['farp_hot', 'farp_cold']), farp: z.string().min(1) }).strict(),
]);
const mutation = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
function result(data: Record<string, unknown>) { return buildResult(JSON.stringify(data), data); }
export function registerAdvancedAuthoringTools(server: McpServer) {
  server.registerTool('dcs_miz_configure_iads', {
    description: 'Embed MIST and Skynet in order, then configure one IADS from same-coalition SAM group and EWR unit prefixes. Exposes go-live range percentage, HARM detection chance and radio menu. Prefix membership is checked; runtime battery effectiveness is unverified. File lookup failures do not mutate the session. Repeated names refused. Offline only.',
    inputSchema: z.object({ sessionId, config: iadsSchema }).strict(), annotations: mutation,
  }, async a => {
    try { const s = requireSession(a.sessionId); const data = await configureIads(s, a.config); s.dirty = true; refresh(s); return result(data); }
    catch (e) { return errorResult(e); }
  });
  server.registerTool('dcs_list_flight_roles', {
    description: 'Role aliases, required parameters and offline verification status. Query a type for actual supported tasks and pylon CLSIDs. Not an installed DCS catalogue.',
    inputSchema: z.object({ type: z.string().min(1).optional() }).strict(), annotations: { readOnlyHint: true },
  }, async ({ type }) => {
    try { return result({ roles: ROLES.map(role => ({ role, task: role === 'strike' ? 'CAS' : ROLE_TASK[role],
      orbitRequired: ['BARCAP', 'TARCAP', 'AWACS', 'tanker'].includes(role), targetRequired: ['strike', 'escort', 'interception'].includes(role) })),
      ...(type ? { aircraft: findUnitType(type)?.entry ?? null, payload: authoringData().aircraft[type] ?? null } : {}),
      limitations: ['No radio-band or historical service-date database; callsign families come from the Hoggit wiki enums (dcs_list_callsigns)', 'Role aliases are conventions; no new DCS task identifiers', 'Offline only; DCS runtime behavior unverified'] });
    } catch (e) { return errorResult(e); }
  });
  server.registerTool('dcs_miz_create_flight', {
    description: 'Create a validated configurable role flight with actual waypoint tasks. BARCAP/TARCAP are CAP conventions; DEAD uses SEAD, group strike uses CAS. AWACS/tanker require orbit geometry. Escort/interception/strike require an existing targetGroup. Ground starts append a station waypoint when orbit is given. Weapons are selected separately. Unknown reference aircraft use the generic tool. Atomic on error; offline only.',
    inputSchema: z.object({ ...baseGroup, type: z.string().min(1), category: z.enum(['plane', 'helicopter']).default('plane'),
      count: z.number().int().min(1).max(4).default(2), role: z.enum(ROLES), altitudeMetres: z.number().positive().max(20000).default(6096),
      skill: z.enum(['Average', 'Good', 'High', 'Excellent', 'Random', 'Client', 'Player']).default('High'),
      start: start.optional(), orbit: orbitSchema.optional(), targetGroup: z.string().min(1).optional(),
      engagementDistanceMetres: z.number().positive().max(500000).optional(), config: flightConfigSchema.optional(),
    }).strict(), annotations: mutation,
  }, async a => {
    try {
      const s = requireSession(a.sessionId), pos = a.start && a.start.kind !== 'air' ? { x: 0, y: 0 } : resolvePosition(s, a);
      const data = createFlight(s.mission, { ...a, ...pos }); data.warnings.push(...claimStartAirfields(s)); s.dirty = true; refresh(s); return result(data);
    } catch (e) { return errorResult(e); }
  });
  server.registerTool('dcs_miz_configure_flight', {
    description: 'Set per-unit skills, tail numbers, livery, callsign, flight MHz/modulation and fixed-wing formation. Preserves other fields. Callsign family (number or name) is checked against the Hoggit wiki lists for the type and main task (dcs_list_callsigns); liveries against installed folders. Radio bands are not verified. Only one Player unit per mission. Atomic on error.',
    inputSchema: z.object({ sessionId, group: z.string().min(1), config: flightConfigSchema }).strict(), annotations: mutation,
  }, async a => {
    try { const s = requireSession(a.sessionId); const warnings = configureFlight(s.mission, a.group, a.config); s.dirty = true; refresh(s); return result({ group: a.group, warnings }); }
    catch (e) { return errorResult(e); }
  });
  server.registerTool('dcs_miz_add_waypoint_task', {
    description: 'Append a typed advanced task to a 1-based aircraft waypoint: orbit, engage, attack_group, escort, AWACS, tanker, option, frequency, tanker TACAN. Options are fixed-wing formation/air ROE/reaction/radar. Preserves existing ComboTask entries and resolves target ids; refuses unsafe task replacement. Orbit needs an airborne point; heights MSL, speed m/s. Offline only.',
    inputSchema: z.object({ sessionId, group: z.string().min(1), waypointIndex: z.number().int().positive(), task: taskSchema }).strict(), annotations: mutation,
  }, async a => {
    try { const s = requireSession(a.sessionId); const taskIndex = appendWaypointTask(s.mission, a.group, a.waypointIndex, a.task); s.dirty = true; refresh(s); return result({ group: a.group, waypointIndex: a.waypointIndex, taskIndex }); }
    catch (e) { return errorResult(e); }
  });
  server.registerTool('dcs_carrier_compatibility', {
    description: 'Evidence-backed DCS aircraft/deck pairings and nominal parking capacity. Unlisted pairs are unknown; no slot geometry or recovery success inferred.',
    inputSchema:z.object({aircraft:z.string().min(1),ship:z.string().min(1)}).strict(),annotations:{readOnlyHint:true},
  },async a=>{try{return result(carrierCompatibility(a.aircraft,a.ship));}catch(e){return errorResult(e);}});
  server.registerTool('dcs_aircraft_coverage', {
    description:'Combine known aircraft fuel, dimensions, tasks, pylons, radios, installed loadouts and sourced historical bounds. Optional exact-type profile with source URL/scope fills missing numeric fields in this report only; caller evidence is not independently verified. No authoring defaults or source files change.',
    inputSchema:z.object({type:z.string().min(1),profile:aircraftCoverageProfileSchema.optional()}).strict(),annotations:{readOnlyHint:true},
  },async a=>{try{return result(aircraftCoverage(a.type,a.profile));}catch(e){return errorResult(e);}});
  server.registerTool('dcs_authoring_coverage_audit', {
    description:'Audit bundled aircraft evidence presence for fuel, complete dimensions, tasks, pylons, radio presets, country-scoped service-date records and deck geometry. Optional exact type IDs includes unknown/mod types. Presence is not completeness or runtime validation; no installed payload scan.',
    inputSchema:z.object({types:z.array(z.string().min(1)).min(1).max(1000).optional()}).strict(),annotations:{readOnlyHint:true},
  },async a=>{try{return result(coverageAudit(a.types));}catch(e){return errorResult(e);}});
  server.registerTool('dcs_service_date_check', {
    description:'Check a type against sourced earliest operational year, optionally for a country. Small explicit dataset; unknown types/countries/retirement/configuration dates are not validated.',
    inputSchema:z.object({type:z.string().min(1),year:z.number().int().min(1900).max(2200),country:z.string().min(1).optional()}).strict(),annotations:{readOnlyHint:true},
  },async a=>{try{return result(serviceDateCheck(a.type,a.year,a.country));}catch(e){return errorResult(e);}});
  server.registerTool('dcs_miz_historical_report', {
    description:'Report aircraft and surface units against sourced service dates for mission year/country; unknown records remain unknown. Does not change the mission.',
    inputSchema:z.object({sessionId}).strict(),annotations:{readOnlyHint:true},
  },async a=>{try{return result(historicalReport(requireSession(a.sessionId).mission));}catch(e){return errorResult(e);}});
  server.registerTool('dcs_miz_add_carrier_recovery', {
    description:'Append a native Land/Landing waypoint linked by linkUnit and helipadId to an existing friendly ship. Preserves earlier route/tasks and rejects a route already containing landing. Unknown pairings need explicit allowUnknown; DCS resolves moving-deck approach. No guarantee of deck clearance, arrestment or AI success.',
    inputSchema:z.object({sessionId,group:z.string().min(1),ship:z.string().min(1),allowUnknown:z.boolean().default(false)}).strict(),annotations:mutation,
  },async a=>{try{const s=requireSession(a.sessionId);const data=addCarrierRecovery(s.mission,a.group,a.ship,a.allowUnknown);s.dirty=true;refresh(s);return result(data);}catch(e){return errorResult(e);}});
  server.registerTool('dcs_miz_add_airfield_landing', {
    description: 'Append a Land/Landing waypoint linked to a known theatre airfield. Does not model carrier recovery or aircraft runway requirements. Offline only.',
    inputSchema: z.object({ sessionId, group: z.string().min(1), airfield: z.union([z.string().min(1), z.number().int().positive()]) }).strict(), annotations: mutation,
  }, async a => {
    try {
      const s = requireSession(a.sessionId), found = findGroup(s.mission, a.group);
      if (!found || !['plane', 'helicopter'].includes(found.category)) throw new Error('Landing requires an aircraft group');
      const airfield = findAirport(String(s.mission.theatre), a.airfield);
      const waypointIndex = addWaypoint(s.mission, a.group, { x: airfield.x, y: airfield.y, altitudeMetres: 0, speedMps: 0, type: 'Land', action: 'Landing' });
      asTable(asTable(asTable(found.group.route)?.points)?.[waypointIndex])!.airdromeId = airfield.id;
      s.dirty = true; refresh(s); return result({ group: a.group, waypointIndex, airfield: airfield.name, verification: 'offline only' });
    } catch (e) { return errorResult(e); }
  });
  server.registerTool('dcs_miz_create_ground_plan', {
    description: 'Configurable convoy, looping patrol, assault route or defensive position from explicit vehicle composition. Convoys default to On Road; assault/defensive groups default to parallel line placement and native Rank (line abreast) movement. Route points can change movement to road/offroad/line_abreast/wedge/diamond/echelon_left/echelon_right, inherited by following points, and override speedMps. Formation describes spawn geometry; road transit uses a column even if the spawn was a line. Combat deployment must be authored before contact; this is not automatic enemy detection or manoeuvre AI. Road action is routing intent: obtain native road points with dcs_terrain_roads and verify pathfinding. playerCanDrive sets the Combined Arms checkbox, not guaranteed type support. Atomic; offline only.',
    inputSchema: z.object({ ...baseGroup, composition: z.array(z.object({ type: z.string().min(1), count: z.number().int().min(1).max(100) }).strict()).min(1).max(100), plan: groundPlanSchema }).strict(), annotations: mutation,
  }, async a => {
    try { const s = requireSession(a.sessionId), pos = resolvePosition(s, a); const data = createGroundPlan(s.mission, { ...a, ...pos, type: a.composition[0].type, count: 1 }, a.plan); s.dirty = true; refresh(s); return result(data); }
    catch (e) { return errorResult(e); }
  });
  server.registerTool('dcs_miz_add_surface_task', {
    description: 'Append Hold, FireAtPoint or GoToWaypoint at a 1-based vehicle/ship waypoint. Preserves existing tasks. Range, ammunition and type-specific AI effectiveness are not known offline; use the live bridge/telemetry to test. Task format follows pydcs, not a claim of verified DCS behavior.',
    inputSchema: z.object({ sessionId, group: z.string().min(1), waypointIndex: z.number().int().positive(), task: surfaceTaskSchema }).strict(), annotations: mutation,
  }, async a => {
    try { const s = requireSession(a.sessionId); const data = appendSurfaceTask(s.mission, a.group, a.waypointIndex, a.task); s.dirty = true; refresh(s); return result(data); }
    catch (e) { return errorResult(e); }
  });
  server.registerTool('dcs_miz_add_threat_ring', {
    description: 'Add an F10 circle on a standard DCS drawing layer, using caller-supplied weapon/radar range in metres. Visual planning aid; no authoritative range inference or sensor model. Offline only.',
    inputSchema: z.object({ sessionId, ring: ringSchema }).strict(), annotations: mutation,
  }, async a => {
    try { const s = requireSession(a.sessionId); const data = addThreatRing(s.mission, a.ring); s.dirty = true; refresh(s); return result(data); }
    catch (e) { return errorResult(e); }
  });
  server.registerTool('dcs_miz_list_warehouses', {
    description: 'Read raw airfield and unit warehouse inventories, fuel, restrictions and supply records. Unknown data is preserved. No changes are made.',
    inputSchema: z.object({ sessionId }).strict(), annotations: { readOnlyHint: true },
  }, async a => { try { return result({ warehouses: listWarehouses(readWarehouses(requireSession(a.sessionId))) }); } catch (e) { return errorResult(e); } });
  server.registerTool('dcs_miz_edit_warehouse', {
    description: 'Edit warehouse fuel InitFuel, unlimited flags, resupply settings, dynamic settings and existing stock quantities. Aircraft and weapons require existing wsType-bearing entries; no identifiers are fabricated. Supplier lists can create/retain/remove links to existing same-coalition endpoints; self-links and duplicates are refused. create=true makes a pydcs-default entry for a known airfield/ship/FARP. Edits retain opaque fields and persist across restart/save. Atomic; offline only.',
    inputSchema: z.object({ sessionId, kind: z.enum(['airports', 'warehouses']), id: z.number().int().positive(), create: z.boolean().default(false), patch: warehousePatchSchema }).strict(), annotations: mutation,
  }, async a => {
    try { const s = requireSession(a.sessionId); s.warehouses = editWarehouse(s, a.kind, a.id, a.patch, a.create); s.dirty = true; refresh(s); return result({ kind: a.kind, id: a.id, verification: 'offline only', warnings: ['Stock editing requires existing wsType metadata; New stock requires a donor; supplier links use existing same-coalition endpoints'] }); }
    catch (e) { return errorResult(e); }
  });
}
