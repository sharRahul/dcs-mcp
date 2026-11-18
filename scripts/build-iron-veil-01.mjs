/**
 * OPERATION IRON VEIL — Mission 01, "First Contact".
 *
 * A fictional Blue/Red conflict over the Caucasus, September 2003. The player
 * is VIPER 1-1, an F-16C out of Kutaisi on a defensive CAP that turns into a
 * shooting war. Built entirely through this server's authoring API, so every
 * trigger goes through the oracle-backed compiler and every coordinate through
 * the bundled Caucasus projection.
 *
 *   node scripts/build-iron-veil-01.mjs [outputPath]
 *
 * TWO THINGS THIS MISSION DOES NOT CLAIM
 *
 * 1. There is no recorded audio. Every radio call in the design document is
 *    written as an on-screen message carrying the same text. This project does
 *    not emit a sound or radio-transmission action with no file behind it, so
 *    the transmissions are subtitles until someone records them and embeds them
 *    with dcs_miz_embed_asset.
 * 2. The ground coordinates are projected from latitude/longitude, not sampled
 *    from DCS. `land.getSurfaceType` is the only authority on land versus water
 *    and it needs a running mission, so the embedded telemetry re-checks every
 *    ground unit five seconds in and logs TERRAIN_WATER as an ERROR.
 *
 *    CHECKED LIVE, 2026-11-18, mission loaded in DCS 2.9.31: every ground unit
 *    is dry. RED_SAM_1 reports LAND at 629-635 m; RED_GROUND reports ROAD at
 *    625-630 m, which is the convoy sitting on an actual road. Move either group
 *    and that answer no longer holds — re-check it.
 *
 * The fiction is the user's. Neither coalition represents any real country's
 * actions, and the radio phraseology is cinematic rather than authentic
 * procedure.
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
  findGroup,
} from "../dist/miz/authoring.js";
import { luaArray } from "../dist/miz/lua.js";
import { updateGroup } from "../dist/miz/editing.js";
import { addWaypointAction } from "../dist/miz/actions.js";
import { findSiteTemplate } from "../dist/miz/templates.js";
import { addDrawing } from "../dist/miz/drawings.js";
import { loadScripts, resolveFrameworkPath } from "../dist/miz/frameworks.js";
import { claimStartAirfields } from "../dist/miz/logistics.js";
import { validateMission } from "../dist/miz/validator.js";
import { populateAirfield } from '../dist/miz/dressing.js';
import { populateIronVeilAirfields } from './iron-veil-airfields.mjs';
import { latLonToXY } from "../dist/miz/projection.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SAVED = path.join(process.env.USERPROFILE, "Saved Games", "DCS");
const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
// The user's rule: test output goes in this folder and nowhere else.
const OUT =
  positional[0] ??
  path.join(SAVED, "Missions", "VS Code Missions", "iron-veil-01-first-contact.miz");

const notes = [];
const skipped = [];

// --------------------------------------------------------------------------
// Geography. Airfield positions are the bundled catalogue's; everything else is
// projected from lat/lon with the Caucasus projection.
// --------------------------------------------------------------------------
const at = (lat, lon) => latLonToXY("Caucasus", lat, lon);

const KUTAISI = { x: -284887, y: 683859 }; // Blue main
const SENAKI = { x: -281783, y: 647280 }; // Blue divert
const VAZIANI = { x: -319065, y: 903149 }; // Red fighter base
const LOCHINI = { x: -315671, y: 896630 }; // Red support

const CAP_ECHO = at(42.1, 43.4); // CAP station, mid-country
const GORI = at(41.985, 44.113); // the disputed corridor
const CORRIDOR = at(42.05, 43.9); // between CAP and Gori
const RED_HOLD = at(42.2, 44.3); // where the first Fulcrum pair comes from

// 05:40 local on a September morning.
const s = newSession("Caucasus", 5 * 3600 + 40 * 60);

// --------------------------------------------------------------------------
// Flags, exactly as the design document numbers them.
// --------------------------------------------------------------------------
const F_AIRBORNE = 10;
const F_ON_STATION = 20;
const F_HOSTILE = 30;
const F_FIRST_PAIR_DOWN = 40;
const F_EGRESS = 50;
const F_CARGO_LOST = 60;
const F_ESCORT_LOST = 61;

setBriefing(
  s.mission,
  "IRON VEIL 01 — FIRST CONTACT",
  [
    "CALLSIGN VIPER 1-1 — F-16C BLOCK 50 — KUTAISI — 05:40 LOCAL — 14 SEPTEMBER 2003",
    "",
    "At 04:32 a Blue reconnaissance aircraft disappeared from radar over the Gori",
    "corridor. Its last transmission reported an unknown fighter closing from the east.",
    "At 05:10 Red forces began moving additional SAM systems toward the border.",
    "",
    "You lead a two-ship on defensive counter-air. Rules of engagement prohibit firing",
    "until hostile intent or a hostile act is confirmed. OVERLORD will make that call.",
    "",
    "TASKING",
    "  1. Depart Kutaisi and establish CAP at station ECHO.",
    "  2. Check in with OVERLORD (AWACS).",
    "  3. Intercept and identify two unknown contacts approaching the border.",
    "  4. Protect HEAVY 7-1, a C-130 crossing the operational area.",
    "  5. Recover at Kutaisi, or divert to Senaki-Kolkhi.",
    "",
    "WARNING. Intelligence believes a Red strike package is already airborne, and that",
    "the corridor east of Gori may be covered by a mobile SAM battery.",
    "",
    "NOTE ON RADIO: this mission ships with no recorded audio. Every transmission is",
    "shown as on-screen text carrying the same words.",
  ].join("\n"),
  {
    blue: "Establish CAP ECHO, identify the contacts, keep HEAVY 7-1 alive, recover.",
    red: "Hold the eastern corridor. Blue reconnaissance over the border is a threat.",
  }
);

// --------------------------------------------------------------------------
// BLUE
// --------------------------------------------------------------------------
addAircraftGroup(s.mission, "plane", {
  side: "blue",
  country: "USA",
  name: "BLUE_VIPER",
  type: "F-16C_50",
  count: 2,
  x: KUTAISI.x,
  y: KUTAISI.y,
  heading: 70,
  skill: "Player",
  task: "CAP",
  start: { kind: "parking_cold", airfield: "Kutaisi" },
});
setGroupTask(s.mission, "BLUE_VIPER", "CAP");
// Only the lead is the player. Giving every unit skill Player makes DCS offer two
// slots for one flight, which the validator reports as MULTIPLE_PLAYER_UNITS; the
// wingman is AI so the two-ship actually behaves like a two-ship.
for (const u of luaArray(findGroup(s.mission, "BLUE_VIPER").group.units).slice(1)) u.skill = "High";

// ED's own stock F-16C loadout, pylon for pylon out of
// CoreMods/aircraft/F-16C/UnitPayloads/F-16C_50.lua. An air-superiority CAP
// fit: four AMRAAM, two Sidewinder, two bags.
for (const unit of ["BLUE_VIPER-1", "BLUE_VIPER-2"]) {
  setPayload(s.mission, unit, {
    fuel: 3249,
    flare: 60,
    chaff: 60,
    gun: 100,
    pylons: [
      { pylon: 1, CLSID: "{40EF17B7-F508-45de-8566-6FFECC0C1AB8}" }, // AIM-120C
      { pylon: 2, CLSID: "{5CE2FF2A-645A-4197-B48D-8720AC69394F}" }, // AIM-9X
      { pylon: 3, CLSID: "{40EF17B7-F508-45de-8566-6FFECC0C1AB8}" }, // AIM-120C
      { pylon: 4, CLSID: "{F376DBEE-4CAE-41BA-ADD9-B2910AC95DEC}" }, // 370 gal
      { pylon: 6, CLSID: "{F376DBEE-4CAE-41BA-ADD9-B2910AC95DEC}" }, // 370 gal
      { pylon: 7, CLSID: "{40EF17B7-F508-45de-8566-6FFECC0C1AB8}" }, // AIM-120C
      { pylon: 8, CLSID: "{5CE2FF2A-645A-4197-B48D-8720AC69394F}" }, // AIM-9X
      { pylon: 9, CLSID: "{40EF17B7-F508-45de-8566-6FFECC0C1AB8}" }, // AIM-120C
    ],
  });
}
addWaypoint(s.mission, "BLUE_VIPER", { x: CORRIDOR.x, y: CORRIDOR.y, altitudeMetres: 7600, speedMps: 220, name: "CAP ECHO" });
addWaypoint(s.mission, "BLUE_VIPER", { x: CAP_ECHO.x, y: CAP_ECHO.y, altitudeMetres: 7600, speedMps: 220, name: "STATION" });
addWaypoint(s.mission, "BLUE_VIPER", { x: KUTAISI.x, y: KUTAISI.y, altitudeMetres: 3000, speedMps: 180, name: "RTB" });
notes.push("BLUE_VIPER: 2x F-16C, player, cold ramp start at Kutaisi, 4x AIM-120C + 2x AIM-9X");

addAircraftGroup(s.mission, "plane", {
  side: "blue", country: "USA", name: "BLUE_EAGLE", type: "F-15C", count: 2,
  x: CAP_ECHO.x - 20000, y: CAP_ECHO.y - 30000, altitudeMetres: 8200, heading: 80, task: "CAP",
});
setGroupTask(s.mission, "BLUE_EAGLE", "CAP");
addWaypoint(s.mission, "BLUE_EAGLE", { x: CAP_ECHO.x, y: CAP_ECHO.y - 15000, altitudeMetres: 8200, speedMps: 230, name: "ECHO NORTH" });
notes.push("BLUE_EAGLE: 2x F-15C supporting CAP, airborne at mission start");

addAircraftGroup(s.mission, "plane", {
  side: "blue", country: "USA", name: "BLUE_OVERLORD", type: "E-3A", count: 1,
  x: CAP_ECHO.x - 40000, y: CAP_ECHO.y - 70000, altitudeMetres: 9000, heading: 90, task: "AWACS",
});
setGroupTask(s.mission, "BLUE_OVERLORD", "AWACS");
addWaypoint(s.mission, "BLUE_OVERLORD", { x: CAP_ECHO.x + 30000, y: CAP_ECHO.y - 70000, altitudeMetres: 9000, speedMps: 190, name: "ORBIT N" });
notes.push("BLUE_OVERLORD: E-3A AWACS orbiting west of the CAP");

// The thing the player is actually protecting.
addAircraftGroup(s.mission, "plane", {
  side: "blue", country: "USA", name: "BLUE_CARGO", type: "C-130", count: 1,
  x: CAP_ECHO.x - 10000, y: CAP_ECHO.y - 90000, altitudeMetres: 5500, heading: 85, task: "Transport",
});
setGroupTask(s.mission, "BLUE_CARGO", "Transport");
addWaypoint(s.mission, "BLUE_CARGO", { x: CAP_ECHO.x, y: CAP_ECHO.y, altitudeMetres: 5500, speedMps: 130, name: "CROSSING" });
addWaypoint(s.mission, "BLUE_CARGO", { x: CORRIDOR.x, y: CORRIDOR.y + 40000, altitudeMetres: 5500, speedMps: 130, name: "EAST" });
notes.push("BLUE_CARGO: C-130 HEAVY 7-1 crossing the operational area — losing it fails the mission");

// --------------------------------------------------------------------------
// RED
// --------------------------------------------------------------------------
// The first intercept pair: airborne from the start so they fly a credible
// track, but late-activated so they appear when the player reaches station.
addAircraftGroup(s.mission, "plane", {
  side: "red", country: "Russia", name: "RED_FULCRUM_1", type: "MiG-29S", count: 2,
  x: RED_HOLD.x, y: RED_HOLD.y, altitudeMetres: 6700, heading: 250, task: "CAP",
});
setGroupTask(s.mission, "RED_FULCRUM_1", "CAP");
addWaypoint(s.mission, "RED_FULCRUM_1", { x: GORI.x, y: GORI.y, altitudeMetres: 6700, speedMps: 230, name: "BORDER" });
addWaypoint(s.mission, "RED_FULCRUM_1", { x: CAP_ECHO.x, y: CAP_ECHO.y + 10000, altitudeMetres: 6400, speedMps: 240, name: "PUSH WEST" });
updateGroup(s.mission, "RED_FULCRUM_1", { lateActivation: true });
notes.push("RED_FULCRUM_1: 2x MiG-29S, late activation on FLAG 20 (player on station)");

// Reinforcements out of Vaziani, launched only if the first pair is destroyed.
addAircraftGroup(s.mission, "plane", {
  side: "red", country: "Russia", name: "RED_FULCRUM_2", type: "MiG-29S", count: 2,
  x: VAZIANI.x, y: VAZIANI.y, heading: 280, task: "CAP",
  start: { kind: "parking_hot", airfield: "Vaziani" },
});
setGroupTask(s.mission, "RED_FULCRUM_2", "CAP");
addWaypoint(s.mission, "RED_FULCRUM_2", { x: GORI.x, y: GORI.y, altitudeMetres: 6000, speedMps: 240, name: "INTERCEPT" });
updateGroup(s.mission, "RED_FULCRUM_2", { lateActivation: true });
notes.push("RED_FULCRUM_2: 2x MiG-29S hot ramp at Vaziani, late activation on FLAG 40");

addAircraftGroup(s.mission, "plane", {
  side: "red", country: "Russia", name: "RED_STRIKE", type: "Su-24M", count: 2,
  x: LOCHINI.x + 30000, y: LOCHINI.y - 20000, altitudeMetres: 4500, heading: 300, task: "Ground Attack",
});
setGroupTask(s.mission, "RED_STRIKE", "Ground Attack");
addWaypoint(s.mission, "RED_STRIKE", { x: GORI.x + 20000, y: GORI.y + 30000, altitudeMetres: 4500, speedMps: 220, name: "HOLDING" });
updateGroup(s.mission, "RED_STRIKE", { lateActivation: true });
notes.push("RED_STRIKE: 2x Su-24M background threat, late activation on FLAG 40");

// The trap. ED's own SA-6 battery layout where the install provides it.
let sa6;
try {
  sa6 = findSiteTemplate("me-sa-6-sam-battery");
} catch {
  sa6 = findSiteTemplate("SA-6");
  skipped.push("SA-6: Mission Editor template library not readable; used the built-in template");
}
addGroundGroup(s.mission, "vehicle", {
  side: "red", country: "Russia", name: "RED_SAM_1",
  composition: sa6.composition,
  offsets: sa6.offsets,
  headingOffsetsDegrees: sa6.headingOffsetsDegrees,
  x: GORI.x - 6000, y: GORI.y + 12000, heading: 280, spacingMetres: sa6.spacingMetres,
});
updateGroup(s.mission, "RED_SAM_1", { lateActivation: true });
// Alarm state RED and ROE open fire, or the ambush is not an ambush: at the DCS
// default a battery can sit with its radars down and never engage.
for (const [action, value] of [["option:alarmState", "RED"], ["option:roe", "OPEN_FIRE"]]) {
  addWaypointAction(s.mission, "RED_SAM_1", 1, { action, value });
}
notes.push(`RED_SAM_1: SA-6 battery from template ${sa6.id} (provenance ${sa6.provenance}), alarm RED, ROE open fire, late activation on FLAG 40`);

addGroundGroup(s.mission, "vehicle", {
  side: "red", country: "Russia", name: "RED_GROUND",
  composition: [{ type: "T-72B", count: 4 }, { type: "BMP-2", count: 3 }, { type: "Ural-375", count: 2 }],
  x: CORRIDOR.x + 4000, y: CORRIDOR.y + 18000, heading: 270, spacingMetres: 40,
});
notes.push("RED_GROUND: armour and transport moving in the disputed corridor");

// --------------------------------------------------------------------------
// Zones
// --------------------------------------------------------------------------
addTriggerZone(s.mission, { name: "CAP_ECHO", x: CAP_ECHO.x, y: CAP_ECHO.y, radius: 25000 });
addTriggerZone(s.mission, { name: "GORI_CORRIDOR", x: GORI.x, y: GORI.y, radius: 30000 });
addTriggerZone(s.mission, { name: "SAM_ENVELOPE", x: GORI.x - 6000, y: GORI.y + 12000, radius: 28000 });
addTriggerZone(s.mission, { name: "KUTAISI_RECOVERY", x: KUTAISI.x, y: KUTAISI.y, radius: 20000 });

// F10 map picture for the player: the CAP station, the corridor and the trap.
addDrawing(s.mission, {
  layer: "Blue", kind: "circle", name: "CAP ECHO",
  origin: { x: CAP_ECHO.x, y: CAP_ECHO.y }, radiusMetres: 25000,
  color: "0x3366ffcc", fill: "0x3366ff14",
});
addDrawing(s.mission, {
  layer: "Blue", kind: "circle", name: "GORI CORRIDOR - DISPUTED",
  origin: { x: GORI.x, y: GORI.y }, radiusMetres: 30000,
  color: "0xff8019bb", fill: "0xff801912",
});
addDrawing(s.mission, {
  layer: "Blue", kind: "text", name: "ECHO LABEL",
  origin: { x: CAP_ECHO.x, y: CAP_ECHO.y },
  text: "CAP STATION ECHO", fontSize: 18, color: "0x3366ffff",
});
notes.push("F10 drawings: CAP ECHO circle, Gori corridor, station label");

// --------------------------------------------------------------------------
// ACT I — departure. The ATC calls from the design document, as text.
// --------------------------------------------------------------------------
const say = (text, seconds = 18, delaySeconds) => ({
  kind: "message_to_coalition", coalition: "blue", text, seconds,
  ...(delaySeconds === undefined ? {} : { delaySeconds }),
});

addTrigger(
  s.mission,
  {
    type: "start",
    comment: "T01 Kutaisi ground",
    conditions: [],
    actions: [
      say(
        "KUTAISI GROUND: \"Viper One, Kutaisi Ground. Taxi to holding point Runway Zero Seven " +
          "via Alpha. QNH one zero one three. Report ready for departure.\"",
        25
      ),
      say(
        "KUTAISI TOWER: \"Viper One, wind zero six zero at six knots. Runway Zero Seven, " +
          "cleared for takeoff.\"",
        22,
        180
      ),
      { kind: "do_script", text: 'if DCSMCP then DCSMCP.trig("ACT1_START") end' },
    ],
  },
  s.dictionary
);

// ACT II — airborne. Altitude AGL is what actually says "he has left the ramp".
addTrigger(
  s.mission,
  {
    type: "once",
    comment: "T02 OVERLORD check-in (FLAG 10)",
    conditions: [{ kind: "unit_altitude_higher_agl", unit: "BLUE_VIPER-1", altitudeMetres: 500 }],
    actions: [
      { kind: "set_flag", flag: F_AIRBORNE },
      say(
        "OVERLORD: \"Viper One, Overlord. Radar contact established. Proceed to CAP station " +
          "Echo. Maintain angels two five. Picture currently clean.\"",
        25
      ),
      { kind: "do_script", text: 'if DCSMCP then DCSMCP.trig("FLAG10_AIRBORNE") end' },
    ],
  },
  s.dictionary
);

addTrigger(
  s.mission,
  {
    type: "once",
    comment: "T03 unknown contacts (FLAG 20)",
    conditions: [
      { kind: "flag_is_true", flag: F_AIRBORNE },
      { kind: "unit_in_zone", unit: "BLUE_VIPER-1", zone: "CAP_ECHO" },
    ],
    actions: [
      { kind: "set_flag", flag: F_ON_STATION },
      { kind: "activate_group", group: "RED_FULCRUM_1" },
      say(
        "OVERLORD: \"Viper One, Overlord. BRAA zero eight five, forty-five miles, angels two " +
          "two, hot. Two contacts, fast movers. Declare status unknown. Investigate.\"",
        28
      ),
      say("ROE REMINDER: weapons tight. Identify before you shoot.", 15, 30),
      { kind: "do_script", text: 'if DCSMCP then DCSMCP.trig("FLAG20_ON_STATION") end' },
    ],
  },
  s.dictionary
);

// ACT III — the first shot. The design document is explicit that RED must start
// it, not the player: the Fulcrums are pushed onto the transport by an AI TASK
// PUSH two minutes after they are activated, and only then is weapons free given.
addTrigger(
  s.mission,
  {
    type: "once",
    comment: "T04 hostile act confirmed (FLAG 30)",
    conditions: [{ kind: "time_since_flag", flag: F_ON_STATION, seconds: 150 }],
    actions: [
      { kind: "set_flag", flag: F_HOSTILE },
      { kind: "ai_task", group: "RED_FULCRUM_1", taskNumber: 1 },
      say(
        "OVERLORD: \"Viper One, Overlord. Hostile act confirmed. Bandit attacking friendly " +
          "aircraft. Weapons free on declared hostile contacts. Protect the transport.\"",
        28
      ),
      { kind: "do_script", text: 'if DCSMCP then DCSMCP.trig("FLAG30_HOSTILE") end' },
    ],
  },
  s.dictionary
);

// ACT IV — the trap. The reinforcement pair and the SAM come together, which is
// what makes the warning worth obeying.
addTrigger(
  s.mission,
  {
    type: "once",
    comment: "T05 SAM trap (FLAG 40)",
    conditions: [
      { kind: "flag_is_true", flag: F_HOSTILE },
      { kind: "group_dead", group: "RED_FULCRUM_1" },
    ],
    actions: [
      { kind: "set_flag", flag: F_FIRST_PAIR_DOWN },
      { kind: "activate_group", group: "RED_FULCRUM_2" },
      { kind: "activate_group", group: "RED_SAM_1" },
      { kind: "activate_group", group: "RED_STRIKE" },
      say(
        "OVERLORD: \"Viper One, Overlord. New surface-to-air threat, SA-6, east of Gori. " +
          "Break off pursuit. Repeat, break off pursuit. Do not enter the engagement zone.\"",
        30
      ),
      { kind: "mark_to_all", id: 1, text: "SA-6 ENGAGEMENT ZONE — DO NOT ENTER", zone: "SAM_ENVELOPE", readonly: true, comment: "OVERLORD" },
      { kind: "do_script", text: 'if DCSMCP then DCSMCP.trig("FLAG40_TRAP") end' },
    ],
  },
  s.dictionary
);

// A player who ignores the warning gets told once, inside the envelope.
addTrigger(
  s.mission,
  {
    type: "once",
    comment: "T05b inside the SAM envelope",
    conditions: [
      { kind: "flag_is_true", flag: F_FIRST_PAIR_DOWN },
      { kind: "unit_in_zone", unit: "BLUE_VIPER-1", zone: "SAM_ENVELOPE" },
    ],
    actions: [
      say("OVERLORD: \"Viper One, you are INSIDE the SA-6 envelope. Get out, now.\"", 20),
      { kind: "do_script", text: 'if DCSMCP then DCSMCP.trig("SAM_ENVELOPE_ENTERED") end' },
    ],
  },
  s.dictionary
);

// ACT V — recovery.
addTrigger(
  s.mission,
  {
    type: "once",
    comment: "T06 recall (FLAG 50)",
    conditions: [
      { kind: "flag_is_true", flag: F_FIRST_PAIR_DOWN },
      { kind: "unit_in_zone", unit: "BLUE_VIPER-1", zone: "KUTAISI_RECOVERY" },
    ],
    actions: [
      { kind: "set_flag", flag: F_EGRESS },
      say(
        "GUARDIAN ACTUAL: \"All Blue flights, this is Guardian Actual. Hostilities are now " +
          "confirmed across the eastern sector. Defensive alert level Red. Further tasking " +
          "to follow.\"",
        30
      ),
      { kind: "do_script", text: 'if DCSMCP then DCSMCP.trig("FLAG50_EGRESS") end' },
    ],
  },
  s.dictionary
);

// --------------------------------------------------------------------------
// Losses, watched so the endings can tell them apart.
// --------------------------------------------------------------------------
addTrigger(
  s.mission,
  {
    type: "once",
    comment: "HEAVY 7-1 lost",
    conditions: [{ kind: "group_dead", group: "BLUE_CARGO" }],
    actions: [
      { kind: "set_flag", flag: F_CARGO_LOST },
      say("OVERLORD: \"Heavy Seven-One is down. Repeat, Heavy Seven-One is down.\"", 25),
      { kind: "do_script", text: 'if DCSMCP then DCSMCP.trig("CARGO_LOST") end' },
    ],
  },
  s.dictionary
);

addTrigger(
  s.mission,
  {
    type: "once",
    comment: "Escort lost",
    conditions: [{ kind: "group_dead", group: "BLUE_EAGLE" }],
    actions: [
      { kind: "set_flag", flag: F_ESCORT_LOST },
      say("OVERLORD: \"We have lost the Eagle flight. You are the only fighter on station.\"", 25),
      { kind: "do_script", text: 'if DCSMCP then DCSMCP.trig("ESCORT_LOST") end' },
    ],
  },
  s.dictionary
);

// --------------------------------------------------------------------------
// Three endings, as the design document asks for.
// --------------------------------------------------------------------------
addTrigger(
  s.mission,
  {
    type: "once",
    comment: "ENDING Blue victory",
    conditions: [
      { kind: "flag_is_true", flag: F_EGRESS },
      { kind: "flag_is_false", flag: F_CARGO_LOST },
      { kind: "flag_is_false", flag: F_ESCORT_LOST },
    ],
    actions: [
      say(
        "BLUE VICTORY — the interceptors were driven off and Heavy Seven-One is home. " +
          "Intelligence is already intercepting traffic suggesting the border incident was " +
          "engineered. Nobody has admitted ordering it.",
        35
      ),
      { kind: "do_script", text: 'if DCSMCP then DCSMCP.trig("ENDING_VICTORY") end' },
      { kind: "end_mission", winner: "blue", delaySeconds: 35 },
    ],
  },
  s.dictionary
);

addTrigger(
  s.mission,
  {
    type: "once",
    comment: "ENDING Pyrrhic victory",
    conditions: [
      { kind: "flag_is_true", flag: F_EGRESS },
      { kind: "flag_is_false", flag: F_CARGO_LOST },
      { kind: "flag_is_true", flag: F_ESCORT_LOST },
    ],
    actions: [
      say(
        "PYRRHIC VICTORY — Heavy Seven-One made it out. The Eagle flight did not. Blue " +
          "command holds the sector and has nothing to celebrate.",
        35
      ),
      { kind: "do_script", text: 'if DCSMCP then DCSMCP.trig("ENDING_PYRRHIC") end' },
      { kind: "end_mission", winner: "blue", delaySeconds: 35 },
    ],
  },
  s.dictionary
);

addTrigger(
  s.mission,
  {
    type: "once",
    comment: "ENDING Red breakthrough",
    conditions: [{ kind: "flag_is_true", flag: F_CARGO_LOST }],
    actions: [
      say(
        "RED BREAKTHROUGH — Heavy Seven-One was lost over the corridor. Red fighters hold " +
          "the eastern sector and the Blue line has moved west.",
        35,
        20
      ),
      { kind: "do_script", text: 'if DCSMCP then DCSMCP.trig("ENDING_RED") end' },
      { kind: "end_mission", winner: "red", delaySeconds: 55 },
    ],
  },
  s.dictionary
);
notes.push("Three endings: Blue victory, Pyrrhic victory (escort lost), Red breakthrough (transport lost)");

// --------------------------------------------------------------------------
// A flight only spawns at an airfield its side owns, and a cold ramp start at
// an unowned base is a spectator slot with no error anywhere.
// --------------------------------------------------------------------------
const claimed = claimStartAirfields(s);
notes.push(`claimStartAirfields: ${JSON.stringify(claimed).slice(0, 160)}`);

// --------------------------------------------------------------------------
// Scripts, in one start trigger, telemetry last.
// --------------------------------------------------------------------------
const scripts = [];
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
scripts.push({ filePath: path.join(REPO, "scripts", "dcs-mcp-telemetry.lua") });
const { loaded, triggerIndex } = await loadScripts(s, s.dictionary, scripts);
notes.push(`Load Scripts start trigger ${triggerIndex}: ${loaded.map((l) => l.fileName).join(", ")}`);

const airfieldScenery = populateIronVeilAirfields(s.mission, populateAirfield);
for (const scene of airfieldScenery) {
 notes.push(`${scene.airfield}: ${scene.placed.length} statics in aircraft servicing and ${scene.zones.at(-1).role} scenes; flight parking preserved`);
 if (scene.skipped.length) skipped.push(`${scene.airfield}: optional scenery assets unavailable: ${scene.skipped.join(', ')}`);
}
refresh(s);
const report = validateMission(s.document, s.mission);
const errors = report.errors ?? [];
const warnings = report.warnings ?? [];
const saved = await saveSessionAs(s, OUT, { overwrite: true });

console.log(`\nwrote     : ${saved.outPath}`);
console.log(`sha256    : ${saved.digest}`);
console.log(`validator : ${errors.length} error(s), ${warnings.length} warning(s)`);
for (const e of errors) console.log(`  ERROR ${e.code}: ${e.message}`);
const codes = new Map();
for (const w of warnings) codes.set(w.code, (codes.get(w.code) ?? 0) + 1);
if (codes.size) console.log(`  warnings: ${[...codes].map(([k, v]) => `${k}=${v}`).join(" ")}`);
console.log(`\nwhat is in it (${notes.length}):`);
for (const n of notes) console.log(`  + ${n}`);
if (skipped.length) {
  console.log(`\nskipped (${skipped.length}):`);
  for (const sk of skipped) console.log(`  - ${sk}`);
}
console.log(
  `\nNOT verified: no audio is embedded (radio calls are on-screen text), and every ground\n` +
    `coordinate is projected, not sampled. Fly it once and read dcs.log for TERRAIN_WATER\n` +
    `and for the DCSMCP TRIG lines that say which act actually fired.`
);
console.log(`\nlaunch: "H:\\DCS World\\Eagle Dynamics\\DCS World\\bin\\DCS.exe" --force_disable_VR --no-launcher "${saved.outPath}"`);
