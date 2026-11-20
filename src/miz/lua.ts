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

/**
 * Convert a data-only Lua AST node into a plain JS value. `constants` (default: none) is a
 * whitelist of bare identifiers a specific data file may use as named numbers, e.g. the
 * main-task names in DCS UnitPayloads files; any other identifier is refused.
 */
function evalNode(node: any, constants?: Readonly<Record<string, number | string>>): LuaValue {
  switch (node.type) {
    case "Identifier":
      if (constants && Object.prototype.hasOwnProperty.call(constants, node.name)) return constants[node.name];
      throw new Error(`Refusing to evaluate identifier '${node.name}': not a whitelisted constant`);
    case "StringLiteral":
      // Always decode from `raw`: luaparse leaves `value` null in its default
      // encoding mode, and where it is populated it is not escape-decoded.
      return typeof node.raw === "string" ? unquote(node.raw) : String(node.value ?? "");
    case "NumericLiteral":
      return node.value;
    case "BooleanLiteral":
      return node.value;
    case "NilLiteral":
      return null;
    case "UnaryExpression":
      if (node.operator === "-") {
        const inner = evalNode(node.argument, constants);
        if (typeof inner === "number") return -inner;
      }
      throw new Error(`Unsupported unary operator '${node.operator}' in mission data`);
    case "TableConstructorExpression":
      return evalTable(node, constants);
    default:
      throw new Error(
        `Refusing to evaluate non-data Lua node '${node.type}'. Mission data must be literal.`
      );
  }
}

function evalTable(node: any, constants?: Readonly<Record<string, number | string>>): LuaTable {
  const table: LuaTable = {};
  // Lua keys are data: assigning __proto__ must not invoke a JavaScript setter.
  const setOwn = (key: string | number, value: LuaValue) => Object.defineProperty(table, key, {
    value, writable: true, enumerable: true, configurable: true,
  });
  let arrayIndex = 1;
  for (const field of node.fields) {
    switch (field.type) {
      case "TableKeyString":
        setOwn(field.key.name, evalNode(field.value, constants));
        break;
      case "TableKey": {
        const key = evalNode(field.key, constants);
        if (typeof key !== "string" && typeof key !== "number") {
          throw new Error("Unsupported table key type in mission data");
        }
        setOwn(key, evalNode(field.value, constants));
        break;
      }
      case "TableValue":
        setOwn(arrayIndex++, evalNode(field.value, constants));
        break;
      default:
        throw new Error(`Unsupported table field '${field.type}' in mission data`);
    }
  }
  return table;
}

/** Single-character Lua escapes. `\<newline>` is a literal newline. */
const SIMPLE_ESCAPES: Record<string, string> = {
  a: "\x07",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  "\\": "\\",
  '"': '"',
  "'": "'",
  "\n": "\n",
};

/**
 * Decode a Lua string literal's raw source (quotes included) into its value.
 *
 * Must be a single left-to-right scan: chained `String.replace` calls corrupt
 * data because an earlier rule can rewrite a backslash that a later rule owns
 * (e.g. `"path\\name"` would decode to a backslash + newline).
 */
function unquote(raw: string): string {
  // Long-bracket strings ([[...]], [==[...]==]) are raw: no escape processing,
  // and Lua drops a newline immediately following the opening bracket.
  const long = /^\[(=*)\[([\s\S]*)\]\1\]$/.exec(raw);
  if (long) return long[2].replace(/^\r\n|^\n/, "");

  if (raw.length < 2 || (raw[0] !== '"' && raw[0] !== "'")) return raw;
  const body = raw.slice(1, -1);

  let out = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = body[++i];
    if (next === undefined) {
      out += "\\"; // trailing backslash: emit literally rather than lose it
      break;
    }
    // \ddd -- up to three decimal digits.
    if (next >= "0" && next <= "9") {
      const digits = /^[0-9]{1,3}/.exec(body.slice(i))![0];
      out += String.fromCharCode(Number(digits));
      i += digits.length - 1;
      continue;
    }
    // \xXX -- hexadecimal (Lua 5.2+, tolerated here).
    if (next === "x" || next === "X") {
      const hex = /^[0-9a-fA-F]{1,2}/.exec(body.slice(i + 1));
      if (hex) {
        out += String.fromCharCode(parseInt(hex[0], 16));
        i += hex[0].length;
        continue;
      }
      out += next;
      continue;
    }
    // \z -- skip the following run of whitespace (Lua 5.2+).
    if (next === "z") {
      let j = i + 1;
      while (j < body.length && /\s/.test(body[j])) j++;
      i = j - 1;
      continue;
    }
    // \<CR> and \<CRLF> are line continuations, normalized to a newline.
    if (next === "\r") {
      out += "\n";
      if (body[i + 1] === "\n") i++;
      continue;
    }
    out += SIMPLE_ESCAPES[next] ?? next;
  }
  return out;
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

/**
 * Parse a standalone DCS data file of the form `[local] name = { ... }` optionally followed
 * by `return name` (e.g. the MissionEditor UnitPayloads Lua files). Any other statement is refused,
 * and bare identifiers are allowed only from `constants`. Nothing is executed.
 */
export function parseLuaDataFile(source: string, name: string, constants: Readonly<Record<string, number | string>> = {}): LuaTable {
  const ast = luaparse.parse(source, { luaVersion: "5.1", comments: false, scope: false, locations: false }) as any;
  let value: LuaValue | undefined;
  for (const stmt of ast.body) {
    const assigns = stmt.type === "AssignmentStatement" || stmt.type === "LocalStatement";
    if (assigns && stmt.variables.length === 1 && stmt.variables[0]?.type === "Identifier" && stmt.variables[0].name === name && stmt.init?.length === 1) {
      value = evalNode(stmt.init[0], constants);
    } else if (stmt.type === "ReturnStatement" && stmt.arguments.length === 1 && stmt.arguments[0].type === "Identifier" && stmt.arguments[0].name === name) {
      continue;
    } else {
      throw new Error(`Refusing non-data statement '${stmt.type}' in data file`);
    }
  }
  if (!value || typeof value !== "object") throw new Error(`No table assigned to '${name}'`);
  return value;
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
