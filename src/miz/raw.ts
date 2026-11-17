/**
 * Read and write any value in the session's mission table by path.
 *
 * Every other tool here writes one kind of thing and checks it. This is the escape hatch
 * for the rest of the file format: a field DCS added last patch, a flag no tool models, a
 * value someone needs to copy out of an editor-saved mission. It is deliberately plain —
 * a path and a value — but it is not unguarded:
 *
 *   - the path is resolved against the parsed mission table only, never the archive, and
 *     can never reach the session's other entries (dictionary, mapResource, files);
 *   - writing an unknown key is refused unless `create` is set, so a typo in a path
 *     cannot silently add a field DCS will ignore while the real one stays unchanged;
 *   - the value is converted to a Lua-safe structure (no functions, no cycles, bounded
 *     depth and size), because the mission is serialized as Lua, not as JSON;
 *   - after the write the mission is serialized and reparsed, and the write is rolled
 *     back if that round trip fails. A mission that cannot be reparsed is a mission the
 *     Mission Editor cannot open either.
 *
 * What it cannot do is know whether DCS honours the field. Validation still applies
 * (dcs_miz_validate), but a raw write is an assertion by the caller, not by this server.
 */
import { parseLuaAssignment, asTable, type LuaTable, type LuaValue } from './lua.js';
import { serializeLuaAssignment } from './serializer.js';

const MAX_DEPTH = 24;
const MAX_NODES = 50_000;

export interface PathStep { key: string | number }

/**
 * Parse `coalition.blue.country[1].plane.group[2].name` into steps. Bracket indices are
 * numbers (Lua tables in a .miz are 1-based arrays), dotted names are strings. A quoted
 * bracket key (`["a key"]`) keeps a literal string, for keys with spaces or digits.
 */
/**
 * Keys that are not mission data but JavaScript's own object machinery. A mission table is
 * a plain object, so writing one of these would reach Object.prototype instead of the
 * mission — polluting every object in the server process. They are refused in paths and
 * in written values alike, and lookups only ever read own properties.
 */
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function parsePath(path: string): (string | number)[] {
  if (!path.trim()) throw new Error('path is required, e.g. coalition.blue.country[1].plane.group[1].name');
  const steps: (string | number)[] = [];
  const re = /\s*(?:\[\s*(?:"([^"]*)"|'([^']*)'|(-?\d+))\s*\]|([A-Za-z_][A-Za-z0-9_]*))\s*(?:\.|(?=\[)|$)/g;
  let at = 0;
  while (at < path.length) {
    re.lastIndex = at;
    const m = re.exec(path);
    if (!m || m.index !== at) throw new Error(`Cannot parse path at '${path.slice(at)}'. Use name.name[1].name or ["a key"].`);
    const step = m[1] ?? m[2] ?? (m[3] !== undefined ? Number(m[3]) : m[4]);
    if (typeof step === 'string' && RESERVED_KEYS.has(step)) {
      throw new Error(`'${step}' is a JavaScript object key, not mission data; it cannot be read or written.`);
    }
    steps.push(step);
    at = re.lastIndex;
  }
  if (!steps.length) throw new Error(`Cannot parse path '${path}'`);
  return steps;
}

const describe = (v: LuaValue | undefined): string =>
  v === undefined ? 'absent' : Array.isArray(v) ? 'table' : typeof v === 'object' ? 'table' : typeof v;

function walk(mission: LuaTable, steps: (string | number)[], upto: number): LuaValue | undefined {
  let node: LuaValue | undefined = mission;
  for (let i = 0; i < upto; i++) {
    const table = asTable(node);
    if (!table) throw new Error(`Path stops at '${steps.slice(0, i).join('.')}': that value is ${describe(node)}, not a table.`);
    const key = steps[i];
    // Own properties only: an inherited member is not mission data.
    node = Object.prototype.hasOwnProperty.call(table, key) ? (table[key as keyof typeof table] as LuaValue | undefined) : undefined;
  }
  return node;
}

export interface GetResult {
  path: string;
  exists: boolean;
  type: string;
  /** Scalars verbatim; a table is summarised (keys and length) unless `expand` is set. */
  value?: unknown;
  keys?: (string | number)[];
  length?: number;
}

export function getMissionValue(mission: LuaTable, path: string, expand = false): GetResult {
  const steps = parsePath(path);
  const value = walk(mission, steps, steps.length);
  const table = asTable(value);
  if (table) {
    const keys = Object.keys(table).map(k => (/^-?\d+$/.test(k) ? Number(k) : k));
    return {
      path, exists: true, type: 'table', keys: keys.slice(0, 500), length: keys.length,
      ...(expand ? { value: JSON.parse(JSON.stringify(table)) as unknown } : {}),
    };
  }
  return { path, exists: value !== undefined, type: describe(value), value: value as unknown };
}

/** Convert a JSON value to a Lua-safe one: bounded, finite numbers, no cycles. */
function toLua(value: unknown, path: string, depth = 0, budget = { nodes: 0 }): LuaValue {
  if (depth > MAX_DEPTH) throw new Error(`Value nests deeper than ${MAX_DEPTH} levels at ${path}`);
  if (++budget.nodes > MAX_NODES) throw new Error(`Value has more than ${MAX_NODES} nodes`);
  if (value === null) throw new Error(`null is not a Lua value (at ${path}). Use remove=true to delete a key.`);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Only finite numbers can be written (at ${path})`);
    return value;
  }
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    // Lua arrays in a .miz are 1-based, which is what the editor writes and reads.
    const out: LuaTable = {};
    value.forEach((v, i) => { out[i + 1] = toLua(v, `${path}[${i + 1}]`, depth + 1, budget); });
    return out;
  }
  if (typeof value === 'object') {
    const out: LuaTable = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (RESERVED_KEYS.has(k)) throw new Error(`'${k}' is a JavaScript object key, not mission data (at ${path})`);
      out[/^-?\d+$/.test(k) ? Number(k) : k] = toLua(v, `${path}.${k}`, depth + 1, budget);
    }
    return out;
  }
  throw new Error(`Cannot write a ${typeof value} into a mission (at ${path})`);
}

export interface SetArgs { path: string; value?: unknown; remove?: boolean; create?: boolean }

export function setMissionValue(mission: LuaTable, args: SetArgs) {
  const steps = parsePath(args.path);
  if (steps.length < 1) throw new Error('path must name a key to write');
  const parentPath = steps.slice(0, -1);
  const leaf = steps[steps.length - 1];
  const parent = asTable(walk(mission, steps, steps.length - 1));
  if (!parent) throw new Error(`'${parentPath.join('.') || 'mission'}' is not a table in this mission`);
  const had = Object.prototype.hasOwnProperty.call(parent, leaf);
  const previous = parent[leaf as keyof typeof parent] as LuaValue | undefined;

  if (args.remove) {
    if (!had) throw new Error(`Nothing to remove: '${args.path}' does not exist`);
  } else {
    if (args.value === undefined) throw new Error('value is required (or pass remove=true)');
    if (!had && !args.create) {
      const near = Object.keys(parent).slice(0, 12).join(', ');
      throw new Error(
        `'${args.path}' does not exist. Pass create=true to add it. Keys at '${parentPath.join('.') || 'mission'}': ${near || '(none)'}.`
      );
    }
  }

  if (args.remove) delete parent[leaf as keyof typeof parent];
  else parent[leaf as keyof typeof parent] = toLua(args.value, args.path) as never;

  // A mission that cannot be reparsed cannot be opened by the editor either, so the write
  // is rolled back rather than left in the session.
  try {
    const text = serializeLuaAssignment('mission', mission);
    parseLuaAssignment(text, 'mission');
  } catch (error) {
    if (had) parent[leaf as keyof typeof parent] = previous as never;
    else delete parent[leaf as keyof typeof parent];
    throw new Error(`Rolled back: the mission no longer serializes and reparses after that write (${(error as Error).message})`);
  }

  return {
    path: args.path,
    action: args.remove ? 'removed' : had ? 'replaced' : 'created',
    previousType: describe(previous),
    newType: args.remove ? 'absent' : describe(parent[leaf as keyof typeof parent] as LuaValue),
    roundTrip: 'serialized and reparsed',
    notes: [
      'A raw write is your assertion about the file format, not this server\'s: nothing here knows whether DCS honours this field.',
      'Run dcs_miz_validate before saving; the structural checks still apply.',
    ],
  };
}
