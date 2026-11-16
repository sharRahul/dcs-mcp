/**
 * Placement input shared by every tool that puts something on the map: either
 * DCS x/y metres or WGS84 lat/lon, converted offline with the session theatre's
 * projection. Exactly one of the two pairs must be given.
 */
import { z } from "zod";
import { latLonToXY } from "../miz/projection.js";
import type { MissionSession } from "../miz/sessions.js";

export const positionFields = {
  x: z.number().optional().describe("DCS x (metres NORTH). Give x+y or lat+lon."),
  y: z.number().optional().describe("DCS y (metres EAST)."),
  lat: z.number().min(-90).max(90).optional().describe("Latitude (WGS84 degrees), converted offline"),
  lon: z.number().min(-180).max(180).optional().describe("Longitude (WGS84 degrees), converted offline"),
};

export interface PositionInput {
  x?: number;
  y?: number;
  lat?: number;
  lon?: number;
}

/** Resolve to DCS x/y. Throws on a missing or half-given position. */
export function resolvePosition(session: MissionSession, p: PositionInput, what = "position"): { x: number; y: number } {
  const hasXY = p.x !== undefined || p.y !== undefined;
  const hasLL = p.lat !== undefined || p.lon !== undefined;
  if (hasXY && hasLL) throw new Error(`Give ${what} as x/y OR lat/lon, not both.`);
  if (hasXY) {
    if (p.x === undefined || p.y === undefined) throw new Error(`${what}: both x and y are required.`);
    return { x: p.x, y: p.y };
  }
  if (hasLL) {
    if (p.lat === undefined || p.lon === undefined) throw new Error(`${what}: both lat and lon are required.`);
    return latLonToXY(session.document.theatre, p.lat, p.lon);
  }
  throw new Error(`${what} is required: pass x/y (DCS metres) or lat/lon.`);
}

/** Optional variant for update tools: undefined when no position was given. */
export function resolveOptionalPosition(
  session: MissionSession,
  p: PositionInput,
  what = "position"
): { x: number; y: number } | undefined {
  if (p.x === undefined && p.y === undefined && p.lat === undefined && p.lon === undefined) return undefined;
  return resolvePosition(session, p, what);
}
