/**
 * Runtime verification of authored triggers.
 *
 * The oracle tests prove our compiled `mission.trig` strings match what the DCS
 * Mission Editor writes. This one goes further: it builds a mission, then loads
 * and RUNS its triggers under the Lua interpreter DCS itself ships (`luae.exe`,
 * Lua 5.1) with mocked `c_*`/`a_*` predicates, so the compiled strings are proven
 * to load, evaluate and dispatch — not merely to look right.
 *
 * Discovers DCS from its logged install path or DCS_INSTALL_DIR. Set DCS_LUA
 * to override with `<DCS>/bin/luae.exe` (or `bin-mt/luae.exe`).
 */
import { findDcsLua } from './helpers/dcs-lua.js';
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { addAircraftGroup, addGroundGroup, addTrigger, addTriggerZone } from "../src/miz/authoring.js";
import { loadScripts } from "../src/miz/frameworks.js";
import { serializeLuaAssignment } from "../src/miz/serializer.js";
import type { LuaTable } from "../src/miz/lua.js";


const HARNESS = fileURLToPath(new URL("./fixtures/trig-runtime.lua", import.meta.url));

/** A mission exercising all four trigger types against real ids. */
function buildMission(): { mission: LuaTable; dictionary: LuaTable } {
  const mission = {
    coalition: { blue: { name: "blue", country: {} }, red: { name: "red", country: {} } },
    triggers: { zones: {} },
    trigrules: {},
  } as unknown as LuaTable;
  const dictionary: LuaTable = {};

  addAircraftGroup(mission, "plane", {
    side: "blue", country: "USA", name: "Uzi 1", type: "FA-18C_hornet", count: 2, x: 0, y: 0,
  });
  addAircraftGroup(mission, "plane", {
    side: "red", country: "Russia", name: "Bandit 1", type: "MiG-29S", count: 2, x: 5000, y: 5000,
  });
  addGroundGroup(mission, "vehicle", {
    side: "red", country: "Russia", name: "SAM Site", type: "S-300PS 40B6M tr", count: 1, x: 4000, y: 4000,
  });
  addTriggerZone(mission, { name: "Kill Box", x: 4000, y: 4000, radius: 20000 });

  addTrigger(mission, {
    type: "start",
    comment: "startup flag",
    conditions: [],
    actions: [{ kind: "set_flag", flag: 1 }],
  }, dictionary);

  addTrigger(mission, {
    type: "once",
    comment: "brief",
    conditions: [{ kind: "time_after", seconds: 10 }],
    actions: [{ kind: "message", text: "Cleared to engage.", seconds: 20 }],
  }, dictionary);

  addTrigger(mission, {
    type: "once",
    comment: "reserves",
    conditions: [
      { kind: "part_of_coalition_in_zone", coalition: "blue", zone: "Kill Box", unitType: "AIRPLANE" },
      { kind: "flag_is_false", flag: 10 },
    ],
    actions: [
      { kind: "activate_group", group: "Bandit 1" },
      { kind: "message_to_coalition", coalition: "blue", text: "Bandits airborne!" },
      { kind: "set_flag", flag: 10 },
    ],
  }, dictionary);

  addTrigger(mission, {
    type: "change",
    comment: "sam down",
    conditions: [{ kind: "group_dead", group: "SAM Site" }],
    actions: [
      { kind: "smoke", zone: "Kill Box", preset: 1 },
      { kind: "end_mission", winner: "blue", delaySeconds: 30 },
    ],
  }, dictionary);

  addTrigger(mission, {
    type: "continuous",
    comment: "heartbeat",
    conditions: [{ kind: "flag_is_true", flag: 10 }],
    actions: [{ kind: "message_to_group", group: "Uzi 1", text: "Fight's on." }],
  }, dictionary);

  return { mission, dictionary };
}

const SCENARIO = `
runStartup()

tick(5)                       -- nothing yet: the brief waits for t=10
assert(#world.log == 1, "startup trigger did not run exactly once: " .. #world.log)

tick(15)                      -- brief fires
tick(25)                      -- ...and the triggerOnce must have disarmed itself

world.inZone["blue:1"] = true
tick(30)                      -- reserves activate, flag 10 set
tick(40)                      -- reserves must not re-fire

world.dead["g3"] = true
tick(50)                      -- 'change' trigger fires on the transition
tick(60)                      -- ...and latches while the condition stays true
world.dead["g3"] = false
tick(70)
world.dead["g3"] = true
tick(80)                      -- re-arms and fires again
`;

const lua = findDcsLua();

/** Run a mission + scenario through the DCS-Lua harness and return its output. */
function runUnderDcsLua(
  mission: LuaTable,
  dictionary: LuaTable,
  scenario: string
): { log: { time: string; entry: string }[]; scripts: string[]; output: string } {
  const dir = mkdtempSync(join(tmpdir(), "dcs-trig-rt-"));
  const missionPath = join(dir, "mission.lua");
  const dictPath = join(dir, "dictionary.lua");
  const scenarioPath = join(dir, "scenario.lua");
  writeFileSync(missionPath, serializeLuaAssignment("mission", mission), "utf8");
  writeFileSync(dictPath, serializeLuaAssignment("dictionary", dictionary), "utf8");
  writeFileSync(scenarioPath, scenario, "utf8");

  const run = spawnSync(lua!, [HARNESS, missionPath, dictPath, scenarioPath], { encoding: "utf8" });
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  assert.equal(run.status, 0, `DCS Lua run failed:\n${output}`);
  assert.match(output, /DONE/, `harness did not finish:\n${output}`);

  const log: { time: string; entry: string }[] = [];
  const scripts: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const m = /^LOG \d+ (\S+) (.*)$/.exec(line);
    if (m) log.push({ time: m[1], entry: m[2] });
    const s = /^SCRIPT \d+ (.*)$/.exec(line);
    if (s) scripts.push(s[1]);
  }
  return { log, scripts, output };
}

test(
  "authored triggers load and run correctly under the DCS Lua interpreter",
  { skip: lua ? false : "no DCS Lua interpreter found; set DCS_LUA to <DCS>/bin-mt/luae.exe" },
  () => {
    const { mission, dictionary } = buildMission();
    const dir = mkdtempSync(join(tmpdir(), "dcs-trig-rt-"));
    const missionPath = join(dir, "mission.lua");
    const dictPath = join(dir, "dictionary.lua");
    const scenarioPath = join(dir, "scenario.lua");
    writeFileSync(missionPath, serializeLuaAssignment("mission", mission), "utf8");
    writeFileSync(dictPath, serializeLuaAssignment("dictionary", dictionary), "utf8");
    writeFileSync(scenarioPath, SCENARIO, "utf8");

    const run = spawnSync(lua!, [HARNESS, missionPath, dictPath, scenarioPath], { encoding: "utf8" });
    const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
    assert.equal(run.status, 0, `DCS Lua run failed:\n${output}`);
    assert.match(output, /DONE/, `harness did not finish:\n${output}`);

    // Group by sim time: which triggers fire in a given tick is what matters,
    // not the order Lua's `pairs` happens to walk them in.
    const byTime = new Map<string, string[]>();
    for (const line of output.split(/\r?\n/)) {
      const m = /^LOG \d+ (\S+) (.*)$/.exec(line);
      if (!m) continue;
      (byTime.get(m[1]) ?? byTime.set(m[1], []).get(m[1])!).push(m[2]);
    }
    for (const entries of byTime.values()) entries.sort();

    assert.deepEqual(
      Object.fromEntries([...byTime].map(([t, e]) => [t, e])),
      {
        // triggerStart runs once, before any tick.
        "0": ["set_flag:1"],
        // t=5: nothing is due yet, so there is no entry at all.
        // triggerOnce at t>=10; ticking again at 25 must not repeat it.
        "15": ["text:Cleared to engage."],
        // Zone entry: reserves activate once, and the continuous heartbeat
        // starts as soon as flag 10 is set.
        "30": ["activate_group:2", "set_flag:10", "text_g:1:Fight's on.", "text_s:blue:Bandits airborne!"],
        "40": ["text_g:1:Fight's on."],
        // The SAM dies: triggerFront fires on the transition.
        "50": ["end_mission:coalition.side.BLUE+30", "smoke:1:1", "text_g:1:Fight's on."],
        // Condition stays true, so triggerFront stays latched.
        "60": ["text_g:1:Fight's on."],
        "70": ["text_g:1:Fight's on."],
        // False then true again: triggerFront re-arms and fires once more.
        "80": ["end_mission:coalition.side.BLUE+30", "smoke:1:1", "text_g:1:Fight's on."],
      },
      `unexpected trigger behaviour:\n${output}`
    );
  }
);

test(
  "an authored mission survives the Mission Editor's load-time fixups",
  { skip: lua ? false : "no DCS Lua interpreter found; set DCS_LUA to <DCS>/bin-mt/luae.exe" },
  () => {
    // Regression: authored groups used to get `route = { points = {} }`, and the
    // editor's `fixUnitsPos` indexes `points[1]` unconditionally — so opening the
    // mission failed with "attempt to index field '?' (a nil value)" and took the
    // whole mission with it. Every group must have a first route point.
    const { mission } = buildMission();
    const harness = fileURLToPath(new URL("./fixtures/me-open.lua", import.meta.url));
    const dir = mkdtempSync(join(tmpdir(), "dcs-me-open-"));
    const missionPath = join(dir, "mission.lua");
    writeFileSync(missionPath, serializeLuaAssignment("mission", mission), "utf8");

    const run = spawnSync(lua!, [harness, missionPath], { encoding: "utf8" });
    const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
    assert.equal(run.status, 0, `Mission Editor load would fail:\n${output}`);
    assert.match(output, /ME_LOAD_OK/, output);
    assert.match(output, /GROUPS 3/, output);

    // And the same harness must still catch the original defect.
    const broken = JSON.parse(JSON.stringify(mission)) as any;
    broken.coalition.blue.country[1].plane.group[1].route.points = {};
    const brokenPath = join(dir, "broken.lua");
    writeFileSync(brokenPath, serializeLuaAssignment("mission", broken), "utf8");
    const brokenRun = spawnSync(lua!, [harness, brokenPath], { encoding: "utf8" });
    assert.notEqual(brokenRun.status, 0, "an empty route should fail the editor's fixups");
    assert.match(
      `${brokenRun.stdout ?? ""}${brokenRun.stderr ?? ""}`,
      /ME_LOAD_FAILED.*attempt to index/,
      "expected the editor's nil-index failure"
    );
  }
);

test(
  "a radio menu item raises its flag and drives another trigger, under DCS Lua",
  { skip: lua ? false : "no DCS Lua interpreter found; set DCS_LUA to <DCS>/bin-mt/luae.exe" },
  () => {
    const mission = {
      coalition: { blue: { name: "blue", country: {} } },
      triggers: { zones: {} },
      trigrules: {},
    } as unknown as LuaTable;
    const dictionary: LuaTable = {};

    addAircraftGroup(mission, "plane", {
      side: "blue", country: "USA", name: "Uzi 1", type: "FA-18C_hornet", count: 1, x: 0, y: 0,
    });

    // Mission start builds the F10 menu.
    addTrigger(mission, {
      type: "start",
      comment: "build radio menu",
      conditions: [],
      actions: [
        { kind: "add_radio_item", text: "Request CAS", flag: 20, value: 1 },
        { kind: "add_radio_item_for_group", group: "Uzi 1", text: "Request tanker", flag: 21, value: 1 },
      ],
    }, dictionary);

    // Picking "Request CAS" raises flag 20, which this trigger reacts to and
    // then tears the menu entry down so it cannot be picked twice.
    addTrigger(mission, {
      type: "once",
      comment: "CAS requested",
      conditions: [{ kind: "flag_is_true", flag: 20 }],
      actions: [
        { kind: "message_to_coalition", coalition: "blue", text: "CAS is inbound." },
        { kind: "remove_radio_item", text: "Request CAS" },
      ],
    }, dictionary);

    addTrigger(mission, {
      type: "once",
      comment: "tanker requested",
      conditions: [{ kind: "flag_is_true", flag: 21 }],
      actions: [{ kind: "message_to_group", group: "Uzi 1", text: "Texaco on station." }],
    }, dictionary);

    const { log } = runUnderDcsLua(mission, dictionary, `
runStartup()
tick(5)                       -- menu exists, nothing picked yet
pickRadioItem("Request CAS")
tick(10)
tick(15)                      -- the once-trigger must not fire again
pickRadioItem("Request tanker")
tick(20)
`);

    const entries = log.map((l) => l.entry);
    assert.deepEqual(entries, [
      // Start trigger builds the menu.
      "radio_item+:Request CAS",
      "radio_item_g+:1:Request tanker",
      // Player picks CAS -> flag 20 -> message, then the item is removed.
      "PICK:Request CAS",
      "text_s:blue:CAS is inbound.",
      "radio_item-:Request CAS",
      // Player picks the group item -> flag 21 -> group-only message.
      "PICK:Request tanker",
      "text_g:1:Texaco on station.",
    ], `unexpected radio-menu behaviour:\n${log.map((l) => l.time + " " + l.entry).join("\n")}`);
  }
);

test(
  "framework scripts run at mission start in dependency order, under DCS Lua",
  { skip: lua ? false : "no DCS Lua interpreter found; set DCS_LUA to <DCS>/bin-mt/luae.exe" },
  async () => {
    const mission = { trigrules: {} } as unknown as LuaTable;
    const mapResource: LuaTable = {};
    const dictionary: LuaTable = {};
    const files = new Map<string, Buffer>();

    const dir = mkdtempSync(join(tmpdir(), "dcs-fw-rt-"));
    const write = (name: string, body: string) => {
      const p = join(dir, name);
      writeFileSync(p, body, "utf8");
      return p;
    };

    // Requested out of order and without mist: the loader must fix both.
    await loadScripts({ mission, mapResource, files }, dictionary, [
      { framework: "mist", filePath: write("mist_4_5_126.lua", "mist = {}\n") },
      { framework: "skynet", filePath: write("skynet-iads-compiled.lua", "SkynetIADS = {}\n") },
      { filePath: write("setup.lua", "SkynetIADS.create()\n") },
    ]);

    const { log, scripts } = runUnderDcsLua(mission, dictionary, `
runStartup()
tick(1)
`);

    // Loads happen at startup, in one trigger, in order — and only once.
    assert.deepEqual(
      scripts,
      ["ResKey_Action_1", "ResKey_Action_2", "ResKey_Action_3"],
      "framework load order is wrong"
    );
    assert.deepEqual(
      scripts.map((k) => mapResource[k]),
      ["mist_4_5_126.lua", "skynet-iads-compiled.lua", "setup.lua"]
    );
    assert.equal(log.length, 3, "scripts should load exactly once, at startup");
    assert.ok(log.every((l) => l.time === "0"), "scripts must load before the first tick");
  }
);

test('unit sound dispatches the selected numeric ID and delay under DCS Lua', { skip: lua ? false : 'no DCS Lua interpreter found' }, () => {
  const { mission, dictionary } = buildMission();
  addTrigger(mission, { type: 'once', conditions: [{ kind: 'time_after', seconds: 2 }], actions: [
    { kind: 'sound_to_unit', unit: 'Uzi 1-2', resourceKey: 'ResKey_Action_Test', delaySeconds: 3 },
  ] }, dictionary);
  const { log } = runUnderDcsLua(mission, dictionary, 'tick(2)\ntick(3)');
  assert.deepEqual(log.filter(l => l.entry.startsWith('sound_u:')), [{ time: '2', entry: 'sound_u:2:ResKey_Action_Test:3' }]);
});
