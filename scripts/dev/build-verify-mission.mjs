/**
 * Build the 0.6.x verification mission: one flight that exercises everything
 * added since 0.6.0 which has never been near DCS.
 *
 * What it is for, item by item (the pending lists in docs/development/verification.md):
 *   - reactive spawns        - a zone-entry wave and a group-dead wave, each
 *                              logging through DCSMCP.trig so a trigger that
 *                              fired is distinguishable from one that fired into
 *                              a broken action;
 *   - a_ai_task              - an AI TASK PUSH on a late-activated flight;
 *   - a_mark_to_all          - an F10 map mark, which only a human can confirm;
 *   - big_smoke presets 1-8  - eight effect statics, one per preset;
 *   - a train                - the editor's "On Railroads" route form;
 *   - a troop lift           - Embarking / EmbarkToTransport / Disembark;
 *   - an editor icon drawing - from the install's own icon picker;
 *   - a learned type         - placed only if one has been learned locally.
 *
 * Every ground coordinate is lifted from the Skynet-IADS demo mission that the
 * existing e2e mission already uses, i.e. a point the Mission Editor itself put
 * a vehicle on. The embedded telemetry script re-checks all of them against
 * DCS's own land.getSurfaceType at run time anyway.
 *
 *   node scripts/dev/build-verify-mission.mjs [outputPath]
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { newSession, saveSessionAs, refresh } from "../../dist/miz/sessions.js";
import {
  addAircraftGroup,
  addGroundGroup,
  addTrigger,
  addTriggerZone,
  addWaypoint,
  setBriefing,
  setGroupTask,
  setPayload,
} from "../../dist/miz/authoring.js";
import { addStatic, updateGroup } from "../../dist/miz/editing.js";
import { addWaypointAction } from "../../dist/miz/actions.js";
import { findSiteTemplate } from "../../dist/miz/templates.js";
import { addReactiveSpawn } from "../../dist/miz/reactive.js";
import { addTrain } from "../../dist/miz/trains.js";
import { makeTroopTransport } from "../../dist/miz/transport.js";
import { addDrawing } from "../../dist/miz/drawings.js";
import { loadScripts, resolveFrameworkPath } from "../../dist/miz/frameworks.js";
import { validateMission } from "../../dist/miz/validator.js";
import { learnedTypes, enableLearnedTypes } from "../../dist/dcs/mission-learned.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SAVED = path.join(process.env.USERPROFILE, "Saved Games", "DCS");
// The user's rule: test output goes in this folder and nowhere else.
const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const OUT = positional[0] ?? path.join(SAVED, "Missions", "VS Code Missions", "dcs-mcp-verify-0-6.miz");

const FLAG_WAVE_ARMED = 30;
const FLAG_SITE_DEAD = 31;

const s = newSession("PersianGulf", 8 * 3600);
const checks = [];
const skipped = [];

setBriefing(
  s.mission,
  "DCS Sortie MCP 0.6.x verification",
  [
    "TASK: kill the SA-2's FAN SONG tracking radar at waypoint MIKE. That ONE unit is the",
    "trigger — you do not have to flatten the battery. The site is the Mission Editor's own",
    "SA-2 layout: Fan Song at the centre, six Guideline launchers on a ring around it, P-19",
    "search radar outside, support park behind. Alarm state RED, ROE open fire, so the",
    "radars are up and it shoots back. Two AGM-88C and the HTS pod are for exactly this.",
    "",
    "THREAT: about 20 s after the Fan Song dies, two MiG-29S activate and get an AI task",
    "push. You carry two AIM-120C and two AIM-9X. Engage or run — your call.",
    "",
    "ROUTE: air start heading 090 at 6000 m. Crossing INGRESS (about 20 km ahead) fires a",
    "reactive wave of armour 7.6 km north-east of the troop LZ. Then land at Kutaisi.",
    "",
    "Both waves log through DCSMCP.trig, so dcs.log shows whether each trigger fired AND",
    "whether its actions ran. Three things no log can show, so look for them yourself:",
    "an F10 map mark, an icon drawing on the same map, and eight smoke columns by the SA-2.",
  ].join("\n"),
  { blue: "Cross INGRESS, kill the Fan Song, survive the MiGs, land. Then read dcs.log." }
);

// --------------------------------------------------------------------------
// The player.
// --------------------------------------------------------------------------
addAircraftGroup(s.mission, "plane", {
  side: "blue", country: "USA", name: "Verify", type: "F-16C_50", count: 1,
  x: 62000, y: -310000, altitudeMetres: 6000, heading: 90,
  skill: "Player", task: "SEAD",
});
setGroupTask(s.mission, "Verify", "SEAD");
// ED's own stock F-16C loadout "AIM-120C*2, AIM-9X*2, AGM-88C*2, FUEL*3, TGP, HTS",
// copied pylon for pylon out of CoreMods/aircraft/F-16C/UnitPayloads/F-16C_50.lua.
// The hand-written payload this replaces was two HARMs, the HTS and two fuel tanks
// and NOTHING air-to-air — which is unflyable the moment wave 2 arrives, because
// two MiG-29S turn up armed and the player has a gun. Do not hand-assemble a
// payload when the module ships a named one that fits.
setPayload(s.mission, "Verify-1", {
  fuel: 3249, flare: 60, chaff: 60, gun: 100,
  pylons: [
    { pylon: 1, CLSID: "{40EF17B7-F508-45de-8566-6FFECC0C1AB8}" },  // AIM-120C
    { pylon: 2, CLSID: "{5CE2FF2A-645A-4197-B48D-8720AC69394F}" },  // AIM-9X
    { pylon: 3, CLSID: "{B06DD79A-F21E-4EB9-BD9D-AB3844618C93}" },  // AGM-88C
    { pylon: 4, CLSID: "{F376DBEE-4CAE-41BA-ADD9-B2910AC95DEC}" },  // 370 gal tank
    { pylon: 5, CLSID: "{8A0BE8AE-58D4-4572-9263-3144C0D06364}" },  // 300 gal centreline
    { pylon: 6, CLSID: "{F376DBEE-4CAE-41BA-ADD9-B2910AC95DEC}" },  // 370 gal tank
    { pylon: 7, CLSID: "{B06DD79A-F21E-4EB9-BD9D-AB3844618C93}" },  // AGM-88C
    { pylon: 8, CLSID: "{5CE2FF2A-645A-4197-B48D-8720AC69394F}" },  // AIM-9X
    { pylon: 9, CLSID: "{40EF17B7-F508-45de-8566-6FFECC0C1AB8}" },  // AIM-120C
    { pylon: 10, CLSID: "{AN_ASQ_213}" },                           // HTS pod
    { pylon: 11, CLSID: "{A111396E-D3E8-4b9c-8AC9-2432489304D5}" }, // LITENING TGP
  ],
});
addWaypoint(s.mission, "Verify", { x: 66950, y: -252874, altitudeMetres: 6000, speedMps: 220, name: "MIKE" });
addWaypoint(s.mission, "Verify", { x: 55756, y: -146736, altitudeMetres: 6000, speedMps: 220, name: "KILO" });

// --------------------------------------------------------------------------
// Red: one SA-2 site to kill (coordinates from the Skynet demo mission).
// --------------------------------------------------------------------------
// A site id is resolved to a composition the same way the MCP tool does it;
// passing the id straight to addGroundGroup would have built an empty group.
// The Mission Editor's OWN template library, read from the installed DCS
// (MissionEditor/data/scripts/templates.lua). This is ED's SA-2 layout, not a
// reconstruction: Fan Song at the centre, six launchers on a 92-107 m ring each
// pointing outward along its own bearing, P-19 search radar 177 m out, and the
// power/fuel/van park behind. Falls back to the built-in if there is no install.
let sa2;
try {
  sa2 = findSiteTemplate("me-sa-2-sam-battery");
} catch {
  sa2 = findSiteTemplate("SA-2");
  skipped.push("SA-2: Mission Editor template library not readable; used the built-in template");
}
addGroundGroup(s.mission, "vehicle", {
  side: "red", country: "Russia", name: "SAM-SA2-Verify",
  composition: sa2.composition, offsets: sa2.offsets,
  headingOffsetsDegrees: sa2.headingOffsetsDegrees,
  x: 66950, y: -252874, heading: 187, spacingMetres: sa2.spacingMetres,
});
checks.push(`SA-2 from template ${sa2.id} (provenance ${sa2.provenance}): ${sa2.composition.reduce((n, c) => n + c.count, 0)} units, per-unit headings`);

// A SAM group with no ROE or alarm-state option left both at the DCS default, and in the
// flown sortie of 2026-11-17 the site never engaged the player at all — so the HARMs had
// nothing radiating to home on and the group-dead half of the test could not be reached.
// Ground ROE has no WEAPON_FREE value (that is air only): the three documented ground
// values are OPEN_FIRE, RETURN_FIRE and WEAPON_HOLD, so OPEN_FIRE is "weapons free" here.
// Alarm state RED is what puts the search and track radars up from t=0.
for (const [action, value] of [["option:alarmState", "RED"], ["option:roe", "OPEN_FIRE"]]) {
  addWaypointAction(s.mission, "SAM-SA2-Verify", 1, { action, value });
}
checks.push("SA-2 at alarm state RED, ROE open fire (it has to shoot for the test to work)");

addTriggerZone(s.mission, { name: "INGRESS", x: 63000, y: -290000, radius: 12000 });
addTriggerZone(s.mission, { name: "SA2ZONE", x: 66950, y: -252874, radius: 15000 });

// --------------------------------------------------------------------------
// Reactive spawns: the two waves, both late-activated.
// --------------------------------------------------------------------------
// The first flown run of this mission (2026-11-17) put this wave at
// (65256, -250053) — the troop lift's own pickup point. The wave activated on
// INGRESS entry exactly as intended and then shot the UH-1H down at t=60 and
// killed three of the four soldiers, so the troop lift could never be observed.
// A reactive wave must not spawn on top of anything else the mission is testing.
// (70000, -256000) is 7.6 km away, LAND, slope 0.4 deg, no scenery — all checked
// live with dcs_check_terrain and dcs_terrain_clear_spot, never assumed.
addGroundGroup(s.mission, "vehicle", {
  side: "red", country: "Russia", name: "Wave1-Armour", type: "T-72B", count: 3,
  x: 70000, y: -256000, heading: 90, spacingMetres: 25,
});
updateGroup(s.mission, "Wave1-Armour", { lateActivation: true });

addAircraftGroup(s.mission, "plane", {
  side: "red", country: "Russia", name: "Wave2-CAP", type: "MiG-29S", count: 2,
  x: 70000, y: -200000, altitudeMetres: 7000, heading: 270, task: "CAP",
});
updateGroup(s.mission, "Wave2-CAP", { lateActivation: true });

const wave1 = addReactiveSpawn(
  s.mission,
  {
    label: "T-Wave1-IngressZone",
    trigger: { on: "coalition_in_zone", zone: "INGRESS", coalition: "blue", unitType: "AIRPLANE" },
    activate: ["Wave1-Armour"],
    message: { text: "VERIFY: wave 1 activated on INGRESS entry", coalition: "blue", seconds: 20 },
    setFlag: FLAG_WAVE_ARMED,
  },
  s.dictionary
);
checks.push(`reactive wave 1 on zone entry -> trigger ${wave1.triggers.join(",")}`);

const wave2 = addReactiveSpawn(
  s.mission,
  {
    label: "T-Wave2-FanSongDead",
    // NOT group_dead. A two-HARM SEAD pass kills the radars and leaves six
    // launchers and the whole support park standing, so a whole-battery
    // condition can only be met with GBUs or CBUs that a SEAD jet is not
    // carrying — the reserve would simply never spawn. The Fan Song (unit 1 of
    // the editor's template, the origin of the ring) is the kill that matters,
    // and c_unit_dead is oracle-backed exactly like c_group_dead.
    trigger: { on: "unit_dead", unit: "SAM-SA2-Verify-1" },
    activate: ["Wave2-CAP"],
    aiTasks: [{ group: "Wave2-CAP", taskNumber: 1 }],
    message: { text: "VERIFY: wave 2 + AI TASK PUSH on Fan Song dead", coalition: "blue", seconds: 20 },
    setFlag: FLAG_SITE_DEAD,
    delaySeconds: 20,
  },
  s.dictionary
);
checks.push(`reactive wave 2 on unit_dead (Fan Song), 20 s delay (flag ${wave2.delayFlag}) -> triggers ${wave2.triggers.join(",")}`);
checks.push("a_ai_task (AI TASK PUSH) on Wave2-CAP task 1");

// --------------------------------------------------------------------------
// Trigger-side proof. DCSMCP.trig(name) is in the telemetry script, so a line
// in dcs.log means the trigger fired AND its action list actually ran.
// --------------------------------------------------------------------------
for (const [flag, name] of [[FLAG_WAVE_ARMED, "WAVE1"], [FLAG_SITE_DEAD, "WAVE2"]]) {
  addTrigger(
    s.mission,
    {
      type: "once",
      comment: `T-Log-${name}`,
      conditions: [{ kind: "flag_is_true", flag }],
      actions: [{ kind: "do_script", text: `if DCSMCP then DCSMCP.trig("${name}") end` }],
    },
    s.dictionary
  );
}

// An F10 map mark and a coalition picture-free message at mission start, so a
// human can confirm the two things no log can show.
addTrigger(
  s.mission,
  {
    type: "start",
    comment: "T-MarkToAll",
    conditions: [],
    actions: [
      { kind: "mark_to_all", id: 1, text: "VERIFY: a_mark_to_all", zone: "SA2ZONE", readonly: true, comment: "dcs-mcp" },
      { kind: "do_script", text: 'if DCSMCP then DCSMCP.trig("MARK") end' },
    ],
  },
  s.dictionary
);
checks.push("a_mark_to_all on a start trigger (needs a human to look at F10)");

// --------------------------------------------------------------------------
// Effect statics: one per preset, so every preset gets loaded at least once.
// --------------------------------------------------------------------------
for (let preset = 1; preset <= 8; preset++) {
  addStatic(s.mission, {
    side: "red", country: "Russia", name: `Smoke-P${preset}`, type: "big_smoke",
    x: 66950 + preset * 120, y: -252874 - 400,
    effectPreset: preset, effectTransparency: 1,
  });
}
checks.push("big_smoke statics, presets 1-8");

// --------------------------------------------------------------------------
// A train. The first flown run of this mission used (58322, -186826) ->
// (57347, -169663), which are road-side points, NOT rail-snapped: the nearest
// railroad is 173 km and 157 km away (measured live, dcs_terrain_roads
// kind=railroads). DCS DROPPED THE WHOLE GROUP, silently — Group.getByName
// returned nil, MOOSE's database registered every other group and not this one,
// and dcs.log did not mention the train at all. So an "On Railroads" group with
// no rails under it is not a cosmetic problem; it does not exist in the mission.
//
// These two points come off findPathOnRoads kind=railroads on the Persian Gulf's
// only railway, in the far north-east corner. They are the ends of a real
// 190-point rail path, so the group now has track to sit on.
// --------------------------------------------------------------------------
addTrain(s.mission, {
  name: "Verify-Train", side: "red", country: "Russia",
  path: [
    { x: 105077.506, y: -20206.277 },
    { x: 116618.179, y: -15338.706 },
  ],
  headingDegrees: 10, speedKph: 40, count: 1,
});
checks.push("train: vehicle group of Train units on rail-snapped On Railroads points");

// --------------------------------------------------------------------------
// A troop lift: helicopter picks up infantry at waypoint 2, drops at 3.
// --------------------------------------------------------------------------
addAircraftGroup(s.mission, "helicopter", {
  side: "blue", country: "USA", name: "Lift", type: "UH-1H", count: 1,
  x: 64000, y: -251000, altitudeMetres: 300, task: "Transport",
});
addWaypoint(s.mission, "Lift", { x: 65256, y: -250053, altitudeMetres: 150, speedMps: 50 });
// The drop used to be the SA-2 site itself, which is both a live SAM and the
// player's target. (66000, -246500) is LAND at 34.4 m, 3.6 km from the pickup.
addWaypoint(s.mission, "Lift", { x: 66000, y: -246500, altitudeMetres: 150, speedMps: 50 });
addGroundGroup(s.mission, "vehicle", {
  side: "blue", country: "USA", name: "Troops", type: "Soldier M4", count: 4,
  x: 65276, y: -250073,
});
const lift = makeTroopTransport(s.mission, { transport: "Lift", troops: "Troops", pickupWaypoint: 2, dropWaypoint: 3 });
checks.push(`troop lift wired: Embarking + EmbarkToTransport + Disembark (troop group ${lift.troopGroupId})`);

// --------------------------------------------------------------------------
// An icon drawing from the editor's own picker list.
// --------------------------------------------------------------------------
try {
  addDrawing(s.mission, {
    layer: "Blue",
    kind: "icon",
    name: "Verify-Icon",
    origin: { x: 63000, y: -290000 },
    icon: "Air Defence SAM",
    scale: 1,
  });
  checks.push("icon drawing from the install's own icon list");
} catch (error) {
  skipped.push(`icon drawing: ${error.message}`);
}

// --------------------------------------------------------------------------
// A learned type, only if one has actually been learned on this machine.
// --------------------------------------------------------------------------
enableLearnedTypes();
// A learned id is only worth flying if the mod is installed HERE - otherwise DCS
// fails the load and the test says nothing about dcs-mcp. So the type is named
// on the command line (--learned-type Su-35S) after checking the mod is present,
// and otherwise the mission simply leaves it out.
const wanted = process.argv.find((a) => a.startsWith("--learned-type="))?.split("=")[1];
const all = [...learnedTypes().values()].filter((t) => t.category === "plane");
const learned = wanted ? all.filter((t) => t.type === wanted) : [];
if (!wanted) skipped.push("learned type: pass --learned-type=<id> for a mod that IS installed here");
if (wanted && !learned.length) skipped.push(`learned type ${wanted}: not in any learned pack; run dcs_learn_mission_types first`);
if (learned.length) {
  const pick = learned[0];
  try {
    addAircraftGroup(s.mission, "plane", {
      side: "red", country: "Russia", name: "Learned-Flight", type: pick.type, count: 1,
      x: 72000, y: -210000, altitudeMetres: 8000, heading: 270, task: "CAP",
    });
    checks.push(`learned type placed: ${pick.type} (seen in ${pick.missions} missions)`);
  } catch (error) {
    skipped.push(`learned type ${pick.type}: ${error.message}`);
  }
}

// --------------------------------------------------------------------------
// Telemetry last, after the frameworks, in ONE start trigger.
// --------------------------------------------------------------------------
const scripts = [];
// Splash Damage ships in its own folder under Missions, which is not one of the
// default search roots, so that root is offered explicitly before falling back to
// auto-discovery. It is loaded after MIST and MOOSE and before the telemetry.
const SPLASH_ROOTS = [
  path.join(SAVED, "Missions", "DCSSplashDamageScript-master"),
  path.join(SAVED, "Missions", "LUA Scripts"),
  path.join(SAVED, "Scripts"),
];
for (const name of ["mist", "moose", "splash"]) {
  try {
    const roots = name === "splash" ? SPLASH_ROOTS : undefined;
    scripts.push({ framework: name, filePath: await resolveFrameworkPath(name, undefined, roots) });
  } catch (error) {
    skipped.push(`framework ${name}: ${error.message.slice(0, 90)}`);
  }
}
scripts.push({ filePath: path.join(REPO, 'runtime', 'dcs', 'dcs-mcp-telemetry.lua') });
const { loaded, triggerIndex } = await loadScripts(s, s.dictionary, scripts);
checks.push(`load-scripts start trigger ${triggerIndex} with ${loaded.length} script(s), telemetry last`);

refresh(s);
const report = validateMission(s.document, s.mission);
const errors = report.errors ?? [];
const warnings = report.warnings ?? [];

const saved = await saveSessionAs(s, OUT, { overwrite: true });

console.log(`\nwrote          : ${saved.outPath}`);
console.log(`sha256         : ${saved.digest}`);
console.log(`validator      : ${errors.length} error(s), ${warnings.length} warning(s)`);
for (const e of errors) console.log(`  ERROR ${e.code}: ${e.message}`);
const codes = new Map();
for (const w of warnings) codes.set(w.code, (codes.get(w.code) ?? 0) + 1);
if (codes.size) console.log(`  warnings: ${[...codes].map(([k, v]) => `${k}=${v}`).join(" ")}`);
console.log(`\nwhat this mission is meant to prove (${checks.length}):`);
for (const c of checks) console.log(`  + ${c}`);
if (skipped.length) {
  console.log(`\nnot in this mission (${skipped.length}):`);
  for (const sk of skipped) console.log(`  - ${sk}`);
}
console.log(`\nlaunch: "${process.env.DCS_EXE ?? "<DCS_INSTALL>/bin/DCS.exe"}" --force_disable_VR --no-launcher "${saved.outPath}"`);
if (errors.length) process.exitCode = 1;
