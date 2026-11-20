/**
 * Embedded resources, scripting frameworks, and radio-menu triggers.
 *
 * The predicate signatures these rely on are asserted against the Mission-Editor
 * oracle in `trig.test.ts`; this file covers the machinery around them — putting
 * files into the `.miz`, registering them in `mapResource`, and getting the load
 * ORDER right, which is what actually breaks Skynet in practice.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import AdmZip from "adm-zip";
import { newSession, saveSessionAs, closeSession, openSession, refresh } from "../src/miz/sessions.js";
import { addResource, listResources, assertSafeResourceName } from "../src/miz/resources.js";
import {
  discoverFramework,
  loadScripts,
  resolveFrameworkPath,
  resolveLoadOrder,
  SCRIPT_TRIGGER_COMMENT,
} from "../src/miz/frameworks.js";
import { addAircraftGroup, addTrigger, addTriggerZone, findTriggerByComment } from "../src/miz/authoring.js";
import { serializeLuaAssignment } from "../src/miz/serializer.js";
import { parseLuaAssignment, luaArray, asTable } from "../src/miz/lua.js";
import type { LuaTable } from "../src/miz/lua.js";

test('bundled frameworks are a fallback and never replace a local installation', async () => {
  for (const name of ['mist', 'moose', 'skynet', 'splash'] as const) {
    const resolved = await resolveFrameworkPath(name, undefined, []);
    assert.ok(resolved.includes(join('scripts', 'lua scripts')), resolved);
  }
  const dir = mkdtempSync(join(tmpdir(), 'dcs-local-framework-'));
  const local = join(dir, 'mist_4_5_107.lua');
  writeFileSync(local, 'x'.repeat(200_000));
  assert.equal(await resolveFrameworkPath('mist', undefined, [dir]), local);
});

function storeOf(session: { mission: LuaTable; mapResource: LuaTable; files: Map<string, Buffer> }) {
  return { mission: session.mission, mapResource: session.mapResource, files: session.files };
}

/** Write throwaway .lua files standing in for the real frameworks. */
function fakeFrameworks(): { dir: string; mist: string; moose: string; skynet: string } {
  const dir = mkdtempSync(join(tmpdir(), "dcs-fw-"));
  const write = (name: string, body: string) => {
    const p = join(dir, name);
    writeFileSync(p, body, "utf8");
    return p;
  };
  return {
    dir,
    mist: write("mist_4_5_126.lua", "mist = { version = '4.5.126' }\n"),
    moose: write("Moose.lua", "MOOSE = { loaded = true }\n"),
    skynet: write("skynet-iads-compiled.lua", "assert(mist, 'Skynet needs MIST')\nSkynetIADS = {}\n"),
  };
}

test("resource keys come off the shared maxDictId counter and dedupe by file name", () => {
  const s = newSession("Caucasus", 43200);
  const store = storeOf(s);

  const first = addResource(store, "mist.lua", Buffer.from("mist = {}"));
  const second = addResource(store, "Moose.lua", Buffer.from("MOOSE = {}"));
  assert.equal(first.key, "ResKey_Action_1");
  assert.equal(second.key, "ResKey_Action_2");
  assert.equal(s.mission["maxDictId"], 2);
  assert.equal(first.reused, false);

  // The same file again reuses the key rather than embedding a second copy —
  // loading a framework twice would re-run its initialisation.
  const again = addResource(store, "mist.lua", Buffer.from("mist = {}"));
  assert.equal(again.key, "ResKey_Action_1");
  assert.equal(again.reused, true);
  assert.equal(s.mission["maxDictId"], 2);
  assert.equal(s.files.size, 2);

  // A dictionary key allocated afterwards must not collide with the resources.
  addTrigger(
    s.mission,
    { type: "once", conditions: [{ kind: "time_after", seconds: 1 }], actions: [{ kind: "message", text: "hi" }] },
    s.dictionary
  );
  assert.equal(s.dictionary["DictKey_ActionText_3"], "hi");
  assert.deepEqual(
    listResources(s.mapResource).map((r) => r.fileName).sort(),
    ["Moose.lua", "mist.lua"]
  );
  closeSession(s.id);
});

test("resource names cannot escape l10n/DEFAULT", () => {
  for (const bad of ["../evil.lua", "sub/dir.lua", "C:/abs.lua", "..", ""]) {
    assert.throws(() => assertSafeResourceName(bad), /file name|Invalid/, `accepted ${JSON.stringify(bad)}`);
  }
  assert.doesNotThrow(() => assertSafeResourceName("mist_4_5_126.lua"));
});

test("re-adding a different file under an existing name is refused", () => {
  const s = newSession("Caucasus", 43200);
  const store = storeOf(s);
  addResource(store, "setup.lua", Buffer.from("a = 1"));
  assert.throws(
    () => addResource(store, "setup.lua", Buffer.from("a = 2")),
    /already carries a different file/
  );
  closeSession(s.id);
});

test("requesting skynet pulls in mist, and load order is dependency-first", () => {
  assert.deepEqual(resolveLoadOrder(["skynet"]), ["mist", "skynet"]);
  assert.deepEqual(resolveLoadOrder(["skynet", "moose"]), ["mist", "moose", "skynet"]);
  // Requested order must not matter; dependency order wins.
  assert.deepEqual(resolveLoadOrder(["moose", "mist"]), ["mist", "moose"]);
});

test("framework discovery picks the real single-file build, not a sample", async () => {
  // Mirrors the real layout: MIST ships `mist_DBs_*.lua` example dumps beside
  // the versioned release, and they sort AFTER it alphabetically, so a loose
  // pattern silently embeds a 3 KB sample instead of the framework.
  const dir = mkdtempSync(join(tmpdir(), "dcs-disco-"));
  mkdirSync(join(dir, "Example DBs"), { recursive: true });
  writeFileSync(join(dir, "Example DBs", "mist_DBs_zonesByNum.lua"), "return {}\n");
  writeFileSync(join(dir, "mist_DBs_activeHumans.lua"), "return {}\n");
  writeFileSync(join(dir, "mist_4_5_107.lua"), "x".repeat(200_000));
  writeFileSync(join(dir, "mist_4_5_126.lua"), "x".repeat(200_000));
  writeFileSync(join(dir, "Moose.lua"), "x".repeat(2_000_000));
  writeFileSync(join(dir, "skynet-iads-compiled.lua"), "x".repeat(60_000));
  writeFileSync(join(dir, "skynet-iads-setup-persian-gulf.lua"), "SkynetIADS:create()\n");

  // Newest version wins, and the sample dumps are never candidates.
  assert.equal(basename((await discoverFramework("mist", [dir]))!), "mist_4_5_126.lua");
  assert.equal(basename((await discoverFramework("moose", [dir]))!), "Moose.lua");
  assert.equal(basename((await discoverFramework("skynet", [dir]))!), "skynet-iads-compiled.lua");
});

test("a suspiciously small auto-discovered framework is refused, not embedded", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dcs-stub-"));
  writeFileSync(join(dir, "mist.lua"), "-- stub\n");

  // Discovery finds it by name, but resolution must refuse it rather than
  // produce a mission where MIST silently is not present.
  assert.equal(basename((await discoverFramework("mist", [dir]))!), "mist.lua");
  await assert.rejects(
    () => resolveFrameworkPath("mist", undefined, [dir]),
    /too small to be the real framework/
  );

  // An explicitly given path is the caller's decision and is not second-guessed.
  const explicit = join(dir, "mist.lua");
  assert.equal(await resolveFrameworkPath("mist", explicit, [dir]), explicit);
});

test("frameworks load from ONE start trigger, in order, and reload does not duplicate", async () => {
  const s = newSession("Caucasus", 43200);
  const fw = fakeFrameworks();

  const first = await loadScripts(storeOf(s), s.dictionary, [
    { framework: "mist", filePath: fw.mist },
    { framework: "moose", filePath: fw.moose },
    { framework: "skynet", filePath: fw.skynet },
  ]);
  refresh(s);

  assert.equal(first.triggerIndex, 1);
  assert.equal(findTriggerByComment(s.mission, SCRIPT_TRIGGER_COMMENT), 1);

  const rule = asTable(asTable(s.mission["trigrules"])?.[1])!;
  assert.equal(rule["predicate"], "triggerStart");
  const actions = luaArray(rule["actions"]);
  assert.equal(actions.length, 3);
  assert.ok(actions.every((a) => a["predicate"] === "a_do_script_file"));

  // Order in the compiled chunk is the only ordering DCS guarantees.
  const trig = asTable(s.mission["trig"])!;
  const compiled = String(asTable(trig["actions"])![1]);
  const keys = first.loaded.map((l) => l.resourceKey);
  assert.equal(
    compiled,
    keys.map((k) => `a_do_script_file(getValueResourceByKey("${k}"));`).join("")
  );
  assert.deepEqual(first.loaded.map((l) => l.fileName), [
    "mist_4_5_126.lua",
    "Moose.lua",
    "skynet-iads-compiled.lua",
  ]);
  // A start trigger is wired through funcStartup, never func.
  assert.ok(asTable(trig["funcStartup"])![1]);
  assert.equal(asTable(trig["func"])![1], undefined);

  // Loading the same frameworks again adds nothing.
  const second = await loadScripts(storeOf(s), s.dictionary, [
    { framework: "mist", filePath: fw.mist },
    { framework: "skynet", filePath: fw.skynet },
  ]);
  assert.equal(second.triggerIndex, 1);
  assert.ok(second.loaded.every((l) => l.reused));
  assert.equal(luaArray(asTable(asTable(s.mission["trigrules"])?.[1])!["actions"]).length, 3);

  closeSession(s.id);
});

test("a user script loads after the frameworks it depends on", async () => {
  const s = newSession("Caucasus", 43200);
  const fw = fakeFrameworks();
  const setup = join(fw.dir, "my-setup.lua");
  writeFileSync(setup, "SkynetIADS.create()\n", "utf8");

  const { loaded } = await loadScripts(storeOf(s), s.dictionary, [
    { framework: "mist", filePath: fw.mist },
    { framework: "skynet", filePath: fw.skynet },
    { filePath: setup },
  ]);
  assert.deepEqual(loaded.map((l) => l.fileName), [
    "mist_4_5_126.lua",
    "skynet-iads-compiled.lua",
    "my-setup.lua",
  ]);
  assert.equal(loaded[2].framework, undefined);
  closeSession(s.id);
});

test("only .lua files are accepted as mission scripts", async () => {
  const s = newSession("Caucasus", 43200);
  const dir = mkdtempSync(join(tmpdir(), "dcs-badscript-"));
  const exe = join(dir, "payload.exe");
  writeFileSync(exe, "not lua");
  await assert.rejects(
    () => loadScripts(storeOf(s), s.dictionary, [{ filePath: exe }]),
    /must be \.lua files/
  );
  closeSession(s.id);
});

test("saving writes the embedded scripts and mapResource into the .miz", async () => {
  const s = newSession("Caucasus", 43200);
  const fw = fakeFrameworks();
  await loadScripts(storeOf(s), s.dictionary, [
    { framework: "mist", filePath: fw.mist },
    { framework: "skynet", filePath: fw.skynet },
  ]);
  refresh(s);

  const outPath = join(mkdtempSync(join(tmpdir(), "dcs-save-")), "scripted.miz");
  await saveSessionAs(s, outPath);

  const zip = new AdmZip(outPath);
  const names = zip.getEntries().map((e) => e.entryName);
  assert.ok(names.includes("l10n/DEFAULT/mist_4_5_126.lua"), names.join(", "));
  assert.ok(names.includes("l10n/DEFAULT/skynet-iads-compiled.lua"), names.join(", "));

  const mapResource = parseLuaAssignment(
    zip.getEntry("l10n/DEFAULT/mapResource")!.getData().toString("utf8"),
    "mapResource"
  );
  const files = Object.values(mapResource);
  assert.ok(files.includes("mist_4_5_126.lua"), JSON.stringify(mapResource));
  assert.ok(files.includes("skynet-iads-compiled.lua"), JSON.stringify(mapResource));

  // The embedded file content must survive byte-for-byte.
  assert.equal(
    zip.getEntry("l10n/DEFAULT/mist_4_5_126.lua")!.getData().toString("utf8"),
    "mist = { version = '4.5.126' }\n"
  );

  // Reopening picks the resources back up rather than losing them.
  const reopened = await openSession(outPath);
  assert.deepEqual(
    listResources(reopened.mapResource).map((r) => r.fileName).sort(),
    ["mist_4_5_126.lua", "skynet-iads-compiled.lua"]
  );
  closeSession(s.id);
  closeSession(reopened.id);
});

test("a binary resource round-trips through save without corruption", async () => {
  const s = newSession("Caucasus", 43200);
  // Bytes that are not valid UTF-8: a naive string round-trip mangles these.
  const audio = Buffer.from([0x4f, 0x67, 0x67, 0x53, 0x00, 0xff, 0xfe, 0x80, 0x81, 0x00, 0x1a]);
  addResource(storeOf(s), "beep.ogg", audio);

  const outPath = join(mkdtempSync(join(tmpdir(), "dcs-bin-")), "sound.miz");
  await saveSessionAs(s, outPath);

  const written = new AdmZip(outPath).getEntry("l10n/DEFAULT/beep.ogg")!.getData();
  assert.deepEqual(written, audio);
  closeSession(s.id);
});

test("radio menu items compile with their own dictionary prefix", () => {
  const s = newSession("Caucasus", 43200);
  addAircraftGroup(s.mission, "plane", {
    side: "blue", country: "USA", name: "Uzi 1", type: "FA-18C_hornet", count: 1, x: 0, y: 0,
  });

  // The item raises flag 7; a second trigger reacts to it.
  addTrigger(
    s.mission,
    {
      type: "start",
      comment: "radio menu",
      conditions: [],
      actions: [
        { kind: "add_radio_item", text: "Request CAS", flag: 7, value: 1 },
        { kind: "add_radio_item_for_group", group: "Uzi 1", text: "Request tanker", flag: 8 },
      ],
    },
    s.dictionary
  );
  addTrigger(
    s.mission,
    {
      type: "once",
      comment: "cas requested",
      conditions: [{ kind: "flag_is_true", flag: 7 }],
      actions: [
        { kind: "message_to_coalition", coalition: "blue", text: "CAS inbound" },
        { kind: "remove_radio_item", text: "Request CAS" },
      ],
    },
    s.dictionary
  );

  const reparsed = parseLuaAssignment(serializeLuaAssignment("mission", s.mission), "mission");
  const trig = asTable(reparsed["trig"])!;
  const actions = asTable(trig["actions"])!;
  const groupId = (reparsed["coalition"] as any).blue.country[1].plane.group[1].groupId;

  assert.equal(
    actions[1],
    `a_add_radio_item(getValueDictByKey("DictKey_ActionRadioText_1"), 7, 1);` +
      `a_add_radio_item_for_group(${groupId}, getValueDictByKey("DictKey_ActionRadioText_2"), 8, 1);`
  );
  assert.match(String(actions[2]), /a_remove_radio_item\(getValueDictByKey\("DictKey_ActionRadioText_4"\)\);/);

  // Menu labels use the radio prefix; message text uses the plain one.
  assert.equal(s.dictionary["DictKey_ActionRadioText_1"], "Request CAS");
  assert.equal(s.dictionary["DictKey_ActionRadioText_2"], "Request tanker");
  assert.equal(s.dictionary["DictKey_ActionText_3"], "CAS inbound");
  closeSession(s.id);
});

test("radio transmission converts MHz to the Hz the runtime expects", () => {
  const s = newSession("Caucasus", 43200);
  const store = storeOf(s);
  const { key } = addResource(store, "callout.ogg", Buffer.from([1, 2, 3]));
  s.mission["triggers"] = { zones: {} };
  addTrigger(
    s.mission,
    {
      type: "start",
      conditions: [],
      actions: [{ kind: "do_script", text: "env.info('hello')" }],
    },
    s.dictionary
  );
  // Zone needed for the transmission's origin.
  addTriggerZone(s.mission, { name: "Tower", x: 0, y: 0, radius: 1000 });
  addTrigger(
    s.mission,
    {
      type: "once",
      conditions: [{ kind: "time_after", seconds: 5 }],
      actions: [
        {
          kind: "radio_transmission",
          resourceKey: key,
          zone: "Tower",
          frequencyMHz: 127.5,
          name: "atis",
        },
      ],
    },
    s.dictionary
  );

  const trig = asTable(s.mission["trig"])!;
  const actions = asTable(trig["actions"])!;
  assert.equal(actions[1], `a_do_script("env.info('hello')");`);
  assert.match(String(actions[2]), /a_radio_transmission\(getValueResourceByKey\("ResKey_Action_1"\), 1, true, false, 127500, 100, "atis", 0, true, true\);/);
  closeSession(s.id);
});
