import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { bridgeRequest } from '../bridge/client.js';
import { BRIDGE_DEFAULT_HOST, BRIDGE_DEFAULT_PORT } from '../constants.js';
import { buildResult, errorResult } from './format.js';
export function registerRuntimeTools(server: McpServer) {
  server.registerTool('dcs_runtime_inspect', {
    title: 'Inspect live state, objectives and events',
    description: 'Read a bounded snapshot of named groups/aircraft/ground units, user flags (including scenario outcome flags), lifecycle identity and recent telemetry events. New hook required. Event monitoring is explicitly unavailable until the trusted mission telemetry script is loaded. afterSequence is a cursor; oldestSequence detects missed ring entries. No raw Lua or state mutation.',
    inputSchema: z.object({ groups: z.array(z.string().min(1).max(200)).max(100).default([]), flags: z.array(z.union([z.number().int().positive().max(2147483647), z.string().min(1).max(64)])).max(100).default([]), afterSequence: z.number().int().nonnegative().max(2147483647).default(0),
      host: z.string().min(1).default(BRIDGE_DEFAULT_HOST), port: z.number().int().min(1).max(65535).default(BRIDGE_DEFAULT_PORT) }).strict(),
    outputSchema: z.object({ runtime: z.unknown() }), annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ host, port, ...args }) => { try { const runtime = await bridgeRequest({ cmd: 'runtime', args }, { host, port }); return buildResult(JSON.stringify(runtime), { runtime }); } catch (e) { return errorResult(e); } });
}
