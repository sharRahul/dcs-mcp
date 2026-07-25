/**
 * Offline acceptance checks for a built `.miz`, before DCS ever sees it.
 *
 * Three things can be proven without launching the sim, and each of them is a
 * failure that otherwise only shows up as a GUI error box or a silently dead
 * mission:
 *
 *   1. The Mission Editor can open it   — ED's own `fixUnitsPos` under luae.exe.
 *   2. Every compiled trigger is Lua    — `mission.trig.*` actually loads.
 *   3. Ground groups face where they were told, and their units trail that
 *      heading instead of stringing off to the north-east.
 *
 *   node scripts/verify-mission.mjs <mission.miz>
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readMizArchive } from "../dist/miz/archive.js";
import { parseMission, parseMissionTables } from "../dist/miz/parser.js";
import { serializeLuaAssignment } from "../dist/miz/serializer.js";
import { luaArray, asTable } from "../dist/miz/lua.js";
import { validateMission } from "../dist/miz/validator.js";

const mizPath = process.argv[2];
if (!mizPath) {
  console.error("usage: node scripts/verify-mission.mjs <mission.miz>");
  process.exit(2);
}

const LUA_CANDIDATES = [
  process.env.DCS_LUA,
  "H:/DCS World/Eagle Dynamics/DCS World/bin-mt/luae.exe",
  "C:/Program Files/Eagle Dynamics/DCS World/bin-mt/luae.exe",
].filter(Boolean);
const lua = LUA_CANDIDATES.find((p) => existsSync(p));

const archive = await readMizArchive(mizPath);
const { mission } = parseMissionTables(archive);
const doc = parseMission(archive);

let failed = 0;
const fail = (msg) => {
  console.error(`FAIL  ${msg}`);
  failed++;
};
const pass = (msg) => console.log(`ok    ${msg}`);

// -------------------------------------------------------------------------
// 1. Validator
// -------------------------------------------------------------------------
const report = validateMission(doc);
for (const e of report.errors) fail(`validator ${e.code}: ${e.message}`);
for (const w of report.warnings) console.warn(`warn  validator ${w.code}: ${w.message}`);
if (report.errors.length === 0) pass(`validator clean (${report.warnings.length} warning(s))`);

// -------------------------------------------------------------------------
// 2. The Mission Editor's own load-time fixups
// -------------------------------------------------------------------------
const dir = mkdtempSync(path.join(tmpdir(), "dcs-verify-"));
const missionLua = path.join(dir, "mission.lua");
writeFileSync(missionLua, serializeLuaAssignment("mission", mission), "utf8");

if (!lua) {
  console.warn("warn  no luae.exe found; skipping Mission Editor open check");
} else {
  const harness = path.resolve(import.meta.dirname, "..", "tests", "fixtures", "me-open.lua");
  const run = spawnSync(lua, [harness, missionLua], { encoding: "utf8" });
  const out = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  if (run.status !== 0 || !out.includes("ME_LOAD_OK")) fail(`Mission Editor open check:\n${out}`);
  else pass(`Mission Editor open check (${out.match(/UNITS (\d+)/)?.[1]} units)`);
}

// -------------------------------------------------------------------------
// 3. Every compiled trigger string is loadable Lua
// -------------------------------------------------------------------------
const trig = asTable(mission["trig"]);
const chunks = [];
for (const section of ["conditions", "actions", "func", "funcStartup"]) {
  const tbl = asTable(trig?.[section]);
  for (const [k, v] of Object.entries(tbl ?? {})) {
    if (typeof v === "string") chunks.push({ where: `trig.${section}[${k}]`, code: v });
  }
}
if (chunks.length === 0) fail("mission has no compiled trig entries at all");
else if (!lua) console.warn("warn  no luae.exe; skipping compiled-trigger syntax check");
else {
  const checker = path.join(dir, "check.lua");
  writeFileSync(
    checker,
    [
      "local file = ...",
      "local bad = 0",
      "for line in io.lines(file) do",
      "  local where, code = line:match('^(%S+)\\t(.*)$')",
      "  if where then",
      "    local fn, err = loadstring(code)",
      "    if not fn then print('BAD ' .. where .. ' :: ' .. tostring(err)); bad = bad + 1 end",
      "  end",
      "end",
      "print('CHECKED ' .. tostring(bad))",
    ].join("\n"),
    "utf8"
  );
  const listing = path.join(dir, "chunks.txt");
  // The compiled strings are single-line by construction; anything multi-line
  // would break this listing format, so assert it rather than assume it.
  const multiline = chunks.filter((c) => /[\r\n]/.test(c.code));
  if (multiline.length > 0) fail(`compiled trig entries contain newlines: ${multiline[0].where}`);
  writeFileSync(listing, chunks.map((c) => `${c.where}\t${c.code.replace(/[\r\n]+/g, " ")}`).join("\n"), "utf8");
  const run = spawnSync(lua, [checker, listing], { encoding: "utf8" });
  const out = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  if (!/CHECKED 0/.test(out)) fail(`compiled trigger syntax:\n${out}`);
  else pass(`all ${chunks.length} compiled trigger chunks are valid Lua`);
}

// -------------------------------------------------------------------------
// 4. Unit geometry
// -------------------------------------------------------------------------
const TWO_PI = Math.PI * 2;
for (const g of doc.groups) {
  if (g.category !== "vehicle" && g.category !== "ship") continue;

  const lead = g.units[0];
  const h = lead.heading ?? 0;
  if (!(h >= 0 && h < TWO_PI)) {
    fail(`${g.name}: heading ${h} is not in [0, 2pi) — degrees written where radians belong?`);
    continue;
  }

  // Units must trail the lead along the reciprocal of the heading. The old bug
  // offset every group to the north-east, whose fingerprint is a 45-degree
  // bearing regardless of which way the group faces.
  if (g.units.length > 1) {
    const u2 = g.units[1];
    const bearing = Math.atan2(u2.y - lead.y, u2.x - lead.x);
    const expected = (h + Math.PI) % TWO_PI;
    const diff = Math.abs(((bearing - expected + Math.PI * 3) % TWO_PI) - Math.PI);
    if (diff > 1e-6) {
      fail(
        `${g.name}: units offset toward ${((bearing + TWO_PI) % TWO_PI * 180 / Math.PI).toFixed(1)} deg, ` +
          `expected ${(expected * 180 / Math.PI).toFixed(1)} deg (heading ${(h * 180 / Math.PI).toFixed(1)})`
      );
      continue;
    }
    // Every unit in the group must share the group's heading.
    for (const u of g.units) {
      if (Math.abs((u.heading ?? 0) - h) > 1e-9) {
        fail(`${g.name}: unit ${u.name} heading ${u.heading} differs from lead ${h}`);
      }
    }
  }
  pass(
    `${g.name}: ${g.units.length} unit(s), heading ${(h * 180 / Math.PI).toFixed(0)} deg, ` +
      `types [${[...new Set(g.units.map((u) => u.type))].join(", ")}]`
  );
}

// -------------------------------------------------------------------------
// 5. Route points — an empty one makes the editor refuse the WHOLE mission
// -------------------------------------------------------------------------
const co = asTable(mission["coalition"]);
for (const side of ["red", "blue", "neutrals"]) {
  for (const c of luaArray(asTable(co?.[side])?.["country"])) {
    for (const cat of ["plane", "helicopter", "vehicle", "ship", "static"]) {
      for (const g of luaArray(asTable(c[cat])?.["group"])) {
        const points = luaArray(asTable(g["route"])?.["points"]);
        if (g["route"] && points.length === 0) fail(`${g["name"]}: route with zero points`);
      }
    }
  }
}
pass("every group with a route has at least one point");

console.log(failed === 0 ? "\nVERIFY OK" : `\nVERIFY FAILED (${failed} problem(s))`);
process.exit(failed === 0 ? 0 : 1);
