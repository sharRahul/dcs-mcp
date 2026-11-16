import { collectAcceptance } from '../dist/acceptance/collect.js';
const [packageDir, scenarioId, logPath, outputDir, ...rest] = process.argv.slice(2);
if (!outputDir) throw new Error('Usage: acceptance:collect -- PACKAGE SCENARIO DCS_LOG NEW_OUTPUT [--results RESULTS_JSON]');
const i = rest.indexOf('--results');
if (rest.some((x,j) => x !== '--results' && j !== i+1)) throw new Error('Unknown option; bridge snapshots use dcs_runtime_inspect separately');
console.log(JSON.stringify(await collectAcceptance({ packageDir, scenarioId, logPath, outputDir, resultsPath: i < 0 ? undefined : rest[i+1] }), null, 2));
