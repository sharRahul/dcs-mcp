/**
 * Scripted departure communications for a player flight starting at an airfield:
 * briefing at mission start, then the ground/tower exchange the player drives
 * from the F10 radio menu (startup, taxi, takeoff), an automatic departure call
 * once airborne, and an AWACS check-in that hands out the next action.
 *
 * Why F10 items and not engine/taxi detection: DCS has no oracle-backed trigger
 * predicate for "engines running" or "on the taxiway", and the bundled data has
 * no taxiway or runway-threshold coordinates (pydcs stores runway designators
 * only). A radio item the player presses is deterministic and matches how the
 * real exchange is initiated - the pilot calls first. Optional caller-supplied
 * zones (hold short, runway) add automatic prompts where the caller knows the
 * geometry. Departure uses `c_unit_altitude_higher_agl`, which is oracle-backed.
 *
 * Every predicate and action used is already in the oracle-backed compiler
 * (`trigger-schema.ts`): time_after, flag_is_true, unit_in_zone,
 * unit_altitude_higher_agl, message_to_group, sound_to_group,
 * add/remove_radio_item_for_group, set_flag. Nothing here has been flown yet.
 *
 * Dialogue is FICTIONAL, brevity-style phrasing, not authenticated ATC
 * procedure. Frequencies come from pydcs (`data/airfield-radio.json`); the
 * runway is the caller's or the first designator pydcs lists - wind is not
 * read, so the caller should pass the runway in use.
 */
import { z } from 'zod';
import { addTrigger, findGroup, type ActionSpec, type ConditionSpec } from './authoring.js';
import { asTable, luaArray, type LuaTable } from './lua.js';
import { allocateFlags } from './scoring.js';
import { airfieldRadio } from '../data/airfield-radio.js';

const name = z.string().min(1).max(200);
const AUDIO_STEPS = ['briefing', 'startupRequest', 'startupReply', 'taxiRequest', 'taxiReply', 'takeoffRequest', 'takeoffReply',
  'departureCall', 'departureReply', 'awacsCheckIn', 'awacsReply'] as const;
export type DepartureAudioStep = typeof AUDIO_STEPS[number];

export const departureCommsSchema = z.object({
  /** The player (or client) flight; it must start at an airfield (route point 1 carries airdromeId). */
  group: name,
  /** Radio callsign spoken for the flight, e.g. "Viper 1-1". Defaults to the lead unit's callsign. */
  callsign: z.string().min(1).max(60).optional(),
  /** Tower name, e.g. "Batumi Tower". Defaults to "<airfield> Tower". */
  towerName: z.string().min(1).max(60).optional(),
  /** Runway in use, e.g. "13". Defaults to the first designator pydcs lists for the airfield. */
  runway: z.string().min(1).max(10).optional(),
  briefing: z.string().min(1).max(100000),
  /** Departure instruction after takeoff, e.g. "climb runway heading to 5000, turn left 090". */
  departureInstruction: z.string().min(1).max(500).optional(),
  awacs: z.object({
    callsign: z.string().min(1).max(60).default('Magic'),
    /** MHz. Defaults to the named AWACS group's frequency when given. */
    frequencyMHz: z.number().positive().max(400).optional(),
    group: name.optional(),
    /** What AWACS tells the flight to do next, e.g. "proceed to CAP point Alpha, angels 25, picture clean". */
    tasking: z.string().min(1).max(1000),
  }).strict(),
  /** Height above ground at which the departure call fires. */
  departureAGLMetres: z.number().positive().max(5000).default(300),
  /** Optional zone names (already in the mission): entering them prompts the next call automatically. */
  holdShortZone: name.optional(),
  /** Optional resource keys (from dcs_miz_embed_asset / audio) played to the group with each line. */
  audio: z.partialRecord(z.enum(AUDIO_STEPS), name).optional(),
  /** Seconds between a pilot call and the controller's reply. */
  replyDelaySeconds: z.number().int().min(0).max(30).default(4),
  messageSeconds: z.number().int().positive().max(120).default(12),
}).strict();

export interface DepartureCommsResult {
  group: string; airfield: string; runway: string; atc: string; awacs: string;
  flags: Record<string, number>; triggers: number[]; notes: string[];
}

function fmt(mhz: number | undefined) { return mhz === undefined ? undefined : mhz.toFixed(mhz * 1000 % 10 ? 3 : 2).replace(/0$/, ''); }

export function addDepartureComms(mission: LuaTable, input: z.input<typeof departureCommsSchema>, dictionary?: LuaTable): DepartureCommsResult {
  const spec = departureCommsSchema.parse(input);
  const found = findGroup(mission, spec.group);
  if (!found) throw new Error(`No group named '${spec.group}' in this mission`);
  const group = found.group;
  const units = luaArray(asTable(group.units));
  const lead = units[0];
  if (!lead) throw new Error(`'${spec.group}' has no units`);
  const point1 = asTable(luaArray(asTable(asTable(group.route)?.points))[0]);
  const airdromeId = Number(point1?.airdromeId);
  if (!Number.isInteger(airdromeId) || airdromeId <= 0) {
    throw new Error(`'${spec.group}' does not start at an airfield (route point 1 has no airdromeId): departure comms need a ramp, runway or hot start at an airfield`);
  }
  if (spec.holdShortZone && !luaArray(asTable(asTable(mission.triggers)?.zones)).some(z => z.name === spec.holdShortZone)) {
    throw new Error(`No trigger zone named '${spec.holdShortZone}'`);
  }
  const theatre = String(mission.theatre ?? '');
  const radio = airfieldRadio(theatre, airdromeId);
  const notes: string[] = [];
  const airfield = radio.name;
  const runway = spec.runway ?? radio.runways[0]?.ends[0]?.name;
  if (!runway) throw new Error(`No runway designator known for ${airfield}; pass runway`);
  if (!spec.runway) notes.push(`Runway ${runway} is the first designator pydcs lists for ${airfield}, not the runway in use for the mission wind: pass runway to choose.`);
  const atcParts = [fmt(radio.atcMHz?.uhf) && `${fmt(radio.atcMHz?.uhf)} UHF`, fmt(radio.atcMHz?.vhfHigh) && `${fmt(radio.atcMHz?.vhfHigh)} VHF`].filter(Boolean);
  const atc = atcParts.join(' / ') || 'frequency unknown';
  const tower = spec.towerName ?? `${airfield} Tower`;
  const ground = spec.towerName ? spec.towerName.replace(/Tower$/i, 'Ground') : `${airfield} Ground`;
  const leadCallsign = asTable(lead.callsign)?.name;
  const cs = spec.callsign ?? (typeof leadCallsign === 'string' ? leadCallsign.replace(/^(\D+)(\d)(\d)$/, '$1 $2-$3') : spec.group);
  let awacsMHz = spec.awacs.frequencyMHz;
  if (spec.awacs.group) {
    const aw = findGroup(mission, spec.awacs.group);
    if (!aw) throw new Error(`No AWACS group named '${spec.awacs.group}'`);
    if (awacsMHz === undefined && typeof aw.group.frequency === 'number') awacsMHz = aw.group.frequency;
  }
  const awacsFreq = awacsMHz === undefined ? undefined : `${fmt(awacsMHz)}`;
  if (!awacsFreq) notes.push('No AWACS frequency given or found on the AWACS group: the handoff names no frequency.');
  const awacs = `${spec.awacs.callsign}${awacsFreq ? ` on ${awacsFreq}` : ''}`;

  const [fStartup, fTaxi, fTakeoff, fAwacs, fAirborne] = allocateFlags(mission, 5);
  const g = spec.group, delay = spec.replyDelaySeconds, secs = spec.messageSeconds;
  const line = (text: string, step: DepartureAudioStep, delaySeconds = 0): ActionSpec[] => {
    const out: ActionSpec[] = [{ kind: 'message_to_group', group: g, text, seconds: secs, ...(delaySeconds ? { delaySeconds } : {}) }];
    const key = spec.audio?.[step];
    if (key) out.push({ kind: 'sound_to_group', group: g, resourceKey: key, ...(delaySeconds ? { delaySeconds } : {}) });
    return out;
  };
  const item = (text: string, flag: number): ActionSpec => ({ kind: 'add_radio_item_for_group', group: g, text, flag, value: 1 });
  const drop = (text: string): ActionSpec => ({ kind: 'remove_radio_item_for_group', group: g, text });
  const ITEM = { startup: 'ATC: Request startup', taxi: 'ATC: Request taxi', takeoff: 'ATC: Ready for departure', awacs: `AWACS: Check in with ${spec.awacs.callsign}` };
  const triggers: number[] = [];
  const add = (comment: string, conditions: ConditionSpec[], actions: ActionSpec[]) =>
    triggers.push(addTrigger(mission, { type: 'once', comment, conditions, actions }, dictionary));

  add('Departure comms: briefing', [{ kind: 'time_after', seconds: 1 }], [
    ...line(`MISSION BRIEFING\n${spec.briefing}\n\nWhen ready, call ${ground} from the F10 menu. ATC ${atc}.`, 'briefing'),
    item(ITEM.startup, fStartup),
  ]);
  add('Departure comms: startup', [{ kind: 'flag_is_true', flag: fStartup }], [
    drop(ITEM.startup),
    ...line(`${cs}: ${ground}, ${cs}, flight of ${units.length}, request startup.`, 'startupRequest'),
    ...line(`${ground}: ${cs}, startup approved, runway ${runway}. Call for taxi when ready.`, 'startupReply', delay),
    item(ITEM.taxi, fTaxi),
  ]);
  add('Departure comms: taxi', [{ kind: 'flag_is_true', flag: fTaxi }], [
    drop(ITEM.taxi),
    ...line(`${cs}: ${ground}, ${cs}, ready to taxi.`, 'taxiRequest'),
    ...line(`${ground}: ${cs}, taxi to runway ${runway}, hold short. Contact ${tower} when ready.`, 'taxiReply', delay),
    item(ITEM.takeoff, fTakeoff),
  ]);
  if (spec.holdShortZone) {
    add('Departure comms: hold-short prompt', [{ kind: 'flag_is_true', flag: fTaxi }, { kind: 'unit_in_zone', unit: String(lead.name), zone: spec.holdShortZone }],
      [{ kind: 'message_to_group', group: g, text: `Holding short runway ${runway}: call ${tower} from the F10 menu.`, seconds: secs }]);
  }
  add('Departure comms: takeoff', [{ kind: 'flag_is_true', flag: fTakeoff }], [
    drop(ITEM.takeoff),
    ...line(`${cs}: ${tower}, ${cs}, holding short runway ${runway}, ready for departure.`, 'takeoffRequest'),
    ...line(`${tower}: ${cs}, runway ${runway}, cleared for takeoff.`, 'takeoffReply', delay),
  ]);
  // Airborne: either the player took off without calling (still give the handoff) or after clearance.
  add('Departure comms: airborne handoff', [{ kind: 'unit_altitude_higher_agl', unit: String(lead.name), altitudeMetres: spec.departureAGLMetres }], [
    drop(ITEM.startup), drop(ITEM.taxi), drop(ITEM.takeoff),
    { kind: 'set_flag', flag: fAirborne },
    ...line(`${cs}: ${tower}, ${cs}, airborne.`, 'departureCall'),
    ...line(`${tower}: ${cs}, ${spec.departureInstruction ? `${spec.departureInstruction}, ` : ''}contact ${awacs}. Good day.`, 'departureReply', delay),
    item(ITEM.awacs, fAwacs),
  ]);
  add('Departure comms: AWACS check-in', [{ kind: 'flag_is_true', flag: fAwacs }], [
    drop(ITEM.awacs),
    ...line(`${cs}: ${spec.awacs.callsign}, ${cs}, checking in, flight of ${units.length}, airborne ${airfield}.`, 'awacsCheckIn'),
    ...line(`${spec.awacs.callsign}: ${cs}, ${spec.awacs.callsign}, radar contact. ${spec.awacs.tasking}`, 'awacsReply', delay),
  ]);

  const missing = AUDIO_STEPS.filter(s => !spec.audio?.[s]);
  if (missing.length) notes.push(`No audio for: ${missing.join(', ')} - those lines are text only. Convert files with dcs_audio_convert, embed them, and pass audio.<step> = resource key.`);
  notes.push('Lines go to the player group only (message_to_group / sound_to_group). Dialogue is fictional brevity-style phrasing, not authenticated ATC procedure.');
  notes.push("DCS's own ATC still answers the cockpit radio; this script does not replace or silence it.");
  notes.push('Offline-compiled with oracle-backed predicates only; not yet flown in DCS.');
  return { group: g, airfield, runway, atc, awacs, flags: { startup: fStartup, taxi: fTaxi, takeoff: fTakeoff, awacs: fAwacs, airborne: fAirborne }, triggers, notes };
}
