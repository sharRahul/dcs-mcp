import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLuaAssignment } from '../src/miz/lua.js';
import { serializeLuaAssignment } from '../src/miz/serializer.js';

test('Lua table keys remain own data properties without changing JavaScript prototypes', () => {
  const source = 'mission = { ["__proto__"] = { inherited = true }, constructor = "literal", ["prototype"] = 42 }';
  const table = parseLuaAssignment(source, 'mission');
  assert.equal(Object.getPrototypeOf(table), Object.prototype);
  assert.equal(table.inherited, undefined);
  assert.equal(Object.hasOwn(table, '__proto__'), true);
  assert.equal(table.constructor, 'literal');
  assert.deepEqual(parseLuaAssignment(serializeLuaAssignment('mission', table), 'mission'), table);
  assert.equal(({} as Record<string, unknown>).inherited, undefined);
});
