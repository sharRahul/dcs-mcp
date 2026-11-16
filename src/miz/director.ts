/** Event-driven cinematic orchestration using only the existing trigger compiler. */
import luaparse from 'luaparse';
import { z } from 'zod';
import type { MissionSession } from './sessions.js';
import { conditionSchema, actionSchema } from './trigger-schema.js';
import { sideSchema } from './configuration.js';
import { addTrigger, findGroup, findUnit, type ActionSpec, type ConditionSpec } from './authoring.js';
import { allocateFlags } from './scoring.js';
import { quoteLuaString } from './serializer.js';
import { luaArray } from './lua.js';
import { listAssets, embedAsset, readAssetBytes } from './assets.js';
const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
export const directorSchema = z.object({ name: id, channels: z.array(z.object({ id, speaker: z.string().min(1).max(100), callsign: z.string().min(1).max(100),
  frequencyMHz: z.number().positive().max(400), style: z.enum(['nato', 'russian']).default('nato'),
}).strict()).min(1).max(100), events: z.array(z.object({
  id, phase: z.enum(['briefing', 'atc_departure', 'atc_recovery', 'awacs', 'jtac', 'detection', 'engagement', 'reinforcements', 'escalation', 'branch', 'victory', 'failure', 'end']),
  channel: id, when: z.object({ conditions: z.array(conditionSchema).max(50).default([]), afterEvent: id.optional(),
    worldEvent: z.object({ kind: z.enum(['takeoff', 'land', 'shot', 'hit', 'kill', 'dead', 'ejection']), unit: z.string().min(1) }).strict().optional(),
    delaySeconds: z.number().int().min(0).max(86400).default(0), atSeconds: z.number().int().min(0).max(86400).optional() }).strict(),
  text: z.string().min(1).max(10000).optional(), template: z.enum(['check_in', 'depart', 'recover', 'contact', 'coordinate', 'success', 'failure']).optional(),
  subject: z.string().min(1).max(1000).default('mission tasking'), procedureSource: z.string().min(1).max(2000).optional(),
  delivery: z.enum(['subtitle', 'audio', 'radio']).default('subtitle'), audioResourceKey: z.string().min(1).optional(),
  transmitterZone: z.string().min(1).optional(), audience: sideSchema.default('blue'),
  seconds: z.number().int().min(1).max(600).default(15), effects: z.array(actionSchema).max(50).default([]),
  deliveryNotes: z.string().max(4000).default(''), shot: z.string().max(2000).optional(),
}).strict()).min(1).max(200), embedReport: z.boolean().default(true) }).strict();
export function copySession(session: MissionSession): MissionSession {
  return { ...session, mission: structuredClone(session.mission), dictionary: structuredClone(session.dictionary), mapResource: structuredClone(session.mapResource),
    files: new Map(session.files), archiveFiles: new Map(session.archiveFiles), removedEntries: new Set(session.removedEntries) };
}
export function commitSession(target: MissionSession, copy: MissionSession) {
  Object.assign(target, { mission: copy.mission, dictionary: copy.dictionary, mapResource: copy.mapResource, files: copy.files, archiveFiles: copy.archiveFiles, removedEntries: copy.removedEntries });
}
export function checkActionResources(session: MissionSession, actions: ActionSpec[]) {
  const assets = listAssets(session);
  for (const action of actions) {
    if (action.kind === 'do_script') luaparse.parse(action.text, { luaVersion: '5.1' });
    if (action.kind === 'set_flag_random' && action.min > action.max) throw new Error('Random flag minimum exceeds maximum');
    if ('resourceKey' in action) {
      const asset = assets.find(a => a.keys.includes(action.resourceKey));
      if (!asset) throw new Error(`Missing resource ${action.resourceKey}`);
      if (action.kind === 'do_script_file') {
        if (!/\.lua$/i.test(asset.path)) throw new Error('Script action must reference a Lua file');
        luaparse.parse(readAssetBytes(session, asset.path)!.toString('utf8'), { luaVersion: '5.1' });
      }
    }
  }
}
const templates = { check_in: 'Checking in for', depart: 'Ready for departure for', recover: 'Request recovery following', contact: 'Contact reported for', coordinate: 'Request target coordination for', success: 'Objective complete:', failure: 'Unable to complete:' };
export function directMission(session: MissionSession, input: z.input<typeof directorSchema>) {
  const spec = directorSchema.parse(input), copy = copySession(session);
  const prefix = `Director:${spec.name}:`;
  if (luaArray(copy.mission.trigrules).some(t => String(t.comment).startsWith(prefix))) throw new Error('Director name is already in use');
  const channels = new Map(spec.channels.map(c => [c.id, c]));
  if (channels.size !== spec.channels.length) throw new Error('Duplicate channel ids');
  for (const a of spec.channels) for (const b of spec.channels) if (a !== b && a.callsign === b.callsign && a.speaker !== b.speaker) throw new Error('Callsign is assigned to different speakers');
  const events = new Map(spec.events.map(e => [e.id, e]));
  if (events.size !== spec.events.length) throw new Error('Duplicate event ids');
  const flags = allocateFlags(copy.mission, spec.events.length * 2, spec);
  const eventFlags = Object.fromEntries(spec.events.map((e, i) => [e.id, flags[i]]));
  const done = new Set<string>(), active = new Set<string>();
  function visit(eventId: string) {
    const e = events.get(eventId); if (!e) throw new Error(`Unknown event dependency '${eventId}'`);
    if (active.has(eventId)) throw new Error('Cyclic director event dependencies');
    if (done.has(eventId)) return;
    active.add(eventId); if (e.when.afterEvent) visit(e.when.afterEvent); active.delete(eventId); done.add(eventId);
  }
  spec.events.forEach(e => visit(e.id));
  const warnings: string[] = [], radioScript = [], timeline = [], shotList = [];
  const bindings: string[] = [];
  spec.events.forEach((event, index) => {
    const binding = event.when.worldEvent; if (!binding) return;
    if (!findUnit(copy.mission, binding.unit)) throw new Error(`Unknown world-event unit '${binding.unit}'`);
    bindings.push(`if event.id == world.event.S_EVENT_${binding.kind.toUpperCase()} and event.initiator and event.initiator:getName() == ${quoteLuaString(binding.unit)} then trigger.action.setUserFlag(${flags[spec.events.length + index]}, 1) end`);
  });
  if (bindings.length) addTrigger(copy.mission, { type: 'start', comment: `${prefix}world-bindings`, conditions: [], actions: [{ kind: 'do_script', text:
    `world.addEventHandler({ onEvent = function(self, event) local ok, err = pcall(function()\n${bindings.join('\n')}\nend) if not ok then env.error('[DCSMCP] director event error: ' .. tostring(err)) end end })` }] }, copy.dictionary);
  for (const e of spec.events) {
    const channel = channels.get(e.channel); if (!channel) throw new Error(`Unknown channel '${e.channel}'`);
    if (!e.text && !e.template) throw new Error(`Event '${e.id}' requires text or a dialogue template`);
    if (!e.when.conditions.length && !e.when.afterEvent && !e.when.worldEvent && e.when.atSeconds === undefined) throw new Error(`Event '${e.id}' needs an actual condition, dependency, or explicit mission time`);
    if (e.when.delaySeconds && !e.when.afterEvent) throw new Error('delaySeconds is relative to afterEvent; use atSeconds for mission time');
    const conditions: ConditionSpec[] = [...e.when.conditions] as ConditionSpec[];
    if (e.when.worldEvent) conditions.push({ kind: 'flag_is_true', flag: flags[spec.events.length + spec.events.indexOf(e)] });
    if (e.when.afterEvent) {
      conditions.push({ kind: 'flag_is_true', flag: eventFlags[e.when.afterEvent] });
      if (e.when.delaySeconds) conditions.push({ kind: 'time_since_flag', flag: eventFlags[e.when.afterEvent], seconds: e.when.delaySeconds });
    }
    if (e.when.atSeconds !== undefined) conditions.push({ kind: 'time_after', seconds: e.when.atSeconds });
    const content = e.text ?? `${channel.callsign}, ${channel.style === 'nato' ? 'this is ' : ''}${channel.speaker}. ${templates[e.template!]} ${e.subject}.`;
    const effects = e.effects as ActionSpec[];
    checkActionResources(copy, effects);
    for (const action of effects) if (action.kind === 'activate_group' && !findGroup(copy.mission, action.group)?.group.lateActivation) throw new Error(`Reinforcement '${action.group}' must exist with lateActivation=true`);
    const actions: ActionSpec[] = [{ kind: 'message_to_coalition', coalition: e.audience, text: `${channel.callsign}: ${content}`, seconds: e.seconds }, ...effects];
    let audioStatus = 'not requested';
    if (e.delivery !== 'subtitle') {
      if (!e.audioResourceKey) { audioStatus = 'PLACEHOLDER: record and embed audio; subtitle only'; warnings.push(`${e.id}: no audio file; no sound/radio transmission authored`); }
      else {
        const asset = listAssets(copy).find(a => a.keys.includes(e.audioResourceKey!));
        if (!asset || !/\.(ogg|wav)$/i.test(asset.path)) throw new Error('Audio key must reference an embedded WAV/OGG asset');
        if (e.delivery === 'radio') {
          if (!e.transmitterZone) throw new Error('Radio audio requires transmitterZone');
          actions.push({ kind: 'radio_transmission', resourceKey: e.audioResourceKey, zone: e.transmitterZone, frequencyMHz: channel.frequencyMHz, name: `${spec.name}-${e.id}`, power: 100, loop: false });
          warnings.push(`${e.id}: frequency radio audio is not coalition-isolated; subtitle audience is separate`);
        } else actions.push({ kind: 'sound_to_coalition', coalition: e.audience, resourceKey: e.audioResourceKey });
        audioStatus = 'audio action configured; decoding/playback unverified';
      }
    } else if (e.audioResourceKey) throw new Error('An audio key with subtitle-only delivery would be unused');
    actions.push({ kind: 'set_flag', flag: eventFlags[e.id], value: 1 });
    const triggerIndex = addTrigger(copy.mission, { type: 'once', comment: `${prefix}${e.id}`, conditions, actions }, copy.dictionary);
    radioScript.push({ event: e.id, speaker: channel.speaker, callsign: channel.callsign, frequencyMHz: channel.frequencyMHz, text: content,
      procedureStatus: e.procedureSource ? 'user-sourced dialogue; source not independently verified' : `fictional ${channel.style}-style cinematic dialogue, not authenticated procedure`,
      source: e.procedureSource ?? null, audioStatus, deliveryNotes: e.deliveryNotes, triggerIndex, flag: eventFlags[e.id] });
    timeline.push({ event: e.id, phase: e.phase, conditions, afterEvent: e.when.afterEvent ?? null, delaySeconds: e.when.delaySeconds, atSeconds: e.when.atSeconds ?? null,
      worldEvent: e.when.worldEvent ?? null, timingBasis: 'dependency delay starts when the preceding trigger fires, not when its audio finishes' });
    shotList.push({ event: e.id, cueFlag: eventFlags[e.id], shot: e.shot ?? `Capture ${e.phase} with player/target establishing view and radio subtitles`,
      notes: 'Recording suggestion only; no camera control or rendered footage generated' });
  }
  const report = { name: spec.name, channels: spec.channels, radioScript, timeline, shotList,
    highlights: spec.events.filter(e => ['engagement', 'escalation', 'victory', 'branch'].includes(e.phase)).map(e => ({ event: e.id, suggestedSeconds: 30, note: 'Suggested edit around the actual event cue; not a recorded highlight' })),
    eventFlags, warnings, dependencies: ['Existing oracle-backed trigger compiler', 'Recorded audio is optional; no TTS/API subscription'], verification: 'offline and mocked runtime only; no DCS run' };
  if (spec.embedReport) embedAsset(copy, 'media', `director-${spec.name}.json`, Buffer.from(JSON.stringify(report, null, 2)));
  commitSession(session, copy);
  return report;
}
