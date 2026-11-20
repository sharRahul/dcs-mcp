import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { buildResult } from './format.js';
export interface CatalogueEntry { name: string; description: string; title?: string; inputSchema?: unknown; annotations?: Record<string, unknown> }
export function captureCatalogue(server: McpServer, selected?: Set<string>) {
  const entries = new Map<string, CatalogueEntry>(), schemas = new Map<string, unknown>();
  const known = new Set<string>();
  const register = server.registerTool.bind(server) as (...args: any[]) => any;
  server.registerTool = ((name: string, config: Omit<CatalogueEntry, 'name'>, callback: unknown) => {
    if (known.has(name)) throw new Error(`Duplicate MCP tool '${name}'`);
    known.add(name);
    const tool = register(name, config, callback);
    if (selected && !selected.has(name)) tool.disable();
    else { entries.set(name, { ...config, name }); schemas.set(name, config.inputSchema); }
    return tool;
  }) as typeof server.registerTool;
  return { entries, schemas, known };
}
export function registerCatalogueTool(server: McpServer, entries: Map<string, CatalogueEntry>) {
  server.registerTool('dcs_tool_catalogue', {
    title: 'Find DCS Sortie MCP tools', description: 'Search the complete registered tool catalogue by name/description. Paginated summaries and capability annotations help discover composable tools without duplicating wrappers. Standard MCP tools/list remains unchanged.',
    inputSchema: z.object({ query: z.string().max(200).default(''), offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(50).default(20) }).strict(),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ query, offset, limit }) => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const matches = [...entries.values()].filter(e => words.every(w => `${e.name} ${e.description}`.toLowerCase().includes(w))).sort((a, b) => a.name.localeCompare(b.name));
    const data = { total: matches.length, offset, nextOffset: offset + limit < matches.length ? offset + limit : null,
      tools: matches.slice(offset, offset + limit).map(e => ({ name: e.name, title: e.title ?? e.name, description: e.description.split('\n')[0].slice(0, 500), annotations: e.annotations ?? {} })) };
    return buildResult(JSON.stringify(data), data);
  });
}
