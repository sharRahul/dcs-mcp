/**
 * Build the 0.6.x verification mission: one flight that exercises everything
 * added since 0.6.0 which has never been near DCS.
 *
 * What it is for, item by item (the pending lists in docs/verification.md):
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
 *   node scripts/build-verify-mission.mjs [outputPath]
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { newSession, saveSessionAs, refresh } from "../dist/miz/sessions.js";
import {
  addAircraftGroup,
  addGroundGroup,
  addTrigger,
  addTriggerZone,
  addWaypoint,
  setBriefing,
  setGroupTask,
  setPayload,
} from "../dist/miz/authoring.js";
import { addStatic, updateGroup } from "../dist/miz/editing.js";
import { findSiteTemplate } from "../dist/miz/templates.js";
import { addReactiveSpawn } from "../dist/miz/reactive.js";
import { addTrain } from "../dist/miz/trains.js";
import { makeTroopTransport } from "../dist/miz/transport.js";
import { addDrawing } from "../dist/miz/drawings.js";
import { loadScripts, resolveFrameworkPath } from "../dist/miz/frameworks.js";
import { validateMission } from "../dist/miz/validator.js";
import { learnedTypes, enableLearnedTypes } from "../dist/dcs/mission-learned.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
  "DCS-MCP 0.6.x verification",
  [
    "Nothing to shoot. This mission exists to prove that what dcs-mcp writes is what DCS runs.",
    "",
    "Fly east. Crossing INGRESS fires a reactive wave; killing the SA-2 fires a second one.",
    "Both log through DCSMCP.trig, so dcs.log shows whether each trigger fired AND whether its",
    "actions ran. An F10 map mark, an icon drawing and eight smoke presets need a human to look.",
  ].join("\n"),
  { blue: "Cross INGRESS, kill the SA-2, land. Then read dcs.log." }
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
setPayload(s.mission, "Verify-1", {
  fuel: 3249, flare: 60, chaff: 60, gun: 100,
  pylons: [
    { pylon: 3, CLSID: "{B06DD79A-F21E-4EB9-BD9D-AB3844618C93}" }, // AGM-88C
    { pylon: 7, CLSID: "{B06DD79A-F21E-4EB9-BD9D-AB3844618C93}" },
    { pylon: 10, CLSID: "{AN_ASQ_213}" },                          // HTS pod
    { pylon: 4, CLSID: "{F376DBEE-4CAE-41BA-ADD9-B2910AC95DEC}" },
    { pylon: 6, CLSID: "{F376DBEE-4CAE-41BA-ADD9-B2910AC95DEC}" },
  ],
});
addWaypoint(s.mission, "Verify", { x: 66950, y: -252874, altitudeMetres: 6000, speedMps: 220, name: "MIKE" });
addWaypoint(s.mission, "Verify", { x: 55756, y: -146736, altitudeMetres: 6000, speedMps: 220, name: "KILO" });

// --------------------------------------------------------------------------
// Red: one SA-2 site to kill (coordinates from the Skynet demo mission).
// --------------------------------------------------------------------------
// A site id is resolved to a composition the same way the MCP tool does it;
// passing the id straight to addGroundGroup would have built an empty group.
const sa2 = findSiteTemplate("SA-2");
addGroundGroup(s.mission, "vehicle", {
  side: "red", country: "Russia", name: "SAM-SA2-Verify",
  composition: sa2.composition, offsets: sa2.offsets,
  x: 66950, y: -252874, heading: 187, spacingMetres: sa2.spacingMetres,
});
checks.push("SA-2 site placed from the built-in template (provenance engaged)");

addTriggerZone(s.mission, { name: "INGRESS", x: 63000, y: -290000, radius: 12000 });
addTriggerZone(s.mission, { name: "SA2ZONE", x: 66950, y: -252874, radius: 15000 });

// --------------------------------------------------------------------------
// Reactive spawns: the two waves, both late-activated.
// --------------------------------------------------------------------------
addGroundGroup(s.mission, "vehicle", {
  side: "red", country: "Russia", name: "Wave1-Armour", type: "T-72B", count: 3,
  x: 65256, y: -250053, heading: 90, spacingMetres: 25,
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
    label: "T-Wave2-SamDead",
    trigger: { on: "group_dead", group: "SAM-SA2-Verify" },
    activate: ["Wave2-CAP"],
    aiTasks: [{ group: "Wave2-CAP", taskNumber: 1 }],
    message: { text: "VERIFY: wave 2 + AI TASK PUSH on SA-2 dead", coalition: "blue", seconds: 20 },
    setFlag: FLAG_SITE_DEAD,
    delaySeconds: 20,
  },
  s.dictionary
);
checks.push(`reactive wave 2 on group_dead, 20 s delay (flag ${wave2.delayFlag}) -> triggers ${wave2.triggers.join(",")}`);
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
// A train, on points taken from the demo mission's road-side positions. Without
// a live roads query these are NOT rail-snapped, which is the known limitation:
// the point of the test is whether DCS and the editor accept the group shape.
// --------------------------------------------------------------------------
addTrain(s.mission, {
  name: "Verify-Train", side: "red", country: "Russia",
  path: [
    { x: 58322, y: -186826 },
    { x: 57347, y: -169663 },
  ],
  headingDegrees: 10, speedKph: 40, count: 1,
});
checks.push("train: vehicle group of Train units with On Railroads route points");

// --------------------------------------------------------------------------
// A troop lift: helicopter picks up infantry at waypoint 2, drops at 3.
// --------------------------------------------------------------------------
addAircraftGroup(s.mission, "helicopter", {
  side: "blue", country: "USA", name: "Lift", type: "UH-1H", count: 1,
  x: 64000, y: -251000, altitudeMetres: 300, task: "Transport",
});
addWaypoint(s.mission, "Lift", { x: 65256, y: -250053, altitudeMetres: 150, speedMps: 50 });
addWaypoint(s.mission, "Lift", { x: 66950, y: -252874, altitudeMetres: 150, speedMps: 50 });
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
for (const name of ["mist", "moose"]) {
  try {
    scripts.push({ framework: name, filePath: await resolveFrameworkPath(name) });
  } catch (error) {
    skipped.push(`framework ${name}: ${error.message.slice(0, 90)}`);
  }
}
scripts.push({ filePath: path.join(REPO, "scripts", "dcs-mcp-telemetry.lua") });
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
console.log(`\nlaunch: "H:\\DCS World\\Eagle Dynamics\\DCS World\\bin\\DCS.exe" --force_disable_VR --no-launcher "${saved.outPath}"`);
if (errors.length) process.exitCode = 1;
