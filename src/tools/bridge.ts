/** Live DCS control tools (require a running DCS with the bridge/hook installed). */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { bridgeRequest, type BridgeOptions, type BridgeRequest } from "../bridge/client.js";
import { BRIDGE_DEFAULT_HOST, BRIDGE_DEFAULT_PORT } from "../constants.js";
import { buildResult, errorResult } from "./format.js";

/**
 * Default port from DCS_BRIDGE_PORT, falling back to the built-in default.
 *
 * A malformed env var must not become a NaN default: that would fail schema
 * validation on every bridge call with an error pointing at the caller's
 * arguments rather than at the real cause.
 */
function defaultPort(): number {
  const raw = process.env.DCS_BRIDGE_PORT;
  if (raw === undefined || raw.trim() === "") return BRIDGE_DEFAULT_PORT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    console.error(
      `dcs-mcp-server: ignoring invalid DCS_BRIDGE_PORT='${raw}' (expected 1-65535); ` +
        `using ${BRIDGE_DEFAULT_PORT}`
    );
    return BRIDGE_DEFAULT_PORT;
  }
  return parsed;
}

const hostField = z
  .string()
  .min(1)
  .default(process.env.DCS_BRIDGE_HOST?.trim() || BRIDGE_DEFAULT_HOST)
  .describe("Host of the DCS hook server (default from DCS_BRIDGE_HOST or 127.0.0.1)");

const portField = z.coerce
  .number()
  .int()
  .min(1)
  .max(65535)
  .default(defaultPort())
  .describe("Port of the DCS hook server (default from DCS_BRIDGE_PORT or 8899)");

const coalitionField = z
  .enum(["red", "blue", "neutral", "all"])
  .default("all")
  .describe("Coalition filter");

/** Read-only live query. */
const liveRead = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

/** Live action that changes simulator state. */
const liveWrite = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

/** Run a bridge command and return a JSON tool result, or an actionable error. */
async function call(
  request: BridgeRequest,
  opts: BridgeOptions,
  key: string
): Promise<ReturnType<typeof buildResult>> {
  const data = await bridgeRequest(request, opts);
  return buildResult(JSON.stringify(data, null, 2), { [key]: data } as Record<string, unknown>);
}

export function registerBridgeTools(server: McpServer): void {
  server.registerTool(
    "dcs_bridge_status",
    {
      title: "Check DCS bridge",
      description:
        "Check the live DCS bridge. Use before other live tools to confirm DCS is running with the " +
        "hook installed, and to find out what state it is in.\n\n" +
        "`phase` is the field that decides what else will work:\n" +
        "  - menu     — DCS is at the menu/Mission Editor. Mission-environment tools (units, " +
        "message, spawn, terrain, mission info) have no environment to talk to, and dcs_load_mission " +
        "is refused: net.load_mission swaps the mission on a RUNNING session and does nothing from a " +
        "cold menu. The user must fly something first.\n" +
        "  - loading  — a mission is opening; poll until it turns running.\n" +
        "  - running  — everything is available.\n\n" +
        "`missionEnv` is derived from simulation frames, not from a probe, so it is false whenever " +
        "mission-environment commands would fail. A paused mission produces no frames.\n\n" +
        "Args: host?, port?\n" +
        "Returns JSON: { connected, phase, missionEnv, simTicking, mission, response }.",
      inputSchema: z.object({ host: hostField, port: portField }).strict(),
      outputSchema: z.object({
        connected: z.boolean(),
        phase: z.string().optional(),
        missionEnv: z.boolean().optional(),
        simTicking: z.boolean().optional(),
        mission: z.string().optional(),
        response: z.unknown(),
      }),
      annotations: liveRead,
    },
    async ({ host, port }) => {
      try {
        // `status` carries phase/missionEnv/simTicking; `ping` only proves the
        // socket answers. Fall back so an older installed hook still reports
        // connectivity instead of failing outright.
        let data: Record<string, unknown>;
        try {
          data = (await bridgeRequest({ cmd: "status" }, { host, port })) as Record<string, unknown>;
        } catch {
          data = (await bridgeRequest({ cmd: "ping" }, { host, port })) as Record<string, unknown>;
        }
        const phase = typeof data.phase === "string" ? data.phase : undefined;
        return buildResult(
          `Connected to DCS bridge at ${host}:${port}${phase ? ` (phase: ${phase})` : ""}.`,
          {
            connected: true,
            ...(phase !== undefined ? { phase } : {}),
            ...(typeof data.missionEnv === "boolean" ? { missionEnv: data.missionEnv } : {}),
            ...(typeof data.simTicking === "boolean" ? { simTicking: data.simTicking } : {}),
            ...(typeof data.mission === "string" ? { mission: data.mission } : {}),
            response: data,
          }
        );
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "dcs_get_self_data",
    {
      title: "Get ownship telemetry",
      description:
        "Return live ownship (player aircraft) telemetry: name, lat/long/alt, attitude, and speeds.\n\n" +
        "Args: host?, port?",
      inputSchema: z.object({ host: hostField, port: portField }).strict(),
      outputSchema: z.object({ self: z.unknown() }),
      annotations: liveRead,
    },
    async ({ host, port }) => {
      try {
        return await call({ cmd: "self" }, { host, port }, "self");
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "dcs_get_mission_info",
    {
      title: "Get live mission info",
      description:
        "Return metadata about the mission currently running in DCS: model time, theatre, and date.\n\n" +
        "Args: host?, port?",
      inputSchema: z.object({ host: hostField, port: portField }).strict(),
      outputSchema: z.object({ mission: z.unknown() }),
      annotations: liveRead,
    },
    async ({ host, port }) => {
      try {
        return await call({ cmd: "mission" }, { host, port }, "mission");
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "dcs_get_all_units",
    {
      title: "List live units",
      description:
        "List all units currently in the running mission, optionally filtered by coalition. Each unit " +
        "includes name, type, group, coalition, DCS x/y, lat/long, altitude, and heading.\n\n" +
        "Args: coalition ('red'|'blue'|'neutral'|'all'), host?, port?",
      inputSchema: z.object({ coalition: coalitionField, host: hostField, port: portField }).strict(),
      outputSchema: z.object({ units: z.unknown() }),
      annotations: liveRead,
    },
    async ({ coalition, host, port }) => {
      try {
        return await call({ cmd: "units", args: { coalition } }, { host, port }, "units");
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "dcs_get_aircraft_list",
    {
      title: "List airborne aircraft",
      description:
        "List airborne aircraft in the running mission, optionally filtered by coalition.\n\n" +
        "Args: coalition ('red'|'blue'|'neutral'|'all'), host?, port?",
      inputSchema: z.object({ coalition: coalitionField, host: hostField, port: portField }).strict(),
      outputSchema: z.object({ aircraft: z.unknown() }),
      annotations: liveRead,
    },
    async ({ coalition, host, port }) => {
      try {
        return await call({ cmd: "aircraft", args: { coalition } }, { host, port }, "aircraft");
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "dcs_send_message",
    {
      title: "Send in-mission message",
      description:
        "Display a text message to players in the running mission (trigger.action.outText).\n\n" +
        "Args:\n  - text (string): message to display\n  - seconds (number): display duration (default 20)\n" +
        "  - host?, port?",
      inputSchema: z
        .object({
          text: z.string().min(1).max(1000).describe("Message text to display"),
          seconds: z.number().int().min(1).max(600).default(20).describe("Display duration in seconds"),
          host: hostField,
          port: portField,
        })
        .strict(),
      outputSchema: z.object({ message: z.unknown() }),
      annotations: liveWrite,
    },
    async ({ text, seconds, host, port }) => {
      try {
        return await call({ cmd: "message", args: { text, seconds } }, { host, port }, "message");
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "dcs_spawn_unit",
    {
      title: "Spawn a ground unit",
      description:
        "Spawn a ground unit/group at a lat/long in the running mission (coalition.addGroup). The unit " +
        "type must be a valid DCS ground-vehicle type id (e.g. 'M-1 Abrams', 'T-90').\n\n" +
        "Args:\n  - name (string): group name\n  - type (string): DCS vehicle type id\n" +
        "  - lat (number), lon (number): spawn position\n  - heading (number): degrees (default 0)\n" +
        "  - country (number): DCS country id (default 2 = USA)\n  - host?, port?",
      inputSchema: z
        .object({
          name: z.string().min(1).max(64).describe("Group name"),
          type: z.string().min(1).max(64).describe("DCS ground-vehicle type id, e.g. 'M-1 Abrams'"),
          lat: z.number().min(-90).max(90).describe("Latitude"),
          lon: z.number().min(-180).max(180).describe("Longitude"),
          heading: z.number().min(0).max(359).default(0).describe("Heading in degrees"),
          country: z.number().int().min(0).default(2).describe("DCS country id (2 = USA)"),
          host: hostField,
          port: portField,
        })
        .strict(),
      outputSchema: z.object({ spawn: z.unknown() }),
      annotations: liveWrite,
    },
    async ({ name, type, lat, lon, heading, country, host, port }) => {
      try {
        return await call(
          { cmd: "spawn", args: { name, type, lat, lon, heading, country } },
          { host, port },
          "spawn"
        );
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "dcs_convert_coords",
    {
      title: "Convert coordinates",
      description:
        "Convert between geographic (lat/long) and DCS map (x/y) coordinates for the current theatre, " +
        "using the running mission's projection.\n\n" +
        "Args (one direction):\n  - direction ('ll2xz' | 'xz2ll')\n" +
        "  - for ll2xz: lat, lon, alt?\n  - for xz2ll: x, y, alt?\n  - host?, port?",
      inputSchema: z
        .object({
          direction: z.enum(["ll2xz", "xz2ll"]).describe("Conversion direction"),
          lat: z.number().min(-90).max(90).optional().describe("Latitude (required for ll2xz)"),
          lon: z.number().min(-180).max(180).optional().describe("Longitude (required for ll2xz)"),
          x: z.number().optional().describe("DCS x / north (required for xz2ll)"),
          y: z.number().optional().describe("DCS y / east (required for xz2ll)"),
          alt: z.number().default(0).describe("Altitude in metres"),
          host: hostField,
          port: portField,
        })
        .strict()
        // Reject the wrong pair up front instead of sending undefined coordinates
        // to DCS and getting a confusing answer back.
        .refine((a) => (a.direction === "ll2xz" ? a.lat !== undefined && a.lon !== undefined : true), {
          message: "direction 'll2xz' requires both lat and lon",
          path: ["lat"],
        })
        .refine((a) => (a.direction === "xz2ll" ? a.x !== undefined && a.y !== undefined : true), {
          message: "direction 'xz2ll' requires both x and y",
          path: ["x"],
        }),
      outputSchema: z.object({ coords: z.unknown() }),
      annotations: liveRead,
    },
    async ({ direction, lat, lon, x, y, alt, host, port }) => {
      try {
        const args = direction === "ll2xz" ? { lat, lon, alt } : { x, y, alt };
        return await call({ cmd: direction, args }, { host, port }, "coords");
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "dcs_check_terrain",
    {
      title: "Check terrain under points",
      description:
        "Ask the RUNNING mission what surface is under a list of map points: LAND, SHALLOW_WATER, " +
        "WATER, ROAD or RUNWAY, plus terrain height.\n\n" +
        "This is the authoritative land/water check — DCS's own terrain query against the loaded " +
        "theatre. Ground groups placed on water do not error when the mission loads; the vehicles " +
        "just sit there inert, which looks like broken AI rather than a bad placement. Verify ground " +
        "positions with this before committing them.\n\n" +
        "Requires a mission to be running (the terrain API lives in the mission environment). Up to " +
        "500 points per call.\n\n" +
        "Args:\n  - points: [{ x, y }] DCS map metres (x = north, y = east)\n  - host?, port?\n\n" +
        "Returns JSON: { count, points: [{ x, y, surface, name, height, land }] }.",
      inputSchema: z
        .object({
          points: z
            .array(z.object({ x: z.number(), y: z.number() }).strict())
            .min(1)
            .max(500)
            .describe("Map points to sample"),
          host: hostField,
          port: portField,
        })
        .strict(),
      outputSchema: z.object({ terrain: z.unknown() }),
      annotations: liveRead,
    },
    async ({ points, host, port }) => {
      try {
        return await call({ cmd: "land", args: { points } }, { host, port }, "terrain");
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "dcs_load_mission",
    {
      title: "Load a mission in DCS",
      description:
        "Swap the mission on an ALREADY-RUNNING DCS session, so an authored mission can go from " +
        "dcs_miz_save_as to flying without the user touching the UI.\n\n" +
        "REQUIRES a mission to already be running. This calls net.load_mission, which is DCS's " +
        "server mission-rotation call; from a cold menu it returns nil and does nothing, so the " +
        "hook refuses the request with 'no mission is running' rather than reporting a phantom " +
        "success. Check dcs_bridge_status first: if phase is 'menu', ask the user to fly any " +
        "mission, then call this to swap in the authored one.\n\n" +
        "Loading is ASYNCHRONOUS: this returns as soon as DCS accepts the request, not when the " +
        "mission is up. Poll dcs_bridge_status (phase: running -> loading -> running) and check " +
        "dcs_get_log_errors afterwards — a mission that fails to open reports it in dcs.log and " +
        "nowhere else.\n\n" +
        "This takes over the user's DCS client; confirm with them before calling it.\n\n" +
        "Args:\n  - path (string): absolute path to a .miz\n  - host?, port?",
      inputSchema: z
        .object({
          path: z.string().min(1).describe("Absolute path to the .miz to load"),
          host: hostField,
          port: portField,
        })
        .strict(),
      outputSchema: z.object({ load: z.unknown() }),
      annotations: { ...liveWrite, destructiveHint: true },
    },
    async ({ path, host, port }) => {
      try {
        return await call({ cmd: "loadmission", args: { path } }, { host, port }, "load");
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  // Raw Lua escape hatch: doubly gated (env var here + ALLOW_EXEC in the hook).
  if (process.env.DCS_ALLOW_RAW_LUA === "1") {
    server.registerTool(
      "dcs_execute_lua",
      {
        title: "Execute raw Lua (unsafe)",
        description:
          "Run arbitrary Lua in a DCS state. DISABLED unless DCS_ALLOW_RAW_LUA=1 AND ALLOW_EXEC=true in " +
          "the hook. This bypasses all structured-tool safety and requires a de-sanitized DCS. Prefer the " +
          "structured tools.\n\nArgs:\n  - code (string): Lua to run\n  - env ('mission'|'export'|'server')\n" +
          "  - host?, port?",
        inputSchema: z
          .object({
            code: z.string().min(1).max(10000).describe("Lua source to execute"),
            env: z.enum(["mission", "export", "server"]).default("mission").describe("DCS state to run in"),
            host: hostField,
            port: portField,
          })
          .strict(),
        outputSchema: z.object({ exec: z.unknown() }),
        annotations: { ...liveWrite, destructiveHint: true },
      },
      async ({ code, env, host, port }) => {
        try {
          return await call({ cmd: "exec", args: { code, env } }, { host, port }, "exec");
        } catch (err) {
          return errorResult(err);
        }
      }
    );
  }
}
