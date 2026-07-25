#!/usr/bin/env node
/**
 * DCS World MCP server.
 *
 * Exposes two capability groups over stdio (compatible with Claude, Codex, OpenCode,
 * and any MCP client):
 *   1. Offline .miz mission inspection (no running DCS required).
 *   2. A live telemetry bridge to a running DCS instance via scripts/Export.lua.
 *
 * The server never executes Lua from a mission and never writes to a source mission file.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerMizTools } from "./tools/miz.js";
import { registerMizAuthoringTools } from "./tools/miz-authoring.js";
import { registerBridgeTools } from "./tools/bridge.js";
import { registerDiagnosticTools } from "./tools/diagnostics.js";

const server = new McpServer({
  name: "dcs-mcp-server",
  version: "0.1.0",
});

registerMizTools(server);
registerMizAuthoringTools(server);
registerBridgeTools(server);
registerDiagnosticTools(server);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("dcs-mcp-server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
