import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DATASETS, provenanceReport } from "../src/data/provenance.js";

const HEX = /^[0-9a-f]{64}$/;

test("every bundled dataset is registered, sourced and pinned", () => {
  const r = provenanceReport();
  assert.deepEqual(r.unregistered, [], "data/*.json files missing from src/data/provenance.ts");
  for (const d of r.datasets) {
    assert.ok(d.source.length > 20, `${d.file}: _source`);
    assert.ok(d.pinnedInputs >= 1, `${d.file}: no pinned inputs in ${d.pins.field}`);
    assert.match(d.fileSha256, HEX);
  }
  for (const f of ["countries.json", "unit-types.json", "theatres.json", "authoring.json", "airfield-radio.json"]) {
    const data = JSON.parse(readFileSync(join("data", f), "utf8"));
    for (const [input, h] of Object.entries(data._sha256 as Record<string, string>)) assert.match(h, HEX, `${f}: ${input}`);
  }
  const rwi = JSON.parse(readFileSync("data/real-world-inventory.json", "utf8"));
  for (const [title, p] of Object.entries(rwi._revisions.pages as Record<string, { revid: number }>)) assert.ok(Number.isInteger(p.revid), title);
});

// Byte-for-byte regeneration from a pinned pydcs 1.0.0 tree: set PYDCS_SRC to the unpacked wheel.
const PYDCS = process.env.PYDCS_SRC;
const python = process.platform === "win32" ? "python" : "python3";
const hasPython = spawnSync(python, ['--version'], { windowsHide: true }).status === 0;

test('navaid regeneration refuses absent external charts without changing existing data', { skip: !hasPython }, t => {
  const dir = mkdtempSync(join(tmpdir(), 'navaid-input-check-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const output = join(dir, 'existing.json');
  writeFileSync(output, 'keep existing data');
  const empty = join(dir, 'empty');
  mkdirSync(empty);
  for (const source of [join(dir, 'missing'), empty]) {
    const result = spawnSync(python, ['-I', 'scripts/gen-airfield-navaids.py', source, 'data/airfield-radio.json', output],
      { encoding: 'utf8', windowsHide: true });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /external.*PNG|PNG.*external/i);
    assert.equal(readFileSync(output, 'utf8'), 'keep existing data');
  }
});
test("pydcs-derived datasets regenerate byte-for-byte", { skip: PYDCS ? false : "set PYDCS_SRC to an unpacked pydcs 1.0.0 wheel" }, () => {
  const out = mkdtempSync(join(tmpdir(), "regen-"));
  const run = (args: string[]) => { const r = spawnSync(python, ["-I", ...args], { encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); };
  run(["scripts/gen-reference-data.py", PYDCS!, out]);
  run(["scripts/gen-authoring-data.py", PYDCS!, join(out, "authoring.json")]);
  run(["scripts/gen-airfield-radio.py", PYDCS!, join(out, "airfield-radio.json")]);
  for (const f of ["countries.json", "unit-types.json", "theatres.json", "authoring.json", "airfield-radio.json"])
    assert.ok(readFileSync(join(out, f)).equals(readFileSync(join("data", f))), `${f} differs from a fresh regeneration`);
  assert.ok(DATASETS.length >= 10);
});
