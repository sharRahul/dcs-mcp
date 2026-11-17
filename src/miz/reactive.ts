/**
 * Reactive ("dynamic") mission patterns: reserves that spawn when something
 * happens, rather than at mission start.
 *
 * This is how the community's "dynamic" single-player missions are actually
 * built, read off editor-saved missions rather than imagined. In the sweep of
 * the mission corpus the shape was the same every time:
 *
 *   - most of the order of battle exists from the start, but 477 groups across
 *     the corpus carry `lateActivation = true` and sit inert;
 *   - triggers watch the player - `c_part_of_coalition_in_zone` (152 uses),
 *     `c_part_of_group_in_zone` (102), `c_unit_in_zone` (101), `c_group_dead`
 *     (43) - and respond with `a_activate_group` (441 uses, by far the most
 *     common action in the corpus), `a_deactivate_group` (45) and `a_ai_task`
 *     (215), usually alongside a message and a sound;
 *   - variety between playthroughs comes from `c_random_less` on the trigger,
 *     not from anything DCS does by itself.
 *
 * Every predicate used here is oracle-backed (`tests/fixtures/trig-oracle.json`),
 * so what this writes is the same compiled `trig` the editor would produce. What
 * it does NOT do is make DCS spawn anything it would not otherwise: a reactive
 * spawn is a late-activated group plus a trigger, and nothing more.
 *
 * ED's own Dynamic Slots are a different feature: groups carry
 * `dynSpawnTemplate`, and `setDynamicSpawnTemplate` below writes exactly that
 * boolean. Every mission in the corpus had it `false`, so the flag is all that
 * is established - what DCS does with a `true` one is not, and the function says
 * so instead of implying a working dynamic-slot mission.
 */
import { z } from "zod";
import {
  addTrigger,
  findGroup,
  type ActionSpec,
  type ConditionSpec,
  type Side,
  type UnitTypeFilter,
} from "./authoring.js";
import { asTable, luaArray, type LuaTable } from "./lua.js";

const name = z.string().min(1).max(200);

/** What makes a reactive spawn fire. Each maps to one oracle-backed condition. */
export const reactiveTriggerSchema = z.discriminatedUnion("on", [
  z
    .object({
      on: z.literal("coalition_in_zone"),
      zone: name,
      coalition: z.enum(["red", "blue", "neutrals"]),
      unitType: z.enum(["ALL", "AIRPLANE", "HELICOPTER", "GROUND_UNIT", "SHIP"]).optional(),
    })
    .strict(),
  z.object({ on: z.literal("group_in_zone"), zone: name, group: name }).strict(),
  z.object({ on: z.literal("unit_in_zone"), zone: name, unit: name }).strict(),
  z.object({ on: z.literal("group_dead"), group: name }).strict(),
  // A whole SAM battery dying is a high bar: a two-HARM SEAD pass kills the
  // radars and leaves six launchers and the support park standing. Keying a
  // reserve off ONE unit — the track radar — is what a mission usually wants.
  z.object({ on: z.literal("unit_dead"), unit: name }).strict(),
  z.object({ on: z.literal("group_damaged"), group: name, percent: z.number().int().min(1).max(100) }).strict(),
  z.object({ on: z.literal("flag"), flag: z.number().int().min(1).max(2147483647) }).strict(),
  z.object({ on: z.literal("time"), seconds: z.number().int().nonnegative() }).strict(),
]);

export const reactiveSpawnSchema = z
  .object({
    /** Trigger comment, and the stem of the flag name in reports. */
    label: z.string().min(1).max(120),
    trigger: reactiveTriggerSchema,
    /** Groups to activate. Each must already exist with lateActivation = true. */
    activate: z.array(name).max(50).default([]),
    /** Groups to deactivate, for a reserve that replaces another. */
    deactivate: z.array(name).max(50).default([]),
    /** Push the group's n-th stored AI task, the editor's AI TASK PUSH. */
    aiTasks: z.array(z.object({ group: name, taskNumber: z.number().int().positive() }).strict()).max(50).default([]),
    /** Chance the response happens at all, as `c_random_less`. */
    chancePercent: z.number().int().min(1).max(100).optional(),
    /** Seconds to wait after the trigger before the response. */
    delaySeconds: z.number().int().positive().max(86400).optional(),
    /** A flag to set, so other triggers and goals can react to the same event. */
    setFlag: z.number().int().min(1).max(2147483647).optional(),
    message: z
      .object({
        text: z.string().min(1).max(100000),
        coalition: z.enum(["red", "blue", "neutrals"]).optional(),
        seconds: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    /** Fire once (the default) or every time the condition is true again. */
    repeat: z.boolean().default(false),
  })
  .strict()
  .refine(
    (s) => s.activate.length || s.deactivate.length || s.aiTasks.length || s.setFlag !== undefined || s.message,
    { message: "A reactive spawn needs something to do: activate, deactivate, aiTasks, setFlag or message." }
  );

export interface ReactiveSpawnResult {
  label: string;
  /** Trigger indices written, in order. */
  triggers: number[];
  /** The flag used to carry a delay, when one was asked for. */
  delayFlag?: number;
  notes: string[];
}

/**
 * Wire one reactive spawn.
 *
 * A delay needs TWO triggers because DCS has no delay on `a_activate_group`:
 * the first sets a flag when the condition is met, the second fires
 * `c_time_since_flag` later and does the work. That is how editor-saved missions
 * do it too, and it is why the delay costs a flag.
 */
export function addReactiveSpawn(
  mission: LuaTable,
  input: z.input<typeof reactiveSpawnSchema>,
  dictionary?: LuaTable
): ReactiveSpawnResult {
  const spec = reactiveSpawnSchema.parse(input);
  const notes: string[] = [];

  for (const group of spec.activate) {
    const found = findGroup(mission, group);
    if (!found) throw new Error(`No group named '${group}' in this mission`);
    if (found.group["lateActivation"] !== true) {
      throw new Error(
        `'${group}' is not late-activated, so activating it does nothing: it is already in the mission from t=0. ` +
          `Set lateActivation on it first (dcs_miz_update_group).`
      );
    }
  }
  for (const group of [...spec.deactivate, ...spec.aiTasks.map((t) => t.group)]) {
    if (!findGroup(mission, group)) throw new Error(`No group named '${group}' in this mission`);
  }

  const conditions: ConditionSpec[] = [conditionFor(spec.trigger)];
  if (spec.chancePercent !== undefined) conditions.push({ kind: "random_less", percent: spec.chancePercent });

  const response: ActionSpec[] = [];
  if (spec.message) {
    response.push(
      spec.message.coalition
        ? {
            kind: "message_to_coalition",
            coalition: spec.message.coalition as Side,
            text: spec.message.text,
            seconds: spec.message.seconds ?? 10,
          }
        : { kind: "message", text: spec.message.text, seconds: spec.message.seconds ?? 10 }
    );
  }
  for (const group of spec.activate) response.push({ kind: "activate_group", group });
  for (const group of spec.deactivate) response.push({ kind: "deactivate_group", group });
  for (const task of spec.aiTasks) response.push({ kind: "ai_task", group: task.group, taskNumber: task.taskNumber });
  if (spec.setFlag !== undefined) response.push({ kind: "set_flag", flag: spec.setFlag });

  const type = spec.repeat ? "continuous" : "once";
  const triggers: number[] = [];

  if (spec.delaySeconds === undefined) {
    triggers.push(addTrigger(mission, { type, comment: spec.label, conditions, actions: response }, dictionary));
  } else {
    const delayFlag = nextFreeFlag(mission);
    triggers.push(
      addTrigger(
        mission,
        {
          type,
          comment: `${spec.label} (armed)`,
          conditions,
          actions: [{ kind: "set_flag", flag: delayFlag }],
        },
        dictionary
      )
    );
    triggers.push(
      addTrigger(
        mission,
        {
          type: "once",
          comment: `${spec.label} (after ${spec.delaySeconds}s)`,
          conditions: [{ kind: "time_since_flag", flag: delayFlag, seconds: spec.delaySeconds }],
          actions: response,
        },
        dictionary
      )
    );
    notes.push(
      `The delay costs flag ${delayFlag}: DCS has no delay on a_activate_group, so the condition sets a flag and a ` +
        `second trigger fires ${spec.delaySeconds}s later on c_time_since_flag.`
    );
    return { label: spec.label, triggers, delayFlag, notes: [...notes, ...baseNotes(spec)] };
  }
  return { label: spec.label, triggers, notes: [...notes, ...baseNotes(spec)] };
}

function baseNotes(spec: z.output<typeof reactiveSpawnSchema>): string[] {
  const notes = [
    "Every predicate here has a recorded editor spec -> compiled-Lua pair, so the trigger fires when the mission is flown directly.",
  ];
  if (spec.repeat) {
    notes.push(
      "A repeating (continuous) trigger re-runs its actions every time the condition is true, including re-activating " +
        "a group that is already active. Pair it with a flag if it should only happen once per wave."
    );
  } else {
    notes.push("A once trigger disarms itself (mission.trig.func[i]=nil), so the reserve spawns at most once.");
  }
  if (spec.chancePercent !== undefined) {
    notes.push(
      `c_random_less(${spec.chancePercent}) is evaluated with the condition, so the roll happens when the trigger is ` +
        `checked, not at mission load.`
    );
  }
  return notes;
}

function conditionFor(trigger: z.output<typeof reactiveTriggerSchema>): ConditionSpec {
  switch (trigger.on) {
    case "coalition_in_zone":
      return {
        kind: "part_of_coalition_in_zone",
        coalition: trigger.coalition as Side,
        zone: trigger.zone,
        unitType: (trigger.unitType ?? "ALL") as UnitTypeFilter,
      };
    case "group_in_zone":
      return { kind: "part_of_group_in_zone", group: trigger.group, zone: trigger.zone };
    case "unit_in_zone":
      return { kind: "unit_in_zone", unit: trigger.unit, zone: trigger.zone };
    case "group_dead":
      return { kind: "group_dead", group: trigger.group };
    case "unit_dead":
      return { kind: "unit_dead", unit: trigger.unit };
    case "group_damaged":
      return { kind: "group_life_less", group: trigger.group, percent: trigger.percent };
    case "flag":
      return { kind: "flag_is_true", flag: trigger.flag };
    case "time":
      return { kind: "time_after", seconds: trigger.seconds };
  }
}

/** Lowest flag id no trigger or goal in the mission already refers to. */
export function nextFreeFlag(mission: LuaTable): number {
  const used = new Set<number>();
  const collect = (table: LuaTable | undefined) => {
    for (const rule of luaArray(table)) {
      for (const list of ["rules", "actions"] as const) {
        for (const entry of luaArray(rule[list])) {
          for (const field of ["flag", "flag_back"] as const) {
            const value = entry[field];
            const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
            if (Number.isInteger(n) && n > 0) used.add(n);
          }
        }
      }
    }
  };
  collect(asTable(mission["trigrules"]));
  for (const side of ["blue", "red"] as const) collect(asTable(asTable(mission["goals"])?.[side]));
  let flag = 1;
  while (used.has(flag)) flag++;
  return flag;
}

/**
 * Set a group's `dynSpawnTemplate`, ED's Dynamic Slots flag.
 *
 * The field is real and the editor writes it on every plane and helicopter
 * group; `false` is what every mission in the corpus carries. That is the limit
 * of what is established here. Setting it true is NOT known to produce a working
 * dynamic slot - the rest of that feature (which airfields offer it, what the
 * client sees) is not visible in any file this project reads - so the result
 * says as much rather than implying it works.
 */
export function setDynamicSpawnTemplate(
  mission: LuaTable,
  group: string,
  value: boolean
): { group: string; dynSpawnTemplate: boolean; notes: string[] } {
  const found = findGroup(mission, group);
  if (!found) throw new Error(`No group named '${group}' in this mission`);
  if (found.category !== "plane" && found.category !== "helicopter") {
    throw new Error(`'${group}' is a ${found.category} group; dynSpawnTemplate is written on flying groups only.`);
  }
  found.group["dynSpawnTemplate"] = value;
  return {
    group,
    dynSpawnTemplate: value,
    notes: [
      "dynSpawnTemplate is the field the editor writes for ED's Dynamic Slots; the flag itself is all this project has evidence for.",
      "Every editor-saved mission available here carries it as false, so a true value has not been seen, flown or verified.",
      "For reserves that appear during a mission, use a late-activated group with a reactive trigger instead: that is tested.",
    ],
  };
}
