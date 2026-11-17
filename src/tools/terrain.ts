import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { distanceBearing, lineOfSight, metadata, profile, routeFeasibility, slope, suitability, TerrainUnavailable, viewshed } from '../terrain/analysis.js';
import { gridProvider, liveProvider } from '../terrain/providers.js';
import { buildPack, describePack, loadPacks, MAX_PACK_NODES, packDir, packProvider, removePack } from '../terrain/packs.js';
import { airbasePackDir, buildAirbasePack, describeAirbasePack, enableAirbasePacks, loadAirbasePacks, MAX_AIRBASES, removeAirbasePack } from '../dcs/airbase-packs.js';
import { BRIDGE_DEFAULT_HOST, BRIDGE_DEFAULT_PORT } from '../constants.js';
import { bridgeRequest } from '../bridge/client.js';
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
    description: 'Elevation, slope, footprint suitability (units/FARPs/statics), profiles, sampled LOS/radar-range estimates, masking, viewshed and ground route checks. Supply a provenance-labelled offline grid, OR rely on installed terrain packs (offline with no grid; built from DCS by dcs_terrain_build_pack), OR source=live with a matching running DCS theatre. No bundled elevation data or flat fallback; points outside pack coverage are unavailable. All positions DCS metres. LOS heights are AGL. Viewshed is radial sampled geometry. Range is caller supplied; no authoritative radar/weapon model. Placement checks are advisory and do not mutate missions.',
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
      if (a.source === 'offline' && !a.grid && !loadPacks(a.theatre).length) throw new TerrainUnavailable('No offline elevation grid supplied and no terrain pack installed for this theatre. Provide a sourced grid, build a pack with dcs_terrain_build_pack, or use source=live with DCS running; airfield data contains no terrain elevations.');
      const provider = a.source === 'live' ? await liveProvider(a.theatre, { host: a.host, port: a.port })
        : a.grid ? gridProvider(a.grid, a.theatre) : packProvider(a.theatre);
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

  const bridge = { host: z.string().min(1).default(process.env.DCS_BRIDGE_HOST || BRIDGE_DEFAULT_HOST),
    port: z.number().int().min(1).max(65535).default(BRIDGE_DEFAULT_PORT) };
  server.registerTool('dcs_terrain_build_pack', {
    description: `Sample DCS's own terrain (land.getHeight/getSurfaceType via the structured bridge land command; needs a mission RUNNING on that theatre) on a regular grid and save it as an offline terrain pack, so dcs_terrain_analyze works later with DCS closed. Bare-earth only (no buildings/trees), interpolated between nodes. At most ${MAX_PACK_NODES} nodes per pack (e.g. 512x512); tile larger areas. Large packs take minutes. Rows run north (x), columns east (y) from origin. Packs are stored in DCS_MCP_TERRAIN_DIR or the user data folder.`,
    inputSchema: z.object({ theatre: z.string().min(1), name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), origin: terrainPointSchema,
      spacingMetres: z.number().min(10).max(10000), rows: z.number().int().min(2).max(4096), columns: z.number().int().min(2).max(4096), ...bridge }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, async a => {
    try {
      const live = await liveProvider(a.theatre, { host: a.host, port: a.port });
      const result = await buildPack(live, a);
      return buildResult(JSON.stringify(result), result);
    } catch (error) {
      if (error instanceof TerrainUnavailable) { const result = { built: false, reason: error.message }; return buildResult(JSON.stringify(result), result); }
      return errorResult(error);
    }
  });
  // Live-only terrain helpers. Each is DCS's own query against the loaded theatre; there
  // is no offline equivalent, because the road graph and the scenery objects are terrain
  // data this server cannot read. A mission must be RUNNING on the map.
  const liveQuery = async (cmd: string, args: Record<string, unknown>, host: string, port: number) => {
    try {
      const data = await bridgeRequest({ cmd, args }, { host, port }) as Record<string, unknown>;
      return buildResult(JSON.stringify(data), data);
    } catch (error) { return errorResult(error); }
  };
  server.registerTool('dcs_terrain_roads', {
    description: "DCS's own road graph for the RUNNING theatre: snap points to the nearest road or railway (land.getClosestPointOnRoads, reporting how far each point moved and the surface there), or get the route between two points along it (land.findPathOnRoads). The graph is terrain data this server cannot read offline, so this needs a mission running on the map. Positions are DCS x=north/y=east metres.",
    inputSchema: z.object({ kind: z.enum(['roads', 'railroads']).default('roads'),
      points: z.array(terrainPointSchema).min(1).max(200).optional().describe('Points to snap to the graph.'),
      start: terrainPointSchema.optional(), end: terrainPointSchema.optional(), ...bridge }).strict(),
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async a => {
    if (a.start && a.end) return liveQuery('roads', { kind: a.kind, from: a.start, to: a.end }, a.host, a.port);
    if (!a.points?.length) return errorResult(new Error('Give points to snap, or start and end for a path along the graph.'));
    return liveQuery('roads', { kind: a.kind, points: a.points }, a.host, a.port);
  });
  server.registerTool('dcs_terrain_clear_spot', {
    description: "Open ground near a point in the RUNNING mission: grid-samples the area for nodes that are land (land.getSurfaceType), flat enough (neighbour heights) and clear of scenery objects (world.searchObjects over buildings and modelled vegetation), nearest first. Use it to place a FARP, a convoy halt or a static without landing it in a village. Vegetation DCS does not model as a scenery object is invisible to this, so a clear spot means 'nothing found', not a guarantee; it is sampled geometry, not a collision test. Needs a mission running on the map.",
    inputSchema: z.object({ centre: terrainPointSchema, radiusMetres: z.number().min(50).max(20000).default(1000),
      spacingMetres: z.number().min(10).max(2000).default(100), clearanceMetres: z.number().min(1).max(500).default(30),
      maxSlopeDegrees: z.number().min(0.5).max(60).default(10), limit: z.number().int().min(1).max(100).default(10), ...bridge }).strict(),
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async a => liveQuery('clearspot', { centre: a.centre, radius: a.radiusMetres, spacing: a.spacingMetres,
    clearance: a.clearanceMetres, maxSlopeDegrees: a.maxSlopeDegrees, limit: a.limit }, a.host, a.port));
  server.registerTool('dcs_terrain_visibility', {
    description: "Line of sight between point pairs in the RUNNING mission using DCS's own terrain intersection (land.isVisible, and land.getIP for where the line is blocked). Altitudes are metres above sea level; omit one and the ground height at that point plus 2 m is used. This is geometry against the loaded terrain — not a radar, sensor or detection model, and it says nothing about RCS, propagation or clutter. For offline masking use dcs_terrain_analyze with a sourced grid or a terrain pack.",
    inputSchema: z.object({ pairs: z.array(z.object({
      from: z.object({ x: z.number().finite(), y: z.number().finite(), alt: z.number().finite().optional() }).strict(),
      to: z.object({ x: z.number().finite(), y: z.number().finite(), alt: z.number().finite().optional() }).strict(),
    }).strict()).min(1).max(100), ...bridge }).strict(),
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async a => liveQuery('los', { pairs: a.pairs }, a.host, a.port));

  server.registerTool('dcs_airbase_build_pack', {
    description: "Sample every airbase of the RUNNING mission's theatre (DCS's own world.getAirbases/getID/getRunways/getParking through the bridge) and save it as an offline airbase pack: airfield ids, names, callsigns, category, coalition, position in map metres and lat/lon, runways and parking spots. This is the only way to get airfield ids, coordinates and parking for a theatre the bundled pydcs catalogue never had (Iraq, Marianas WWII) — that data lives in the terrain's binary files. Once a pack exists, dcs_list_airfields and airfield/parking starts work offline for that map. Parking slot SIZE and category flags are not in the live answer, so they are stored as unknown and the pydcs fit rule is skipped for those airfields; which index the mission file's parking_id holds is not established by the sample. Not yet opened in the Mission Editor by this project. Needs a mission running on the map.",
    inputSchema: z.object({ theatre: z.string().min(1), name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
      parking: z.boolean().default(true), runways: z.boolean().default(true),
      maxAirbases: z.number().int().min(1).max(MAX_AIRBASES).default(MAX_AIRBASES), ...bridge }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, async a => {
    try {
      const built = await buildAirbasePack(a, { host: a.host, port: a.port });
      enableAirbasePacks();
      return buildResult(JSON.stringify(built), built);
    } catch (error) { return errorResult(error); }
  });
  server.registerTool('dcs_list_airbase_packs', {
    description: 'Installed offline airbase packs (theatre, when sampled, how many airfields and parking spots, the DCS build), optionally for one theatre.',
    inputSchema: z.object({ theatre: z.string().min(1).optional() }).strict(), annotations: { readOnlyHint: true, openWorldHint: false },
  }, async a => {
    const packs = loadAirbasePacks(a.theatre).map(describeAirbasePack);
    const result = { dir: airbasePackDir(), count: packs.length, packs };
    return buildResult(JSON.stringify(result), result);
  });
  server.registerTool('dcs_remove_airbase_pack', {
    description: 'Delete one installed airbase pack by theatre and name.',
    inputSchema: z.object({ theatre: z.string().min(1), name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, async a => { try { const r = removeAirbasePack(a.theatre, a.name); enableAirbasePacks(); return buildResult(JSON.stringify(r), r); } catch (e) { return errorResult(e); } });

  server.registerTool('dcs_terrain_list_packs', {
    description: 'List installed offline terrain packs (theatre, extent, spacing, provenance, creation time), optionally for one theatre.',
    inputSchema: z.object({ theatre: z.string().min(1).optional() }).strict(), annotations: { readOnlyHint: true, openWorldHint: false },
  }, async a => { const packs = loadPacks(a.theatre).map(describePack); const result = { dir: packDir(), count: packs.length, packs }; return buildResult(JSON.stringify(result), result); });
  server.registerTool('dcs_terrain_remove_pack', {
    description: 'Delete one installed terrain pack by theatre and name.',
    inputSchema: z.object({ theatre: z.string().min(1), name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, async a => { try { const result = removePack(a.theatre, a.name); return buildResult(JSON.stringify(result), result); } catch (e) { return errorResult(e); } });
}
