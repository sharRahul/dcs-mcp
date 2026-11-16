import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { missionReport } from '../miz/report.js';
import { configurationSchema, configureMission, assignCountry, sideSchema, referencePointSchema, addReferencePoint } from '../miz/configuration.js';
import { addDrawing, drawingSchema } from '../miz/drawings.js';
import { embedAsset, listAssets, removeAsset } from '../miz/assets.js';
import { addGoal, goalSchema } from '../miz/scoring.js';
import { copySession, commitSession, directMission, directorSchema, checkActionResources } from '../miz/director.js';
import { addTrigger, replaceTrigger, triggerCapabilities, findGroupOfUnit, type ActionSpec, type ConditionSpec } from '../miz/authoring.js';
import { conditionSchema, triggerSchema } from '../miz/trigger-schema.js';
import { generateCampaign, campaignSchema, generateScenario, scenarioSchema } from '../scenario/engine.js';
import { refresh, requireSession, closeSession } from '../miz/sessions.js';
import { buildResult, errorResult } from './format.js';
import { ARCHIVE_LIMITS } from '../constants.js';
const sessionId = z.string().min(1);
const writes = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
const read = { readOnlyHint: true, openWorldHint: false } as const;
function result(data: Record<string, unknown>) { return buildResult(JSON.stringify(data), data); }
export function registerMissionDesignTools(server: McpServer) {
  server.registerTool('dcs_miz_trigger_capabilities', {
    description: 'List the exact supported trigger types and oracle-backed DCS condition/action predicates. Unknown imported compiled predicates are preserved; this is not a claim of every DCS Mission Editor predicate.',
    inputSchema: z.object({}).strict(), annotations: read,
  }, async () => result(triggerCapabilities()));
  server.registerTool('dcs_miz_add_unit_activation', {
    description: 'Conditionally activate/deactivate a named unit by resolving a single-unit group and compiling the existing group action. Refuses multi-unit groups because DCS activation is group-scoped; create a single-unit group for independent activation. Activation requires lateActivation=true.',
    inputSchema: z.object({ sessionId, unit: z.string().min(1), activate: z.boolean(), conditions: z.array(conditionSchema).min(1).max(50) }).strict(), annotations: writes,
  }, async a => {
    try {
      const s = requireSession(a.sessionId), copy = copySession(s), found = findGroupOfUnit(copy.mission, a.unit);
      if (!found || found.category === 'static' || Object.keys(found.group.units as object).length !== 1) throw new Error('Independent unit activation requires a single-unit non-static group');
      if (a.activate && found.group.lateActivation !== true) throw new Error('Activation requires lateActivation=true');
      const triggerIndex = addTrigger(copy.mission, { type: 'once', comment: `${a.activate ? 'Activate' : 'Deactivate'} ${a.unit}`, conditions: a.conditions as ConditionSpec[],
        actions: [{ kind: a.activate ? 'activate_group' : 'deactivate_group', group: String(found.group.name) }] }, copy.dictionary);
      commitSession(s, copy); s.dirty = true; refresh(s); return result({ unit: a.unit, group: found.group.name, triggerIndex });
    } catch (e) { return errorResult(e); }
  });
  server.registerTool('dcs_miz_mission_report', {
    description: 'Report the current session: forces, per-unit identity/payloads, tasks/routes, triggers, goals, frequencies, zones, script dependencies, assets, options and validation warnings. Recomputes from current tables; embedded generation reports are snapshots. Does not infer DCS execution.',
    inputSchema: z.object({ sessionId }).strict(), annotations: read,
  }, async a => { try { return result({ report: missionReport(requireSession(a.sessionId)) }); } catch (e) { return errorResult(e); } });
  server.registerTool('dcs_miz_configure_mission', {
    description: 'Atomic mission configuration: canonical theatre (empty missions only), country assignments, validated date/time, static weather/wind/clouds/fog/dust/visibility/turbulence, coalition briefings and bullseyes. Existing options/restrictions tool remains available. Season follows date; temperature is explicit. Unknown cloud presets cannot be checked without installed DCS. Offline only.',
    inputSchema: z.object({ sessionId, configuration: configurationSchema }).strict(), annotations: writes,
  }, async a => { try { const s = requireSession(a.sessionId); const data = configureMission(s.mission, a.configuration); s.dirty = true; refresh(s); return result(data); } catch (e) { return errorResult(e); } });
  server.registerTool('dcs_miz_assign_country', {
    description: 'Move a whole country and all of its groups to a coalition, updating both coalition representations. Preserves triggers/tasks; review their coalition semantics and warehouse ownership afterwards.',
    inputSchema: z.object({ sessionId, country: z.string().min(1), side: sideSchema }).strict(), annotations: writes,
  }, async a => { try { const s = requireSession(a.sessionId); const data = assignCountry(s.mission, a.country, a.side); s.dirty = true; refresh(s); return result(data); } catch (e) { return errorResult(e); } });
  server.registerTool('dcs_miz_add_reference_point', {
    description: 'Add an aircraft-specific NavTargetPoints reference (DCS metres). F-14/JF-17 conventions depend on text_comment; other modules may ignore it. General navigation uses the existing waypoint tools; coalition nav_points schema is not guessed.',
    inputSchema: z.object({ sessionId, point: referencePointSchema }).strict(), annotations: writes,
  }, async a => { try { const s = requireSession(a.sessionId); const data = addReferencePoint(s.mission, a.point.group, a.point.name, a.point.position); s.dirty = true; refresh(s); return result(data); } catch (e) { return errorResult(e); } });
  server.registerTool('dcs_miz_add_drawing', {
    description: 'F10 drawing: line (segment/segments/freehand), free polygon, circle, oval, rectangle, arrow, oblong corridor, text box or standard icon, with pydcs line styles. Vertices are absolute DCS x/y metres; serialized vertices are relative to origin. Only standard layers Red/Blue/Neutral/Common/Author. Runtime visibility depends on F10 options and DCS roles. Preserves existing objects. Offline format evidence: pydcs.',
    inputSchema: z.object({ sessionId, drawing: drawingSchema }).strict(), annotations: writes,
  }, async a => { try { const s = requireSession(a.sessionId); const data = addDrawing(s.mission, a.drawing); s.dirty = true; refresh(s); return result(data); } catch (e) { return errorResult(e); } });
  server.registerTool('dcs_miz_embed_asset', {
    description: 'Embed audio, coalition briefing image, aircraft-type kneeboard page, Lua script or mission media. Existing files are not replaced with different bytes. PNG/JPEG and WAV/OGG extensions are checked, not codecs. Scripts are embedded, never executed by the server; use existing trigger/framework tools to run them in DCS. Kneeboards apply to every aircraft of that type.',
    inputSchema: z.object({ sessionId, kind: z.enum(['audio', 'briefing_image', 'kneeboard', 'script', 'media']), path: z.string().min(1), fileName: z.string().min(1).optional(), side: sideSchema.default('blue'), aircraft: z.string().min(1).optional() }).strict(), annotations: { ...writes, openWorldHint: true },
  }, async a => {
    try {
      const s = requireSession(a.sessionId), before = JSON.stringify([s.mission, s.mapResource, [...s.files].map(([n, b]) => [n, b.toString('base64')]), [...(s.removedEntries ?? [])]]);
      const info = await stat(a.path); if (!info.isFile() || info.size > ARCHIVE_LIMITS.maxEntryUncompressed) throw new Error('Asset path is not a file or exceeds size limit');
      const bytes = await readFile(a.path), copy = copySession(s);
      const data = embedAsset(copy, a.kind, a.fileName ?? basename(a.path), bytes, a.side, a.aircraft);
      if (JSON.stringify([s.mission, s.mapResource, [...s.files].map(([n, b]) => [n, b.toString('base64')]), [...(s.removedEntries ?? [])]]) !== before) throw new Error('Mission changed while reading asset; retry');
      commitSession(s, copy); s.dirty = true; refresh(s); return result(data);
    } catch (e) { return errorResult(e); }
  });
  server.registerTool('dcs_miz_list_assets', {
    description: 'List effective mission media and kneeboard archive paths, resource keys and byte sizes, including pending additions/removals. No media is executed.',
    inputSchema: z.object({ sessionId }).strict(), annotations: read,
  }, async a => { try { return result({ assets: listAssets(requireSession(a.sessionId)) }); } catch (e) { return errorResult(e); } });
  server.registerTool('dcs_miz_remove_asset', {
    description: 'Remove one asset and its mapResource keys from the saved archive and snapshots, preserving unrelated members. Refuses known mission-table references unless force=true; opaque script references are not fully resolved; forcing leaves references requiring repair.',
    inputSchema: z.object({ sessionId, archivePath: z.string().min(1), force: z.boolean().default(false) }).strict(), annotations: { ...writes, destructiveHint: true },
  }, async a => { try { const s = requireSession(a.sessionId), copy = copySession(s); const data = removeAsset(copy, a.archivePath, a.force); commitSession(s, copy); s.dirty = true; refresh(s); return result(data); } catch (e) { return errorResult(e); } });
  server.registerTool('dcs_miz_add_goal', {
    description: 'Add a mission score goal with both goals rules and compiled result conditions/actions/functions. Conditions use only the existing oracle-backed compiler; existing goals/results are preserved. Distinct from an end_mission trigger. Format follows pydcs; runtime is mock-tested only.',
    inputSchema: z.object({ sessionId, goal: goalSchema }).strict(), annotations: writes,
  }, async a => { try { const s = requireSession(a.sessionId); const data = addGoal(s.mission, a.goal); s.dirty = true; refresh(s); return result(data); } catch (e) { return errorResult(e); } });
  server.registerTool('dcs_miz_replace_trigger', {
    description: 'Replace a trigger type, conditions and actions atomically at its stable 1-based index. Compiles both trigrules and trig; does not shift other triggers. Opaque custom runtime data at that index is refused. Resource actions require existing embedded keys.',
    inputSchema: z.object({ sessionId, index: z.number().int().positive(), trigger: triggerSchema }).strict(), annotations: writes,
  }, async a => { try { const s = requireSession(a.sessionId); checkActionResources(s, a.trigger.actions as ActionSpec[]); replaceTrigger(s.mission, s.dictionary, a.index, { ...a.trigger, actions: a.trigger.actions as ActionSpec[], conditions: a.trigger.conditions as ConditionSpec[] }); s.dirty = true; refresh(s); return result({ index: a.index }); } catch (e) { return errorResult(e); } });
  server.registerTool('dcs_miz_add_counter', {
    description: 'Increment a user-flag counter from real conditions using an existing compiled do_script action and public trigger flag APIs. once increments once, change increments on false-to-true edges. No unsupported increment predicate is invented.',
    inputSchema: z.object({ sessionId, flag: z.number().int().positive().max(2147483647), increment: z.number().int().min(-1000000).max(1000000), type: z.enum(['once', 'change']).default('change'), conditions: z.array(conditionSchema).min(1).max(50) }).strict(), annotations: writes,
  }, async a => { try { const s = requireSession(a.sessionId), copy = copySession(s); const index = addTrigger(copy.mission, { type: a.type, comment: `Counter ${a.flag}`, conditions: a.conditions as ConditionSpec[], actions: [{ kind: 'do_script', text: `trigger.action.setUserFlag(${a.flag}, (tonumber(trigger.misc.getUserFlag(${a.flag})) or 0) + (${a.increment}))` }] }, copy.dictionary); commitSession(s, copy); s.dirty = true; refresh(s); return result({ triggerIndex: index, flag: a.flag }); } catch (e) { return errorResult(e); } });
  server.registerTool('dcs_miz_direct_mission', {
    description: 'Compile an event-driven cinematic director: actual conditions, branching dependencies and delays, radio dialogue/subtitles, optional existing audio keys, reinforcement actions, scripts, shot lists, timeline and short-form highlight suggestions. Templates are explicitly fictional; supplied procedure citations are unverified. Missing audio yields placeholders and subtitles, never fake radio playback. No TTS or AI subscription.',
    inputSchema: z.object({ sessionId, director: directorSchema }).strict(), annotations: writes,
  }, async a => { try { const s = requireSession(a.sessionId); const report = directMission(s, a.director); s.dirty = true; refresh(s); return result({ report }); } catch (e) { return errorResult(e); } });
  server.registerTool('dcs_scenario_validate', {
    description: 'Independently validate a structured scenario by fully compiling into a disposable mission: schema, country/type/role/target/start dependencies, triggers, goals, supports and final validator. Returns the normalized spec/report; retains no session. No external AI API.',
    inputSchema: z.object({ specification: scenarioSchema }).strict(), annotations: read,
  }, async a => { try { const built = generateScenario(a.specification); closeSession(built.session.id); return result({ valid: true, specification: built.specification, report: built.report }); } catch (e) { return errorResult(e); } });
  server.registerTool('dcs_scenario_generate', {
    description: 'Deterministically generate an editable mission session from a strict client-supplied specification and optional seed. Supports air-to-air, counter-air, SEAD/DEAD, CAS/strike, zone/flag CSAR, convoy escort, naval strike and ship-linked starts. Explicit forces/supports, difficulty AI skills, actual duration limit, victory/failure goals and event-driven director. Embeds specification/report. No subscription; offline only.',
    inputSchema: z.object({ specification: scenarioSchema }).strict(), annotations: writes,
  }, async a => { try { const built = generateScenario(a.specification); return result({ sessionId: built.session.id, report: built.report }); } catch (e) { return errorResult(e); } });
  server.registerTool('dcs_campaign_generate', {
    description: 'Generate validated mission-stage sessions plus a deterministic, acyclic victory/failure transition manifest. Save each session with save_as. Does not claim to write a DCS .cmp or automatic cross-mission persistence. All stages roll back if any fails.',
    inputSchema: z.object({ campaign: campaignSchema }).strict(), annotations: writes,
  }, async a => { try { const built = generateCampaign(a.campaign); return result({ name: built.name, stages: built.stages.map(s => ({ name: s.report.name, sessionId: s.session.id, report: s.report })), transitions: built.transitions, limitation: built.limitation }); } catch (e) { return errorResult(e); } });
}
