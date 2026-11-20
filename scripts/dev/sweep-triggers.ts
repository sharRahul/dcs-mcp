/**
 * Recompile every trigger in every Mission-Editor-saved mission you point this
 * at, and compare the result with the compiled Lua DCS itself wrote.
 *
 * This is the widest check the trigger compiler has: the oracle fixture pins 66
 * predicates, this pins the compiler against tens of thousands of real calls.
 * Run it after touching anything in CONDITION_COMPILERS / ACTION_COMPILERS:
 *
 *   node --import tsx scripts/dev/sweep-triggers.ts "<missions folder>" ["<more>" ...]
 *
 * Good folders: `Saved Games/DCS/Missions`, and `<DCS>/Mods/aircraft` plus
 * `<DCS>/Mods/campaigns` for the missions ED ships.
 *
 * A mismatch is not automatically a bug: the editor writes several forms for
 * some actions (`a_out_text_delay` with and without its trailing delay,
 * `a_radio_transmission` with 11 or 12 arguments) for specs with identical
 * fields, so a few per cent of strings differ by a trailing default. What must
 * not happen is a mismatch in the ARGUMENT ORDER or a predicate whose shape
 * differs for a reason the rule explains.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import { parseLuaAssignment, asTable, luaArray, type LuaTable } from '../../src/miz/lua.js';
import { compileTrig } from '../../src/miz/authoring.js';

const files: string[] = [];
const walkDir = (d: string) => {
  try {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { if (!/vs code|opencode|test missions/i.test(e.name)) walkDir(p); }
      else if (e.name.toLowerCase().endsWith('.miz')) files.push(p);
    }
  } catch { /* unreadable */ }
};
process.argv.slice(2).forEach(walkDir);

let missions = 0, rules = 0, compiledCount = 0, skippedCount = 0, matched = 0;
const mismatches = new Map<string, { n: number; was: string; now: string; file: string }>();
const skippedPredicates = new Map<string, number>();

for (const f of files) {
  let mission: LuaTable;
  try {
    const z = new AdmZip(f);
    const e = z.getEntry('mission');
    if (!e) continue;
    mission = parseLuaAssignment(e.getData().toString('utf8'), 'mission');
  } catch { continue; }
  const original = asTable(mission['trig']);
  if (!original) continue;
  const beforeConditions = { ...(asTable(original['conditions']) ?? {}) };
  const beforeActions = { ...(asTable(original['actions']) ?? {}) };
  missions++;
  const ruleList = luaArray(mission['trigrules']);
  rules += ruleList.length;
  const { compiled, skipped } = compileTrig(mission);
  compiledCount += compiled.length;
  skippedCount += skipped.length;
  for (const i of skipped) {
    const rule = ruleList[i - 1];
    if (!rule) continue;
    for (const list of ['rules', 'actions'] as const) {
      for (const entry of luaArray(rule[list])) {
        const p = String(entry['predicate']);
        skippedPredicates.set(p, (skippedPredicates.get(p) ?? 0) + 1);
      }
    }
  }
  const after = asTable(mission['trig'])!;
  for (const i of compiled) {
    for (const [kind, before, now] of [
      ['conditions', beforeConditions[i], asTable(after['conditions'])?.[i]],
      ['actions', beforeActions[i], asTable(after['actions'])?.[i]],
    ] as const) {
      if (typeof before !== 'string') continue;
      if (before === now) { matched++; continue; }
      const rule = ruleList[i - 1];
      const predicates = [
        ...luaArray(rule?.['rules'] ?? {}).map(e => String(e['predicate'])),
        ...luaArray(rule?.['actions'] ?? {}).map(e => String(e['predicate'])),
      ].join(',');
      const key = `${kind} :: ${predicates}`;
      const hit = mismatches.get(key);
      if (hit) hit.n++;
      else mismatches.set(key, { n: 1, was: String(before).slice(0, 220), now: String(now).slice(0, 220), file: f.split(/[\\/]/).pop()! });
    }
  }
}

console.log(`missions=${missions} trigrules=${rules} compiled=${compiledCount} skipped=${skippedCount}`);
console.log(`compiled strings compared=${matched + [...mismatches.values()].reduce((a, m) => a + m.n, 0)} identical=${matched}`);
console.log(`\nMISMATCH SHAPES: ${mismatches.size}`);
for (const [k, v] of [...mismatches].sort((a, b) => b[1].n - a[1].n).slice(0, 12)) {
  console.log(`\n ${v.n}x ${k}   (${v.file})`);
  console.log(`   DCS : ${v.was}`);
  console.log(`   ours: ${v.now}`);
}
console.log('\nPREDICATES IN SKIPPED RULES (top 20):');
console.log([...skippedPredicates].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([k, v]) => `${k}:${v}`).join(' '));
