import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { generateAcceptancePackage, type Progress } from '../acceptance/package.js';
import { checkMission } from '../acceptance/checks.js';
import { collectAcceptance } from '../acceptance/collect.js';
import { buildResult, errorResult } from './format.js';
export function registerAcceptanceTools(server: McpServer) {
  type Job = { id: string; status: 'running' | 'complete' | 'failed'; progress?: Progress; result?: unknown; error?: string };
  const jobs = new Map<string, Job>();
  server.registerTool('dcs_acceptance_generate', {
    description: 'Start generating ten offline-checked live acceptance missions and the Windows test kit in a NEW directory. Returns a process-local job id; poll dcs_acceptance_job. Never replaces existing output. Live DCS checks remain pending.',
    inputSchema: z.object({ outputDir: z.string().min(1) }).strict(), annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ outputDir }) => {
    if ([...jobs.values()].some(j => j.status === 'running')) return errorResult(new Error('An acceptance generation job is already running; poll it before starting another'));
    if (jobs.size >= 20) jobs.delete(jobs.keys().next().value!);
    const job: Job = { id: randomUUID(), status: 'running' }; jobs.set(job.id, job);
    setImmediate(() => { generateAcceptancePackage(outputDir, p => { job.progress = p; }).then(result => { job.result = result; job.status = 'complete'; }, e => { job.error = (e as Error).message; job.status = 'failed'; }); });
    return buildResult(JSON.stringify(job), { ...job });
  });
  server.registerTool('dcs_acceptance_job', {
    description: 'Poll an acceptance generation job in this server process. Jobs are not persisted across server restarts; generated files remain on disk. Up to twenty recent jobs retained.',
    inputSchema: z.object({ jobId: z.string().uuid() }).strict(), annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ jobId }) => { const job = jobs.get(jobId); return job ? buildResult(JSON.stringify(job), { ...job }) : errorResult(new Error('Unknown job id (possibly server restarted)')); });
  server.registerTool('dcs_acceptance_check', {
    description: 'Check a .miz archive safely: mission structure, finite route/unit geometry, compiled triggers, Lua 5.1 syntax, resource references and theatre consistency. Does not execute mission Lua or verify AI behavior inside DCS.',
    inputSchema: z.object({ path: z.string().min(1) }).strict(), annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ path }) => { try { const report = await checkMission(path); return buildResult(JSON.stringify(report), report); } catch (e) { return errorResult(e); } });
  server.registerTool('dcs_acceptance_collect', {
    description: 'Copy bounded logs/evidence into a NEW directory and correlate acceptance run/scenario markers. Optional operator results must identify all eight checks with notes/evidence. A pass is operator-attested, never automatic aircraft AI proof. Sources are preserved. Query dcs_runtime_inspect separately while DCS runs.',
    inputSchema: z.object({ packageDir: z.string().min(1), scenarioId: z.string().min(1), logPath: z.string().min(1), outputDir: z.string().min(1), resultsPath: z.string().min(1).optional() }).strict(), annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async args => { try { const report = await collectAcceptance(args); return buildResult(JSON.stringify(report), report); } catch (e) { return errorResult(e); } });
}
