import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { distanceBearing, lineOfSight, metadata, profile, routeFeasibility, slope, suitability, TerrainUnavailable, viewshed } from '../terrain/analysis.js';
import { gridProvider, liveProvider } from '../terrain/providers.js';
import { BRIDGE_DEFAULT_HOST, BRIDGE_DEFAULT_PORT } from '../constants.js';
import { buildResult, errorResult } from './format.js';
export const terrainPointSchema = z.object({ x: z.number().finite(), y: z.number().finite() }).strict();
export const terrainGridSchema = z.object({ theatre: z.string().min(1), source: z.string().min(1), origin: terrainPointSchema,
  spacingMetres: z.number().positive(), rows: z.number().int().min(2), columns: z.number().int().min(2),
  heights: z.array(z.number().finite().nullable()).max(65536), surfaces: z.array(z.number().int().min(1).max(5).nullable()).max(65536).optional() }).strict();
export function registerTerrainTools(server: McpServer) {
  server.registerTool('dcs_distance_bearing', {
    description: 'Offline distance and grid-north bearing in DCS x=north/y=east metres. No terrain required.',
    inputSchema: z.object({ start: terrainPointSchema, end: terrainPointSchema }).strict(),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ start, end }) => { const result = distanceBearing(start, end); return buildResult(JSON.stringify(result), result); });
  server.registerTool('dcs_terrain_analyze', {
    description: 'Elevation, slope, footprint suitability (units/FARPs/statics), profiles, sampled LOS/radar-range estimates, masking, viewshed and ground route checks. Supply a provenance-labelled offline grid OR source=live with a matching running DCS theatre. No bundled elevation data or flat fallback. All positions DCS metres. LOS heights are AGL. Viewshed is radial sampled geometry. Range is caller supplied; no authoritative radar/weapon model. Placement checks are advisory and do not mutate missions.',
    inputSchema: z.object({ operation: z.enum(['status', 'elevation', 'slope', 'suitability', 'profile', 'los', 'viewshed', 'route']),
      theatre: z.string().min(1), source: z.enum(['offline', 'live']).default('offline'), grid: terrainGridSchema.optional(),
      start: terrainPointSchema.optional(), end: terrainPointSchema.optional(), route: z.array(terrainPointSchema).min(2).max(100).optional(),
      stepMetres: z.number().min(1).max(10000).default(100), radiusMetres: z.number().positive().max(100000).default(50),
      maxSlopeDegrees: z.number().positive().max(89).default(10), rays: z.number().int().min(4).max(180).default(36),
      observerHeightMetres: z.number().min(0).max(30000).default(10), targetHeightMetres: z.number().min(0).max(30000).default(10),
      earthRadiusFactor: z.number().min(.1).max(10).default(1), maxRangeMetres: z.number().positive().max(1000000).optional(),
      host: z.string().min(1).default(process.env.DCS_BRIDGE_HOST || BRIDGE_DEFAULT_HOST),
      port: z.number().int().min(1).max(65535).default(BRIDGE_DEFAULT_PORT),
    }).strict(), annotations: { readOnlyHint: true, openWorldHint: true },
  }, async a => {
    try {
      if (a.source === 'live' && a.grid) throw new Error('grid cannot be combined with source=live');
      if (a.source === 'offline' && !a.grid) throw new TerrainUnavailable('No offline elevation grid supplied. Provide a sourced grid or use source=live with DCS running; airfield data contains no terrain elevations.');
      const provider = a.source === 'live' ? await liveProvider(a.theatre, { host: a.host, port: a.port }) : gridProvider(a.grid!, a.theatre);
      let data: unknown;
      if (a.operation === 'status') data = { ready: true, elevation: true, surface: a.source === 'live' || !!a.grid?.surfaces };
      else {
        if (a.operation !== 'route' && !a.start) throw new Error('start is required');
        if (['profile', 'los'].includes(a.operation) && !a.end) throw new Error('end is required');
        switch (a.operation) {
          case 'elevation': {
            const samples = await provider.sample([a.start!]);
            if (samples[0]?.height === null) throw new TerrainUnavailable('Point outside coverage or no elevation data');
            data = { samples }; break;
          }
          case 'slope': data = await slope(provider, a.start!, a.stepMetres); break;
          case 'suitability': data = await suitability(provider, a.start!, a.radiusMetres, a.stepMetres, a.maxSlopeDegrees); break;
          case 'profile': data = await profile(provider, a.start!, a.end!, a.stepMetres); break;
          case 'los': data = await lineOfSight(provider, a.start!, a.end!, a); break;
          case 'viewshed': data = await viewshed(provider, a.start!, a.radiusMetres, a.rays, a); break;
          case 'route': if (!a.route) throw new Error('route is required'); data = await routeFeasibility(provider, a.route, a.stepMetres, a.maxSlopeDegrees); break;
        }
      }
      const result = { available: true, ...metadata(provider), data };
      return buildResult(JSON.stringify(result), result);
    } catch (error) {
      if (error instanceof TerrainUnavailable) {
        const result = { available: false, source: a.source, theatre: a.theatre, reason: error.message };
        return buildResult(JSON.stringify(result), result);
      }
      return errorResult(error);
    }
  });
}
