/**
 * Serialize a raw Lua data table back to DCS mission Lua.
 *
 * The serializer is the ONLY component permitted to write mission data. It emits
 * deterministic output (numeric keys ascending, string keys sorted) so diffs are
 * stable, and preserves every field present in the table for lossless round-trips.
 */
import type { LuaTable, LuaValue } from "./lua.js";

function quote(s: string): string {
  return (
    '"' +
    s
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t") +
    '"'
  );
}

function serializeNumber(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (Number.isInteger(n)) return n.toString();
  return n.toString();
}

function serializeKey(key: string): string {
  // Numeric-looking keys become [n]; everything else is ["key"].
  if (/^\d+$/.test(key)) return `[${key}]`;
  return `[${quote(key)}]`;
}

function orderedKeys(table: LuaTable): string[] {
  const keys = Object.keys(table);
  const numeric = keys.filter((k) => /^\d+$/.test(k)).sort((a, b) => Number(a) - Number(b));
  const strings = keys.filter((k) => !/^\d+$/.test(k)).sort();
  return [...numeric, ...strings];
}

function serializeValue(value: LuaValue, indent: number): string {
  if (value === null) return "nil";
  switch (typeof value) {
    case "string":
      return quote(value);
    case "number":
      return serializeNumber(value);
    case "boolean":
      return value ? "true" : "false";
    case "object":
      return serializeTable(value as LuaTable, indent);
    default:
      return "nil";
  }
}

function serializeTable(table: LuaTable, indent: number): string {
  const keys = orderedKeys(table);
  if (keys.length === 0) return "{}";
  const pad = "\t".repeat(indent + 1);
  const closePad = "\t".repeat(indent);
  const lines: string[] = ["{"];
  for (const key of keys) {
    const value = table[key];
    if (value === undefined) continue;
    lines.push(`${pad}${serializeKey(key)} = ${serializeValue(value, indent + 1)},`);
  }
  lines.push(`${closePad}}`);
  return lines.join("\n");
}

/** Serialize a global assignment: `name = \n{ ... }` in DCS mission-file style. */
export function serializeLuaAssignment(name: string, table: LuaTable): string {
  return `${name} = \n${serializeTable(table, 0)}\n`;
}
