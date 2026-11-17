import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { acceptanceCases } from './cases.js';
import { checkMission } from './checks.js';
import { generateScenario } from '../scenario/engine.js';
import { addTrigger, setPayload, findGroup, type ActionSpec } from '../miz/authoring.js';
import { addFarp, populateAirfield } from '../miz/dressing.js';
import { findAirport } from '../data/reference.js';
import { asTable, luaArray } from '../miz/lua.js';
import { loadScripts } from '../miz/frameworks.js';
import { serializeLuaAssignment, quoteLuaString } from '../miz/serializer.js';
import { saveSessionAs, closeSession, refresh } from '../miz/sessions.js';
import { claimStartAirfields, editWarehouse } from '../miz/logistics.js';
import { packagePath } from '../paths.js';
import { atomicWrite } from '../security/files.js';
import { missionReport } from '../miz/report.js';
export interface Progress { phase: string; completed: number; total: number; scenario?: string }
const documents = ['readme.md', 'test_matrix.md', 'manual_test_plan.md', 'expected_results.md', 'known_limitations.md', 'results_template.md'];
export async function generateAcceptancePackage(outDir: string, onProgress?: (progress: Progress) => void) {
  const root = path.resolve(outDir), runId = randomUUID(), cases = acceptanceCases(), manifests = [];
  await mkdir(root); // Deliberately not recursive: existing output is never replaced.
  try {
    await mkdir(path.join(root, 'missions')); await mkdir(path.join(root, 'specifications')); await mkdir(path.join(root, 'reports'));
    for (const doc of documents) await atomicWrite(path.join(root, doc), await readFile(packagePath('docs', 'testing', 'live-acceptance', doc)));
    for (const [index, test] of cases.entries()) {
      onProgress?.({ phase: 'generate', completed: index, total: cases.length, scenario: test.id });
      const built = generateScenario(test.specification), s = built.session;
      try {
        if (test.id === '04-cas-jtac') {
          // FAC shape copied as format facts from pinned pydcs task.FAC; not a fictional radio script.
          const jtac = findGroup(s.mission, 'JTAC')!.group;
          const point = asTable(asTable(asTable(jtac.route)?.points)?.[1])!;
          point.task = { id: 'ComboTask', params: { tasks: { 1: { id: 'FAC', auto: false, enabled: true, number: 1,
            params: { designation: 'Auto', frequency: 30000000, modulation: 1, datalink: true, callname: 1, number: 1 } } } } };
        }
        const airport = findAirport('Caucasus', 'Kutaisi');
        if (test.id === '08-airfield-farp') {
          populateAirfield(s.mission, { side: 'blue', country: 'USA', airfield: 'Kutaisi', types: ['F-16C_50'], count: 3, namePrefix: 'Parked' });
          // The scenario already supplies a pad; add a second supported FARP with its own service vehicles.
          addFarp(s.mission, { side: 'blue', country: 'USA', name: 'ServicePad', x: airport.x + 5000, y: airport.y + 3000, support: true });
          // Test the helicopter at the serviced pad, not at an unsupported bare pad.
          const helicopter = findGroup(s.mission, 'Huey')!.group;
          const pad = luaArray(findGroup(s.mission, 'ServicePad')!.group.units)[0];
          const first = asTable(asTable(asTable(helicopter.route)?.points)?.[1])!;
          first.linkUnit = pad.unitId!; first.helipadId = pad.unitId!; first.x = pad.x!; first.y = pad.y!;
          helicopter.x = pad.x!; helicopter.y = pad.y!;
          for (const u of luaArray(helicopter.units)) { u.x = pad.x!; u.y = pad.y!; }
        }
        if (test.id === '09-logistics') s.warehouses = editWarehouse(s, 'airports', airport.id, { coalition: 'BLUE', unlimitedFuel: false, unlimitedAircrafts: false, unlimitedMunitions: false, fuel: { jet_fuel: 1 } }, true);
        // Case edits above can re-link a start (08 moves the Huey to ServicePad);
        // re-claim so every start base has its warehouse entry. Idempotent.
        claimStartAirfields(s);
        await loadScripts(s, s.dictionary, [{ filePath: packagePath('scripts', 'dcs-mcp-telemetry.lua') }]);
        addTrigger(s.mission, { type: 'start', comment: 'Acceptance identity', conditions: [], actions: [{ kind: 'do_script', text:
          `DCSMCP_ACCEPTANCE = {runId=${quoteLuaString(runId)}, scenarioId=${quoteLuaString(test.id)}}\nenv.info('[DCSMCP] ACCEPTANCE runId=${runId} scenarioId=${test.id}')` }] }, s.dictionary);
        for (const [value, outcome] of [[1, 'victory'], [2, 'failure']] as const) addTrigger(s.mission, { type: 'once', comment: `Acceptance ${outcome}`, conditions: [{ kind: 'flag_equals', flag: built.report.outcome.outcomeFlag, value }], actions: [{ kind: 'do_script', text:
          `env.info('[DCSMCP] ACCEPTANCE_OBJECTIVE runId=${runId} scenarioId=${test.id} outcome=${outcome}')` }] }, s.dictionary);
        refresh(s);
        const missionPath = path.join(root, 'missions', `${test.id}.miz`);
        await saveSessionAs(s, missionPath);
        const offline = await checkMission(missionPath); if (!offline.ok) throw new Error(`${test.id}: ${offline.errors.join('; ')}`);
        const report = missionReport(s);
        await atomicWrite(path.join(root, 'reports', `${test.id}.json`), JSON.stringify({ offline, report, director: built.report.director }, null, 2));
        await atomicWrite(path.join(root, 'specifications', `${test.id}.json`), JSON.stringify(built.specification, null, 2));
        // Trusted generated Lua files allow local 5.1 loading/compilation without executing arbitrary input.
        await atomicWrite(path.join(root, 'reports', `${test.id}.lua`), serializeLuaAssignment('mission', s.mission));
        manifests.push({ ...test, specification: `specifications/${test.id}.json`, mission: `missions/${test.id}.miz`, report: `reports/${test.id}.json`, lua: `reports/${test.id}.lua`,
          digest: offline.digest, groups: s.document.groups.map(g => g.name), outcomeFlag: built.report.outcome.outcomeFlag,
          expectedUnits: s.document.groups.flatMap(g => g.units.map(u => ({ ...u, group: g.name }))),
          expectedTasks: s.document.groups.map(g => ({ group: g.name, task: g.task ?? null, route: findGroup(s.mission, g.name)!.group.route })),
          expectedTriggers: s.document.triggers, frequencies: built.report.forces.map(f => ({ group: f.name, frequencyMHz: f.frequencyMHz })),
          radio: built.report.director?.radioScript ?? [{ delivery: 'scenario outcome messages and any declared F10 items; no recorded voice supplied' }],
          offline, liveStatus: 'pending', requiredEvidence: ['Mission Editor screenshots', 'Flight/feature screenshots', 'Session dcs.log', 'Telemetry/runtime snapshot', 'Operator results JSON'],
          stockMode: test.id === '09-logistics' ? 'finite-empty aircraft/weapons; 1 InitFuel unit; positive native inventory metadata not supplied' : null });
      } finally { closeSession(s.id); }
    }
    const manifest = { version: 1, runId, verification: 'offline only; all live DCS checks pending', scenarios: manifests };
    await atomicWrite(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2));
    await atomicWrite(path.join(root, 'offline-report.json'), JSON.stringify({ status: 'pass', scenarios: manifests.length, liveStatus: 'pending', checks: manifests.map(m => ({ scenario: m.id, ...m.offline })) }, null, 2));
    onProgress?.({ phase: 'complete', completed: cases.length, total: cases.length });
    return { directory: root, runId, scenarios: cases.length, manifest: path.join(root, 'manifest.json'), offlineStatus: 'pass', liveStatus: 'pending' };
  } catch (e) {
    await atomicWrite(path.join(root, 'generation-failure.json'), JSON.stringify({ runId, completedScenarios: manifests.map(m => m.id), error: (e as Error).message, liveStatus: 'pending' }, null, 2));
    throw e;
  }
}
