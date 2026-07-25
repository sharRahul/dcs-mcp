# DCS-MCP

A [Model Context Protocol](https://modelcontextprotocol.io) server for **Digital Combat Simulator (DCS World)**. Works with any MCP client — Claude, Codex, OpenCode, etc. — over stdio.

Four things it does:

- **Build missions offline** — create/modify `.miz` files (groups, SAM sites, zones, triggers, scripts, weather, briefing) and save copy-on-write. No running DCS needed.
- **Inspect missions** — open a `.miz`, read its summary, groups, weather and briefing, and validate it.
- **Live control** — query units, spawn groups, send messages, check terrain, and load a mission into a *running* DCS via a bundled hook.
- **Diagnose** — read `dcs.log` for the errors that appear nowhere else, including with DCS closed.

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

- **Claude / Claude Code**: `claude mcp add`, or add the block to `~/.claude.json`. The repo also ships a project-scoped [`.mcp.json`](.mcp.json).
- **Codex**: add an equivalent `command`/`args` entry in `~/.codex/config.toml`.
- **OpenCode**: add it under `mcp` in `opencode.json`.

## Tools

**Author (offline):** `dcs_miz_new`, `dcs_miz_add_aircraft_group`, `dcs_miz_add_ground_group`, `dcs_miz_add_waypoint`, `dcs_miz_set_payload`, `dcs_miz_set_group_task`, `dcs_miz_add_trigger_zone`, `dcs_miz_add_trigger`, `dcs_miz_load_scripts`, `dcs_miz_list_resources`, `dcs_miz_set_weather`, `dcs_miz_set_briefing`, `dcs_miz_diff`, `dcs_miz_save_as`

**Inspect (offline):** `dcs_miz_open`, `dcs_miz_get_summary`, `dcs_miz_list_groups`, `dcs_miz_get_weather`, `dcs_miz_get_briefing`, `dcs_miz_validate`, `dcs_miz_list_sessions`, `dcs_miz_close`

**Live (DCS running):** `dcs_bridge_status`, `dcs_get_self_data`, `dcs_get_mission_info`, `dcs_get_all_units`, `dcs_get_aircraft_list`, `dcs_send_message`, `dcs_spawn_unit`, `dcs_convert_coords`, `dcs_check_terrain`, `dcs_load_mission`, and (gated) `dcs_execute_lua`

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

**Author, load and check in one pass (DCS running):**

> "Build that SEAD mission, load it in DCS, and tell me if anything errored."

→ `dcs_miz_*` → `dcs_miz_save_as` → `dcs_load_mission` → `dcs_bridge_status` (poll until `running`) → `dcs_get_log_errors`

**Act in a running mission:**

> "Is DCS connected? If so, spawn an Abrams platoon near 42.1N 42.3E and message all players 'Armor inbound'."

→ `dcs_bridge_status` → `dcs_spawn_unit` → `dcs_send_message`

**Inspect an existing file:**

> "Open ~/Missions/op.miz and list all the blue groups and the weather."

→ `dcs_miz_open` → `dcs_miz_list_groups` → `dcs_miz_get_weather`

## Live bridge setup

Copy [`scripts/Hooks/dcs-mcp-hook.lua`](scripts/Hooks/dcs-mcp-hook.lua) into `Saved Games/DCS/Scripts/Hooks/` and **restart DCS** — hooks are read at startup. Confirm in `Saved Games/DCS/Logs/dcs.log`:

```
INFO  DCS-MCP (Main): hook server listening on 127.0.0.1:8899
INFO  APP   (Main): Loaded .../Scripts/Hooks/dcs-mcp-hook.lua
```

with no adjacent `ERROR` line. It listens on localhost only. This is a **control** channel, not a read-only one: it can spawn groups, show messages, and load missions. For **telemetry only**, use [`scripts/Export.lua`](scripts/Export.lua) instead (port `8898`) and skip the hook.

The hook opens its socket when it **loads**, not when a mission starts, so the bridge answers in the main menu and the Mission Editor too — exactly when you need to ask why a mission would not open. A port conflict is reported at bind time in the log.

Structured commands build vetted Lua internally — the model never supplies Lua. Raw `dcs_execute_lua` is doubly gated: `DCS_ALLOW_RAW_LUA=1` here **and** `ALLOW_EXEC = true` in the hook. Enabling it runs arbitrary Lua in DCS and requires a de-sanitized `MissionScripting.lua`; leave it off unless you understand the risk.

### Mission-environment commands run on the simulation thread

DCS is multithreaded, and this bit them: `net.dostring_in('mission', ...)` called from the hook's GUI updater **does not reach the mission scripting state**, and does not fail loudly either. The snippet runs somewhere with no `coalition`, `timer`, `land` or `coord`, so with a mission demonstrably running, every mission-environment command came back with:

```
attempt to index global 'coalition' (a nil value)
```

The hook now holds those commands (`units`, `aircraft`, `mission`, `message`, `spawn`, `ll2xz`, `xz2ll`, `land`) until an `onSimulationFrame` tick dispatches them. Commands that do not need the mission environment (`ping`, `status`, `errors`, `loadmission`) still answer straight from the GUI tick, so the bridge stays responsive in menus.

A **paused** mission produces no simulation frames. A held command is then answered with that reason instead of timing out. For the same reason `dcs_bridge_status` reports `simTicking` and derives `missionEnv` from actual frames — the old probe (`net.dostring_in("mission", "return 'ok'")`) succeeded from the wrong Lua state and cheerfully reported a reachable environment for commands that then failed on a nil global.

## Safety

Every `.miz` is treated as untrusted: archives are checked for path traversal and zip-bomb limits (entry count, expanded/per-entry size, compression ratio) **before** decompression; only known data entries are read; mission Lua is parsed as data, never run. Saves are copy-on-write and refuse to overwrite either the source file or any other existing file (unless you pass `overwrite=true`); a SHA-256 digest is returned for every generated file. Entries the server does not understand are carried through byte-for-byte, so editing a mission never silently drops content. See `src/security/`, `src/miz/lua.ts`, and `src/miz/archive.ts`.

## Placement

Headings are given in **degrees** and written to the mission in radians, which is what DCS stores
(confirmed against 17,367 unit headings in Mission-Editor-saved missions).

A group's units are laid out as a column trailing its heading — vehicles 20 m apart, ships 120 m,
aircraft 60 m, or whatever you pass as `spacingMetres`. The offset follows the heading, so a convoy
lines up with the way it is facing rather than sitting at an angle to it.

DCS map axes are `x` = north, `y` = east. Use `dcs_convert_coords` to turn lat/long into x/y when
DCS is running.

Note: if a group has two or more route points, the Mission Editor overwrites each unit's heading from
`atan2(p2 - p1)` on load. An authored heading only sticks on a single-point group.

### Mixed unit types in one group

`dcs_miz_add_ground_group` takes an optional `composition: [{ type, count }]`. Use it for SAM sites:
a site is **not** N copies of one vehicle. An SA-6 needs its `Kub 1S91 str` search/track radar *and*
`Kub 2P25 ln` launchers in the same group, or Skynet registers the site and it never shoots.

```jsonc
{
  "name": "SAM-SA-6-Kilo",
  "x": 55756, "y": -146736, "heading": 344, "spacingMetres": 70,
  "composition": [
    { "type": "Kub 1S91 str", "count": 1 },
    { "type": "Kub 2P25 ln",  "count": 3 }
  ]
}
```

### Land, not water

`dcs_check_terrain` batches DCS's own `land.getSurfaceType` over up to 500 points and reports
`LAND` / `SHALLOW_WATER` / `WATER` / `ROAD` / `RUNWAY` plus terrain height. It needs a mission
running, because that API lives in the mission environment.

Use it. A ground group placed on water does **not** error when the mission loads — the vehicles just
sit there inert, which reads as broken AI rather than a bad coordinate. Two ways to get a coordinate
you can trust: lift it from a Mission-Editor-saved mission (the editor put a vehicle there, so it is
land), or query it with this tool. `scripts/dcs-mcp-telemetry.lua` does the same check from inside
the mission a few seconds after start and logs an ERROR line for anything wet.

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

### In-mission telemetry

[`scripts/dcs-mcp-telemetry.lua`](scripts/dcs-mcp-telemetry.lua) runs in the mission scripting
environment — load it with `dcs_miz_load_scripts` after the frameworks — and writes
`[DCSMCP] <KIND> key=value ...` lines to `dcs.log`:

| Kind | What it tells you |
|---|---|
| `FRAMEWORK` / `PROOF` | which frameworks loaded, and whether calling into them actually works |
| `TERRAIN` / `TERRAIN_WATER` | the surface under every ground unit; water is logged as an ERROR |
| `TRIG` | a trigger fired, by name — call `DCSMCP.trig('name')` from a `do_script` action |
| `EVT` | shots, hits, kills, deaths, takeoffs, landings, ejections |
| `STATE` | player position, altitude AGL/MSL, speed and life, every 10 s |
| `IADS` / `IADS_SITE` | per-site IADS status: live, dark, cut off, out of ammo, defending a HARM |

The log is the transport on purpose: it is the one channel that still works while a mission is
loading and after a script has thrown. Nothing in the script can raise — a telemetry error inside a
world event handler takes the handler down with it and DCS silently stops delivering events, which
looks exactly like "the mission is fine but nothing happens".

`DCSMCP.trig()` earns its place: a trigger that never fired and a trigger that fired into a broken
action are otherwise indistinguishable from the cockpit.

[`scripts/monitor-flight.mjs`](scripts/monitor-flight.mjs) tails that log incrementally alongside a
bridge poll and maintains a small `digest.json` (counters, latest player state, every trigger firing,
every error) that is cheap to re-read while someone is flying.

```bash
npm run monitor -- ./.monitor 5
```

## Round-trip and trigger fidelity

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
live hook itself and drives both of its tick sources, which is how the GUI-thread routing bug above is
kept fixed, and how a `load(string)` call that is valid in Lua 5.2+ but fatal on DCS's 5.1 was caught.
These are skipped unless you point `DCS_LUA` at your install:

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
with `remove_radio_item`. Pair it with a **continuous** trigger that clears the flag, so the item can
be used more than once — a `once` trigger answers the first request and then goes quiet.
`radio_transmission` broadcasts an embedded `.ogg` on a frequency from a trigger zone.

**AI and world.** `activate_group`, `deactivate_group`, `group_on`, `group_off`, `group_resume`,
`explode`, `smoke`, `signal_flare`, `end_mission`, and the flag actions.

**Scripting.** `do_script` runs inline Lua; `do_script_file` embeds a `.lua` from disk and runs it.

## Scripting frameworks (MIST, MOOSE, Skynet-IADS)

`dcs_miz_load_scripts` embeds a framework into the `.miz` and wires it to run at mission start.

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

**Verify frameworks by calling into them, not by checking a global.** A framework that loaded but
half-failed to initialise still leaves its global defined. `scripts/dcs-mcp-e2e-setup.lua` shows the
pattern: count `mist.DBs.MEgroupsByName`, look a group up in MOOSE's `_DATABASE`, and assert Skynet
found a non-zero number of SAM sites.

### Skynet gotcha: iterate its collections with `ipairs`

`SkynetIADS:getSAMSites()` and `getEarlyWarningRadars()` return a `SkynetIADSTableDelegator` — a proxy
that forwards method calls to its elements and carries its own `__index` field. `pairs` therefore
yields **one extra, non-site value**. In a running mission this reported 4 SAM sites and 3 EW radars
for a mission containing 3 and 2, and killed the IADS sampler every 30 seconds with
`attempt to call method 'isDestroyed' (a nil value)`. Use `ipairs` and `#`.

Skynet also matches by prefix, and the two prefixes look at different things:
`addSAMSitesByPrefix('SAM')` matches **group** names, `addEarlyWarningRadarsByPrefix('EW')` matches
**unit** names. Since a group's units are named `<group>-1`, `<group>-2`, …, naming an EWR group `EW-North`
gives you a unit called `EW-North-1` and the match works out.

## End-to-end scripts

Three scripts drive the whole path, and are the fastest way to see the pieces working together:

```bash
npm run build:e2e-mission     # authors a full Persian Gulf SEAD mission through the same APIs the tools call
npm run verify:miz -- <file>  # offline acceptance checks on any .miz
npm run monitor -- ./.monitor # tail the log + poll the bridge while flying
```

`verify-mission.mjs` runs four checks that catch failures which otherwise only show up as a GUI error
box or a silently dead mission: the validator; ED's own `fixUnitsPos` from `me_mission.lua` under
`luae.exe` (a group with an empty `route.points` makes the Mission Editor refuse to open the *whole*
mission, and nothing points at the group responsible); every compiled `mission.trig` string actually
loading as Lua; and unit geometry — headings in `[0, 2π)`, units trailing the group heading rather
than stringing off to the north-east.

## Notes & status

Verified against a real install (2026-07-25, Persian Gulf, DCS multithreaded): an authored mission was
built through these APIs, loaded through the bridge with `dcs_load_mission`, and run. `triggerStart`
and `triggerOnce` triggers fired at the right model times and their actions ran; MIST, MOOSE and
Skynet all loaded from the single start trigger and all three initialised; all 18 authored ground
units reported `LAND` from `land.getSurfaceType`.

Still honestly unverified:

- Brand-new missions from `dcs_miz_new` are a best-effort skeleton.
- The condition-driven triggers (`group_dead`, `unit_in_zone`, `part_of_coalition_in_zone`, the radio
  menu handler) and `end_mission` need a full sortie that actually destroys the objectives. They are
  verified against ME-saved oracles and executed under DCS's own Lua, which is strong evidence but not
  the same as a flight.
- `dcs_spawn_unit` and `dcs_send_message` are written against the DCS scripting API and, unlike the
  read paths, have not been exercised in a live mission since the thread-routing fix.

## License

[Apache 2.0](LICENSE).
