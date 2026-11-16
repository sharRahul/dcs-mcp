/** Deterministic, independently validated mission generation. No AI API dependency. */
import { z } from 'zod';
import { configurationSchema, configureMission, sideSchema, xySchema } from '../miz/configuration.js';
import { actionSchema, conditionSchema, triggerSchema } from '../miz/trigger-schema.js';
import { addAircraftGroup, addGroundGroup, addTrigger, addTriggerZone, addWaypoint, findGroup, findUnit, setPayload, type AircraftStart, type ConditionSpec, type ActionSpec } from '../miz/authoring.js';
import { configureFlight, createFlight, flyingReference, orbitSchema, ROLES, appendWaypointTask } from '../miz/flight.js';
import { findSiteTemplate } from '../miz/templates.js';
import { addFarp } from '../miz/dressing.js';
import { newSession, closeSession, refresh, type MissionSession } from '../miz/sessions.js';
import { findCountry, findUnitType, resolveTheatreName } from '../data/reference.js';
import { addGoal, allocateFlags } from '../miz/scoring.js';
import { checkActionResources, directMission, directorSchema } from '../miz/director.js';
import { embedAsset, listAssets } from '../miz/assets.js';
import { validateMission } from '../miz/validator.js';
import { luaArray, asTable } from '../miz/lua.js';
const name = z.string().regex(/^[A-Za-z][A-Za-z0-9 _-]{0,63}$/);
export const aircraftStartSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('air') }).strict(),
  z.object({ kind: z.literal('runway'), airfield: z.union([z.string().min(1), z.number().int().positive()]) }).strict(),
  z.object({ kind: z.enum(['parking_cold', 'parking_hot']), airfield: z.union([z.string().min(1), z.number().int().positive()]), parking: z.array(z.string().min(1)).max(4).optional() }).strict(),
  z.object({ kind: z.enum(['ship_cold', 'ship_hot']), ship: z.string().min(1) }).strict(),
  z.object({ kind: z.enum(['farp_cold', 'farp_hot']), farp: z.string().min(1) }).strict(),
]);
const forceSchema = z.object({ name, side: sideSchema, country: z.string().min(1), category: z.enum(['plane', 'helicopter', 'vehicle', 'ship', 'farp']), type: z.string().min(1),
  count: z.number().int().min(1).max(50).default(1),
  composition: z.array(z.object({ type: z.string().min(1), count: z.number().int().min(1).max(50) }).strict()).min(1).max(50).optional(),
  site: z.string().min(1).optional(), spacingMetres: z.number().positive().max(2000).optional(), position: xySchema, heading: z.number().min(0).max(359).default(0),
  role: z.enum([...ROLES, 'naval_strike']).optional(), targetGroup: name.optional(), start: aircraftStartSchema.optional(), orbit: orbitSchema.optional(),
  route: z.array(z.object({ ...xySchema.shape, altitudeMetres: z.number().min(0).max(20000).optional(), speedMps: z.number().min(0).max(1000).optional() }).strict()).max(100).default([]),
  skill: z.enum(['Average', 'Good', 'High', 'Excellent', 'Random']).optional(), lateActivation: z.boolean().default(false), frequencyMHz: z.number().positive().max(400).optional(),
  payload: z.object({ fuel: z.number().finite().nonnegative().optional(), pylons: z.array(z.object({ pylon: z.number().int().positive(), CLSID: z.string().min(1) }).strict()).max(40).optional() }).strict().optional(),
  jitterMetres: z.number().min(0).max(10000).default(0),
}).strict();
export const scenarioSchema = z.object({ version: z.literal(1).default(1), name,
  kind: z.enum(['interception', 'defensive_counter_air', 'offensive_counter_air', 'sead', 'dead', 'cas', 'strike', 'csar', 'convoy_escort', 'naval_strike', 'carrier_operations']),
  theatre: z.string().min(1), seed: z.number().int().min(0).max(4294967295).default(0),
  coalitions: z.object({ blue: z.array(z.string().min(1)).min(1).max(50), red: z.array(z.string().min(1)).min(1).max(50), neutrals: z.array(z.string().min(1)).max(50).default([]) }).strict(),
  player: z.object({ group: name, slot: z.enum(['Player', 'Client']).default('Player') }).strict(),
  objective: z.string().min(1).max(10000), threatLevel: z.enum(['none', 'low', 'medium', 'high']).default('medium'), difficulty: z.enum(['easy', 'normal', 'hard']).default('normal'),
  durationSeconds: z.number().int().min(60).max(86400).default(1800), configuration: configurationSchema.optional(),
  forces: z.array(forceSchema).min(1).max(200), requiredSupport: z.array(name).max(20).default([]),
  zones: z.array(z.object({ name, ...xySchema.shape, radius: z.number().positive().max(500000) }).strict()).max(100).default([]),
  assets: z.array(z.object({ id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/), kind: z.enum(['audio', 'briefing_image', 'kneeboard', 'script', 'media']),
    fileName: z.string().min(1), contentBase64: z.string().min(4).max(8 * 1024 * 1024).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
    side: sideSchema.default('blue'), aircraft: z.string().optional(),
  }).strict()).max(32).default([]),
  events: z.array(triggerSchema).max(200).default([]),
  victory: z.array(conditionSchema).min(1).max(50), failure: z.array(conditionSchema).max(50).default([]),
  endOnOutcome: z.boolean().default(false), director: directorSchema.optional(), assumptions: z.array(z.string().max(2000)).max(100).default([]),
}).strict();
export type ScenarioInput = z.input<typeof scenarioSchema>;
function generator(seed: number) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}
function outcomes(s: MissionSession, spec: z.infer<typeof scenarioSchema>) {
  const [victoryCandidate, failureCandidate, pendingFlag, outcomeFlag] = allocateFlags(s.mission, 4, spec);
  // A public timer callback resolves simultaneous candidate events after one second,
  // independent of DCS's undefined iteration order for compiled triggers.
  const schedule = `if tonumber(trigger.misc.getUserFlag(${pendingFlag})) == 0 then
  trigger.action.setUserFlag(${pendingFlag}, 1)
  timer.scheduleFunction(function()
    if tonumber(trigger.misc.getUserFlag(${outcomeFlag})) == 0 then
      if tonumber(trigger.misc.getUserFlag(${failureCandidate})) ~= 0 then trigger.action.setUserFlag(${outcomeFlag}, 2)
      elseif tonumber(trigger.misc.getUserFlag(${victoryCandidate})) ~= 0 then trigger.action.setUserFlag(${outcomeFlag}, 1) end
    end
    return nil
  end, nil, timer.getTime() + 1)
end`;
  const candidate = (comment: string, conditions: ConditionSpec[], flag: number) => addTrigger(s.mission, { type: 'once', comment,
    conditions: [...conditions, { kind: 'flag_equals', flag: outcomeFlag, value: 0 }],
    actions: [{ kind: 'set_flag', flag, value: 1 }, { kind: 'do_script', text: schedule }] }, s.dictionary);
  candidate('Scenario victory candidate', spec.victory as ConditionSpec[], victoryCandidate);
  if (spec.failure.length) candidate('Scenario failure candidate', spec.failure as ConditionSpec[], failureCandidate);
  // The requested mission duration is an actual time limit, not report-only metadata.
  candidate('Scenario time limit', [{ kind: 'time_after', seconds: spec.durationSeconds }], failureCandidate);
  const player = findGroup(s.mission, spec.player.group)!;
  for (const [value, title] of [[1, 'Victory'], [2, 'Failure']] as const) {
    const conditions: ConditionSpec[] = [{ kind: 'flag_equals', flag: outcomeFlag, value }];
    const actions: ActionSpec[] = [{ kind: 'message_to_coalition', coalition: player.side, text: `${title}: ${spec.objective}`, seconds: 30 }];
    if (spec.endOnOutcome) actions.push({ kind: 'end_mission', winner: value === 1 ? player.side : player.side === 'blue' ? 'red' : 'blue', delaySeconds: 15 });
    addTrigger(s.mission, { type: 'once', comment: `Scenario ${title}`, conditions, actions }, s.dictionary);
    addGoal(s.mission, { side: player.side as 'blue' | 'red', comment: `Scenario ${title}`, score: value === 1 ? 100 : 0, conditions });
  }
  return { outcomeFlag, victoryCandidate, failureCandidate, pendingFlag, values: { unresolved: 0, victory: 1, failure: 2 },
    rule: 'First outcome candidates adjudicated one second later; failure wins within that window. Later outcomes do not overwrite a resolved result.' };
}
export function validateScenario(input: unknown) {
  const spec = scenarioSchema.parse(input), theatre = resolveTheatreName(spec.theatre);
  if (!theatre) throw new Error('Unknown scenario theatre');
  spec.theatre = theatre;
  if (spec.configuration?.theatre && resolveTheatreName(spec.configuration.theatre) !== theatre) throw new Error('Scenario/configuration theatres conflict');
  if (spec.configuration?.countries) throw new Error('Use scenario.coalitions as the single country assignment source');
  const assigned = new Map<number, string>();
  for (const side of ['blue', 'red', 'neutrals'] as const) for (const countryName of spec.coalitions[side]) {
    const country = findCountry(countryName); if (!country) throw new Error(`Unknown country '${countryName}'`);
    if (assigned.has(country.id)) throw new Error(`Duplicate country assignment '${countryName}'`); assigned.set(country.id, side);
  }
  const names = new Set<string>(); let totalUnits = 0;
  for (const f of spec.forces) {
    if (names.has(f.name)) throw new Error(`Duplicate force '${f.name}'`); names.add(f.name);
    if (assigned.get(findCountry(f.country)?.id ?? -1) !== f.side) throw new Error(`Force '${f.name}' country/coalition is undeclared or inconsistent`);
    if (f.site && (f.category !== 'vehicle' || f.composition)) throw new Error('SAM/EWR site templates require a vehicle force and cannot be combined with composition');
    const composition = f.site ? findSiteTemplate(f.site).composition : f.composition;
    if (composition) {
      if (!['vehicle', 'ship'].includes(f.category) || f.type !== composition[0].type) throw new Error('Mixed surface force must name the first composition type as its lead type');
      if (composition.some(c => findUnitType(c.type)?.category !== f.category)) throw new Error('Mixed force type/category mismatch');
      const count = composition.reduce((n, c) => n + c.count, 0); if (count > 100) throw new Error('Mixed force exceeds 100 units'); totalUnits += count;
    } else totalUnits += f.count;
    if (totalUnits > 5000) throw new Error('Scenario exceeds 5000 units');
    const ref = findUnitType(f.type);
    if (f.category !== 'farp' && ref?.category !== f.category) throw new Error(`Force '${f.name}' type/category is not in the reference catalogue`);
    if (['plane', 'helicopter'].includes(f.category)) {
      if (!f.role) throw new Error(`Aircraft '${f.name}' requires a role`);
      if (f.count > 4) throw new Error('Aircraft flights support at most four units');
    } else if (f.role || f.orbit || f.start || f.payload || f.frequencyMHz || f.targetGroup) throw new Error('Aircraft settings supplied to a surface force');
    if (f.category === 'farp' && (f.count !== 1 || !['FARP', 'SINGLE_HELIPAD', 'Invisible FARP'].includes(f.type))) throw new Error('FARP force must declare one supported pad type');
    if (f.category === 'farp' && f.route.length) throw new Error('FARPs cannot have movement routes');
  }
  const player = spec.forces.find(f => f.name === spec.player.group);
  if (!player || !['plane', 'helicopter'].includes(player.category) || player.side === 'neutrals' || player.lateActivation) throw new Error('Player must be an active non-neutral aircraft force');
  const enemyAircraft = spec.forces.filter(f => f.side !== player.side && f.side !== 'neutrals' && ['plane', 'helicopter'].includes(f.category));
  const roleRequirements: Partial<Record<typeof spec.kind, string[]>> = {
    interception: ['interception'], defensive_counter_air: ['CAP', 'BARCAP', 'TARCAP'], offensive_counter_air: ['CAP', 'strike', 'interception'],
    sead: ['SEAD'], dead: ['DEAD'], cas: ['CAS'], strike: ['strike'], naval_strike: ['naval_strike'], csar: ['transport'],
  };
  if (roleRequirements[spec.kind] && !roleRequirements[spec.kind]!.includes(player.role!)) throw new Error(`Player role does not match '${spec.kind}' scenario`);
  if (['interception', 'defensive_counter_air', 'offensive_counter_air'].includes(spec.kind) && !enemyAircraft.length) throw new Error('Air-to-air scenario needs an opposing aircraft force');
  if (spec.kind === 'interception' && !spec.forces.some(f => f.name === player.targetGroup && ['plane', 'helicopter'].includes(f.category) && f.side !== player.side && f.side !== 'neutrals')) throw new Error('Interception target must be an opposing aircraft group');
  if (spec.kind === 'csar' && player.category !== 'helicopter') throw new Error('CSAR scenario supports helicopter/zone/flag objectives only');
  if (spec.kind === 'carrier_operations' && !player.start?.kind.startsWith('ship_')) throw new Error('Carrier scenario requires a ship-linked player start');
  if (spec.kind === 'naval_strike' && !spec.forces.some(f => f.name === player.targetGroup && f.category === 'ship' && f.side !== player.side)) throw new Error('Naval strike requires an opposing ship target');
  if (spec.kind === 'convoy_escort' && !spec.forces.some(f => f.category === 'vehicle' && f.side === player.side && f.route.length)) throw new Error('Convoy escort requires a moving friendly vehicle force');
  if (spec.threatLevel === 'none' && spec.forces.some(f => f.side !== player.side && (findUnitType(f.type)?.entry as { group?: string })?.group === 'AirDefence')) throw new Error('Threat level none conflicts with declared enemy air defence');
  for (const support of spec.requiredSupport) if (!spec.forces.some(f => f.name === support && f.side === player.side && ['AWACS', 'tanker'].includes(f.role ?? '') && !f.lateActivation)) throw new Error(`Required support '${support}' is not an active friendly AWACS/tanker`);
  if (new Set(spec.zones.map(z => z.name)).size !== spec.zones.length) throw new Error('Duplicate scenario zone names');
  if (spec.victory.some(c => c.kind === 'time_after' && c.seconds >= spec.durationSeconds)) throw new Error('Victory time is not before the enforced mission time limit');
  return spec;
}
export function generateScenario(input: unknown) {
  const spec = validateScenario(input), s = newSession(spec.theatre, spec.configuration?.startTime ?? 43200), random = generator(spec.seed);
  try {
    configureMission(s.mission, { ...spec.configuration, theatre: spec.theatre, title: spec.name, briefing: spec.objective,
      countries: (['blue', 'red', 'neutrals'] as const).flatMap(side => spec.coalitions[side].map(name => ({ name, side }))) });
    const pending = [...spec.forces], positions: Record<string, { x: number; y: number }> = {};
    // Consume randomness in declaration order, independent of target dependency ordering.
    for (const force of spec.forces) positions[force.name] = { x: force.position.x + (random() - .5) * 2 * force.jitterMetres, y: force.position.y + (random() - .5) * 2 * force.jitterMetres };
    const warnings = ['All placements are unverified against terrain unless independently checked with real terrain data', 'Threat level is an author declaration, not an authoritative difficulty or sensor model'];
    while (pending.length) {
      let progress = false;
      for (const force of [...pending]) {
        const start = force.start;
        if (force.targetGroup && !findGroup(s.mission, force.targetGroup)) continue;
        if (start && 'ship' in start && !findUnit(s.mission, start.ship)) continue;
        if (start && 'farp' in start && !findUnit(s.mission, start.farp)) continue;
        const args = { side: force.side, country: force.country, name: force.name, type: force.type, count: force.count, ...positions[force.name], heading: force.heading,
          skill: force.skill ?? ({ easy: 'Average', normal: 'Good', hard: 'Excellent' } as const)[spec.difficulty], start: force.start as AircraftStart | undefined };
        if (force.category === 'farp') addFarp(s.mission, { ...args, kind: force.type === 'Invisible FARP' ? 'INVISIBLE' : force.type as 'FARP' | 'SINGLE_HELIPAD' });
        else if (force.category === 'plane' || force.category === 'helicopter') {
          const skills = Array.from({ length: force.count }, (_, i) => force.name === spec.player.group && i === 0 ? spec.player.slot : args.skill);
          if (force.role === 'naval_strike') {
            if (!flyingReference(force.type).tasks.includes('Antiship Strike')) throw new Error('Aircraft does not support Antiship Strike');
            addAircraftGroup(s.mission, force.category, { ...args, task: 'Antiship Strike' });
            configureFlight(s.mission, force.name, { skills, frequencyMHz: force.frequencyMHz });
            if (!force.targetGroup) throw new Error('Naval strike flight requires targetGroup');
            appendWaypointTask(s.mission, force.name, 1, { kind: 'attack_group', group: force.targetGroup });
          } else {
            const result = createFlight(s.mission, { ...args, category: force.category, role: force.role as typeof ROLES[number], targetGroup: force.targetGroup, orbit: force.orbit,
              config: { skills, frequencyMHz: force.frequencyMHz } }); warnings.push(...result.warnings);
          }
          if (force.payload) for (let i = 1; i <= force.count; i++) setPayload(s.mission, `${force.name}-${i}`, force.payload);
        } else {
          const template = force.site ? findSiteTemplate(force.site) : undefined;
          addGroundGroup(s.mission, force.category, { ...args, composition: template?.composition ?? force.composition, spacingMetres: force.spacingMetres ?? template?.spacingMetres });
          if (template) warnings.push(`${force.name}: site ${template.id} provenance ${template.provenance}; no provenance promoted by generation`);
        }
        const group = findGroup(s.mission, force.name)!.group; group.lateActivation = force.lateActivation;
        for (const point of force.route) addWaypoint(s.mission, force.name, point);
        pending.splice(pending.indexOf(force), 1); progress = true;
      }
      if (!progress) throw new Error(`Unresolved/cyclic force targets or start dependencies: ${pending.map(f => f.name).join(', ')}`);
    }
    for (const zone of spec.zones) addTriggerZone(s.mission, zone);
    const assetKeys: Record<string, string> = {}; let assetBytes = 0;
    for (const asset of spec.assets) {
      if (Object.prototype.hasOwnProperty.call(assetKeys, asset.id)) throw new Error('Duplicate scenario asset id');
      const bytes = Buffer.from(asset.contentBase64, 'base64');
      if (bytes.toString('base64') !== asset.contentBase64) throw new Error('Asset content is not canonical base64');
      assetBytes += bytes.length; if (assetBytes > 32 * 1024 * 1024) throw new Error('Scenario assets exceed 32 MiB');
      const embedded = embedAsset(s, asset.kind, asset.fileName, bytes, asset.side, asset.aircraft);
      assetKeys[asset.id] = embedded.resourceKey ?? embedded.path;
    }
    const resourceKey = (key: string) => {
      if (!key.startsWith('asset:')) return key;
      const resolved = assetKeys[key.slice(6)]; if (!resolved || resolved.startsWith('KNEEBOARD/')) throw new Error(`Unknown or non-resource asset reference '${key}'`);
      return resolved;
    };
    for (const event of spec.events) {
      const actions = (event.actions as ActionSpec[]).map(a => 'resourceKey' in a ? { ...a, resourceKey: resourceKey(a.resourceKey) } : a);
      checkActionResources(s, actions); addTrigger(s.mission, { ...event, conditions: event.conditions as ConditionSpec[], actions }, s.dictionary);
    }
    for (const force of spec.forces) if (['plane', 'helicopter'].includes(force.category) && !['AWACS', 'tanker', 'transport', 'reconnaissance'].includes(force.role ?? '') && !force.payload?.pylons?.length) warnings.push(`${force.name}: no pylon stores supplied; loadout selection is required before combat testing`);
    const outcome = outcomes(s, spec);
    const directorSpec = spec.director ? { ...spec.director, events: spec.director.events.map(event => ({ ...event,
      audioResourceKey: event.audioResourceKey ? resourceKey(event.audioResourceKey) : undefined,
      effects: (event.effects as ActionSpec[]).map(a => 'resourceKey' in a ? { ...a, resourceKey: resourceKey(a.resourceKey) } : a),
    })) } : undefined;
    const director = directorSpec ? directMission(s, directorSpec) : null;
    if (spec.kind === 'csar') warnings.push('CSAR is a zone/flag rescue objective; no automatic personnel pickup, cargo or rescue framework is claimed');
    if (spec.kind === 'carrier_operations') warnings.push('Carrier departure linking only; moving-deck recovery and aircraft/deck compatibility remain unverified');
    refresh(s); const validation = validateMission(s.document, s.mission);
    if (!validation.ok) throw new Error(`Generated mission failed validation: ${validation.errors.map(e => e.message).join('; ')}`);
    const report = { name: spec.name, kind: spec.kind, seed: spec.seed, theatre: spec.theatre, objective: spec.objective,
      threatLevel: spec.threatLevel, difficulty: spec.difficulty, durationSeconds: spec.durationSeconds, player: spec.player,
      coalitions: spec.coalitions, forces: s.document.groups.map(g => ({ ...g, frequencyMHz: findGroup(s.mission, g.name)?.group.frequency ?? null, route: findGroup(s.mission, g.name)?.group.route })),
      assets: listAssets(s), assetKeys, triggers: s.document.triggers, outcome, requiredSupport: spec.requiredSupport,
      dependencies: ['DCS catalogue aircraft and task identifiers', ...(spec.director ? ['Optional recorded dialogue audio'] : [])],
      assumptions: spec.assumptions, warnings: [...new Set([...warnings, ...validation.warnings.map(w => w.message)])], validation, director,
      verification: 'Deterministic offline generation and validation only; no Mission Editor or DCS run' };
    embedAsset(s, 'media', 'scenario-specification.json', Buffer.from(JSON.stringify(spec, null, 2)));
    embedAsset(s, 'media', 'scenario-report.json', Buffer.from(JSON.stringify(report, null, 2)));
    refresh(s); return { session: s, specification: spec, report };
  } catch (error) { closeSession(s.id); throw error; }
}
export const campaignSchema = z.object({ name, stages: z.array(scenarioSchema).min(2).max(20), transitions: z.array(z.object({ from: name, to: name, on: z.enum(['victory', 'failure']) }).strict()).min(1).max(100) }).strict();
export function generateCampaign(input: unknown) {
  const a = campaignSchema.parse(input), names = new Set(a.stages.map(s => s.name));
  if (names.size !== a.stages.length) throw new Error('Campaign stage names must be unique');
  const edges = new Set<string>();
  for (const t of a.transitions) {
    if (!names.has(t.from) || !names.has(t.to)) throw new Error('Unknown campaign transition endpoint');
    const key = `${t.from}:${t.on}`; if (edges.has(key)) throw new Error('Ambiguous campaign outcome transition'); edges.add(key);
  }
  const active = new Set<string>(), done = new Set<string>();
  function visit(name: string) { if (active.has(name)) throw new Error('Cyclic campaign stage dependencies'); if (done.has(name)) return;
    active.add(name); for (const t of a.transitions.filter(t => t.from === name)) visit(t.to); active.delete(name); done.add(name); }
  a.stages.forEach(s => visit(s.name));
  const roots = a.stages.filter(s => !a.transitions.some(t => t.to === s.name));
  if (roots.length !== 1 || roots[0].name !== a.stages[0].name) throw new Error('Campaign must have one entry stage, declared first');
  const reached = new Set<string>();
  function reach(name: string) { if (reached.has(name)) return; reached.add(name); for (const t of a.transitions.filter(t => t.from === name)) reach(t.to); }
  reach(roots[0].name); if (reached.size !== names.size) throw new Error('Unreachable campaign stages');
  const stages: ReturnType<typeof generateScenario>[] = [];
  try { for (const spec of a.stages) stages.push(generateScenario(spec)); }
  catch (error) { for (const stage of stages) closeSession(stage.session.id); throw error; }
  return { name: a.name, stages, transitions: a.transitions,
    limitation: 'Validated mission-stage manifest; save each session separately and select next stage from its outcome. No .cmp file or automatic cross-mission persistence is authored.' };
}
