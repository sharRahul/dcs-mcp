/** Goals/result representation follows pydcs goals.py; trigger conditions use the captured compiler. */
import { z } from 'zod';
import { conditionSchema } from './trigger-schema.js';
import { addTrigger, type ConditionSpec } from './authoring.js';
import { asTable, luaArray, type LuaTable } from './lua.js';
export const goalSchema = z.object({ side: z.enum(['blue', 'red', 'offline']), comment: z.string().min(1).max(200), score: z.number().int().min(-1000).max(1000), conditions: z.array(conditionSchema).min(1).max(100) }).strict();
export function addGoal(mission: LuaTable, input: z.input<typeof goalSchema>) {
  const spec = goalSchema.parse(input);
  // Compile on an isolated copy: no helper trigger is added to the real mission.
  const scratch = structuredClone(mission);
  const helper = addTrigger(scratch, { type: 'once', conditions: spec.conditions as ConditionSpec[], actions: [] });
  const rule = asTable(asTable(scratch.trigrules)?.[helper])!;
  const conditions = asTable(asTable(scratch.trig)?.conditions)?.[helper];
  const goals = structuredClone(asTable(mission.goals) ?? {});
  const index = Math.max(0, ...Object.keys(goals).map(Number).filter(Number.isFinite)) + 1;
  const result = structuredClone(asTable(mission.result) ?? {});
  const side = (result[spec.side] ??= { conditions: {}, actions: {}, func: {} }) as LuaTable;
  const sideGoals = Object.values(goals).filter(g => asTable(g)?.side === spec.side.toUpperCase()).length;
  const next = Math.max(sideGoals, ...Object.keys(asTable(side.conditions) ?? {}).map(Number).filter(Number.isFinite),
    ...Object.keys(asTable(side.actions) ?? {}).map(Number).filter(Number.isFinite), ...Object.keys(asTable(side.func) ?? {}).map(Number).filter(Number.isFinite)) + 1;
  goals[index] = { side: spec.side.toUpperCase(), score: spec.score, predicate: 'score', comment: spec.comment, rules: rule.rules! };
  ((side.conditions ??= {}) as LuaTable)[next] = conditions!;
  ((side.actions ??= {}) as LuaTable)[next] = `a_set_mission_result(${spec.score})`;
  ((side.func ??= {}) as LuaTable)[next] = `if mission.result.${spec.side}.conditions[${next}]() then mission.result.${spec.side}.actions[${next}]() end`;
  result.total = Object.keys(goals).filter(k => /^\d+$/.test(k)).length;
  mission.goals = goals; mission.result = result;
  return { goalIndex: index, resultIndex: next, side: spec.side, verification: 'pydcs goal/result format and mocked Lua only; no new trigger predicates' };
}
/** User flag allocation avoids all known raw rule and compiled flag references. */
export function allocateFlags(mission: LuaTable, count: number, extra: unknown = {}): number[] {
  let max = 999;
  const scan = (value: unknown, depth = 0) => {
    if (depth > 60 || !value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (/flag/i.test(key) && ((typeof child === 'number' && Number.isInteger(child)) || (typeof child === 'string' && /^\d+$/.test(child)))) max = Math.max(max, Number(child));
      if (typeof child === 'string') for (const match of child.matchAll(/(?:getUserFlag|setUserFlag|c_flag_is_true|c_flag_is_false|c_flag_equals|c_flag_more)\s*\(\s*["']?(\d+)/g)) max = Math.max(max, Number(match[1]));
      if (typeof child === 'object') scan(child, depth + 1);
    }
  };
  scan(mission); scan(extra);
  if (max + count > 2147483647) throw new Error('No free user flag block in supported integer range');
  return Array.from({ length: count }, (_, i) => max + i + 1);
}
