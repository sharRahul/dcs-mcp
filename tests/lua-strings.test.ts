import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLuaAssignment } from "../src/miz/lua.js";
import { serializeLuaAssignment } from "../src/miz/serializer.js";

/** Serialize a value, parse it back, and return what survived. */
function roundTrip(value: string): unknown {
  const lua = serializeLuaAssignment("t", { s: value });
  return (parseLuaAssignment(lua, "t") as Record<string, unknown>).s;
}

const TRICKY: Record<string, string> = {
  plain: "hello",
  doubleQuote: 'he said "hi"',
  singleQuote: "it's here",
  backslash: "C:\\Users\\pilot",
  // The regression that motivated these tests: chained replaces turned the
  // two-character sequence backslash + 'n' into backslash + newline.
  backslashThenN: "path\\name",
  backslashThenT: "tab\\there",
  doubleBackslash: "a\\\\b",
  newline: "line1\nline2",
  carriageReturn: "a\rb",
  crlf: "a\r\nb",
  tab: "a\tb",
  bell: "ring\x07ing",
  nullByte: "a\0b",
  formFeed: "a\fb",
  verticalTab: "a\vb",
  unicode: "Тбилиси ✈ 日本語",
  luaBrackets: 'key["x"] = [[y]]',
  digitAfterEscape: "a\n1b",
  briefingLike: 'Mission "Thunder"\r\nTake off from Batumi.\tRTB at bingo.\\n is literal.',
};

for (const [name, value] of Object.entries(TRICKY)) {
  test(`Lua string round-trips exactly: ${name}`, () => {
    assert.equal(roundTrip(value), value);
  });
}

test("serialized output is valid Lua for every tricky string", () => {
  for (const value of Object.values(TRICKY)) {
    const lua = serializeLuaAssignment("t", { s: value });
    assert.doesNotThrow(() => parseLuaAssignment(lua, "t"), `failed to reparse: ${JSON.stringify(value)}`);
  }
});

test("decimal escapes are emitted zero-padded so a following digit is unambiguous", () => {
  // "\0" followed by "1" must not be read back as the single character \01.
  const lua = serializeLuaAssignment("t", { s: "\x001" });
  assert.match(lua, /\\000/);
  assert.equal((parseLuaAssignment(lua, "t") as Record<string, unknown>).s, "\x001");
});

test("parser decodes escapes DCS writes: \\ddd, \\r, \\a and line continuations", () => {
  const table = parseLuaAssignment(
    't = { ["dec"] = "A\\066C", ["cr"] = "a\\rb", ["bell"] = "x\\ay", ["cont"] = "a\\\nb" }',
    "t"
  ) as Record<string, string>;
  assert.equal(table.dec, "ABC");
  assert.equal(table.cr, "a\rb");
  assert.equal(table.bell, "x\x07y");
  assert.equal(table.cont, "a\nb");
});

test("parser reads long-bracket strings without processing escapes", () => {
  const table = parseLuaAssignment('t = { ["s"] = [[raw \\n stays]], ["eq"] = [==[a]]b]==] }', "t") as Record<
    string,
    string
  >;
  assert.equal(table.s, "raw \\n stays");
  assert.equal(table.eq, "a]]b");
});

test("a long-bracket string drops only the newline right after the opening bracket", () => {
  const table = parseLuaAssignment('t = { ["s"] = [[\nfirst\nsecond\n]] }', "t") as Record<string, string>;
  assert.equal(table.s, "first\nsecond\n");
});
