# DCS-MCP

A [Model Context Protocol](https://modelcontextprotocol.io) server for **Digital Combat Simulator (DCS World)**. It works with any MCP client — Claude, Codex, OpenCode, etc. — over stdio.

Two capability groups:

- **Offline `.miz` inspection** — open a mission archive, read its summary, groups, weather, and briefing, and validate it. No running DCS required.
- **Live telemetry bridge** — read ownship and mission data from a running DCS via a bundled `Export.lua` hook.

It never executes Lua from a mission and never writes to your mission files.

## Install

```bash
npm install
npm run build   # outputs dist/index.js
npm test        # optional
```

## Client configuration

Point your MCP client at the built server (stdio). Optional env vars: `DCS_BRIDGE_HOST` (default `127.0.0.1`), `DCS_BRIDGE_PORT` (default `8899`).

```json
{
  "mcpServers": {
    "dcs": {
      "command": "node",
      "args": ["/absolute/path/to/dcs-mcp/dist/index.js"]
    }
  }
}
```

- **Claude / Claude Code**: add the block above to your MCP config (`claude mcp add` or `~/.claude.json`).
- **Codex**: add an equivalent `command`/`args` entry to `~/.codex/config.toml`.
- **OpenCode**: add it under `mcp` in `opencode.json`.

## Tools

| Tool | Description |
|------|-------------|
| `dcs_miz_open` | Open a `.miz` as a read-only session (safety-checked). |
| `dcs_miz_get_summary` | Theatre, coalitions/countries, counts, weather, briefing. |
| `dcs_miz_list_groups` | List groups, filterable by coalition/category. |
| `dcs_miz_get_weather` | Temperature, QNH, clouds, wind. |
| `dcs_miz_get_briefing` | Briefing title/description (dictionary-resolved). |
| `dcs_miz_validate` | Structural validation (errors vs. warnings). |
| `dcs_miz_close` | Close a session. |
| `dcs_bridge_status` | Ping the live DCS export bridge. |
| `dcs_get_self_data` | Live ownship telemetry. |
| `dcs_get_mission_info` | Live mission metadata. |

## Live bridge setup

Copy [`scripts/Export.lua`](scripts/Export.lua) into `Saved Games/DCS/Scripts/Export.lua` (it chains any existing hooks) and start a mission. The hook opens a local, read-only TCP listener on `127.0.0.1:8899` that answers only the whitelisted `ping`/`self`/`mission` commands. Based on the [DCS Lua Export API](https://www.digitalcombatsimulator.com/en/dev_journal/lua-export/) and the socket-bridge pattern from [sprhawk/dcs_scripts](https://github.com/sprhawk/dcs_scripts).

## Safety

Every `.miz` is treated as untrusted: archives are checked for path traversal and zip-bomb limits (entry count, expanded size, compression ratio) **before** decompression, only known data entries are read, and mission Lua is parsed as data — never run. See `src/security/` and `src/miz/lua.ts`.

## Status & roadmap

Implemented: read/inspect/validate (offline) + live telemetry bridge. Planned: copy-on-write `.miz` authoring (add groups, routes, tasks, triggers, weather, briefing), structured diffs, and change manifests. See the plan in the PR description.

## License

[Apache 2.0](LICENSE).
