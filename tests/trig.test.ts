/**
 * Compiled-trigger tests.
 *
 * `tests/fixtures/trig-oracle.json` was captured from missions saved by the DCS
 * Mission Editor: each record pairs a `mission.trigrules` spec with the exact
 * `mission.trig` Lua the editor compiled for it. These tests assert we reproduce
 * that output byte for byte, so an authored .miz fires when flown directly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import luaparse from "luaparse";
import { compileTrig, addTrigger, addTriggerZone, addAircraftGroup } from "../src/miz/authoring.js";
import { serializeLuaAssignment } from "../src/miz/serializer.js";
import { parseLuaAssignment } from "../src/miz/lua.js";
import type { LuaTable } from "../src/miz/lua.js";

interface PredicateCase {
  predicate: string;
  /** Which trigrule array DCS stores this in. Not inferable from the name: it
   *  keeps `c_start_wait_for_user` in `actions`. */
  role: "condition" | "action";
  spec: Record<string, unknown>;
  lua: string;
}
interface RuleCase {
  type: string;
  index: number;
  rules: Record<string, unknown>[];
  actions: Record<string, unknown>[];
  condition: string;
  action: string;
  func?: string;
  funcStartup?: string;
}

const oracle = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/trig-oracle.json", import.meta.url)), "utf8")
) as { predicates: PredicateCase[]; rules: RuleCase[] };

/** A trigrule the compiler cannot understand, used to hold an index slot. */
function placeholderRule(): LuaTable {
  return {
    predicate: "triggerOnce",
    rules: { 1: { predicate: "c_not_a_real_predicate" } },
    actions: { 1: { predicate: "a_not_a_real_predicate" } },
  } as unknown as LuaTable;
}

/** Build a mission whose trigrule `index` is `rule`, padded so indices line up. */
function missionWithRuleAt(index: number, rule: LuaTable): LuaTable {
  const trigrules: LuaTable = {};
  for (let i = 1; i < index; i++) trigrules[i] = placeholderRule();
  trigrules[index] = rule;
  return { trigrules } as unknown as LuaTable;
}

function compileOne(index: number, rule: LuaTable) {
  const mission = missionWithRuleAt(index, rule);
  const result = compileTrig(mission);
  const trig = mission["trig"] as unknown as Record<string, LuaTable>;
  return { result, trig };
}

test("every oracle condition predicate compiles to the Lua the Mission Editor wrote", () => {
  const conditions = oracle.predicates.filter((p) => p.role === "condition");
  assert.ok(conditions.length >= 14, `oracle has only ${conditions.length} conditions`);

  for (const oracleCase of conditions) {
    const rule = {
      predicate: "triggerContinious",
      rules: { 1: oracleCase.spec },
      actions: { 1: { predicate: "a_set_flag", flag: 1 } },
    } as unknown as LuaTable;
    const { trig } = compileOne(1, rule);
    assert.equal(
      trig.conditions[1],
      `return(${oracleCase.lua} )`,
      `${oracleCase.predicate}: compiled condition does not match the Mission Editor`
    );
  }
});

test("every oracle action predicate compiles to the Lua the Mission Editor wrote", () => {
  const actions = oracle.predicates.filter((p) => p.role === "action");
  assert.ok(actions.length >= 14, `oracle has only ${actions.length} actions`);

  for (const oracleCase of actions) {
    const rule = {
      // Continuous, so nothing is appended after the action call.
      predicate: "triggerContinious",
      rules: {},
      actions: { 1: oracleCase.spec },
    } as unknown as LuaTable;
    const { trig } = compileOne(1, rule);
    assert.equal(
      trig.actions[1],
      `${oracleCase.lua};`,
      `${oracleCase.predicate}: compiled action does not match the Mission Editor`
    );
  }
});

test("whole triggers compile to the Mission Editor's conditions, actions and wiring", () => {
  assert.ok(oracle.rules.length >= 10, `oracle has only ${oracle.rules.length} whole-trigger cases`);
  const typesSeen = new Set<string>();

  for (const oracleCase of oracle.rules) {
    const rules: LuaTable = {};
    oracleCase.rules.forEach((r, i) => (rules[i + 1] = r as LuaTable));
    const actions: LuaTable = {};
    oracleCase.actions.forEach((a, i) => (actions[i + 1] = a as LuaTable));

    const { result, trig } = compileOne(oracleCase.index, {
      predicate: oracleCase.type,
      rules,
      actions,
    } as unknown as LuaTable);

    const label = `${oracleCase.type}[${oracleCase.index}]`;
    assert.ok(result.compiled.includes(oracleCase.index), `${label}: was not compiled`);
    assert.equal(trig.conditions[oracleCase.index], oracleCase.condition, `${label}: conditions`);
    assert.equal(trig.actions[oracleCase.index], oracleCase.action, `${label}: actions`);
    assert.equal(trig.func[oracleCase.index], oracleCase.funcStartup ? undefined : oracleCase.func, `${label}: func`);
    assert.equal(trig.funcStartup[oracleCase.index], oracleCase.funcStartup, `${label}: funcStartup`);
    assert.equal(trig.flag[oracleCase.index], true, `${label}: flag`);
    typesSeen.add(oracleCase.type);
  }

  // The four trigger types wire func/funcStartup differently; cover them all.
  assert.deepEqual(
    [...typesSeen].sort(),
    ["triggerContinious", "triggerFront", "triggerOnce", "triggerStart"],
    "oracle should exercise every trigger type"
  );
});

test("a trigger with no conditions compiles to the editor's 'always' form", () => {
  const { trig } = compileOne(1, {
    predicate: "triggerOnce",
    rules: {},
    actions: { 1: { predicate: "a_set_flag", flag: 3 } },
  } as unknown as LuaTable);
  assert.equal(trig.conditions[1], "return(true)");
  assert.equal(trig.actions[1], "a_set_flag(3); mission.trig.func[1]=nil;");
});

test("compileTrig leaves triggers it does not understand exactly as they were", () => {
  const mission = missionWithRuleAt(2, {
    predicate: "triggerOnce",
    rules: { 1: { predicate: "c_time_after", seconds: 5 } },
    actions: { 1: { predicate: "a_set_flag", flag: 1 } },
  } as unknown as LuaTable);
  // Index 1 is a predicate we have no verified mapping for, but it already has
  // compiled entries from DCS. Those must survive untouched.
  const existingCondition = `return(c_something_exotic(1) )`;
  const existingAction = `a_do_script_file(getValueResourceByKey("ResKey_Script"));`;
  mission["trig"] = {
    conditions: { 1: existingCondition },
    actions: { 1: existingAction },
    funcStartup: { 1: "if mission.trig.conditions[1]() then mission.trig.actions[1]() end" },
    func: {},
    flag: {},
  } as unknown as LuaTable;

  const result = compileTrig(mission);
  const trig = mission["trig"] as unknown as Record<string, LuaTable>;

  assert.deepEqual(result.skipped, [1]);
  assert.deepEqual(result.compiled, [2]);
  assert.equal(trig.conditions[1], existingCondition);
  assert.equal(trig.actions[1], existingAction);
  assert.equal(trig.conditions[2], "return(c_time_after(5) )");
});

test("compileTrig leaves event-driven (eventlist) triggers wired exactly as the editor saved them", () => {
  // Shape of a real ME-saved trigger: a once trigger on the "shot" event. The
  // editor wires it into trig.events.shot[1] with an events-table disarm and NO
  // func[1]. Its predicates are compilable, which is exactly why it used to be
  // rewritten into a polled func[1] trigger.
  const mission = missionWithRuleAt(1, {
    predicate: "triggerOnce",
    eventlist: "shot",
    rules: { 1: { predicate: "c_time_after", seconds: 5 } },
    actions: { 1: { predicate: "a_set_flag", flag: 1 } },
  } as unknown as LuaTable);
  const wiring = "if mission.trig.conditions[1]() then mission.trig.actions[1]() end";
  const savedAction = `a_set_flag("1"); mission.trig.events["shot"][1]=nil;`;
  mission["trig"] = {
    conditions: { 1: "return(c_time_after(5) )" },
    actions: { 1: savedAction },
    events: { shot: { 1: wiring } },
    func: {},
    funcStartup: {},
    flag: { 1: true },
  } as unknown as LuaTable;
  const before = structuredClone(mission["trig"]);

  const result = compileTrig(mission);

  assert.deepEqual(result.skipped, [1]);
  assert.deepEqual(result.compiled, []);
  const after = mission["trig"] as unknown as Record<string, unknown>;
  for (const section of Object.keys(before)) assert.deepEqual(after[section], (before as Record<string, unknown>)[section], section);
});

test("recompiling is idempotent and never doubles the once-trigger's disarm", () => {
  const mission = missionWithRuleAt(1, {
    predicate: "triggerOnce",
    rules: { 1: { predicate: "c_time_after", seconds: 5 } },
    actions: { 1: { predicate: "a_set_flag", flag: 1 } },
  } as unknown as LuaTable);

  compileTrig(mission);
  const first = JSON.stringify(mission["trig"]);
  compileTrig(mission);
  compileTrig(mission);
  assert.equal(JSON.stringify(mission["trig"]), first);
});

test("changing a trigger type rewires func and funcStartup instead of leaving both", () => {
  const rule = {
    predicate: "triggerStart",
    rules: {},
    actions: { 1: { predicate: "a_set_flag", flag: 1 } },
  } as unknown as LuaTable;
  const mission = missionWithRuleAt(1, rule);

  compileTrig(mission);
  let trig = mission["trig"] as unknown as Record<string, LuaTable>;
  assert.ok(trig.funcStartup[1]);
  assert.equal(trig.func[1], undefined);

  rule["predicate"] = "triggerContinious";
  compileTrig(mission);
  trig = mission["trig"] as unknown as Record<string, LuaTable>;
  assert.equal(trig.funcStartup[1], undefined);
  assert.ok(trig.func[1]);
});

test("every compiled trig string is syntactically valid Lua", () => {
  // These strings only ever run inside DCS, where a syntax error is silent: the
  // trigger simply never fires. Parse them here instead.
  for (const oracleCase of oracle.rules) {
    const rules: LuaTable = {};
    oracleCase.rules.forEach((r, i) => (rules[i + 1] = r as LuaTable));
    const actions: LuaTable = {};
    oracleCase.actions.forEach((a, i) => (actions[i + 1] = a as LuaTable));
    const { trig } = compileOne(oracleCase.index, {
      predicate: oracleCase.type,
      rules,
      actions,
    } as unknown as LuaTable);

    const label = `${oracleCase.type}[${oracleCase.index}]`;
    // `conditions` and `funcStartup`/`func` are function bodies in DCS, so wrap
    // them the same way DCS does before parsing.
    const snippets: [string, string][] = [
      [`${label} conditions`, `local f = function() ${trig.conditions[oracleCase.index]} end`],
      [`${label} actions`, `local f = function() ${trig.actions[oracleCase.index]} end`],
    ];
    const wiring = trig.func[oracleCase.index] ?? trig.funcStartup[oracleCase.index];
    snippets.push([`${label} wiring`, `local f = function() ${wiring} end`]);

    for (const [name, source] of snippets) {
      assert.doesNotThrow(
        () => luaparse.parse(source, { luaVersion: "5.3", comments: false, scope: false }),
        `Lua syntax error in ${name}: ${source.slice(0, 200)}`
      );
    }
  }
});

test("message text with quotes and newlines stays valid Lua once compiled", () => {
  const mission = { trigrules: {} } as unknown as LuaTable;
  const dictionary: LuaTable = {};
  addTrigger(
    mission,
    {
      type: "once",
      conditions: [{ kind: "time_after", seconds: 1 }],
      // No dictionary indirection would put this straight into the Lua source.
      actions: [{ kind: "message", text: 'He said "break left"\nnow!\\' }],
    },
    dictionary
  );
  const trig = mission["trig"] as unknown as Record<string, LuaTable>;
  assert.doesNotThrow(() =>
    luaparse.parse(`local f = function() ${trig.actions[1]} end`, { luaVersion: "5.3" })
  );
  // The text itself lives in the dictionary, verbatim.
  assert.equal(dictionary["DictKey_ActionText_1"], 'He said "break left"\nnow!\\');
});

test("authored triggers reference DCS ids, not names, and survive a round-trip", () => {
  const mission = {
    coalition: { blue: { name: "blue", country: {} } },
    triggers: { zones: {} },
    trigrules: {},
  } as unknown as LuaTable;
  const dictionary: LuaTable = {};

  addAircraftGroup(mission, "plane", {
    side: "blue", country: "USA", name: "Reserve Flight", type: "F-16C_50", count: 1, x: 0, y: 0,
  });
  addTriggerZone(mission, { name: "Kill Box", x: 1000, y: 2000, radius: 8000 });

  addTrigger(
    mission,
    {
      type: "change",
      comment: "reserves on contact",
      conditions: [
        { kind: "part_of_coalition_in_zone", coalition: "red", zone: "Kill Box", unitType: "AIRPLANE" },
        { kind: "flag_is_false", flag: 7 },
      ],
      actions: [
        { kind: "activate_group", group: "Reserve Flight" },
        { kind: "message_to_coalition", coalition: "blue", text: "Reserves inbound", seconds: 20 },
        { kind: "set_flag", flag: 7 },
      ],
    },
    dictionary
  );

  const reparsed = parseLuaAssignment(serializeLuaAssignment("mission", mission), "mission");
  const trig = reparsed["trig"] as unknown as Record<string, LuaTable>;
  const zoneId = (reparsed["triggers"] as any).zones[1].zoneId;
  const groupId = (reparsed["coalition"] as any).blue.country[1].plane.group[1].groupId;

  assert.equal(
    trig.conditions[1],
    `return(c_part_of_coalition_in_zone("red", ${zoneId}, "AIRPLANE") and c_flag_is_false(7) )`
  );
  assert.equal(
    trig.actions[1],
    `a_activate_group(${groupId});` +
      `a_out_text_delay_s("blue", getValueDictByKey("DictKey_ActionText_1"), 20, false, 0);` +
      `a_set_flag(7);`
  );
  // 'change' is triggerFront, which latches through trig.flag.
  assert.match(String(trig.func[1]), /if not mission\.trig\.flag\[1\] then/);
  assert.equal(dictionary["DictKey_ActionText_1"], "Reserves inbound");
});
