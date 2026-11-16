import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { terrainGridSchema, terrainPointSchema } from './terrain.js';
import { gridProvider, liveProvider } from '../terrain/providers.js';
import { assessPositions, metadata, TerrainUnavailable, MAX_SAMPLES } from '../terrain/analysis.js';
import { requireSession, refresh } from '../miz/sessions.js';
import { findGroup } from '../miz/authoring.js';
import { moveGroup } from '../miz/editing.js';
import { luaArray } from '../miz/lua.js';
import { buildResult, errorResult } from './format.js';
import { BRIDGE_DEFAULT_HOST, BRIDGE_DEFAULT_PORT } from '../constants.js';
export function registerTerrainPlacementTools(server: McpServer) {
  server.registerTool('dcs_miz_move_ground_on_terrain', {
    description: 'Move an existing vehicle group (including a SAM battery) to the first caller-provided candidate where EVERY unit footprint passes sampled land/slope checks. Preserves formation offsets and translates the first waypoint via moveGroup. Offline sourced grid or live DCS required, matching mission theatre. No flat fallback; no mutation if unavailable or unsuitable. Unknown surface is refused. Advisory geometry, no guarantee against trees/buildings or of weapon effectiveness. Maximum 8192 samples across all candidates.',
    inputSchema: z.object({ sessionId: z.string().min(1), group: z.string().min(1), candidates: z.array(terrainPointSchema).min(1).max(10),
      heading: z.number().min(0).max(359).optional(), radiusMetres: z.number().positive().max(100).default(5),
      stepMetres: z.number().min(1).max(1000).default(10), maxSlopeDegrees: z.number().positive().max(60).default(10),
      source: z.enum(['offline', 'live']).default('offline'), grid: terrainGridSchema.optional(),
      host: z.string().min(1).default(process.env.DCS_BRIDGE_HOST || BRIDGE_DEFAULT_HOST), port: z.number().int().min(1).max(65535).default(BRIDGE_DEFAULT_PORT),
    }).strict(), annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, async a => {
    try {
      const session = requireSession(a.sessionId), found = findGroup(session.mission, a.group);
      const originalMission = session.mission, originalData = JSON.stringify(session.mission);
      if (!found || found.category !== 'vehicle') throw new Error('Terrain placement requires an existing vehicle group');
      const units = luaArray(found.group.units);
      if (!units.length || units.length * a.candidates.length * 45 > MAX_SAMPLES) throw new Error('Empty group or placement exceeds 8192 samples; reduce candidates or group size');
      if (a.source === 'offline' && !a.grid) throw new TerrainUnavailable('No offline elevation grid supplied; provide a sourced grid or a live DCS bridge');
      if (a.source === 'live' && a.grid) throw new Error('grid cannot be combined with source=live');
      const theatre = String(session.mission.theatre);
      const provider = a.source === 'live' ? await liveProvider(theatre, { host: a.host, port: a.port }) : gridProvider(a.grid!, theatre);
      const rejected = [];
      for (const candidate of a.candidates) {
        const copy = structuredClone(session.mission);
        moveGroup(copy, a.group, { ...candidate, heading: a.heading });
        const moved = findGroup(copy, a.group)!.group;
        const positions = luaArray(moved.units).map(u => ({ x: Number(u.x), y: Number(u.y) }));
        const findings = await assessPositions(provider, positions, a.radiusMetres, a.stepMetres, a.maxSlopeDegrees);
        if (findings.every(f => f.suitable === true)) {
          // Do not replace the mission after asynchronous terrain queries if another tool changed it.
          if (session.mission !== originalMission || JSON.stringify(session.mission) !== originalData) throw new Error('Mission changed during terrain analysis; retry placement');
          session.mission = copy; session.dirty = true; refresh(session);
          const data = { available: true, moved: true, group: a.group, position: candidate, ...metadata(provider), findings, rejected };
          return buildResult(JSON.stringify(data), data);
        }
        rejected.push({ position: candidate, units: findings.map((f, i) => ({ unit: units[i].name, suitable: f.suitable, water: f.water, maxSlopeDegrees: f.maxSlopeDegrees, unknownSurface: f.unknownSurface })) });
      }
      const data = { available: true, moved: false, group: a.group, ...metadata(provider), rejected };
      return buildResult(JSON.stringify(data), data);
    } catch (e) {
      if (e instanceof TerrainUnavailable) { const data = { available: false, moved: false, reason: e.message }; return buildResult(JSON.stringify(data), data); }
      return errorResult(e);
    }
  });
}
