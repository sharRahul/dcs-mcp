/**
 * The MCPB manifest for the Claude Desktop bundle, derived from package.json so
 * the version and metadata have one source of truth.
 *
 * Field names and the `${__dirname}` / `${user_config.*}` substitutions follow the
 * MCPB spec (modelcontextprotocol/mcpb, MANIFEST.md) at manifest_version 0.4, whose
 * schema sets `additionalProperties: false` — an unknown key is rejected outright.
 * `npx @anthropic-ai/mcpb validate` accepts this manifest (it accepted the earlier
 * 0.3 form too, so the bump is for the current schema, not a fix).
 * Deliberately absent:
 *   - `compatibility.claude_desktop`: a version constraint we cannot check would
 *     only risk blocking an install, so no range is claimed.
 *   - `platforms`: offline authoring runs anywhere Claude Desktop does; only
 *     flying and the live bridge need Windows, which the README states.
 *   - `icon`: this repository ships no PNG, and the spec makes it optional.
 * Every user_config value is optional: the server treats an empty environment
 * variable as unset, so an unanswered field keeps its built-in default.
 */
export const MANIFEST_VERSION = '0.4';
export const MANIFEST_SCHEMA =
  'https://raw.githubusercontent.com/anthropics/mcpb/main/schemas/mcpb-manifest-v0.4.schema.json';
export const SERVER_ENTRY_POINT = 'server/dist/index.js';

export function buildManifest(pkg) {
  return {
    $schema: MANIFEST_SCHEMA,
    manifest_version: MANIFEST_VERSION,
    name: 'dcs-mcp',
    display_name: 'DCS Sortie MCP',
    version: pkg.version,
    description: 'Create, edit and inspect DCS World missions in conversation, with optional live control of a running sim.',
    long_description:
      'An independent open-source project for DCS World. Not affiliated with or endorsed by Eagle Dynamics. ' + 'Authors and edits DCS World .miz missions offline: aircraft, ground forces, ships, air defences, routes, '
      + 'payloads, weather, triggers, briefings and mission audio, with validation before you fly. DCS can stay '
      + 'closed. With the bundled hook installed in a DCS profile and a mission running, it also reads live state, '
      + 'samples terrain and swaps in a built mission. It never executes Lua from a mission and never overwrites a '
      + 'source .miz: saving always writes a new file.',
    author: { name: 'DCS Sortie MCP contributors', url: pkg.homepage },
    repository: { type: 'git', url: pkg.repository.url },
    homepage: pkg.homepage,
    documentation: `${pkg.homepage}#readme`,
    support: pkg.bugs.url,
    license: pkg.license,
    keywords: pkg.keywords,
    server: {
      type: 'node',
      entry_point: SERVER_ENTRY_POINT,
      mcp_config: {
        command: 'node',
        args: [`\${__dirname}/${SERVER_ENTRY_POINT}`],
        env: {
          DCS_SAVED_GAMES: '${user_config.saved_games}',
          DCS_INSTALL_DIR: '${user_config.dcs_install_dir}',
          DCS_BRIDGE_HOST: '${user_config.bridge_host}',
          DCS_BRIDGE_PORT: '${user_config.bridge_port}',
          DCS_FFMPEG_PATH: '${user_config.ffmpeg_path}',
          DCS_MISSION_OUTPUT_DIR: '${user_config.mission_output_dir}',
        },
      },
    },
    user_config: {
      mission_output_dir: {
        type: 'directory',
        title: 'Mission output folder',
        description: 'All mission saves use this folder. Leave empty for Saved Games/DCS/Missions/My Mission under your user profile. Production projects and acceptance kits are stored beneath it.',
        required: false,
      },
      saved_games: {
        type: 'directory',
        title: 'DCS Saved Games folder',
        description:
          'Your DCS profile, e.g. C:\\Users\\<you>\\Saved Games\\DCS (or DCS.openbeta). Used for dcs.log diagnostics, '
          + 'installed mods, scripts and the hook. Leave empty to search the usual locations.',
        required: false,
      },
      dcs_install_dir: {
        type: 'directory',
        title: 'DCS install folder',
        description:
          'Where DCS World itself is installed, read for terrains, unit mods and the editor template library. '
          + 'Leave empty to use the path DCS logs at startup, then Program Files.',
        required: false,
      },
      bridge_host: {
        type: 'string',
        title: 'Live bridge host',
        description: 'Where the in-game hook listens. Only change this for a remote DCS host.',
        default: '127.0.0.1',
        required: false,
      },
      bridge_port: {
        type: 'number',
        title: 'Live bridge port',
        description: 'Port the in-game hook listens on.',
        default: 8899,
        min: 1,
        max: 65535,
        required: false,
      },
      ffmpeg_path: {
        type: 'file',
        title: 'FFmpeg executable',
        description:
          'Optional. Needed only to convert your own MP3/WAV/OGG files into mission audio. Leave empty to use '
          + 'ffmpeg from PATH.',
        required: false,
      },
    },
    compatibility: { runtimes: { node: '>=20.0.0' } },
    tools_generated: true,
    prompts_generated: true,
  };
}
