import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { openSession, closeSession } from "../src/miz/sessions.js";
import { validateMission } from "../src/miz/validator.js";
import { parseLuaAssignment, luaArray } from "../src/miz/lua.js";
import { assertSafeEntryName, ArchivePolicyError } from "../src/security/archive-policy.js";

const MISSION_LUA = `mission =
{
    ["theatre"] = "Caucasus",
    ["start_time"] = 43200,
    ["date"] = { ["Year"] = 2016, ["Month"] = 6, ["Day"] = 1 },
    ["weather"] =
    {
        ["season"] = { ["temperature"] = 20 },
        ["qnh"] = 760,
        ["clouds"] = { ["base"] = 1200 },
        ["groundTurbulence"] = 0,
        ["wind"] = { ["atGround"] = { ["speed"] = 3, ["dir"] = 180 } },
    },
    ["sortie"] = "DictKey_sortie_1",
    ["descriptionText"] = "DictKey_descriptionText_2",
    ["coalition"] =
    {
        ["blue"] =
        {
            ["country"] =
            {
                [1] =
                {
                    ["name"] = "USA",
                    ["id"] = 2,
                    ["plane"] =
                    {
                        ["group"] =
                        {
                            [1] =
                            {
                                ["name"] = "Colt 1",
                                ["task"] = "CAP",
                                ["route"] = { ["points"] = { [1] = {}, [2] = {} } },
                                ["units"] =
                                {
                                    [1] = { ["name"] = "Colt 1-1", ["type"] = "FA-18C_hornet", ["skill"] = "Client", ["x"] = 1000, ["y"] = 2000, ["alt"] = 6096, ["heading"] = 1.5 },
                                    [2] = { ["name"] = "Colt 1-2", ["type"] = "FA-18C_hornet", ["skill"] = "High", ["x"] = 1050, ["y"] = 2050, ["alt"] = 6096 },
                                },
                            },
                        },
                    },
                },
            },
        },
    },
    ["triggers"] = { ["zones"] = { [1] = { ["name"] = "CAP Zone", ["x"] = 5000, ["y"] = 6000, ["radius"] = 20000, ["type"] = 0 } } },
    ["trigrules"] = { [1] = {}, [2] = {} },
} -- end of mission
`;

const DICT_LUA = `dictionary =
{
    ["DictKey_sortie_1"] = "Operation North Star",
    ["DictKey_descriptionText_2"] = "Protect the carrier from incoming raids.",
} -- end of dictionary
`;

function buildFixtureMiz(): string {
  const dir = mkdtempSync(join(tmpdir(), "dcs-miz-"));
  const zip = new AdmZip();
  zip.addFile("mission", Buffer.from(MISSION_LUA, "utf8"));
  zip.addFile("l10n/DEFAULT/dictionary", Buffer.from(DICT_LUA, "utf8"));
  zip.addFile("theatre", Buffer.from("Caucasus", "utf8"));
  const path = join(dir, "test.miz");
  writeFileSync(path, zip.toBuffer());
  return path;
}

test("lua parser evaluates data tables and arrays", () => {
  const t = parseLuaAssignment(`x = { [1] = { ["a"] = 1 }, [2] = { ["a"] = -2 }, ["k"] = "v" }`, "x");
  assert.equal(t["k"], "v");
  const arr = luaArray(t);
  assert.equal(arr.length, 2);
  assert.equal(arr[1]["a"], -2);
});

test("lua parser rejects executable constructs", () => {
  assert.throws(() => parseLuaAssignment(`x = os.time()`, "x"), /non-data Lua node/);
});

test("archive policy rejects path traversal and absolute paths", () => {
  assert.throws(() => assertSafeEntryName("../evil"), ArchivePolicyError);
  assert.throws(() => assertSafeEntryName("/etc/passwd"), ArchivePolicyError);
  assertSafeEntryName("l10n/DEFAULT/dictionary"); // safe, no throw
});

test("open parses mission into canonical model", async () => {
  const path = buildFixtureMiz();
  const session = await openSession(path);
  const s = session.document.summary;
  assert.equal(s.theatre, "Caucasus");
  assert.equal(s.groupCount, 1);
  assert.equal(s.unitCount, 2);
  assert.equal(s.zoneCount, 1);
  assert.equal(s.triggerCount, 2);
  assert.equal(s.weather.qnhMmHg, 760);
  assert.deepEqual(s.countriesByCoalition, { blue: ["USA"] });

  const group = session.document.groups[0];
  assert.equal(group.name, "Colt 1");
  assert.equal(group.task, "CAP");
  assert.equal(group.waypointCount, 2);
  assert.equal(group.units[0].type, "FA-18C_hornet");

  // Dictionary resolution.
  assert.equal(session.document.briefing.title, "Operation North Star");
  assert.equal(session.document.briefing.description, "Protect the carrier from incoming raids.");

  // sha256 digest present.
  assert.match(session.document.sourceDigest, /^[0-9a-f]{64}$/);

  closeSession(session.id);
});

test("validator flags duplicate names", async () => {
  const path = buildFixtureMiz();
  const session = await openSession(path);
  // Inject a duplicate unit name.
  session.document.groups[0].units[1].name = "Colt 1-1";
  const report = validateMission(session.document);
  // The Mission Editor saves duplicate unit names (65 of them across the 184 ME-saved
  // missions this was calibrated against), so DCS accepts them: a warning, not an error.
  assert.ok(report.warnings.some((e) => e.code === "DUP_UNIT_NAME"));
  assert.ok(!report.errors.some((e) => e.code === "DUP_UNIT_NAME"));
  closeSession(session.id);
});
