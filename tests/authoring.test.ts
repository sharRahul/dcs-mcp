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
  const mission = `mission = { ["theatre"]="Caucasus", ["coalition"]={["blue"]={["name"]="blue",["country"]={[1]={["name"]="USA",["id"]=2,["plane"]={["group"]={[1]={["name"]="Existing 1",["task"]="CAP",["units"]={[1]={["name"]="Existing 1-1",["type"]="F-16C_50",["x"]=1,["y"]=2}}}}}}}}}, ["triggers"]={["zones"]={}}, ["weather"]={["qnh"]=760} }`;
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
  addTrigger(s.mission, {
    type: "once",
    comment: "welcome",
    conditions: [{ kind: "time_after", seconds: 60 }],
    actions: [{ kind: "message", text: "Fight's on", seconds: 15 }],
  });

  // Serialize -> reparse to prove lossless round-trip of the raw table.
  const reparsed = parse(serialize("mission", s.mission), "mission");

  const viper = findGroup(reparsed, "Viper 1")!;
  assert.equal(viper.group["task"], "SEAD");
  const points = viper.group["route"] as any;
  assert.equal(Object.keys(points.points).length, 2);
  assert.equal(points.points[1].name, "WP1");
  assert.equal(points.points[1].speed, 250);

  const unit = findUnit(reparsed, "Viper 1-1")!;
  const payload = unit["payload"] as any;
  assert.equal(payload.fuel, "3200"); // stored as string
  assert.equal(payload.pylons[3].CLSID, "{CLSID-TEST}");

  const trigrules = reparsed["trigrules"] as any;
  assert.equal(trigrules[1].predicate, "triggerOnce");
  assert.equal(trigrules[1].rules[1].predicate, "c_time_after");
  assert.equal(trigrules[1].actions[1].predicate, "a_out_text");

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

test("validation rejects a trigger pointing at a group that does not exist", async () => {
  const s = await openSession(fixtureMiz());

  addTrigger(s.mission, {
    type: "once",
    comment: "spawn reserves",
    conditions: [{ kind: "time_after", seconds: 10 }],
    actions: [{ kind: "activate_group", group: "Does Not Exist" }],
  });
  refresh(s);

  const bad = validateMission(s.document);
  assert.equal(bad.ok, false);
  const issue = bad.errors.find((e) => e.code === "TRIGGER_GROUP_MISSING");
  assert.ok(issue, `expected TRIGGER_GROUP_MISSING, got ${JSON.stringify(bad.errors)}`);
  assert.match(issue!.message, /Does Not Exist/);
  assert.match(issue!.message, /spawn reserves/);

  // Adding the referenced group clears the error.
  addAircraftGroup(s.mission, "plane", {
    side: "blue", country: "USA", name: "Does Not Exist", type: "F-16C_50", count: 1, x: 0, y: 0,
  });
  refresh(s);
  assert.equal(validateMission(s.document).errors.some((e) => e.code === "TRIGGER_GROUP_MISSING"), false);

  closeSession(s.id);
});

test("a trigger referencing an existing group validates cleanly", async () => {
  const s = await openSession(fixtureMiz());
  addTrigger(s.mission, {
    type: "once",
    conditions: [{ kind: "time_after", seconds: 10 }],
    actions: [{ kind: "activate_group", group: "Existing 1" }],
  });
  refresh(s);
  const report = validateMission(s.document);
  assert.equal(report.errors.some((e) => e.code === "TRIGGER_GROUP_MISSING"), false);
  closeSession(s.id);
});
