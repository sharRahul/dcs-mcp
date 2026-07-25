/**
 * Build the DCS-MCP end-to-end test mission (Persian Gulf, F-16C SEAD).
 *
 * Drives the same functions the MCP tools call, so what this produces is what a
 * client asking for the same mission over MCP would get.
 *
 * Ground placements are NOT invented. Every red ground position is lifted from
 * the Mission-Editor-saved Skynet demo mission that ships with Skynet-IADS 3.3.0
 * (`demo-missions/skynet-test-persian-gulf.miz`), so each one is a coordinate
 * the editor itself put a vehicle on — i.e. known land. The embedded telemetry
 * script re-checks every one of them against DCS's own `land.getSurfaceType` at
 * run time, because "the editor allowed it" is evidence, not proof.
 *
 *   node scripts/build-e2e-mission.mjs [outputPath]
 */
import path from "node:path";
import { newSession, saveSessionAs, refresh } from "../dist/miz/sessions.js";
import {
  addAircraftGroup,
  addGroundGroup,
  addTriggerZone,
  addTrigger,
  addWaypoint,
  setPayload,
  setGroupTask,
  setWeather,
  setBriefing,
} from "../dist/miz/authoring.js";
import { loadScripts, resolveFrameworkPath } from "../dist/miz/frameworks.js";
import { validateMission } from "../dist/miz/validator.js";

const REPO = path.resolve(import.meta.dirname, "..");
const SAVED = path.join(process.env.USERPROFILE, "Saved Games", "DCS");
const OUT = process.argv[2] ?? path.join(SAVED, "Missions", "dcs-mcp-e2e-persian-gulf.miz");

// Flags the mission uses. Named here so the triggers below read as intent.
const FLAG_SITREP_REQUESTED = 100;
const FLAG_INGRESS = 10;
const FLAG_SA2_DOWN = 20;
const FLAG_SA6_DOWN = 21;

const s = newSession("PersianGulf", 8 * 3600); // 08:00 local

setBriefing(
  s.mission,
  "DCS-MCP E2E: REDLINE SEAD",
  [
    "SEAD sweep west-to-east along the REDLINE air defence belt, Persian Gulf.",
    "",
    "Airborne start, angels 20, heading 090. Three radar-guided threats sit between you",
    "and the northern EWR chain, netted together by a Skynet IADS:",
    "",
    "  1. SA-2 'MIKE'  - southern gate. Goes live at 70% of search range, so expect an",
    "                    early launch warning rather than a late surprise.",
    "  2. SA-8 'LIMA'  - short range pop-up between the gates. Mobile, no warning.",
    "  3. SA-6 'KILO'  - the objective. Reacts to every HARM you shoot at it.",
    "",
    "Mission ends when both MIKE and KILO are destroyed. Hard time limit 90 minutes.",
    "",
    "F10 -> Other -> 'MCP: IADS SITREP' reports the live IADS state at any time.",
    "This mission is instrumented: every trigger firing, event and IADS state change",
    "is written to Saved Games/DCS/Logs/dcs.log with a [DCSMCP] prefix.",
  ].join("\n")
);

setWeather(s.mission, {
  temperatureCelsius: 32,
  qnhMmHg: 760,
  cloudBaseMetres: 3000,
  windGroundSpeed: 3,
  windGroundDir: 270,
});

// --------------------------------------------------------------------------
// Red: the REDLINE IADS. Coordinates are ME ground truth (see file header).
// Group names carry the prefixes Skynet matches on: 'SAM' for sites (group
// name), 'EW' for early warning (unit name).
// --------------------------------------------------------------------------
const red = { side: "red", country: "Russia", skill: "High" };

addGroundGroup(s.mission, "vehicle", {
  ...red, name: "EW-North", type: "55G6 EWR", count: 1,
  x: 37765, y: -144345, heading: 0,
});

addGroundGroup(s.mission, "vehicle", {
  ...red, name: "SAM-SA-6-Kilo", type: "Kub 1S91 str", count: 1,
  x: 55756, y: -146736, heading: 344, spacingMetres: 70,
  composition: [
    { type: "Kub 1S91 str", count: 1 },
    { type: "Kub 2P25 ln", count: 3 },
  ],
});

addGroundGroup(s.mission, "vehicle", {
  ...red, name: "EW-South", type: "1L13 EWR", count: 1,
  x: 57347, y: -169663, heading: 45,
});

addGroundGroup(s.mission, "vehicle", {
  ...red, name: "SAM-SA-8-Lima", type: "Osa 9A33 ln", count: 2,
  x: 58322, y: -186826, heading: 163, spacingMetres: 50,
});

addGroundGroup(s.mission, "vehicle", {
  ...red, name: "SAM-SA-2-Mike", type: "p-19 s-125 sr", count: 1,
  x: 66950, y: -252874, heading: 187, spacingMetres: 90,
  composition: [
    { type: "p-19 s-125 sr", count: 1 },
    { type: "SNR_75V", count: 1 },
    { type: "S_75M_Volhov", count: 4 },
  ],
});

// Not part of the IADS: a plain road convoy, here to prove that a group's units
// line up along its heading instead of trailing off to the north-east.
addGroundGroup(s.mission, "vehicle", {
  ...red, skill: "Average", name: "Convoy-Redline", type: "Ural-375", count: 4,
  x: 65256, y: -250053, heading: 90, spacingMetres: 25,
});

// --------------------------------------------------------------------------
// Blue: the player.
// --------------------------------------------------------------------------
addAircraftGroup(s.mission, "plane", {
  side: "blue", country: "USA", name: "Viper", type: "F-16C_50", count: 1,
  x: 62000, y: -310000, altitudeMetres: 6000, heading: 90,
  skill: "Player", task: "SEAD",
});
setGroupTask(s.mission, "Viper", "SEAD");

// The SEAD loadout is copied from a working F-16C SEAD flight in an existing
// Persian Gulf mission on this install: HARMs on 3/7, HTS pod on 10. CLSIDs are
// not validated offline, so taking them from a mission that flies is the only
// way to be sure they are real.
setPayload(s.mission, "Viper-1", {
  fuel: 3249,
  flare: 60,
  chaff: 60,
  gun: 100,
  pylons: [
    { pylon: 1, CLSID: "{40EF17B7-F508-45de-8566-6FFECC0C1AB8}" },
    { pylon: 2, CLSID: "{5CE2FF2A-645A-4197-B48D-8720AC69394F}" },
    { pylon: 3, CLSID: "{B06DD79A-F21E-4EB9-BD9D-AB3844618C93}" }, // AGM-88C
    { pylon: 4, CLSID: "{F376DBEE-4CAE-41BA-ADD9-B2910AC95DEC}" },
    { pylon: 6, CLSID: "{F376DBEE-4CAE-41BA-ADD9-B2910AC95DEC}" },
    { pylon: 7, CLSID: "{B06DD79A-F21E-4EB9-BD9D-AB3844618C93}" }, // AGM-88C
    { pylon: 8, CLSID: "{5CE2FF2A-645A-4197-B48D-8720AC69394F}" },
    { pylon: 9, CLSID: "{40EF17B7-F508-45de-8566-6FFECC0C1AB8}" },
    { pylon: 10, CLSID: "{AN_ASQ_213}" }, // HTS pod - without it there is no SEAD
    { pylon: 11, CLSID: "{A111396E-D3E8-4b9c-8AC9-2432489304D5}" },
  ],
});

addWaypoint(s.mission, "Viper", { x: 66950, y: -252874, altitudeMetres: 6000, speedMps: 220, name: "MIKE" });
addWaypoint(s.mission, "Viper", { x: 58322, y: -186826, altitudeMetres: 6000, speedMps: 220, name: "LIMA" });
addWaypoint(s.mission, "Viper", { x: 55756, y: -146736, altitudeMetres: 6000, speedMps: 220, name: "KILO" });

// --------------------------------------------------------------------------
// Zones
// --------------------------------------------------------------------------
addTriggerZone(s.mission, { name: "IngressZone", x: 63000, y: -290000, radius: 12000 });
addTriggerZone(s.mission, { name: "SA2-Zone", x: 66950, y: -252874, radius: 15000 });
addTriggerZone(s.mission, { name: "TargetZone", x: 55756, y: -146736, radius: 12000 });

// --------------------------------------------------------------------------
// Scripts. ONE start trigger, dependency order: MIST -> MOOSE -> Skynet, then
// telemetry (which the setup script logs through), then setup.
// --------------------------------------------------------------------------
const frameworks = ["mist", "moose", "skynet"];
const scripts = [];
for (const f of frameworks) scripts.push({ framework: f, filePath: await resolveFrameworkPath(f) });
scripts.push({ filePath: path.join(REPO, "scripts", "dcs-mcp-telemetry.lua") });
scripts.push({ filePath: path.join(REPO, "scripts", "dcs-mcp-e2e-setup.lua") });

const { loaded, triggerIndex } = await loadScripts(s, s.dictionary, scripts);

// --------------------------------------------------------------------------
// Triggers
//
// Every trigger also calls DCSMCP.trig(), so a trigger that fired and a trigger
// that never fired are distinguishable in the log. Without it, a broken
// condition and a broken action look identical from the cockpit.
// --------------------------------------------------------------------------
const trig = (name) => ({ kind: "do_script", text: `DCSMCP.trig('${name}')` });

// 1. Message trigger, time based.
addTrigger(s.mission, {
  type: "once",
  comment: "Brief on arrival",
  conditions: [{ kind: "time_after", seconds: 15 }],
  actions: [
    {
      kind: "message_to_coalition",
      coalition: "blue",
      text: "REDLINE SEAD: three radar threats between you and the EWR chain. Push east.\nF10 > Other > 'MCP: IADS SITREP' for the live IADS picture.",
      seconds: 25,
    },
    trig("T2-Brief"),
  ],
}, s.dictionary);

// 2. Radio trigger: an F10 menu item that raises a flag.
addTrigger(s.mission, {
  type: "once",
  comment: "Radio menu: IADS SITREP",
  conditions: [],
  actions: [
    { kind: "add_radio_item", text: "MCP: IADS SITREP", flag: FLAG_SITREP_REQUESTED, value: 1 },
    trig("T3-RadioMenuAdded"),
  ],
}, s.dictionary);

// 3. The radio item's handler. Continuous + clear_flag makes it re-usable; a
//    'once' trigger here would answer the first request and then go quiet.
addTrigger(s.mission, {
  type: "continuous",
  comment: "Radio menu handler: report IADS state",
  conditions: [{ kind: "flag_is_true", flag: FLAG_SITREP_REQUESTED }],
  actions: [
    {
      kind: "do_script",
      text: [
        "local live, dark, dead = 0, 0, 0",
        "if redIADS then",
        // ipairs, not pairs: Skynet returns a delegator proxy whose extra
        // `__index` field is not a SAM site and blows up on any site method.
        "  for _, site in ipairs(redIADS:getSAMSites() or {}) do",
        "    if site:isDestroyed() then dead = dead + 1",
        "    elseif site:isActive() then live = live + 1",
        "    else dark = dark + 1 end",
        "  end",
        "end",
        "trigger.action.outTextForCoalition(coalition.side.BLUE,",
        "  string.format('IADS SITREP  live:%d  dark:%d  destroyed:%d', live, dark, dead), 20)",
        "DCSMCP.trig('T4-Sitrep', string.format('live=%d dark=%d dead=%d', live, dark, dead))",
      ].join("\n"),
    },
    { kind: "clear_flag", flag: FLAG_SITREP_REQUESTED },
  ],
}, s.dictionary);

// 4. Coalition-in-zone trigger (change type: fires on the false->true edge).
addTrigger(s.mission, {
  type: "change",
  comment: "Blue entered the ingress corridor",
  conditions: [{ kind: "part_of_coalition_in_zone", coalition: "blue", zone: "IngressZone", unitType: "AIRPLANE" }],
  actions: [
    { kind: "message_to_coalition", coalition: "blue", text: "Feet dry. MIKE's search radar is up.", seconds: 15 },
    { kind: "set_flag", flag: FLAG_INGRESS, value: 1 },
    trig("T5-Ingress"),
  ],
}, s.dictionary);

// 5. Player-unit trigger, addressed to the player's group.
addTrigger(s.mission, {
  type: "once",
  comment: "Player inside the SA-2 engagement ring",
  conditions: [{ kind: "unit_in_zone", unit: "Viper-1", zone: "SA2-Zone" }],
  actions: [
    { kind: "message_to_group", group: "Viper", text: "MIKE has you. Recommend HARM now.", seconds: 15 },
    trig("T6-InSA2Ring"),
  ],
}, s.dictionary);

// 6/7. AI group triggers.
addTrigger(s.mission, {
  type: "once",
  comment: "SA-2 MIKE destroyed",
  conditions: [{ kind: "group_dead", group: "SAM-SA-2-Mike" }],
  actions: [
    { kind: "message_to_coalition", coalition: "blue", text: "MIKE is down. Southern gate is open.", seconds: 20 },
    { kind: "set_flag", flag: FLAG_SA2_DOWN, value: 1 },
    trig("T7-Sa2Down"),
  ],
}, s.dictionary);

addTrigger(s.mission, {
  type: "once",
  comment: "SA-6 KILO destroyed",
  conditions: [{ kind: "group_dead", group: "SAM-SA-6-Kilo" }],
  actions: [
    { kind: "message_to_coalition", coalition: "blue", text: "KILO is down.", seconds: 20 },
    { kind: "set_flag", flag: FLAG_SA6_DOWN, value: 1 },
    trig("T8-Sa6Down"),
  ],
}, s.dictionary);

// 8. Win condition: both objectives, ANDed.
addTrigger(s.mission, {
  type: "once",
  comment: "Mission success",
  conditions: [
    { kind: "flag_is_true", flag: FLAG_SA2_DOWN },
    { kind: "flag_is_true", flag: FLAG_SA6_DOWN },
  ],
  actions: [
    { kind: "message_to_coalition", coalition: "blue", text: "REDLINE is broken. Both objectives destroyed. RTB.", seconds: 30 },
    trig("T9-Success"),
    { kind: "end_mission", winner: "blue", delaySeconds: 30 },
  ],
}, s.dictionary);

// 9. Hard time limit, so an unattended run always terminates.
addTrigger(s.mission, {
  type: "once",
  comment: "Time limit",
  conditions: [{ kind: "time_after", seconds: 5400 }],
  actions: [
    { kind: "message_to_coalition", coalition: "blue", text: "Time limit reached. Mission ending.", seconds: 20 },
    trig("T10-TimeLimit"),
    { kind: "end_mission", winner: "neutrals", delaySeconds: 15 },
  ],
}, s.dictionary);

// --------------------------------------------------------------------------
// Validate, then save.
// --------------------------------------------------------------------------
refresh(s);
const report = validateMission(s.document);

console.log(`theatre        : ${s.document.summary.theatre}`);
console.log(`groups         : ${s.document.summary.groupCount}`);
console.log(`zones          : ${s.document.summary.zoneCount}`);
console.log(`triggers       : ${s.document.summary.triggerCount}`);
console.log(`scripts trigger: #${triggerIndex}`);
for (const l of loaded) {
  console.log(`  load ${String(l.framework ?? "script").padEnd(8)} ${l.fileName} (${l.bytes} bytes)`);
}

const notCompiled = s.document.triggers.filter((t) => !t.compiled);
if (notCompiled.length > 0) {
  console.error(`UNCOMPILED TRIGGERS: ${notCompiled.map((t) => `#${t.index} ${t.comment}`).join(", ")}`);
}

for (const e of report.errors) console.error(`ERROR   ${e.code} ${e.message}`);
for (const w of report.warnings) console.warn(`WARNING ${w.code} ${w.message}`);

if (report.errors.length > 0 || notCompiled.length > 0) {
  console.error("refusing to save a mission with errors or uncompiled triggers");
  process.exit(1);
}

const saved = await saveSessionAs(s, OUT, true);
console.log(`saved          : ${saved.outPath}`);
console.log(`digest         : ${saved.digest}`);
