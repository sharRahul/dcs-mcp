/**
 * Route, group and unit inspection, plus editing of existing waypoint tasks.
 *
 * Editing goes through the Hoggit-wiki catalogue (actions.ts): a task is identified as a
 * catalogue entry (task id, WrappedAction command id, or Option by numeric id for the
 * group's domain), the changed parameters are validated exactly as for a new action, and
 * any field the file carried that the catalogue does not document (e.g. editor-written
 * `speedEdited`, `key`) is kept as it was. A task that cannot be identified is refused,
 * not rewritten. Offline only; not Mission-Editor verified.
 */
import { asTable, luaArray, type LuaTable, type LuaValue } from './lua.js';
import { findGroup, findGroupOfUnit, findUnit, type FoundGroup } from './authoring.js';
import { buildWaypointAction, hoggitData } from './actions.js';

const DOMAIN: Record<string, 'Air' | 'Ground' | 'Naval'> = { plane: 'Air', helicopter: 'Air', vehicle: 'Ground', ship: 'Naval' };
const deg = (r: unknown) => typeof r === 'number' ? Math.round(((r * 180) / Math.PI + 360) % 360 * 100) / 100 : undefined;

function requireGroup(mission: LuaTable, name: string): FoundGroup {
  const found = findGroup(mission, name);
  if (!found) throw new Error(`No group named '${name}' in this mission`);
  return found;
}
function points(found: FoundGroup): LuaTable[] { return luaArray(asTable(found.group.route)?.points); }
function comboTasks(point: LuaTable): LuaTable | undefined {
  const combo = asTable(point.task);
  return combo?.id === 'ComboTask' ? asTable(asTable(combo.params)?.tasks) : undefined;
}

/** Which catalogue entry a stored task is, if any. */
export function identifyTask(task: LuaTable, category: string): { key: string | null; kind: string; id: string } {
  const actions = hoggitData().actions;
  if (task.id === 'WrappedAction') {
    const inner = asTable(asTable(task.params)?.action);
    const innerId = String(inner?.id ?? '');
    if (innerId === 'Option') {
      const name = asTable(inner?.params)?.name;
      const domain = DOMAIN[category];
      const key = Object.entries(actions).find(([, a]) => a.kind === 'option' && a.optionIds?.[domain] === name)?.[0] ?? null;
      return { key, kind: 'option', id: `Option ${name}` };
    }
    const key = Object.entries(actions).find(([, a]) => a.kind === 'command' && a.id === innerId)?.[0] ?? null;
    return { key, kind: 'command', id: innerId };
  }
  const id = String(task.id ?? '');
  const key = Object.entries(actions).find(([, a]) => a.kind === 'task' && a.id === id)?.[0] ?? null;
  return { key, kind: 'task', id };
}

function describeTask(task: LuaTable, category: string) {
  const who = identifyTask(task, category);
  const inner = task.id === 'WrappedAction' ? asTable(asTable(task.params)?.action) : task;
  return { number: task.number, ...who, enabled: task.enabled !== false, auto: task.auto === true, params: asTable(inner?.params) ?? {} };
}

export function getRoute(mission: LuaTable, groupName: string) {
  const found = requireGroup(mission, groupName);
  return { group: groupName, category: found.category, points: points(found).map((p, i) => ({
    index: i + 1, x: p.x, y: p.y, alt: p.alt, alt_type: p.alt_type, speed: p.speed, type: p.type, action: p.action,
    name: p.name, ETA: p.ETA, ETA_locked: p.ETA_locked, airdromeId: p.airdromeId, linkUnit: p.linkUnit,
    tasks: luaArray(comboTasks(p)).map(t => describeTask(t, found.category)),
  })) };
}

function unitView(u: LuaTable) {
  const { heading, ...rest } = u;
  return { ...rest, headingDegrees: deg(heading) };
}

export function getGroup(mission: LuaTable, groupName: string) {
  const found = requireGroup(mission, groupName);
  const { units, route, ...fields } = found.group;
  return { group: groupName, side: found.side, country: found.country.name, category: found.category, fields,
    units: luaArray(units).map(unitView), waypoints: points(found).length };
}

export function getUnit(mission: LuaTable, unitName: string) {
  const unit = findUnit(mission, unitName);
  const found = findGroupOfUnit(mission, unitName);
  if (!unit || !found) throw new Error(`No unit named '${unitName}' in this mission`);
  return { unit: unitName, group: found.group.name, side: found.side, country: found.country.name, category: found.category, data: unitView(unit) };
}

function requireTask(mission: LuaTable, groupName: string, waypoint: number, taskNumber: number) {
  const found = requireGroup(mission, groupName);
  const point = points(found)[waypoint - 1];
  if (!point) throw new Error(`Group '${groupName}' has no waypoint ${waypoint}`);
  const tasks = comboTasks(point);
  if (!tasks) throw new Error(`Waypoint ${waypoint} has no ComboTask list`);
  const key = Object.keys(tasks).find(k => asTable(tasks[k])?.number === taskNumber);
  if (key === undefined) throw new Error(`Waypoint ${waypoint} has no task number ${taskNumber}`);
  return { found, tasks, key, task: asTable(tasks[key])! };
}

/** Remove one task; later tasks keep their order and are renumbered 1..n like the editor's list. */
export function removeWaypointTask(mission: LuaTable, groupName: string, waypoint: number, taskNumber: number) {
  const { tasks, task, found } = requireTask(mission, groupName, waypoint, taskNumber);
  const kept = luaArray(tasks).filter(t => t !== task);
  for (const k of Object.keys(tasks)) delete tasks[k];
  kept.forEach((t, i) => { t.number = i + 1; tasks[i + 1] = t; });
  return { group: groupName, waypoint, removed: describeTask(task, found.category), remaining: kept.length };
}

export function setTaskEnabled(mission: LuaTable, groupName: string, waypoint: number, taskNumber: number, enabled: boolean) {
  const { task } = requireTask(mission, groupName, waypoint, taskNumber);
  task.enabled = enabled;
  return { group: groupName, waypoint, taskNumber, enabled };
}

/** Change a catalogued task's params (or an option's value); everything else is kept. */
export function modifyWaypointTask(mission: LuaTable, groupName: string, waypoint: number, taskNumber: number,
  change: { params?: Record<string, unknown>; value?: unknown }) {
  const { found, tasks, key, task } = requireTask(mission, groupName, waypoint, taskNumber);
  const who = identifyTask(task, found.category);
  if (!who.key) throw new Error(`Task ${taskNumber} ('${who.id}') is not in the catalogue; refusing to rewrite it. Remove and re-add it instead.`);
  const entry = hoggitData().actions[who.key];
  const inner = task.id === 'WrappedAction' ? asTable(asTable(task.params)?.action)! : task;
  const existing = asTable(inner.params) ?? {};
  let built;
  const preserved: string[] = [];
  if (entry.kind === 'option') {
    if (change.params) throw new Error('Options take value, not params');
    built = buildWaypointAction(mission, found, { action: who.key, value: change.value });
  } else {
    if (change.value !== undefined) throw new Error(`'${who.key}' takes params, not value`);
    const declared = entry.params ?? {};
    const documented: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(existing)) if (k in declared) documented[k] = v;
    built = buildWaypointAction(mission, found, { action: who.key, params: { ...documented, ...change.params } });
    const newInner = built.task.id === 'WrappedAction' ? asTable(asTable(built.task.params)?.action)! : built.task;
    const np = asTable(newInner.params)!;
    for (const [k, v] of Object.entries(existing)) if (!(k in declared)) { np[k] = v as LuaValue; preserved.push(k); }
  }
  // Keep every top-level field the stored task had (enabled, auto, number, key, name...).
  const { id: _id, params: _params, ...envelope } = task;
  tasks[key] = { ...built.task, ...envelope };
  return { group: groupName, waypoint, taskNumber, action: who.key, preservedUndocumentedParams: preserved, warnings: built.warnings };
}
