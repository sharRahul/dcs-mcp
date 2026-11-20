import { collectAcceptance } from '../../dist/acceptance/collect.js';
const [packageDir, scenarioId, logPath, outputDir, ...rest] = process.argv.slice(2);
if (!outputDir) throw new Error('Usage: acceptance:collect -- PACKAGE SCENARIO DCS_LOG NEW_OUTPUT [--results RESULTS_JSON]');
if (rest.length && !(rest.length === 2 && rest[0] === '--results' && rest[1])) throw new Error('Expected only --results RESULTS_JSON; bridge snapshots use dcs_runtime_inspect separately');
console.log(JSON.stringify(await collectAcceptance({ packageDir, scenarioId, logPath, outputDir, resultsPath: rest[1] }), null, 2));
