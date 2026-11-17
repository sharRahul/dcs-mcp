/**
 * Schemas for the oracle-backed compiler only: every kind here has a recorded
 * spec -> compiled-Lua pair in tests/fixtures/trig-oracle.json. Nothing is added
 * without one.
 */
import { z } from 'zod';
import { sideSchema } from './configuration.js';
const flag = z.number().int().min(1).max(2147483647), name = z.string().min(1).max(200);
export const conditionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('time_after'), seconds: z.number().int().nonnegative() }).strict(),
  z.object({ kind: z.literal('time_since_flag'), flag, seconds: z.number().int().nonnegative() }).strict(),
  ...(['flag_is_true', 'flag_is_false'] as const).map(kind => z.object({ kind: z.literal(kind), flag }).strict()),
  ...(['flag_equals', 'flag_more'] as const).map(kind => z.object({ kind: z.literal(kind), flag, value: z.number().int() }).strict()),
  ...(['unit_in_zone', 'unit_out_zone'] as const).map(kind => z.object({ kind: z.literal(kind), unit: name, zone: name }).strict()),
  z.object({ kind: z.literal('unit_dead'), unit: name }).strict(),
  z.object({ kind: z.literal('group_dead'), group: name }).strict(),
  z.object({ kind: z.literal('group_life_less'), group: name, percent: z.number().int().min(0).max(100) }).strict(),
  z.object({ kind: z.literal('part_of_group_in_zone'), group: name, zone: name }).strict(),
  z.object({ kind: z.literal('part_of_coalition_in_zone'), coalition: sideSchema, zone: name, unitType: z.enum(['ALL', 'AIRPLANE', 'HELICOPTER', 'GROUND_UNIT', 'SHIP']).optional() }).strict(),
  z.object({ kind: z.literal('random_less'), percent: z.number().int().min(0).max(100) }).strict(),
  // Captured in the 2026-11-17 sweep of Mission-Editor-saved missions.
  z.object({ kind: z.literal('group_alive'), group: name }).strict(),
  z.object({ kind: z.literal('unit_damaged'), unit: name }).strict(),
  z.object({ kind: z.literal('all_of_group_in_zone'), group: name, zone: name }).strict(),
  z.object({ kind: z.literal('part_of_group_out_zone'), group: name, zone: name }).strict(),
  z.object({ kind: z.literal('unit_in_zone_unit'), unit: name, zone: name, zoneUnit: name }).strict(),
  ...(['unit_altitude_higher', 'unit_altitude_higher_agl', 'unit_altitude_lower'] as const)
    .map(kind => z.object({ kind: z.literal(kind), unit: name, altitudeMetres: z.number().finite() }).strict()),
  // `types` is the editor's own four-number weapon selector; this server does not
  // interpret it, so copy it from a mission whose condition already works.
  ...(['missile_in_zone', 'bomb_in_zone'] as const).map(kind => z.object({ kind: z.literal(kind), zone: name,
    types: z.array(z.number().int().nonnegative()).length(4), count: z.number().int().positive().optional() }).strict()),
  // Separator: joins the surrounding conditions with ` or ` instead of ` and `.
  z.object({ kind: z.literal('or') }).strict(),
]);
const message = { text: z.string().min(1).max(100000), seconds: z.number().int().positive().optional(), clearview: z.boolean().optional(), delaySeconds: z.number().int().nonnegative().optional() };
// The per-group message DOES take a delay: the editor emits a fifth argument
// whenever the rule carries `start_delay`, in most of its own missions.
const groupMessage = message;
const resourceKey = name;
export const actionSchema = z.union([
  z.object({ kind: z.literal('message'), ...message }).strict(),
  z.object({ kind: z.literal('message_to_coalition'), coalition: sideSchema, ...message }).strict(),
  z.object({ kind: z.literal('message_to_group'), group: name, ...groupMessage }).strict(),
  z.object({ kind: z.literal('message_to_unit'), unit: name, ...message }).strict(),
  z.object({ kind: z.literal('message_to_country'), countryId: z.number().int().nonnegative(), ...message }).strict(),
  z.object({ kind: z.literal('set_flag'), flag, value: z.number().int().optional() }).strict(),
  z.object({ kind: z.literal('set_flag_random'), flag, min: z.number().int(), max: z.number().int() }).strict(),
  z.object({ kind: z.literal('clear_flag'), flag }).strict(),
  ...(['activate_group', 'deactivate_group', 'group_on', 'group_off', 'group_resume'] as const).map(kind => z.object({ kind: z.literal(kind), group: name }).strict()),
  z.object({ kind: z.literal('end_mission'), winner: sideSchema, delaySeconds: z.number().int().nonnegative().optional() }).strict(),
  z.object({ kind: z.literal('add_radio_item'), text: name, flag, value: z.number().int().optional() }).strict(),
  z.object({ kind: z.literal('add_radio_item_for_group'), group: name, text: name, flag, value: z.number().int().optional() }).strict(),
  z.object({ kind: z.literal('remove_radio_item'), text: name }).strict(),
  z.object({ kind: z.literal('remove_radio_item_for_group'), group: name, text: name }).strict(),
  z.object({ kind: z.literal('wait_for_user_flag'), flag, flagBack: flag.optional() }).strict(),
  z.object({ kind: z.literal('sound'), resourceKey, delaySeconds: z.number().int().nonnegative().optional() }).strict(),
  z.object({ kind: z.literal('sound_to_coalition'), resourceKey, coalition: sideSchema, delaySeconds: z.number().int().nonnegative().optional() }).strict(),
  z.object({ kind: z.literal('sound_to_group'), resourceKey, group: name, delaySeconds: z.number().int().nonnegative().optional() }).strict(),
  z.object({ kind: z.literal('stop_sound') }).strict(),
  z.object({ kind: z.literal('radio_transmission'), resourceKey, zone: name, frequencyMHz: z.number().positive().max(400), name,
    power: z.number().positive().optional(), modulationAM: z.boolean().optional(), loop: z.boolean().optional(), delaySeconds: z.number().int().nonnegative().optional(), micEffects: z.boolean().optional(), squelchEffects: z.boolean().optional() }).strict(),
  z.object({ kind: z.literal('do_script'), text: z.string().min(1).max(200000) }).strict(),
  z.object({ kind: z.literal('do_script_file'), resourceKey }).strict(),
  z.object({ kind: z.literal('explode'), zone: name, power: z.number().positive().optional(), altitudeMetres: z.number().nonnegative().optional() }).strict(),
  z.object({ kind: z.literal('smoke'), zone: name, preset: z.number().int().min(1).max(8).optional(), density: z.number().int().min(1).max(4).optional() }).strict(),
  z.object({ kind: z.literal('signal_flare'), zone: name, color: z.number().int().min(0).max(3).optional(), altitudeMetres: z.number().nonnegative().optional(), bearing: z.number().min(0).max(359).optional() }).strict(),
  // Captured in the 2026-11-17 sweep of Mission-Editor-saved missions.
  z.object({ kind: z.literal('explode_unit'), unit: name, power: z.number().positive().optional() }).strict(),
  z.object({ kind: z.literal('smoke_marker'), zone: name, color: z.number().int().min(0).max(4).optional(), altitudeMetres: z.number().nonnegative().optional() }).strict(),
  z.object({ kind: z.literal('smoke_marker_unit'), unit: name, color: z.number().int().min(0).max(4).optional(), name: z.string().max(200).optional() }).strict(),
  z.object({ kind: z.literal('signal_flare_unit'), unit: name, color: z.number().int().min(0).max(3).optional(), bearing: z.number().min(0).max(359).optional() }).strict(),
  z.object({ kind: z.literal('picture_to_coalition'), coalition: sideSchema, resourceKey,
    seconds: z.number().int().positive().optional(), clearview: z.boolean().optional(), delaySeconds: z.number().int().nonnegative().optional(),
    size: z.number().int().positive().max(100).optional(), horizontalAlignment: z.number().int().min(0).max(2).optional(),
    verticalAlignment: z.number().int().min(0).max(2).optional(), sizeUnits: z.number().int().min(0).max(1).optional() }).strict(),
  z.object({ kind: z.literal('mark_to_all'), id: z.number().int().positive(), text: z.string().min(1).max(100000), zone: name,
    readonly: z.boolean().optional(), comment: z.string().max(100000).optional() }).strict(),
  z.object({ kind: z.literal('add_radio_item_for_coalition'), coalition: sideSchema, text: name, flag, value: z.number().int().optional() }).strict(),
  z.object({ kind: z.literal('set_atc_silent_mode'), airdromeId: z.number().int().positive(), silent: z.boolean().optional() }).strict(),
  z.object({ kind: z.literal('shelling_zone'), zone: name, tnt: z.number().positive().max(100000), shells: z.number().int().positive().max(10000) }).strict(),
  z.object({ kind: z.literal('resize_zone'), zone: name, metres: z.number().finite() }).strict(),
  z.object({ kind: z.literal('ai_task'), group: name, taskNumber: z.number().int().positive() }).strict(),
]);
export const triggerSchema = z.object({ type: z.enum(['start', 'once', 'continuous', 'change']).default('once'), comment: z.string().max(200).optional(), conditions: z.array(conditionSchema).max(100), actions: z.array(actionSchema).min(1).max(100) }).strict();
