/**
 * DCS log parsing.
 *
 * The sample below is taken verbatim from a real `dcs.log`, including the
 * Mission Editor failure that a generated `.miz` with an empty group route
 * actually produced — the case these tools exist to catch.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseLog, findProblems, readLogProblems } from "../src/dcs/log.js";

const SAMPLE = `=== Log opened UTC 2026-07-24 23:28:49
2026-07-24 23:35:04.495 INFO    Scripting (Main): plugin: World War II PTO Units unit replace Type_94_Truck
2026-07-24 23:35:04.926 ERROR   Scripting (Main): unit Su-30MKI not found
2026-07-24 23:35:04.928 WARNING Scripting (Main): plugin: SKIPPED './DemoMods/aircraft/AJS37': not supported
2026-07-24 23:35:11.023 ERROR   wInfo (Main): negative drag of payload "{HB_A6E_MK20_MER_5x_RIGHT}" (origin: "./CoreMods/aircraft/A-6E/Entry/Weapons.lua")
2026-07-24 23:35:11.035 ERROR   EDCORE (Main): Failed to load H:/DCS World/CoreMods/tech/SouthAtlanticAssets/bin/SouthAtlantic.dll: (127) The specified procedure could not be found.
2026-07-24 23:35:23.218 INFO    APP (Main): Loaded C:\\Users\\x\\Saved Games\\DCS\\Scripts\\Hooks\\dcs-mcp-hook.lua
2026-07-24 23:51:52.635 ALERT   LUACOMMON (Main): Error: GUI Error: [string "./MissionEditor/modules/me_mission.lua"]:595: attempt to index field '?' (a nil value)
GUI debug.traceback: stack traceback:
	[C]: ?
	[string "./MissionEditor/modules/me_mission.lua"]:595: in function 'fixUnitsPos'
	[string "./MissionEditor/modules/me_mission.lua"]:2477: in function 'load'
2026-07-24 23:53:53.673 INFO    DXGUI_WIN_ADAPTER (Main): resize main window to [0, 0]
`;

test("log lines parse into timestamp, level, source and message", () => {
  const entries = parseLog(SAMPLE);
  // The `=== Log opened` header is not a log entry.
  assert.equal(entries.length, 8);

  const first = entries[0];
  assert.equal(first.timestamp, "2026-07-24 23:35:04.495");
  assert.equal(first.level, "INFO");
  assert.equal(first.source, "Scripting");
  assert.match(first.message, /^plugin: World War II/);
});

test("a stack traceback is folded into the entry it belongs to", () => {
  const entries = parseLog(SAMPLE);
  const alert = entries.find((e) => e.level === "ALERT")!;
  assert.ok(alert, "ALERT entry not found");
  assert.equal(alert.source, "LUACOMMON");
  assert.ok(alert.detail && alert.detail.length >= 3, "traceback lines were dropped");
  assert.ok(alert.detail!.some((d) => d.includes("fixUnitsPos")));
});

test("routine startup noise is filtered but real failures are kept", () => {
  const problems = findProblems(parseLog(SAMPLE));
  const messages = problems.map((p) => p.message);

  // Dropped: per-module weapon-drag spam and missing optional units.
  assert.ok(!messages.some((m) => /negative drag/.test(m)), "weapon-drag noise survived");
  assert.ok(!messages.some((m) => /unit Su-30MKI not found/.test(m)), "missing-unit noise survived");
  assert.ok(!messages.some((m) => /SKIPPED/.test(m)), "skipped-plugin noise survived");

  // Kept: a failed DLL load and the Mission Editor Lua failure.
  assert.ok(messages.some((m) => /SouthAtlantic\.dll/.test(m)), "a failed load was filtered out");
  const lua = problems.find((p) => p.lua);
  assert.ok(lua, "the Lua failure was not reported");
  assert.match(lua!.message, /attempt to index field/);
});

test("map-load and startup-probe noise is filtered but a mission script error is kept", () => {
  // Verbatim from a real run: 30-odd routine ERROR/ALERT lines the terrain and
  // module loader emit at every start, plus the one line that mattered — a
  // Skynet failure thrown from a MIST scheduled function inside the mission.
  const sample = `=== Log opened UTC 2026-07-25 12:27:00
2026-07-25 12:27:38.291 ERROR   GRAPHICSVISTA (Main): Can't open model light_source_small.
2026-07-25 12:27:40.057 ERROR   woCar (Main): can't load destroyed model 'Ural-375_p_1' for '55G6 EWR'
2026-07-25 12:27:38.304 ERROR   WRADIO (Main): Invalid DME frequency or missing channel to determine DME frequency. Can't load beacon "BH BuHasa"
2026-07-25 12:27:39.993 ERROR   FLIGHT (Main): INVALID ATC Quasoura_airport
2026-07-25 12:27:39.994 ERROR   FLIGHT (Main): Unable to find beacon with ID: airfield18_2
2026-07-25 12:27:10.000 ALERT   Scripting (Main): loadfile: no file './DemoMods/aircraft/AJS37/entry.lua'
2026-07-25 12:27:11.000 ERROR   EDCORE (Main): No suitable driver found to mount mods/terrains/persiangulf/
2026-07-25 12:27:12.000 ERROR   LuaHooks (Main): [string "C:\\Users\\x\\Saved Games\\DCS\\Scripts\\DCS-gRPC\\grpc.lua"]:268: attempt to index global 'grpc' (a nil value)
2026-07-25 12:29:36.658 ERROR   SCRIPTING (Main): MIST|doScheduledFunctions|1495: Error in scheduled function: [string "skynet-iads-compiled.lua"]:3179: Unit doesn't exist
`;
  const problems = findProblems(parseLog(sample));
  const messages = problems.map((p) => p.message);

  assert.ok(!messages.some((m) => /Can't open model/.test(m)), "prop-model noise survived");
  assert.ok(!messages.some((m) => /can't load destroyed model/.test(m)), "destroyed-model noise survived");
  assert.ok(!messages.some((m) => /Invalid DME/.test(m)), "DME-beacon noise survived");
  assert.ok(!messages.some((m) => /INVALID ATC/.test(m)), "ATC noise survived");
  assert.ok(!messages.some((m) => /Unable to find beacon/.test(m)), "beacon-lookup noise survived");
  assert.ok(!messages.some((m) => /loadfile: no file/.test(m)), "module-probe noise survived");
  assert.ok(!messages.some((m) => /No suitable driver/.test(m)), "terrain-mount noise survived");
  assert.ok(!messages.some((m) => /DCS-gRPC/.test(m)), "third-party gRPC flood survived");

  // The one real failure must not be buried by the noise filter.
  assert.equal(problems.length, 1, "exactly the mission script error should remain");
  assert.match(problems[0].message, /MIST\|doScheduledFunctions/);
  assert.match(problems[0].message, /Unit doesn't exist/);
});

test("a Lua failure names the files its traceback blames", () => {
  const problems = findProblems(parseLog(SAMPLE));
  const lua = problems.find((p) => p.lua)!;
  assert.deepEqual(lua.blames, ["./MissionEditor/modules/me_mission.lua"]);
});

test("reading the log reports position so a caller can poll for new entries", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dcs-log-"));
  const logPath = join(dir, "dcs.log");
  writeFileSync(logPath, SAMPLE, "utf8");

  const all = await readLogProblems({ logPath });
  assert.equal(all.sessionStarted, "2026-07-24 23:28:49");
  assert.ok(all.totalProblems >= 2);
  assert.ok(all.lines > 10);

  // Everything after the ALERT line is uninteresting, so polling from there is quiet.
  const alertLine = parseLog(SAMPLE).find((e) => e.level === "ALERT")!.line;
  const after = await readLogProblems({ logPath, sinceLine: alertLine + 1 });
  assert.equal(after.totalProblems, 0);

  // Filtering by timestamp keeps only the late failure.
  const late = await readLogProblems({ logPath, since: "2026-07-24 23:40:00.000" });
  assert.equal(late.totalProblems, 1);
  assert.ok(late.problems[0].lua);
});

test("a missing log is an explicit error, not a silent empty result", async () => {
  await assert.rejects(
    () => readLogProblems({ logPath: join(tmpdir(), "definitely-not-here", "dcs.log") }),
    /DCS log not found/
  );
});
