/**
 * Scripted ATC for one player/client flight, start to finish, in place of DCS's own
 * ATC: briefing, ground/tower departure (startup, taxi, takeoff), airborne handoff,
 * AWACS check-in with the next action, and - when the flight has a landing airfield -
 * the arrival (inbound to approach, landing clearance, taxi to parking).
 *
 * DCS's own ATC is silenced at every airfield this script speaks for
 * (`a_set_ATC_silent_mode`, oracle-backed), so the player hears one controller, not
 * two talking over each other. Whether silent mode also mutes the airfield for AI
 * traffic is not verified: the action is written exactly as the editor writes it.
 *
 * The player drives each exchange from the F10 menu because DCS has no oracle-backed
 * predicate for "engines running" or "on the taxiway", and the bundled data has no
 * taxiway or threshold coordinates (pydcs stores runway designators only). What CAN
 * be detected is detected: airborne via `c_unit_altitude_higher_AGL`, arrival via
 * zones around the landing airfield (`c_unit_in_zone`). Every predicate used is
 * already in the oracle-backed compiler.
 *
 * Dialogue is FICTIONAL brevity-style phrasing, not authenticated procedure. Frequencies
 * come from pydcs (`data/airfield-radio.json`); a runway the caller does not pass is the
 * first designator pydcs lists - wind is not read. Nothing here has been flown yet.
 */
import { z } from 'zod';
import { addTrigger, addTriggerZone, findGroup, type ActionSpec, type ConditionSpec } from './authoring.js';
import { asTable, luaArray, type LuaTable } from './lua.js';
import { allocateFlags } from './scoring.js';
import { airfieldRadio } from '../data/airfield-radio.js';
import { findAirport } from '../data/reference.js';

const name = z.string().min(1).max(200);
export const ATC_AUDIO_STEPS = ['briefing', 'startupRequest', 'startupReply', 'taxiRequest', 'taxiReply', 'takeoffRequest', 'takeoffReply',
  'departureCall', 'departureReply', 'awacsCheckIn', 'awacsReply', 'inboundCall', 'inboundReply', 'landingRequest', 'landingReply',
  'clearOfRunway', 'taxiToParking'] as const;
export type AtcAudioStep = typeof ATC_AUDIO_STEPS[number];

const airfieldRef = z.union([z.string().min(1), z.number().int().positive()]);

export const atcSchema = z.object({
  /** Radio callsign spoken for the flight, e.g. "Viper 1-1". Defaults to the lead unit's callsign. */
  callsign: z.string().min(1).max(60).optional(),
  /** Briefing shown (and played, with audio.briefing) one second into the mission. */
  briefing: z.string().min(1).max(100000).optional(),
  /** Departure exchange. Used whenever route point 1 is at an airfield; ignored for an air start. */
  departure: z.object({
    runway: z.string().min(1).max(10).optional(),
    towerName: z.string().min(1).max(60).optional(),
    groundName: z.string().min(1).max(60).optional(),
    /** Read back after takeoff, e.g. "climb runway heading to 5000, turn left 090". */
    instruction: z.string().min(1).max(500).optional(),
    /** A zone already in the mission: entering it prompts the tower call. */
    holdShortZone: name.optional(),
  }).strict().default({}),
  awacs: z.object({
    callsign: z.string().min(1).max(60).default('Magic'),
    /** MHz. Defaults to the named AWACS group's frequency. */
    frequencyMHz: z.number().positive().max(400).optional(),
    group: name.optional(),
    /** What AWACS tells the flight to do next, e.g. "proceed to CAP point Alpha, angels 25, picture clean". */
    tasking: z.string().min(1).max(1000),
  }).strict().optional(),
  /** Arrival exchange. Defaults to the airfield of the flight's Landing waypoint (dcs_miz_add_airfield_landing). */
  arrival: z.object({
    airfield: airfieldRef.optional(),
    runway: z.string().min(1).max(10).optional(),
    approachName: z.string().min(1).max(60).optional(),
    towerName: z.string().min(1).max(60).optional(),
    groundName: z.string().min(1).max(60).optional(),
    /** Entering this radius around the airfield prompts the inbound call. */
    inboundKm: z.number().positive().max(200).default(40),
    /** Entering this radius prompts the landing request. */
    finalKm: z.number().positive().max(50).default(12),
  }).strict().optional(),
  /** Silence DCS's own ATC at the departure and arrival airfields. */
  silenceDcsAtc: z.boolean().default(true),
  /** Height above ground at which the airborne handoff fires. */
  departureAGLMetres: z.number().positive().max(5000).default(300),
  /** Resource keys (dcs_audio_convert + dcs_miz_embed_asset) played to the group with each line. */
  audio: z.partialRecord(z.enum(ATC_AUDIO_STEPS), name).optional(),
  /** Seconds between a pilot call and the controller's reply. */
  replyDelaySeconds: z.number().int().min(0).max(30).default(4),
  messageSeconds: z.number().int().positive().max(120).default(12),
}).strict();

export interface AtcResult {
  group: string;
  departure?: { airfield: string; runway: string; atc: string };
  arrival?: { airfield: string; runway: string; atc: string; zones: string[] };
  awacs?: string;
  silenced: string[];
  flags: Record<string, number>;
  triggers: number[];
  notes: string[];
}

const COMMENT = (group: string) => `ATC ${group}:`;

function fmt(mhz: number | undefined) { return mhz === undefined ? undefined : mhz.toFixed(mhz * 1000 % 10 ? 3 : 2).replace(/0$/, ''); }

function atcFreq(theatre: string, airdromeId: number) {
  const radio = airfieldRadio(theatre, airdromeId);
  const parts = [fmt(radio.atcMHz?.uhf) && `${fmt(radio.atcMHz?.uhf)} UHF`, fmt(radio.atcMHz?.vhfHigh) && `${fmt(radio.atcMHz?.vhfHigh)} VHF`].filter(Boolean);
  return { radio, atc: parts.join(' / ') || 'frequency unknown' };
}

/** The airfield of the last Landing waypoint, if any. */
function landingAirdrome(points: LuaTable[]): number | undefined {
  for (let i = points.length - 1; i > 0; i--) {
    const id = Number(points[i]?.airdromeId);
    if (points[i]?.action === 'Landing' && Number.isInteger(id) && id > 0) return id;
  }
  return undefined;
}

/**
 * Write the ATC script for `group`. Atomic: on any error the mission's triggers, zones,
 * dictionary counter and dictionary are restored. Refuses a second script for the same
 * group (remove its "ATC <group>:" triggers first).
 */
export function addFlightAtc(mission: LuaTable, groupName: string, input: z.input<typeof atcSchema>, dictionary?: LuaTable): AtcResult {
  const before = {
    trig: structuredClone(mission.trig), trigrules: structuredClone(mission.trigrules), triggers: structuredClone(mission.triggers),
    maxDictId: mission.maxDictId, dictionary: dictionary ? structuredClone(dictionary) : undefined,
  };
  try {
    return writeAtc(mission, groupName, atcSchema.parse(input), dictionary);
  } catch (e) {
    for (const k of ['trig', 'trigrules', 'triggers', 'maxDictId'] as const) {
      if (before[k] === undefined) delete mission[k]; else mission[k] = before[k] as never;
    }
    if (dictionary && before.dictionary) { for (const k of Object.keys(dictionary)) delete dictionary[k]; Object.assign(dictionary, before.dictionary); }
    throw e;
  }
}

function writeAtc(mission: LuaTable, g: string, spec: z.output<typeof atcSchema>, dictionary?: LuaTable): AtcResult {
  const found = findGroup(mission, g);
  if (!found || (found.category !== 'plane' && found.category !== 'helicopter')) throw new Error(`No aircraft group named '${g}' in this mission`);
  if (luaArray(asTable(mission.trigrules)).some(r => String(r.comment ?? '').startsWith(COMMENT(g)))) {
    throw new Error(`'${g}' already has an ATC script: remove its '${COMMENT(g)}' triggers (dcs_miz_list_triggers / dcs_miz_remove_trigger) before writing a new one`);
  }
  const units = luaArray(asTable(found.group.units));
  const lead = units[0];
  if (!lead) throw new Error(`'${g}' has no units`);
  const leadName = String(lead.name);
  const points = luaArray(asTable(asTable(found.group.route)?.points));
  const theatre = String(mission.theatre ?? '');
  const notes: string[] = [];
  const depId = Number(points[0]?.airdromeId);
  const hasDeparture = Number.isInteger(depId) && depId > 0;
  const arrId = spec.arrival?.airfield !== undefined ? findAirport(theatre, spec.arrival.airfield).id : landingAirdrome(points);
  if (!hasDeparture && arrId === undefined && !spec.awacs) {
    throw new Error(`'${g}' neither starts at an airfield nor has a Landing waypoint, and no awacs was given: there is no exchange to script. Add dcs_miz_add_airfield_landing or pass arrival.airfield.`);
  }
  if (spec.departure.holdShortZone && !luaArray(asTable(asTable(mission.triggers)?.zones)).some(z => z.name === spec.departure.holdShortZone)) {
    throw new Error(`No trigger zone named '${spec.departure.holdShortZone}'`);
  }
  const leadCallsign = asTable(lead.callsign)?.name;
  const cs = spec.callsign ?? (typeof leadCallsign === 'string' ? leadCallsign.replace(/^(\D+)(\d)(\d)$/, '$1 $2-$3') : g);
  const pickRunway = (radio: ReturnType<typeof airfieldRadio>, given: string | undefined, what: string) => {
    const r = given ?? radio.runways[0]?.ends[0]?.name;
    if (!r) throw new Error(`No runway designator known for ${radio.name}; pass ${what}.runway`);
    if (!given) notes.push(`${what} runway ${r} is the first designator pydcs lists for ${radio.name}, not the runway in use for the mission wind: pass ${what}.runway to choose.`);
    return r;
  };

  let awacsLabel: string | undefined;
  if (spec.awacs) {
    let mhz = spec.awacs.frequencyMHz;
    if (spec.awacs.group) {
      const aw = findGroup(mission, spec.awacs.group);
      if (!aw) throw new Error(`No AWACS group named '${spec.awacs.group}'`);
      if (mhz === undefined && typeof aw.group.frequency === 'number') mhz = aw.group.frequency;
    }
    if (mhz === undefined) notes.push('No AWACS frequency given or found on the AWACS group: the handoff names no frequency.');
    awacsLabel = `${spec.awacs.callsign}${mhz === undefined ? '' : ` on ${fmt(mhz)}`}`;
  }

  const [fStartup, fTaxi, fTakeoff, fAirborne, fAwacs, fInbound, fLanding, fClear, fAway] = allocateFlags(mission, 9);
  const delay = spec.replyDelaySeconds, secs = spec.messageSeconds;
  const line = (text: string, step: AtcAudioStep, delaySeconds = 0): ActionSpec[] => {
    const out: ActionSpec[] = [{ kind: 'message_to_group', group: g, text, seconds: secs, ...(delaySeconds ? { delaySeconds } : {}) }];
    const key = spec.audio?.[step];
    if (key) out.push({ kind: 'sound_to_group', group: g, resourceKey: key, ...(delaySeconds ? { delaySeconds } : {}) });
    return out;
  };
  const item = (text: string, flag: number): ActionSpec => ({ kind: 'add_radio_item_for_group', group: g, text, flag, value: 1 });
  const drop = (text: string): ActionSpec => ({ kind: 'remove_radio_item_for_group', group: g, text });
  const triggers: number[] = [];
  const add = (step: string, conditions: ConditionSpec[], actions: ActionSpec[], type: 'once' | 'start' = 'once') =>
    triggers.push(addTrigger(mission, { type, comment: `${COMMENT(g)} ${step}`, conditions, actions }, dictionary));
  const result: AtcResult = { group: g, silenced: [], flags: {}, triggers, notes };

  const silence = [...new Set([hasDeparture ? depId : undefined, arrId].filter((id): id is number => id !== undefined))];
  if (spec.silenceDcsAtc && silence.length) {
    add('silence DCS ATC', [], silence.map(id => ({ kind: 'set_atc_silent_mode', airdromeId: id, silent: true } as ActionSpec)), 'start');
    result.silenced = silence.map(id => airfieldRadio(theatre, id).name);
  }

  const ITEM = { startup: 'ATC: Request startup', taxi: 'ATC: Request taxi', takeoff: 'ATC: Ready for departure',
    awacs: spec.awacs ? `AWACS: Check in with ${spec.awacs.callsign}` : '', inbound: 'ATC: Inbound for landing', landing: 'ATC: Request landing', clear: 'ATC: Clear of runway' };

  // --- Briefing and departure -------------------------------------------------------
  const openers: ActionSpec[] = [];
  let firstCall = '';
  if (hasDeparture) {
    const { radio, atc } = atcFreq(theatre, depId);
    const runway = pickRunway(radio, spec.departure.runway, 'departure');
    const tower = spec.departure.towerName ?? `${radio.name} Tower`;
    const ground = spec.departure.groundName ?? `${radio.name} Ground`;
    result.departure = { airfield: radio.name, runway, atc };
    firstCall = `When ready, call ${ground} from the F10 menu. ATC ${atc}.`;
    openers.push(item(ITEM.startup, fStartup));
    add('startup', [{ kind: 'flag_is_true', flag: fStartup }], [
      drop(ITEM.startup),
      ...line(`${cs}: ${ground}, ${cs}, flight of ${units.length}, request startup.`, 'startupRequest'),
      ...line(`${ground}: ${cs}, startup approved, runway ${runway}. Call for taxi when ready.`, 'startupReply', delay),
      item(ITEM.taxi, fTaxi),
    ]);
    add('taxi', [{ kind: 'flag_is_true', flag: fTaxi }], [
      drop(ITEM.taxi),
      ...line(`${cs}: ${ground}, ${cs}, ready to taxi.`, 'taxiRequest'),
      ...line(`${ground}: ${cs}, taxi to runway ${runway}, hold short. Contact ${tower} when ready.`, 'taxiReply', delay),
      item(ITEM.takeoff, fTakeoff),
    ]);
    if (spec.departure.holdShortZone) {
      add('hold-short prompt', [{ kind: 'flag_is_true', flag: fTaxi }, { kind: 'unit_in_zone', unit: leadName, zone: spec.departure.holdShortZone }],
        [{ kind: 'message_to_group', group: g, text: `Holding short runway ${runway}: call ${tower} from the F10 menu.`, seconds: secs }]);
    }
    add('takeoff', [{ kind: 'flag_is_true', flag: fTakeoff }], [
      drop(ITEM.takeoff),
      ...line(`${cs}: ${tower}, ${cs}, holding short runway ${runway}, ready for departure.`, 'takeoffRequest'),
      ...line(`${tower}: ${cs}, runway ${runway}, cleared for takeoff.`, 'takeoffReply', delay),
    ]);
    // Airborne with or without having called: the handoff still comes.
    const next = awacsLabel ? `contact ${awacsLabel}` : 'frequency change approved';
    add('airborne handoff', [{ kind: 'unit_altitude_higher_agl', unit: leadName, altitudeMetres: spec.departureAGLMetres }], [
      drop(ITEM.startup), drop(ITEM.taxi), drop(ITEM.takeoff),
      { kind: 'set_flag', flag: fAirborne },
      ...line(`${cs}: ${tower}, ${cs}, airborne.`, 'departureCall'),
      ...line(`${tower}: ${cs}, ${spec.departure.instruction ? `${spec.departure.instruction}, ` : ''}${next}. Good day.`, 'departureReply', delay),
      ...(spec.awacs ? [item(ITEM.awacs, fAwacs)] : []),
    ]);
  } else {
    openers.push({ kind: 'set_flag', flag: fAirborne });
    if (spec.awacs) openers.push(item(ITEM.awacs, fAwacs));
    if (spec.departure.runway || spec.departure.holdShortZone) notes.push(`'${g}' starts in the air: departure settings are ignored.`);
  }
  const briefingText = spec.briefing ? `MISSION BRIEFING\n${spec.briefing}${firstCall ? `\n\n${firstCall}` : ''}` : firstCall;
  add('briefing', [{ kind: 'time_after', seconds: 1 }], [...(briefingText ? line(briefingText, 'briefing') : []), ...openers]);

  if (spec.awacs) {
    add('AWACS check-in', [{ kind: 'flag_is_true', flag: fAwacs }], [
      drop(ITEM.awacs),
      ...line(`${cs}: ${spec.awacs.callsign}, ${cs}, checking in, flight of ${units.length}${result.departure ? `, airborne ${result.departure.airfield}` : ''}.`, 'awacsCheckIn'),
      ...line(`${spec.awacs.callsign}: ${cs}, ${spec.awacs.callsign}, radar contact. ${spec.awacs.tasking}`, 'awacsReply', delay),
    ]);
    result.awacs = awacsLabel;
  }

  // --- Arrival ----------------------------------------------------------------------
  if (arrId !== undefined) {
    const airport = findAirport(theatre, arrId);
    const { radio, atc } = atcFreq(theatre, arrId);
    const a = spec.arrival ?? { inboundKm: 40, finalKm: 12 } as NonNullable<typeof spec.arrival>;
    if (a.finalKm >= a.inboundKm) throw new Error('arrival.finalKm must be smaller than arrival.inboundKm');
    const runway = pickRunway(radio, spec.arrival?.runway, 'arrival');
    const approach = a.approachName ?? `${radio.name} Approach`;
    const tower = a.towerName ?? `${radio.name} Tower`;
    const ground = a.groundName ?? `${radio.name} Ground`;
    const zones = [`${COMMENT(g)} inbound ${radio.name}`, `${COMMENT(g)} final ${radio.name}`];
    addTriggerZone(mission, { name: zones[0], x: airport.x, y: airport.y, radius: a.inboundKm * 1000 });
    addTriggerZone(mission, { name: zones[1], x: airport.x, y: airport.y, radius: a.finalKm * 1000 });
    result.arrival = { airfield: radio.name, runway, atc, zones };
    // Only after the flight has been OUTSIDE the inbound ring: on a round trip it departs from inside it.
    add('outbound', [{ kind: 'flag_is_true', flag: fAirborne }, { kind: 'unit_out_zone', unit: leadName, zone: zones[0] }], [{ kind: 'set_flag', flag: fAway }]);
    add('inbound prompt', [{ kind: 'flag_is_true', flag: fAway }, { kind: 'unit_in_zone', unit: leadName, zone: zones[0] }], [
      { kind: 'message_to_group', group: g, text: `Entering ${approach} airspace. Call inbound from the F10 menu. ATC ${atc}.`, seconds: secs },
      item(ITEM.inbound, fInbound),
    ]);
    add('inbound', [{ kind: 'flag_is_true', flag: fInbound }], [
      drop(ITEM.inbound),
      ...line(`${cs}: ${approach}, ${cs}, inbound for landing, flight of ${units.length}.`, 'inboundCall'),
      ...line(`${approach}: ${cs}, radar contact, expect runway ${runway}, descend at pilot's discretion. Contact ${tower} on final.`, 'inboundReply', delay),
    ]);
    add('final prompt', [{ kind: 'flag_is_true', flag: fAway }, { kind: 'unit_in_zone', unit: leadName, zone: zones[1] }], [
      drop(ITEM.inbound),
      { kind: 'message_to_group', group: g, text: `Call ${tower} for landing from the F10 menu.`, seconds: secs },
      item(ITEM.landing, fLanding),
    ]);
    add('landing clearance', [{ kind: 'flag_is_true', flag: fLanding }], [
      drop(ITEM.landing),
      ...line(`${cs}: ${tower}, ${cs}, final runway ${runway}, full stop.`, 'landingRequest'),
      ...line(`${tower}: ${cs}, runway ${runway}, cleared to land.`, 'landingReply', delay),
      item(ITEM.clear, fClear),
    ]);
    add('taxi to parking', [{ kind: 'flag_is_true', flag: fClear }], [
      drop(ITEM.clear),
      ...line(`${cs}: ${ground}, ${cs}, clear of runway ${runway}.`, 'clearOfRunway'),
      ...line(`${ground}: ${cs}, taxi to parking. Welcome back.`, 'taxiToParking', delay),
    ]);
  }

  result.flags = Object.fromEntries(Object.entries({ startup: fStartup, taxi: fTaxi, takeoff: fTakeoff, airborne: fAirborne, awacs: fAwacs,
    inbound: fInbound, landing: fLanding, clear: fClear, outbound: fAway }));
  const used = ATC_AUDIO_STEPS.filter(s => (s.startsWith('startup') || s.startsWith('taxi') && s !== 'taxiToParking' || s.startsWith('takeoff') || s.startsWith('departure')) ? hasDeparture
    : s.startsWith('awacs') ? !!spec.awacs : (s === 'briefing' ? !!briefingText : arrId !== undefined));
  const missing = used.filter(s => !spec.audio?.[s]);
  if (missing.length) notes.push(`No audio for: ${missing.join(', ')} - those lines are text only. Convert files with dcs_audio_convert, embed them, and pass audio.<step> = resource key.`);
  if (arrId === undefined) notes.push(`No arrival scripted: '${g}' has no Landing waypoint. Add one with dcs_miz_add_airfield_landing (or pass arrival.airfield) to get approach/tower/ground on the way home.`);
  notes.push(spec.silenceDcsAtc ? `DCS's own ATC is set silent at ${result.silenced.join(', ') || 'no airfield'}; whether silent mode also affects AI traffic there is unverified.` : "DCS's own ATC was left on and will answer the cockpit radio as well.");
  notes.push('Lines go to the flight only (message_to_group / sound_to_group). Dialogue is fictional brevity-style phrasing, not authenticated procedure. Offline-compiled with oracle-backed predicates only; not yet flown in DCS.');
  return result;
}
