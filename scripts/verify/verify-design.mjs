#!/usr/bin/env node
/** Reproducible phase 4–6 acceptance artifact; stock Lua runtime is optional. */
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { generateScenario } from '../../dist/scenario/engine.js';
import { addTrigger, findGroup, findUnit } from '../../dist/miz/authoring.js';
import { serializeLuaAssignment } from '../../dist/miz/serializer.js';
import { saveSessionAs, openSession, closeSession, refresh } from '../../dist/miz/sessions.js';
import { listAssets } from '../../dist/miz/assets.js';
const output = process.argv[2]; if (!output) throw new Error('Usage: npm run build && npm run verify:design -- <new-output-directory>');
mkdirSync(output, { recursive: true });
const spec = JSON.parse(readFileSync(new URL('../../examples/scenarios/interception.json', import.meta.url), 'utf8'));
spec.director.events.push({ id: 'update', phase: 'awacs', channel: 'control', when: { afterEvent: 'depart', delaySeconds: 10 }, template: 'contact', subject: 'the intercept' });
const a = generateScenario(spec), b = generateScenario(spec);
try {
  assert.equal(serializeLuaAssignment('mission', a.session.mission), serializeLuaAssignment('mission', b.session.mission));
  addTrigger(a.session.mission, { type: 'change', comment: 'Runtime counter', conditions: [{ kind: 'flag_is_true', flag: 7001 }], actions: [{ kind: 'do_script', text: 'trigger.action.setUserFlag(7000, (tonumber(trigger.misc.getUserFlag(7000)) or 0) + 2)' }] }, a.session.dictionary);
  refresh(a.session);
  const saved = await saveSessionAs(a.session, join(output, 'mission-design-proof.miz'));
  const back = await openSession(saved.outPath); assert.ok(listAssets(back).some(asset => asset.path.endsWith('scenario-report.json'))); closeSession(back.id);
  const runtime = [];
  if (process.env.LUA51) {
    const temp = mkdtempSync(join(tmpdir(), 'dcs-design-lua51-'));
    try {
      const mission = join(temp, 'mission.lua'), dictionary = join(temp, 'dictionary.lua'), manifest = join(temp, 'manifest.lua');
      writeFileSync(mission, serializeLuaAssignment('mission', a.session.mission)); writeFileSync(dictionary, serializeLuaAssignment('dictionary', a.session.dictionary));
      writeFileSync(manifest, serializeLuaAssignment('manifest', { departure: a.report.director.eventFlags.depart, update: a.report.director.eventFlags.update,
        outcome: a.report.outcome.outcomeFlag, enemyGroup: findGroup(a.session.mission, 'Bombers').group.groupId, playerUnit: findUnit(a.session.mission, 'Intercept-1').unitId }));
      for (const mode of ['success', 'failure']) for (const order of ['forward', 'reverse']) {
        const result = spawnSync(process.env.LUA51, [resolve('scripts/verify/lua51/design-runtime.lua'), mission, dictionary, manifest, mode, order], { encoding: 'utf8' });
        assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`); runtime.push(result.stdout.trim());
      }
    } finally { rmSync(temp, { recursive: true, force: true }); }
  } else runtime.push('NOT RUN: set LUA51 for stock Lua 5.1 mocked-runtime acceptance');
  const report = { verification: 'OFFLINE and optional mocked Lua only; no DCS/Mission Editor run', node: process.version, platform: process.platform, deterministic: true,
    artifact: saved, runtime, report: a.report };
  writeFileSync(join(output, 'mission-design-verification.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ...saved, evidence: join(output, 'mission-design-verification.json'), runtime }, null, 2));
} finally { closeSession(a.session.id); closeSession(b.session.id); }
