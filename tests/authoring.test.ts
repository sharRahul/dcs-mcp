import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { serializeLuaAssignment } from "../src/miz/serializer.js";
import { parseLuaAssignment } from "../src/miz/lua.js";
import { openSession, newSession, saveSessionAs, closeSession, refresh } from "../src/miz/sessions.js";
import { validateMission } from "../src/miz/validator.js";
import {
  addAircraftGroup,
  addGroundGroup,
  addWaypoint,
  setPayload,
  setGroupTask,
  addTrigger,
  addTriggerZone,
  findGroup,
  findUnit,
} from "../src/miz/authoring.js";
import { serializeLuaAssignment as serialize } from "../src/miz/serializer.js";
import { parseLuaAssignment as parse } from "../src/miz/lua.js";

test("serializer round-trips an arbitrary data table", () => {
  const src = `t = { ["theatre"] = "Syria", [1] = { ["name"] = "A", ["x"] = -12.5 }, ["flag"] = true, ["empty"] = {} }`;
  const table = parseLuaAssignment(src, "t");
  const serialized = serializeLuaAssignment("t", table);
  const reparsed = parseLuaAssignment(serialized, "t");
  assert.deepEqual(reparsed, table);
});

function fixtureMiz(): string {
  const dir = mkdtempSync(join(tmpdir(), "dcs-auth-"));
  // Every group carries a first route point, as one saved by the Mission Editor
  // always does — the editor cannot open a mission where one does not.
  const route = `["route"]={["points"]={[1]={["x"]=1,["y"]=2,["alt"]=6096,["alt_type"]="BARO",["type"]="Turning Point",["action"]="Turning Point",["speed"]=220,["speed_locked"]=true,["ETA"]=0,["ETA_locked"]=true,["name"]="",["formation_template"]="",["task"]={["id"]="ComboTask",["params"]={["tasks"]={}}}}}}`;
  const mission = `mission = { ["theatre"]="Caucasus", ["coalition"]={["blue"]={["name"]="blue",["country"]={[1]={["name"]="USA",["id"]=2,["plane"]={["group"]={[1]={["name"]="Existing 1",["groupId"]=1,["task"]="CAP",${route},["units"]={[1]={["name"]="Existing 1-1",["unitId"]=1,["type"]="F-16C_50",["x"]=1,["y"]=2}}}}}}}}}, ["triggers"]={["zones"]={}}, ["weather"]={["qnh"]=760} }`;
  const zip = new AdmZip();
  zip.addFile("mission", Buffer.from(mission, "utf8"));
  zip.addFile("options", Buffer.from(`options = { ["foo"] = "keepme" }`, "utf8")); // unknown entry preserved
  const path = join(dir, "src.miz");
  writeFileSync(path, zip.toBuffer());
  return path;
}

test("open -> add group -> save -> reopen preserves and adds", async () => {
  const srcPath = fixtureMiz();
  const outPath = srcPath.replace("src.miz", "out.miz");

  const s = await openSession(srcPath);
  assert.equal(s.document.summary.groupCount, 1);

  addAircraftGroup(s.mission, "plane", {
    side: "blue",
    country: "USA",
    name: "Colt 1",
    type: "FA-18C_hornet",
    count: 2,
    x: 1000,
    y: 2000,
  });
  s.dirty = true;

  const { digest } = await saveSessionAs(s, outPath);
  assert.match(digest, /^[0-9a-f]{64}$/);

  // Reopen the saved file and verify both groups exist.
  const reopened = await openSession(outPath);
  const names = reopened.document.groups.map((g) => g.name).sort();
  assert.deepEqual(names, ["Colt 1", "Existing 1"]);
  const colt = reopened.document.groups.find((g) => g.name === "Colt 1")!;
  assert.equal(colt.units.length, 2);

  // Unknown 'options' entry preserved byte-wise (copy-on-write).
  const zip = new AdmZip(outPath);
  assert.equal(zip.getEntry("options")!.getData().toString("utf8"), `options = { ["foo"] = "keepme" }`);

  closeSession(s.id);
  closeSession(reopened.id);
});

test("depth authoring: waypoints, payload, task, trigger survive round-trip", async () => {
  const srcPath = fixtureMiz();
  const s = await openSession(srcPath);

  addAircraftGroup(s.mission, "plane", {
    side: "blue",
    country: "USA",
    name: "Viper 1",
    type: "F-16C_50",
    count: 1,
    x: 500,
    y: 600,
  });
  addWaypoint(s.mission, "Viper 1", { x: 1000, y: 1100, altitudeMetres: 7000, speedMps: 250, name: "WP1" });
  addWaypoint(s.mission, "Viper 1", { x: 2000, y: 2100 });
  setGroupTask(s.mission, "Viper 1", "SEAD");
  setPayload(s.mission, "Viper 1-1", {
    fuel: 3200,
    chaff: 60,
    flare: 60,
    gun: 100,
    pylons: [{ pylon: 3, CLSID: "{CLSID-TEST}" }],
  });
  addTrigger(
    s.mission,
    {
      type: "once",
      comment: "welcome",
      conditions: [{ kind: "time_after", seconds: 60 }],
      actions: [{ kind: "message", text: "Fight's on", seconds: 15 }],
    },
    (s.dictionary ??= {})
  );

  // Serialize -> reparse to prove lossless round-trip of the raw table.
  const reparsed = parse(serialize("mission", s.mission), "mission");

  const viper = findGroup(reparsed, "Viper 1")!;
  assert.equal(viper.group["task"], "SEAD");
  const points = viper.group["route"] as any;
  // Point 1 is the spawn point every group is created with; the two added
  // waypoints follow it.
  assert.equal(Object.keys(points.points).length, 3);
  assert.equal(points.points[1].x, 500);
  assert.equal(points.points[1].y, 600);
  assert.equal(points.points[2].name, "WP1");
  assert.equal(points.points[2].speed, 250);
  assert.equal(points.points[3].x, 2000);

  const unit = findUnit(reparsed, "Viper 1-1")!;
  const payload = unit["payload"] as any;
  assert.equal(payload.fuel, "3200"); // stored as string
  assert.equal(payload.pylons[3].CLSID, "{CLSID-TEST}");

  const trigrules = reparsed["trigrules"] as any;
  assert.equal(trigrules[1].predicate, "triggerOnce");
  assert.equal(trigrules[1].rules[1].predicate, "c_time_after");
  assert.equal(trigrules[1].actions[1].predicate, "a_out_text_delay");

  // The compiled runtime form survives the round-trip too, so the trigger fires
  // without a Mission Editor pass.
  const trig = reparsed["trig"] as any;
  assert.equal(trig.conditions[1], "return(c_time_after(60) )");
  assert.equal(
    trig.actions[1],
    `a_out_text_delay(getValueDictByKey("DictKey_ActionText_1"), 15, false, 0); mission.trig.func[1]=nil;`
  );
  assert.equal(trig.func[1], "if mission.trig.conditions[1]() then mission.trig.actions[1]() end");
  assert.equal(trig.flag[1], true);

  // Message text is stored in the dictionary, ME-style, and maxDictId advances.
  assert.equal(s.dictionary!["DictKey_ActionText_1"], "Fight's on");
  assert.equal(reparsed["maxDictId"], 1);

  closeSession(s.id);
});

test("addWaypoint throws for an unknown group", async () => {
  const s = await openSession(fixtureMiz());
  assert.throws(() => addWaypoint(s.mission, "Nope", { x: 0, y: 0 }), /No group named 'Nope'/);
  closeSession(s.id);
});

test("save refuses to overwrite the source file", async () => {
  const srcPath = fixtureMiz();
  const s = await openSession(srcPath);
  await assert.rejects(() => saveSessionAs(s, srcPath), /Refusing to overwrite/);
  closeSession(s.id);
});

test("new mission session is serializable and reopenable", async () => {
  const s = newSession("PersianGulf", 43200);
  const dir = mkdtempSync(join(tmpdir(), "dcs-new-"));
  const outPath = join(dir, "new.miz");
  await saveSessionAs(s, outPath);
  const reopened = await openSession(outPath);
  assert.equal(reopened.document.theatre, "PersianGulf");
  closeSession(s.id);
  closeSession(reopened.id);
});

test("save refuses to clobber an existing unrelated file unless overwrite=true", async () => {
  const s = newSession("Caucasus", 43200);
  const dir = mkdtempSync(join(tmpdir(), "dcs-ovw-"));
  const outPath = join(dir, "target.miz");

  await saveSessionAs(s, outPath);
  await assert.rejects(() => saveSessionAs(s, outPath), /Refusing to overwrite the existing file/);

  // The original file must still be intact after the refusal.
  const before = readFileSync(outPath);
  await assert.rejects(() => saveSessionAs(s, outPath), /overwrite=true/);
  assert.deepEqual(readFileSync(outPath), before);

  // Explicit opt-in succeeds.
  const { digest } = await saveSessionAs(s, outPath, true);
  assert.match(digest, /^[0-9a-f]{64}$/);
  closeSession(s.id);
});

test("authored groups and units get unique DCS ids that continue existing numbering", async () => {
  const s = await openSession(fixtureMiz());

  addAircraftGroup(s.mission, "plane", {
    side: "blue", country: "USA", name: "Alpha", type: "F-16C_50", count: 2, x: 0, y: 0,
  });
  addGroundGroup(s.mission, "vehicle", {
    side: "red", country: "Russia", name: "Bravo", type: "T-90", count: 3, x: 10, y: 10,
  });

  const reparsed = parse(serialize("mission", s.mission), "mission");
  const alpha = findGroup(reparsed, "Alpha")!.group as any;
  const bravo = findGroup(reparsed, "Bravo")!.group as any;

  assert.equal(typeof alpha.groupId, "number");
  assert.equal(typeof bravo.groupId, "number");
  assert.notEqual(alpha.groupId, bravo.groupId);

  const ids = [
    ...Object.values(alpha.units as Record<string, any>).map((u) => u.unitId),
    ...Object.values(bravo.units as Record<string, any>).map((u) => u.unitId),
  ];
  assert.equal(ids.length, 5);
  assert.ok(ids.every((id) => typeof id === "number"), `unitIds not all numbers: ${ids}`);
  assert.equal(new Set(ids).size, 5, `unitIds not unique: ${ids}`);

  closeSession(s.id);
});

test("ids keep incrementing past ids already present in the source mission", async () => {
  const s = await openSession(fixtureMiz());
  // Give the pre-existing group high ids, then confirm new content goes above them.
  const existing = findGroup(s.mission, "Existing 1")!.group as any;
  existing.groupId = 500;
  existing.units[1].unitId = 900;

  addAircraftGroup(s.mission, "plane", {
    side: "blue", country: "USA", name: "Charlie", type: "F-16C_50", count: 1, x: 0, y: 0,
  });

  const charlie = findGroup(s.mission, "Charlie")!.group as any;
  assert.equal(charlie.groupId, 501);
  assert.equal(charlie.units[1].unitId, 901);
  closeSession(s.id);
});

test("addTrigger refuses group, unit and zone names that are not in the mission", async () => {
  const s = await openSession(fixtureMiz());

  assert.throws(
    () =>
      addTrigger(s.mission, {
        type: "once",
        conditions: [{ kind: "time_after", seconds: 10 }],
        actions: [{ kind: "activate_group", group: "Does Not Exist" }],
      }),
    /No group named 'Does Not Exist'/
  );
  assert.throws(
    () =>
      addTrigger(s.mission, {
        type: "once",
        conditions: [{ kind: "unit_in_zone", unit: "Existing 1-1", zone: "Nowhere" }],
        actions: [{ kind: "set_flag", flag: 1 }],
      }),
    /No trigger zone named 'Nowhere'/
  );
  assert.throws(
    () =>
      addTrigger(s.mission, {
        type: "once",
        conditions: [{ kind: "unit_dead", unit: "Ghost" }],
        actions: [{ kind: "set_flag", flag: 1 }],
      }),
    /No unit named 'Ghost'/
  );

  // A rejected trigger must not be half-written into the mission.
  assert.equal(Object.keys((s.mission["trigrules"] ?? {}) as object).length, 0);
  closeSession(s.id);
});

test("a trigger referencing existing content validates cleanly", async () => {
  const s = await openSession(fixtureMiz());
  addTriggerZone(s.mission, { name: "Target Area", x: 100, y: 200, radius: 5000 });
  addTrigger(s.mission, {
    type: "once",
    conditions: [{ kind: "unit_in_zone", unit: "Existing 1-1", zone: "Target Area" }],
    actions: [{ kind: "activate_group", group: "Existing 1" }],
  });
  refresh(s);
  const report = validateMission(s.document);
  assert.equal(report.ok, true, JSON.stringify(report.errors));
  assert.equal(report.warnings.some((w) => w.code === "TRIGGER_NOT_COMPILED"), false);
  closeSession(s.id);
});

test("validation flags dangling ids in triggers an existing mission already had", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dcs-dangle-"));
  // A mission whose trigger points at ids nothing in the mission defines: the
  // Mission Editor lets this happen when content is deleted after the trigger.
  const mission =
    `mission = { ["theatre"]="Caucasus", ` +
    `["coalition"]={["blue"]={["name"]="blue",["country"]={}}}, ` +
    `["triggers"]={["zones"]={}}, ` +
    `["trigrules"]={[1]={["predicate"]="triggerOnce",["comment"]="spawn reserves",` +
    `["rules"]={[1]={["predicate"]="c_unit_in_zone",["unit"]=42,["zone"]=7}},` +
    `["actions"]={[1]={["predicate"]="a_activate_group",["group"]=99}}}} }`;
  const zip = new AdmZip();
  zip.addFile("mission", Buffer.from(mission, "utf8"));
  const path = join(dir, "dangling.miz");
  writeFileSync(path, zip.toBuffer());

  const s = await openSession(path);
  const report = validateMission(s.document);
  assert.equal(report.ok, false);

  const group = report.errors.find((e) => e.code === "TRIGGER_GROUP_MISSING");
  assert.ok(group, `expected TRIGGER_GROUP_MISSING, got ${JSON.stringify(report.errors)}`);
  assert.match(group!.message, /'99'/);
  assert.match(group!.message, /spawn reserves/);
  assert.ok(report.errors.some((e) => e.code === "TRIGGER_ZONE_MISSING" && /'7'/.test(e.message)));
  assert.ok(report.errors.some((e) => e.code === "TRIGGER_UNIT_MISSING" && /'42'/.test(e.message)));

  // It also has no compiled runtime entry, so it would not fire if flown.
  assert.ok(report.warnings.some((w) => w.code === "TRIGGER_NOT_COMPILED"));
  closeSession(s.id);
});

test("unit headings are written in radians, as DCS stores them", async () => {
  const s = await openSession(fixtureMiz());
  addGroundGroup(s.mission, "vehicle", {
    side: "red", country: "Russia", name: "Convoy", type: "Ural-4320T", count: 1,
    x: 0, y: 0, heading: 90,
  });
  const convoy = findGroup(s.mission, "Convoy")!.group as any;
  // 90 degrees is pi/2 radians, NOT 90. Writing degrees straight through would
  // point the unit at roughly 117 degrees instead.
  assert.ok(
    Math.abs(convoy.units[1].heading - Math.PI / 2) < 1e-9,
    `expected pi/2 radians, got ${convoy.units[1].heading}`
  );

  // Every heading must land in [0, 2pi) the way the editor writes them.
  for (const deg of [0, 45, 180, 359, 360, 450, -90]) {
    addGroundGroup(s.mission, "vehicle", {
      side: "red", country: "Russia", name: `H${deg}`, type: "Ural-4320T", count: 1,
      x: 0, y: 0, heading: deg,
    });
    const h = (findGroup(s.mission, `H${deg}`)!.group as any).units[1].heading;
    assert.ok(h >= 0 && h < 2 * Math.PI, `heading ${deg} deg produced ${h} rad`);
  }
  closeSession(s.id);
});

test("group units trail the heading instead of a fixed diagonal", async () => {
  const s = await openSession(fixtureMiz());

  // Facing east (90 deg): the column must run west, i.e. along -y with x fixed.
  addGroundGroup(s.mission, "vehicle", {
    side: "red", country: "Russia", name: "Eastbound", type: "Ural-4320T", count: 3,
    x: 1000, y: 2000, heading: 90,
  });
  const units = (findGroup(s.mission, "Eastbound")!.group as any).units;
  for (let i = 1; i <= 3; i++) {
    assert.ok(Math.abs(units[i].x - 1000) < 1e-6, `unit ${i} drifted north/south: x=${units[i].x}`);
    assert.ok(Math.abs(units[i].y - (2000 - (i - 1) * 20)) < 1e-6, `unit ${i} y=${units[i].y}`);
  }

  // Facing north (0 deg): the column runs south, along -x with y fixed. The old
  // fixed +30/+30 offset put it on a 45-degree diagonal regardless of heading.
  addGroundGroup(s.mission, "vehicle", {
    side: "red", country: "Russia", name: "Northbound", type: "Ural-4320T", count: 3,
    x: 0, y: 0, heading: 0,
  });
  const north = (findGroup(s.mission, "Northbound")!.group as any).units;
  assert.deepEqual(
    [1, 2, 3].map((i) => [Math.round(north[i].x), Math.round(north[i].y)]),
    [[0, 0], [-20, 0], [-40, 0]]
  );

  // The offset direction must always be exactly opposite the heading.
  for (const deg of [0, 30, 90, 180, 270, 315]) {
    addGroundGroup(s.mission, "vehicle", {
      side: "red", country: "Russia", name: `Bearing${deg}`, type: "Ural-4320T", count: 2,
      x: 0, y: 0, heading: deg,
    });
    const u = (findGroup(s.mission, `Bearing${deg}`)!.group as any).units;
    const offsetBearing = (Math.atan2(u[2].y - u[1].y, u[2].x - u[1].x) * 180) / Math.PI;
    const expected = (deg + 180) % 360;
    const diff = Math.abs(((offsetBearing - expected + 540) % 360) - 180);
    assert.ok(diff < 1e-6, `heading ${deg}: units offset toward ${offsetBearing}, expected ${expected}`);
  }
  closeSession(s.id);
});

test("a mixed composition builds one group of several unit types", async () => {
  const s = await openSession(fixtureMiz());

  // A SAM site is not N copies of one vehicle. Skynet finds the site by group
  // name and then looks inside it for a search/track radar and launchers; a group
  // of launchers alone registers and never fires.
  addGroundGroup(s.mission, "vehicle", {
    side: "red", country: "Russia", name: "SAM-SA-6-Test", type: "unused", count: 99,
    x: 5000, y: -1000, heading: 0, spacingMetres: 60,
    composition: [
      { type: "Kub 1S91 str", count: 1 },
      { type: "Kub 2P25 ln", count: 3 },
      { type: "Ural-375 PBU", count: 1 },
    ],
  });

  const reparsed = parse(serialize("mission", s.mission), "mission");
  const site = findGroup(reparsed, "SAM-SA-6-Test")!.group as any;
  const units = Object.values(site.units as Record<string, any>);

  assert.deepEqual(
    units.map((u) => u.type),
    ["Kub 1S91 str", "Kub 2P25 ln", "Kub 2P25 ln", "Kub 2P25 ln", "Ural-375 PBU"],
    "composition order is the layout order"
  );
  assert.equal(new Set(units.map((u) => u.unitId)).size, 5, "unitIds must stay unique");

  // The layout rule does not change: heading 0 trails south, at the override spacing.
  assert.deepEqual(
    units.map((u) => [Math.round(u.x), Math.round(u.y)]),
    [[5000, -1000], [4940, -1000], [4880, -1000], [4820, -1000], [4760, -1000]]
  );

  // Without a composition, type/count still behave exactly as before.
  addGroundGroup(s.mission, "vehicle", {
    side: "red", country: "Russia", name: "Plain", type: "T-90", count: 2, x: 0, y: 0,
  });
  const plain = (findGroup(s.mission, "Plain")!.group as any).units;
  assert.deepEqual([plain[1].type, plain[2].type], ["T-90", "T-90"]);

  closeSession(s.id);
});
