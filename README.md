# DCS-MCP

A [Model Context Protocol](https://modelcontextprotocol.io) server for **Digital Combat Simulator (DCS World)**. Works with any MCP client — Claude, Codex, OpenCode, etc. — over stdio.

Three things it does:

- **Build missions offline** — create/modify `.miz` files (groups, zones, weather, briefing) and save copy-on-write. No running DCS needed.
- **Inspect missions** — open a `.miz` and read its summary, groups, weather, and briefing, and validate it.
- **Live control** — query units, spawn groups, send messages, and convert coordinates in a *running* mission via a bundled DCS hook.

It never executes mission Lua (missions are parsed as data), never overwrites a source `.miz`, and keeps raw-Lua execution behind an explicit opt-in.

## Install

```bash
npm install && npm run build   # outputs dist/index.js
npm test                       # optional
```

## Client configuration

Point your MCP client at the built server (stdio). Optional env: `DCS_BRIDGE_HOST` (default `127.0.0.1`), `DCS_BRIDGE_PORT` (default `8899`), `DCS_ALLOW_RAW_LUA=1` (exposes `dcs_execute_lua`).

```json
{
  "mcpServers": {
    "dcs": { "command": "node", "args": ["/absolute/path/to/dcs-mcp/dist/index.js"] }
  }
}
```

- **Claude / Claude Code**: `claude mcp add` or add the block to `~/.claude.json`.
- **Codex**: add an equivalent `command`/`args` entry in `~/.codex/config.toml`.
- **OpenCode**: add it under `mcp` in `opencode.json`.

## Tools

**Author (offline):** `dcs_miz_new`, `dcs_miz_add_aircraft_group`, `dcs_miz_add_ground_group`, `dcs_miz_add_waypoint`, `dcs_miz_set_payload`, `dcs_miz_set_group_task`, `dcs_miz_add_trigger_zone`, `dcs_miz_add_trigger`, `dcs_miz_set_weather`, `dcs_miz_set_briefing`, `dcs_miz_diff`, `dcs_miz_save_as`

**Inspect (offline):** `dcs_miz_open`, `dcs_miz_get_summary`, `dcs_miz_list_groups`, `dcs_miz_get_weather`, `dcs_miz_get_briefing`, `dcs_miz_validate`, `dcs_miz_close`

**Live (DCS running):** `dcs_bridge_status`, `dcs_get_self_data`, `dcs_get_mission_info`, `dcs_get_all_units`, `dcs_get_aircraft_list`, `dcs_send_message`, `dcs_spawn_unit`, `dcs_convert_coords`, and (gated) `dcs_execute_lua`

Offline positions are DCS x/y metres; use `dcs_convert_coords` (live) to turn lat/long into x/y.

## Using it from Claude / Codex / OpenCode

Once configured, just ask your AI client in natural language — it calls the tools for you. All tools are available at once; the model uses `dcs_bridge_status` to decide whether to work live or offline.

**Build a mission offline (no DCS needed):**

> "Create a Caucasus mission, add a 2-ship F/A-18C CAP flight for the USA with two waypoints, set clear weather and a briefing, then save it to ~/Missions/op.miz"

→ `dcs_miz_new` → `dcs_miz_add_aircraft_group` → `dcs_miz_add_waypoint` → `dcs_miz_set_group_task` → `dcs_miz_set_weather` → `dcs_miz_set_briefing` → `dcs_miz_save_as`

**Act in a running mission (DCS online):**

> "Is DCS connected? If so, spawn an Abrams platoon near 42.1N 42.3E and message all players 'Armor inbound'."

→ `dcs_bridge_status` → `dcs_spawn_unit` → `dcs_send_message`

**Inspect an existing file:**

> "Open ~/Missions/op.miz and list all the blue groups and the weather."

→ `dcs_miz_open` → `dcs_miz_list_groups` → `dcs_miz_get_weather`

## Live bridge setup

For full live control, copy [`scripts/Hooks/dcs-mcp-hook.lua`](scripts/Hooks/dcs-mcp-hook.lua) into `Saved Games/DCS/Scripts/Hooks/` and start a mission. It opens a local read-only TCP server on `127.0.0.1:8899` and answers structured commands (`units`, `spawn`, `message`, coordinate conversion, …). For **telemetry only** without a Hooks script, use [`scripts/Export.lua`](scripts/Export.lua) instead (port `8898`).

Structured commands build vetted Lua internally — the model never supplies Lua. Raw `dcs_execute_lua` is doubly gated: `DCS_ALLOW_RAW_LUA=1` here **and** `ALLOW_EXEC = true` in the hook. Enabling it runs arbitrary Lua in DCS and requires a de-sanitized `MissionScripting.lua`; leave it off unless you understand the risk.

## Safety

Every `.miz` is treated as untrusted: archives are checked for path traversal and zip-bomb limits (entry count, expanded/per-entry size, compression ratio) **before** decompression; only known data entries are read; mission Lua is parsed as data, never run. Saves are copy-on-write and refuse to overwrite the source; a SHA-256 digest is returned for every generated file. See `src/security/`, `src/miz/lua.ts`, and `src/miz/archive.ts`.

## Notes & status

Round-trip editing of existing missions (open → edit → save → reopen) is covered by tests. Some things need a final pass in the DCS Mission Editor: **triggers** are written in the ME's structured form and are compiled to runtime form when you open+save in the ME; brand-new missions from `dcs_miz_new` are a best-effort skeleton. Live tools are written to the DCS scripting API and need verification against a real DCS install.

## License

[Apache 2.0](LICENSE).
