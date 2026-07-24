/** Live DCS telemetry bridge tools (require a running DCS with scripts/Export.lua). */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { bridgeRequest, type BridgeOptions } from "../bridge/client.js";
import { BRIDGE_DEFAULT_HOST, BRIDGE_DEFAULT_PORT } from "../constants.js";
import { buildResult, errorResult } from "./format.js";

const hostField = z
  .string()
  .default(process.env.DCS_BRIDGE_HOST ?? BRIDGE_DEFAULT_HOST)
  .describe("Host of the DCS export bridge (default from DCS_BRIDGE_HOST or 127.0.0.1)");

const portField = z.coerce
  .number()
  .int()
  .min(1)
  .max(65535)
  .default(Number(process.env.DCS_BRIDGE_PORT ?? BRIDGE_DEFAULT_PORT))
  .describe("Port of the DCS export bridge (default from DCS_BRIDGE_PORT or 8899)");

const liveBridge = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

export function registerBridgeTools(server: McpServer): void {
  server.registerTool(
    "dcs_bridge_status",
    {
      title: "Check DCS bridge",
      description:
        "Ping the live DCS export bridge to check connectivity. Use this before other live tools to " +
        "confirm DCS is running with scripts/Export.lua installed.\n\nArgs:\n  - host (string, optional)\n" +
        "  - port (number, optional)\n\nReturns JSON: { connected, host, port, ... }.",
      inputSchema: z.object({ host: hostField, port: portField }).strict(),
      annotations: liveBridge,
    },
    async ({ host, port }) => {
      const opts: BridgeOptions = { host, port };
      try {
        const data = await bridgeRequest("ping", opts);
        return buildResult(`Connected to DCS bridge at ${host}:${port}.`, {
          connected: true,
          host,
          port,
          response: data,
        });
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
        "Return the latest ownship (player aircraft) telemetry from the live DCS export bridge: " +
        "position, altitude, attitude, and speed. Requires DCS running with scripts/Export.lua.\n\n" +
        "Args:\n  - host (string, optional)\n  - port (number, optional)\n\n" +
        "Returns whatever Export.lua exposes for LoGetSelfData/LoGetAltitudeAboveSeaLevel etc.",
      inputSchema: z.object({ host: hostField, port: portField }).strict(),
      annotations: liveBridge,
    },
    async ({ host, port }) => {
      try {
        const data = await bridgeRequest("self", { host, port });
        return buildResult(JSON.stringify(data, null, 2), { self: data } as Record<string, unknown>);
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
        "Return metadata about the mission currently loaded in the running DCS instance via the " +
        "export bridge (theatre, mission name, model time).\n\nArgs:\n  - host (string, optional)\n" +
        "  - port (number, optional)",
      inputSchema: z.object({ host: hostField, port: portField }).strict(),
      annotations: liveBridge,
    },
    async ({ host, port }) => {
      try {
        const data = await bridgeRequest("mission", { host, port });
        return buildResult(JSON.stringify(data, null, 2), { mission: data } as Record<string, unknown>);
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}
