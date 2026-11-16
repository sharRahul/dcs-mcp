/**
 * Inspection and editing of existing content: routes/tasks, groups/units, goals, quad zones,
 * airbase ownership, imported site templates and DCS payload-library loadouts. Offline only.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getGroup, getRoute, getUnit, modifyWaypointTask, removeWaypointTask, setTaskEnabled } from '../miz/route-edit.js';
import { modifyUnit, unitChangeSchema } from '../miz/units.js';
import { getGoal, goalChangeSchema, listGoals, modifyGoal, removeGoal } from '../miz/goals.js';
import { addQuadZone } from '../miz/zones.js';
import { editWarehouse } from '../miz/logistics.js';
import { findAirport } from '../data/reference.js';
import { importSiteTemplate, removeImportedTemplate } from '../miz/site-import.js';
import { SITE_TEMPLATES } from '../miz/templates.js';
import { loadoutsFor, scanPayloads } from '../dcs/payloads.js';
import { applyLoadout } from '../miz/loadouts.js';
import { requireSession, refresh } from '../miz/sessions.js';
import { errorResult } from './format.js';
import { destructive, inspect, mutate, read, result, sessionId, writes } from './miz-extended.js';

const xy = z.object({ x: z.number().finite(), y: z.number().finite() }).strict();
const taskRef = { sessionId, group: z.string().min(1), waypointIndex: z.number().int().min(1), taskNumber: z.number().int().min(1) };

export function registerMizInspectEditTools(server: McpServer) {
  server.registerTool('dcs_miz_get_route', {
    description: 'Every waypoint of a group (position, altitude, speed, type/action, ETA lock, airfield/ship link) with its tasks, each identified against the waypoint-action catalogue (key, kind, enabled, params). Use the task numbers with modify/remove/enable.',
    inputSchema: z.object({ sessionId, group: z.string().min(1) }).strict(), annotations: read,
  }, async a => inspect(a.sessionId, s => getRoute(s.mission, a.group)));
  server.registerTool('dcs_miz_get_group', {
    description: 'Full detail of one group: side, country, category, every group field and every unit (type, skill, position, heading in degrees, altitude, payload, callsign, livery, tail number...). Route is summarised; use dcs_miz_get_route for waypoints.',
    inputSchema: z.object({ sessionId, group: z.string().min(1) }).strict(), annotations: read,
  }, async a => inspect(a.sessionId, s => getGroup(s.mission, a.group)));
  server.registerTool('dcs_miz_get_unit', {
    description: 'Full detail of one unit and the group/side/country it belongs to (heading in degrees).',
    inputSchema: z.object({ sessionId, unit: z.string().min(1) }).strict(), annotations: read,
  }, async a => inspect(a.sessionId, s => getUnit(s.mission, a.unit)));
  server.registerTool('dcs_miz_modify_waypoint_task', {
    description: 'Change one existing waypoint task: params for a task/command (validated like dcs_miz_add_waypoint_action, merged over the stored documented params) or value for an option. Fields the catalogue does not document are kept as stored. Tasks not in the catalogue (e.g. ControlledTask wrappers) are refused; remove and re-add them.',
    inputSchema: z.object({ ...taskRef, params: z.record(z.string(), z.unknown()).optional(), value: z.unknown().optional() }).strict(), annotations: writes,
  }, async a => mutate(a.sessionId, s => modifyWaypointTask(s.mission, a.group, a.waypointIndex, a.taskNumber, { params: a.params, value: a.value })));
  server.registerTool('dcs_miz_remove_waypoint_task', {
    description: 'Remove one task from a waypoint; the remaining tasks keep their order and are renumbered 1..n.',
    inputSchema: z.object(taskRef).strict(), annotations: destructive,
  }, async a => mutate(a.sessionId, s => removeWaypointTask(s.mission, a.group, a.waypointIndex, a.taskNumber)));
  server.registerTool('dcs_miz_set_waypoint_task_enabled', {
    description: "Enable or disable one waypoint task (the editor's per-action checkbox) without removing it.",
    inputSchema: z.object({ ...taskRef, enabled: z.boolean() }).strict(), annotations: writes,
  }, async a => mutate(a.sessionId, s => setTaskEnabled(s.mission, a.group, a.waypointIndex, a.taskNumber, a.enabled)));
  server.registerTool('dcs_miz_modify_unit', {
    description: 'Edit one unit: skill (one Player per mission; Client/Player aircraft only), livery (checked against installed folders), tail number, heading (degrees), altitude (aircraft), playerCanDrive (vehicles). Positions: dcs_miz_move_unit.',
    inputSchema: z.object({ sessionId, unit: z.string().min(1), change: unitChangeSchema }).strict(), annotations: writes,
  }, async a => mutate(a.sessionId, s => modifyUnit(s.mission, a.unit, a.change)));
  server.registerTool('dcs_miz_list_goals', {
    description: 'Mission score goals: index, side, score, comment, rule count and the result index DCS uses for it on that side.',
    inputSchema: z.object({ sessionId }).strict(), annotations: read,
  }, async a => inspect(a.sessionId, s => { const goals = listGoals(s.mission); return { count: goals.length, goals }; }));
  server.registerTool('dcs_miz_get_goal', {
    description: 'One goal with its rules and its compiled result condition and action.',
    inputSchema: z.object({ sessionId, index: z.number().int().min(1) }).strict(), annotations: read,
  }, async a => inspect(a.sessionId, s => getGoal(s.mission, a.index)));
  server.registerTool('dcs_miz_modify_goal', {
    description: "Change a goal's score, comment or conditions (recompiled with the oracle-backed trigger compiler). Rebuilds that side's result actions/func in pydcs's format; refuses if they were hand-written.",
    inputSchema: z.object({ sessionId, index: z.number().int().min(1), change: goalChangeSchema }).strict(), annotations: writes,
  }, async a => mutate(a.sessionId, s => modifyGoal(s.mission, a.index, a.change)));
  server.registerTool('dcs_miz_remove_goal', {
    description: "Remove a goal; goals are renumbered and that side's result tables rebuilt in pydcs's format (refused if hand-written).",
    inputSchema: z.object({ sessionId, index: z.number().int().min(1) }).strict(), annotations: destructive,
  }, async a => mutate(a.sessionId, s => removeGoal(s.mission, a.index)));
  server.registerTool('dcs_miz_add_quad_zone', {
    description: 'Add a quad (four-corner polygon) trigger zone, pydcs TriggerZoneQuadPoint format: absolute DCS x/y vertices in order around the shape; crossing or zero-area quads are refused. Usable by zone triggers like a circle zone.',
    inputSchema: z.object({ sessionId, name: z.string().min(1).max(128), vertices: z.array(xy).length(4), hidden: z.boolean().default(false) }).strict(), annotations: writes,
  }, async a => mutate(a.sessionId, s => { const z = addQuadZone(s.mission, a); return { name: a.name, zoneId: z.zoneId, x: z.x, y: z.y }; }));
  server.registerTool('dcs_miz_set_airbase_coalition', {
    description: "Set which coalition owns an airfield (its warehouse entry's coalition, creating the pydcs-default entry if the mission has none). Other warehouse data is kept. Units parked there are not moved or recoloured.",
    inputSchema: z.object({ sessionId, airfield: z.union([z.string().min(1), z.number().int().positive()]), coalition: z.enum(['RED', 'BLUE', 'NEUTRAL']) }).strict(), annotations: writes,
  }, async a => mutate(a.sessionId, s => {
    const ap = findAirport(String(s.mission.theatre), a.airfield);
    s.warehouses = editWarehouse(s, 'airports', ap.id, { coalition: a.coalition }, true);
    return { airfield: ap.name, id: ap.id, coalition: a.coalition };
  }));
  server.registerTool('dcs_import_site_template', {
    description: "Import an air-defence site from a mission YOU supply (ideally saved by the Mission Editor): the named ground group's unit types, order and exact per-unit offsets become a reusable template (provenance 'imported') for dcs_miz_add_ground_group's site argument. The source file is only read. Stored under DCS_MCP_TEMPLATE_DIR or the user data folder.",
    inputSchema: z.object({ file: z.string().min(1), group: z.string().min(1), id: z.string().min(1).max(48), description: z.string().max(300).optional(),
      skynetRole: z.enum(['sam', 'ewr']).default('sam'), overwrite: z.boolean().default(false) }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async a => { try { return result(await importSiteTemplate(a, SITE_TEMPLATES.map(t => t.id))); } catch (e) { return errorResult(e); } });
  server.registerTool('dcs_remove_site_template', {
    description: 'Delete one imported site template (built-in templates cannot be removed).',
    inputSchema: z.object({ id: z.string().min(1).max(48) }).strict(), annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, async a => { try { return result(removeImportedTemplate(a.id)); } catch (e) { return errorResult(e); } });
  server.registerTool('dcs_list_loadouts', {
    description: "Named loadouts from this machine's DCS payload library (user Saved Games UnitPayloads, the install's stock files, per-airframe and mod folders, in pydcs's order), read as data, never executed. Filter by main task. status 'unknown' means no DCS directories were found, not that none exist.",
    inputSchema: z.object({ type: z.string().min(1), task: z.string().optional(), refresh: z.boolean().default(false) }).strict(), annotations: read,
  }, async a => { try { const r = loadoutsFor(a.type, a.task, scanPayloads(a.refresh)); return result({ ...r, count: r.loadouts.length }); } catch (e) { return errorResult(e); } });
  server.registerTool('dcs_miz_apply_loadout', {
    description: "Apply a named payload-library loadout (dcs_list_loadouts) to every unit of an aircraft group or to one unit: pylons with their settings, as the library defines them. Fuel, chaff, flares and gun are kept. CLSIDs the bundled pydcs catalogue does not list on that pylon are reported, not refused (the library is your DCS install's own data).",
    inputSchema: z.object({ sessionId, group: z.string().min(1).optional(), unit: z.string().min(1).optional(), loadout: z.string().min(1) }).strict(), annotations: writes,
  }, async a => mutate(a.sessionId, s => applyLoadout(s.mission, { group: a.group, unit: a.unit }, a.loadout)));
}
