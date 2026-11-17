/**
 * Validate every Mission-Editor-saved mission you point this at.
 *
 * An ERROR means DCS or the editor cannot handle the file, so an error on a
 * mission that DCS ships or that someone has flown is OUR bug, not theirs. Run
 * this before changing ANY severity in the validator, and keep the error list
 * empty:
 *
 *   node --import tsx scripts/sweep-validator.ts "<missions folder>" ["<more>" ...]
 *
 * Folders this project writes into are skipped, so the corpus stays independent.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readMizArchive } from '../src/miz/archive.js';
import { parseLuaAssignment } from '../src/miz/lua.js';
import { parseMission } from '../src/miz/parser.js';
import { validateMission } from '../src/miz/validator.js';

const files: string[] = [];
const walkDir = (d: string) => {
  try {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { if (!/vs code|opencode/i.test(e.name)) walkDir(p); }
      else if (e.name.toLowerCase().endsWith('.miz')) files.push(p);
    }
  } catch { /* unreadable */ }
};
process.argv.slice(2).forEach(walkDir);

let ok = 0, unreadable = 0;
const errors = new Map<string, number>();
const warnings = new Map<string, number>();
const offenders: string[] = [];
const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

for (const f of files) {
  let report;
  try {
    const archive = await readMizArchive(f);
    const text = archive.entries.get('mission');
    if (!text) { unreadable++; continue; }
    const raw = parseLuaAssignment(text, 'mission');
    report = validateMission(parseMission(archive), raw);
  } catch { unreadable++; continue; }
  ok++;
  for (const e of report.errors) bump(errors, e.code);
  for (const w of report.warnings) bump(warnings, w.code);
  if (report.errors.length) offenders.push(`${f.split(/[\\/]/).pop()}: ${report.errors.slice(0, 3).map(e => e.code).join(',')}`);
}
console.log(`missions=${files.length} validated=${ok} unreadable=${unreadable}`);
console.log(`ERRORS: ${[...errors].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' ') || '(none)'}`);
offenders.slice(0, 10).forEach(o => console.log('  !', o));
console.log(`WARNINGS: ${[...warnings].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' ')}`);
