/**
 * Drawings management, radios, group operations, weather presets, liveries and
 * geometry helpers. All offline: none of this is Mission-Editor or flight verified.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { clearLayer, ICON_FILES, listDrawings, removeDrawing, STANDARD_LAYERS } from '../miz/drawings.js';
import { meIcons } from '../data/me-icons.js';
import { radioInfo, resetRadioPresets, setIntraFlightFrequency, setRadioPresets } from '../miz/radios.js';
import { listCloudPresets, setCloudPreset } from '../miz/weather.js';
import { lerp, pointFromBearing, pointsInZone, randomPointInCircle } from '../miz/geometry.js';
import { addWaypointAction, listWaypointActions } from '../miz/actions.js';
import { callsignOptions } from '../miz/callsigns.js';
import { airfieldRadio } from '../data/airfield-radio.js';
import { liveriesForType, liveryStatus, scanLiveries } from '../dcs/liveries.js';
import { addUnitsToGroup, cloneGroup, findGroupsNear, setRoute } from '../miz/groups.js';
import { refresh, requireSession } from '../miz/sessions.js';
import { buildResult, errorResult } from './format.js';

export const sessionId = z.string().min(1);
export const writes = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
export const destructive = { readOnlyHint: false, destructiveHint: true, openWorldHint: false } as const;
export const read = { readOnlyHint: true, openWorldHint: false } as const;
export function result(data: Record<string, unknown>) { return buildResult(JSON.stringify(data), data); }

/** Run a session mutation, mark it dirty and snapshot it. */
export function mutate<T extends Record<string, unknown>>(id: string, fn: (s: ReturnType<typeof requireSession>) => T) {
  try { const s = requireSession(id); const data = fn(s); s.dirty = true; refresh(s); return result(data); } catch (e) { return errorResult(e); }
}
export function inspect<T extends Record<string, unknown>>(id: string, fn: (s: ReturnType<typeof requireSession>) => T) {
  try { return result(fn(requireSession(id))); } catch (e) { return errorResult(e); }
}

export function registerMizExtendedTools(server: McpServer) {
  const layer = z.enum(STANDARD_LAYERS);
  server.registerTool('dcs_miz_list_drawings', {
    description: 'List F10 map drawings (name, layer, primitive type/mode, origin). Optionally filter to one standard layer.',
    inputSchema: z.object({ sessionId, layer: layer.optional() }).strict(), annotations: read,
  }, async a => inspect(a.sessionId, s => { const drawings = listDrawings(s.mission, a.layer); return { count: drawings.length, drawings }; }));
  server.registerTool('dcs_list_map_icons', {
    description: "Every F10 map icon that can be used by dcs_miz_add_drawing kind=icon: the Mission Editor's own picker list (label -> image file, read from the install by scripts/gen-me-icons.py and bundled as data/me-icons.json) plus pydcs's nine StandardIcon names. The file name is what the mission file's drawing `file` field holds, confirmed against Mission-Editor-saved missions. Unknown names are refused rather than written as a guessed file.",
    inputSchema: z.object({ query: z.string().min(1).optional().describe('Case-insensitive filter on the label.') }).strict(), annotations: read,
  }, async a => {
    const data = (() => { try { return meIcons(); } catch { return undefined; } })();
    const q = a.query?.toLowerCase();
    const icons = Object.entries(ICON_FILES)
      .filter(([name]) => !q || name.toLowerCase().includes(q))
      .sort(([a1], [b1]) => a1.localeCompare(b1))
      .map(([name, file]) => ({ name, file, source: name in (data?.icons ?? {}) ? 'mission editor' : 'pydcs StandardIcon' }));
    return result({ count: icons.length, editorIcons: data?.count ?? 0, dcsVersion: data?._dcsVersion ?? null, icons });
  });
  server.registerTool('dcs_miz_remove_drawing', {
    description: 'Remove one F10 drawing by layer and name. Other drawings and drawing options are kept.',
    inputSchema: z.object({ sessionId, layer, name: z.string().min(1) }).strict(), annotations: destructive,
  }, async a => mutate(a.sessionId, s => removeDrawing(s.mission, a.layer, a.name)));
  server.registerTool('dcs_miz_clear_drawing_layer', {
    description: 'Remove every drawing on one standard F10 layer (the layer itself stays).',
    inputSchema: z.object({ sessionId, layer }).strict(), annotations: destructive,
  }, async a => mutate(a.sessionId, s => clearLayer(s.mission, a.layer)));

  const noBands = 'pydcs has no radio band data, so frequencies are NOT checked against the radio band.';
  server.registerTool('dcs_list_radios', {
    description: `Radios of an aircraft type: pydcs default intra-flight frequency and each preset radio's channel count and default channels. ${noBands}`,
    inputSchema: z.object({ type: z.string().min(1) }).strict(), annotations: read,
  }, async a => { try { return result(radioInfo(a.type)); } catch (e) { return errorResult(e); } });
  server.registerTool('dcs_miz_set_radio_presets', {
    description: `Set channel presets (MHz) on one aircraft unit's radio, written to unit.Radio like pydcs set_radio_channel_preset. Unknown radios/channels are refused; untouched channels keep their airframe defaults. pydcs only does this for Client/Player units. ${noBands}`,
    inputSchema: z.object({ sessionId, unit: z.string().min(1), radio: z.number().int().positive(),
      channels: z.record(z.string().regex(/^\d+$/), z.number().positive().max(1000)) }).strict(), annotations: writes,
  }, async a => mutate(a.sessionId, s => setRadioPresets(s.mission, a.unit, { radio: a.radio, channels: a.channels })));
  server.registerTool('dcs_miz_reset_radio_presets', {
    description: 'Reset every unit of an aircraft group to the airframe\'s default presets (pydcs set_radio_preset).',
    inputSchema: z.object({ sessionId, group: z.string().min(1) }).strict(), annotations: destructive,
  }, async a => mutate(a.sessionId, s => resetRadioPresets(s.mission, a.group)));
  server.registerTool('dcs_miz_set_intra_flight_frequency', {
    description: `Set an aircraft group's intra-flight frequency (group.frequency, radioSet) like pydcs FlyingGroup.set_frequency; Client/Player units with presets get channel 1 of the given radio set to it. Omit frequencyMHz to use the airframe's pydcs default. ${noBands}`,
    inputSchema: z.object({ sessionId, group: z.string().min(1), frequencyMHz: z.number().positive().max(1000).optional(),
      radio: z.number().int().positive().default(1), modulation: z.union([z.literal(0), z.literal(1)]).optional().describe('0 = AM, 1 = FM') }).strict(), annotations: writes,
  }, async a => mutate(a.sessionId, s => setIntraFlightFrequency(s.mission, a.group, a.frequencyMHz, a.radio, a.modulation)));
  server.registerTool('dcs_list_cloud_presets', {
    description: 'The Mission Editor cloud presets (from pydcs cloud_presets.py) with their allowed cloud-base range.',
    inputSchema: z.object({}).strict(), annotations: read,
  }, async () => { const presets = listCloudPresets(); return result({ count: presets.length, presets }); });
  server.registerTool('dcs_miz_set_cloud_preset', {
    description: 'Apply a cloud preset by stored name (Preset7), editor label (Scattered 2) or pydcs name, with an optional base in metres checked against the preset\'s range. preset=null returns to manual clouds. Thickness/density are not preset-configurable and are kept.',
    inputSchema: z.object({ sessionId, preset: z.string().min(1).nullable(), baseMetres: z.number().finite().optional() }).strict(), annotations: writes,
  }, async a => mutate(a.sessionId, s => setCloudPreset(s.mission, a.preset, a.baseMetres)));

  const sideEnum = z.enum(['blue', 'red', 'neutrals']);
  server.registerTool('dcs_miz_clone_group', {
    description: 'Duplicate a group under a new name with fresh ids, offset by dx/dy metres (x north, y east); every route point moves with it. Optionally to another side/country. Refuses parking/ship/FARP starts (the copy would reuse the slot). Datalinks are dropped; tail numbers/callsigns are copied and reported; triggers are not copied.',
    inputSchema: z.object({ sessionId, source: z.string().min(1), newName: z.string().min(1).max(128),
      dx: z.number().finite().default(0), dy: z.number().finite().default(0), side: sideEnum.optional(), country: z.string().min(1).optional() }).strict(), annotations: writes,
  }, async a => mutate(a.sessionId, s => cloneGroup(s.mission, a.source, a)));
  server.registerTool('dcs_miz_add_units_to_group', {
    description: 'Append units to an existing group, trailing its last unit along the lead heading at the category spacing. Aircraft must match the lead type, stay within 16 and be an air start (parking would need new slots); they copy the lead payload/skill. Ground/ship units may be any known type.',
    inputSchema: z.object({ sessionId, group: z.string().min(1), type: z.string().min(1).optional(), count: z.number().int().min(1).max(64) }).strict(), annotations: writes,
  }, async a => mutate(a.sessionId, s => addUnitsToGroup(s.mission, a.group, a)));
  server.registerTool('dcs_miz_find_groups_near', {
    description: 'Groups whose lead unit is within radiusMetres of a DCS x/y point, nearest first, optionally filtered by side and category (plane, helicopter, vehicle, ship, static).',
    inputSchema: z.object({ sessionId, x: z.number().finite(), y: z.number().finite(), radiusMetres: z.number().positive().max(2000000),
      side: sideEnum.optional(), category: z.enum(['plane', 'helicopter', 'vehicle', 'ship', 'static']).optional() }).strict(), annotations: read,
  }, async a => inspect(a.sessionId, s => { const groups = findGroupsNear(s.mission, a); return { count: groups.length, groups }; }));
  server.registerTool('dcs_miz_set_route', {
    description: 'Replace every waypoint after the start point with the given list (same fields as dcs_miz_add_waypoint). Point 1 is always kept. Tasks on replaced waypoints are removed and counted.',
    inputSchema: z.object({ sessionId, group: z.string().min(1), points: z.array(z.object({ x: z.number().finite(), y: z.number().finite(),
      altitudeMetres: z.number().finite().optional(), speedMps: z.number().nonnegative().optional(), type: z.string().optional(),
      action: z.string().optional(), name: z.string().optional() }).strict()).max(500) }).strict(), annotations: destructive,
  }, async a => mutate(a.sessionId, s => setRoute(s.mission, a.group, a.points)));

  server.registerTool('dcs_list_liveries', {
    description: 'Liveries installed on this machine for an aircraft type, scanned like pydcs LiveryScanner (DCS install CoreMods/Bazar/campaigns/tech and Saved Games Liveries/Mods). description.lua is read as text, never executed. An empty list with scannedRoots=0 means unknown (no DCS found; set DCS_INSTALL_DIR / DCS_SAVED_GAMES), not "none".',
    inputSchema: z.object({ type: z.string().min(1), refresh: z.boolean().default(false) }).strict(), annotations: read,
  }, async a => { try { const r = liveriesForType(a.type, scanLiveries(a.refresh)); return result({ ...r, count: r.liveries.length }); } catch (e) { return errorResult(e); } });
  server.registerTool('dcs_check_livery', {
    description: 'Check whether a livery id is installed for an aircraft type (and allowed for a country, from its description.lua). Returns installed | not_installed | unknown.',
    inputSchema: z.object({ type: z.string().min(1), livery: z.string().min(1), country: z.string().optional() }).strict(), annotations: read,
  }, async a => { try { return result({ type: a.type, livery: a.livery, ...liveryStatus(a.type, a.livery, a.country) }); } catch (e) { return errorResult(e); } });

  const xy = z.object({ x: z.number().finite(), y: z.number().finite() }).strict();
  server.registerTool('dcs_geometry', {
    description: 'Flat-grid helpers in DCS metres (x north, y east, bearing degrees clockwise from grid north): point_from_bearing, midpoint, lerp (t 0..1), random_in_circle (uniform by area; seed makes it reproducible). Grid north differs from true north away from the theatre origin; use dcs_geo_convert for lat/lon. No terrain involved.',
    inputSchema: z.object({ operation: z.enum(['point_from_bearing', 'midpoint', 'lerp', 'random_in_circle']),
      from: xy, to: xy.optional(), bearingDegrees: z.number().finite().optional(), distanceMetres: z.number().nonnegative().max(5000000).optional(),
      t: z.number().finite().optional(), radiusMetres: z.number().positive().max(5000000).optional(),
      count: z.number().int().min(1).max(500).default(1), seed: z.number().int().optional() }).strict(), annotations: read,
  }, async a => {
    try {
      const need = <T>(v: T | undefined, n: string): T => { if (v === undefined) throw new Error(`${n} is required for ${a.operation}`); return v; };
      switch (a.operation) {
        case 'point_from_bearing': return result({ point: pointFromBearing(a.from, need(a.bearingDegrees, 'bearingDegrees'), need(a.distanceMetres, 'distanceMetres')) });
        case 'midpoint': return result({ point: lerp(a.from, need(a.to, 'to'), 0.5) });
        case 'lerp': return result({ point: lerp(a.from, need(a.to, 'to'), need(a.t, 't')) });
        case 'random_in_circle': return result({ points: randomPointInCircle(a.from, need(a.radiusMetres, 'radiusMetres'), a.count, a.seed) });
      }
    } catch (e) { return errorResult(e); }
  });
  server.registerTool('dcs_miz_points_in_zone', {
    description: 'Test DCS x/y points against a trigger zone of the session: circle zones by radius, quad zones by their vertices.',
    inputSchema: z.object({ sessionId, zone: z.string().min(1), points: z.array(xy).min(1).max(1000) }).strict(), annotations: read,
  }, async a => inspect(a.sessionId, s => pointsInZone(s.mission, a.zone, a.points)));

  const category = z.enum(['plane', 'helicopter', 'vehicle', 'ship']);
  server.registerTool('dcs_list_waypoint_actions', {
    description: 'Catalogue of DCS waypoint tasks, commands and options from the Hoggit DCS scripting wiki (data/hoggit.json): action key, kind, which group categories it applies to, documented params/required params or option id and allowed values, and the wiki page. Filter by category and kind. Scripting-API documentation, not ME-verified.',
    inputSchema: z.object({ category: category.optional(), kind: z.enum(['task', 'command', 'option']).optional() }).strict(), annotations: read,
  }, async a => { const actions = listWaypointActions(a.category, a.kind); return result({ count: actions.length, actions }); });
  server.registerTool('dcs_miz_add_waypoint_action', {
    description: 'Append any catalogued task, command or option (dcs_list_waypoint_actions) to a waypoint of any group (aircraft, vehicle or ship). Tasks: params as documented; commands are wrapped in WrappedAction; options take `value` (enum name or number, boolean, range...) and use the numeric option id for the group\'s domain (Air/Ground/Naval). Undocumented params, wrong categories and unknown option values are refused. groupId/unitId may be given as names. Positions are DCS x/y metres, frequencies Hz as on the wiki. Not ME-verified.',
    inputSchema: z.object({ sessionId, group: z.string().min(1), waypointIndex: z.number().int().min(1), action: z.string().min(1),
      params: z.record(z.string(), z.unknown()).optional(), value: z.unknown().optional() }).strict(), annotations: writes,
  }, async a => mutate(a.sessionId, s => addWaypointAction(s.mission, a.group, a.waypointIndex, { action: a.action, params: a.params, value: a.value })));
  server.registerTool('dcs_list_callsigns', {
    description: 'NATO callsign families available to an aircraft type (numbers from the Hoggit wiki enums: 1-8 generic, AWACS 1-5 and tanker 1-3 by main task, 9+ type-specific only where pydcs callnames match the wiki list exactly). Use the family number or name in dcs_miz_configure_flight callsign, or SetCallsign.',
    inputSchema: z.object({ type: z.string().min(1), task: z.string().optional().describe('Main task, e.g. AWACS or Refueling') }).strict(), annotations: read,
  }, async a => result(callsignOptions(a.type, a.task)));

  server.registerTool('dcs_airfield_radio', {
    description: "An airfield's ATC radios (HF / VHF low / VHF high / UHF, MHz) and runway designators, from pydcs's export of DCS airfield data. Runway headings are designator x 10, not measured. navaids (ICAO, elevation, TACAN, VOR, NDB, ILS MHz) come from DimOn's Aerodrome Data and Frequencies kneeboards by OCR, only where that row's ATC frequencies match pydcs; empty = not extracted. No magnetic variation.",
    inputSchema: z.object({ theatre: z.string().min(1), airfield: z.union([z.string().min(1), z.number().int()]) }).strict(), annotations: read,
  }, async a => { try { return result(airfieldRadio(a.theatre, a.airfield)); } catch (e) { return errorResult(e); } });
}
