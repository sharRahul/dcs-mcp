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

**Author (offline):** `dcs_miz_new`, `dcs_miz_add_aircraft_group`, `dcs_miz_add_ground_group`, `dcs_miz_add_waypoint`, `dcs_miz_set_payload`, `dcs_miz_set_group_task`, `dcs_miz_add_trigger_zone`, `dcs_miz_add_trigger`, `dcs_miz_load_scripts`, `dcs_miz_list_resources`, `dcs_miz_set_weather`, `dcs_miz_set_briefing`, `dcs_miz_diff`, `dcs_miz_save_as`

**Inspect (offline):** `dcs_miz_open`, `dcs_miz_get_summary`, `dcs_miz_list_groups`, `dcs_miz_get_weather`, `dcs_miz_get_briefing`, `dcs_miz_validate`, `dcs_miz_list_sessions`, `dcs_miz_close`

**Live (DCS running):** `dcs_bridge_status`, `dcs_get_self_data`, `dcs_get_mission_info`, `dcs_get_all_units`, `dcs_get_aircraft_list`, `dcs_send_message`, `dcs_spawn_unit`, `dcs_convert_coords`, and (gated) `dcs_execute_lua`

**Diagnostics (work with DCS closed):** `dcs_status`, `dcs_get_log_errors`

Offline positions are DCS x/y metres; use `dcs_convert_coords` (live) to turn lat/long into x/y.

Every tool declares an `outputSchema` and returns `structuredContent` alongside its text, so clients get typed results rather than prose they have to re-parse. Tools that read data also take `response_format` (`markdown` or `json`).

### Guardrails worth knowing

- `dcs_miz_save_as` refuses to write over the source `.miz`, and refuses to replace **any** existing file unless you pass `overwrite=true`.
- `dcs_miz_validate` (also run automatically before every save) reports duplicate names, empty groups, implausible QNH, triggers referencing a group, unit or zone the mission does not contain, invalid flags, groups with no route points (which the Mission Editor cannot open), and triggers with no compiled runtime entry (which would not fire if flown).

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

## Placement

Headings are given in **degrees** and written to the mission in radians, which is what DCS stores
(confirmed against 17,367 unit headings in Mission-Editor-saved missions).

A group's units are laid out as a column trailing its heading — vehicles 20 m apart, ships 120 m,
aircraft 60 m. Spacing follows the heading, so a convoy always lines up with the way it is facing
rather than sitting at an angle to it.

DCS map axes are `x` = north, `y` = east. Use `dcs_convert_coords` to turn lat/long into x/y when
DCS is running.

## Knowing when something broke

`dcs_status` answers "is DCS up, is the bridge reachable, and has anything gone wrong" in one call, and
does not fail when DCS is closed — it falls back to the log. `dcs_get_log_errors` reads
`Saved Games/DCS/Logs/dcs.log` directly.

That log matters because it is the **only error channel that is always available**. The live bridge
needs DCS running; the log records failures at every stage, including the two that bite hardest when
authoring missions offline:

- a generated `.miz` the Mission Editor refuses to open, and
- a mission script that throws on load.

Routine startup noise (skipped demo mods, per-module weapon-drag errors, missing optional units) is
filtered out. Lua stack tracebacks are folded into the entry they belong to, and `blames` lists the
files the traceback names. Pass `sinceLine` from a previous call to see only what is new.

The hook now opens its socket when it **loads**, not when a mission starts, so the bridge answers in
the main menu and the Mission Editor too — which is exactly when you need to ask why a mission would
not open. `dcs_status` reports `phase` (menu / loading / loaded / running) and `missionEnv`, so
"no mission is running" is distinguishable from "the bridge is down". Commands that reach into the
mission scripting environment still require a mission to actually be running.

## Notes & status

Round-trip editing of existing missions (open → edit → save → reopen) is covered by tests, including exact preservation of strings containing quotes, backslashes, tabs, and CRLF — the kind of text DCS puts in briefings.

**Triggers** are written in both forms DCS uses: the Mission Editor's structured `trigrules`, and the
compiled runtime `mission.trig` tables the simulation actually executes. That means an authored trigger
fires when the `.miz` is flown directly — no Mission Editor round-trip needed.

Every predicate mapping was captured from missions saved by the Mission Editor rather than guessed.
`tests/fixtures/trig-oracle.json` records those spec → compiled-Lua pairs, and the tests assert our
output matches them byte for byte across all four trigger types (once, continuous, change, start).
Regenerate the oracle against your own missions with:

```bash
npx tsx tests/build-trig-oracle.ts "$USERPROFILE/Saved Games/DCS/Missions" tests/fixtures/trig-oracle.json
```

There are also runtime tests that load an authored mission's triggers and run them under the Lua
interpreter DCS ships (`luae.exe`, Lua 5.1), with the `c_*`/`a_*` predicates mocked: a `once` trigger
disarms itself, a `change` trigger latches and re-arms, a radio menu item raises its flag and drives
another trigger, and framework scripts load at startup in dependency order. The same harness loads the
live hook itself, which is how a `load(string)` call that is valid in Lua 5.2+ but fatal on DCS's 5.1
was caught. These are skipped unless you point `DCS_LUA` at your install:

```bash
DCS_LUA="C:/Program Files/Eagle Dynamics/DCS World/bin-mt/luae.exe" npm test
```

Groups, units and zones are referenced in triggers by NAME in the tool API and resolved to the DCS
numeric ids the file format requires; a name that is not in the mission is an error rather than a
trigger that silently never fires. Message text is stored in `l10n/DEFAULT/dictionary` behind a
`DictKey_...`, the same way the Mission Editor stores it.

### What a trigger can do

**Audiences.** Messages and sounds can target everyone, a coalition, a group, a unit, or a country —
`message`, `message_to_coalition`, `message_to_group`, `message_to_unit`, `message_to_country`, and
the `sound*` equivalents.

**Radio menu (F10 "Other").** `add_radio_item` / `add_radio_item_for_group` create a menu entry that
raises a flag when the player picks it; react to it with a `flag_is_true` condition and tear it down
with `remove_radio_item`. `radio_transmission` broadcasts an embedded `.ogg` on a frequency from a
trigger zone.

**AI and world.** `activate_group`, `deactivate_group`, `group_on`, `group_off`, `group_resume`,
`explode`, `smoke`, `signal_flare`, `end_mission`, and the flag actions.

**Scripting.** `do_script` runs inline Lua; `do_script_file` embeds a `.lua` from disk and runs it.

### Scripting frameworks (MIST, MOOSE, Skynet-IADS)

`dcs_miz_load_scripts` embeds a framework into the `.miz` and wires it to run at mission start:

```bash
npx tsx -e "/* via MCP */"   # or just call the tool from your MCP client
```

All loads go into **one** `MISSION START` trigger, in dependency order (MIST → MOOSE → Skynet → your
setup scripts). That is not a stylistic choice: DCS walks `mission.trig.funcStartup` with `pairs`, so
separate start triggers have **no defined order**, and Skynet fails to initialise if MIST has not
loaded yet. Actions inside one trigger compile to a single Lua chunk that runs top to bottom, which is
the only ordering DCS guarantees — and it is exactly what the Mission Editor produces for the shipped
Skynet and MOOSE demo missions.

Requesting `skynet` pulls in `mist` automatically. Framework files are auto-discovered under
`Saved Games/DCS/Missions/LUA Scripts` and `Saved Games/DCS/Scripts`, preferring the newest versioned
single-file build; pass explicit paths to override. Re-loading a framework already in the mission
reuses it rather than embedding a second copy or running its initialisation twice.

Embedded files live under `l10n/DEFAULT/` and are registered in `l10n/DEFAULT/mapResource`, byte for
byte — binary resources such as `.ogg` are carried without a lossy string round-trip. `dcs_miz_list_resources`
shows what a mission currently carries.

Still honestly unverified against a real install:

- Brand-new missions from `dcs_miz_new` are a best-effort skeleton.
- Nothing here has been *flown* in DCS as part of this work. The trigger behaviour is verified against
  ME-saved oracles and executed under DCS's own Lua, which is strong evidence but not the same as a
  sortie.
- Live tools are written against the DCS scripting API and need verification with DCS actually running.

## License

[Apache 2.0](LICENSE).
