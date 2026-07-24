import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { serializeLuaAssignment } from "../src/miz/serializer.js";
import { parseLuaAssignment } from "../src/miz/lua.js";
import { openSession, newSession, saveSessionAs, closeSession } from "../src/miz/sessions.js";
import {
  addAircraftGroup,
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
