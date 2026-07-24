import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { serializeLuaAssignment } from "../src/miz/serializer.js";
import { parseLuaAssignment } from "../src/miz/lua.js";
import { openSession, newSession, saveSessionAs, closeSession } from "../src/miz/sessions.js";
import { addAircraftGroup } from "../src/miz/authoring.js";

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
