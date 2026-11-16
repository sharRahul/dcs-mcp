/**
 * List, read, modify and remove mission goals.
 *
 * Format: pydcs goals.py. `mission.goals[i]` holds every goal; `mission.result.<side>` holds,
 * for the side's k-th goal (goal-index order), `conditions[k]` (compiled), `actions[k]` =
 * `a_set_mission_result(<score>)` and `func[k]` = the fixed pydcs `funcstr`. Removing or
 * re-scoring rebuilds a side's actions/func in that format and keeps each compiled condition;
 * if an existing action/func entry is NOT in that format (hand-written), it refuses rather
 * than rewrite it. Offline only.
 */
import { z } from 'zod';
import { asTable, type LuaTable } from './lua.js';
import { addTrigger, type ConditionSpec } from './authoring.js';
import { conditionSchema } from './trigger-schema.js';

type Side = 'blue' | 'red' | 'offline';
const SIDES: Side[] = ['blue', 'red', 'offline'];
const funcstr = (side: Side, k: number) => `if mission.result.${side}.conditions[${k}]() then mission.result.${side}.actions[${k}]() end`;
const numericKeys = (t: LuaTable) => Object.keys(t).filter(k => /^\d+$/.test(k)).map(Number).sort((a, b) => a - b);

function goalsOf(mission: LuaTable) {
  const goals = asTable(mission.goals) ?? {};
  return numericKeys(goals).map(i => ({ index: i, goal: asTable(goals[i])! }));
}
function sideOf(goal: LuaTable): Side {
  const s = String(goal.side ?? '').toLowerCase();
  if (!SIDES.includes(s as Side)) throw new Error(`Goal has unknown side '${goal.side}'`);
  return s as Side;
}
/** The 1-based result index of each goal within its side. */
function ordinals(mission: LuaTable) {
  const counters: Record<Side, number> = { blue: 0, red: 0, offline: 0 };
  return goalsOf(mission).map(g => ({ ...g, side: sideOf(g.goal), resultIndex: ++counters[sideOf(g.goal)] }));
}

export function listGoals(mission: LuaTable) {
  return ordinals(mission).map(({ index, goal, side, resultIndex }) => ({
    index, side, score: goal.score, comment: goal.comment, rules: numericKeys(asTable(goal.rules) ?? {}).length, resultIndex,
  }));
}

export function getGoal(mission: LuaTable, index: number) {
  const hit = ordinals(mission).find(g => g.index === index);
  if (!hit) throw new Error(`No goal ${index}`);
  const side = asTable(asTable(mission.result)?.[hit.side]);
  return { index, side: hit.side, resultIndex: hit.resultIndex, goal: hit.goal,
    result: { condition: asTable(side?.conditions)?.[hit.resultIndex] ?? null, action: asTable(side?.actions)?.[hit.resultIndex] ?? null } };
}

/** Refuse when a side's actions/func are not the exact pydcs-generated strings. */
function assertGenerated(mission: LuaTable, side: Side) {
  const r = asTable(asTable(mission.result)?.[side]);
  if (!r) return;
  for (const k of numericKeys(asTable(r.func) ?? {}))
    if (asTable(r.func)![k] !== funcstr(side, k)) throw new Error(`result.${side}.func[${k}] is not the standard generated form; refusing to renumber it`);
  for (const k of numericKeys(asTable(r.actions) ?? {}))
    if (!/^a_set_mission_result\(-?\d+\)$/.test(String(asTable(r.actions)![k]))) throw new Error(`result.${side}.actions[${k}] is not a_set_mission_result(n); refusing to rewrite it`);
}

/** Rebuild one side's result tables from its goals, keeping each goal's compiled condition. */
function rebuildSide(mission: LuaTable, side: Side, conditionFor: (resultIndexBefore: number | undefined, goalIndex: number) => string) {
  const result = (mission.result ??= {}) as LuaTable;
  const sideGoals = ordinals(mission).filter(g => g.side === side);
  const r: LuaTable = { conditions: {}, actions: {}, func: {} };
  sideGoals.forEach((g, i) => {
    const k = i + 1;
    (r.conditions as LuaTable)[k] = conditionFor(undefined, g.index);
    (r.actions as LuaTable)[k] = `a_set_mission_result(${g.goal.score})`;
    (r.func as LuaTable)[k] = funcstr(side, k);
  });
  result[side] = { ...(asTable(result[side]) ?? {}), ...r };
  result.total = goalsOf(mission).length;
}

export function removeGoal(mission: LuaTable, index: number) {
  const before = ordinals(mission);
  const hit = before.find(g => g.index === index);
  if (!hit) throw new Error(`No goal ${index}`);
  assertGenerated(mission, hit.side);
  const oldConditions = asTable(asTable(asTable(mission.result)?.[hit.side])?.conditions) ?? {};
  const conditionByGoal = new Map(before.filter(g => g.side === hit.side).map(g => [g.index, String(oldConditions[g.resultIndex] ?? 'return(false)')]));
  const goals = asTable(mission.goals)!;
  const kept = goalsOf(mission).filter(g => g.index !== index);
  const newIndexOf = new Map<number, number>();
  for (const k of Object.keys(goals)) delete goals[k];
  kept.forEach((g, i) => { goals[i + 1] = g.goal; newIndexOf.set(g.index, i + 1); });
  const conditionByNew = new Map([...conditionByGoal].map(([old, c]) => [newIndexOf.get(old)!, c]));
  rebuildSide(mission, hit.side, (_, goalIndex) => conditionByNew.get(goalIndex)!);
  return { removed: index, side: hit.side, remaining: kept.length };
}

export const goalChangeSchema = z.object({
  score: z.number().int().min(-1000).max(1000).optional(), comment: z.string().min(1).max(200).optional(),
  conditions: z.array(conditionSchema).min(1).max(100).optional(),
}).strict();

export function modifyGoal(mission: LuaTable, index: number, input: z.input<typeof goalChangeSchema>) {
  const change = goalChangeSchema.parse(input);
  const hit = ordinals(mission).find(g => g.index === index);
  if (!hit) throw new Error(`No goal ${index}`);
  assertGenerated(mission, hit.side);
  const side = asTable(asTable(mission.result)?.[hit.side]);
  let condition = String(asTable(side?.conditions)?.[hit.resultIndex] ?? 'return(false)');
  if (change.conditions) {
    // Compile on a scratch copy with the oracle-backed compiler, exactly as addGoal does.
    const scratch = structuredClone(mission);
    const helper = addTrigger(scratch, { type: 'once', conditions: change.conditions as ConditionSpec[], actions: [] });
    hit.goal.rules = asTable(asTable(scratch.trigrules)?.[helper])!.rules!;
    condition = String(asTable(asTable(scratch.trig)?.conditions)?.[helper]);
  }
  if (change.score !== undefined) hit.goal.score = change.score;
  if (change.comment !== undefined) hit.goal.comment = change.comment;
  const conditions = new Map(ordinals(mission).filter(g => g.side === hit.side)
    .map(g => [g.index, g.index === index ? condition : String(asTable(side?.conditions)?.[g.resultIndex] ?? 'return(false)')]));
  rebuildSide(mission, hit.side, (_, goalIndex) => conditions.get(goalIndex)!);
  return { index, side: hit.side, changed: Object.keys(change) };
}
