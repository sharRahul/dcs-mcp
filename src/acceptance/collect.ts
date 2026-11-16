/** Evidence is correlated and preserved; operator attestations are never automatic AI verification. */
import { mkdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { atomicWrite } from '../security/files.js';
import { assertInputBudget } from '../security/input-budget.js';
const checkIds = ['ME_OPEN', 'SPAWN', 'TASKS', 'FEATURE', 'TRIGGERS', 'RADIO', 'OBJECTIVE', 'LOG_CLEAN'] as const;
const resultsSchema = z.object({ runId: z.string().uuid(), scenarioId: z.string(), expectedOutcome: z.enum(['victory', 'failure']), notes: z.string(), checks: z.array(z.object({ id: z.enum(checkIds), status: z.enum(['pending', 'blocked', 'pass', 'fail']), notes: z.string(), evidence: z.array(z.string()).max(30) }).strict()).length(8) }).strict();
const manifestSchema = z.object({ version: z.literal(1), runId: z.string().uuid(), scenarios: z.array(z.object({ id: z.string().regex(/^\d\d-[a-z0-9-]+$/), digest: z.string(), outcomeFlag: z.number().int() }).passthrough()).max(100) }).passthrough();
async function boundedRead(file: string, max = 64 * 1024 * 1024) {
  const info = await stat(file); if (!info.isFile() || info.size > max) throw new Error(`Expected regular file no larger than ${max} bytes: ${file}`);
  const bytes = await readFile(file); if (bytes.length > max) throw new Error(`File grew past size limit: ${file}`); return bytes;
}
const digest = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
export async function collectAcceptance(options: { packageDir: string; scenarioId: string; logPath: string; outputDir: string; resultsPath?: string }) {
  const raw = JSON.parse((await boundedRead(path.join(options.packageDir, 'manifest.json'), 8 * 1024 * 1024)).toString()); assertInputBudget(raw);
  const manifest = manifestSchema.parse(raw), scenario = manifest.scenarios.find(s => s.id === options.scenarioId);
  if (!scenario) throw new Error('Unknown acceptance scenario; select an id from manifest.json');
  const logBytes = await boundedRead(options.logPath), log = logBytes.toString('utf8');
  const marker = `[DCSMCP] ACCEPTANCE runId=${manifest.runId} scenarioId=${scenario.id}`;
  const start = log.lastIndexOf(marker), next = start < 0 ? -1 : log.indexOf('[DCSMCP] ACCEPTANCE runId=', start + marker.length);
  const session = start < 0 ? '' : log.slice(start, next < 0 ? undefined : next);
  const problems = session.split(/\r?\n/).filter(line => /SCRIPTING.*(?:ERROR|error)|ERROR.*(?:Lua|SCRIPTING)|[Ll]ua [Ee]rror/.test(line));
  let operator: z.infer<typeof resultsSchema> | undefined;
  let evidenceBytes = 0;
  const files: { source: string; target: string; bytes: Buffer; sha256: string }[] = [];
  if (options.resultsPath) {
    const parsed = JSON.parse((await boundedRead(options.resultsPath, 1024 * 1024)).toString()); assertInputBudget(parsed); operator = resultsSchema.parse(parsed);
    if (operator.runId !== manifest.runId || operator.scenarioId !== scenario.id) throw new Error('Operator results do not match package run/scenario');
    if (new Set(operator.checks.map(c => c.id)).size !== checkIds.length) throw new Error('Each check id must occur exactly once');
    const base = await realpath(path.dirname(path.resolve(options.resultsPath)));
    for (const c of operator.checks) {
      if (c.status === 'pass' && (!c.notes.trim() || c.evidence.length === 0)) throw new Error(`Pass requires notes and evidence: ${c.id}`);
      for (const name of c.evidence) {
        if (!name || path.isAbsolute(name) || name.includes('\\') || name.includes(':') || name.split('/').some(p => !p || p === '.' || p === '..')) throw new Error(`Unsafe evidence path: ${name}`);
        const source = await realpath(path.join(base, name)), relative = path.relative(base, source);
        if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Evidence escapes results directory');
        const bytes = await boundedRead(source, 32 * 1024 * 1024);
        evidenceBytes += bytes.length; if (evidenceBytes > 128 * 1024 * 1024) throw new Error('Total operator evidence exceeds 128 MiB; split collections');
        files.push({ source, target: `evidence-${files.length}${path.extname(name).replace(/[^.a-zA-Z0-9]/g, '').slice(0, 12)}`, bytes, sha256: digest(bytes) });
      }
    }
  }
  const outcome = operator?.expectedOutcome;
  const outcomeObserved = !!outcome && session.includes(`[DCSMCP] ACCEPTANCE_OBJECTIVE runId=${manifest.runId} scenarioId=${scenario.id} outcome=${outcome}`);
  const status = problems.length || operator?.checks.some(c => c.status === 'fail') ? 'fail'
    : operator?.checks.some(c => c.status === 'blocked') ? 'blocked'
    : start >= 0 && outcomeObserved && operator?.checks.every(c => c.status === 'pass') ? 'pass' : 'pending';
  const output = path.resolve(options.outputDir); await mkdir(output);
  await atomicWrite(path.join(output, 'dcs.log'), logBytes);
  for (const f of files) await atomicWrite(path.join(output, f.target), f.bytes);
  const report = { version: 1, runId: manifest.runId, scenarioId: scenario.id, status,
    basis: 'Operator-attested live results plus correlated log and file hashes; screenshots/AI behavior are not automatically interpreted',
    missionDigest: scenario.digest, identityMatched: start >= 0, outcomeObserved, problems, operator: operator ?? null,
    limitations: ['Run marker does not prove an unchanged mission archive; record any Mission Editor modifications.', 'Separate success/failure sorties and branch variants require separate collections.'],
    telemetry: session.split(/\r?\n/).filter(l => l.includes('[DCSMCP]')).slice(-5000),
    evidence: [{ file: 'dcs.log', sha256: digest(logBytes) }, ...files.map(f => ({ file: f.target, sha256: f.sha256, source: f.source }))] };
  await atomicWrite(path.join(output, 'evidence-report.json'), JSON.stringify(report, null, 2));
  return { directory: output, ...report };
}
