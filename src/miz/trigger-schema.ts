/** Schemas for the existing oracle-backed compiler only. No new DCS predicates. */
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
]);
const message = { text: z.string().min(1).max(100000), seconds: z.number().int().positive().optional(), clearview: z.boolean().optional(), delaySeconds: z.number().int().nonnegative().optional() };
const { delaySeconds: _delay, ...groupMessage } = message;
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
]);
export const triggerSchema = z.object({ type: z.enum(['start', 'once', 'continuous', 'change']).default('once'), comment: z.string().max(200).optional(), conditions: z.array(conditionSchema).max(100), actions: z.array(actionSchema).min(1).max(100) }).strict();
