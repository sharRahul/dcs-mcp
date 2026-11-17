/** Regression suite over Mission-Editor-saved missions (tests/fixtures/native, or DCS_NATIVE_MIZ_DIR). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { closeSession, newSession, openSession, saveSessionAs } from "../src/miz/sessions.js";
import { parseLuaAssignment } from "../src/miz/lua.js";
import { serializeLuaAssignment } from "../src/miz/serializer.js";
import { validateMission } from "../src/miz/validator.js";
import { addTriggerZone, addGroundGroup } from "../src/miz/authoring.js";

interface Fixture { file: string; sha256?: string; expectedErrors?: string[]; label: string }
const DIR = join("tests", "fixtures", "native");
const manifest = JSON.parse(readFileSync(join(DIR, "manifest.json"), "utf8")) as { fixtures: Omit<Fixture, "label">[] };
const fixtures: Fixture[] = manifest.fixtures.map((f) => ({ ...f, file: join(DIR, f.file), label: f.file }));
function walk(dir: string, out: string[] = [], depth = 0): string[] {
  if (depth > 4 || out.length >= 200) return out;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    try { if (statSync(p).isDirectory()) walk(p, out, depth + 1); else if (e.toLowerCase().endsWith(".miz")) out.push(p); } catch { /* skip */ }
  }
  return out;
}
const extra = process.env.DCS_NATIVE_MIZ_DIR;
if (extra && existsSync(extra)) for (const f of walk(extra)) fixtures.push({ file: f, label: `local:${f}` });

const LUA_ENTRIES: Record<string, string> = { mission: "mission", options: "options", warehouses: "warehouses",
  "l10n/DEFAULT/dictionary": "dictionary", "l10n/DEFAULT/mapResource": "mapResource" };
const RESERIALIZED = new Set(["mission", "l10n/DEFAULT/dictionary", "l10n/DEFAULT/mapResource", "theatre"]);

/** The checks every native fixture must pass; also run once on a self-made mission to prove the suite. */
async function checkMission(path: string, expectedErrors: string[] = []) {
  const zip = new AdmZip(readFileSync(path));
  // 3. Every Lua data entry round-trips exactly.
  for (const [entry, global] of Object.entries(LUA_ENTRIES)) {
    const e = zip.getEntry(entry);
    if (!e) continue;
    const parsed = parseLuaAssignment(e.getData().toString("utf8"), global);
    assert.deepEqual(parseLuaAssignment(serializeLuaAssignment(global, parsed), global), parsed, `${entry} round trip`);
  }
  const s = await openSession(path);
  try {
    // 4. No unexpected validator errors on an editor-made file.
    const errors = validateMission(s.document, s.mission).errors.map((i) => i.code).filter((c) => !expectedErrors.includes(c));
    assert.deepEqual([...new Set(errors)], [], `unexpected validator errors`);
    // 2. Unmodified save preserves every other entry byte for byte.
    const out = join(mkdtempSync(join(tmpdir(), "native-")), "resaved.miz");
    await saveSessionAs(s, out);
    const after = new AdmZip(readFileSync(out));
    for (const e of zip.getEntries()) {
      if (e.isDirectory) continue;
      const a = after.getEntry(e.entryName);
      assert.ok(a, `entry ${e.entryName} kept`);
      if (RESERIALIZED.has(e.entryName)) {
        const g = LUA_ENTRIES[e.entryName];
        if (g) assert.deepEqual(parseLuaAssignment(a!.getData().toString("utf8"), g), parseLuaAssignment(e.getData().toString("utf8"), g), e.entryName);
      } else assert.ok(a!.getData().equals(e.getData()), `entry ${e.entryName} byte-identical`);
    }
    // 5. A small edit touches only what it should.
    const before = structuredClone(s.mission);
    addTriggerZone(s.mission, { name: "__native_probe__", x: 0, y: 0, radius: 100 });
    const { triggers: t1, ...rest1 } = before as Record<string, unknown>;
    const { triggers: t2, ...rest2 } = s.mission as Record<string, unknown>;
    assert.deepEqual(rest2, rest1, "adding a zone changed something outside triggers");
    void t1; void t2;
  } finally { closeSession(s.id); }
}

test("native fixture suite is self-consistent on a mission made here", async () => {
  const s = newSession("Caucasus", 43200);
  addGroundGroup(s.mission, "vehicle", { side: "red", country: "Russia", name: "Armor", type: "T-72B", count: 2, x: 0, y: 0 });
  const p = join(mkdtempSync(join(tmpdir(), "native-self-")), "self.miz");
  await saveSessionAs(s, p); closeSession(s.id);
  await checkMission(p);
});

for (const f of fixtures) {
  test(`native mission ${f.label}`, async () => {
    if (f.sha256) assert.equal(createHash("sha256").update(readFileSync(f.file)).digest("hex"), f.sha256, "fixture differs from the manifest");
    await checkMission(f.file, f.expectedErrors ?? []);
  });
}
test("native fixtures present", { skip: fixtures.length ? false : "no Mission-Editor-saved fixtures yet (see tests/fixtures/native/README.md)" }, () => {
  assert.ok(fixtures.length > 0);
});
