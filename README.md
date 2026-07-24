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

**Inspect (offline):** `dcs_miz_open`, `dcs_miz_get_summary`, `dcs_miz_list_groups`, `dcs_miz_get_weather`, `dcs_miz_get_briefing`, `dcs_miz_validate`, `dcs_miz_list_sessions`, `dcs_miz_close`

**Live (DCS running):** `dcs_bridge_status`, `dcs_get_self_data`, `dcs_get_mission_info`, `dcs_get_all_units`, `dcs_get_aircraft_list`, `dcs_send_message`, `dcs_spawn_unit`, `dcs_convert_coords`, and (gated) `dcs_execute_lua`

Offline positions are DCS x/y metres; use `dcs_convert_coords` (live) to turn lat/long into x/y.

Every tool declares an `outputSchema` and returns `structuredContent` alongside its text, so clients get typed results rather than prose they have to re-parse. Tools that read data also take `response_format` (`markdown` or `json`).

### Guardrails worth knowing

- `dcs_miz_save_as` refuses to write over the source `.miz`, and refuses to replace **any** existing file unless you pass `overwrite=true`.
- `dcs_miz_validate` (also run automatically before every save) reports duplicate names, empty groups, implausible QNH, and triggers whose `activate_group` or zone conditions reference something the mission does not contain.
- Sessions live only for the life of the server process. If you lose a `sessionId`, `dcs_miz_list_sessions` gets it back; closing a session discards unsaved changes.

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

For full live control, copy [`scripts/Hooks/dcs-mcp-hook.lua`](scripts/Hooks/dcs-mcp-hook.lua) into `Saved Games/DCS/Scripts/Hooks/` and start a mission. It listens on `127.0.0.1:8899` (localhost only) and answers structured commands (`units`, `spawn`, `message`, coordinate conversion, …). This is a **control** channel, not a read-only one: it can spawn groups and show messages in your running mission. For **telemetry only**, use [`scripts/Export.lua`](scripts/Export.lua) instead (port `8898`).

The hook services connections without blocking the simulation frame, and logs to `Saved Games/DCS/Logs/dcs.log` under the `DCS-MCP` tag — check there first if `dcs_bridge_status` cannot connect, since a port conflict is reported at bind time.

Structured commands build vetted Lua internally — the model never supplies Lua. Raw `dcs_execute_lua` is doubly gated: `DCS_ALLOW_RAW_LUA=1` here **and** `ALLOW_EXEC = true` in the hook. Enabling it runs arbitrary Lua in DCS and requires a de-sanitized `MissionScripting.lua`; leave it off unless you understand the risk.

## Safety

Every `.miz` is treated as untrusted: archives are checked for path traversal and zip-bomb limits (entry count, expanded/per-entry size, compression ratio) **before** decompression; only known data entries are read; mission Lua is parsed as data, never run. Saves are copy-on-write and refuse to overwrite either the source file or any other existing file (unless you pass `overwrite=true`); a SHA-256 digest is returned for every generated file. Entries the server does not understand are carried through byte-for-byte, so editing a mission never silently drops content. See `src/security/`, `src/miz/lua.ts`, and `src/miz/archive.ts`.

## Notes & status

Round-trip editing of existing missions (open → edit → save → reopen) is covered by tests, including exact preservation of strings containing quotes, backslashes, tabs, and CRLF — the kind of text DCS puts in briefings.

Some things still need a final pass in the DCS Mission Editor, and are honestly unverified against a real install:

- **Triggers** are written in the ME's structured `trigrules` form only. DCS compiles the runtime `mission.trig` tables when you open and save in the Mission Editor, so a generated trigger is not guaranteed to fire if you fly the `.miz` directly. Reference validation (does the named group/zone exist?) is enforced offline; the runtime compilation is not implemented, because the exact DCS-internal function names and wiring have to be captured from ME-saved missions rather than guessed.
- Brand-new missions from `dcs_miz_new` are a best-effort skeleton.
- Authored groups and units are given unique `groupId`/`unitId` values, which DCS expects, but the generated files have not been flown on a real DCS install as part of this work.
- Live tools are written against the DCS scripting API and need verification with DCS actually running.

## License

[Apache 2.0](LICENSE).
