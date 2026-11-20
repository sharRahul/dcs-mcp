#!/usr/bin/env node
import { generateAcceptancePackage } from '../../dist/acceptance/package.js';
if (!process.argv[2]) throw new Error('Usage: npm run acceptance:generate -- <new-output-directory>');
try { console.log(JSON.stringify(await generateAcceptancePackage(process.argv[2], p => console.error(`${p.completed}/${p.total} ${p.phase} ${p.scenario ?? ''}`)), null, 2)); }
catch (error) { console.error(error.message); process.exitCode = 1; }
