#!/usr/bin/env node
import {registerProductionTools} from './tools/production.js';
/**
 * DCS World MCP server.
 *
 * Capability groups over stdio (Claude, Codex, OpenCode, any MCP client):
 *   1. Offline .miz authoring, editing and inspection (no running DCS required).
 *   2. Offline reference data: unit types, countries, airfields, coordinates.
 *   3. Live control of a running DCS through scripts/Hooks/dcs-mcp-hook.lua.
 *   4. Diagnostics from dcs.log, which work with DCS closed.
 *
 * The server never executes Lua from a mission and never writes to a source mission file.
 *
 * `dcs-mcp-server install-hook [--saved-games <dir>] [--telemetry] [--force] [--dry-run]`
 * installs the live hook instead of starting the server.
 *
 * `dcs-mcp-server install-claude-desktop [--published|--local] [--config <file>]
 * [--name <key>] [--saved-games <dir>] [--dcs-install <dir>] [--bridge-host <host>]
 * [--bridge-port <port>] [--ffmpeg <exe>] [--force] [--dry-run]` registers this
 * server with the Claude Desktop app instead of starting the server.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GuardedStdioTransport } from "./security/transport.js";
import { captureCatalogue, registerCatalogueTool } from "./tools/catalogue.js";
import { registerMissionDesignTools } from "./tools/mission-design.js";
import { registerAdvancedAuthoringTools } from "./tools/advanced-authoring.js";
import { registerTerrainPlacementTools } from "./tools/terrain-placement.js";
import { registerTerrainTools } from "./tools/terrain.js";
import { registerAudioTools } from "./tools/audio.js";
import { registerMizTools } from "./tools/miz.js";
import { registerMizAuthoringTools } from "./tools/miz-authoring.js";
import { registerMizEditingTools } from "./tools/miz-editing.js";
import { registerMizDressingTools } from "./tools/miz-dressing.js";
import { registerReferenceTools } from "./tools/reference.js";
import { registerAcceptanceTools } from "./tools/acceptance.js";
import { registerRuntimeTools } from "./tools/runtime.js";
import { registerAircraftRuntimeTools } from "./tools/aircraft-runtime.js";
import { registerBridgeTools } from "./tools/bridge.js";
import { registerMizExtendedTools } from "./tools/miz-extended.js";
import { registerMizInspectEditTools } from "./tools/miz-inspect-edit.js";
import { registerDataQualityTools } from "./tools/data-quality.js";
import { registerCampaignSceneTools } from "./tools/campaign-scene.js";
import { registerLearnedTypeTools } from "./tools/learned-types.js";
import { registerDiagnosticTools } from "./tools/diagnostics.js";
import { registerPrompts, registerResources } from "./tools/resources.js";
import { enableSessionPersistence } from "./miz/sessions.js";
import { enableAirbasePacks } from "./dcs/airbase-packs.js";
import { enableLearnedTypes } from "./dcs/mission-learned.js";
import { enableInstalledSceneryTypes } from "./dcs/scenery-assets.js";
import { findSavedGamesDirs, installHook } from "./dcs/install.js";
import { configureClaudeDesktop, type EntryMode } from "./dcs/claude-desktop.js";
import { SERVER_INSTRUCTIONS } from "./guide.js";
import { PACKAGE_VERSION } from "./paths.js";

function createServer(selected?: Set<string>) {
  const server = new McpServer(
    { name: "dcs-mcp-server", version: PACKAGE_VERSION },
    { instructions: selected
      ? `This client exposes only these tools: ${[...selected].join(', ')}. Use only this selection; other tool examples in the guide are unavailable in this connection.\n\n${SERVER_INSTRUCTIONS}`
      : SERVER_INSTRUCTIONS }
  );
  const catalogue = captureCatalogue(server, selected);
  registerMizTools(server);
  registerAudioTools(server);
  registerAdvancedAuthoringTools(server);
  registerMissionDesignTools(server);
  registerTerrainTools(server);
  registerTerrainPlacementTools(server);
  registerMizAuthoringTools(server);
  registerMizEditingTools(server);
  registerMizDressingTools(server);
  registerMizExtendedTools(server);
  registerMizInspectEditTools(server);
  registerDataQualityTools(server);
  registerCampaignSceneTools(server);
  registerLearnedTypeTools(server);
  registerReferenceTools(server);
  registerBridgeTools(server);
  registerRuntimeTools(server);
  registerAircraftRuntimeTools(server);
  registerAcceptanceTools(server);
  registerProductionTools(server);
  registerDiagnosticTools(server);
  registerResources(server);
  registerPrompts(server);
  registerCatalogueTool(server, catalogue.entries);
  const unknown = [...(selected ?? [])].filter(name => !catalogue.known.has(name));
  if (unknown.length) throw new Error(`Unknown --tools names: ${unknown.join(', ')}`);
  return { server, schemas: catalogue.schemas };
}

function cliFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function cliValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function installHookCli(args: string[]): Promise<number> {
  const flag = (name: string) => cliFlag(args, name);
  const value = (name: string) => cliValue(args, name);
  let savedGames = value("--saved-games");
  if (!savedGames) {
    const candidates = findSavedGamesDirs();
    if (candidates.length !== 1) {
      console.error(
        candidates.length === 0
          ? "No DCS Saved Games folder found. Pass --saved-games <dir> (or set DCS_SAVED_GAMES)."
          : `Several DCS profiles found; pass --saved-games with one of:\n${candidates.map((c) => `  ${c.path}`).join("\n")}`
      );
      return 2;
    }
    savedGames = candidates[0].path;
  }
  const result = await installHook({
    savedGames,
    telemetry: flag("--telemetry"),
    overwrite: flag("--force"),
    dryRun: flag("--dry-run"),
  });
  for (const f of result.files) {
    console.log(`${f.status.padEnd(13)} ${f.target}${f.backup ? `  (previous kept at ${f.backup})` : ""}`);
  }
  for (const note of result.notes) console.log(`\n${note}`);
  return result.files.some((f) => f.status === "differs") ? 1 : 0;
}

async function installClaudeDesktopCli(args: string[]): Promise<number> {
  const flag = (name: string) => cliFlag(args, name);
  const value = (name: string) => cliValue(args, name);
  let mode: EntryMode | undefined;
  if (flag("--published")) mode = "published";
  if (flag("--local")) {
    if (mode) {
      console.error("Pass either --local or --published, not both.");
      return 2;
    }
    mode = "local";
  }
  const result = await configureClaudeDesktop({
    configPath: value("--config"),
    serverName: value("--name"),
    mode,
    overwrite: flag("--force"),
    dryRun: flag("--dry-run"),
    env: {
      DCS_SAVED_GAMES: value("--saved-games"),
      DCS_INSTALL_DIR: value("--dcs-install"),
      DCS_BRIDGE_HOST: value("--bridge-host"),
      DCS_BRIDGE_PORT: value("--bridge-port"),
      DCS_FFMPEG_PATH: value("--ffmpeg"),
    },
  });
  console.log(`${result.status.padEnd(13)} ${result.serverName} in ${result.configPath}`);
  console.log(`${"".padEnd(13)} ${result.mode}: ${result.entry.command} ${result.entry.args.join(" ")}`);
  if (result.entry.env) {
    for (const [key, val] of Object.entries(result.entry.env)) {
      console.log(`${"".padEnd(13)} env ${key}=${val}`);
    }
  }
  if (result.backup) console.log(`${"".padEnd(13)} previous config kept at ${result.backup}`);
  for (const note of result.notes) console.log(`\n${note}`);
  return result.status === "differs" ? 1 : 0;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "install-hook") {
    process.exit(await installHookCli(rest));
  }
  if (command === "install-claude-desktop") {
    process.exit(await installClaudeDesktopCli(rest));
  }
  if (command === "--version" || command === "-v") {
    console.log(PACKAGE_VERSION);
    return;
  }
  const stateDir = enableSessionPersistence();
  // Airfields sampled from a running DCS (airbase packs) become visible to the airfield
  // lookup, which is what makes a theatre pydcs never exported usable offline.
  enableAirbasePacks();
  // Types learned from the user's own missions: mod airframes, and DCS types
  // newer than the pinned pydcs. Never shadows a bundled type.
  enableLearnedTypes();
  enableInstalledSceneryTypes();
  const args = process.argv.slice(2);
  let selected: Set<string> | undefined;
  if (args.includes('--tools')) {
    const value = cliValue(args, '--tools');
    selected = new Set(value?.split(',').map(name => name.trim()).filter(Boolean));
    if (!selected.size) throw new Error('Pass --tools followed by comma-separated DCS tool names. Omit --tools to expose all tools.');
  }
  const { server } = createServer(selected);
  await server.connect(new GuardedStdioTransport());
  console.error(
    `dcs-mcp-server ${PACKAGE_VERSION} running on stdio` +
      (stateDir ? ` (session snapshots: ${stateDir})` : " (session snapshots disabled)")
  );
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
