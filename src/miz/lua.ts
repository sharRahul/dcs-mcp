/**
 * Safe Lua-data parser.
 *
 * DCS `.miz` package entries (mission, options, dictionary, ...) are pure data:
 * a single global assignment of a nested table literal. We parse the source with
 * luaparse and evaluate ONLY literal data nodes. Any function, call, or other
 * executable construct causes a hard failure. Nothing from the mission is ever run.
 */
import luaparse from "luaparse";

export type LuaValue =
  | string
  | number
  | boolean
  | null
  | LuaTable;

export interface LuaTable {
  [key: string]: LuaValue;
  [key: number]: LuaValue;
}

/** Convert a data-only Lua AST node into a plain JS value. */
function evalNode(node: any): LuaValue {
  switch (node.type) {
    case "StringLiteral":
      return typeof node.value === "string" ? node.value : unquote(node.raw);
    case "NumericLiteral":
      return node.value;
    case "BooleanLiteral":
      return node.value;
    case "NilLiteral":
      return null;
    case "UnaryExpression":
      if (node.operator === "-") {
        const inner = evalNode(node.argument);
        if (typeof inner === "number") return -inner;
      }
      throw new Error(`Unsupported unary operator '${node.operator}' in mission data`);
    case "TableConstructorExpression":
      return evalTable(node);
    default:
      throw new Error(
        `Refusing to evaluate non-data Lua node '${node.type}'. Mission data must be literal.`
      );
  }
}

function evalTable(node: any): LuaTable {
  const table: LuaTable = {};
  let arrayIndex = 1;
  for (const field of node.fields) {
    switch (field.type) {
      case "TableKeyString":
        table[field.key.name] = evalNode(field.value);
        break;
      case "TableKey": {
        const key = evalNode(field.key);
        if (typeof key !== "string" && typeof key !== "number") {
          throw new Error("Unsupported table key type in mission data");
        }
        table[key as string | number] = evalNode(field.value);
        break;
      }
      case "TableValue":
        table[arrayIndex++] = evalNode(field.value);
        break;
      default:
        throw new Error(`Unsupported table field '${field.type}' in mission data`);
    }
  }
  return table;
}

function unquote(raw: string): string {
  if (raw.length >= 2 && (raw[0] === '"' || raw[0] === "'")) {
    const body = raw.slice(1, -1);
    return body
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\'/g, "'")
      .replace(/\\\\/g, "\\");
  }
  return raw;
}

/**
 * Parse a DCS data file that assigns a single global table (e.g. `mission = {...}`).
 * Returns the assigned table. `expectedName` (when given) must match the assigned global.
 */
export function parseLuaAssignment(source: string, expectedName?: string): LuaTable {
  const ast = luaparse.parse(source, {
    luaVersion: "5.1",
    comments: false,
    scope: false,
    locations: false,
  }) as any;

  for (const stmt of ast.body) {
    if (stmt.type === "AssignmentStatement" && stmt.variables[0]?.type === "Identifier") {
      const name = stmt.variables[0].name;
      if (expectedName && name !== expectedName) continue;
      const value = evalNode(stmt.init[0]);
      if (value === null || typeof value !== "object") {
        throw new Error(`Global '${name}' is not a table`);
      }
      return value;
    }
  }
  throw new Error(
    expectedName
      ? `No assignment to global '${expectedName}' found`
      : "No table assignment found in Lua source"
  );
}

/** Extract the sequential (1..n) values of a Lua table as a JS array. */
export function luaArray(table: LuaValue | undefined): LuaTable[] {
  if (!table || typeof table !== "object") return [];
  const out: LuaTable[] = [];
  for (let i = 1; ; i++) {
    const v = (table as LuaTable)[i];
    if (v === undefined) break;
    if (v && typeof v === "object") out.push(v as LuaTable);
    else out.push({ value: v } as LuaTable);
  }
  return out;
}

/** Type-narrowing accessor for a nested table. */
export function asTable(value: LuaValue | undefined): LuaTable | undefined {
  return value && typeof value === "object" ? (value as LuaTable) : undefined;
}
